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
 * A key-derived PeerId (Ed25519, secp256k1, RSA) re-parses to an equal one,
 * and the store keys on its CID. Ed25519 and secp256k1 carry the public key
 * inline; an RSA ID re-parses by CID alone and the store fills the key from
 * its own record. URL peer IDs (the HTTP-gateway form) do not re-parse from
 * their string and yield `undefined`; DKG does not use them. A value that is
 * not a peer ID yields `undefined`, never a throw.
 */
export function toLibp2pPeerId(peer: { toString(): string }): Libp2pPeerId | undefined {
  try {
    return peerIdFromString(String(peer));
  } catch {
    return undefined;
  }
}
