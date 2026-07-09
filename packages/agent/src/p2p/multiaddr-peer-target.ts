import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface CanonicalMultiaddrPeerTarget {
  raw: string;
  canonical: CanonicalPeerId;
}

export interface ParsedMultiaddrPeerTarget {
  multiaddress: string;
  target?: CanonicalMultiaddrPeerTarget;
}

export function peerIdsFromMultiaddr(addr: string): string[] {
  const peerIds: string[] = [];
  const matches = addr.matchAll(/\/p2p\/([^/]+)/g);
  for (const match of matches) {
    const peerId = match[1]?.trim();
    if (peerId) peerIds.push(peerId);
  }
  return peerIds;
}

export function targetPeerIdFromMultiaddr(addr: string): string | undefined {
  return peerIdsFromMultiaddr(addr).at(-1);
}

export function canonicalTargetPeerIdFromMultiaddr(addr: string): CanonicalMultiaddrPeerTarget | undefined {
  const raw = targetPeerIdFromMultiaddr(addr);
  return raw ? { raw, canonical: canonicalPeerIdString(raw) } : undefined;
}

export function parseMultiaddrPeerTarget(addr: string): ParsedMultiaddrPeerTarget {
  const target = canonicalTargetPeerIdFromMultiaddr(addr);
  return target ? { multiaddress: addr, target } : { multiaddress: addr };
}

export function peerIdsFromMultiaddrs(addrs: readonly string[] | undefined): Set<string> {
  const peerIds = new Set<string>();
  for (const addr of addrs ?? []) {
    for (const peerId of peerIdsFromMultiaddr(addr)) peerIds.add(peerId);
  }
  return peerIds;
}
