import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { MAX_PUBLISH_EPOCHS } from './publisher.js';
import type {
  PhaseCallback,
  PublishOptions,
  ReceiverSignatureProvider,
} from './publisher.js';
import type {
  LiftAuthorityProof,
  LiftJobValidationMetadata,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  LiftTransitionType,
  LiftRequest,
} from './lift-job.js';

export interface LiftResolvedPublishSlice {
  /**
   * Public quads resolved from the workspace slice selected by LiftRequest.roots.
   * These are the canonical quads handed to the shared publish flow.
   */
  readonly quads: Quad[];
  /**
   * Optional private quads resolved from the same workspace slice.
   * When present and no explicit access policy is supplied, the mapper defaults
   * canonical publish options to `ownerOnly`.
   */
  readonly privateQuads?: Quad[];
  /** Publisher peer ID used by canonical publish metadata/access checks. */
  readonly publisherPeerId?: string;
  readonly accessPolicy?: PublishOptions['accessPolicy'];
  readonly allowedPeers?: readonly string[];
  readonly entityProofs?: boolean;
  readonly targetGraphUri?: string;
  readonly targetMetaGraphUri?: string;
  readonly operationCtx?: OperationContext;
  readonly onPhase?: PhaseCallback;
  readonly receiverSignatureProvider?: ReceiverSignatureProvider;
  readonly publishContextGraphId?: string;
  /**
   * GH #1121 — inline-encryption callbacks for private/curated CGs, threaded
   * from the async worker (the agent-resolved, chainKey-bound AEAD closures)
   * into the mapper exactly like `onPhase`/`receiverSignatureProvider`. When a
   * non-public CG reaches the mapper WITHOUT these, the mapper substitutes a
   * fail-closed default so cores can never silently receive plaintext.
   */
  readonly encryptInlinePayload?: PublishOptions['encryptInlinePayload'];
  readonly encryptInlineChunked?: PublishOptions['encryptInlineChunked'];
}

/**
 * GH #1121 fail-closed default. A private/curated async publish must never ship
 * plaintext to cores. The real chainKey-bound AEAD closure is resolved live at
 * execute time by the agent and threaded through `LiftResolvedPublishSlice`
 * (and, in the CLI runtime, merged in `publisher-runner.ts` where it takes
 * precedence over this default). If a non-public CG ever reaches the publisher
 * with NO inline-encryption callback, this default makes the publish FAIL LOUD
 * instead of leaking plaintext.
 */
const FAIL_CLOSED_MARKER = '__dkgFailClosedInlineEncrypt';
const failClosedInlineEncrypt: NonNullable<PublishOptions['encryptInlinePayload']> = Object.assign(
  (() => {
    throw new Error(
      'Async-lift private/curated CG publish requires an encryptInlinePayload factory threaded ' +
        'through LiftResolvedPublishSlice (a non-public context graph must not ship plaintext to cores). ' +
        'Wire publishEncryptionFactory in the async publisher runtime.',
    );
  }) as NonNullable<PublishOptions['encryptInlinePayload']>,
  { [FAIL_CLOSED_MARKER]: true as const },
);

/**
 * True iff `cb` is the mapper's fail-closed default (not a real agent-resolved
 * encryption callback). The publisher uses this to skip the encrypted-inline
 * path on a chainless/local publish that ships nothing to cores — there is no
 * plaintext leak to guard, so the default must not throw — while still honouring
 * any REAL callback the caller wired, and still firing the default (fail-closed)
 * for an actual on-chain publish with no real encryption resolved.
 */
export function isFailClosedInlineEncrypt(cb: unknown): boolean {
  return typeof cb === 'function' && (cb as unknown as Record<string, unknown>)[FAIL_CLOSED_MARKER] === true;
}

export interface LiftPublishMappingInput {
  readonly request: LiftPublishSnapshotRequest;
  readonly metadata?: LiftPublishRequestMetadata;
  readonly validation: Pick<LiftJobValidationMetadata, 'authorityProofRef' | 'priorVersion' | 'transitionType'>;
  readonly resolved: LiftResolvedPublishSlice;
}

/**
 * Internal handoff contract between async lift orchestration and canonical
 * publish execution. This is intentionally not a second public protocol: it
 * packages validated lift context together with the canonical PublishOptions
 * needed to call shared publish logic.
 */
export interface AsyncPreparedPublishPayload {
  readonly contextGraphId: string;
  readonly scope: string;
  readonly transitionType: LiftTransitionType;
  readonly authority: LiftAuthorityProof;
  readonly authorityProofRef: string;
  readonly priorVersion?: string;
  readonly quads: Quad[];
  readonly privateQuads: Quad[];
  readonly publishOptions: PublishOptions;
  readonly subtraction?: {
    alreadyPublishedPublicCount: number;
    alreadyPublishedPrivateCount: number;
  };
}

/**
 * Maps validated async-lift inputs onto the canonical PublishOptions contract.
 * Authority proof refs and priorVersion stay as lift/job validation metadata:
 * they gate whether canonical publish is allowed, but they do not have direct
 * fields on PublishOptions today.
 */
export function mapLiftRequestToPublishOptions(input: LiftPublishMappingInput): PublishOptions {
  const metadata = resolveLiftPublishRequestMetadata(input.request, input.metadata);
  const authorityProofRef = normalizeAuthorityProofRef(input.validation.authorityProofRef);
  if (authorityProofRef.length === 0) {
    throw new Error('Lift publish mapping requires a non-empty authorityProofRef');
  }

  if (metadata.transitionType !== input.validation.transitionType) {
    throw new Error(
      `Lift publish mapping requires validation.transitionType to match request metadata transitionType. Request: ${metadata.transitionType}, validation: ${input.validation.transitionType}`,
    );
  }

  const requestPriorVersion = normalizePriorVersion(input.request.priorVersion);
  const validationPriorVersion = input.validation.priorVersion;
  if (requestPriorVersion !== validationPriorVersion) {
    throw new Error(
      `Lift publish mapping requires validation.priorVersion to match request.priorVersion. Request: ${requestPriorVersion ?? '<none>'}, validation: ${validationPriorVersion ?? '<none>'}`,
    );
  }

  const privateQuads = [...(input.resolved.privateQuads ?? [])];
  const publisherPeerId = input.resolved.publisherPeerId?.trim();
  const allowedPeers = [...new Set((input.resolved.allowedPeers ?? []).map((peerId) => peerId.trim()).filter(Boolean))];
  const accessPolicy = input.resolved.accessPolicy ?? (privateQuads.length > 0 ? 'ownerOnly' : 'public');

  if (accessPolicy !== 'public' && !publisherPeerId) {
    throw new Error(`Lift publish mapping requires publisherPeerId when accessPolicy is ${accessPolicy}`);
  }
  if (accessPolicy === 'allowList' && allowedPeers.length === 0) {
    throw new Error('Lift publish mapping requires non-empty allowedPeers for allowList access');
  }
  if (accessPolicy !== 'allowList' && allowedPeers.length > 0) {
    throw new Error('Lift publish mapping only allows allowedPeers when accessPolicy is allowList');
  }

  // GH #1121 — derive the inline-encryption path. Public CGs MUST stay
  // plaintext: force BOTH inline callbacks to `undefined` so even a resolver
  // that supplies a default encryption factory cannot push DKGPublisher onto
  // the encrypted-inline path for a public CG (otherwise public content would
  // be silently encrypted at rest and unreadable by readers). Non-public CGs
  // MUST carry an inline-encryption callback: use the agent-resolved one
  // threaded through `resolved`, else the fail-closed default so a missing
  // factory throws at publish time rather than leaking plaintext. The chunked
  // callback is optional (the inline blob path is the floor).
  const encryptInlinePayload = accessPolicy === 'public'
    ? undefined
    : (input.resolved.encryptInlinePayload ?? failClosedInlineEncrypt);
  const encryptInlineChunked = accessPolicy === 'public'
    ? undefined
    : input.resolved.encryptInlineChunked;

  // Request flags (enqueue-time caller intent) win over resolved hints (per-process defaults).
  const entityProofs = input.request.entityProofs ?? input.resolved.entityProofs;
  const publishEpochs = input.request.publishEpochs;
  if (publishEpochs !== undefined && (!Number.isSafeInteger(publishEpochs) || publishEpochs < 1 || publishEpochs > MAX_PUBLISH_EPOCHS)) {
    throw new Error(`Lift publish mapping requires request.publishEpochs to be a positive uint32 integer; got ${String(publishEpochs)}`);
  }
  const publisherNodeIdentityIdOverride = input.request.publisherNodeIdentityIdOverride !== undefined
    ? BigInt(input.request.publisherNodeIdentityIdOverride)
    : undefined;

  return {
    contextGraphId: input.request.contextGraphId,
    quads: input.resolved.quads,
    privateQuads: privateQuads.length > 0 ? privateQuads : undefined,
    publisherPeerId,
    accessPolicy,
    allowedPeers: allowedPeers.length > 0 ? allowedPeers : undefined,
    entityProofs,
    targetGraphUri: input.resolved.targetGraphUri,
    targetMetaGraphUri: input.resolved.targetMetaGraphUri,
    subGraphName: input.request.subGraphName,
    operationCtx: input.resolved.operationCtx,
    onPhase: input.resolved.onPhase,
    receiverSignatureProvider: input.resolved.receiverSignatureProvider,
    publishContextGraphId: input.resolved.publishContextGraphId,
    encryptInlinePayload,
    encryptInlineChunked,
    ...(publishEpochs !== undefined
      ? { publishEpochs }
      : {}),
    ...(publisherNodeIdentityIdOverride !== undefined
      ? { publisherNodeIdentityIdOverride }
      : {}),
    // Publisher's SEAL INTEGRITY PREFLIGHT validates this against its own recomputed merkle.
    ...(input.request.seal !== undefined
      ? { precomputedAttestation: liftSealToPrecomputedAttestation(input.request.seal) }
      : {}),
  };
}

function liftSealToPrecomputedAttestation(seal: NonNullable<LiftPublishSnapshotRequest['seal']>): {
  expectedMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
  reservedKaId: bigint;
} {
  return {
    expectedMerkleRoot: decodeSealField('merkleRoot', seal.merkleRoot, 32),
    authorAddress: seal.authorAddress,
    signature: {
      r: decodeSealField('signature.r', seal.signature.r, 32),
      vs: decodeSealField('signature.vs', seal.signature.vs, 32),
    },
    schemeVersion: seal.schemeVersion,
    // OT-RFC-43 §F2 — read the packed reservedKaId the author signed into the
    // digest at enqueue and thread it to `precomputedAttestation.reservedKaId`.
    // The publisher's `ensureReservedKaId` reuses this verbatim (it never
    // re-allocates when a precomputed id is present), so the on-chain mint
    // `_safeMint`s exactly the id the seal was signed over. A seal persisted
    // before §F2 async binding has no `reservedKaId` → `0n` (the legacy
    // behaviour: such a seal is namespace-mismatched and the mint rejects it).
    reservedKaId: BigInt(seal.reservedKaId ?? 0n),
  };
}

/** Validating hex → bytes decoder with bound length check. */
function decodeSealField(
  fieldName: string,
  hex: string,
  expectedBytes: number,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = ethers.getBytes(hex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Lift seal ${fieldName} contains invalid hex: ${message}`);
  }
  if (bytes.length !== expectedBytes) {
    throw new Error(
      `Lift seal ${fieldName} must be exactly ${expectedBytes} bytes; got ${bytes.length} (hex: ${hex})`,
    );
  }
  return bytes;
}

export function prepareAsyncPublishPayload(input: LiftPublishMappingInput): AsyncPreparedPublishPayload {
  const metadata = resolveLiftPublishRequestMetadata(input.request, input.metadata);
  const publishOptions = mapLiftRequestToPublishOptions(input);
  const authorityProofRef = normalizeAuthorityProofRef(input.validation.authorityProofRef);

  return {
    contextGraphId: input.request.contextGraphId,
    scope: metadata.scope,
    transitionType: metadata.transitionType,
    authority: metadata.authority,
    authorityProofRef,
    priorVersion: input.validation.priorVersion,
    quads: [...publishOptions.quads],
    privateQuads: [...(publishOptions.privateQuads ?? [])],
    publishOptions,
  };
}

function normalizeAuthorityProofRef(value: string): string {
  return value.trim();
}

function resolveLiftPublishRequestMetadata(
  request: LiftPublishSnapshotRequest,
  metadata: LiftPublishRequestMetadata | undefined,
): LiftPublishRequestMetadata {
  if (metadata) return metadata;
  const raw = request as LiftRequest;
  if (!raw.authority || !raw.scope || !raw.transitionType) {
    throw new Error('Lift publish mapping requires request metadata for non-raw snapshot requests');
  }
  return {
    scope: raw.scope,
    transitionType: raw.transitionType,
    authority: raw.authority,
  };
}

function normalizePriorVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
