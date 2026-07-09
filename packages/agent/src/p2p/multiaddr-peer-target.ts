import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface CanonicalMultiaddrPeerTarget {
  raw: string;
  canonical: CanonicalPeerId;
}

export interface DirectMultiaddrConnectTarget {
  kind: 'direct';
  multiaddress: string;
  target?: CanonicalMultiaddrPeerTarget;
}

export interface CircuitMultiaddrConnectTarget {
  kind: 'circuit';
  multiaddress: string;
  relayMultiaddress: string;
  target: CanonicalMultiaddrPeerTarget;
}

export type MultiaddrConnectTarget = DirectMultiaddrConnectTarget | CircuitMultiaddrConnectTarget;

const CIRCUIT_TARGET_MARKER = '/p2p-circuit/p2p/';

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
  const circuitTarget = rawCircuitTargetPeerId(addr);
  if (circuitTarget !== undefined) return circuitTarget || undefined;
  return peerIdsFromMultiaddr(addr).at(-1);
}

export function canonicalTargetPeerIdFromMultiaddr(addr: string): CanonicalMultiaddrPeerTarget | undefined {
  const raw = targetPeerIdFromMultiaddr(addr);
  return raw ? { raw, canonical: canonicalPeerIdString(raw) } : undefined;
}

export function parseMultiaddrConnectTarget(addr: string): MultiaddrConnectTarget {
  const circuitIndex = addr.indexOf(CIRCUIT_TARGET_MARKER);
  if (circuitIndex !== -1) {
    const raw = rawCircuitTargetPeerId(addr);
    if (!raw) throw new Error('Circuit multiaddr missing target peer id');
    return {
      kind: 'circuit',
      multiaddress: addr,
      relayMultiaddress: addr.slice(0, circuitIndex),
      target: { raw, canonical: canonicalPeerIdString(raw) },
    };
  }

  const target = canonicalTargetPeerIdFromMultiaddr(addr);
  return target ? { kind: 'direct', multiaddress: addr, target } : { kind: 'direct', multiaddress: addr };
}

function rawCircuitTargetPeerId(addr: string): string | undefined {
  const circuitIndex = addr.indexOf(CIRCUIT_TARGET_MARKER);
  if (circuitIndex === -1) return undefined;
  return addr.slice(circuitIndex + CIRCUIT_TARGET_MARKER.length).split('/')[0]?.trim() ?? '';
}

export function peerIdsFromMultiaddrs(addrs: readonly string[] | undefined): Set<string> {
  const peerIds = new Set<string>();
  for (const addr of addrs ?? []) {
    for (const peerId of peerIdsFromMultiaddr(addr)) peerIds.add(peerId);
  }
  return peerIds;
}
