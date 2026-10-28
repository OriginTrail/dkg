/**
 * @deprecated Compatibility module. The protocol outbox store moved to
 * `@origintrail-official/dkg-node-store`; this file only keeps the deep import
 * path `@origintrail-official/dkg-node-ui/dist/protocol-outbox-store.js`
 * resolving for downstream consumers that shipped against it (this package has
 * no `exports` map, so `dist/*` is importable). First-party code imports
 * `@origintrail-official/dkg-node-store` directly. Every runtime value and type
 * the former module exported is forwarded, and each is the very same
 * declaration node-store exports.
 */
export {
  SqliteProtocolOutboxStore,
  type SqliteProtocolOutboxStoreOptions,
} from '@origintrail-official/dkg-node-store';
