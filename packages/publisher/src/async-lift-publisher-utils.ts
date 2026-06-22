import type { QueryResult } from '@origintrail-official/dkg-storage';
import type {
  KnowledgeAssetVmPublishRequest,
  LiftJob,
  LiftJobHex,
  LiftRequest,
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

export function createKnowledgeAssetVmPublishLiftRequest(
  request: KnowledgeAssetVmPublishRequest,
): LiftRequest {
  const subGraphPart = request.subGraphName ? `:${request.subGraphName}` : '';
  const operationKey = `${request.contextGraphId}:${request.name}${subGraphPart}:${request.shareOperationId}`;
  return {
    jobType: 'knowledge-asset-vm-publish',
    knowledgeAssetVmPublish: request,
    swmId: request.shareOperationId,
    shareOperationId: request.shareOperationId,
    roots: request.roots,
    contextGraphId: request.contextGraphId,
    namespace: 'knowledge-assets',
    scope: 'vm-publish',
    transitionType: 'CREATE',
    authority: {
      type: 'owner',
      proofRef: `urn:dkg:knowledge-assets:${operationKey}:vm-publish`,
    },
    ...(request.subGraphName ? { subGraphName: request.subGraphName } : {}),
    ...(request.publishEpochs !== undefined ? { publishEpochs: request.publishEpochs } : {}),
    ...(request.publisherNodeIdentityIdOverride !== undefined
      ? { publisherNodeIdentityIdOverride: request.publisherNodeIdentityIdOverride }
      : {}),
    seal: request.seal,
  };
}
