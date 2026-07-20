# WAL-002 implementation evidence

## Outcome

WAL-002 adds the daemon-facing runtime skeleton required to develop OT-RFC-65
as a parallel protocol without changing production authority. The existing DKG
semantic layer, SVM/verified-memory behavior, cryptography, graph writes,
queries, and current synchronization remain untouched and authoritative.

The implementation deliberately resolves and owns WAL runtime configuration in
the daemon boundary rather than injecting incomplete WAL semantics into
`DKGAgent`. Later tasks may connect mutation capture and adapters through typed
interfaces after their canonical objects and shared-core replay adapters exist.

## Runtime contract

| Mode | Registration and state | Synchronization authority | Startup gate |
|---|---|---|---|
| omitted / `legacy` | No runtime, directories, protocols, workers, timers, or ports | Legacy | None added |
| `parallel` | Isolated lifecycle controller and directories below `<DKG_HOME>/wal-v1` | Legacy | Explicit operator selection |
| `wal` | Future authoritative runtime | WAL only after verification and readiness | Exact `CutoverId` plus injected signed-cutover verifier |

A string mode or configured `cutoverId` cannot bypass the gate. The production
daemon intentionally supplies no cutover verifier in WAL-002, so `wal` mode
fails before network resolution or agent creation with
`WAL_CUTOVER_VERIFIER_UNAVAILABLE`. A blocked or merely constructed runtime
continues to report legacy authority.

The fixed isolated layout is:

```text
<DKG_HOME>/wal-v1/
  objects/
  range-staging/
  quarantine/
  shadow-rdf/
  control/runtime.json
```

The marker is written atomically on ready, drain, and stop transitions. Custom
component paths must remain strict non-overlapping descendants of the fixed
root and may not traverse symlinks. No legacy progress file, graph, or store is
reused.

## Operator surfaces

- Persistent config: `sync.mode` and versioned `sync.wal` settings in
  `<DKG_HOME>/config.json`.
- One-run override: `dkg start --sync-mode legacy|parallel|wal`, passed only to
  the child daemon as `DKG_WAL_SYNC_MODE` without rewriting config.
- CLI visibility: `dkg status` prints mode, lifecycle, and current authority.
- API visibility: `GET /api/status` returns the typed `wal` runtime status.
- Stable failures: invalid mode/config/path/version/cutover and lifecycle
  failures use `WAL_*` reason codes and abort startup before partial daemon boot.

## Acceptance mapping

1. The workspace dependency and TypeScript project reference are wired into the
   CLI; the full dependency-ordered CLI build completes.
2. Omitted mode resolves to `legacy`, returns no runtime, creates no WAL path,
   and reports zero registered protocols and workers.
3. `parallel` creates only the isolated shadow lifecycle state and always
   reports `synchronizationAuthority: legacy`.
4. `wal` requires both an exact lower-case bytes32 `CutoverId` and an injected
   verifier. The daemon has no configuration-only verifier path.
5. Start, replay, drain, stop, and process-restart reconstruction are tested;
   the runtime opens no listener, interval, worker, or protocol and holds no
   shared legacy state.
6. Table-driven tests cover malformed blocks, every unknown mode, unsupported
   versions, unsafe paths, overlap, symlink traversal, and cutover failures with
   exact stable codes.

## Validation receipts

```text
pnpm -r --filter @origintrail-official/dkg... run build
  PASS: 18-package dependency closure and CLI build

pnpm --filter @origintrail-official/dkg-wal test:types
  PASS

pnpm --filter @origintrail-official/dkg-wal test:coverage
  PASS: 11 files passed, 1 scale file skipped by its explicit stress gate
  PASS: 76 tests, 2 gated scale tests skipped
  PASS: 100% statements, branches, functions, and lines

pnpm --filter @origintrail-official/dkg exec vitest run \
  test/wal-runtime.test.ts \
  test/status-command-store.test.ts \
  test/status-route-store-quads.test.ts \
  test/daemon-startup-validation.test.ts
  PASS: 4 files, 18 tests
```

WAL-002 does not claim that the complete parallel protocol is already running.
It creates the enforceable authority and isolation boundary on which WAL-003+
can safely add protocol semantics.
