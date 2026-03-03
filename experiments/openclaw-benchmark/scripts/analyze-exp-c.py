#!/usr/bin/env python3
"""
Analyze Experiment C1/C2 for speed, cost, consistency, and collaboration signals.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
import subprocess
from pathlib import Path

BASE = Path("/Users/aleatoric/dev/dkg-v9/experiments/openclaw-benchmark")
RESULTS = BASE / "results"


def load_feature(exp: str, feat: str):
    for rnd in ("round1", "round2"):
        p = RESULTS / exp / rnd / f"{feat}.json"
        if p.exists():
            with p.open("r", encoding="utf-8") as f:
                d = json.load(f)
            if d.get("num_turns") is None:
                return {"ok": False, "cost": 0.0, "turns": 0, "status": "timeout"}
            if d.get("is_error"):
                return {
                    "ok": False,
                    "cost": float(d.get("total_cost_usd", 0.0)),
                    "turns": int(d.get("num_turns", 0)),
                    "status": "error",
                }
            u = d.get("usage", {})
            return {
                "ok": True,
                "cost": float(d.get("total_cost_usd", 0.0)),
                "turns": int(d.get("num_turns", 0)),
                "cache_read": int(u.get("cache_read_input_tokens", 0)),
                "status": "ok",
            }
    return {"ok": False, "cost": 0.0, "turns": 0, "status": "missing"}


def summarize_exp(exp: str):
    feats = [f"r1-f{i}" for i in range(1, 5)] + [f"r2-f{i}" for i in range(1, 5)]
    rows = [load_feature(exp, feat) for feat in feats]
    ok_rows = [r for r in rows if r["ok"]]
    costs = [r["cost"] for r in ok_rows]
    turns = [r["turns"] for r in ok_rows]

    total_cost = sum(r["cost"] for r in rows)
    success = len(ok_rows)
    fail = len(rows) - success
    total_turns = sum(turns)
    total_cache_read = sum(r.get("cache_read", 0) for r in ok_rows)

    # Consistency metrics (lower is better)
    cost_cv = statistics.pstdev(costs) / statistics.mean(costs) if len(costs) > 1 and statistics.mean(costs) > 0 else 0.0
    turns_cv = statistics.pstdev(turns) / statistics.mean(turns) if len(turns) > 1 and statistics.mean(turns) > 0 else 0.0

    return {
        "success": success,
        "fail": fail,
        "total_cost": total_cost,
        "total_turns": total_turns,
        "total_cache_read": total_cache_read,
        "cost_cv": cost_cv,
        "turns_cv": turns_cv,
    }


def c1_collab_entries(run_id: str) -> int:
    shared = RESULTS / "exp-c1" / "shared" / f"{run_id}.jsonl"
    if not shared.exists():
        return 0
    with shared.open("r", encoding="utf-8") as f:
        return sum(1 for _ in f)


def c2_published_entities(run_id: str) -> int:
    token_file = Path.home() / ".dkg" / "auth.token"
    if not token_file.exists():
        return 0
    token = ""
    with token_file.open("r", encoding="utf-8") as f:
        for line in f:
            t = line.strip()
            if t and not t.startswith("#"):
                token = t
                break
    if not token:
        return 0

    sparql = (
        "SELECT (COUNT(DISTINCT ?s) AS ?cnt) WHERE { "
        "?s ?p ?o . "
        f'FILTER(CONTAINS(STR(?s), "urn:exp-c2:{run_id}:")) '
        "}"
    )
    payload = json.dumps({"sparql": sparql, "paranetId": "dev-coordination"})
    try:
        raw = subprocess.check_output(
            [
                "curl",
                "-s",
                "-X",
                "POST",
                "http://127.0.0.1:9200/api/query",
                "-H",
                "Content-Type: application/json",
                "-H",
                f"Authorization: Bearer {token}",
                "-d",
                payload,
            ],
            text=True,
        )
        data = json.loads(raw)
        bindings = data.get("result", {}).get("bindings", [])
        if not bindings:
            return 0
        cnt_raw = bindings[0].get("cnt", "\"0\"")
        m = re.search(r"\d+", cnt_raw)
        return int(m.group(0)) if m else 0
    except Exception:
        return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--c1-run-id", default="", help="Run ID used in run-exp-c1.sh")
    parser.add_argument("--c2-run-id", default="", help="Run ID used in run-exp-c2.sh")
    args = parser.parse_args()

    c1 = summarize_exp("exp-c1")
    c2 = summarize_exp("exp-c2")

    print("## Experiment C Summary\n")
    print("| Metric | C1 Workspace Collaboration | C2 Full Publishing |")
    print("|---|---:|---:|")
    print(f"| Completion | {c1['success']}/8 | {c2['success']}/8 |")
    print(f"| Total cost | ${c1['total_cost']:.2f} | ${c2['total_cost']:.2f} |")
    print(f"| Total turns | {c1['total_turns']} | {c2['total_turns']} |")
    print(f"| Cache read tokens | {c1['total_cache_read']:,} | {c2['total_cache_read']:,} |")
    print(f"| Cost consistency (CV, lower better) | {c1['cost_cv']:.3f} | {c2['cost_cv']:.3f} |")
    print(f"| Turn consistency (CV, lower better) | {c1['turns_cv']:.3f} | {c2['turns_cv']:.3f} |")

    if args.c1_run_id:
        print(f"| C1 shared-memory entries | {c1_collab_entries(args.c1_run_id)} | — |")
    if args.c2_run_id:
        print(f"| C2 published entities (run-scoped) | — | {c2_published_entities(args.c2_run_id)} |")


if __name__ == "__main__":
    main()
