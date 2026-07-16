# core-peers-features — devnet validation

End-to-end devnet gate for the chain-driven VM reconciliation effort
("full Telegram on top of chain"): Phases **B / C / D / E / F**.

## What it proves

| Phase | Assertion |
|-------|-----------|
| **F** | Every node serves `/api/replication/{summary,per-cg,timeline,cursors,events}` backed by the V19 `replication_events` table. |
| **B + E** | A public publish drives the reconciler: a core's per-CG contiguous watermark advances past 0, telemetry is persisted, and `daemon.log` carries the `chain-promote` grep surface. |
| **D (recording)** | A core that signs a StorageACK for a public CG marks it `coreHosted` (cursor inspector Role = `host`), persisted. |
| **D (fill-the-gap)** | A core taken **offline during a publish** learns the missed KA from chain on restart and fills its own gap — observed as a `core-fill` replication event and/or the missed triple landing in that core's verifiable-memory. |
| **C** | The additive, unsigned `sinceBatchId` hint does not regress normal catch-up sync. (Its responder/envelope behaviour is unit-pinned in `packages/agent/test/sync-{responder,envelope}-cursor.test.ts`; it has no active production caller yet, so it isn't independently triggerable on devnet.) |

## Run

```bash
pnpm run build
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:core-peers-features
```

Runtime ~3-6 min. The fill-the-gap test stops and restarts **node2** (a core)
via `./scripts/devnet.sh restart-node 2`, so expect that node to blip during
the run.
