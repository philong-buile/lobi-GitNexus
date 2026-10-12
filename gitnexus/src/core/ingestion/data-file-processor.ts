/**
 * Data File Processor
 *
 * Indexes delimited data files (.csv, .tsv) by STRUCTURE ONLY: a `DataFile`
 * node per file (row count, column count, delimiter) and a `DataColumn` node
 * per header column. Cell values are never stored — data files routinely hold
 * private data, so nothing past the header row reaches a node property, and a
 * first row that does not look like a header (a headerless file) produces no
 * columns at all rather than risk storing a data row as column names.
 *
 * Also links files that reference a data file: a string literal naming its
 * path gives `File -USES-> DataFile`, and inside such a file an exact column
 * name in a subscript/getter gives `File -USES-> DataColumn`. Matching is
 * deliberately conservative — a missing edge is better than a false one.
 */

import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { generateId } from '../../lib/utils.js';
import type { KnowledgeGraph } from '../graph/types.js';

const DATA_FILE_EXTENSIONS = new Set(['.csv', '.tsv']);

/** Columns kept per file; wider files keep the first MAX_DATA_COLUMNS. */
export const MAX_DATA_COLUMNS = 256;
/** Header cells longer than this are treated as data, not a column name. */
const MAX_COLUMN_NAME_LENGTH = 64;
/** Data rows sampled to decide whether the first row is a header. */
const HEADER_SAMPLE_ROWS = 20;
/** Longest string literal considered as a data-file path reference. */
const MAX_PATH_LITERAL_LENGTH = 300;

export const isDataFilePath = (filePath: string): boolean =>
  DATA_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase());

export interface DataFileInput {
  path: string;
  content: string;
}

type DelimiterName = 'comma' | 'semicolon' | 'tab';
const DELIMITER_CHARS: Record<DelimiterName, string> = { comma: ',', semicolon: ';', tab: '\t' };

/** Tab for .tsv; for .csv a comma unless the first line has only `;` or tabs. */
export const sniffDelimiter = (filePath: string, text: string): DelimiterName => {
  if (path.extname(filePath).toLowerCase() === '.tsv') return 'tab';
  const firstLine = text.slice(0, text.search(/\r|\n/) === -1 ? text.length : text.search(/\r|\n/));
  if (firstLine.includes(',')) return 'comma';
  if (firstLine.includes(';')) return 'semicolon';
  if (firstLine.includes('\t')) return 'tab';
  return 'comma';
};

/**
 * One quote-aware pass (RFC 4180: `"` quoting, `""` escapes, quoted newlines,
 * CRLF/LF/CR). Returns the first `keep` records parsed into fields and the
 * total number of non-blank records. Only the kept records are materialized.
 */
export const scanDelimited = (
  text: string,
  delimiter: string,
  keep: number,
): { records: string[][]; total: number } => {
  const records: string[][] = [];
  let total = 0;
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let recordHasContent = false;

  const endRecord = (): void => {
    if (recordHasContent) {
      if (records.length < keep) {
        fields.push(field);
        records.push(fields);
      }
      total++;
    }
    fields = [];
    field = '';
    recordHasContent = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const collecting = records.length < keep;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          if (collecting) field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else if (collecting) {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      recordHasContent = true;
    } else if (ch === delimiter) {
      recordHasContent = true;
      if (collecting) fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      recordHasContent = true;
      if (collecting) field += ch;
    }
  }
  endRecord();
  return { records, total };
};

const NAME_SHAPE = /^[\p{L}_][\p{L}\p{N}_ .\-()/#%]*$/u;
const NUMERIC = /^[-+]?(\d+([.,]\d+)*|\d*\.\d+)([eE][-+]?\d+)?%?$/;

/**
 * Whether the first record is a header. Every cell must look like a name
 * (non-empty, unique, ≤64 chars, starts with a letter or `_`, no `@`), there
 * must be at least one data row, and — modelled on Python's
 * csv.Sniffer.has_header — the sampled data rows must
 * disagree with it: a header needs at least one column that is numeric below a
 * non-numeric name. Constant-width text alone is not enough, since short codes
 * like country names fake it, so text-only files get no columns: they may be
 * headerless, and their first row would then be private data.
 */
export const looksLikeHeader = (header: string[], sample: string[][]): boolean => {
  const names = header.map((h) => h.trim());
  if (names.length === 0) return false;
  if (new Set(names).size !== names.length) return false;
  for (const name of names) {
    if (!name || name.length > MAX_COLUMN_NAME_LENGTH) return false;
    if (name.includes('@') || !NAME_SHAPE.test(name)) return false;
  }
  // A single-row file gives no evidence either way: "Alice,London" is a
  // plausible header and a plausible private record. Index no columns.
  if (sample.length === 0) return false;

  let numericVotes = 0;
  for (let c = 0; c < names.length; c++) {
    const values = sample.map((r) => (r[c] ?? '').trim()).filter((v) => v !== '');
    if (values.length === 0) continue;
    if (values.every((v) => NUMERIC.test(v))) {
      numericVotes++;
    }
  }
  return numericVotes > 0;
};

export interface DataColumnRef {
  id: string;
  name: string;
}

/**
 * Adds `DataFile` + `DataColumn` nodes under each data file's existing `File`
 * node. Returns the column list per data file path for reference linking.
 */
export const processDataFiles = (
  graph: KnowledgeGraph,
  files: readonly DataFileInput[],
): { dataFiles: number; columns: number; columnsByPath: Map<string, DataColumnRef[]> } => {
  const columnsByPath = new Map<string, DataColumnRef[]>();
  let dataFiles = 0;
  let columns = 0;

  for (const file of files) {
    if (!isDataFilePath(file.path)) continue;
    const fileNodeId = generateId('File', file.path);
    if (!graph.getNode(fileNodeId)) continue;

    const text = file.content.replace(/^﻿/, '');
    const delimiter = sniffDelimiter(file.path, text);
    const { records, total } = scanDelimited(
      text,
      DELIMITER_CHARS[delimiter],
      HEADER_SAMPLE_ROWS + 1,
    );
    const first = records[0] ?? [];
    const hasHeader = looksLikeHeader(first, records.slice(1));
    const columnCount = first.length;
    const rowCount = hasHeader ? total - 1 : total;
    const kept = hasHeader ? Math.min(columnCount, MAX_DATA_COLUMNS) : 0;

    const ext = path.extname(file.path).slice(1).toLowerCase();
    let description = `${ext}, ${columnCount} columns, ${rowCount} rows`;
    if (!hasHeader && columnCount > 0) description += ', no header detected';
    if (kept < columnCount && hasHeader) description += `, first ${kept} columns indexed`;

    const dataFileId = generateId('DataFile', file.path);
    const dataFileNode: GraphNode = {
      id: dataFileId,
      label: 'DataFile',
      properties: {
        name: path.posix.basename(file.path),
        filePath: file.path,
        rowCount,
        columnCount,
        delimiter,
        description,
      },
    };
    graph.addNode(dataFileNode);
    graph.addRelationship({
      id: generateId('CONTAINS', `${fileNodeId}->${dataFileId}`),
      type: 'CONTAINS',
      sourceId: fileNodeId,
      targetId: dataFileId,
      confidence: 1.0,
      reason: 'data-file',
    });
    dataFiles++;

    const refs: DataColumnRef[] = [];
    for (let i = 0; i < kept; i++) {
      const name = first[i].trim();
      const columnId = generateId('DataColumn', `${file.path}:${i}:${name}`);
      graph.addNode({
        id: columnId,
        label: 'DataColumn',
        properties: {
          name,
          filePath: file.path,
          description: `column ${i + 1} of ${columnCount}`,
        },
      });
      graph.addRelationship({
        id: generateId('CONTAINS', `${dataFileId}->${columnId}`),
        type: 'CONTAINS',
        sourceId: dataFileId,
        targetId: columnId,
        confidence: 1.0,
        reason: 'data-column',
      });
      refs.push({ id: columnId, name });
    }
    columnsByPath.set(file.path, refs);
    columns += refs.length;
  }

  return { dataFiles, columns, columnsByPath };
};

const STRING_LITERAL_RE = /"([^"\n]{1,300})"|'([^'\n]{1,300})'|`([^`\n]{1,300})`/g;
const DATA_EXT_IN_TEXT_RE = /\.[ct]sv\b/i;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Resolve one string literal to a data file path, or null. Exact resolution
 * (relative to the referrer, or to the repo root) wins; otherwise a path
 * suffix on a `/` boundary — a bare basename included — counts only when
 * exactly one data file matches.
 */
export const resolveDataFileLiteral = (
  literal: string,
  referrerPath: string,
  dataPaths: readonly string[],
  dataPathSet: ReadonlySet<string>,
): { path: string; exact: boolean } | null => {
  if (literal.length > MAX_PATH_LITERAL_LENGTH || !isDataFilePath(literal.trim())) return null;
  const norm = literal.trim().replace(/\\/g, '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(norm)) return null; // URL, not a repo path

  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(referrerPath), norm));
  if (dataPathSet.has(relative)) return { path: relative, exact: true };
  const fromRoot = path.posix.normalize(norm).replace(/^\/+/, '');
  if (dataPathSet.has(fromRoot)) return { path: fromRoot, exact: true };

  const suffix = fromRoot.replace(/^(\.\.\/)+/, '');
  if (!suffix || suffix.startsWith('..')) return null;
  const matches = dataPaths.filter((p) => p === suffix || p.endsWith(`/${suffix}`));
  return matches.length === 1 ? { path: matches[0], exact: false } : null;
};

/**
 * Adds `File -USES-> DataFile` and `File -USES-> DataColumn` edges from the
 * given referrer files. Referrers must not include the data files themselves.
 */
export const linkDataFileReferences = (
  graph: KnowledgeGraph,
  referrers: readonly DataFileInput[],
  columnsByPath: ReadonlyMap<string, readonly DataColumnRef[]>,
): { fileRefs: number; columnRefs: number } => {
  const dataPaths = [...columnsByPath.keys()];
  const dataPathSet = new Set(dataPaths);
  let fileRefs = 0;
  let columnRefs = 0;
  if (dataPaths.length === 0) return { fileRefs, columnRefs };

  for (const referrer of referrers) {
    if (isDataFilePath(referrer.path)) continue;
    if (!DATA_EXT_IN_TEXT_RE.test(referrer.content)) continue;
    const referrerId = generateId('File', referrer.path);
    if (!graph.getNode(referrerId)) continue;

    const referenced = new Map<string, boolean>(); // data path -> exact
    STRING_LITERAL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_LITERAL_RE.exec(referrer.content)) !== null) {
      const literal = m[1] ?? m[2] ?? m[3];
      const hit = resolveDataFileLiteral(literal, referrer.path, dataPaths, dataPathSet);
      if (hit) referenced.set(hit.path, (referenced.get(hit.path) ?? false) || hit.exact);
    }
    if (referenced.size === 0) continue;

    // Column name -> the one column it can mean; null once it is ambiguous
    // across the data files this referrer names.
    const columnByName = new Map<string, DataColumnRef | null>();
    for (const [dataPath, exact] of referenced) {
      const dataFileId = generateId('DataFile', dataPath);
      graph.addRelationship({
        id: generateId('USES', `${referrerId}->${dataFileId}`),
        type: 'USES',
        sourceId: referrerId,
        targetId: dataFileId,
        confidence: exact ? 0.8 : 0.6,
        reason: 'data-file-reference',
      });
      fileRefs++;
      for (const col of columnsByPath.get(dataPath) ?? []) {
        columnByName.set(col.name, columnByName.has(col.name) ? null : col);
      }
    }

    for (const [name, col] of columnByName) {
      if (!col || name.length < 2) continue;
      const access = new RegExp(`(?:\\[|\\.get\\(|\\bcol\\()\\s*(["'])${escapeRegExp(name)}\\1`);
      if (!access.test(referrer.content)) continue;
      graph.addRelationship({
        id: generateId('USES', `${referrerId}->${col.id}`),
        type: 'USES',
        sourceId: referrerId,
        targetId: col.id,
        confidence: 0.7,
        reason: 'data-column-reference',
      });
      columnRefs++;
    }
  }

  return { fileRefs, columnRefs };
};
