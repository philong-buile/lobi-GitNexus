# lobibench

An agent benchmark for this fork, modeled on token-savior's `tsbench`. Real headless Claude Code sessions answer read-only code questions about a small planted-trap TypeScript repo, in three arms with the same prompt and model:

| arm | MCP server |
|---|---|
| `plain` | none (built-in Read/Grep/Glob/Bash only) |
| `upstream` | registry `gitnexus@1.6.12` (the fork's base version) |
| `lobi` | this checkout's built CLI, `node gitnexus/dist/cli/index.js mcp` |

Each MCP arm gets its own `GITNEXUS_HOME` (set in the MCP config env and for `analyze`), its own fixture copy, and `"alwaysLoad": true` so Claude Code does not defer the tools behind ToolSearch. The real `~/.gitnexus` is never touched. The run checks that the tools really were in the session (`init` event) and counts calls whose name starts with `mcp__gitnexus`; an MCP arm with zero such calls over a whole pass is marked INVALID and excluded from the means.

## Fixture and traps (`make_fixture.py`, deterministic)

36 TypeScript files under `src/` (plus `package.json`, `tsconfig.json`), committed as C0 on `main` in `<root>/main`.

1. Duplicate name: `formatPrice` in `src/billing/format.ts` and `src/catalog/format.ts`, different callers (t2, t3).
2. Chain `parseAmount` <- `toCents` <- `buildInvoice` <- `sendInvoice`, plus an unrelated `refundTotal` -> `sumLines` (t4).
3. Import cycle `src/cycle/a.ts -> b.ts -> c.ts -> a.ts`; `d.ts` imports `a` but is not in the cycle (t5).
4. Dead `computeTax`; live `computeTaxRate` (the name contains the dead one) (t7).
5. Table dispatch `handlers[kind](x)`, with a `handleLegacy` that is not in the table (t8).
6. Worktree trap (t6): `main` is indexed, then given an uncommitted edit inside `roundCents` ("someone else's work"). `<root>/wt-agent` (`git worktree add -b agent-task` at C0) is NOT indexed and has an uncommitted edit inside `applyDiscount`. Every session runs with cwd = `wt-agent`. t1 is an easy control (which file exports `CURRENCY`).

`tasks.json` holds the 8 tasks with `expected` (all must appear) and `forbidden` (none may appear). Grading is mechanical and case-sensitive: correct iff `expected` is a subset of the answer and `forbidden` is disjoint from it. The prompt ends with "final line exactly `ANSWER: ["name", ...]`". Tasks were fixed before any run and not changed afterwards.

## Method details and deviations

- Command per session: `claude -p <prompt> --model haiku --output-format stream-json --verbose --strict-mcp-config --mcp-config <arm.json> --setting-sources project --disable-slash-commands --no-chrome --no-session-persistence --dangerously-skip-permissions --disallowedTools Edit Write NotebookEdit --max-budget-usd 1`, env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Sessions run sequentially.
- After every session both checkouts are `git checkout`ed and the two uncommitted edits re-applied; `git diff` is hashed before/after to flag a session that mutated the fixture (0 of 72 did). The index (built once, on clean C0) is therefore never stale.
- `analyze --index-only` is used for both arms (keeps the indexed repo free of generated `AGENTS.md`/skill files).
- **Deviation from `npx -y gitnexus@1.6.12`:** on this machine the global `gitnexus` is an npm link to this fork and reports the same version string, so `npx gitnexus@1.6.12` ran the fork. The runner instead installs the registry package into a private prefix (`npm install --prefix <out>/upstream-pkg gitnexus@1.6.12`) and runs that. It exposes 17 MCP tools; the fork's HEAD exposes 19 (the fork also contains upstream commits after the 1.6.12 release, so "same version" is not "same code").
- Cost cap: the runner stops when cumulative `total_cost_usd` exceeds $10 (not reached).
- "New tokens" = input + output + cache creation, excluding cache reads (as token-savior does).

### What is and is not neutralized

Neutralized equally in all arms: user and local settings, user hooks, user `enabledPlugins` and user skills (`--setting-sources project`; the fixture has no project settings), slash commands/skills (`--disable-slash-commands`; init reports 0 skills), all other MCP servers (`--strict-mcp-config`), CLAUDE.md auto-discovery and auto-memory (the two env vars above; init does not report these, so this is not independently verified), Chrome integration, session persistence.

Not neutralized: `--bare` was not used because it disables OAuth login. Organization-managed policy, if any, still applies. The `plain` arm's init lists one built-in plugin (`plugin-authoring`) that the MCP arms do not; it has no tools of its own. Haiku resolved to `claude-haiku-4-5-20251001`. Bash is not removed, so the "read-only" instruction is a prompt rule, backed by the reset-and-hash check above.

## Reproduce

```bash
cd gitnexus && npm ci && npm run build && cd ..
python docs/fork/bench/run.py --arms plain,upstream,lobi --passes 3 --model haiku --out <dir>
# smoke: --passes 1 --tasks t6
```

Output in `<dir>`: `sessions.jsonl` (one record per session), `raw/*.jsonl` (stream-json transcripts, fixture content only, not committed), `summary.json`, `summary.md`. Python 3 stdlib only. Each analyze took about 3 minutes here for the 36-file repo, so allow roughly 45 minutes for the full run.

## Result (2026-10-12)

Windows 11, Claude Code 2.1.263, model `haiku` (`claude-haiku-4-5-20251001`), upstream gitnexus 1.6.12 vs lobi 1.6.12 base (HEAD `548cfa42` plus these files). 3 passes x 8 tasks x 3 arms = 72 sessions, 0 invalid passes, 0 errors, total spend $2.64.

Cost, new tokens, wall time and turns are totals per pass (8 tasks), mean ± sd over 3 passes.

| arm | score (correct/total) | cost $ | new tokens | wall s | turns | sessions that used gitnexus |
|---|---|---|---|---|---|---|
| plain | 1.00 ± 0.00 | 0.476 ± 0.106 | 76299 ± 25610 | 225 ± 42 | 100.3 ± 19.5 | n/a |
| upstream | 1.00 ± 0.00 | 0.197 ± 0.008 | 33030 ± 724 | 106 ± 6 | 25.7 ± 2.3 | 16 / 24 |
| lobi | 1.00 ± 0.00 | 0.207 ± 0.014 | 34721 ± 2162 | 111 ± 14 | 24.3 ± 2.1 | 15 / 24 |

Per-task correctness was 3/3 in every arm for all 8 tasks.

What this shows, and what it does not:

- **No accuracy difference.** Haiku solved every task in every arm, so this task set is at ceiling and cannot separate the arms on correctness. Grep and Read are enough for a 36-file repo.
- **Efficiency difference is between plain and MCP, not between upstream and lobi.** Both MCP arms cost about 2.3x less, used about 2.2x fewer new tokens and about a quarter of the turns of `plain`. Upstream vs lobi is within noise (difference smaller than one sd).
- **The worktree trap (t6) did not discriminate.** The upstream package also answered correctly (applyDiscount, priceCart, quoteOrder) in 3/3 passes. In these sessions the agent called `detect_changes` with no `repo` argument and got the `wt-agent` diff, unlike the A/B run in the top-level README, where the agent passed a sibling worktree's path as `repo`. The mechanism was not investigated here. The fork's advantage in that README is about the explicit-`repo` path, which this prompt did not elicit; lobi itself skipped gitnexus on t6 in pass 3 (answered from `git diff` and Read, correctly).
- Tool use was partial: t1 (control) and t8 (dispatch) never called gitnexus in either MCP arm, and 17 of 48 MCP sessions used no gitnexus tool at all. Table dispatch was answered correctly from source by all arms.
- n = 3 passes of 8 small tasks with one cheap model: a smoke-level benchmark, not evidence for or against the fork beyond "no regression versus 1.6.12 on this set". Harder tasks (larger repo, the explicit-`repo` worktree path, a stronger-grep-resistant graph question) would be needed to separate the arms.
