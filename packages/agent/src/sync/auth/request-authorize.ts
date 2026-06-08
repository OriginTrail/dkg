import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncRequestEnvelope } from './request-build.js';

interface AuthLookupOptions {
  signal?: AbortSignal;
}

interface AuthorizeSyncRequestParams {
  ctx: OperationContext;
  request: SyncRequestEnvelope;
  remotePeerId: string;
  localPeerId: string;
  syncAuthMaxAgeMs: number;
  seenRequestIds: Map<string, number>;
  computeSyncDigest: (
    contextGraphId: string,
    offset: number,
    limit: number,
    includeSharedMemory: boolean,
    targetPeerId: string,
    requesterPeerId: string,
    requestId: string,
    issuedAtMs: number,
    requesterAgentAddress: string | undefined,
    authPurpose?: string,
    authSelector?: string,
  ) => Uint8Array;
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint, options?: AuthLookupOptions) => Promise<boolean>;
  getParticipants: (contextGraphId: string, options?: AuthLookupOptions) => Promise<string[] | null>;
  getAllowedPeers: (contextGraphId: string, options?: AuthLookupOptions) => Promise<string[] | null>;
  getAgentGateAddresses: (contextGraphId: string, options?: AuthLookupOptions) => Promise<string[] | null>;
  /**
   * Per-agent map of libp2p peer-ids / op-keys an agent has delegated
   * to act on its behalf for sync. Keyed by the lowercased agent
   * address (the principal of the signed delegation).
   *
   * Auth binds the lookup to `request.requesterAgentAddress` (the
   * "on behalf of" claim in the envelope) so a delegation granted by
   * agent A doesn't authorise traffic claiming to act for agent B,
   * even when both agents are hosted on the same node and share the
   * same op-key. This is the single most important property of the
   * delegation gate: graph-wide unions silently widen access.
   */
  getAllowedDelegateePeers: (contextGraphId: string, options?: AuthLookupOptions) => Promise<Map<string, string[]>>;
  getAllowedDelegateeKeys: (contextGraphId: string, options?: AuthLookupOptions) => Promise<Map<string, string[]>>;
  refreshMetaFromCurator: (contextGraphId: string, options?: AuthLookupOptions) => Promise<boolean>;
  signal?: AbortSignal;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') return reason;
    const err = new Error(reason.message || 'aborted');
    err.name = 'AbortError';
    (err as Error & { cause?: unknown }).cause = reason;
    return err;
  }
  const err = new Error(typeof reason === 'string' ? reason : 'aborted');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw asAbortError(signal.reason);
}

export function isSyncRequestEnvelopeBoundToPeer(
  request: SyncRequestEnvelope,
  remotePeerId: string,
  localPeerId: string,
): request is SyncRequestEnvelope & { targetPeerId: string; requesterPeerId: string } {
  return request.targetPeerId === localPeerId && request.requesterPeerId === remotePeerId;
}

export async function authorizePrivateSyncRequest(params: AuthorizeSyncRequestParams): Promise<boolean> {
  const {
    ctx,
    request,
    remotePeerId,
    localPeerId,
    syncAuthMaxAgeMs,
    seenRequestIds,
    computeSyncDigest,
    verifyIdentity,
    getParticipants,
    getAllowedPeers,
    getAgentGateAddresses,
    getAllowedDelegateePeers,
    getAllowedDelegateeKeys,
    refreshMetaFromCurator,
    signal,
    logWarn,
    logInfo,
  } = params;

  throwIfAborted(signal);
  const lookupOptions = signal ? { signal } : undefined;

  const now = Date.now();
  for (const [requestId, seenAt] of seenRequestIds) {
    if (now - seenAt > syncAuthMaxAgeMs) {
      seenRequestIds.delete(requestId);
    }
  }

  let requesterIdentityId = 0n;
  try { requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n; } catch {}

  if (
    !isSyncRequestEnvelopeBoundToPeer(request, remotePeerId, localPeerId) ||
    !request.requestId ||
    request.issuedAtMs == null ||
    now - request.issuedAtMs > syncAuthMaxAgeMs ||
    now < request.issuedAtMs - 5000 ||
    !request.requesterSignatureR ||
    !request.requesterSignatureVS
  ) {
    logWarn(
      ctx,
      `Denied sync request for "${request.contextGraphId}": malformed or mismatched envelope (requesterPeer=${request.requesterPeerId ?? 'n/a'} targetPeer=${request.targetPeerId ?? 'n/a'} remotePeer=${remotePeerId} identityId=${request.requesterIdentityId ?? '0'} agentAddress=${request.requesterAgentAddress ?? 'n/a'})`,
    );
    return false;
  }

  if (seenRequestIds.has(request.requestId)) {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": replay detected for request ${request.requestId}`);
    return false;
  }

  const digest = request.authPurpose || request.authSelector
    ? computeSyncDigest(
        request.contextGraphId,
        request.offset,
        request.limit,
        request.includeSharedMemory,
        request.targetPeerId,
        request.requesterPeerId,
        request.requestId,
        request.issuedAtMs,
        request.requesterAgentAddress,
        request.authPurpose,
        request.authSelector,
      )
    : computeSyncDigest(
        request.contextGraphId,
        request.offset,
        request.limit,
        request.includeSharedMemory,
        request.targetPeerId,
        request.requesterPeerId,
        request.requestId,
        request.issuedAtMs,
        request.requesterAgentAddress,
      );

  let recoveredAddress: string;
  try {
    recoveredAddress = ethers.recoverAddress(ethers.hashMessage(digest), {
      r: request.requesterSignatureR,
      yParityAndS: request.requesterSignatureVS,
    });
  } catch {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": failed to recover signer (identityId=${request.requesterIdentityId ?? '0'} agentAddress=${request.requesterAgentAddress ?? 'n/a'})`);
    return false;
  }

  if (requesterIdentityId > 0n) {
    if (typeof verifyIdentity !== 'function') {
      logWarn(ctx, `Denied sync request for "${request.contextGraphId}": identity verification unavailable (identityId=${requesterIdentityId.toString()} signer=${recoveredAddress})`);
      return false;
    }
    const validIdentity = await verifyIdentity(recoveredAddress, requesterIdentityId, lookupOptions);
    throwIfAborted(signal);
    if (!validIdentity) {
      logWarn(ctx, `Denied sync request for "${request.contextGraphId}": signer ${recoveredAddress} does not verify for identityId=${requesterIdentityId.toString()}`);
      return false;
    }
  } else if (!request.requesterAgentAddress || recoveredAddress.toLowerCase() !== request.requesterAgentAddress.toLowerCase()) {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": edge signer mismatch (signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'})`);
    return false;
  }

  let participants = await getParticipants(request.contextGraphId, lookupOptions);
  throwIfAborted(signal);
  let agentGateAddresses = await getAgentGateAddresses(request.contextGraphId, lookupOptions);
  throwIfAborted(signal);
  let allowedPeers = await getAllowedPeers(request.contextGraphId, lookupOptions);
  throwIfAborted(signal);
  let allowedDelegateePeers = await getAllowedDelegateePeers(request.contextGraphId, lookupOptions);
  throwIfAborted(signal);
  let allowedDelegateeKeys = await getAllowedDelegateeKeys(request.contextGraphId, lookupOptions);
  throwIfAborted(signal);
  const isParticipantAllowed = () => participants?.some((p) =>
    p.toLowerCase() === recoveredAddress.toLowerCase() ||
    (requesterIdentityId > 0n && p === String(requesterIdentityId)),
  ) ?? false;
  const isAgentGateAllowed = () => agentGateAddresses?.some((agent) =>
    agent.toLowerCase() === recoveredAddress.toLowerCase(),
  ) ?? false;
  const isPeerAllowed = () => allowedPeers?.includes(remotePeerId) ?? false;
  // Agent-signed delegation. The envelope's `requesterAgentAddress`
  // is the "on behalf of" claim — the agent the joiner's node says
  // it's representing. We then look up the delegation entity for
  // THAT specific agent and verify the carrier identifiers
  // (op-key signer and/or transport peer-id) match what the agent
  // signed. Without an explicit principal claim we deny on this path
  // — graph-wide union would let any node hosting an approved agent
  // sync data on behalf of an unapproved one.
  const claimedAgent = request.requesterAgentAddress?.toLowerCase();
  const isDelegateePeerAllowed = () =>
    !!claimedAgent && (allowedDelegateePeers.get(claimedAgent)?.includes(remotePeerId) ?? false);
  const isDelegateeKeyAllowed = () =>
    !!claimedAgent && (allowedDelegateeKeys.get(claimedAgent)?.includes(recoveredAddress.toLowerCase()) ?? false);
  const isDelegateeAllowed = () => isDelegateePeerAllowed() || isDelegateeKeyAllowed();
  const resolveAllowed = () => {
    if (isDelegateeAllowed()) return true;
    if (agentGateAddresses !== null && allowedPeers !== null) {
      return isPeerAllowed() && isAgentGateAllowed();
    }
    return isParticipantAllowed() || isPeerAllowed();
  };

  let allowed = resolveAllowed();

  if (!allowed) {
    const refreshed = await refreshMetaFromCurator(request.contextGraphId, lookupOptions);
    throwIfAborted(signal);
    if (refreshed) {
      participants = await getParticipants(request.contextGraphId, lookupOptions);
      throwIfAborted(signal);
      agentGateAddresses = await getAgentGateAddresses(request.contextGraphId, lookupOptions);
      throwIfAborted(signal);
      allowedPeers = await getAllowedPeers(request.contextGraphId, lookupOptions);
      throwIfAborted(signal);
      allowedDelegateePeers = await getAllowedDelegateePeers(request.contextGraphId, lookupOptions);
      throwIfAborted(signal);
      allowedDelegateeKeys = await getAllowedDelegateeKeys(request.contextGraphId, lookupOptions);
      throwIfAborted(signal);
      allowed = resolveAllowed();
    }
  }

  const delegateePeerSetForClaim = claimedAgent ? allowedDelegateePeers.get(claimedAgent)?.length ?? 0 : 0;
  const delegateeKeySetForClaim = claimedAgent ? allowedDelegateeKeys.get(claimedAgent)?.length ?? 0 : 0;
  logInfo(
    ctx,
    `Private sync auth for "${request.contextGraphId}": identityId=${requesterIdentityId.toString()} signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'} participantCount=${participants?.length ?? 0} agentGateCount=${agentGateAddresses?.length ?? 0} delegateePeerCount=${delegateePeerSetForClaim} delegateeKeyCount=${delegateeKeySetForClaim} peerAllowed=${isPeerAllowed()} delegateeAllowed=${isDelegateeAllowed()} allowed=${allowed}`,
  );

  if (allowed) {
    throwIfAborted(signal);
    seenRequestIds.set(request.requestId, now);
  }
  return allowed;
}
