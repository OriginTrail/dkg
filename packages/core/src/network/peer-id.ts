import { peerIdFromString } from '@libp2p/peer-id';

declare const canonicalPeerIdBrand: unique symbol;

export type CanonicalPeerId = string & { readonly [canonicalPeerIdBrand]: true };

export function canonicalPeerIdString(peerId: string): CanonicalPeerId {
  const trimmed = peerId.trim();
  if (!trimmed) throw new Error('empty peer id');
  return peerIdFromString(trimmed).toString() as CanonicalPeerId;
}

export function tryCanonicalPeerIdString(peerId: string): CanonicalPeerId | null {
  try {
    return canonicalPeerIdString(peerId);
  } catch {
    return null;
  }
}
