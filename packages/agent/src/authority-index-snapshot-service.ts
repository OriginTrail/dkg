// SPDX-License-Identifier: Apache-2.0

/** Compatibility exports for the role-specific snapshot protocol modules. */
export {
  AUTHORITY_INDEX_SNAPSHOT_MAX_REQUEST_BYTES,
  AUTHORITY_INDEX_SNAPSHOT_MAX_RESPONSE_BYTES,
  PROTOCOL_CONTEXT_GRAPH_AUTHORITY_INDEX_SNAPSHOT,
} from './authority-index-snapshot-wire.js';
export {
  AUTHORITY_INDEX_SNAPSHOT_DEFAULT_MAX_TAIL_BLOCKS,
  AUTHORITY_INDEX_SNAPSHOT_MAX_TRUSTED_PEERS,
  normalizeAuthorityIndexSnapshotConfig,
  type AuthorityIndexSnapshotConfig,
  type AuthorityIndexSnapshotPeer,
  type NormalizedAuthorityIndexSnapshotConfig,
} from './authority-index-snapshot-config.js';
export {
  AuthorityIndexSnapshotPeerStatusError,
  AuthorityIndexSnapshotUnavailableError,
  createAuthorityIndexSnapshotClient,
  type AuthorityIndexSnapshotClientOptions,
  type AuthorityIndexSnapshotTransportOptions,
} from './authority-index-snapshot-client.js';
export { createAuthorityIndexSnapshotHandler } from './authority-index-snapshot-handler.js';
