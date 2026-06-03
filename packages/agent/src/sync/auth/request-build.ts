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
  /**
   * Phase C — optional, UNSIGNED delta-sync hint. When set, the responder
   * returns only Knowledge Assets whose KC `dkg:batchId` is strictly greater
   * than this value (the requester's per-CG high-water mark). Encoded as a
   * decimal string because batchIds are `uint256` and exceed `Number`.
   *
   * Deliberately NOT part of `computeSyncDigest` (same treatment as
   * `phase`/`snapshotRef`): it can only ever NARROW the result set, so a
   * subset is always authorization-safe and needs no signed-digest version
   * bump or negotiation. Old responders ignore the unknown field and return a
   * full scan; new responders honor it and return a delta.
   */
  sinceBatchId?: string;
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
  sinceBatchId?: string;
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
    sinceBatchId,
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
    // Phase C: trailing keyed token; old responders ignore the extra parts.
    const sinceSuffix = sinceBatchId ? `|since|${sinceBatchId}` : '';
    return new TextEncoder().encode(`${prefix}|${offset}|${limit}${phaseSuffix}${sinceSuffix}`);
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
  // Phase C: set AFTER digest computation below — it is intentionally outside
  // the signature (narrowing-only, see field docs).

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

  // Phase C: ride the envelope unsigned, after the digest (cannot influence
  // authorization; only narrows the responder's result set).
  if (sinceBatchId) request.sinceBatchId = sinceBatchId;

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

/**
 * Parse the unauthenticated, pipe-delimited sync request encoding produced by
 * {@link buildSyncRequestEnvelope} when `needsAuth` is false:
 *
 *   `[workspace:]<cg>|<offset>|<limit>[|meta][|snapshot|<ref>][|since|<n>]`
 *
 * Extracted (pure, dependency-free) from the agent so both the encode and parse
 * directions are unit-testable together. The phase normalisation is inlined to
 * keep this module free of agent-side imports.
 *
 * Phase C delta hint: the `|since|<n>` keyed token is ALWAYS the FINAL two
 * segments (after any phase/snapshot suffix). We match only that trailing
 * position — scanning every segment would misparse an ordinary segment that
 * happens to equal `"since"` (a CG or snapshotRef literally named "since") as a
 * delta marker and silently turn a full sync into a partial one.
 */
export function parsePipeDelimitedSyncRequest(
  text: string,
  opts: { defaultContextGraphId: string; syncPageSize: number },
): SyncRequestEnvelope {
  const parts = text.split('|');
  const ctxGraphPart = parts[0] || '';
  const includeSharedMemory = ctxGraphPart.startsWith('workspace:');
  const contextGraphId = includeSharedMemory
    ? ctxGraphPart.slice('workspace:'.length)
    : (ctxGraphPart || opts.defaultContextGraphId);
  const rawPhase = parts[3];
  const phase: SyncPhase = rawPhase === 'meta' || rawPhase === 'snapshot' ? rawPhase : 'data';

  let sinceBatchId: string | undefined;
  if (
    parts.length >= 2 &&
    parts[parts.length - 2] === 'since' &&
    /^\d+$/.test(parts[parts.length - 1])
  ) {
    sinceBatchId = parts[parts.length - 1];
  }

  return {
    contextGraphId,
    offset: parseInt(parts[1], 10) || 0,
    limit: Math.min(parseInt(parts[2], 10) || opts.syncPageSize, opts.syncPageSize),
    includeSharedMemory,
    phase,
    snapshotRef: phase === 'snapshot' ? parts[4] : undefined,
    sinceBatchId,
  };
}
