/**
 * @deprecated Compatibility module. The chain cursor, registry-scan,
 * storage-discovery and authority stores moved to
 * `@origintrail-official/dkg-node-store`; this file only keeps the deep import
 * path `@origintrail-official/dkg-node-ui/dist/chain-cursor-stores.js`
 * resolving for downstream consumers that shipped against it (this package has
 * no `exports` map, so `dist/*` is importable). First-party code imports
 * `@origintrail-official/dkg-node-store` directly. Every class the former
 * module exported is forwarded, and each is the very same class node-store
 * exports.
 */
export {
  SqliteChainEventCursorStore,
  SqliteContextGraphAuthorityHistoryStore,
  SqliteContextGraphAuthorityIndexStore,
  SqliteContextGraphRegistryScanCursorStore,
  SqliteContextGraphStorageDiscoveryStore,
} from '@origintrail-official/dkg-node-store';
