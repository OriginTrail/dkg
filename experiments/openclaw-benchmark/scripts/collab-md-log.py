#!/usr/bin/env python3
"""
Markdown collaboration logger for Experiment D1.
Writes append-only markdown entries with file locking.
"""

from __future__ import annotations

import argparse
import fcntl
import os
from datetime import datetime, timezone


def append_entry(path: str, run_id: str, agent: str, stream: str, kind: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lock_path = f"{path}.lock"
    ts = datetime.now(timezone.utc).isoformat()
    entry = (
        f"\n## {ts} | {kind}\n"
        f"- runId: `{run_id}`\n"
        f"- agent: `{agent}`\n"
        f"- stream: `{stream}`\n"
        f"- note: {text}\n"
    )
    with open(lock_path, "a+", encoding="utf-8") as lockf:
        fcntl.flock(lockf.fileno(), fcntl.LOCK_EX)
        try:
            with open(path, "a", encoding="utf-8") as out:
                out.write(entry)
        finally:
            fcntl.flock(lockf.fileno(), fcntl.LOCK_UN)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--file", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--agent", required=True)
    p.add_argument("--stream", required=True)
    p.add_argument("--kind", required=True)
    p.add_argument("--text", required=True)
    args = p.parse_args()
    append_entry(args.file, args.run_id, args.agent, args.stream, args.kind, args.text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
