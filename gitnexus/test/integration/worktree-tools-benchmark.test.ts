/**
 * Deterministic worktree tools benchmark (no LLM).
 *
 * Builds a tiny TypeScript repo with real git, indexes ONE checkout with the
 * real `analyze` (real LadybugDB, isolated GITNEXUS_HOME), then asks the MCP
 * read tools about two linked worktrees that have no index of their own, and
 * grades each answer against ground truth known from the fixture.
 *
 * Two arms:
 *  - `lobi`:     default behaviour (worktree fallback ON).
 *  - `upstream-behavior`: `{ worktreeFallback: false }`; on an error the call is
 *    retried ONCE with `repo` set to the indexed sibling's path, which is what a
 *    real agent did in the README "A/B evaluation".
 *
 * Only the `lobi` arm is asserted. The other arm is measured, not guarded.
 *
 * Run: GITNEXUS_BENCH=1 npx vitest run test/integration/worktree-tools-benchmark.test.ts
 *
 * Needs a built CLI (`npm run build`) and `GITNEXUS_E2E_CLI=dist`: under tsx the
 * analyzer's build-identity check can fail with "Analyzer build changed".
 * Add `--reporter=verbose` to see the printed table.
 * Full command: GITNEXUS_E2E_CLI=dist GITNEXUS_BENCH=1 npx vitest run ... --reporter=verbose
 *
 * Output: JSON at $GITNEXUS_BENCH_OUT (default <tmpdir>/gitnexus-worktree-bench.json).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';

type Arm = 'lobi' | 'upstream-behavior';
type Outcome = 'correct' | 'error' | 'silent-wrong';

interface Row {
  scenario: string;
  arm: Arm;
  outcome: Outcome;
  precision?: number;
  recall?: number;
  medianMs: number;
  retried: boolean;
  staleness?: unknown;
  detail: string;
}

const REPEATS = 5;
const rows: Row[] = [];
const meta: Record<string, unknown> = {};
const roots: string[] = [];

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe', windowsHide: true }).trim();

const MATH = `export function add(a: number, b: number): number {
  return a + b;
}

export function mul(a: number, b: number): number {
  return a * b;
}
`;
const CALC = `import { add } from './math';

export function total(xs: number[]): number {
  let t = 0;
  for (const x of xs) t = add(t, x);
  return t;
}
`;
const REPORT = `import { total } from './calc';

export function render(xs: number[]): string {
  return 'total=' + total(xs);
}
`;
const EXTRA = `import { add } from './math';

export function extra(): number {
  return add(1, 2);
}
`;

const write = (dir: string, file: string, text: string) =>
  fs.writeFileSync(path.join(dir, file), text);
const patch = (dir: string, file: string, from: string, to: string) => {
  const p = path.join(dir, file);
  const s = fs.readFileSync(p, 'utf-8');
  if (!s.includes(from)) throw new Error(`fixture: ${from} not in ${file}`);
  fs.writeFileSync(p, s.replace(from, to));
};

const benchOut = (): string =>
  process.env.GITNEXUS_BENCH_OUT || path.join(os.tmpdir(), 'gitnexus-worktree-bench.json');

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const dirSize = (p: string): number => {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return n;
};

/** Every `name` string anywhere in a result (impact/context shapes differ). */
const collectNames = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => collectNames(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name' && typeof x === 'string') out.add(x);
      else collectNames(x, out);
    }
  }
  return out;
};

const prf = (got: Set<string>, want: Set<string>) => {
  const tp = [...got].filter((x) => want.has(x)).length;
  return { precision: got.size ? tp / got.size : 0, recall: want.size ? tp / want.size : 0 };
};

describe.skipIf(!process.env.GITNEXUS_BENCH)('worktree tools benchmark', () => {
  let home: string;
  let main: string;
  let wtAgent: string;
  let wtAhead: string;
  let backend: import('../../src/mcp/local/local-backend.js').LocalBackend;
  const prevHome = process.env.GITNEXUS_HOME;

  beforeAll(async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'gnx-wt-bench-')));
    roots.push(root);
    home = path.join(root, 'home');
    fs.mkdirSync(home);
    process.env.GITNEXUS_HOME = home;

    main = path.join(root, 'main');
    fs.mkdirSync(path.join(main, 'src'), { recursive: true });
    initGitRepo(main);
    git(main, 'config', 'core.autocrlf', 'false');
    git(main, 'checkout', '-q', '-b', 'main');
    write(main, 'src/math.ts', MATH);
    write(main, 'src/calc.ts', CALC);
    write(main, 'src/report.ts', REPORT);
    write(main, '.gitignore', '.gitnexus\n');
    commitAll(main, 'C0');
    const c0 = git(main, 'rev-parse', 'HEAD');

    wtAgent = path.join(root, 'wt-agent');
    git(main, 'worktree', 'add', '-q', '--detach', wtAgent, c0);
    wtAhead = path.join(root, 'wt-ahead');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', wtAhead, c0);
    write(wtAhead, 'src/extra.ts', EXTRA);
    commitAll(wtAhead, 'C1');

    // Index main at C0 (before its uncommitted edit).
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, 'analyze', main], {
      cwd: main,
      encoding: 'utf-8',
      windowsHide: true,
      env: {
        ...process.env,
        GITNEXUS_HOME: home,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
      },
    });
    meta.analyzeMs = Math.round(performance.now() - t0);
    if (r.status !== 0) throw new Error(`analyze failed: ${r.stdout}\n${r.stderr}`);
    meta.indexBytes = dirSize(path.join(main, '.gitnexus'));
    const reg = fs.existsSync(path.join(home, 'registry.json'))
      ? JSON.parse(fs.readFileSync(path.join(home, 'registry.json'), 'utf-8'))
      : [];
    const stats = (Array.isArray(reg) ? reg : []).find((e: { path?: string }) => e.path)?.stats;
    meta.nodes = stats?.nodes ?? null;
    meta.edges = stats?.edges ?? null;

    // Uncommitted edits, one per checkout ("someone else's edits" on main).
    patch(main, 'src/math.ts', 'return a * b;', 'return a * b + 0;');
    patch(wtAgent, 'src/math.ts', 'return a + b;', 'return a + b + 0;');
    patch(wtAhead, 'src/calc.ts', 'let t = 0;', 'let t = 0; // edited');

    const { LocalBackend } = await import('../../src/mcp/local/local-backend.js');
    backend = new LocalBackend();
    await backend.init();
  }, 600_000);

  afterAll(async () => {
    try {
      await backend?.disconnect?.();
    } catch {
      /* best effort */
    }
    if (prevHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = prevHome;

    const { version } = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8'),
    );
    const out = benchOut();
    fs.writeFileSync(
      out,
      JSON.stringify(
        {
          gitnexusVersion: version,
          node: process.version,
          platform: process.platform,
          ...meta,
          results: rows,
        },
        null,
        2,
      ),
    );
    for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  /** One call, upstream arm retries once against the indexed sibling. */
  async function call(arm: Arm, tool: string, args: Record<string, unknown>) {
    const opts = arm === 'lobi' ? {} : { worktreeFallback: false };
    let retried = false;
    const once = async (a: Record<string, unknown>) => {
      try {
        const res = await backend.callTool(tool, a, opts);
        const isErr = res && typeof res === 'object' && 'error' in (res as object);
        return { res, err: isErr ? String((res as { error: unknown }).error) : undefined };
      } catch (e) {
        return { res: undefined, err: e instanceof Error ? e.message : String(e) };
      }
    };
    const run = async () => {
      let r = await once(args);
      if (r.err && arm !== 'lobi') {
        retried = true;
        // `worktree` (detect_changes) is a separate input; the retry names the
        // indexed sibling as `repo` and drops it, as the A/B agent did.
        const { worktree: _w, ...rest } = args;
        r = await once({ ...rest, repo: main });
      }
      return r;
    };
    const times: number[] = [];
    let last = await run();
    for (let i = 0; i < REPEATS; i++) {
      const t = performance.now();
      last = await run();
      times.push(performance.now() - t);
    }
    return { ...last, retried, medianMs: median(times) };
  }

  const record = (r: Omit<Row, 'detail'> & { detail?: string }) => {
    rows.push({ detail: '', ...r });
    return r;
  };

  async function detect(id: string, arm: Arm, target: string, want: string[]) {
    const c = await call(arm, 'detect_changes', { scope: 'unstaged', repo: target });
    const got = new Set<string>(
      ((c.res as { changed_symbols?: { name: string }[] })?.changed_symbols ?? []).map(
        (s) => s.name,
      ),
    );
    const { precision, recall } = prf(got, new Set(want));
    const outcome: Outcome = c.err
      ? 'error'
      : precision === 1 && recall === 1
        ? 'correct'
        : 'silent-wrong';
    return record({
      scenario: id,
      arm,
      outcome,
      precision,
      recall,
      medianMs: c.medianMs,
      retried: c.retried,
      staleness: (c.res as { staleness?: unknown })?.staleness,
      detail: c.err ?? [...got].join(','),
    });
  }

  for (const arm of ['lobi', 'upstream-behavior'] as Arm[]) {
    describe(arm, () => {
      it('D1 detect_changes on the indexed checkout', async () => {
        const r = await detect('D1', arm, main, ['mul']);
        if (arm === 'lobi') expect(r.outcome).toBe('correct');
      }, 300_000);

      it('D2 detect_changes on unindexed wt-agent', async () => {
        const r = await detect('D2', arm, wtAgent, ['add']);
        if (arm === 'lobi') expect(r.outcome).toBe('correct');
      }, 300_000);

      it('D3 detect_changes on unindexed wt-ahead', async () => {
        const r = await detect('D3', arm, wtAhead, ['total']);
        if (arm === 'lobi') {
          expect(r.outcome).toBe('correct');
          const s = r.staleness as { status?: string; servedFrom?: string } | undefined;
          expect(s?.status === 'behind' || !!s?.servedFrom).toBe(true);
        }
      }, 300_000);

      it('I1 impact upstream of add from wt-agent', async () => {
        const c = await call(arm, 'impact', {
          target: 'add',
          direction: 'upstream',
          repo: wtAgent,
        });
        const names = collectNames(c.res);
        const ok = names.has('total') && names.has('render');
        const r = record({
          scenario: 'I1',
          arm,
          outcome: c.err ? 'error' : ok ? 'correct' : 'silent-wrong',
          medianMs: c.medianMs,
          retried: c.retried,
          detail: c.err ?? [...names].join(','),
        });
        if (arm === 'lobi') expect(r.outcome).toBe('correct');
      }, 300_000);

      it('C1 context for total from wt-ahead', async () => {
        const c = await call(arm, 'context', { name: 'total', repo: wtAhead });
        const found = (c.res as { status?: string })?.status === 'found';
        const r = record({
          scenario: 'C1',
          arm,
          outcome: c.err ? 'error' : found ? 'correct' : 'silent-wrong',
          medianMs: c.medianMs,
          retried: c.retried,
          detail: c.err ?? String((c.res as { status?: string })?.status),
        });
        if (arm === 'lobi') expect(r.outcome).toBe('correct');
      }, 300_000);
    });
  }
  it('prints the report', () => {
    console.log(`\nworktree benchmark (analyze ${meta.analyzeMs} ms, index ${meta.indexBytes} B)`);
    console.log('scenario | arm | outcome | P/R | median ms | retried');
    for (const r of rows) {
      const pr =
        r.precision === undefined ? '-' : `${r.precision.toFixed(2)}/${(r.recall ?? 0).toFixed(2)}`;
      console.log(
        `${r.scenario} | ${r.arm} | ${r.outcome} | ${pr} | ${r.medianMs.toFixed(1)} | ${r.retried}`,
      );
    }
    console.log(`JSON: ${benchOut()}`);
  });
});
