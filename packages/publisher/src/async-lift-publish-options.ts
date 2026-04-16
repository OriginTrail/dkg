import type { Quad } from '@origintrail-official/dkg-storage';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type {
  PhaseCallback,
  PublishOptions,
  ReceiverSignatureProvider,
} from './publisher.js';
import type {
  LiftAuthorityProof,
  LiftJobValidationMetadata,
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
}

export interface LiftPublishMappingInput {
  readonly request: LiftRequest;
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
  const authorityProofRef = normalizeAuthorityProofRef(input.validation.authorityProofRef);
  if (authorityProofRef.length === 0) {
    throw new Error('Lift publish mapping requires a non-empty authorityProofRef');
  }

  if (input.request.transitionType !== input.validation.transitionType) {
    throw new Error(
      `Lift publish mapping requires validation.transitionType to match request.transitionType. Request: ${input.request.transitionType}, validation: ${input.validation.transitionType}`,
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

  return {
    contextGraphId: input.request.contextGraphId,
    quads: input.resolved.quads,
    privateQuads: privateQuads.length > 0 ? privateQuads : undefined,
    publisherPeerId,
    accessPolicy,
    allowedPeers: allowedPeers.length > 0 ? allowedPeers : undefined,
    entityProofs: input.resolved.entityProofs,
    targetGraphUri: input.resolved.targetGraphUri,
    targetMetaGraphUri: input.resolved.targetMetaGraphUri,
    operationCtx: input.resolved.operationCtx,
    onPhase: input.resolved.onPhase,
    receiverSignatureProvider: input.resolved.receiverSignatureProvider,
    publishContextGraphId: input.resolved.publishContextGraphId,
  };
}

export function prepareAsyncPublishPayload(input: LiftPublishMappingInput): AsyncPreparedPublishPayload {
  const publishOptions = mapLiftRequestToPublishOptions(input);
  const authorityProofRef = normalizeAuthorityProofRef(input.validation.authorityProofRef);

  return {
    contextGraphId: input.request.contextGraphId,
    scope: input.request.scope,
    transitionType: input.request.transitionType,
    authority: input.request.authority,
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

function normalizePriorVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
