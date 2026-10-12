"""lobibench runner: headless Claude Code sessions, three arms, same prompt.

    python docs/fork/bench/run.py --suite v2 --arms plain,upstream,lobi --passes 3 --model haiku --out <dir>

Suites: v1 (36-file fixture, tasks.json, one indexed repo) and v2 (default; ~180-file fixture,
tasks_v2.json, three indexed repos per MCP arm, a worktree that is ahead of the index).

Arms: plain (no MCP), upstream (registry gitnexus@1.6.12, privately installed), lobi (this checkout's
built CLI). Python 3 stdlib only. See README.md for method and caveats.
"""
import argparse
import collections
import concurrent.futures
import hashlib
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import time

import fixture_v2
import make_fixture

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[2]
UPSTREAM_VERSION = "1.6.12"
LOBI_CLI = REPO / "gitnexus" / "dist" / "cli" / "index.js"
NODE = shutil.which("node") or "node"
IS_WIN = os.name == "nt"
PROMPT_TAIL = (
    "\n\nThis is a read-only question: do not modify any file. Use repo-relative paths "
    "with forward slashes for files and bare identifiers for functions. "
    'End your reply with a final line exactly of the form: ANSWER: ["name", "name"]'
)


def claude_exe():
    w = shutil.which("claude")
    if w and w.lower().endswith(".cmd"):
        exe = pathlib.Path(w).parent / "node_modules/@anthropic-ai/claude-code/bin/claude.exe"
        if exe.exists():
            return str(exe)
    return w or "claude"


UPSTREAM_CLI = None  # set by install_upstream()
FX = make_fixture  # fixture module of the selected suite (set in main)
TASKS_FILE = "tasks.json"


def install_upstream(out):
    """`npx -y gitnexus@1.6.12` would resolve to an npm-linked fork on this machine (same
    version string), so install the registry package into a private prefix instead."""
    global UPSTREAM_CLI
    pfx = out / "upstream-pkg"
    cli = pfx / "node_modules" / "gitnexus" / "dist" / "cli" / "index.js"
    if not cli.exists():
        pfx.mkdir(parents=True, exist_ok=True)
        npm = ["cmd", "/c", "npm"] if IS_WIN else ["npm"]
        subprocess.run(npm + ["install", "--prefix", str(pfx), f"gitnexus@{UPSTREAM_VERSION}"],
                       check=True, cwd=pfx, capture_output=True)
    pkg = json.loads((cli.parents[2] / "package.json").read_text(encoding="utf-8"))
    assert pkg["version"] == UPSTREAM_VERSION, pkg["version"]
    UPSTREAM_CLI = cli


def cli_for(arm):
    return UPSTREAM_CLI if arm == "upstream" else LOBI_CLI


def server_cmd(arm):
    """(command, args) that starts the MCP server for an arm."""
    return NODE, [str(cli_for(arm)), "mcp"]


def analyze_cmd(arm, path):
    return [NODE, str(cli_for(arm)), "analyze", "--index-only", str(path)]


def setup_arm(arm, out):
    """Fresh fixture for this arm, every FX.REGISTRY repo indexed (MCP arms), MCP config file."""
    root = out / "fixtures" / arm
    if root.exists():
        shutil.rmtree(root, onexc=lambda f, p, e: (os.chmod(p, 0o700), f(p)))
    FX.make(root)  # clean C0 (+ C1 on wt-ahead); no edits yet so the index is of clean state
    cfg = {"mcpServers": {}}
    if arm != "plain":
        home = out / "gnhome" / arm
        home.mkdir(parents=True, exist_ok=True)
        env = {**os.environ, "GITNEXUS_HOME": str(home)}
        for name in FX.REGISTRY:  # identical registry in every MCP arm
            t = time.time()
            for attempt in range(3):  # analyzer identity check is flaky on first run ("changed while ... computed")
                r = subprocess.run(analyze_cmd(arm, root / name), env=env, capture_output=True,
                                   text=True, timeout=1800)
                if not r.returncode or "changed while its identity" not in r.stderr + r.stdout:
                    break
            print(f"[{arm}] analyze {name} exit={r.returncode} {time.time() - t:.0f}s", flush=True)
            (out / f"analyze-{arm}-{name}.log").write_text(r.stdout + "\n" + r.stderr, encoding="utf-8")
            if r.returncode:
                sys.exit(f"analyze failed for {arm}/{name}; see analyze-{arm}-{name}.log")
        cmd, args = server_cmd(arm)
        cfg["mcpServers"]["gitnexus"] = {"command": cmd, "args": args,
                                         "env": {"GITNEXUS_HOME": str(home)},
                                         "alwaysLoad": True}
    FX.apply_edits(root)  # uncommitted edits AFTER indexing (the trap)
    cfg_path = out / f"mcp-{arm}.json"
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return root, cfg_path


def _text(c):
    if isinstance(c, list):
        return " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    return c if isinstance(c, str) else json.dumps(c)


def parse(path):
    """tools: name -> count; gn: one record per gitnexus call with its repo/worktree args and error."""
    tools, result, init, gn, byid = {}, None, None, [], {}
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            init = ev
        elif t == "assistant":
            for c in ev.get("message", {}).get("content", []):
                if isinstance(c, dict) and c.get("type") == "tool_use":
                    tools[c["name"]] = tools.get(c["name"], 0) + 1
                    if c["name"].startswith("mcp__gitnexus"):
                        i = c.get("input") or {}
                        rec = {"tool": c["name"].split("__")[-1], "repo": i.get("repo"),
                               "worktree": i.get("worktree"), "scope": i.get("scope"),
                               "error": False, "err": ""}
                        gn.append(rec)
                        byid[c.get("id")] = rec
        elif t == "user":
            cs = ev.get("message", {}).get("content", [])
            for c in cs if isinstance(cs, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in byid:
                    txt = _text(c.get("content"))
                    if c.get("is_error") or re.match(r'\s*(\{\s*"error"|Error)', txt):
                        byid[c["tool_use_id"]].update(error=True, err=txt[:160])
        elif t == "result":
            result = ev
    return tools, result, init, gn


def extract_answer(text):
    found = re.findall(r"ANSWER:\s*(\[.*?\])\s*$", text or "", re.M | re.S)
    if not found:
        return None
    try:
        v = json.loads(found[-1])
    except ValueError:
        return None
    return [str(x).strip().removeprefix("./") for x in v] if isinstance(v, list) else None


def grade(task, answer):
    if answer is None:
        return False
    a = set(answer)
    return set(task["expected"]) <= a and not (set(task["forbidden"]) & a)


def run_session(arm, task, root, cfg, model, budget, out, tag):
    exe = claude_exe()
    cmd = [exe, "-p", task["question"] + PROMPT_TAIL, "--model", model,
           "--output-format", "stream-json", "--verbose",
           "--strict-mcp-config", "--mcp-config", str(cfg),
           "--setting-sources", "project", "--disable-slash-commands",
           "--no-chrome", "--no-session-persistence",
           "--dangerously-skip-permissions", "--disallowedTools", "Edit", "Write", "NotebookEdit",
           "--max-budget-usd", str(budget)]
    env = {**os.environ, "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1", "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1"}
    raw = out / "raw" / f"{tag}.jsonl"
    raw.parent.mkdir(exist_ok=True)
    t = time.time()
    try:
        with open(raw, "wb") as f:
            p = subprocess.run(cmd, cwd=root / task.get("cwd", "wt-agent"), env=env, stdout=f,
                               stderr=subprocess.PIPE, timeout=900)
        err = p.stderr.decode("utf-8", "replace")[-500:]
    except subprocess.TimeoutExpired:
        err = "timeout"
    wall = time.time() - t
    tools, res, init, gn = parse(raw)
    res = res or {}
    u = res.get("usage") or {}
    new_tokens = (u.get("input_tokens", 0) + u.get("output_tokens", 0)
                  + u.get("cache_creation_input_tokens", 0))
    answer = extract_answer(res.get("result"))
    init = init or {}
    return {
        "arm": arm, "task": task["id"], "answer": answer, "correct": grade(task, answer),
        "cost": res.get("total_cost_usd", 0.0), "new_tokens": new_tokens,
        "cache_read_tokens": u.get("cache_read_input_tokens", 0),
        "wall_s": wall, "api_ms": res.get("duration_ms"), "turns": res.get("num_turns"),
        "is_error": bool(res.get("is_error")) or not res, "stop": res.get("subtype"),
        "tools": tools, "gn": gn,
        "gitnexus_calls": sum(n for k, n in tools.items() if k.startswith("mcp__gitnexus")),
        "init_mcp_tools": sum(1 for x in init.get("tools", []) if x.startswith("mcp__gitnexus")),
        "init_mcp_servers": init.get("mcp_servers"), "init_plugins": init.get("plugins"),
        "init_slash": len(init.get("slash_commands", [])), "model_used": init.get("model"),
        "stderr": err,
    }


def tree_hash(root):
    h = hashlib.sha256()
    for sub in FX.CHECKOUTS:
        r = subprocess.run(["git", "diff"], cwd=root / sub, capture_output=True)
        h.update(r.stdout)
    return h.hexdigest()


def ms(xs):
    return (statistics.mean(xs), statistics.stdev(xs) if len(xs) > 1 else 0.0) if xs else (0.0, 0.0)


def summarize(rows, arms, passes, tasks, out, meta):
    S = {"meta": meta, "arms": {}, "invalid_passes": []}
    md = ["# lobibench summary", "",
          f"suite {meta['suite']}, model {meta['model']}, Claude Code {meta['claude']}, {meta['os']}, gitnexus upstream "
          f"{UPSTREAM_VERSION} vs lobi {meta['lobi_version']}, {meta['date']}", "",
          "| arm | score | cost $ | new tokens | wall s | turns | used gitnexus | invalid passes |",
          "|---|---|---|---|---|---|---|---|"]
    for arm in arms:
        per_pass, bad = [], []
        for p in range(1, passes + 1):
            r = [x for x in rows if x["arm"] == arm and x["pass"] == p]
            if not r:
                continue
            if arm != "plain" and sum(x["gitnexus_calls"] for x in r) == 0:
                bad.append(p)
                S["invalid_passes"].append({"arm": arm, "pass": p})
            per_pass.append((p, r))
        valid = [r for p, r in per_pass if p not in bad]
        arm_rows = [x for r in valid for x in r]
        f = lambda key: ms([sum(x[key] or 0 for x in r) for r in valid])
        sc = ms([sum(x["correct"] for x in r) / len(r) for r in valid])
        used = sum(1 for x in rows if x["arm"] == arm and x["gitnexus_calls"] > 0)
        n = sum(1 for x in rows if x["arm"] == arm)
        # per-pass cost/tokens/wall/turns are totals over that pass's sessions
        S["arms"][arm] = {
            "score_mean": sc[0], "score_sd": sc[1],
            "cost_per_pass": f("cost"), "new_tokens_per_pass": f("new_tokens"),
            "wall_s_per_pass": f("wall_s"), "turns_per_pass": f("turns"),
            "sessions_used_gitnexus": used, "sessions": n, "valid_passes": [p for p, _ in per_pass if p not in bad],
            "invalid_passes": bad, "mean_sessions_per_valid_pass": len(arm_rows),
        }
        fmt = lambda t, d=1: f"{t[0]:.{d}f} ± {t[1]:.{d}f}"
        md.append(f"| {arm} | {sc[0]:.2f} ± {sc[1]:.2f} | {fmt(f('cost'), 3)} | {fmt(f('new_tokens'), 0)} | "
                  f"{fmt(f('wall_s'), 0)} | {fmt(f('turns'))} | "
                  f"{used} / {n if arm != 'plain' else n} | {bad or '-'} |")
    md += ["", "Cost, tokens, wall and turns are totals per pass (all tasks), mean ± sd over valid passes. "
           "New tokens = input + output + cache creation (cache reads excluded). Invalid pass = MCP arm "
           "with zero gitnexus calls in the whole pass; it is excluded from means.", "",
           "## Per-task correctness (correct sessions / sessions)", "",
           "| task | " + " | ".join(arms) + " |", "|---|" + "---|" * len(arms)]
    for t in tasks:
        cells = []
        for arm in arms:
            r = [x for x in rows if x["arm"] == arm and x["task"] == t["id"]]
            cells.append(f"{sum(x['correct'] for x in r)}/{len(r)}")
        md.append(f"| {t['id']} | " + " | ".join(cells) + " |")
    md += ["", "## Per-task gitnexus calls (mean per session)", "",
           "| task | " + " | ".join(a for a in arms if a != "plain") + " |",
           "|---|" + "---|" * len([a for a in arms if a != "plain"])]
    for t in tasks:
        cells = []
        for arm in arms:
            if arm == "plain":
                continue
            r = [x for x in rows if x["arm"] == arm and x["task"] == t["id"]]
            cells.append(f"{statistics.mean([x['gitnexus_calls'] for x in r]):.1f}" if r else "-")
        md.append(f"| {t['id']} | " + " | ".join(cells) + " |")
    # what the agent actually passed to gitnexus, and whether it hit an error (MCP arms)
    md += ["", "## gitnexus call details per task (all passes)", "",
           "`repo`/`worktree` = argument values passed (basename; `-` = omitted), with counts. "
           "errors = tool results that were errors.", "",
           "| arm | task | calls | errors | tools | repo args | worktree args | first error |",
           "|---|---|---|---|---|---|---|---|"]
    base = lambda v: "-" if v is None else (v if v in ("", ".") else pathlib.PurePath(str(v).replace("\\", "/")).name or v)
    cnt = lambda xs: ", ".join(f"{k}x{n}" for k, n in sorted(collections.Counter(xs).items())) or "-"
    for arm in arms:
        if arm == "plain":
            continue
        for t in tasks:
            g = [c for x in rows if x["arm"] == arm and x["task"] == t["id"] for c in x.get("gn", [])]
            if not g:
                continue
            e = next((c["err"] for c in g if c["error"]), "").replace("|", "/").replace(chr(10), " ")
            md.append(f"| {arm} | {t['id']} | {len(g)} | {sum(c['error'] for c in g)} | "
                      f"{cnt(c['tool'] for c in g)} | {cnt(base(c['repo']) for c in g)} | "
                      f"{cnt(base(c['worktree']) for c in g)} | {e[:100]} |")
    md += ["", f"Total spend: ${meta['total_cost']:.2f}" + (" (STOPPED at cap)" if meta["capped"] else "")]
    (out / "summary.json").write_text(json.dumps(S, indent=2), encoding="utf-8")
    (out / "summary.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", choices=["v1", "v2"], default="v2")
    ap.add_argument("--arms", default="plain,upstream,lobi")
    ap.add_argument("--passes", type=int, default=3)
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--out", required=True)
    ap.add_argument("--tasks", default="", help="comma-separated task ids (default: all)")
    ap.add_argument("--cap", type=float, default=12.0, help="stop when cumulative cost exceeds this")
    ap.add_argument("--budget", type=float, default=1.0, help="--max-budget-usd per session")
    a = ap.parse_args()
    global FX, TASKS_FILE
    if a.suite == "v2":
        FX, TASKS_FILE = fixture_v2, "tasks_v2.json"
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    arms = a.arms.split(",")
    tasks = json.loads((HERE / TASKS_FILE).read_text(encoding="utf-8"))
    if a.tasks:
        keep = a.tasks.split(",")
        tasks = [t for t in tasks if t["id"] in keep or t["id"].split("-")[0] in keep]
    if "lobi" in arms and not LOBI_CLI.exists():
        sys.exit(f"build first: cd gitnexus && npm ci && npm run build ({LOBI_CLI} missing)")
    if "upstream" in arms:
        install_upstream(out)
    with concurrent.futures.ThreadPoolExecutor() as ex:  # arms have separate roots and GITNEXUS_HOME
        setups = dict(zip(arms, ex.map(lambda arm: setup_arm(arm, out), arms)))
    base_hash = {arm: tree_hash(root) for arm, (root, _) in setups.items()}
    rows, total, capped = [], 0.0, False
    jl = open(out / "sessions.jsonl", "a", encoding="utf-8")
    for p in range(1, a.passes + 1):
        for arm in arms:
            root, cfg = setups[arm]
            for t in tasks:
                tag = f"p{p}-{arm}-{t['id']}"
                r = run_session(arm, t, root, cfg, a.model, a.budget, out, tag)
                r["pass"] = p
                mutated = tree_hash(root) != base_hash[arm]
                r["mutated_fixture"] = mutated
                FX.apply_edits(root)  # restore pristine state every time
                rows.append(r)
                jl.write(json.dumps(r) + "\n")
                jl.flush()
                total += r["cost"]
                print(f"{tag}: correct={r['correct']} cost=${r['cost']:.3f} turns={r['turns']} "
                      f"gn={r['gitnexus_calls']} (init mcp tools {r['init_mcp_tools']}) "
                      f"ans={r['answer']} total=${total:.2f}", flush=True)
                if total > a.cap:
                    capped = True
                    break
            if capped:
                break
        if capped:
            print(f"STOP: cumulative cost ${total:.2f} exceeds cap ${a.cap}")
            break
    cv = subprocess.run([claude_exe(), "--version"], capture_output=True, text=True).stdout.strip()
    lv = json.loads((REPO / "gitnexus" / "package.json").read_text(encoding="utf-8"))["version"]
    meta = {"model": a.model, "claude": cv, "os": sys.platform + " " + os.environ.get("OS", ""),
            "lobi_version": lv, "date": time.strftime("%Y-%m-%d"), "total_cost": total,
            "capped": capped, "suite": a.suite, "passes_requested": a.passes, "arms": arms}
    summarize(rows, arms, a.passes, tasks, out, meta)


if __name__ == "__main__":
    main()
