/** Maximum peer IDs in one wallet-registry page, excluding one lookahead row. */
export const MAX_AGENT_PEER_PAGE_SIZE = 1024;

export interface AgentPeerPageRequest {
  /** Positive integer, at most MAX_AGENT_PEER_PAGE_SIZE. */
  readonly limit: number;
  /** Exclusive lexical peer-ID cursor; omit for the first page. */
  readonly afterPeerId?: string;
  readonly signal?: AbortSignal;
}

export interface AgentPeerPage {
  /** Strictly increasing, duplicate-free peer IDs; at most request.limit. */
  readonly peerIds: readonly string[];
  /** Last returned peer ID when another row exists, otherwise null. */
  readonly nextAfterPeerId: string | null;
}

/** Required capability for bounded recovery. Unsupported providers must reject. */
export interface AgentPeerDiscovery {
  findAgentPeerPageByAddress(agentAddress: string, request: AgentPeerPageRequest): Promise<AgentPeerPage>;
}

export function validateAgentPeerPageRequest(request: AgentPeerPageRequest): void {
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_AGENT_PEER_PAGE_SIZE) {
    throw new RangeError(`Peer page limit must be an integer from 1 to ${MAX_AGENT_PEER_PAGE_SIZE}`);
  }
  if (request.afterPeerId !== undefined && (typeof request.afterPeerId !== 'string' || request.afterPeerId.length === 0)) {
    throw new TypeError('Peer page cursor must be a nonempty string');
  }
  request.signal?.throwIfAborted();
}

/** Reject a broken provider contract before treating a page as registry evidence. */
export function validateAgentPeerPage(page: unknown, request: AgentPeerPageRequest): AgentPeerPage {
  if (page === null || typeof page !== 'object' || Array.isArray(page)) {
    throw new TypeError('Peer discovery returned an invalid page');
  }
  const { peerIds: rawPeerIds, nextAfterPeerId } = page as Record<string, unknown>;
  if (!Array.isArray(rawPeerIds)) {
    throw new Error('Peer discovery exceeded its page bound');
  }
  const peerCount = rawPeerIds.length;
  if (!Number.isSafeInteger(peerCount) || peerCount < 0 || peerCount > request.limit) {
    throw new Error('Peer discovery exceeded its page bound');
  }
  if (nextAfterPeerId !== null && typeof nextAfterPeerId !== 'string') {
    throw new TypeError('Peer discovery returned an invalid continuation');
  }
  const peerIds: string[] = [];
  let previous = request.afterPeerId;
  for (let index = 0; index < peerCount; index++) {
    const peerId: unknown = rawPeerIds[index];
    if (typeof peerId !== 'string' || peerId.length === 0 || (previous !== undefined && peerId <= previous)) {
      throw new Error('Peer discovery returned a non-monotonic page');
    }
    peerIds.push(peerId);
    previous = peerId;
  }
  if (nextAfterPeerId !== null && (peerIds.length !== request.limit || nextAfterPeerId !== previous)) {
    throw new Error('Peer discovery returned an invalid continuation');
  }
  request.signal?.throwIfAborted();
  return { peerIds, nextAfterPeerId };
}

export async function readAgentPeerPage(
  discovery: {
    findAgentPeerPageByAddress(agentAddress: string, request: AgentPeerPageRequest): Promise<unknown>;
  },
  agentAddress: string,
  request: AgentPeerPageRequest,
): Promise<AgentPeerPage> {
  const boundedRequest = Object.freeze({ ...request });
  validateAgentPeerPageRequest(boundedRequest);
  const page = await discovery.findAgentPeerPageByAddress(agentAddress, boundedRequest);
  return validateAgentPeerPage(page, boundedRequest);
}
