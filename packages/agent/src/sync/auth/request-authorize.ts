import { ethers } from 'ethers';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { SyncRequestEnvelope } from './request-build.js';

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
  ) => Uint8Array;
  verifyIdentity?: (recoveredAddress: string, claimedIdentityId: bigint) => Promise<boolean>;
  getParticipants: (contextGraphId: string) => Promise<string[] | null>;
  getAllowedPeers: (contextGraphId: string) => Promise<string[] | null>;
  refreshMetaFromCurator: (contextGraphId: string) => Promise<boolean>;
  logWarn: (ctx: OperationContext, message: string) => void;
  logInfo: (ctx: OperationContext, message: string) => void;
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
    refreshMetaFromCurator,
    logWarn,
    logInfo,
  } = params;

  const now = Date.now();
  for (const [requestId, seenAt] of seenRequestIds) {
    if (now - seenAt > syncAuthMaxAgeMs) {
      seenRequestIds.delete(requestId);
    }
  }

  let requesterIdentityId = 0n;
  try { requesterIdentityId = request.requesterIdentityId ? BigInt(request.requesterIdentityId) : 0n; } catch {}

  if (
    request.targetPeerId !== localPeerId ||
    request.requesterPeerId !== remotePeerId ||
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

  const digest = computeSyncDigest(
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId,
    request.requesterPeerId,
    request.requestId,
    request.issuedAtMs,
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
    const validIdentity = await verifyIdentity(recoveredAddress, requesterIdentityId);
    if (!validIdentity) {
      logWarn(ctx, `Denied sync request for "${request.contextGraphId}": signer ${recoveredAddress} does not verify for identityId=${requesterIdentityId.toString()}`);
      return false;
    }
  } else if (!request.requesterAgentAddress || recoveredAddress.toLowerCase() !== request.requesterAgentAddress.toLowerCase()) {
    logWarn(ctx, `Denied sync request for "${request.contextGraphId}": edge signer mismatch (signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'})`);
    return false;
  }

  let participants = await getParticipants(request.contextGraphId);
  let allowed = participants?.some((p) =>
    p.toLowerCase() === recoveredAddress.toLowerCase() ||
    (requesterIdentityId > 0n && p === String(requesterIdentityId)),
  ) ?? false;

  if (!allowed) {
    const allowedPeers = await getAllowedPeers(request.contextGraphId);
    if (allowedPeers?.includes(remotePeerId)) {
      allowed = true;
    }
  }

  if (!allowed) {
    const refreshed = await refreshMetaFromCurator(request.contextGraphId);
    if (refreshed) {
      participants = await getParticipants(request.contextGraphId);
      allowed = participants?.some((p) =>
        p.toLowerCase() === recoveredAddress.toLowerCase() ||
        p === String(requesterIdentityId),
      ) ?? false;
      if (!allowed) {
        const freshPeers = await getAllowedPeers(request.contextGraphId);
        if (freshPeers?.includes(remotePeerId)) {
          allowed = true;
        }
      }
    }
  }

  logInfo(
    ctx,
    `Private sync auth for "${request.contextGraphId}": identityId=${requesterIdentityId.toString()} signer=${recoveredAddress} requesterAgentAddress=${request.requesterAgentAddress ?? 'n/a'} participantCount=${participants?.length ?? 0} allowed=${allowed}`,
  );

  if (allowed) {
    seenRequestIds.set(request.requestId, now);
  }
  return allowed;
}
