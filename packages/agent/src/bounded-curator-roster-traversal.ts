// SPDX-License-Identifier: Apache-2.0

import {
  readAgentPeerPage,
  validateAgentPeerPageRequest,
  type AgentPeerDiscovery,
} from './agent-peer-discovery.js';

export type CuratorRosterState =
  | { readonly status: 'complete' }
  | { readonly status: 'continue'; readonly nextAfterPeerId: string }
  | { readonly status: 'cycle' };

export type BoundedCuratorRosterTraversal = CuratorRosterState & { readonly peerIds: string[] };

/** Canonical public projection: the peer list has exactly one owner. */
export type BoundedCuratorRosterResolution =
  | {
      readonly peerIds: string[];
      readonly rosterStatus: 'complete';
      readonly overflowed?: never;
      readonly nextPageAfterPeerId?: never;
    }
  | {
      readonly peerIds: string[];
      readonly rosterStatus: 'continue';
      readonly overflowed: true;
      readonly nextPageAfterPeerId: string;
    }
  | {
      readonly peerIds: string[];
      readonly rosterStatus: 'cycle';
      readonly overflowed: true;
      readonly nextPageAfterPeerId?: never;
    };

export interface BoundedCuratorRosterRequest {
  readonly maxPeerIds: number;
  readonly pagePeerIds?: number;
  readonly afterPeerId?: string;
  readonly signal?: AbortSignal;
  readonly isCurrent?: () => boolean;
}

/** Only a complete first page can establish a whole local roster. */
export async function traverseBoundedCuratorRoster(
  discovery: AgentPeerDiscovery,
  wallet: string,
  request: BoundedCuratorRosterRequest,
): Promise<BoundedCuratorRosterTraversal> {
  const { maxPeerIds, pagePeerIds = maxPeerIds, afterPeerId, signal, isCurrent } = request;
  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    if (isCurrent?.() === false) throw new DOMException('Curator discovery is no longer current', 'AbortError');
  };
  assertCurrent();
  validateAgentPeerPageRequest({ limit: maxPeerIds, signal });
  validateAgentPeerPageRequest({ limit: pagePeerIds, signal });
  const transportPageSize = Math.min(maxPeerIds, pagePeerIds);
  const readPage = async (limit: number, cursor?: string) => {
    assertCurrent();
    const page = await readAgentPeerPage(discovery, wallet, {
      limit, ...(cursor === undefined ? {} : { afterPeerId: cursor }), signal,
    });
    assertCurrent();
    return page;
  };
  const readFirstPage = async (): Promise<BoundedCuratorRosterTraversal> => {
    const page = await readPage(maxPeerIds);
    if (page.nextAfterPeerId === null) return { status: 'complete', peerIds: [...page.peerIds] };
    // A target can spend only one peer attempt per pass. Advance only past
    // returned transport candidates, even when the proof probe read more.
    const peerIds = page.peerIds.slice(0, transportPageSize);
    return { status: 'continue', peerIds, nextAfterPeerId: peerIds[peerIds.length - 1]! };
  };
  if (afterPeerId === undefined) return readFirstPage();
  const tail = await readPage(transportPageSize, afterPeerId);
  // A saved cursor can become exhausted after churn. Recover immediately with
  // a fresh bounded first-page probe; do not infer completeness from the tail.
  if (tail.peerIds.length === 0) return readFirstPage();
  const peerIds = [...tail.peerIds];
  return tail.nextAfterPeerId === null
    ? { status: 'cycle', peerIds }
    : { status: 'continue', peerIds, nextAfterPeerId: tail.nextAfterPeerId };
}

/** Flatten traversal state beside the one canonical transport peer list. */
export function curatorRosterResolution(
  rosterTraversal: BoundedCuratorRosterTraversal,
): BoundedCuratorRosterResolution {
  const { peerIds } = rosterTraversal;
  if (rosterTraversal.status === 'complete') return { peerIds, rosterStatus: 'complete' };
  if (rosterTraversal.status === 'continue') {
    return {
      peerIds,
      rosterStatus: 'continue',
      overflowed: true,
      nextPageAfterPeerId: rosterTraversal.nextAfterPeerId,
    };
  }
  return { peerIds, rosterStatus: 'cycle', overflowed: true };
}
