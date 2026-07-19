# WAL task execution status

| Task | Status | Evidence |
|---|---|---|
| `WAL-000` | Complete | `codex/wal-000-legacy-baseline` at `b3498244c954103a034abf0f55b636195bb35af0`; independent semantic oracle, with current sync output explicitly non-normative. |
| `WAL-001` | Consolidated | Its schema, vectors, large-object contract, and two TypeScript conformance consumers now live on `codex/wal-005-iblt-lab` and freeze the RFC v0.7 measured binary64 mapping. |
| `WAL-005` | Implemented and benchmarked | The same branch contains the reconciliation implementation, 100% unit coverage, 100,000-seed proof, 10K/100K/1M/10M baseline, and rotated binary64-versus-integer A/B evidence. |

WAL-001 and WAL-005 now share one linear implementation history, one worktree,
and one authoritative branch. No Go/Rust/Python conformance implementation is
required. The exact-integer mapping is retained only as named A/B experiment
evidence; protocol version 1 uses the benchmarked exact binary64 evaluation
profile and its regenerated language-neutral vectors.
