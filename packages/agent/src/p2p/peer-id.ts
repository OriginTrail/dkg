import { peerIdFromString } from '@libp2p/peer-id';

export function canonicalPeerIdString(peerId: string): string {
  const trimmed = peerId.trim();
  if (!trimmed) throw new Error('empty peer id');
  return peerIdFromString(trimmed).toString();
}

export function tryCanonicalPeerIdString(peerId: string): string | null {
  try {
    return canonicalPeerIdString(peerId);
  } catch {
    return null;
  }
}
