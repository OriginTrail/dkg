import { multiaddr, type Component } from '@multiformats/multiaddr';
import { canonicalPeerIdString, type CanonicalPeerId } from './peer-id.js';

export interface DirectMultiaddrConnectTarget {
  kind: 'direct';
  multiaddress: string;
  targetPeerId?: CanonicalPeerId;
}

export interface CircuitMultiaddrConnectTarget {
  kind: 'circuit';
  multiaddress: string;
  relayMultiaddress: string;
  targetPeerId: CanonicalPeerId;
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

/** @deprecated Prefer parseMultiaddrConnectTarget() so callers share one parsed model. */
export function targetPeerIdFromMultiaddr(addr: string): string | undefined {
  return targetPeerIdFromStructure(parseMultiaddrStructure(addr));
}

/** @deprecated Prefer parseMultiaddrConnectTarget() so callers share one parsed model. */
export function canonicalTargetPeerIdFromMultiaddr(addr: string): CanonicalPeerId | undefined {
  return parseMultiaddrConnectTarget(addr).targetPeerId;
}

export function parseMultiaddrConnectTarget(addr: string): MultiaddrConnectTarget {
  const structure = parseMultiaddrStructure(addr);
  if (structure.circuitIndex !== -1) {
    const raw = targetPeerIdFromStructure(structure);
    if (!raw) throw new MultiaddrPeerTargetParseError('Circuit multiaddr missing target peer id', '<missing>');
    return {
      kind: 'circuit',
      multiaddress: structure.multiaddress,
      relayMultiaddress: multiaddr(structure.components.slice(0, structure.circuitIndex)).toString(),
      targetPeerId: canonicalTargetPeerId(raw),
    };
  }

  const raw = targetPeerIdFromStructure(structure);
  const targetPeerId = raw ? canonicalTargetPeerId(raw) : undefined;
  return targetPeerId
    ? { kind: 'direct', multiaddress: structure.multiaddress, targetPeerId }
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

function canonicalTargetPeerId(raw: string): CanonicalPeerId {
  try {
    return canonicalPeerIdString(raw);
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
