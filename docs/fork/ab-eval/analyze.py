"""Summarize `claude -p --output-format stream-json --verbose` transcripts.

Usage: python analyze.py upstream.jsonl lobi.jsonl
Prints cost, duration, turns, tool counts, and every gitnexus call with the
full `detect_changes` changed-symbol list, so the two arms can be compared.
"""

import collections
import json
import sys

for path in sys.argv[1:]:
    tools, pending, gn, result = collections.Counter(), {}, [], None
    for line in open(path, encoding="utf-8"):
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "assistant":
            for c in ev["message"].get("content", []):
                if c.get("type") == "tool_use":
                    tools[c["name"]] += 1
                    pending[c["id"]] = c["name"]
        elif ev.get("type") == "user" and isinstance(ev["message"].get("content"), list):
            for c in ev["message"]["content"]:
                name = pending.get(c.get("tool_use_id"))
                if c.get("type") == "tool_result" and name and "gitnexus" in name:
                    content = c.get("content")
                    text = content[0].get("text", "") if isinstance(content, list) else str(content)
                    gn.append((name.split("__")[-1], bool(c.get("is_error")), text))
        elif ev.get("type") == "result":
            result = ev

    print(f"===== {path} =====")
    if result:
        print(f"turns={result.get('num_turns')} cost=${result.get('total_cost_usd', 0):.2f} "
              f"duration={result.get('duration_ms', 0) / 1000:.0f}s")
    print("tools:", dict(tools))
    print(f"gitnexus calls={len(gn)} errors={sum(e for _, e, _ in gn)}")
    for name, err, text in gn:
        print(f"  {name}{' ERROR' if err else ''}")
        if name == "detect_changes":
            try:
                body = json.loads(text.split("\n---")[0])
                for s in body.get("changed_symbols", []):
                    print("    changed:", s.get("id"))
                for p in body.get("affected_processes", []):
                    print("    process:", p.get("name"))
            except ValueError:
                print("   ", text[:300])
