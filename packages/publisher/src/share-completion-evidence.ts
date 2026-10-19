import {
  computeCanonicalGraphScopedAuthorSealDigestV1, assertCanonicalGraphScopedAuthorSealV1, canonicalGraphScopedAuthorSealFromAssertionSealV1,
  type AssertionSeal, type CanonicalGraphScopedAuthorSealV1,
} from '@origintrail-official/dkg-core';
import type { PromoteRequest, PromoteResult, PromoteJob } from './async-promote-queue-types.js';
import { normalizePromoteAgentLane } from './async-promote-queue-utils.js';

/** Produced under the publisher lifecycle lock, never accepted from a share request. */
export interface ShareCompletionEvidence {
  readonly version: 1;
  readonly contextGraphId: string;
  readonly assertionName: string;
  readonly agentAddress: string;
  readonly subGraphName?: string;
  readonly entities: 'all';
  readonly shareOperationId: string;
  readonly seal: Readonly<CanonicalGraphScopedAuthorSealV1>;
}

/** Strict versioned decoding is separate from legacy queue-job decoding. */
export function readShareCompletionEvidence(value: unknown): ShareCompletionEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid share completion evidence');
  const v = value as Record<string, unknown>;
  for (const field of ['contextGraphId', 'assertionName', 'agentAddress', 'shareOperationId']) {
    if (typeof v[field] !== 'string' || !(v[field] as string).trim() || (v[field] as string).length > 2048)
      throw new Error('Invalid share completion evidence scope');
  }
  if (v.version !== 1 || v.entities !== 'all'
    || (v.subGraphName !== undefined && (typeof v.subGraphName !== 'string' || !v.subGraphName || v.subGraphName.length > 2048))
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(v.shareOperationId as string))
    throw new Error('Unsupported share completion evidence');
  assertCanonicalGraphScopedAuthorSealV1(v.seal);
  return Object.freeze({ version: 1, contextGraphId: v.contextGraphId as string,
    assertionName: v.assertionName as string, agentAddress: normalizePromoteAgentLane(v.agentAddress as string),
    ...(v.subGraphName === undefined ? {} : { subGraphName: v.subGraphName as string }),
    entities: 'all', shareOperationId: v.shareOperationId as string, seal: Object.freeze({ ...v.seal }),
  });
}

export function createShareCompletionEvidence(
  contextGraphId: string, assertionName: string, agentAddress: string,
  subGraphName: string | undefined, seal: AssertionSeal, shareOperationId: string,
): ShareCompletionEvidence {
  return readShareCompletionEvidence({ version: 1, contextGraphId, assertionName, agentAddress,
    subGraphName, entities: 'all', shareOperationId, seal: canonicalGraphScopedAuthorSealFromAssertionSealV1(seal) });
}

export function shareEvidenceMatchesRequest(evidence: ShareCompletionEvidence, request: PromoteRequest): boolean {
  return evidence.contextGraphId === request.contextGraphId && evidence.assertionName === request.assertionName
    && evidence.subGraphName === request.subGraphName && request.entities === 'all'
    && !!request.agentAddress?.trim() && evidence.agentAddress === normalizePromoteAgentLane(request.agentAddress)
    && (!request.authorAgentAddress || evidence.seal.authorAddress === request.authorAgentAddress.toLowerCase())
    && (!request.recoveryBinding || (evidence.shareOperationId === request.recoveryBinding.intent.operationId
      && computeCanonicalGraphScopedAuthorSealDigestV1(evidence.seal) === request.recoveryBinding.sealDigest));
}

/** Pure success transition; callers must hold and validate the current lease. */
export function promoteSuccessTransition(job: PromoteJob, result: PromoteResult, now: number): PromoteJob {
  if (!job.commitMarker?.swmInserted) {
    throw new Error(`Cannot succeed job ${job.jobId}: commitMarker.swmInserted is false. Worker must record SWM commit before declaring success.`);
  }
  if (result.shareEvidence && !shareEvidenceMatchesRequest(result.shareEvidence, job.request))
    throw new Error('Share completion evidence does not match the leased request');
  return { ...job, state: 'succeeded', updatedAt: now, lease: undefined, result };
}
