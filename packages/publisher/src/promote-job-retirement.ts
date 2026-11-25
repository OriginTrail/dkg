// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import { asGraphWriteRevisionSource, controlStoreOptions, supportsAtomicSparqlModify, tryUpdateWithTouchedGraphs, type TripleStore } from '@origintrail-official/dkg-storage';
import { isBoundPromoteJob } from './bound-promote-job.js';
import { expectBindings, jobSubject, literal, isPromotePostCommitAttemptError, parseJobPayload, PROMOTE_PAYLOAD, serializeJobRecord } from './async-promote-queue-utils.js';
import { isSafeJobId } from './job-id.js';
import type { BoundPromoteJob } from './async-promote-queue-types.js';

const ARCHIVED = 'urn:dkg:promote-queue:abandoned:originalFailedPayload';
const DECISION = 'urn:dkg:promote-queue:abandoned:decision';
const ABANDONED = 'operator_abandoned_unknown_effects';
const options = controlStoreOptions('share', 'publisher.asyncPromote.retirement');

export interface PromoteRetirementApproval {
  expectedJobSha256: string;
  acceptUnknownEffects: true;
}

interface PromoteRetirementIdentity {
  jobId: string;
  jobSha256: string;
  contextGraphId: string;
  assertionName: string;
  agentAddress: string;
  sealDigest: string;
  operationId: string;
  attemptCount: number;
  commitMarker: NonNullable<BoundPromoteJob['commitMarker']>;
  effects: 'unknown';
}

export type PromoteRetirementResult =
  | { outcome: 'not_found' | 'ineligible' | 'stale' | 'unsupported' }
  | (PromoteRetirementIdentity & { outcome: 'eligible' })
  | (PromoteRetirementIdentity & { outcome: 'observed' | 'retired'; retiredAt: number });

export interface PromoteJobRetirer {
  retireFailedJob(jobId: string, approval?: PromoteRetirementApproval): Promise<PromoteRetirementResult>;
}

export function isPromoteRetirementApproval(value: unknown): value is PromoteRetirementApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).length === 2 && body.acceptUnknownEffects === true
    && typeof body.expectedJobSha256 === 'string' && /^[0-9a-f]{64}$/.test(body.expectedJobSha256);
}

function sourceJob(payload: string | undefined, jobId: string) {
  const job = parseJobPayload(payload);
  if (!payload || !job || job.jobId !== jobId || !isBoundPromoteJob(job) || job.state !== 'failed'
    || job.attempt.lastError?.classification !== 'fatal' || job.attempt.lastError.retryable !== false
    || typeof job.attempt.lastError.message !== 'string' || !Number.isSafeInteger(job.attempt.lastError.recordedAt)
    || job.attempt.lastError.noEffectProof !== undefined || isPromotePostCommitAttemptError(job.attempt.lastError)
    || job.lease !== undefined || job.result !== undefined || job.attempt.nextRetryAt !== undefined
    || !Number.isSafeInteger(job.attempt.count) || job.attempt.count < 1
    || !job.commitMarker || typeof job.commitMarker.promoteStarted !== 'boolean') return;
  const raw: unknown = JSON.parse(payload);
  if (typeof raw !== 'string') return;
  return { job, raw, digest: createHash('sha256').update(raw).digest('hex') };
}

/**
 * The caller holds the queue mutation lock. The archive retains the original payload RDF term and
 * the decision; the canonical lookup indexes are removed. The backend rechecks the indexed record in the
 * same DELETE/INSERT that archives it. No fallback splits these operations or replays a share.
 */
export async function retireFailedPromote(store: TripleStore, graph: string, jobId: string, now: () => number,
  approval?: PromoteRetirementApproval): Promise<PromoteRetirementResult> {
  if (!isSafeJobId(jobId) || (approval !== undefined && !isPromoteRetirementApproval(approval))) return { outcome: 'ineligible' };
  const g = `<${assertSafeIri(graph)}>`, active = jobSubject(jobId), receipt = 'urn:dkg:promote-queue:abandoned-job:' + jobId;
  const archiveGraph = graph + ':retirements';
  const archive = `<${assertSafeIri(archiveGraph)}>`;
  const rows = expectBindings(await store.query(`SELECT ?s ?p ?o WHERE {
    { GRAPH ${g} { <${active}> ?p ?o } BIND(<${active}> AS ?s) }
    UNION { GRAPH ${archive} { <${receipt}> ?p ?o } BIND(<${receipt}> AS ?s) }
  } LIMIT 20`, options));
  if (!rows.length) return { outcome: 'not_found' };
  const archived = rows.some(r => r.s === receipt);
  const source = sourceJob(rows.find(r => r.p === (archived ? ARCHIVED : PROMOTE_PAYLOAD))?.o, jobId);
  if (!source) return { outcome: 'ineligible' };
  const { job, raw, digest } = source;
  const info = { jobId, jobSha256: digest, contextGraphId: job.request.contextGraphId, assertionName: job.request.assertionName,
    agentAddress: job.request.agentAddress, sealDigest: job.request.recoveryBinding.sealDigest,
    operationId: job.request.recoveryBinding.intent.operationId, attemptCount: job.attempt.count,
    commitMarker: job.commitMarker!, effects: 'unknown' as const };
  if (archived) {
    const decision = rows.find(r => r.p === DECISION)?.o;
    if (rows.length !== 2 || rows.some(r => r.s !== receipt) || !decision) return { outcome: 'ineligible' };
    let saved;
    try { saved = JSON.parse(JSON.parse(decision)); } catch { return { outcome: 'ineligible' }; }
    if (saved?.disposition !== ABANDONED || saved.jobSha256 !== digest || !Number.isSafeInteger(saved.retiredAt) || saved.retiredAt < 0) return { outcome: 'ineligible' };
    if (approval && approval.expectedJobSha256 !== digest) return { outcome: 'stale' };
    if (!approval) return { outcome: 'observed', ...info, retiredAt: saved.retiredAt };
    if (!supportsAtomicSparqlModify(store)) return { outcome: 'unsupported' };
    await store.flush?.();
    return { outcome: 'retired', ...info, retiredAt: saved.retiredAt };
  }
  const expected = serializeJobRecord(job, graph).jobQuads.map(q => ({
    p: q.predicate, o: q.predicate === PROMOTE_PAYLOAD ? literal(raw) : q.object,
  }));
  // Bind every canonical term, then require the exact cardinality. A duplicate payload, changed
  // index or unknown extra predicate must not be silently discarded. Numeric RDF terms stay typed.
  const patterns = expected.map(({ p, o }) => `<${active}> <${p}> ${o} .`).join('\n');
  const matching = `GRAPH ${g} { ${patterns} }
    { SELECT (COUNT(*) AS ?rowCount) WHERE { GRAPH ${g} { <${active}> ?index ?value } } }
    FILTER(?rowCount = ${expected.length})
    FILTER NOT EXISTS { GRAPH ${archive} { <${receipt}> ?oldP ?oldO } }`;
  if (rows.length !== expected.length || !expectBindings(await store.query(
    `SELECT (1 AS ?matched) WHERE { ${matching} }`, options)).length) return { outcome: 'ineligible' };
  if (!supportsAtomicSparqlModify(store)) return { outcome: 'unsupported' };
  if (!approval) return { outcome: 'eligible', ...info };
  if (digest !== approval.expectedJobSha256) return { outcome: 'stale' };
  if (asGraphWriteRevisionSource(store)?.getWriteRevision('').stable === false) return { outcome: 'ineligible' };
  const decision = literal(JSON.stringify({ disposition: ABANDONED, jobSha256: digest, retiredAt: now() }));
  const updated = await tryUpdateWithTouchedGraphs(store, `DELETE { GRAPH ${g} { <${active}> ?p ?o } }
    INSERT { GRAPH ${archive} { <${receipt}> <${ARCHIVED}> ?original ; <${DECISION}> ${decision} } }
    WHERE { ${matching} GRAPH ${g} { <${active}> ?p ?o ; <${PROMOTE_PAYLOAD}> ?original } }`,
    [graph, archiveGraph], { ...options, writtenGraphs: [graph, archiveGraph] });
  if (!updated) return { outcome: 'unsupported' };
  await store.flush?.();
  // Observation only, including after a guarded no-op. An uncertain write is never reissued here.
  const observed = await retireFailedPromote(store, graph, jobId, now);
  return observed.outcome === 'observed' && observed.jobSha256 === digest
    ? { ...observed, outcome: 'retired' } : { outcome: 'stale' };
}
