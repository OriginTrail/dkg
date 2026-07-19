# OT-RFC-64 Gate 1 public/open harness contract

This bounded harness freezes the deterministic evidence contract and process
orchestration needed for the first RFC-64 public/open one-row synchronization.
It runs an author adapter process and a receiver adapter process concurrently,
then kills and restarts the receiver against the same durable directory.

The artifact proves that the harness and verifier require:

- distinct author and receiver peer identities;
- exact successor head, catalog-row, bundle, and public-content digests;
- exact KA UAL, inventory row count, SWM graph, and activated quad count;
- an exact durable applied-head readback after positive activation;
- a forged author attestation failure with zero activation and no applied head;
- a durable repair intent followed by `SIGKILL`, receiver restart, repair of the
  applied-head gap, and exact semantic plus applied-state post-read.

The current adapter is deliberately identified as
`deterministic-fixture-adapter-v1` and the raw artifact has
`gateEvaluation.status = "not-evaluated"`. It does **not** claim a production
Gate 1 pass. Combined commit `1f9119ac8` does not yet contain the successor
producer from `6c14bd4ad15b79cc889d0308dd1d1cac60467747` or the serialized
durable applied-head behavior from
`ebbfb34f9bd0a0833ee5adb925cba67c527c91a8`. Once those APIs are assembled,
replace the adapter commands with production `DKGAgent` calls while preserving
the closed evidence schema and verifier.

The closed adapter boundary requires exactly six production operations, without
depending on current service internals: `publishGenesis`, `publishSuccessor`,
`announce`, `appliedHeadReadback`, `exactInventoryReadback`, and `killRestart`.

Run the deterministic process exercise and separate fail-closed verifier:

```sh
pnpm test:gate1:rfc64-public-open-harness
```

Run only the schema/model mutation tests or strict typecheck:

```sh
pnpm test:gate1:rfc64-public-open-harness:unit
pnpm typecheck:gate1:rfc64-public-open-harness
```

The raw and verdict artifacts are written atomically as owner-only stable JSON:

```text
devnet/rfc64-gate1-public-open/artifacts/gate1-result.json
devnet/rfc64-gate1-public-open/artifacts/gate1-verdict.json
```

They contain no timestamp, PID, duration, temporary path, or random identifier.
The generator pins a clean tracked repository `HEAD` before spawning and after
all processes exit; the verifier independently pins the same commit. Artifact
bytes therefore remain identical across runs on the same tested commit.
