# node-store persistence (devnet)

Pins the daemon's durable protocol state on a live devnet after it moved out of
the dashboard package into `@origintrail-official/dkg-node-store` (Phase 1: a
package move; the SQLite file is still `node-ui.db`).

What it checks, on real nodes:

1. Every node's `node-ui.db` is at the shipped schema version, carries every
   protocol table (with the columns the stores use) and index, and there is no
   second protocol database beside it.
2. Cores have a populated chain-event log (`SqliteChainEventLogStore`) whose
   cursor is consistent with its coverage and rows.
3. A publish into a Context Graph the suite creates allocates through the KA
   number store (`ka_numbers` advances), and the chain-log cursor keeps
   following the chain.

The suite opens every database **read-only** (a live node owns it, and
`DashboardDB`'s constructor migrates and prunes) and never touches the shared
`devnet-test` graph.

```bash
pnpm run build:packages && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:node-store-persistence
```

Runtime: a few minutes (one on-chain Context Graph registration and one publish).
