/**
 * Populations and independent oracles for the share queue's paged and aggregate reads (OT-RFC-73 P8a), shared by the in-memory
 * suite (async-promote-listing-paging.test.ts) and the live Blazegraph one. Nothing here calls the code under test.
 */
import { expect } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { TripleStoreAsyncPromoteQueue } from '../../src/async-promote-queue-impl.js';
import { PROMOTE_JOB_STATES, type PromoteJob, type PromoteJobPage, type PromoteJobState, type PromoteListFilter } from '../../src/async-promote-queue-types.js';
import {
  DEFAULT_PROMOTE_CONTROL_GRAPH_URI, PROMOTE_UNIQUENESS_KEY, comparePromoteJobs, jobSubject, legacyUniquenessKey, uniquenessKey,
} from '../../src/async-promote-queue-utils.js';
import { isAutomaticallyRecoverablePostCommitFailure } from '../../src/async-promote-recovery-policy.js';
import { PROMOTE_POST_COMMIT_FAILURE_MESSAGE } from '../../src/promote-replay-safety.js';
import { ROW_AGENT, ROW_NOW as NOW, randomJobId, shareRow, type ShareRowSpec } from './share-job-rows.js';

export const STATES = PROMOTE_JOB_STATES as readonly PromoteJobState[];

/** Walk the keyset listing to its end; `between` runs after each page that is not the last (the mutex is free then). */
export async function walkPages(
  queue: TripleStoreAsyncPromoteQueue, filter: Omit<PromoteListFilter, 'limit'>, pageSize: number,
  between?: (page: PromoteJobPage, index: number) => Promise<void>,
): Promise<PromoteJobPage[]> {
  const pages: PromoteJobPage[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await queue.listPage(filter, { pageSize, ...(cursor ? { cursor } : {}) });
    pages.push(page);
    if (page.complete) return pages;
    expect(page.nextCursor).toEqual(expect.any(String));
    cursor = page.nextCursor;
    if (pages.length > 5_000) throw new Error('the walk did not end');
    await between?.(page, pages.length - 1);
  }
}

/** `count` jobs of random state with unique mixed-case ids; timestamps tie in groups of `tieGroup`. */
export function population(count: number, rand: () => number, over: { tieGroup?: number; contexts?: readonly string[] } = {}): ShareRowSpec[] {
  const used = new Set<string>();
  const specs: ShareRowSpec[] = [];
  for (let i = 0; i < count; i++) {
    let id = randomJobId(rand);
    while (used.has(id)) id = randomJobId(rand);
    used.add(id);
    specs.push({
      id, state: STATES[Math.floor(rand() * STATES.length)]!, enqueuedAt: NOW + Math.floor(i / (over.tieGroup ?? 5)),
      contextGraphId: over.contexts ? over.contexts[Math.floor(rand() * over.contexts.length)]! : 'cg-rows',
    });
  }
  return specs;
}

// ---- the post-commit sweep

export const POST_COMMIT_ERRORS = (() => {
  const code = { message: 'step failed', retryable: false, classification: 'fatal' as const, recordedAt: NOW, diagnosticCode: 'PROMOTE_POST_COMMIT_FAILURE' };
  const legacy = { message: PROMOTE_POST_COMMIT_FAILURE_MESSAGE, retryable: false, classification: 'fatal' as const, recordedAt: NOW };
  const lookalike = { ...legacy, message: `${PROMOTE_POST_COMMIT_FAILURE_MESSAGE} (mirrored by a caller)` };
  const other = { message: 'assertion not found', retryable: false, classification: 'fatal' as const, recordedAt: NOW };
  const otherCode = { ...code, diagnosticCode: 'PROMOTE_RETRYABLE_FAILURE' };
  return { code, legacy, lookalike, other, otherCode, all: [code, legacy, lookalike, other, otherCode, undefined] as const };
})();

/**
 * Recoverable post-commit failures (retry budget left) that all carry one enqueue time, in groups of `group` that share one assertion.
 * The ids are mixed-case, where code point order and `localeCompare` disagree, so of each group the job recovery requeues is the one
 * the queue's own order ranks first and the rest are deferred behind it: the order the sweep decides in is the outcome.
 */
export function tiedContenders(rand: () => number, count: number, over: { enqueuedAt?: number; group?: number; prefix?: string } = {}): ShareRowSpec[] {
  const group = over.group ?? 3, prefix = over.prefix ?? 'tie';
  return Array.from({ length: count }, (_, k): ShareRowSpec => ({
    id: `${randomJobId(rand, 6)}-${prefix}${k}`, state: 'failed', enqueuedAt: over.enqueuedAt ?? NOW + 1, name: `${prefix}-asset-${Math.floor(k / group)}`,
    lastError: POST_COMMIT_ERRORS.code, attemptCount: 1, maxRetries: 3,
  }));
}

/**
 * Failed jobs with every kind of last error, reason, marker, format and budget, plus four owners that hold some of their assertions,
 * and twelve recoverable contenders (four assertions, three jobs each) that tie on one enqueue time in the middle of the range.
 */
export function failedPopulation(rand: () => number, count: number): ShareRowSpec[] {
  const specs: ShareRowSpec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      id: `${randomJobId(rand, 8)}-${i}`, state: 'failed', enqueuedAt: NOW + i * 10,
      name: rand() < 0.25 ? `shared-${Math.floor(rand() * 4)}` : `asset-${i}`,
      lastError: POST_COMMIT_ERRORS.all[Math.floor(rand() * POST_COMMIT_ERRORS.all.length)],
      attemptCount: 1 + Math.floor(rand() * 3), maxRetries: 3,
      ...(rand() < 0.15 ? { reason: 'cancelled' } : {}),
      ...(rand() < 0.1 ? { swmInserted: true } : {}),
      ...(rand() < 0.15 ? { formatVersion: [1, 2, 5][Math.floor(rand() * 3)]! } : {}),
    });
  }
  for (let k = 0; k < 4; k++) {
    specs.push({ id: `owner-${k}`, state: (['queued', 'running', 'failed_retrying', 'succeeded'] as const)[k]!, enqueuedAt: NOW + 5 + k * 17, name: `shared-${k}` });
  }
  specs.push(...tiedContenders(rand, 12, { enqueuedAt: NOW + Math.floor(count / 2) * 10 + 3 }));
  return specs;
}

/**
 * The sweep as it was before P8a: every failed job in queue order, each judged by the recovery policy, a conflict being an active job
 * of the same assertion (a row the sweep requeued counts from then on). The queue's backoff is 1,000 ms.
 */
export function expectedSweep(specs: readonly ShareRowSpec[], now: number) {
  const events: Array<Record<string, unknown>> = [];
  const active = new Set(specs.filter((spec) => ['queued', 'running', 'failed_retrying'].includes(spec.state)).map((spec) => spec.name ?? spec.id));
  const finals = new Map<string, PromoteJob>(specs.map((spec) => [spec.id, shareRow(spec)]));
  const failed = specs.filter((spec) => spec.state === 'failed').map(shareRow).sort(comparePromoteJobs);
  for (const job of failed) {
    if (!isAutomaticallyRecoverablePostCommitFailure(job)) continue;
    const attemptCount = Math.max(1, job.attempt.count), maxAttempts = job.attempt.maxRetries;
    if (attemptCount >= maxAttempts) {
      events.push({ jobId: job.jobId, action: 'exhausted', attempt: attemptCount, maxAttempts });
      finals.set(job.jobId, { ...job, updatedAt: now, reason: `automatic post-commit recovery exhausted after ${attemptCount} attempts; needs operator inspection` });
      continue;
    }
    if (active.has(job.request.assertionName)) continue;
    const nextRetryAt = now + 1_000;
    events.push({ jobId: job.jobId, action: 'requeued', attempt: attemptCount, maxAttempts, nextRetryAt });
    active.add(job.request.assertionName);
    finals.set(job.jobId, { ...job, state: 'failed_retrying', updatedAt: now, lease: undefined,
      attempt: { count: attemptCount, maxRetries: maxAttempts, nextRetryAt, lastError: job.attempt.lastError ? { ...job.attempt.lastError, retryable: true } : undefined } });
  }
  return { events, finals };
}

// ---- the key-scoped lookup

export const LANES = [
  ROW_AGENT, '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', '0xabcdef0123456789abcdef0123456789abcdef01',
  '0x2222222222222222222222222222222222222222', '12D3KooWPeerLaneWithUpperCaseLetters',
];
export type Spelling = 'current' | 'precanonical' | 'default-lane' | 'legacy';
export const SPELLINGS: readonly Spelling[] = ['current', 'current', 'precanonical', 'default-lane', 'legacy'];

/** Ninety jobs over two assertions, five lanes (one in two letter cases), an optional sub-graph and two context graphs. */
export function selectorPopulation(rand: () => number): ShareRowSpec[] {
  return Array.from({ length: 90 }, (_, i): ShareRowSpec => ({
    id: `${randomJobId(rand, 6)}-${i}`, state: STATES[Math.floor(rand() * STATES.length)]!, enqueuedAt: NOW + Math.floor(i / 3),
    name: ['alpha', 'beta'][Math.floor(rand() * 2)]!, agentAddress: LANES[Math.floor(rand() * LANES.length)]!,
    ...(rand() < 0.3 ? { subGraphName: 'sg' } : {}), contextGraphId: rand() < 0.8 ? 'cg-rows' : 'cg-other',
  }));
}

/** Rewrite the stored uniqueness key of a row to the spelling an older version wrote; returns the key now stored. */
export async function respell(store: TripleStore, spec: ShareRowSpec, spelling: Spelling, graph = DEFAULT_PROMOTE_CONTROL_GRAPH_URI): Promise<string> {
  const job = shareRow(spec);
  const legacyKey = legacyUniquenessKey(job.request);
  const key = {
    current: uniquenessKey(job.request),
    precanonical: `${legacyKey}\u001f${job.request.agentAddress?.trim().toLowerCase() ?? ''}`,
    'default-lane': `${legacyKey}\u001f`,
    legacy: legacyKey,
  }[spelling];
  if (spelling !== 'current') {
    await store.deleteByPattern({ subject: jobSubject(spec.id), predicate: PROMOTE_UNIQUENESS_KEY, graph });
    await store.insert([{ subject: jobSubject(spec.id), predicate: PROMOTE_UNIQUENESS_KEY, object: JSON.stringify(key), graph }]);
  }
  return key;
}
