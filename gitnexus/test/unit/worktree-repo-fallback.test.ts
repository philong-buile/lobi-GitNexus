/**
 * Read-only tools answer for an unindexed linked worktree from a sibling
 * worktree's index, and say so.
 *
 * A worktree created with `git worktree add` has no index until someone runs
 * `analyze` in it. Before this change an MCP call aimed at it either failed
 * (`Repository "<path>" not found`, or `Multiple repositories indexed` when the
 * worktree was only the server's cwd) or — with a single registered repo —
 * silently answered from the main checkout's index while reporting `current`,
 * because staleness was measured against the main checkout's own HEAD.
 *
 * Real git and the real `checkStalenessAsync` run here; only the registry and
 * the LadybugDB adapter are stubbed. The worktree is one commit ahead of the
 * indexed main checkout, so the measured freshness is what discriminates the
 * fix: against the worktree's HEAD it is `behind` by 1, against main's it would
 * be `current`.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...lbugMocks,
}));
vi.mock('../../src/mcp/core/lbug-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...lbugMocks,
}));

// `readRegistry` is pinned to empty so the real `checkCwdMatch` cannot read the
// developer's own registry; `listRegisteredRepos` is set per test.
vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/storage/repo-manager.js')>()),
  listRegisteredRepos: vi.fn().mockResolvedValue([]),
  readRegistry: vi.fn().mockResolvedValue([]),
  cleanupOldKuzuFiles: vi.fn().mockResolvedValue({ found: false, needsReindex: false }),
  findSiblingClones: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/core/search/bm25-index.js', () => ({
  searchFTSFromLbug: vi.fn().mockResolvedValue({ results: [], ftsAvailable: true }),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: vi.fn().mockResolvedValue([]),
  getEmbeddingDims: vi.fn().mockReturnValue(384),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { stalenessPayload } from '../../src/core/staleness-status.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

const commit = (repo: string, file: string): void => {
  writeFileSync(path.join(repo, file), `export const x = '${file}';\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', `add ${file}`);
};

const fixtureRoots: string[] = [];

interface Fixture {
  main: string;
  /** Linked worktree, one commit ahead of main, never indexed. */
  worktree: string;
  /** Linked worktree at main's commit, indexed. */
  indexedWorktree: string;
  /** An unrelated repository, indexed. */
  other: string;
  mainHead: string;
}

function makeFixture(): Fixture {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'gnx-wt-fallback-')));
  fixtureRoots.push(root);

  const main = path.join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-b', 'main');
  git(main, 'config', 'user.email', 'wt@fallback.test');
  git(main, 'config', 'user.name', 'Worktree Fallback');
  commit(main, 'a.ts');
  const mainHead = git(main, 'rev-parse', 'HEAD');

  const indexedWorktree = path.join(root, 'wt-indexed');
  git(main, 'worktree', 'add', '--detach', indexedWorktree, mainHead);

  const worktree = path.join(root, 'wt-new');
  git(main, 'worktree', 'add', '-b', 'feature', worktree, mainHead);
  commit(worktree, 'b.ts');

  const other = path.join(root, 'other');
  mkdirSync(other);
  git(other, 'init', '-b', 'main');
  git(other, 'config', 'user.email', 'wt@fallback.test');
  git(other, 'config', 'user.name', 'Worktree Fallback');
  commit(other, 'z.ts');

  return { main, worktree, indexedWorktree, other, mainHead };
}

const entry = (name: string, repoPath: string, lastCommit: string) => ({
  name,
  path: repoPath,
  storagePath: path.join(repoPath, '.gitnexus'),
  indexedAt: '2026-10-08T00:00:00Z',
  lastCommit,
  stats: { files: 1, nodes: 1, edges: 0, communities: 0, processes: 0 },
});

const IMPACT_RESULT = { target: 'x', impactedCount: 0, risk: 'LOW' };

afterAll(() => {
  for (const dir of fixtureRoots) rmSync(dir, { recursive: true, force: true });
});

describe('read-only tools fall back to a sibling worktree index', () => {
  let fx: Fixture;
  let backend: LocalBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    fx = makeFixture();
    backend = new LocalBackend();
  });

  const register = (...entries: ReturnType<typeof entry>[]) =>
    vi.mocked(listRegisteredRepos).mockResolvedValue(entries as never);

  const withCwd = async <T>(cwd: string, fn: () => Promise<T>): Promise<T> => {
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };

  it('serves an explicit unindexed worktree path from a sibling, measured at the worktree HEAD', async () => {
    register(entry('repo', fx.main, fx.mainHead), entry('other', fx.other, 'ffff'));
    await backend.init();
    vi.spyOn(
      backend as unknown as { impact: () => Promise<typeof IMPACT_RESULT> },
      'impact',
    ).mockResolvedValue(IMPACT_RESULT as never);

    const result = (await backend.callTool('impact', {
      target: 'x',
      repo: fx.worktree,
    })) as { staleness: Record<string, unknown> };

    expect(result).toMatchObject(IMPACT_RESULT);
    // Against main's own HEAD this index is current; against the worktree the
    // caller asked about it is one commit behind. Only the latter is honest.
    expect(result.staleness).toMatchObject({
      status: 'behind',
      commitsBehind: 1,
      lastCommit: fx.mainHead,
      servedFrom: fx.main,
    });
    expect(String(result.staleness.hint)).toContain('gitnexus analyze');
  });

  it('prefers the sibling indexed at the worktree HEAD over the main checkout', async () => {
    const wtHead = git(fx.worktree, 'rev-parse', 'HEAD');
    git(fx.indexedWorktree, 'checkout', '--detach', wtHead);
    register(entry('repo', fx.main, fx.mainHead), entry('repo', fx.indexedWorktree, wtHead));
    await backend.init();

    const resolved = await backend.selectToolRepository(fx.worktree, undefined, {
      allowWorktreeFallback: true,
    });
    expect(resolved.repoPath).toBe(fx.indexedWorktree);
    expect(resolved.servedFor).toBe(fx.worktree);
  });

  it('resolves a subdirectory of an indexed checkout to that checkout, not a fallback', async () => {
    register(entry('repo', fx.main, fx.mainHead), entry('other', fx.other, 'ffff'));
    const sub = path.join(fx.main, 'src', 'deep');
    mkdirSync(sub, { recursive: true });
    await backend.init();

    const resolved = await backend.selectToolRepository(sub, undefined, {
      allowWorktreeFallback: true,
    });
    expect(resolved.repoPath).toBe(fx.main);
    expect(resolved.servedFor).toBeUndefined();
  });

  it('marks the single registered repo as a fallback when cwd is an unindexed worktree', async () => {
    register(entry('repo', fx.main, fx.mainHead));
    await backend.init();

    const resolved = await withCwd(fx.worktree, () =>
      backend.selectToolRepository(undefined, undefined, {
        allowCwdDefault: true,
        allowWorktreeFallback: true,
      }),
    );
    expect(resolved.repoPath).toBe(fx.main);
    expect(resolved.servedFor).toBe(fx.worktree);
  });

  it('picks the same-repo sibling instead of failing when several repos are registered', async () => {
    register(entry('repo', fx.main, fx.mainHead), entry('other', fx.other, 'ffff'));
    await backend.init();

    const resolved = await withCwd(path.join(fx.worktree), () =>
      backend.selectToolRepository(undefined, undefined, {
        allowCwdDefault: true,
        allowWorktreeFallback: true,
      }),
    );
    expect(resolved.repoPath).toBe(fx.main);
    expect(resolved.servedFor).toBe(fx.worktree);
  });

  it('never falls back for rename: edits must land in the checkout that was asked for', async () => {
    register(entry('repo', fx.main, fx.mainHead), entry('other', fx.other, 'ffff'));
    await backend.init();

    await expect(
      backend.callTool('rename', { symbol_name: 'x', new_name: 'y', repo: fx.worktree }),
    ).rejects.toThrow(/not found/);
  });

  it('detect_changes diffs the asked-about worktree, even when the sibling is itself a worktree', async () => {
    // Sibling-at-HEAD wins, and it is a linked worktree: resolveWorktreeCwd
    // would return it unchanged, so the diff must come from servedFor directly.
    const wtHead = git(fx.worktree, 'rev-parse', 'HEAD');
    git(fx.indexedWorktree, 'checkout', '--detach', wtHead);
    register(entry('repo', fx.main, fx.mainHead), entry('repo', fx.indexedWorktree, wtHead));
    await backend.init();
    writeFileSync(path.join(fx.worktree, 'b.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(fx.indexedWorktree, 'a.ts'), 'export const sibling = 1;\n');

    const result = (await backend.callTool('detect_changes', {
      repo: fx.worktree,
      scope: 'unstaged',
    })) as { unmapped_files?: string[]; staleness?: { servedFrom?: string } };

    expect(result.unmapped_files).toEqual(['b.ts']);
    expect(result.staleness?.servedFrom).toBe(fx.indexedWorktree);
  });

  it('only graph tools fall back: file readers and an explicit opt-out stay exact', async () => {
    register(entry('repo', fx.main, fx.mainHead), entry('other', fx.other, 'ffff'));
    await backend.init();

    await expect(
      backend.callTool('read_file', { repo: fx.worktree, path: 'a.ts' }),
    ).rejects.toThrow(/not found/);
    await expect(
      backend.callTool('impact', { target: 'x', repo: fx.worktree }, { worktreeFallback: false }),
    ).rejects.toThrow(/not found/);
  });

  it('does not treat two submodules of one superproject as siblings', async () => {
    // Both submodules' common dirs sit under <super>/.git/modules, so their
    // parents are equal; only the common dir itself tells them apart.
    const source = fx.other;
    const sup = path.join(path.dirname(fx.main), 'super');
    mkdirSync(sup);
    git(sup, 'init', '-b', 'main');
    git(sup, 'config', 'user.email', 'wt@fallback.test');
    git(sup, 'config', 'user.name', 'Worktree Fallback');
    for (const name of ['a', 'b']) {
      git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, name);
    }
    const subA = path.join(sup, 'a');
    register(entry('a', subA, git(subA, 'rev-parse', 'HEAD')));
    await backend.init();

    await expect(
      backend.selectToolRepository(path.join(sup, 'b'), undefined, { allowWorktreeFallback: true }),
    ).rejects.toThrow(/not found/);
  });

  it('does not fall back across repositories', async () => {
    register(entry('other', fx.other, 'ffff'), entry('third', fx.indexedWorktree, fx.mainHead));
    await backend.init();
    // fx.worktree belongs to fx.main's repository, which is not registered at
    // all; the indexed worktree IS of that repository, so this is the
    // positive control for the next assertion.
    const sameRepo = await backend.selectToolRepository(fx.worktree, undefined, {
      allowWorktreeFallback: true,
    });
    expect(sameRepo.repoPath).toBe(fx.indexedWorktree);

    register(entry('other', fx.other, 'ffff'));
    await backend.init();
    await expect(
      backend.selectToolRepository(fx.worktree, undefined, { allowWorktreeFallback: true }),
    ).rejects.toThrow(/not found/);
  });
});

describe('stalenessPayload with servedFrom', () => {
  const ref = { lastCommit: 'abc', indexedAt: '2026-10-08T00:00:00Z', servedFrom: '/repo/main' };

  it('says a sibling answered even when that index is current', () => {
    const payload = stalenessPayload(
      { isStale: false, commitsBehind: 0, status: 'current' },
      { ref },
    );
    expect(payload).toMatchObject({ status: 'current', servedFrom: '/repo/main' });
    expect(payload?.hint).toContain('/repo/main');
  });

  it('keeps the freshness hint and appends the fallback hint', () => {
    const payload = stalenessPayload(
      { isStale: true, commitsBehind: 2, status: 'behind', hint: 'Index is 2 commits behind.' },
      { ref },
    );
    expect(payload).toMatchObject({ status: 'behind', commitsBehind: 2, servedFrom: '/repo/main' });
    expect(payload?.hint).toMatch(/^Index is 2 commits behind\. This worktree has no index/);
  });

  it('is unchanged for a ref without servedFrom', () => {
    const { servedFrom: _omit, ...plain } = ref;
    const payload = stalenessPayload(
      { isStale: false, commitsBehind: 0, status: 'current' },
      { ref: plain },
    );
    expect(payload).toEqual({
      status: 'current',
      lastCommit: 'abc',
      indexedAt: '2026-10-08T00:00:00Z',
      measuredAgainst: 'HEAD',
    });
  });
});
