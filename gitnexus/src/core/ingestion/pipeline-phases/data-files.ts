/**
 * Phase: dataFiles
 *
 * Indexes delimited data files (.csv/.tsv) by structure only and links the
 * files that reference them. See data-file-processor.ts.
 *
 * @deps    structure
 * @reads   scannedFiles (from structure phase)
 * @writes  graph (DataFile/DataColumn nodes, CONTAINS + USES edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { readFileContents } from '../filesystem-walker.js';
import {
  isDataFilePath,
  linkDataFileReferences,
  processDataFiles,
} from '../data-file-processor.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

/** Referrer files read per batch, to bound memory on large repos. */
const REFERRER_BATCH = 500;

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
    const dataPaths = scannedFiles.map((f) => f.path).filter(isDataFilePath);
    if (dataPaths.length === 0) return { dataFiles: 0, columns: 0, fileRefs: 0, columnRefs: 0 };

    const dataContents = await readFileContents(ctx.repoPath, dataPaths);
    const { dataFiles, columns, columnsByPath } = processDataFiles(
      ctx.graph,
      dataPaths
        .filter((p) => dataContents.has(p))
        .map((p) => ({ path: p, content: dataContents.get(p)! })),
    );

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
