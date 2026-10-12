# lobibench

An agent benchmark for this fork, modeled on token-savior's `tsbench`. Real headless Claude Code sessions answer read-only code questions about a planted-trap TypeScript repo, in three arms with the same prompt and model:

| arm | MCP server |
|---|---|
| `plain` | none (built-in Read/Grep/Glob/Bash only) |
| `upstream` | registry `gitnexus@1.6.12` (the fork's base version) |
| `lobi` | this checkout's built CLI, `node gitnexus/dist/cli/index.js mcp` |

Each MCP arm gets its own `GITNEXUS_HOME` (set in the MCP config env and for `analyze`), its own fixture copy, and `"alwaysLoad": true` so Claude Code does not defer the tools behind ToolSearch. The real `~/.gitnexus` is never touched. The run checks that the tools really were in the session (`init` event) and counts calls whose name starts with `mcp__gitnexus`; an MCP arm with zero such calls over a whole pass is marked INVALID and excluded from the means.

## Suites

| suite | fixture | tasks | indexed repos per MCP arm |
|---|---|---|---|
| `v1` | `make_fixture.py`, 36 files | `tasks.json`, 8 | 1 (`main`) |
| `v2` (default) | `fixture_v2.py`, 180 `.ts` files | `tasks_v2.json`, 15 (v1's 8 + 7 new) | 3 (`main`, `notes-app`, `cli-tool`) |

`--suite v1` still runs the original benchmark unchanged.

### Why v2

v1 hit a ceiling: all three arms scored 24/24 on Haiku. It also did not separate upstream from lobi on the worktree task, because each arm's `GITNEXUS_HOME` held exactly one indexed repo, so upstream's call without `repo` resolved to it. In real use a developer has many repos indexed, and then a call without `repo` errors (`Multiple repositories indexed`) and the agent has to choose one. v2 therefore:

1. Indexes two unrelated small repos (`notes-app`, `cli-tool`, 5 files each) next to `main` in each MCP arm's registry, identically in both arms. Neither worktree is indexed.
2. Adds `wt-ahead` (branch `feature-ahead`, one commit C1 ahead of the indexed C0) with its own uncommitted edit. Sessions for the two worktree-ahead tasks run with cwd = `wt-ahead`.
3. Grows the fixture to 180 files of deterministic noise and traps.

## v2 fixture (`fixture_v2.py`, deterministic, no randomness)

The 36 v1 files, plus:

- 99 bulk files, `src/modules/<9 domains>/<10 entities>.ts` + barrel `index.ts` per domain, each with `load/validate/summarize` functions and a chain of calls to the previous entity.
- Look-alike names (`formatPriceRange`, `formatPrices`, `parseAmounts`, `parseAmountStrict`, `toCentsSafe`, `computeTaxes`, `applyDiscounts`, `handleRefundLater`) in `src/lookalikes/`, none of which call or define a v1 task symbol.
- Trap code for the new tasks: a 5-level chain with a prefix-named decoy (`computeChecksum` <- `signPayload` <- `buildEnvelope` <- `queueMessage` <- `flushOutbox` <- `runNightlyJob`; decoy `computeChecksumLegacy`); aliased imports (`import { computeGrandTotal as grandTotal }`) plus an unrelated local `grandTotal`; a barrel re-export of `printLabel` with the same name defined in three modules, reached directly, through the barrel, and through the barrel under an alias; comments and strings that mention `chargeCard` without calling it, and a prefix-named `chargeCardLater`; two classes with a `post` method called through instances.
- `wt-ahead` C1 adds `applyCoupon` (`src/billing/coupon.ts`), calls it from `priceCart` (changed) and a new `redeemCode`, and moves the `computeShipping` call from `summarizeCart` to a new `cartTotals`. Uncommitted edits: `main` has one inside `roundCents` ("someone else's work"), `wt-agent` inside `applyDiscount`, `wt-ahead` inside `computeShipping`.

## v2 tasks (written before any v2 run, not edited afterwards)

t1-t8 are the v1 tasks, unchanged, now on the 180-file fixture. New:

| id | what it needs | expected | forbidden |
|---|---|---|---|
| t9-deep-chain | transitive callers, depth 5 | signPayload, buildEnvelope, queueMessage, flushOutbox, runNightlyJob | verifyPayload, auditChecksums, describeChecksum, peekOutbox |
| t10-alias | callers that import under another name | renderSummary, exportCsv, buildDashboard | renderLegacy |
| t11-barrel | barrel re-export, same name in 3 modules, alias | dispatchParcel, reprintLabel, batchLabels | stockBinTag, createReturnSlip |
| t12-string-mention | comments/strings are not calls | checkoutCart, renewSubscription | describeBilling, scheduleRetry, explainFailure, auditNotes, deferPayment, chargeCardLater |
| t13-method | method called through class instances | recordSale, closeMonth | recordNote |
| t14-ahead-callers | callers of a function that exists only in `wt-ahead` HEAD | priceCart, redeemCode | quoteOrder |
| t15-ahead-diff | own uncommitted change + direct callers as the code stands in `wt-ahead` | computeShipping, cartTotals | roundCents, summarizeCart |

Grading is mechanical and case-sensitive: correct iff `expected` is a subset of the answer and `forbidden` is disjoint from it. The prompt ends with "final line exactly `ANSWER: ["name", ...]`". No v2 task was found to be factually wrong, so none was changed after the runs. Note on t15: `summarizeCart` is what the indexed graph (C0) says calls `computeShipping`; it is the stale answer, deliberately forbidden. `roundCents` is the edit in `main`.

## v1 fixture and traps (`make_fixture.py`)

36 TypeScript files under `src/` (plus `package.json`, `tsconfig.json`), committed as C0 on `main` in `<root>/main`.

1. Duplicate name: `formatPrice` in `src/billing/format.ts` and `src/catalog/format.ts`, different callers (t2, t3).
2. Chain `parseAmount` <- `toCents` <- `buildInvoice` <- `sendInvoice`, plus an unrelated `refundTotal` -> `sumLines` (t4).
3. Import cycle `src/cycle/a.ts -> b.ts -> c.ts -> a.ts`; `d.ts` imports `a` but is not in the cycle (t5).
4. Dead `computeTax`; live `computeTaxRate` (the name contains the dead one) (t7).
5. Table dispatch `handlers[kind](x)`, with a `handleLegacy` that is not in the table (t8).
6. Worktree trap (t6): `main` is indexed, then given an uncommitted edit inside `roundCents`. `<root>/wt-agent` (`git worktree add -b agent-task` at C0) is NOT indexed and has an uncommitted edit inside `applyDiscount`. Every t1-t13 session runs with cwd = `wt-agent`. t1 is an easy control.

## Method details and deviations

- Command per session: `claude -p <prompt> --model haiku --output-format stream-json --verbose --strict-mcp-config --mcp-config <arm.json> --setting-sources project --disable-slash-commands --no-chrome --no-session-persistence --dangerously-skip-permissions --disallowedTools Edit Write NotebookEdit --max-budget-usd 1`, env `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Sessions run sequentially; the three arms' fixtures are built and indexed in parallel.
- After every session all checkouts are `git checkout`ed and the uncommitted edits re-applied; `git diff` is hashed before/after to flag a session that mutated the fixture (0 of 135 did in v2). The indices (built once, on clean state, before the edits) are therefore never stale with respect to `main`.
- `analyze --index-only` is used for every repo in both arms (keeps the indexed repos free of generated `AGENTS.md`/skill files). The analyzer's identity check failed once on a first run ("changed while its identity was being computed", same flake as noted in the repo README), so the runner retries `analyze` up to 3 times on that error only.
- **Deviation from `npx -y gitnexus@1.6.12`:** on this machine the global `gitnexus` is an npm link to this fork and reports the same version string, so `npx gitnexus@1.6.12` ran the fork. The runner instead installs the registry package into a private prefix (`npm install --prefix <out>/upstream-pkg gitnexus@1.6.12`) and runs that. It exposes 17 MCP tools; the fork's HEAD exposes 19 (the fork also contains upstream commits after the 1.6.12 release, so "same version" is not "same code").
- Cost cap: the runner stops when cumulative `total_cost_usd` exceeds `--cap` (default 12; not reached).
- "New tokens" = input + output + cache creation, excluding cache reads (as token-savior does).
- For every gitnexus call the runner records the tool, the `repo`, `worktree` and `scope` arguments, and whether the result was an error (`is_error` or an `Error`/`{"error"` body). `summary.md` aggregates these per arm and task.

### What is and is not neutralized

Neutralized equally in all arms: user and local settings, user hooks, user `enabledPlugins` and user skills (`--setting-sources project`; the fixture has no project settings), slash commands/skills (`--disable-slash-commands`; init reports 0 skills), all other MCP servers (`--strict-mcp-config`), CLAUDE.md auto-discovery and auto-memory (the two env vars above; init does not report these, so this is not independently verified), Chrome integration, session persistence.

Not neutralized: `--bare` was not used because it disables OAuth login. Organization-managed policy, if any, still applies. The `plain` arm's init may list one built-in plugin (`plugin-authoring`) that the MCP arms do not; it has no tools of its own. Haiku resolved to `claude-haiku-4-5-20251001`. Bash is not removed, so the "read-only" instruction is a prompt rule, backed by the reset-and-hash check above.

## Reproduce

```bash
cd gitnexus && npm ci && npm run build && cd ..
python docs/fork/bench/run.py --suite v2 --arms plain,upstream,lobi --passes 3 --model haiku --out <dir>
# smoke: --passes 1 --tasks t14,t15
# original benchmark: --suite v1
```

Output in `<dir>`: `sessions.jsonl` (one record per session, including the per-call `gn` list), `raw/*.jsonl` (stream-json transcripts, fixture content only, not committed), `summary.json`, `summary.md`. Python 3 stdlib only. Indexing took 1-6 minutes per repo here (v2: three repos per arm, both arms in parallel), then about 53 minutes for the 135 sessions.

## Result, v2 (2026-10-12)

Windows 11 Pro, Claude Code 2.1.263, model `haiku` (`claude-haiku-4-5-20251001`), upstream gitnexus 1.6.12 (registry) vs lobi (1.6.12 base, HEAD `7d1e98b4` plus the v2 files). 3 passes x 15 tasks x 3 arms = 135 sessions, 0 invalid passes, 0 errored sessions, 0 fixture mutations, total spend $5.19.

Cost, new tokens, wall time and turns are totals per pass (15 tasks), mean ± sd over 3 passes.

| arm | score (correct/total) | cost $ | new tokens | wall s | turns | sessions that used gitnexus |
|---|---|---|---|---|---|---|
| plain | 0.98 ± 0.04 (44/45) | 0.704 ± 0.113 | 114685 ± 17724 | 515 ± 191 | 133.7 ± 24.9 | n/a |
| upstream | 0.93 ± 0.07 (42/45) | 0.549 ± 0.054 | 78080 ± 4808 | 282 ± 38 | 69.7 ± 5.9 | 28 / 45 |
| lobi | 0.89 ± 0.04 (40/45) | 0.476 ± 0.031 | 75414 ± 4150 | 231 ± 14 | 60.0 ± 9.6 | 36 / 45 |

Per-task correct sessions (of 3):

| task | plain | upstream | lobi |
|---|---|---|---|
| t1-control | 3 | 3 | 3 |
| t2-dup-billing | 3 | 3 | 3 |
| t3-dup-catalog | 3 | 3 | 3 |
| t4-chain | 3 | 3 | 3 |
| t5-cycle | 2 | 3 | 3 |
| t6-worktree | 3 | 3 | 3 |
| t7-dead | 3 | 2 | 3 |
| t8-dispatch | 3 | 3 | 3 |
| t9-deep-chain | 3 | 3 | 1 |
| t10-alias | 3 | 3 | 3 |
| t11-barrel | 3 | 3 | 3 |
| t12-string-mention | 3 | 3 | 3 |
| t13-method | 3 | 3 | 3 |
| t14-ahead-callers | 3 | 3 | 3 |
| t15-ahead-diff | 3 | 1 | 0 |

### What the MCP agents actually did

gitnexus calls over all 45 sessions per arm (88 upstream, 64 lobi):

| | upstream | lobi |
|---|---|---|
| calls that returned an error | 29 (28 sessions) | 10 (7 sessions) |
| `repo` omitted / `"."` / a registry name | 20 / 28 / 40 | 54 / 1 / 9 |
| `detect_changes` calls | 0 | 4 |
| `worktree` argument passed | 0 | 1 (a `wt-agent` path) |

- **Upstream hit the multi-repo problem in 28 of 45 sessions**, almost always the same way: the agent passed `repo: "."` (meaning "the current directory"), got `Repository "." not found. Available: cli-tool, main, notes-app`, and then either called `list_repos` or guessed `main` and retried. That is wasted turns (the call counts above; about 1.15x the cost and 1.22x the wall time of lobi), not wrong answers: it always recovered by picking `main`, whose graph is the same as `wt-agent`'s C0. One call without `repo` got the documented `Multiple repositories indexed` error.
- **Lobi mostly succeeded with no `repo` at all** (54 omitted-`repo` calls; `context`, `impact` and `detect_changes` resolved the agent's worktree to the indexed sibling `main`). Its 10 errors were mostly `grep`/`check` without `repo` (`Multiple repositories indexed`, 6) and `Symbol 'applyCoupon' not found` (3, t14). The fork's `grep`/`check` tools did not get the same resolution.
- **The failure the README's A/B section describes (upstream's `detect_changes` diffing a sibling's tree) did not occur here**, because upstream never called `detect_changes` in any session (0 of 45), including t6 and t15 where it would be the natural tool. It used `context` plus Bash/Read instead. Lobi called it 4 times and its diff was the agent's own tree each time (it reported `computeShipping`, not `roundCents`), served "from sibling worktree ...\main" with a staleness hint.
- **t15 shows the limit of the worktree fallback, and lobi lost it.** Lobi correctly found the changed function from its own diff, then asked `context` for callers and got the indexed C0 answer (`summarizeCart`), although the tool output carried `commitsBehind: 1` and the sibling path in `servedFrom`. Haiku did not act on that hint in any of the 3 passes (0/3). Upstream's single pass was a session that never called gitnexus and read the code (plain got 3/3). Neither MCP server can know a function moved in a commit the index has not seen; the fork's fallback makes the diff right but the callers can still be stale.
- **t14** (symbol exists only in `wt-ahead` HEAD): both MCP arms passed 3/3, but not because of the graph. Upstream's agent never called gitnexus (grep/Read). Lobi's called it, got `Symbol 'applyCoupon' not found` / empty `grep` results from the index, and fell back to Read, which cost more turns (11 gitnexus calls, 3.7 per session).
- **t9** (depth 5): lobi 1/3. The agent called `impact` with the default depth, whose result lists three levels (`byDepthCounts` 1, 2, 3), and answered with those three; upstream's agent passed a larger `maxDepth` (32, or 10) in all three sessions and got all five; lobi's did so only in its one passing session. Same default depth in both servers, so this is agent behavior, not a lobi regression, but it is a real failure mode of trusting `impact` output.
- Other misses: plain t5 answered `cycle/a.ts` without the `src/` prefix (format, not understanding); upstream t7 listed `computeTaxRate` as uncalled in one session.

### Reading the result

- **Accuracy: no win for either MCP arm.** plain 44/45, upstream 42/45, lobi 40/45. The ordering is driven by t9 and t15 (5 of the 9 wrong sessions are lobi's), n = 3 per task and one cheap model, so a 2-session gap is within what a different sampling seed could produce. v2 un-saturated the benchmark but not in the direction of lobi.
- **Efficiency: MCP arms still beat plain**, about 1.3-1.5x cheaper, 1.5x fewer new tokens, about half the turns and 1.8-2.2x faster in wall time on this larger repo (v1 on 36 files: about 2.3x cheaper). Lobi vs upstream: 13% cheaper and 18% faster in wall time, from fewer `repo` guessing round trips; cost difference is about 1.4 sd, wall about 1.3 sd of the upstream spread, suggestive rather than established.
- **Where the fork helps and where it did not:** it removes the multi-repo friction (no `repo: "."` dead end for `context`/`impact`/`detect_changes`), and its `detect_changes` stays on the agent's own tree. It does not fix stale-index callers for code newer than the index, and the agent's trust in the graph can make it worse than reading the source (t15).

### Caveats

- One model (Haiku), one OS, one fixture, 3 passes. Not evidence about stronger models, which may pass `repo` and `maxDepth` correctly and heed staleness hints.
- Task wording was fixed before running, but the tasks were designed knowing the failure modes under test, and t15 in particular is built so the indexed graph is stale. It measures behavior in that situation, not average usefulness.
- The upstream failure mode that motivated v2 (diffing a sibling's tree) was not elicited; the multi-repo difference showed up as wasted calls instead.
- `plain` benefits from a 180-file repo being small enough to grep; the cost gap would widen on larger repos.
- Token and cost figures come from Claude Code's `result` event; wall time includes MCP server start-up and varies with machine load (plain sd is large).

## Result, v1 (2026-10-12)

Windows 11, Claude Code 2.1.263, model `haiku`, upstream gitnexus 1.6.12 vs lobi 1.6.12 base (HEAD `548cfa42` plus these files). 3 passes x 8 tasks x 3 arms = 72 sessions, 0 invalid passes, 0 errors, total spend $2.64.

Totals per pass (8 tasks), mean ± sd over 3 passes.

| arm | score (correct/total) | cost $ | new tokens | wall s | turns | sessions that used gitnexus |
|---|---|---|---|---|---|---|
| plain | 1.00 ± 0.00 | 0.476 ± 0.106 | 76299 ± 25610 | 225 ± 42 | 100.3 ± 19.5 | n/a |
| upstream | 1.00 ± 0.00 | 0.197 ± 0.008 | 33030 ± 724 | 106 ± 6 | 25.7 ± 2.3 | 16 / 24 |
| lobi | 1.00 ± 0.00 | 0.207 ± 0.014 | 34721 ± 2162 | 111 ± 14 | 24.3 ± 2.1 | 15 / 24 |

- All three arms solved every task (ceiling), so v1 could not separate them on accuracy. Both MCP arms cost about 2.3x less than `plain`; upstream vs lobi was within noise.
- The worktree trap (t6) did not discriminate: with one indexed repo, upstream's no-`repo` call resolved to it and upstream 1.6.12's `detect_changes` already takes a `worktree` argument. That is what v2's realistic registry addresses.
- 17 of 48 MCP sessions used no gitnexus tool at all (t1 control and t8 dispatch never did).
- n = 3 passes of 8 small tasks with one cheap model: a smoke-level benchmark.
