/**
 * Phase: dataFiles
 *
 * Indexes data files (.csv/.tsv/.xlsx) by structure only and links the
 * files that reference them. See data-file-processor.ts.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (DataFile/DataColumn nodes, CONTAINS + USES edges)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { readFileContents } from '../filesystem-walker.js';
import { getProviderForFile } from '../languages/index.js';
import {
  type DataColumnRef,
  isDataFilePath,
  linkDataFileReferences,
  processDataFiles,
} from '../data-file-processor.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

/** Referrer files read per batch, to bound memory on large repos. */
const REFERRER_BATCH = 500;

const isXlsx = (p: string): boolean => path.extname(p).toLowerCase() === '.xlsx';

/** Data file bytes held in memory at once. */
const DATA_BATCH_BYTES = 64 * 1024 * 1024;

/**
 * Splits entries into consecutive batches of at most `maxBytes` total size.
 * An entry larger than `maxBytes` gets a batch of its own.
 */
export const batchBySize = <T extends { size: number }>(
  entries: readonly T[],
  maxBytes: number,
): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < entries.length; ) {
    const batch = [entries[i++]];
    let bytes = batch[0].size;
    while (i < entries.length && bytes + entries[i].size <= maxBytes) {
      bytes += entries[i].size;
      batch.push(entries[i++]);
    }
    batches.push(batch);
  }
  return batches;
};

export interface DataFilesOutput {
  dataFiles: number;
  columns: number;
  fileRefs: number;
  columnRefs: number;
}

export const dataFilesPhase: PipelinePhase<DataFilesOutput> = {
  name: 'dataFiles',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<DataFilesOutput> {
    const { scannedFiles } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const dataEntries = scannedFiles.filter((f) => isDataFilePath(f.path));
    if (dataEntries.length === 0) return { dataFiles: 0, columns: 0, fileRefs: 0, columnRefs: 0 };

    // Batches are bounded by total bytes (a lone oversized file gets its own),
    // so many large CSVs are never in memory together.
    const columnsByPath = new Map<string, DataColumnRef[]>();
    let dataFiles = 0;
    let columns = 0;
    for (const batch of batchBySize(dataEntries, DATA_BATCH_BYTES)) {
      const contents: Map<string, string | Buffer> = await readFileContents(
        ctx.repoPath,
        batch.map((f) => f.path).filter((p) => !isXlsx(p)),
      );
      // .xlsx is a zip archive: read raw bytes, not utf-8 text.
      for (const f of batch.filter((e) => isXlsx(e.path))) {
        try {
          contents.set(f.path, await fs.readFile(path.join(ctx.repoPath, f.path)));
        } catch {
          // unreadable: skipped, same as readFileContents
        }
      }
      const processed = processDataFiles(
        ctx.graph,
        batch
          .filter((f) => contents.has(f.path))
          .map((f) => ({ path: f.path, content: contents.get(f.path)! })),
      );
      for (const [p, refs] of processed.columnsByPath) columnsByPath.set(p, refs);
      dataFiles += processed.dataFiles;
      columns += processed.columns;
    }

    // ponytail: re-reads every non-data file once per analyze when the repo has
    // data files; share the parse phase's content if this shows up in profiles.
    const referrerPaths = scannedFiles.map((f) => f.path).filter((p) => !isDataFilePath(p));
    let fileRefs = 0;
    let columnRefs = 0;
    for (let i = 0; i < referrerPaths.length; i += REFERRER_BATCH) {
      const batch = referrerPaths.slice(i, i + REFERRER_BATCH);
      const contents = await readFileContents(ctx.repoPath, batch);
      const linked = linkDataFileReferences(
        ctx.graph,
        batch.filter((p) => contents.has(p)).map((p) => ({ path: p, content: contents.get(p)! })),
        columnsByPath,
        (p) => getProviderForFile(p)?.commentSyntax,
      );
      fileRefs += linked.fileRefs;
      columnRefs += linked.columnRefs;
    }

    if (isDev) {
      logger.info(
        `  Data files: ${dataFiles} files, ${columns} columns, ${fileRefs} file refs, ${columnRefs} column refs`,
      );
    }
    return { dataFiles, columns, fileRefs, columnRefs };
  },
};
