/**
 * `@origintrail-official/dkg-node-store`: the daemon's durable protocol state.
 *
 * The outbox, sync checkpoints, changelog cursors, KA numbering, message
 * idempotency, chain-event log and chain cursors are protocol persistence, not
 * dashboard observability. They live here, apart from the logs/metrics/UI
 * package that used to house them, and every store is constructed against a
 * structural {@link NodeStoreDatabaseHandle}.
 *
 * Phase 1 (this package) relocates the store classes only. The SQLite file is
 * still the dashboard's `node-ui.db`, opened and migrated by `DashboardDB` in
 * `@origintrail-official/dkg-node-ui`, and `SCHEMA_VERSION` and every
 * migration stay there. See the package README.
 */
export type { NodeStoreDatabaseHandle } from './database-handle.js';

export { SqliteMessageIdempotencyStore } from './message-idempotency-store.js';
export {
  SqliteProtocolOutboxStore,
  type SqliteProtocolOutboxStoreOptions,
} from './protocol-outbox-store.js';
export { SqliteSyncCheckpointStore } from './sync-checkpoint-store.js';
export {
  SqliteChangelogCursorStore,
  SqliteChangelogEraGuard,
} from './changelog-stores.js';
export { SqliteKaNumberStore } from './ka-number-store.js';

export {
  SqliteChainEventCursorStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
} from './chain-cursor-stores.js';

/** Durable side of the node's ONE chain log. Opaque: it interprets no topic. */
export { SqliteChainEventLogStore } from './chain-event-log-store.js';
export type {
  SqliteChainEventLogBlockRange,
  SqliteChainEventLogCommit,
  SqliteChainEventLogCountQuery,
  SqliteChainEventLogCoverage,
  SqliteChainEventLogCursor,
  SqliteChainEventLogHead,
  SqliteChainEventLogQuery,
  SqliteChainEventLogRow,
  SqliteChainEventLogState,
} from './chain-event-log-store.js';
