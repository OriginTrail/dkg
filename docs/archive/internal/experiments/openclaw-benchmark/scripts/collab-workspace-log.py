#!/usr/bin/env python3
"""
Shared workspace collaboration log for Experiment C1.

Usage:
  python collab-workspace-log.py read --file <path> [--limit 30]
  python collab-workspace-log.py write --file <path> --run-id <id> --agent <id> --feature <id> --kind <kind> --summary <text> [--paths "a,b,c"]
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
from datetime import datetime, timezone


def read_entries(path: str, limit: int) -> int:
    if not os.path.exists(path):
        print("(no shared entries yet)")
        return 0

    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    if not lines:
        print("(no shared entries yet)")
        return 0

    for line in lines[-limit:]:
        print(line.rstrip("\n"))
    return 0


def write_entry(
    path: str,
    run_id: str,
    agent: str,
    feature: str,
    kind: str,
    summary: str,
    paths: str,
) -> int:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "agent": agent,
        "feature": feature,
        "kind": kind,
        "summary": summary,
        "paths": [p.strip() for p in paths.split(",") if p.strip()] if paths else [],
    }

    lock_path = f"{path}.lock"
    with open(lock_path, "a+", encoding="utf-8") as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
        try:
            with open(path, "a", encoding="utf-8") as out:
                out.write(json.dumps(payload, ensure_ascii=True) + "\n")
        finally:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)

    print(json.dumps(payload, ensure_ascii=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    read_p = sub.add_parser("read")
    read_p.add_argument("--file", required=True)
    read_p.add_argument("--limit", type=int, default=30)

    write_p = sub.add_parser("write")
    write_p.add_argument("--file", required=True)
    write_p.add_argument("--run-id", required=True)
    write_p.add_argument("--agent", required=True)
    write_p.add_argument("--feature", required=True)
    write_p.add_argument("--kind", required=True)
    write_p.add_argument("--summary", required=True)
    write_p.add_argument("--paths", default="")

    args = parser.parse_args()
    if args.cmd == "read":
        return read_entries(args.file, args.limit)
    if args.cmd == "write":
        return write_entry(
            args.file,
            args.run_id,
            args.agent,
            args.feature,
            args.kind,
            args.summary,
            args.paths,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
