import { multiaddr, type Component } from '@multiformats/multiaddr';
import {
  Libp2pConnectCandidateParseError,
  parseLibp2pConnectCandidate,
  type Libp2pConnectCandidate,
} from '@origintrail-official/dkg-core';
import type { CanonicalPeerId } from './peer-id.js';

type ParsedMultiaddrStructure = {
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

export function parseMultiaddrConnectTarget(addr: string): Libp2pConnectCandidate {
  try {
    return parseLibp2pConnectCandidate(addr);
  } catch (error) {
    throw new MultiaddrPeerTargetParseError(
      error instanceof Error ? error.message : String(error),
      error instanceof Libp2pConnectCandidateParseError
        ? error.rawTarget
        : undefined,
    );
  }
}

export function parseExplicitConnectTarget(
  addr: string,
  options: { requireTargetPeerId?: boolean } = {},
): Libp2pConnectCandidate {
  const target = parseMultiaddrConnectTarget(addr);
  if (options.requireTargetPeerId && !target.targetPeerId) {
    throw new MultiaddrPeerTargetParseError(
      'connect multiaddr must include a target /p2p/<peerId> for network admission',
      '<missing>',
    );
  }
  return target;
}

function parseMultiaddrStructure(addr: string): ParsedMultiaddrStructure {
  const parsed = multiaddr(addr);
  const components = parsed.getComponents();
  return {
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

export function peerIdsFromMultiaddrs(addrs: readonly string[] | undefined): Set<string> {
  const peerIds = new Set<string>();
  for (const addr of addrs ?? []) {
    for (const peerId of peerIdsFromMultiaddr(addr)) peerIds.add(peerId);
  }
  return peerIds;
}
