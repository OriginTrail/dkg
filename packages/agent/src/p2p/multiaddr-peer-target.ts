import { multiaddr, type Component } from '@multiformats/multiaddr';
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

type ParsedMultiaddrStructure = {
  multiaddress: string;
  components: Component[];
  peerIds: string[];
  circuitIndex: number;
};

export class MultiaddrPeerTargetParseError extends Error {
  constructor(
    message: string,
    readonly rawTarget?: string,
  ) {
    super(message);
    this.name = 'MultiaddrPeerTargetParseError';
  }
}

export function peerIdsFromMultiaddr(addr: string): string[] {
  return parseMultiaddrStructure(addr).peerIds;
}

export function targetPeerIdFromMultiaddr(addr: string): string | undefined {
  const structure = parseMultiaddrStructure(addr);
  return targetPeerIdFromStructure(structure);
}

export function canonicalTargetPeerIdFromMultiaddr(addr: string): CanonicalMultiaddrPeerTarget | undefined {
  const raw = targetPeerIdFromMultiaddr(addr);
  return raw ? canonicalTargetPeerId(raw) : undefined;
}

export function parseMultiaddrConnectTarget(addr: string): MultiaddrConnectTarget {
  const structure = parseMultiaddrStructure(addr);
  if (structure.circuitIndex !== -1) {
    const raw = targetPeerIdFromStructure(structure);
    if (!raw) throw new Error('Circuit multiaddr missing target peer id');
    return {
      kind: 'circuit',
      multiaddress: structure.multiaddress,
      relayMultiaddress: multiaddr(structure.components.slice(0, structure.circuitIndex)).toString(),
      target: canonicalTargetPeerId(raw),
    };
  }

  const raw = targetPeerIdFromStructure(structure);
  const target = raw ? canonicalTargetPeerId(raw) : undefined;
  return target
    ? { kind: 'direct', multiaddress: structure.multiaddress, target }
    : { kind: 'direct', multiaddress: structure.multiaddress };
}

function parseMultiaddrStructure(addr: string): ParsedMultiaddrStructure {
  const parsed = multiaddr(addr);
  const components = parsed.getComponents();
  return {
    multiaddress: parsed.toString(),
    components,
    peerIds: components
      .filter((component) => component.name === 'p2p' && component.value)
      .map((component) => component.value!.trim())
      .filter(Boolean),
    circuitIndex: components.findIndex((component) => component.name === 'p2p-circuit'),
  };
}

function targetPeerIdFromStructure(structure: ParsedMultiaddrStructure): string | undefined {
  const candidates = structure.circuitIndex === -1
    ? structure.peerIds
    : structure.components
      .slice(structure.circuitIndex + 1)
      .filter((component) => component.name === 'p2p' && component.value)
      .map((component) => component.value!.trim())
      .filter(Boolean);
  return candidates.at(-1);
}

function canonicalTargetPeerId(raw: string): CanonicalMultiaddrPeerTarget {
  try {
    return { raw, canonical: canonicalPeerIdString(raw) };
  } catch (err) {
    throw new MultiaddrPeerTargetParseError(
      err instanceof Error ? err.message : String(err),
      raw,
    );
  }
}

export function peerIdsFromMultiaddrs(addrs: readonly string[] | undefined): Set<string> {
  const peerIds = new Set<string>();
  for (const addr of addrs ?? []) {
    for (const peerId of peerIdsFromMultiaddr(addr)) peerIds.add(peerId);
  }
  return peerIds;
}
