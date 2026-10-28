# node-store persistence (devnet)

Pins the daemon's durable protocol state on a live devnet after it moved out of
the dashboard package into `@origintrail-official/dkg-node-store` (Phase 1: a
package move; the SQLite file is still `node-ui.db`).

What it checks, on real nodes:

1. Every node's `node-ui.db` is at the shipped schema version, carries every
   protocol table (with the columns the stores use) and index, and there is no
   second protocol database beside it.
2. Every node has a populated chain-event log (`SqliteChainEventLogStore`)
   whose cursor is consistent with its coverage and rows.
3. A publish into a Context Graph the suite creates allocates through the KA
   number store (`ka_numbers` advances), and the chain log follows the chain
   through that publish, on every node. The publish transaction is identified
   on the chain (the hash the CLI reports, its receipt, the receipt's one
   `KnowledgeAssetRegisteredToContextGraph` log for the published KA), and each
   node must then show, in its own `node-ui.db`, the cursor of its own chain-log
   scope at or past the receipt's block **and** that event in `chain_events`
   (same transaction hash, block, log index, contract and topics). The scope
   (`<chainId>:hub=<hub>:<hub>`) is built from the node's `config.json`, because
   `chain_index_cursor` holds one row per scope and a maximum over the table says
   nothing about this deployment. A head that merely moved since before the
   Context Graph was registered would not do: registering mines a block before the
   publish does.

The suite opens every database **read-only** (a live node owns it, and
`DashboardDB`'s constructor migrates and prunes) and never touches the shared
`devnet-test` graph.

```bash
pnpm run build:packages && pnpm --dir packages/cli run build:prepared
./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
pnpm test:devnet:node-store-persistence
```

Runtime: a few minutes (one on-chain Context Graph registration and one publish).

The decision behind check 3 is a pure function (`chain-log-follows.ts`), unit-tested
without a devnet in `chain-log-follows.test.ts` against a scratch `node-ui.db` built
through the real `DashboardDB` schema and written through the real
`SqliteChainEventLogStore`: a cursor at the registration block but before the
publish block, a cursor of another scope, an event of another transaction, and a
missing event are all rejected, and each of those cases asserts that the old
head-moved check accepts the very same rows.
`pnpm test:devnet:node-store-persistence` runs both files; to run only the unit test:

```bash
pnpm exec vitest run --config devnet/node-store-persistence/vitest.config.ts chain-log-follows.test.ts
```
