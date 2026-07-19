# WAL task execution status

| Task | Status | Evidence |
|---|---|---|
| `WAL-000` | Complete | `codex/wal-000-legacy-baseline` at `b3498244c954103a034abf0f55b636195bb35af0`; independent semantic oracle, with current sync output explicitly non-normative. |
| `WAL-001` | Consolidated | Its schema, vectors, large-object contract, and two TypeScript conformance consumers now live on `codex/wal-005-iblt-lab` and freeze the RFC v0.7 measured binary64 mapping. |
| `WAL-002` | Implemented and verified | The same branch contains the legacy-default runtime scaffold, isolated parallel state, fail-closed signed-cutover gate, CLI/API status, lifecycle tests, and stable configuration errors. See `WAL-002-EVIDENCE.md`. |
| `WAL-003` | Implemented and verified | The same branch contains the exact RFC 8949 tuple codec, all frozen typed protocol schemas, domain-separated identities, EIP-191 signing/recovery, existing signer-shape adapters, golden-vector conformance, canonicality negatives/property tests, and 100% package coverage. See `WAL-003-EVIDENCE.md`. |
| `WAL-004` | Implemented and verified | The same branch contains the four-method complete-object store, scalable SQLite-indexed append-only segments, the reference file backend, streaming canonical/signature/ID verification, resumable bounded range staging, crash recovery at every durability point, a 10K/100K/1M/10M packed-store matrix, large-object evidence, adversarial filesystem/quota tests, and 100% package coverage. See `WAL-004-EVIDENCE.md`. |
| `WAL-005` | Implemented and benchmarked | The same branch contains the reconciliation implementation, 100% unit coverage, 100,000-seed proof, 10K/100K/1M/10M baseline, and rotated binary64-versus-integer A/B evidence. |
| `WAL-006` | Implemented and verified | The same branch contains versioned SQLite/FULL control state, atomic local finalization and remote admission, guarded independent rollback high-water, durable bounded queues/cache/quarantine/GC metadata, restart and integrity blocking, 25 focused tests, and 100% package coverage. See `WAL-006-EVIDENCE.md`. |

WAL-001 through WAL-006 now share one linear implementation history, one worktree,
and one authoritative branch. No Go/Rust/Python conformance implementation is
required. The exact-integer mapping is retained only as named A/B experiment
evidence; protocol version 1 uses the benchmarked exact binary64 evaluation
profile and its regenerated language-neutral vectors.
