import { ethers } from 'ethers';
import {
  SYNC_BYTE_BUDGET_MAX_ROWS,
  SYNC_BYTE_BUDGET_PAGE_MODE,
  SYNC_PAGE_SIZE,
} from '../../dkg-agent-constants.js';
import { encodeExactAssetUals, requireExactAssetUals } from '../exact-assets.js';

// 'catalog' (§7) — the public facet open-serve: served to ANYONE
// without the allowlist gate, bounded to exactly the `_catalog` named graph.
// Backward-compatible: `phase` is not part of the signed digest and only
// narrows results, so old responders ignore it and new ones honor it.
export type SyncPhase = 'data' | 'meta' | 'snapshot' | 'catalog';

// NOTE: a structurally-identical `SyncRequestEnvelope` is also declared in
// `dkg-agent-types.ts` (used by `parseSyncRequest`'s return type and the agent
// modules). The two MUST be kept in lockstep — adding a field here without
// mirroring it there silently drops it on the parse/responder path.
export interface SyncRequestEnvelope {
  contextGraphId: string;
  offset: number;
  limit: number;
  includeSharedMemory: boolean;
  targetPeerId?: string;
  requesterPeerId?: string;
  requestId?: string;
  issuedAtMs?: number;
  syncSessionId?: string;
  requesterIdentityId?: string;
  requesterAgentAddress?: string;
  requesterSignatureR?: string;
  requesterSignatureVS?: string;
  phase?: SyncPhase;
  snapshotRef?: string;
  authPurpose?: string;
  authSelector?: string;
  /**
   * Additive, UNSIGNED response-shaping capability. The signed `limit` remains
   * at or below the legacy 500-row cap, so old responders can authenticate and
   * serve the request unchanged. New responders may honor `pageRowsHint`, but
   * only under their own hard row and byte caps. This cannot expand the caller's
   * authorization scope; it only changes how much already-authorized durable
   * data is returned in one response.
   */
  pageMode?: typeof SYNC_BYTE_BUDGET_PAGE_MODE;
  pageRowsHint?: number;
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
  /**
   * Additive, UNSIGNED exact-KA response filter. It can only narrow an already
   * authorized Context Graph read. Upgraded responders serve metadata and data
   * for these UALs only; old responders ignore it, while the upgraded requester
   * still filters their full response before verification/storage.
   */
  assetUals?: string[];
  /**
   * R9 (SECURITY) — member SWM recovery marker. When set, the recovery path
   * serves PLAINTEXT member-to-member, so the responder MUST authorize it via
   * the strict members-only `isMemberRecoveryAuthorized` hard-deny gate (a
   * FRESH `_meta` agent-gate read, hard-deny on null/empty) and MUST NOT fall
   * through to the weaker participant/peer fallback in
   * `authorizePrivateSyncRequest`.
   *
   * Deliberately UNSIGNED (rides the envelope after `computeSyncDigest`, like
   * `phase`/`sinceBatchId`). The rationale differs from those narrowing-only
   * fields: `recovery` only ever ESCALATES strictness. An attacker who sets it
   * faces the harder members-only gate; stripping it (MITM on a real member's
   * request) just reverts to the normal private-sync path the member already
   * passes. It is auth-safe precisely because the responder decides membership
   * against the cryptographically RECOVERED signer address — never against this
   * flag or the (forgeable) `requesterAgentAddress` claim alone.
   */
  recovery?: boolean;
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
  authPurpose?: string;
  authSelector?: string;
  sinceBatchId?: string;
  assetUals?: string[];
  syncSessionId?: string;
  needsAuth: boolean;
  /**
   * R9 (SECURITY) — member SWM recovery. Forces the JSON auth envelope (never
   * the public text form) and, critically, forces the EDGE (agent-key) signing
   * path so the responder-recovered signer == the member agent address. The
   * responder's members-only gate decides on the RECOVERED signer, so the
   * recovery request MUST be signed by the member agent's own key (NOT the node
   * op-key, which would recover to a non-member and be hard-denied). No
   * delegation is consulted on the recovery path.
   */
  recovery?: boolean;
  /**
   * Force the authenticated envelope to be signed by `claimedAgentPrivateKey`
   * even when the node also has an on-chain identity signer. Use this for
   * protocols whose responder authorizes the recovered signer as the claimed
   * agent itself, not as the node identity/op-key.
   */
  forceClaimedAgentSignature?: boolean;
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
    authPurpose,
    authSelector,
    sinceBatchId,
    assetUals: rawAssetUals,
    syncSessionId,
    needsAuth,
    recovery,
    forceClaimedAgentSignature,
    computeSyncDigest,
    getIdentityId,
    signMessage,
    claimedAgentAddress,
    claimedAgentPrivateKey,
  } = params;

  // R9: recovery serves plaintext member-to-member and is authorized by the
  // strict members-only gate — it can never ride the unauthenticated public
  // text form. Private SWM already yields needsAuth=true; assert it rather than
  // silently downgrade to an envelope no responder will gate as recovery.
  if (recovery && !needsAuth) {
    throw new Error(`Cannot build member-recovery sync request for "${contextGraphId}": recovery requires an authenticated envelope`);
  }
  if (forceClaimedAgentSignature && !needsAuth) {
    throw new Error(`Cannot build agent-signed sync request for "${contextGraphId}": forced agent signing requires an authenticated envelope`);
  }

  const requestedLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, SYNC_BYTE_BUDGET_MAX_ROWS))
    : SYNC_PAGE_SIZE;
  // Advertise byte-budget page mode for durable DATA and META (#1916/#1923).
  // Additive/rolling-upgrade safe both directions: an OLD responder ignores the
  // meta pageMode (its meta path is not byte-budget-gated → serves legacy meta),
  // and a NEW responder treats a request WITHOUT meta pageMode as non-negotiated
  // (plain meta serializer). The signed `limit` still rides the 500-row legacy
  // cap below, so digests stay wire-compatible.
  const useByteBudgetPage = !includeSharedMemory
    && (phase === 'data' || phase === 'meta')
    && requestedLimit > SYNC_PAGE_SIZE;
  const assetUals = rawAssetUals === undefined ? undefined : requireExactAssetUals(rawAssetUals);

  if (!needsAuth) {
    const prefix = includeSharedMemory ? `workspace:${contextGraphId}` : contextGraphId;
    const phaseSuffix = phase === 'meta'
      ? '|meta'
      : phase === 'snapshot'
        ? `|snapshot|${snapshotRef ?? ''}`
        : phase === 'catalog'
          // The public `_catalog` facet (§7) is open-served unauthenticated, so
          // it rides THIS text form. Emit the phase token in parts[3] (same slot
          // `parsePipeDelimitedSyncRequest` reads) so the phase survives on the
          // wire and the responder routes to readCatalogPage instead of falling
          // back to the DEFAULT data phase (which is gated and serves nothing).
          ? '|catalog'
          : '';
    // Trailing keyed tokens are additive; old responders ignore the extra parts.
    const sessionSuffix = syncSessionId ? `|session|${syncSessionId}` : '';
    const sinceSuffix = sinceBatchId ? `|since|${sinceBatchId}` : '';
    const assetsSuffix = assetUals ? `|assets|${encodeExactAssetUals(assetUals)}` : '';
    return new TextEncoder().encode(`${prefix}|${offset}|${requestedLimit}${phaseSuffix}${sessionSuffix}${sinceSuffix}${assetsSuffix}`);
  }

  const request: SyncRequestEnvelope = {
    contextGraphId,
    offset,
    // Keep this signed field within the legacy cap. An old responder clamps to
    // the same value before verifying the digest, so rolling upgrades remain
    // wire-compatible even when the additive hint below asks a new responder
    // for a larger byte-bounded page.
    limit: Math.min(requestedLimit, SYNC_PAGE_SIZE),
    includeSharedMemory,
    targetPeerId,
    requesterPeerId,
    requestId: ethers.hexlify(ethers.randomBytes(12)),
    issuedAtMs: Date.now(),
  };
  if (phase) request.phase = phase;
  if (snapshotRef) request.snapshotRef = snapshotRef;
  if (authPurpose) request.authPurpose = authPurpose;
  if (authSelector) request.authSelector = authSelector;
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
    request.authPurpose,
    request.authSelector,
  );

  // Phase C: ride the envelope unsigned, after the digest (cannot influence
  // authorization; only narrows the responder's result set).
  if (syncSessionId) request.syncSessionId = syncSessionId;
  if (sinceBatchId) request.sinceBatchId = sinceBatchId;
  if (assetUals) request.assetUals = assetUals;
  if (useByteBudgetPage) {
    request.pageMode = SYNC_BYTE_BUDGET_PAGE_MODE;
    request.pageRowsHint = requestedLimit;
  }
  // R9: unsigned recovery marker (only ever escalates strictness — see field
  // docs). The responder authorizes against the recovered signer, not this flag.
  if (recovery) request.recovery = true;

  // R9: recovery is authorized against the RECOVERED signer address, which the
  // responder matches against the members-only agent gate. So a recovery
  // request MUST be signed by the member agent's OWN key (edge path) — the node
  // identity op-key would recover to a non-member and be hard-denied. Force the
  // edge path and require the agent key locally (the recovering node IS the
  // member, so it holds the key).
  const mustSignWithClaimedAgent = Boolean(recovery || forceClaimedAgentSignature);
  const identityId = mustSignWithClaimedAgent ? 0n : await getIdentityId();
  if (mustSignWithClaimedAgent) {
    if (!claimedAgentAddress || !claimedAgentPrivateKey) {
      const requestType = recovery ? 'member-recovery' : 'agent-signed';
      throw new Error(`Cannot build ${requestType} sync request for "${contextGraphId}": missing claimed agent signing key`);
    }
    const wallet = new ethers.Wallet(claimedAgentPrivateKey);
    const sig = ethers.Signature.from(await wallet.signMessage(digest));
    request.requesterIdentityId = '0';
    // requesterAgentAddress was already set above (and bound into the digest);
    // the responder enforces recoveredAddress === member gate entry.
    request.requesterSignatureR = ethers.hexlify(sig.r);
    request.requesterSignatureVS = ethers.hexlify(sig.yParityAndS);
  } else if (identityId > 0n && typeof signMessage === 'function') {
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
