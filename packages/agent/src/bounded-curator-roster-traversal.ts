// SPDX-License-Identifier: Apache-2.0

import {
  readAgentPeerPage,
  validateAgentPeerPageRequest,
  type AgentPeerPageRequest,
} from './agent-peer-discovery.js';

interface BoundedCuratorRosterProvider {
  findAgentPeerPageByAddress(agentAddress: string, request: AgentPeerPageRequest): Promise<unknown>;
}

export type BoundedCuratorRosterTraversal =
  | { status: 'complete'; peerIds: string[] }
  | { status: 'continue'; peerIds: string[]; nextAfterPeerId: string }
  | { status: 'cycle'; peerIds: string[] };

/**
 * Read one bounded registry page and describe what the recovery owner should do
 * with its cursor. A tail page can never prove a complete roster: reaching its
 * end explicitly asks the owner to begin a fresh cycle on its next pass.
 */
export async function traverseBoundedCuratorRoster(
  discovery: BoundedCuratorRosterProvider,
  curatorAddress: string,
  options: {
    maxPeerIds: number;
    pagePeerIds?: number;
    afterPeerId?: string;
    signal?: AbortSignal;
  },
): Promise<BoundedCuratorRosterTraversal> {
  validateAgentPeerPageRequest({ limit: options.maxPeerIds, signal: options.signal });
  const requestedPageSize = options.pagePeerIds ?? options.maxPeerIds;
  validateAgentPeerPageRequest({ limit: requestedPageSize, signal: options.signal });
  const transportPageSize = Math.min(options.maxPeerIds, requestedPageSize);
  const startedAtBeginning = options.afterPeerId === undefined;
  const page = await readAgentPeerPage(discovery, curatorAddress, {
    ...(options.afterPeerId !== undefined ? { afterPeerId: options.afterPeerId } : {}),
    limit: startedAtBeginning ? options.maxPeerIds : transportPageSize,
    signal: options.signal,
  });

  const peerIds = page.peerIds.slice(
    0,
    startedAtBeginning && page.nextAfterPeerId === null
      ? options.maxPeerIds
      : transportPageSize,
  );
  if (!startedAtBeginning && page.nextAfterPeerId === null) {
    return { status: 'cycle', peerIds };
  }
  if (page.nextAfterPeerId === null) {
    return { status: 'complete', peerIds };
  }
  const nextAfterPeerId = peerIds[peerIds.length - 1];
  if (!nextAfterPeerId) {
    throw new Error('Peer discovery continuation did not expose a transport cursor');
  }
  return { status: 'continue', peerIds, nextAfterPeerId };
}
