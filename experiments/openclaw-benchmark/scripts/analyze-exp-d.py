#!/usr/bin/env python3
from __future__ import annotations

import json
from pathlib import Path
import statistics

BASE = Path("/Users/aleatoric/dev/dkg-v9/experiments/openclaw-benchmark/results")


def summarize(exp: str):
    files = sorted((BASE / exp / "round1").glob("*.json"))
    rows = []
    for p in files:
        with p.open() as f:
            d = json.load(f)
        ok = d.get("num_turns") is not None and not d.get("is_error", False)
        u = d.get("usage", {})
        rows.append(
            {
                "stream": p.stem,
                "ok": ok,
                "cost": float(d.get("total_cost_usd", 0.0)),
                "turns": int(d.get("num_turns") or 0),
                "cache": int(u.get("cache_read_input_tokens", 0)),
            }
        )
    ok_rows = [r for r in rows if r["ok"]]
    costs = [r["cost"] for r in ok_rows] or [0.0]
    turns = [r["turns"] for r in ok_rows] or [0]
    return {
        "rows": rows,
        "success": len(ok_rows),
        "total_cost": sum(r["cost"] for r in rows),
        "total_turns": sum(r["turns"] for r in rows),
        "total_cache": sum(r["cache"] for r in rows),
        "cost_cv": (statistics.pstdev(costs) / statistics.mean(costs)) if len(costs) > 1 and statistics.mean(costs) else 0.0,
        "turn_cv": (statistics.pstdev(turns) / statistics.mean(turns)) if len(turns) > 1 and statistics.mean(turns) else 0.0,
    }


def main():
    d1 = summarize("exp-d1")
    d2 = summarize("exp-d2")
    print("| Metric | D1 (Shared MD) | D2 (DKG publish/query) |")
    print("|---|---:|---:|")
    print(f"| Stream completion | {d1['success']}/4 | {d2['success']}/4 |")
    print(f"| Total cost | ${d1['total_cost']:.2f} | ${d2['total_cost']:.2f} |")
    print(f"| Total turns | {d1['total_turns']} | {d2['total_turns']} |")
    print(f"| Cache-read tokens | {d1['total_cache']:,} | {d2['total_cache']:,} |")
    print(f"| Cost consistency CV (lower better) | {d1['cost_cv']:.3f} | {d2['cost_cv']:.3f} |")
    print(f"| Turn consistency CV (lower better) | {d1['turn_cv']:.3f} | {d2['turn_cv']:.3f} |")


if __name__ == "__main__":
    main()
