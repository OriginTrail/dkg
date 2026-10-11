import type * as NodeStore from '@origintrail-official/dkg-node-store';
import type {
  SqliteChainEventLogBlockRange,
  SqliteChainEventLogCommit,
  SqliteChainEventLogCountQuery,
  SqliteChainEventLogCoverage,
  SqliteChainEventLogCursor,
  SqliteChainEventLogHead,
  SqliteChainEventLogQuery,
  SqliteChainEventLogRow,
  SqliteChainEventLogState,
  SqliteChainEventLogStore,
} from '../src/chain-event-log-store.js';
import type {
  SqliteChainEventCursorStore,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
} from '../src/chain-cursor-stores.js';
import type {
  SqliteProtocolOutboxStore,
  SqliteProtocolOutboxStoreOptions,
} from '../src/protocol-outbox-store.js';

// Public API compatibility: `dist/chain-event-log-store.js`,
// `dist/chain-cursor-stores.js` and `dist/protocol-outbox-store.js` are
// importable paths of this package (it has no `exports` map). The classes and
// types that moved to `@origintrail-official/dkg-node-store` must stay
// importable from them, and must be the same types node-store exports, so a
// value typed against the old path stays assignable to the new one. The
// runtime side is `node-store-reexport.test.ts` and the built-package side is
// `scripts/test-package-exports.mjs`.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? true
  : false;

export const chainEventLogTypes: [
  Same<SqliteChainEventLogBlockRange, NodeStore.SqliteChainEventLogBlockRange>,
  Same<SqliteChainEventLogCommit, NodeStore.SqliteChainEventLogCommit>,
  Same<SqliteChainEventLogCountQuery, NodeStore.SqliteChainEventLogCountQuery>,
  Same<SqliteChainEventLogCoverage, NodeStore.SqliteChainEventLogCoverage>,
  Same<SqliteChainEventLogCursor, NodeStore.SqliteChainEventLogCursor>,
  Same<SqliteChainEventLogHead, NodeStore.SqliteChainEventLogHead>,
  Same<SqliteChainEventLogQuery, NodeStore.SqliteChainEventLogQuery>,
  Same<SqliteChainEventLogRow, NodeStore.SqliteChainEventLogRow>,
  Same<SqliteChainEventLogState, NodeStore.SqliteChainEventLogState>,
  Same<SqliteChainEventLogStore, NodeStore.SqliteChainEventLogStore>,
] = [true, true, true, true, true, true, true, true, true, true];

export const chainCursorClasses: [
  Same<SqliteChainEventCursorStore, NodeStore.SqliteChainEventCursorStore>,
  Same<SqliteContextGraphAuthorityHistoryStore, NodeStore.SqliteContextGraphAuthorityHistoryStore>,
  Same<SqliteContextGraphAuthorityIndexStore, NodeStore.SqliteContextGraphAuthorityIndexStore>,
  Same<
    SqliteContextGraphRegistryScanCursorStore,
    NodeStore.SqliteContextGraphRegistryScanCursorStore
  >,
  Same<
    SqliteContextGraphStorageDiscoveryStore,
    NodeStore.SqliteContextGraphStorageDiscoveryStore
  >,
] = [true, true, true, true, true];

export const protocolOutboxTypes: [
  Same<SqliteProtocolOutboxStore, NodeStore.SqliteProtocolOutboxStore>,
  Same<SqliteProtocolOutboxStoreOptions, NodeStore.SqliteProtocolOutboxStoreOptions>,
] = [true, true];
