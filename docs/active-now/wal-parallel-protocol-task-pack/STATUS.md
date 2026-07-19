# WAL task execution status

| Task | Status | Evidence |
|---|---|---|
| `WAL-000` | Complete | `codex/wal-000-legacy-baseline` at `b3498244c954103a034abf0f55b636195bb35af0`; independent semantic oracle, with current sync output explicitly non-normative. |
| `WAL-001` | Complete | `codex/wal-001-protocol-freeze` at `f3ff597b6`; RFC v0.6 and hard-bound follow-up at spec commit `224501923af36213b47b945958068e4c48de3f9f`; 40 TypeScript tests and strict typecheck pass. |
| `WAL-005` | Experimental branch preserved | `codex/wal-005-iblt-lab` remains isolated. Its tuning/benchmark evidence is not a substitute for the WAL-001 integer-only schema/vectors and must be rebased before implementation acceptance. |

WAL-001 introduced no new implementation language. Its two independent
conformance consumers are TypeScript. The provisional Go files that exist only
on the earlier WAL-005 experiment branch are not part of WAL-001 and are not a
protocol requirement.

The WAL-001 code branch and WAL-005 experiment branch use the same physical
worktree sequentially, but remain separate Git histories. Switching task work
must preserve a clean tree and an explicit task branch.
