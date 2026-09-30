import { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  SqliteChainEventCursorStore,
  SqliteChainEventLogStore,
  SqliteChangelogCursorStore,
  SqliteChangelogEraGuard,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
  SqliteKaNumberStore,
  SqliteMessageIdempotencyStore,
  SqliteProtocolOutboxStore,
  SqliteSyncCheckpointStore,
  type NodeStoreDatabaseHandle,
} from '@origintrail-official/dkg-node-store';
import {
  DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS,
  DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
} from '@origintrail-official/dkg-core';

/**
 * The daemon's ONE `node-ui.db` connection, and the single place that closes it.
 *
 * `DashboardDB` still opens, migrates and owns the file (protocol persistence
 * moved to `@origintrail-official/dkg-node-store`, but its schema did not), so
 * the composition root opens it here once and hands the same handle to every
 * store and to the dashboard code that shares it. Whoever holds this owner
 * closes the connection through {@link NodeDatabase.close}; nothing else does.
 */
export interface NodeDatabase {
  readonly dashboardDb: DashboardDB;
  /** Closes the connection every protocol store and the dashboard share. */
  close(): void;
}

export function openNodeDatabase(dataDir: string): NodeDatabase {
  const dashboardDb = new DashboardDB({ dataDir });
  return { dashboardDb, close: () => dashboardDb.close() };
}

export interface ProtocolStoreOptions {
  /**
   * Chain deployment identity that scopes the chain cursors and the
   * storage-discovery checkpoint, so a node home reused across networks never
   * replays another deployment's catalog.
   */
  readonly chainCursorScope: string;
  /**
   * OT-RFC-59 changelog intent. When on, the durable era guard is built and MUST
   * back the changelog: it lives in node-ui.db, which survives a `store.nq` RDF
   * restore, so a restore/rollback rotates the era and forces peers to
   * full-resync instead of silently skipping.
   */
  readonly changelogEnabled: boolean;
}

/** Every protocol persistence store the daemon composes, over one shared handle. */
export interface ProtocolStores {
  /**
   * Universal Messenger substrate stores (rc.9 PR-2). Wired into the DKGAgent's
   * Messenger so any caller that opts into `messenger.sendReliable` gets durable
   * receiver-side idempotency + sender-side outbox retries.
   */
  readonly messengerStores: {
    readonly idempotencyStore: SqliteMessageIdempotencyStore;
    readonly outboxStore: SqliteProtocolOutboxStore;
  };
  readonly syncCheckpointStore: SqliteSyncCheckpointStore;
  readonly changelogCursorStore: SqliteChangelogCursorStore;
  /** Present only when {@link ProtocolStoreOptions.changelogEnabled}. */
  readonly changelogEraGuard: SqliteChangelogEraGuard | undefined;
  readonly chainEventCursorStore: SqliteChainEventCursorStore;
  readonly contextGraphRegistryScanCursorStore: SqliteContextGraphRegistryScanCursorStore;
  readonly contextGraphStorageDiscoveryStore: SqliteContextGraphStorageDiscoveryStore;
  readonly localContextGraphAuthorityHistoryStore: SqliteContextGraphAuthorityHistoryStore;
  readonly localContextGraphAuthorityIndexStore: SqliteContextGraphAuthorityIndexStore;
  /**
   * THE node's one chain log. Handed to the agent's chain adapter ONLY: that
   * adapter builds the tick, starts it, and publishes the binding every other
   * eligible reader consults. Per-wallet publisher adapters receive only a
   * late-bound binding getter, never this store, because a second store would
   * be a second scanner, which is what this log exists to delete.
   */
  readonly chainEventLogStore: SqliteChainEventLogStore;
  /**
   * OT-RFC-43 Option-1 deterministic KA identity (B2 allocator core). Durable
   * per-author KA-number sequence backing the off-chain `KaNumberAllocator`.
   * Constructed here, alongside the other durable substrate stores, so the V20
   * `ka_numbers` table is opened and its sequence is co-located with the rest
   * of the node's persistent state.
   *
   * The publisher allocates a deterministic packed reservedKaId per V10 mint
   * (DKGPublisher.ensureReservedKaId) and lazily reconciles each author's floor
   * against the chain's highest minted number on first use
   * (chain.getMaxKaNumberForAuthor), satisfying the RFC §4.5 cold-start guard.
   * (A blocking startup reconciliation sweep + the ongoing
   * KnowledgeAssetCreated poller->reconcile wiring remain a hardening
   * follow-up.)
   */
  readonly kaNumberStore: SqliteKaNumberStore;
}

/**
 * Compose the protocol persistence stores over ONE database handle.
 *
 * Every store is built from the same `database`, so they all read and write the
 * same connection, transactions included. The construction order and options
 * are the ones the daemon has always used.
 */
export function createProtocolStores(
  database: NodeStoreDatabaseHandle,
  options: ProtocolStoreOptions,
): ProtocolStores {
  const idempotencyStore = new SqliteMessageIdempotencyStore(database);
  const outboxStore = new SqliteProtocolOutboxStore(database, {
    maxAgeMs: DEFAULT_PROTOCOL_OUTBOX_MAX_AGE_MS,
    backoffFor: (attempts) => {
      const idx = Math.min(
        Math.max(attempts - 1, 0),
        DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS.length - 1,
      );
      return DEFAULT_PROTOCOL_OUTBOX_BACKOFFS_MS[idx];
    },
  });
  const syncCheckpointStore = new SqliteSyncCheckpointStore(database);
  const changelogCursorStore = new SqliteChangelogCursorStore(database);
  const changelogEraGuard = options.changelogEnabled
    ? new SqliteChangelogEraGuard(database)
    : undefined;
  const chainEventCursorStore = new SqliteChainEventCursorStore(database, {
    scope: options.chainCursorScope,
  });
  const contextGraphRegistryScanCursorStore =
    new SqliteContextGraphRegistryScanCursorStore(database);
  // Historical Context Graph discovery: ContextGraphStorage enumeration cursor
  // plus the chain facts below it, scoped like the event cursors so a node home
  // reused across networks never replays another deployment's catalog.
  const contextGraphStorageDiscoveryStore = new SqliteContextGraphStorageDiscoveryStore(
    database,
    { scope: options.chainCursorScope },
  );
  // The database is process-owned local state under the same integrity boundary
  // as the node identity/configuration. Authority generations cannot be proven
  // from a watermark hash alone, so this composition-root admission is
  // deliberately explicit rather than inferred from a structural store type.
  const localContextGraphAuthorityHistoryStore =
    new SqliteContextGraphAuthorityHistoryStore(database);
  const localContextGraphAuthorityIndexStore =
    new SqliteContextGraphAuthorityIndexStore(database);
  const chainEventLogStore = new SqliteChainEventLogStore(database);
  const kaNumberStore = new SqliteKaNumberStore(database);

  return {
    messengerStores: { idempotencyStore, outboxStore },
    syncCheckpointStore,
    changelogCursorStore,
    changelogEraGuard,
    chainEventCursorStore,
    contextGraphRegistryScanCursorStore,
    contextGraphStorageDiscoveryStore,
    localContextGraphAuthorityHistoryStore,
    localContextGraphAuthorityIndexStore,
    chainEventLogStore,
    kaNumberStore,
  };
}
