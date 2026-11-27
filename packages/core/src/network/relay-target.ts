import type { Address, NodeIdentity } from './network.js';

/**
 * Canonical relay candidate produced by DKGNode after parse, self filtering,
 * peer-id canonicalization, and address de-duplication.
 */
export interface ConfiguredRelayTarget {
  readonly peerId: NodeIdentity;
  readonly addresses: readonly Address[];
}
