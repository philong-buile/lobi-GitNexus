import { describe, it, expect } from 'vitest';
import {
  isDataFilePath,
  linkDataFileReferences,
  looksLikeHeader,
  MAX_DATA_COLUMNS,
  processDataFiles,
  resolveDataFileLiteral,
  scanDelimited,
  sniffDelimiter,
} from '../../src/core/ingestion/data-file-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';

const graphWithFiles = (...paths: string[]): KnowledgeGraph => {
  const graph = createKnowledgeGraph();
  for (const p of paths) {
    graph.addNode({
      id: generateId('File', p),
      label: 'File',
      properties: { name: p.split('/').pop()!, filePath: p },
    });
  }
  return graph;
};

const nodesOf = (graph: KnowledgeGraph, label: string) =>
  [...graph.iterNodes()].filter((n) => n.label === label);

const usesEdges = (graph: KnowledgeGraph) => [...graph.iterRelationshipsByType('USES')];

describe('isDataFilePath', () => {
  it('matches .csv/.tsv case-insensitively only', () => {
    expect(isDataFilePath('a/b.csv')).toBe(true);
    expect(isDataFilePath('a/b.TSV')).toBe(true);
    expect(isDataFilePath('a/b.csv.bak')).toBe(false);
    expect(isDataFilePath('a/b.json')).toBe(false);
  });
});

describe('scanDelimited', () => {
  it('parses quoted fields, escaped quotes and quoted newlines', () => {
    const text = 'a,"b,c","say ""hi"""\r\n1,"two\nlines",3\n';
    const { records, total } = scanDelimited(text, ',', 10);
    expect(records).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['1', 'two\nlines', '3'],
    ]);
    expect(total).toBe(2);
  });

  it('counts records past the kept ones and skips blank lines', () => {
    const text = 'h\n1\n\n2\r3\r\n4';
    const { records, total } = scanDelimited(text, ',', 1);
    expect(records).toEqual([['h']]);
    expect(total).toBe(5);
  });

  it('handles empty input', () => {
    expect(scanDelimited('', ',', 5)).toEqual({ records: [], total: 0 });
  });
});

describe('sniffDelimiter', () => {
  it('uses tab for .tsv and sniffs semicolons in .csv', () => {
    expect(sniffDelimiter('x.tsv', 'a,b\tc')).toBe('tab');
    expect(sniffDelimiter('x.csv', 'a;b;c\n1;2;3')).toBe('semicolon');
    expect(sniffDelimiter('x.csv', 'a,b;c')).toBe('comma');
    expect(sniffDelimiter('x.csv', 'a\tb')).toBe('tab');
  });
});

describe('looksLikeHeader', () => {
  it('rejects text rows when too few columns give header evidence', () => {
    expect(
      looksLikeHeader(
        ['Alice Johnson', 'Smith LLC', 'USA'],
        [
          ['Bob Lee', 'Acme Inc', 'UK'],
          ['Cara Diaz', 'Foo Corp', 'UK'],
        ],
      ),
    ).toBe(false);
  });

  it('accepts a named header over numeric data', () => {
    expect(looksLikeHeader(['id', 'name'], [['1', 'Alice']])).toBe(true);
  });

  it('rejects headerless numeric, email-like, duplicate and single-row input', () => {
    expect(looksLikeHeader(['1', '2'], [['3', '4']])).toBe(false);
    expect(looksLikeHeader(['alice@example.com', 'x'], [['1', '2']])).toBe(false);
    expect(looksLikeHeader(['a', 'a'], [['1', '2']])).toBe(false);
    expect(looksLikeHeader(['id', 'name'], [])).toBe(false);
  });

  it('rejects a text-only first row with no type or width signal', () => {
    expect(looksLikeHeader(['Alice', 'London'], [['Bob', 'Paris']])).toBe(false);
  });
});

describe('processDataFiles', () => {
  it('creates DataFile + DataColumn nodes with counts and no cell values', () => {
    const graph = graphWithFiles('data/users.csv');
    const content =
      '﻿id,email,signup_date\r\n1,SECRET_ALICE@example.com,2024-01-01\r\n2,"SECRET, BOB",2024-02-02\r\n';
    const result = processDataFiles(graph, [{ path: 'data/users.csv', content }]);

    expect(result).toMatchObject({ dataFiles: 1, columns: 3 });
    const [dataFile] = nodesOf(graph, 'DataFile');
    expect(dataFile.properties).toMatchObject({
      name: 'users.csv',
      filePath: 'data/users.csv',
      rowCount: 2,
      columnCount: 3,
      delimiter: 'comma',
    });
    expect(nodesOf(graph, 'DataColumn').map((n) => n.properties.name)).toEqual([
      'id',
      'email',
      'signup_date',
    ]);

    const contains = [...graph.iterRelationshipsByType('CONTAINS')];
    expect(contains).toContainEqual(
      expect.objectContaining({
        sourceId: generateId('File', 'data/users.csv'),
        targetId: dataFile.id,
      }),
    );
    expect(contains.filter((r) => r.sourceId === dataFile.id)).toHaveLength(3);

    const everything = JSON.stringify([...graph.iterNodes()]);
    expect(everything).not.toContain('SECRET');
    expect(everything).not.toContain('2024-01-01');
  });

  it('indexes a TSV file', () => {
    const graph = graphWithFiles('t.tsv');
    processDataFiles(graph, [{ path: 't.tsv', content: 'code\tqty\nA1\t5\n' }]);
    expect(nodesOf(graph, 'DataColumn').map((n) => n.properties.name)).toEqual(['code', 'qty']);
    expect(nodesOf(graph, 'DataFile')[0].properties.delimiter).toBe('tab');
  });

  it('gives a headerless file no columns and counts every row', () => {
    const graph = graphWithFiles('h.csv');
    processDataFiles(graph, [{ path: 'h.csv', content: 'Alice,London\nBob,Paris\n' }]);
    expect(nodesOf(graph, 'DataColumn')).toHaveLength(0);
    const props = nodesOf(graph, 'DataFile')[0].properties;
    expect(props.rowCount).toBe(2);
    expect(props.description).toContain('no header detected');
    expect(JSON.stringify(props)).not.toContain('Alice');
  });

  it('handles an empty file', () => {
    const graph = graphWithFiles('e.csv');
    processDataFiles(graph, [{ path: 'e.csv', content: '' }]);
    expect(nodesOf(graph, 'DataFile')[0].properties).toMatchObject({
      rowCount: 0,
      columnCount: 0,
    });
  });

  it('caps columns at MAX_DATA_COLUMNS', () => {
    const graph = graphWithFiles('wide.csv');
    const header = Array.from({ length: 300 }, (_, i) => `c${i}`).join(',');
    const row = Array.from({ length: 300 }, (_, i) => String(i)).join(',');
    processDataFiles(graph, [{ path: 'wide.csv', content: `${header}\n${row}\n` }]);
    expect(nodesOf(graph, 'DataColumn')).toHaveLength(MAX_DATA_COLUMNS);
    expect(nodesOf(graph, 'DataFile')[0].properties.columnCount).toBe(300);
  });

  it('skips data files with no File node', () => {
    const graph = createKnowledgeGraph();
    expect(processDataFiles(graph, [{ path: 'x.csv', content: 'a\n1\n' }]).dataFiles).toBe(0);
  });
});

describe('resolveDataFileLiteral', () => {
  const paths = ['data/users.csv', 'app/data/orders.csv', 'a/dup.csv', 'b/dup.csv'];
  const set = new Set(paths);

  it('resolves relative to the referrer and to the repo root as exact', () => {
    expect(resolveDataFileLiteral('../data/users.csv', 'src/load.py', paths, set)).toEqual({
      path: 'data/users.csv',
      exact: true,
    });
    expect(resolveDataFileLiteral('./data/users.csv', 'load.py', paths, set)).toEqual({
      path: 'data/users.csv',
      exact: true,
    });
  });

  it('accepts a unique suffix or basename, refuses ambiguous ones', () => {
    expect(resolveDataFileLiteral('data/orders.csv', 'x.py', paths, set)).toEqual({
      path: 'app/data/orders.csv',
      exact: false,
    });
    expect(resolveDataFileLiteral('users.csv', 'x/y.py', paths, set)?.path).toBe('data/users.csv');
    expect(resolveDataFileLiteral('dup.csv', 'x.py', paths, set)).toBeNull();
    expect(resolveDataFileLiteral('ers.csv', 'x.py', paths, set)).toBeNull();
    expect(resolveDataFileLiteral('https://h/data/users.csv', 'x.py', paths, set)).toBeNull();
    expect(resolveDataFileLiteral('users.json', 'x.py', paths, set)).toBeNull();
  });
});

describe('linkDataFileReferences', () => {
  const setup = () => {
    const graph = graphWithFiles(
      'data/users.csv',
      'data/orders.csv',
      'src/load.py',
      'src/other.py',
    );
    const { columnsByPath } = processDataFiles(graph, [
      { path: 'data/users.csv', content: 'id,email,status\n1,a,x\n' },
      { path: 'data/orders.csv', content: 'order_id,status\n7,x\n' },
    ]);
    return { graph, columnsByPath };
  };

  it('links a path literal to the DataFile and accessed columns to DataColumns', () => {
    const { graph, columnsByPath } = setup();
    const content = 'df = pd.read_csv("data/users.csv")\nprint(df["email"])\nx = row.get(\'id\')\n';
    const result = linkDataFileReferences(graph, [{ path: 'src/load.py', content }], columnsByPath);
    expect(result).toEqual({ fileRefs: 1, columnRefs: 2 });
    const targets = usesEdges(graph).map((r) => r.targetId);
    expect(targets).toContain(generateId('DataFile', 'data/users.csv'));
    expect(targets).toContain(generateId('DataColumn', 'data/users.csv:1:email'));
    expect(targets).toContain(generateId('DataColumn', 'data/users.csv:0:id'));
  });

  it('does not link a column name without the data-access shape or the path reference', () => {
    const { graph, columnsByPath } = setup();
    linkDataFileReferences(
      graph,
      [
        { path: 'src/load.py', content: 'open("data/users.csv")\nemail = 1\n' },
        { path: 'src/other.py', content: 'x["email"] # no csv named here\n' },
      ],
      columnsByPath,
    );
    expect(usesEdges(graph).map((r) => r.targetId)).toEqual([
      generateId('DataFile', 'data/users.csv'),
    ]);
  });

  it('skips a column name shared by two referenced data files', () => {
    const { graph, columnsByPath } = setup();
    const content = 'a = "data/users.csv"\nb = "data/orders.csv"\nrow["status"]\n';
    const result = linkDataFileReferences(graph, [{ path: 'src/load.py', content }], columnsByPath);
    expect(result).toEqual({ fileRefs: 2, columnRefs: 0 });
  });
});
