/**
 * Data file (CSV/TSV) indexing, end to end: a real pipeline run over a tiny
 * repo, then the DB export. The gate is privacy — the marker values planted in
 * the data rows must appear in no graph node and in no exported DB CSV.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { streamAllCSVsToDisk } from '../../src/core/lbug/csv-generator.js';
import { generateId } from '../../src/lib/utils.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const MARKERS = ['ZZMARKER_ALICE', 'zzmarker.bob@example.com', 'ZZMARKER_ORDER_42'];

const FILES: Record<string, string> = {
  'data/users.csv': [
    'id,email,signup_date',
    `1,${MARKERS[1]},2024-01-01`,
    `2,"${MARKERS[0]}, Jr",2024-02-02`,
    '',
  ].join('\r\n'),
  'data/orders.tsv': ['order_id\tnote', `7\t${MARKERS[2]}`, `8\tfine`, ''].join('\n'),
  'data/unused.csv': 'code,qty\nA1,5\nB2,6\n',
  'src/load.py': [
    'import pandas as pd',
    '',
    'def load():',
    '    df = pd.read_csv("data/users.csv")',
    '    return df["email"]',
    '',
  ].join('\n'),
  'README.md': '# Data\n\nSee [users](data/users.csv) and `data/orders.tsv`.\n',
};

describe('data files pipeline', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-datafiles-'));
    for (const [rel, content] of Object.entries(FILES)) {
      await fs.mkdir(path.join(repoDir, path.dirname(rel)), { recursive: true });
      await fs.writeFile(path.join(repoDir, rel), content);
    }
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 120_000);

  afterAll(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  const nodes = (label: string) => [...result.graph.iterNodes()].filter((n) => n.label === label);
  const edge = (type: string, sourceId: string, targetId: string) =>
    [...result.graph.iterRelationshipsByType(type as never)].find(
      (r) => r.sourceId === sourceId && r.targetId === targetId,
    );

  it('indexes each data file and its header columns', () => {
    const files = nodes('DataFile').map((n) => n.properties);
    expect(files.map((p) => p.filePath).sort()).toEqual([
      'data/orders.tsv',
      'data/unused.csv',
      'data/users.csv',
    ]);
    expect(files.find((p) => p.filePath === 'data/users.csv')).toMatchObject({
      rowCount: 2,
      columnCount: 3,
    });
    const userColumns = nodes('DataColumn')
      .filter((n) => n.properties.filePath === 'data/users.csv')
      .map((n) => n.properties.name);
    expect(userColumns).toEqual(['id', 'email', 'signup_date']);
    expect(
      edge(
        'CONTAINS',
        generateId('File', 'data/users.csv'),
        generateId('DataFile', 'data/users.csv'),
      ),
    ).toBeDefined();
  });

  it('links code and docs that reference the data file, and the accessed column', () => {
    const load = generateId('File', 'src/load.py');
    expect(edge('USES', load, generateId('DataFile', 'data/users.csv'))).toBeDefined();
    expect(edge('USES', load, generateId('DataColumn', 'data/users.csv:1:email'))).toBeDefined();
    expect(
      edge('USES', generateId('File', 'README.md'), generateId('DataFile', 'data/orders.tsv')),
    ).toBeDefined();
    expect(
      edge('IMPORTS', generateId('File', 'README.md'), generateId('File', 'data/users.csv')),
    ).toBeDefined();
    const unused = generateId('DataFile', 'data/unused.csv');
    expect(
      [...result.graph.iterRelationshipsByType('USES')].some((r) => r.targetId === unused),
    ).toBe(false);
  });

  it('stores no cell value in any graph node', () => {
    const everything = JSON.stringify([...result.graph.iterNodes()]);
    for (const marker of MARKERS) expect(everything).not.toContain(marker);
  });

  it('writes no cell value to any DB export CSV', async () => {
    const csvDir = path.join(repoDir, '.gn-csv');
    await streamAllCSVsToDisk(result.graph, repoDir, csvDir);
    const written = await fs.readdir(csvDir);
    expect(written).toContain('datafile.csv');
    expect(written).toContain('datacolumn.csv');
    for (const name of written) {
      const text = await fs.readFile(path.join(csvDir, name), 'utf8');
      for (const marker of MARKERS) expect(text, `${name} leaks ${marker}`).not.toContain(marker);
    }
    // The source file next to it still exports its own content.
    const fileCsv = await fs.readFile(path.join(csvDir, 'file.csv'), 'utf8');
    expect(fileCsv).toContain('read_csv');
  });
});
