# WAL parallel-protocol implementation task pack

This directory turns OT-RFC-65 v0.6 into an implementation backlog for
OriginTrail DKG. It is intentionally created in an isolated worktree based on
the current remote `main`; it does not reuse or modify the dirty primary
checkout.

## Repository baseline

| Item | Value |
|---|---|
| Repository | `OriginTrail/dkg-v9` |
| Base ref | `origin/main` |
| Base commit | `a6f33e408335930f009c49781684bc79dd322b7b` |
| Planning branch | `codex/wal-parallel-protocol-task-pack` |
| Worktree | `/private/tmp/dkg-v9-wal-parallel-protocol-task-pack` |
| RFC source repository | `OriginTrail/dkgv10-spec` |
| RFC source commit | `224501923af36213b47b945958068e4c48de3f9f` |
| RFC version | `0.6` |
| RFC SHA-256 | `11c1a48e38fad0f3ccb81cb584c19f270595669d6840d936be3cf1b732ec9784` |
| Schema SHA-256 | `df5681933e8409ba946c5533e113929f64b4e1de5f4976d15cab1d2740ffe4ea` |
| Vectors SHA-256 | `1de9c274f027e110b8a8fdbdd4302db744eb7f2d3c0f73166b989600963294a0` |

## Mandatory system-context contract

[OT-RFC-65-wal-byte-set-reconciliation-sync.md](OT-RFC-65-wal-byte-set-reconciliation-sync.md)
is the complete, verbatim RFC and is the
normative system context for **every** task in [TASKS.md](TASKS.md).
Its normative schema and byte fixtures are mirrored verbatim under
[`vectors/`](vectors/) and are part of that system context.

A task must not be dispatched by copying only its task section. The task runner
must receive:

1. the complete contents of `OT-RFC-65-wal-byte-set-reconciliation-sync.md` as
   system context;
2. the complete normative schema and vector files under `vectors/`;
3. the selected `WAL-xxx` task section as the task request;
4. the current repository and dependency state at execution time.

The RFC is authoritative when a task summary is shorter or ambiguous. A task
may narrow its implementation scope, but it may not weaken RFC invariants,
security boundaries, measurable goals, or acceptance gates. Any necessary RFC
change must be proposed in `dkgv10-spec` first and the system-context snapshot
must then be refreshed with its new source commit and checksum.

[OT-RFC-65-comparison-with-OT-RFC-64.md](OT-RFC-65-comparison-with-OT-RFC-64.md) is
informative context. It preserves the separate comparison with OT-RFC-64 / PR
#144 but is not a substitute for the RFC.

## Parallel-protocol boundary

Until the final cutover tasks are accepted:

- the existing graph-sync and graph-write path remains production-authoritative;
- WAL records, reconciliation, and RDF projection run only under explicit
  `parallel` configuration;
- WAL network traffic uses separate versioned protocols and durable state;
- shadow WAL failures must be visible but must not corrupt or silently block the
  authoritative path;
- production reads must not consume shadow graphs;
- no task may introduce per-collection mixed authority;
- no legacy handler is removed before the signed hard-cutover gate.

The implementation preserves existing SWM/VM, membership, authorship,
private-access, Sender Key, KA identity, chain-finality, and reorg semantics.
The WAL changes replication, durability, replay, and projection mechanics. It
must not silently redefine DKG business or cryptographic authority.

## Execution waves

```mermaid
flowchart TD
    A["Wave 0: baseline and specification freeze"] --> B["Wave 1: byte primitives and durable stores"]
    B --> C["Wave 2: authority, privacy, transport, and admission"]
    C --> D["Wave 3: RDF compiler, reducer, materializer, and VM lifecycle"]
    D --> E["Wave 4: snapshots, backfill, and parallel runtime wiring"]
    E --> F["Wave 5: observability, fault injection, security, and benchmarks"]
    F --> G["Wave 6: signed cutover rehearsal and legacy retirement"]
```

| Wave | Tasks | Exit condition |
|---|---|---|
| 0 | `WAL-000`–`WAL-002` | Baseline receipts, frozen wire decisions, safe feature/config skeleton. |
| 1 | `WAL-003`–`WAL-006` | Canonical objects, whole-object range storage, rateless IBLT reconciliation, signed set commitments, and crash-safe WAL storage pass conformance tests. |
| 2 | `WAL-007`–`WAL-011` | Authority, private crypto adapter, wire protocols, provider discovery, and closed admission work fail-closed. |
| 3 | `WAL-012`–`WAL-016` | Local commits and identical admitted sets produce deterministic SWM/VM projections without semantic drift. |
| 4 | `WAL-017`–`WAL-020` | Snapshot/delta backfill and the complete network shadow protocol run beside legacy authority. |
| 5 | `WAL-021`–`WAL-022` | Security, crash, scale, and measurable-goal evidence gates pass. |
| 6 | `WAL-023`–`WAL-024` | Full-inventory cutover rehearsal passes; only then may WAL become authoritative and legacy sync be retired. |

## Task completion rules

Every task contains an **Acceptance area**. A task is complete only when every
checkbox is evidenced. “Code exists,” “unit tests pass,” or “works locally” is
not sufficient by itself.

For every task:

- preserve the RFC context and record any resolved ambiguity;
- add focused unit tests and the narrowest meaningful integration/devnet test;
- include negative and restart/fault cases, not only happy paths;
- run typecheck/build/lint for affected packages;
- attach exact commands, commit, environment, raw digests, and relevant metrics;
- store large/generated receipts as CI artifacts or under a task-specific `/tmp`
  result directory, not as accidental repository changes;
- keep the authoritative legacy path unchanged unless the task explicitly owns
  cutover or retirement;
- leave the worktree clean when handing off.

## Artifacts

- [STATUS.md](STATUS.md) — task execution status with exact branch/commit evidence.
- [TASKS.md](TASKS.md) — detailed task list and acceptance areas.
- [COVERAGE.md](COVERAGE.md) — RFC-section and freeze-item coverage matrix.
- [OT-RFC-65-wal-byte-set-reconciliation-sync.md](OT-RFC-65-wal-byte-set-reconciliation-sync.md) — complete normative RFC system context.
- [`vectors/`](vectors/) — exact protocol-v1 schema registry and valid/invalid conformance bytes.
- [OT-RFC-65-comparison-with-OT-RFC-64.md](OT-RFC-65-comparison-with-OT-RFC-64.md) — separate informative comparison.
