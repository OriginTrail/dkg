import type { Quad } from '@origintrail-official/dkg-storage';
import type { LiftJob, LiftJobHex, LiftJobRequest } from './lift-job.js';

export const DEFAULT_CONTROL_GRAPH_URI = 'urn:dkg:publisher:control-plane';
export const DEFAULT_WALLET_LOCK_GRAPH_URI = 'urn:dkg:publisher:wallet-locks';

export const RDF_TYPE_PREDICATE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
export const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

export const CONTROL_JOB_TYPE = 'urn:dkg:publisher:LiftJob';
export const CONTROL_REQUEST_TYPE = 'urn:dkg:publisher:LiftRequest';
export const CONTROL_WALLET_LOCK_TYPE = 'urn:dkg:publisher:WalletLock';

export const CONTROL_HAS_REQUEST = 'urn:dkg:publisher:hasRequest';
export const CONTROL_STATUS = 'urn:dkg:publisher:status';
export const CONTROL_JOB_SLUG = 'urn:dkg:publisher:jobSlug';
export const CONTROL_PAYLOAD = 'urn:dkg:publisher:payload';
export const CONTROL_CONTEXT_GRAPH_ID = 'urn:dkg:publisher:contextGraphId';
export const CONTROL_SCOPE = 'urn:dkg:publisher:scope';
export const CONTROL_NAMESPACE = 'urn:dkg:publisher:namespace';
export const CONTROL_TRANSITION_TYPE = 'urn:dkg:publisher:transitionType';
export const CONTROL_SWM_ID = 'urn:dkg:publisher:swmId';
export const CONTROL_SHARE_OPERATION_ID = 'urn:dkg:publisher:shareOperationId';
export const CONTROL_ROOT = 'urn:dkg:publisher:root';
export const CONTROL_SUB_GRAPH_NAME = 'urn:dkg:publisher:subGraphName';
export const CONTROL_AUTHORITY_TYPE = 'urn:dkg:publisher:authorityType';
export const CONTROL_AUTHORITY_PROOF_REF = 'urn:dkg:publisher:authorityProofRef';
export const CONTROL_PRIOR_VERSION = 'urn:dkg:publisher:priorVersion';
export const CONTROL_ACCEPTED_AT = 'urn:dkg:publisher:acceptedAt';
export const CONTROL_CLAIMED_AT = 'urn:dkg:publisher:claimedAt';
export const CONTROL_VALIDATED_AT = 'urn:dkg:publisher:validatedAt';
export const CONTROL_BROADCAST_AT = 'urn:dkg:publisher:broadcastAt';
export const CONTROL_INCLUDED_AT = 'urn:dkg:publisher:includedAt';
export const CONTROL_FINALIZED_AT = 'urn:dkg:publisher:finalizedAt';
export const CONTROL_FAILED_AT = 'urn:dkg:publisher:failedAt';
export const CONTROL_LAST_RETRIED_AT = 'urn:dkg:publisher:lastRetriedAt';
export const CONTROL_NEXT_RETRY_AT = 'urn:dkg:publisher:nextRetryAt';
export const CONTROL_LAST_RECOVERED_AT = 'urn:dkg:publisher:lastRecoveredAt';
export const CONTROL_UPDATED_AT = 'urn:dkg:publisher:updatedAt';
export const CONTROL_RETRY_COUNT = 'urn:dkg:publisher:retryCount';
export const CONTROL_MAX_RETRIES = 'urn:dkg:publisher:maxRetries';
export const CONTROL_LAST_RETRY_REASON = 'urn:dkg:publisher:lastRetryReason';
// #1828 — ephemeral secondary index on the (mutable) job subject enabling O(1)
// intent recovery. This triple lives on jobRef, so clear/cancel/deleteJob remove
// it with the job. PR3 (#1829) append-only journal MUST key intent on its OWN
// journal subjects — never rely on the job-subject index for durability.
// `lifecycleKey` mirrors the promote queue's uniquenessKey (the dedup subject).
// Intent exactness is derived from the parsed payload at lookup time, so no
// separate intentKey triple is materialized.
export const CONTROL_LIFECYCLE_KEY = 'urn:dkg:publisher:lifecycleKey';
export const CONTROL_WALLET_ID = 'urn:dkg:publisher:walletId';
export const CONTROL_CLAIMED_BY = 'urn:dkg:publisher:claimedBy';
export const CONTROL_CLAIM_TOKEN = 'urn:dkg:publisher:claimToken';
export const CONTROL_CLAIM_LEASE_EXPIRES_AT = 'urn:dkg:publisher:claimLeaseExpiresAt';
export const CONTROL_TX_HASH = 'urn:dkg:publisher:txHash';
export const CONTROL_MERKLE_ROOT = 'urn:dkg:publisher:merkleRoot';
export const CONTROL_PUBLIC_BYTE_SIZE = 'urn:dkg:publisher:publicByteSize';
export const CONTROL_BLOCK_NUMBER = 'urn:dkg:publisher:blockNumber';
export const CONTROL_BLOCK_HASH = 'urn:dkg:publisher:blockHash';
export const CONTROL_BLOCK_TIMESTAMP = 'urn:dkg:publisher:blockTimestamp';
export const CONTROL_UAL = 'urn:dkg:publisher:ual';
export const CONTROL_FINALIZATION_MODE = 'urn:dkg:publisher:finalizationMode';
export const CONTROL_BATCH_ID = 'urn:dkg:publisher:batchId';
export const CONTROL_START_KA_ID = 'urn:dkg:publisher:startKAId';
export const CONTROL_END_KA_ID = 'urn:dkg:publisher:endKAId';
export const CONTROL_PUBLISHER_ADDRESS = 'urn:dkg:publisher:publisherAddress';
export const CONTROL_FAILURE_CODE = 'urn:dkg:publisher:failureCode';
export const CONTROL_FAILURE_PHASE = 'urn:dkg:publisher:failurePhase';
export const CONTROL_FAILURE_MODE = 'urn:dkg:publisher:failureMode';
export const CONTROL_FAILURE_RETRYABLE = 'urn:dkg:publisher:failureRetryable';
export const CONTROL_FAILURE_RESOLUTION = 'urn:dkg:publisher:failureResolution';
export const CONTROL_ERROR_PAYLOAD_REF = 'urn:dkg:publisher:errorPayloadRef';
export const CONTROL_STACK_TRACE_REF = 'urn:dkg:publisher:stackTraceRef';
export const CONTROL_RPC_RESPONSE_REF = 'urn:dkg:publisher:rpcResponseRef';
export const CONTROL_REVERT_REASON_REF = 'urn:dkg:publisher:revertReasonRef';
export const CONTROL_FAILURE_MESSAGE = 'urn:dkg:publisher:failureMessage';
export const CONTROL_RECOVERY_ACTION = 'urn:dkg:publisher:recoveryAction';
export const CONTROL_RECOVERED_FROM_STATUS = 'urn:dkg:publisher:recoveredFromStatus';
export const CONTROL_TX_HASH_CHECKED = 'urn:dkg:publisher:txHashChecked';
export const CONTROL_TIMEOUT_MS = 'urn:dkg:publisher:timeoutMs';
export const CONTROL_TIMEOUT_AT = 'urn:dkg:publisher:timeoutAt';
export const CONTROL_TIMEOUT_HANDLING = 'urn:dkg:publisher:timeoutHandling';
export const CONTROL_JOB_REF = 'urn:dkg:publisher:jobRef';
export const CONTROL_WALLET_LOCK_REF = 'urn:dkg:publisher:walletLockRef';
export const CONTROL_LOCKED_JOB = 'urn:dkg:publisher:lockedJob';
export const CONTROL_LOCK_STATUS = 'urn:dkg:publisher:lockStatus';
export const CONTROL_LOCK_ACQUIRED_AT = 'urn:dkg:publisher:lockAcquiredAt';
export const CONTROL_LOCK_EXPIRES_AT = 'urn:dkg:publisher:lockExpiresAt';
export const CONTROL_LOCK_LAST_HEARTBEAT_AT = 'urn:dkg:publisher:lockLastHeartbeatAt';

export interface WalletLockRecord {
  readonly walletId: string;
  readonly jobId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly status: 'active' | 'expired' | 'released';
  readonly claimToken?: string;
  readonly lastHeartbeatAt?: number;
}

export function jobSubject(jobId: string): string {
  return `urn:dkg:publisher:lift-job:${jobId}`;
}

export function requestSubject(jobId: string): string {
  return `urn:dkg:publisher:lift-request:${jobId}`;
}

export function walletLockSubject(walletId: string): string {
  return `urn:dkg:publisher:wallet-lock:${walletId}`;
}

export function serializeWalletLock(lock: WalletLockRecord, graphUri: string): Quad[] {
  const subject = walletLockSubject(lock.walletId);
  return [
    quad(subject, RDF_TYPE_PREDICATE, iri(CONTROL_WALLET_LOCK_TYPE), graphUri),
    quad(subject, CONTROL_WALLET_ID, literal(lock.walletId), graphUri),
    quad(subject, CONTROL_LOCKED_JOB, iri(jobSubject(lock.jobId)), graphUri),
    quad(subject, CONTROL_LOCK_STATUS, literal(lock.status), graphUri),
    quad(subject, CONTROL_LOCK_ACQUIRED_AT, integer(lock.acquiredAt), graphUri),
    quad(subject, CONTROL_LOCK_EXPIRES_AT, integer(lock.expiresAt), graphUri),
    ...(lock.claimToken ? [quad(subject, CONTROL_CLAIM_TOKEN, literal(lock.claimToken), graphUri)] : []),
    ...(lock.lastHeartbeatAt !== undefined
      ? [quad(subject, CONTROL_LOCK_LAST_HEARTBEAT_AT, integer(lock.lastHeartbeatAt), graphUri)]
      : []),
  ];
}

export function serializeJob(job: LiftJob, graphUri: string): Quad[] {
  const jobRef = jobSubject(job.jobId);
  const requestRef = requestSubject(job.jobId);
  const quads: Quad[] = [
    quad(jobRef, RDF_TYPE_PREDICATE, iri(CONTROL_JOB_TYPE), graphUri),
    quad(jobRef, CONTROL_HAS_REQUEST, iri(requestRef), graphUri),
    quad(jobRef, CONTROL_STATUS, literal(job.status), graphUri),
    quad(jobRef, CONTROL_JOB_SLUG, literal(job.jobSlug), graphUri),
    quad(jobRef, CONTROL_PAYLOAD, literal(JSON.stringify(job)), graphUri),
    quad(jobRef, CONTROL_ACCEPTED_AT, integer(job.timestamps.acceptedAt), graphUri),
    quad(jobRef, CONTROL_UPDATED_AT, integer(job.timestamps.updatedAt), graphUri),
    quad(jobRef, CONTROL_RETRY_COUNT, integer(job.retries.retryCount), graphUri),
    quad(jobRef, CONTROL_MAX_RETRIES, integer(job.retries.maxRetries), graphUri),
  ];

  quads.push(...serializeRequest(job.request, requestRef, graphUri));
  pushOptional(quads, jobRef, CONTROL_CLAIMED_AT, job.timestamps.claimedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_VALIDATED_AT, job.timestamps.validatedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_BROADCAST_AT, job.timestamps.broadcastAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_INCLUDED_AT, job.timestamps.includedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_FINALIZED_AT, job.timestamps.finalizedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_FAILED_AT, job.timestamps.failedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_LAST_RETRIED_AT, job.timestamps.lastRetriedAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_NEXT_RETRY_AT, job.timestamps.nextRetryAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_LAST_RECOVERED_AT, job.timestamps.lastRecoveredAt, graphUri, integer);
  pushOptional(quads, jobRef, CONTROL_LAST_RETRY_REASON, job.retries.lastRetryReason, graphUri, literal);
  pushOptional(quads, jobRef, CONTROL_JOB_REF, job.controlPlane?.jobRef, graphUri, iri);
  pushOptional(quads, jobRef, CONTROL_WALLET_LOCK_REF, job.controlPlane?.walletLockRef, graphUri, iri);

  if ('claim' in job && job.claim) {
    quads.push(quad(jobRef, CONTROL_WALLET_ID, literal(job.claim.walletId), graphUri));
    pushOptional(quads, jobRef, CONTROL_CLAIMED_BY, job.claim.claimedBy, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_CLAIM_TOKEN, job.claim.claimToken, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_CLAIM_LEASE_EXPIRES_AT, job.claim.claimLeaseExpiresAt, graphUri, integer);
  }

  if ('validation' in job && job.validation) {
    pushOptional(quads, jobRef, CONTROL_PRIOR_VERSION, job.validation.priorVersion, graphUri, literal);
    quads.push(quad(jobRef, CONTROL_AUTHORITY_PROOF_REF, literal(job.validation.authorityProofRef), graphUri));
  }

  if ('broadcast' in job && job.broadcast) {
    quads.push(quad(jobRef, CONTROL_TX_HASH, literal(job.broadcast.txHash), graphUri));
    quads.push(quad(jobRef, CONTROL_WALLET_ID, literal(job.broadcast.walletId), graphUri));
    pushOptional(quads, jobRef, CONTROL_MERKLE_ROOT, job.broadcast.merkleRoot, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_PUBLIC_BYTE_SIZE, job.broadcast.publicByteSize, graphUri, integer);
  }

  if ('inclusion' in job && job.inclusion) {
    quads.push(quad(jobRef, CONTROL_BLOCK_NUMBER, integer(job.inclusion.blockNumber), graphUri));
    pushOptional(quads, jobRef, CONTROL_BLOCK_HASH, job.inclusion.blockHash, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_BLOCK_TIMESTAMP, job.inclusion.blockTimestamp, graphUri, integer);
  }

  if ('finalization' in job && job.finalization) {
    pushOptional(quads, jobRef, CONTROL_FINALIZATION_MODE, job.finalization.mode, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_UAL, job.finalization.ual, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_BATCH_ID, job.finalization.batchId, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_START_KA_ID, job.finalization.startKAId, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_END_KA_ID, job.finalization.endKAId, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_PUBLISHER_ADDRESS, job.finalization.publisherAddress, graphUri, literal);
  }

  if ('failure' in job && job.failure) {
    quads.push(quad(jobRef, CONTROL_FAILURE_CODE, literal(job.failure.code), graphUri));
    quads.push(quad(jobRef, CONTROL_FAILURE_PHASE, literal(job.failure.phase), graphUri));
    quads.push(quad(jobRef, CONTROL_FAILURE_MODE, literal(job.failure.mode), graphUri));
    quads.push(quad(jobRef, CONTROL_FAILURE_RETRYABLE, boolean(job.failure.retryable), graphUri));
    quads.push(quad(jobRef, CONTROL_FAILURE_RESOLUTION, literal(job.failure.resolution), graphUri));
    quads.push(quad(jobRef, CONTROL_FAILURE_MESSAGE, literal(job.failure.message), graphUri));
    quads.push(quad(jobRef, CONTROL_ERROR_PAYLOAD_REF, literal(job.failure.errorPayloadRef), graphUri));
    pushOptional(quads, jobRef, CONTROL_STACK_TRACE_REF, job.failure.stackTraceRef, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_RPC_RESPONSE_REF, job.failure.rpcResponseRef, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_REVERT_REASON_REF, job.failure.revertReasonRef, graphUri, literal);
    pushOptional(quads, jobRef, CONTROL_TIMEOUT_MS, job.failure.timeout?.timeoutMs, graphUri, integer);
    pushOptional(quads, jobRef, CONTROL_TIMEOUT_AT, job.failure.timeout?.timeoutAt, graphUri, integer);
    pushOptional(quads, jobRef, CONTROL_TIMEOUT_HANDLING, job.failure.timeout?.handling, graphUri, literal);
  }

  if (job.recovery) {
    quads.push(quad(jobRef, CONTROL_RECOVERY_ACTION, literal(job.recovery.action), graphUri));
    quads.push(quad(jobRef, CONTROL_RECOVERED_FROM_STATUS, literal(job.recovery.recoveredFromStatus), graphUri));
    pushOptional(quads, jobRef, CONTROL_TX_HASH_CHECKED, job.recovery.txHashChecked, graphUri, literal);
  }

  // #1828 — materialize the ephemeral recovery index on the job subject.
  quads.push(...serializeVmPublishIntentIndex(job, graphUri));

  return quads;
}

/** Canonical agent lane for a VM-publish lifecycle subject (case-insensitive, trimmed). */
function agentAddressScopeKey(agentAddress?: string): string {
  return agentAddress?.trim().toLowerCase() ?? '';
}

/**
 * #1828 — the lifecycle subject a VM-publish job dedups on
 * (contextGraphId, name, subGraphName, agent lane), joined by U+001F (a control
 * char absent from every component) into one literal for indexed equality
 * lookup, mirroring the promote queue's uniquenessKey. MUST stay identical to
 * findActiveKnowledgeAssetVmPublishJob's tuple — both derive it from here.
 */
export function knowledgeAssetVmPublishLifecycleKey(publish: {
  contextGraphId: string;
  name: string;
  subGraphName?: string;
  agentAddress?: string;
}): string {
  const separator = String.fromCharCode(0x1f);
  const components = [
    publish.contextGraphId,
    publish.name,
    publish.subGraphName ?? '',
    agentAddressScopeKey(publish.agentAddress),
  ];
  // The components are joined with U+001F, so a component that itself contains the
  // delimiter would shift the boundaries and collide two distinct intents onto one
  // lifecycle subject. The recovery route rejects control chars, but the admission
  // validators (validateAssertionName/validateSubGraphName) do NOT exclude U+001F —
  // so fail closed HERE, the single point every path (admission dedup, index, and
  // lookup) funnels through, rather than silently alias. #1828 review.
  if (components.some((component) => component.includes(separator))) {
    throw new Error(
      'knowledgeAssetVmPublishLifecycleKey: components must not contain the U+001F delimiter',
    );
  }
  return components.join(separator);
}

/**
 * #1828 — the ephemeral lifecycle-key index triple on the job subject, for
 * VM-publish jobs only. Single source used by both serializeJob and the boot
 * backfill so the index is built identically everywhere. Intent exactness is
 * derived from the parsed payload at lookup time (no separate intentKey triple).
 */
export function serializeVmPublishIntentIndex(job: LiftJob, graphUri: string): Quad[] {
  if (job.request.jobType !== 'knowledge-asset-vm-publish') return [];
  const jobRef = jobSubject(job.jobId);
  const publish = job.request.knowledgeAssetVmPublish;
  let lifecycleKey: string;
  try {
    lifecycleKey = knowledgeAssetVmPublishLifecycleKey(publish);
  } catch {
    // A malformed legacy job (a component carrying the U+001F delimiter, admitted
    // before the key guard existed) is left un-indexed rather than throwing — never
    // let one bad persisted job abort a writeJob or the whole boot backfill. New
    // writes are still rejected upstream (the incoming key is built fail-closed).
    return [];
  }
  return [
    quad(jobRef, CONTROL_LIFECYCLE_KEY, literal(lifecycleKey), graphUri),
  ];
}

export function serializeRequest(request: LiftJobRequest, subject: string, graphUri: string): Quad[] {
  if (request.jobType === 'knowledge-asset-vm-publish') {
    const publish = request.knowledgeAssetVmPublish;
    const quads: Quad[] = [
      quad(subject, RDF_TYPE_PREDICATE, iri(CONTROL_REQUEST_TYPE), graphUri),
      quad(subject, CONTROL_CONTEXT_GRAPH_ID, literal(publish.contextGraphId), graphUri),
      quad(subject, CONTROL_SHARE_OPERATION_ID, literal(publish.shareOperationId), graphUri),
    ];

    for (const root of publish.roots) {
      quads.push(quad(subject, CONTROL_ROOT, literal(root), graphUri));
    }

    pushOptional(quads, subject, CONTROL_SUB_GRAPH_NAME, publish.subGraphName, graphUri, literal);
    return quads;
  }

  const lift = request.lift;
  const quads: Quad[] = [
    quad(subject, RDF_TYPE_PREDICATE, iri(CONTROL_REQUEST_TYPE), graphUri),
    quad(subject, CONTROL_CONTEXT_GRAPH_ID, literal(lift.contextGraphId), graphUri),
    quad(subject, CONTROL_SCOPE, literal(lift.scope), graphUri),
    quad(subject, CONTROL_NAMESPACE, literal(lift.namespace), graphUri),
    quad(subject, CONTROL_TRANSITION_TYPE, literal(lift.transitionType), graphUri),
    quad(subject, CONTROL_SHARE_OPERATION_ID, literal(lift.shareOperationId), graphUri),
    quad(subject, CONTROL_AUTHORITY_TYPE, literal(lift.authority.type), graphUri),
    quad(subject, CONTROL_AUTHORITY_PROOF_REF, literal(lift.authority.proofRef), graphUri),
  ];

  quads.push(quad(subject, CONTROL_SWM_ID, literal(lift.swmId), graphUri));

  for (const root of lift.roots) {
    quads.push(quad(subject, CONTROL_ROOT, literal(root), graphUri));
  }

  pushOptional(quads, subject, CONTROL_PRIOR_VERSION, lift.priorVersion, graphUri, literal);
  pushOptional(quads, subject, CONTROL_SUB_GRAPH_NAME, lift.subGraphName, graphUri, literal);
  return quads;
}

export function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

export function iri(value: string): string {
  return `<${value}>`;
}

export function literal(value: string): string {
  return JSON.stringify(value);
}

export function parseLiteral(value: string): unknown {
  return JSON.parse(value);
}

export function parseIntegerLiteral(value: string): number {
  const match = value.match(/^"(-?\d+)"(?:\^\^<[^>]+>)?$/);
  if (!match) {
    throw new Error(`Invalid integer literal: ${value}`);
  }
  return Number.parseInt(match[1] as string, 10);
}

export function createJobSlug(request: LiftJobRequest): string {
  if (request.jobType === 'knowledge-asset-vm-publish') {
    const publish = request.knowledgeAssetVmPublish;
    const contextGraph = slugPart(publish.contextGraphId);
    const name = slugPart(publish.name);
    const operation = slugPart(publish.shareOperationId);
    const rootRange = createRootRangeSlug(publish.roots);
    return [contextGraph, 'knowledge-assets', name, 'vm-publish', operation, rootRange].filter(Boolean).join('/');
  }

  const lift = request.lift;
  const contextGraph = slugPart(lift.contextGraphId);
  const scope = slugPart(lift.scope);
  const transition = lift.transitionType.toLowerCase();
  const operation = slugPart(lift.shareOperationId);
  const rootRange = createRootRangeSlug(lift.roots);
  return [contextGraph, scope, transition, operation, rootRange].filter(Boolean).join('/');
}

function createRootRangeSlug(roots: readonly string[]): string {
  if (roots.length === 0) return 'no-roots';

  const normalized = [...roots].map(rootTail).filter(Boolean).sort();
  if (normalized.length === 0) return 'no-roots';
  if (normalized.length === 1) return normalized[0] as string;
  if (normalized.length === 2) return `${normalized[0]}-${normalized[1]}`;
  return `${normalized[0]}-${normalized[normalized.length - 1]}-plus-${normalized.length - 2}`;
}

function rootTail(value: string): string {
  const trimmed = value.trim();
  const slashIndex = trimmed.lastIndexOf('/');
  const colonIndex = trimmed.lastIndexOf(':');
  const cutIndex = Math.max(slashIndex, colonIndex);
  return slugPart(cutIndex >= 0 ? trimmed.slice(cutIndex + 1) : trimmed);
}

function slugPart(value: string): string {
  // Slugs are operator-facing labels, so normalize aggressively for stable,
  // shell-friendly output without affecting canonical identifiers elsewhere.
  let normalized = '';
  let previousWasDash = false;
  for (const ch of value.trim().toLowerCase()) {
    const code = ch.charCodeAt(0);
    const isAsciiAlnum =
      (code >= 48 && code <= 57)
      || (code >= 97 && code <= 122);
    if (isAsciiAlnum) {
      normalized += ch;
      previousWasDash = false;
    } else if (!previousWasDash && normalized.length > 0) {
      normalized += '-';
      previousWasDash = true;
    }
  }
  if (previousWasDash) normalized = normalized.slice(0, -1);
  return normalized || 'unknown';
}

export function integer(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

export function boolean(value: boolean): string {
  return `"${value}"^^<${XSD_BOOLEAN}>`;
}

function pushOptional<T>(
  quads: Quad[],
  subject: string,
  predicate: string,
  value: T | undefined,
  graph: string,
  formatter: (value: T) => string,
): void {
  if (value === undefined) return;
  quads.push(quad(subject, predicate, formatter(value), graph));
}
