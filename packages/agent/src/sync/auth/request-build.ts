import { ethers } from 'ethers';

export type SyncPhase = 'data' | 'meta' | 'snapshot';

export interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
  phase?: SyncPhase;
  snapshotRef?: string;
}

interface BuildSyncRequestParams {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  targetPeerId: string;
  requesterPeerId: string;
  phase?: SyncPhase;
  snapshotRef?: string;
  needsAuth: boolean;
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
  ) => Uint8Array;
  getIdentityId: () => Promise<bigint>;
  signMessage?: (digest: Uint8Array) => Promise<{ r: Uint8Array; vs: Uint8Array }>;
  /**
   * Agent address the request is being made ON BEHALF OF for THIS
   * context graph. NOT the process-wide default — the caller must pick
   * the right agent for the CG (see `findLocalAgentForContextGraph`).
   * The address is bound into the signed digest so post-signing
   * envelope tampering can't steer the responder's delegation lookup.
   */
  claimedAgentAddress?: string;
  /** Private key matching `claimedAgentAddress`, used as a fallback signer when no chain identity is available. */
  claimedAgentPrivateKey?: string;
}

export async function buildSyncRequestEnvelope(params: BuildSyncRequestParams): Promise<Uint8Array> {
  const {
    contextGraphId,
    offset,
    limit,
    includeSharedMemory,
    targetPeerId,
    requesterPeerId,
    phase,
    snapshotRef,
    needsAuth,
    computeSyncDigest,
    getIdentityId,
    signMessage,
    claimedAgentAddress,
    claimedAgentPrivateKey,
  } = params;

  if (!needsAuth) {
    const prefix = includeSharedMemory ? `workspace:${contextGraphId}` : contextGraphId;
    const phaseSuffix = phase === 'meta'
      ? '|meta'
      : phase === 'snapshot'
        ? `|snapshot|${snapshotRef ?? ''}`
        : '';
    return new TextEncoder().encode(`${prefix}|${offset}|${limit}${phaseSuffix}`);
  }

  const request: SyncRequestEnvelope = {
    contextGraphId,
    offset,
    limit,
    includeSharedMemory,
    targetPeerId,
    requesterPeerId,
    requestId: ethers.hexlify(ethers.randomBytes(12)),
    issuedAtMs: Date.now(),
  };
  if (phase) request.phase = phase;
  if (snapshotRef) request.snapshotRef = snapshotRef;

  // Bind the "on behalf of" agent claim INTO the signed digest so the
  // responder's per-agent delegation lookup can't be steered by post-
  // signing envelope tampering. For op-key-signed envelopes the agent
  // address still isn't a signing principal, but it IS material that
  // the signature must commit to.
  if (claimedAgentAddress) {
    request.requesterAgentAddress = claimedAgentAddress;
  }
  const digest = computeSyncDigest(
    request.contextGraphId,
    request.offset,
    request.limit,
    request.includeSharedMemory,
    request.targetPeerId!,
    request.requesterPeerId!,
    request.requestId!,
    request.issuedAtMs!,
    request.requesterAgentAddress,
  );

  const identityId = await getIdentityId();
  if (identityId > 0n && typeof signMessage === 'function') {
    const signature = await signMessage(digest);
    request.requesterIdentityId = identityId.toString();
    request.requesterSignatureR = ethers.hexlify(signature.r);
    request.requesterSignatureVS = ethers.hexlify(signature.vs);
  } else if (claimedAgentAddress && claimedAgentPrivateKey) {
    const wallet = new ethers.Wallet(claimedAgentPrivateKey);
    const sig = ethers.Signature.from(await wallet.signMessage(digest));
    request.requesterIdentityId = '0';
    // requesterAgentAddress was already set above (and bound into the digest).
    request.requesterSignatureR = ethers.hexlify(sig.r);
    request.requesterSignatureVS = ethers.hexlify(sig.yParityAndS);
  }

  if (needsAuth && (!request.requesterSignatureR || !request.requesterSignatureVS)) {
    const signingTarget = claimedAgentAddress ? `claimed agent ${claimedAgentAddress}` : 'node identity';
    throw new Error(`Cannot build authenticated sync request for "${contextGraphId}": missing signing key for ${signingTarget}`);
  }

  return new TextEncoder().encode(JSON.stringify(request));
}
