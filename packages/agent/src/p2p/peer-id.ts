import { peerIdFromString } from '@libp2p/peer-id';

export {
  canonicalPeerIdString,
  tryCanonicalPeerIdString,
  type CanonicalPeerId,
} from '@origintrail-official/dkg-core';

type Libp2pPeerId = ReturnType<typeof peerIdFromString>;

/**
 * Parse a peer ID into the real libp2p `PeerId` that libp2p APIs key on.
 * `@libp2p/peer-store` rejects anything else with
 * `InvalidParametersError('Invalid PeerId')`, so a string-backed
 * `{ toString: () => peerId }` wrapper can never be looked up as-is.
 *
 * A real PeerId re-parses to an equal one: the store keys on its CID and
 * fills the public key from its own record. A value that is not a peer ID
 * yields `undefined`, never a throw.
 */
export function toLibp2pPeerId(peer: { toString(): string }): Libp2pPeerId | undefined {
  try {
    return peerIdFromString(String(peer));
  } catch {
    return undefined;
  }
}
