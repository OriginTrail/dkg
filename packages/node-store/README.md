# @origintrail-official/dkg-node-store

The durable protocol state of a DKG V10 node, as SQLite-backed stores.

| Store | Table(s) | What it keeps |
| --- | --- | --- |
| `SqliteProtocolOutboxStore` | `protocol_outbox` | Sender-side durable retry queue for the reliable messenger |
| `SqliteMessageIdempotencyStore` | `message_idempotency` | Receiver dedup and sender "did we deliver this" cache |
| `SqliteSyncCheckpointStore` | `sync_checkpoints` | Requester-side sync resume offsets, manifest bindings and responder sessions |
| `SqliteChangelogCursorStore` | `changelog_cursors` | Last applied `(era, seq)` per `(peer, context graph)` |
| `SqliteChangelogEraGuard` | `changelog_era` | The write-side changelog era and high-water mark |
| `SqliteKaNumberStore` | `ka_numbers` | Per-author, never-reclaimed Knowledge Asset number allocator |
| `SqliteChainEventLogStore` | `chain_index_cursor`, `chain_events`, `chain_index_coverage` | The node's one chain-event log, its cursor and its coverage record |
| `SqliteChainEventCursorStore`, `SqliteContextGraphRegistryScanCursorStore` | `runtime_cursors` (and legacy `settings` keys) | Chain poller and registry scan cursors |
| `SqliteContextGraphAuthorityIndexStore` | `context_graph_authority_indexes` | Opaque compare-and-swap authority index checkpoints |
| `SqliteContextGraphAuthorityHistoryStore`, `SqliteContextGraphStorageDiscoveryStore` | `settings` | Opaque authority-history and storage-discovery checkpoints |

These used to live in `@origintrail-official/dkg-node-ui`, the dashboard package,
next to logs, metrics and the UI. Protocol durability is not observability, so
it has its own package. The daemon (`@origintrail-official/dkg`) depends on this
package directly and composes the stores over the shared database handle in
`packages/cli/src/daemon/protocol-persistence.ts`. `@origintrail-official/dkg-node-ui`
still re-exports every class unchanged (from its entry point, from `dist/db.js`
and from the former `dist/chain-event-log-store.js`, `dist/chain-cursor-stores.js`
and `dist/protocol-outbox-store.js` paths), but only as a compatibility surface
for downstream importers: first-party code imports this package.

## Usage

Every store is constructed against a `NodeStoreDatabaseHandle`: any object with
an open [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) handle on
`db`.

```ts
import { SqliteKaNumberStore } from '@origintrail-official/dkg-node-store';

const kaNumbers = new SqliteKaNumberStore(dashboardDb); // DashboardDB satisfies the handle
kaNumbers.allocate('0xAuthor...'); // 0n, then 1n, ...
```

The stores never open, close, migrate or pragma the database, and they never
create their own tables. The host owns the file, the connection and the schema.

## Phase 1: what moved and what did not

Phase 1 is a pure package move with no behavior change.

- **Moved:** the store classes and their tests.
- **Not moved:** the SQLite file and the schema. `DashboardDB` in
  `@origintrail-official/dkg-node-ui` still opens `<data dir>/node-ui.db`, still
  owns `SCHEMA_VERSION` and every migration, and creates every table above. The
  stores' tests therefore open the real `DashboardDB` (a relative, test-only
  import from `packages/node-ui`) instead of a hand-copied schema that could
  drift from it.
- **Not moved:** the Context Graph subscription, membership, join-policy and
  approval-ledger tables, the VM reconcile cursors, `snapshot_page_indexes` and
  `local_context_graph_origins`. They are protocol state too, but they are
  methods of `DashboardDB` or owned by the CLI, not store classes, so moving
  them means splitting `DashboardDB`. That is Phase 2.

The dependency runs one way: node-ui depends on this package, and this package
never depends on node-ui (the workspace graph must stay acyclic).

## Phase 2 (not implemented)

Give protocol state its own SQLite file (for example `node-protocol.db`) with a
one-time, marker-guarded migration out of `node-ui.db`, behind a config flag.
It must keep the property `node-ui.db` has today: it survives a `store.nq` RDF
restore, so changelog eras, sync checkpoints and chain cursors are never
rewound. Because every store takes a handle, the split needs no store change.
