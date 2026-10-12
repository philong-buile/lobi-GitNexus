import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { walkRepositoryPaths } from '../../src/core/ingestion/filesystem-walker.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const makeRepo = async (files: Record<string, string>): Promise<string> => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-walk-data-'));
  temporaryRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), content);
  }
  return root;
};

describe('walkRepositoryPaths data files', () => {
  it('keeps a data file over the size cap but skips an oversized code file', async () => {
    const root = await makeRepo({ 'big.csv': 'x'.repeat(200), 'big.ts': 'x'.repeat(200) });
    const scanned = await walkRepositoryPaths(root, undefined, {
      maxFileSizeBytes: 50,
      quiet: true,
    });
    expect(scanned.map((f) => f.path)).toEqual(['big.csv']);
  });

  it('finds data files under fixtures/ but not code files there', async () => {
    const root = await makeRepo({
      'tests/fixtures/a.csv': 'id,n\n1,2\n',
      'tests/fixtures/b.ts': 'export {};\n',
      'node_modules/p/fixtures/c.csv': 'id,n\n1,2\n',
    });
    const scanned = await walkRepositoryPaths(root, undefined, { quiet: true });
    expect(scanned.map((f) => f.path)).toEqual(['tests/fixtures/a.csv']);
  });
});
