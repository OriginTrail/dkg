import type { QueryResult } from '@origintrail-official/dkg-storage';
import type {
  KnowledgeAssetVmPublishJobRequest,
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobHex,
  LiftJobRequest,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  RawLiftJobRequest,
  RawLiftRequest,
} from './lift-job.js';
export {
  CONTROL_CLAIM_TOKEN,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  DEFAULT_CONTROL_GRAPH_URI as DEFAULT_GRAPH_URI,
  CONTROL_PAYLOAD as PAYLOAD_PREDICATE,
  CONTROL_STATUS as STATUS_PREDICATE,
  createJobSlug,
  jobSubject,
  parseIntegerLiteral,
  serializeJob,
  serializeWalletLock,
  literal,
  parseLiteral,
  requestSubject,
  walletLockSubject,
} from './async-lift-control-plane.js';

export type PersistedFailedJob = Extract<LiftJob, { status: 'failed' }>;

export function expectBindings(result: QueryResult): Array<Record<string, string>> {
  if (result.type !== 'bindings') {
    throw new Error(`Expected SPARQL bindings result, got ${result.type}`);
  }
  return result.bindings;
}

export function compareAcceptedJobs(a: LiftJob, b: LiftJob): number {
  const timeDelta = a.timestamps.acceptedAt - b.timestamps.acceptedAt;
  if (timeDelta !== 0) return timeDelta;
  return a.jobId.localeCompare(b.jobId);
}

export function getRecoveryTxHash(job: LiftJob): LiftJobHex | undefined {
  if ('broadcast' in job && job.broadcast) {
    return job.broadcast.txHash;
  }
  return undefined;
}

export function isFailedJob(job: LiftJob): job is PersistedFailedJob {
  return job.status === 'failed' && 'failure' in job;
}

export function createKnowledgeAssetVmPublishSnapshotRequest(
  request: KnowledgeAssetVmPublishRequest,
): LiftPublishSnapshotRequest {
  return {
    shareOperationId: request.shareOperationId,
    roots: request.roots,
    contextGraphId: request.contextGraphId,
    ...(request.subGraphName ? { subGraphName: request.subGraphName } : {}),
    ...(request.publishEpochs !== undefined ? { publishEpochs: request.publishEpochs } : {}),
    ...(request.publisherNodeIdentityIdOverride !== undefined
      ? { publisherNodeIdentityIdOverride: request.publisherNodeIdentityIdOverride }
      : {}),
    seal: request.seal,
  };
}

export function createKnowledgeAssetVmPublishSnapshotMetadata(
  request: KnowledgeAssetVmPublishRequest,
): LiftPublishRequestMetadata {
  const subGraphPart = request.subGraphName ? `:${request.subGraphName}` : '';
  const operationKey = `${request.contextGraphId}:${request.name}${subGraphPart}:${request.shareOperationId}`;
  return {
    scope: 'vm-publish',
    // Named-KA VM publish chooses mint/update from lifecycle state in the agent.
    // This metadata only validates the immutable share snapshot shape: no
    // priorVersion is expected for the sealed snapshot payload itself.
    transitionType: 'CREATE',
    authority: {
      type: 'owner',
      proofRef: `urn:dkg:knowledge-assets:${operationKey}:vm-publish`,
    },
  };
}

export function createRawLiftJobRequest(request: RawLiftRequest): RawLiftJobRequest {
  return {
    jobType: 'lift',
    lift: {
      ...request,
      jobType: request.jobType ?? 'lift',
    },
  };
}

export function createKnowledgeAssetVmPublishJobRequest(
  request: KnowledgeAssetVmPublishRequest,
): KnowledgeAssetVmPublishJobRequest {
  return {
    jobType: 'knowledge-asset-vm-publish',
    knowledgeAssetVmPublish: request,
  };
}

export function isKnowledgeAssetVmPublishJobRequest(
  request: unknown,
): request is KnowledgeAssetVmPublishJobRequest {
  return isRecord(request) && request.jobType === 'knowledge-asset-vm-publish' && isRecord(request.knowledgeAssetVmPublish);
}

export function isRawLiftJobRequest(request: unknown): request is RawLiftJobRequest {
  return isRecord(request) && request.jobType === 'lift' && isRecord(request.lift);
}

export function rawLiftRequestFromJobRequest(request: LiftJobRequest): RawLiftRequest | null {
  return isRawLiftJobRequest(request) ? request.lift : null;
}

export function isRawLiftRequest(request: unknown): request is RawLiftRequest {
  return isRecord(request)
    && (request.jobType === undefined || request.jobType === 'lift')
    && typeof request.swmId === 'string'
    && typeof request.shareOperationId === 'string'
    && Array.isArray(request.roots)
    && typeof request.contextGraphId === 'string'
    && typeof request.namespace === 'string'
    && typeof request.scope === 'string'
    && typeof request.transitionType === 'string'
    && isRecord(request.authority)
    && request.lift === undefined
    && request.knowledgeAssetVmPublish === undefined;
}

export function normalizePersistedLiftJobRequest(request: unknown): LiftJobRequest {
  if (isKnowledgeAssetVmPublishJobRequest(request)) {
    return request;
  }
  if (isRawLiftJobRequest(request)) {
    return createRawLiftJobRequest(request.lift);
  }
  if (isRawLiftRequest(request)) {
    return createRawLiftJobRequest(request);
  }
  throw new Error('Unrecognized persisted async lift job request payload');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
