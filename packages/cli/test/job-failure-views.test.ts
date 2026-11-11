/**
 * Job and status views carry a short failure reason (at most 512 characters, without transaction
 * payloads, long hex, URLs or request details) beside the failure's machine code. A record stored
 * before reasons were bounded is cut the same way when it is read; the worker logs the whole text.
 */
import { describe, expect, it } from 'vitest';
import type { IntentLookupResult, PersistedLiftJob, PromoteJob } from '@origintrail-official/dkg-publisher';
import { promoteJobToView } from '../src/daemon/routes/promote-job-view.js';
import { publisherIntentLookupView, publisherJobView } from '../src/daemon/routes/publisher-job-view.js';
import { promoteFailureReason } from '../src/daemon/worker/async-promote-attempt-diagnostics.js';

const PAYLOAD = `0x02f8${'cd'.repeat(400)}`;
const LONG_TEXT = `send failed at https://rpc.example/v2/SECRET-API-KEY: ${'refused; '.repeat(80)}raw ${PAYLOAD}`;

function promoteJob(message: string): PromoteJob {
  return {
    jobId: 'share-1',
    request: { contextGraphId: 'cg', assertionName: 'a', entities: 'all' },
    state: 'failed',
    enqueuedAt: 1_000,
    updatedAt: 2_000,
    attempt: { count: 1, maxRetries: 5, lastError: { message, retryable: false, classification: 'fatal', recordedAt: 2_000 } },
  };
}

function publishJob(jobId: string, failure?: { code: string; message: string }): PersistedLiftJob {
  return { jobId, status: failure ? 'failed' : 'accepted', ...(failure ? { failure } : {}) } as unknown as PersistedLiftJob;
}

function expectShortReason(message: string): void {
  expect(message.length).toBeLessThanOrEqual(512);
  expect(message.startsWith('send failed at rpc.example: refused;')).toBe(true);
  expect(message).not.toContain('SECRET-API-KEY');
  expect(message).not.toContain('cdcd');
}

describe('share job view', () => {
  it('cuts a stored long attempt error and keeps its code', () => {
    const view = promoteJobToView(promoteJob(LONG_TEXT));
    expect(view.lastError).toMatchObject({ code: 'fatal', retryable: false });
    expectShortReason(view.lastError!.message);
  });

  it('shows a short attempt error as it is', () => {
    expect(promoteJobToView(promoteJob('transient blip')).lastError!.message).toBe('transient blip');
  });
});

describe('publish job view', () => {
  it('answers a job without a long failure reason as it is stored', () => {
    const accepted = publishJob('job-1');
    const short = publishJob('job-2', { code: 'rpc_unavailable', message: 'endpoint refused' });
    expect(publisherJobView(accepted)).toBe(accepted);
    expect(publisherJobView(short)).toBe(short);
  });

  it('cuts a failure reason stored before reasons were bounded, and leaves the record alone', () => {
    const stored = publishJob('job-3', { code: 'tx_reverted', message: LONG_TEXT });
    const view = publisherJobView(stored) as unknown as { jobId: string; failure: { code: string; message: string } };
    expect(view.jobId).toBe('job-3');
    expect(view.failure.code).toBe('tx_reverted');
    expectShortReason(view.failure.message);
    expect((stored as unknown as { failure: { message: string } }).failure.message).toBe(LONG_TEXT);
  });

  it('cuts every job an intent lookup answers with', () => {
    const long = (jobId: string) => publishJob(jobId, { code: 'rpc_unavailable', message: LONG_TEXT });
    const reasons = (jobs: readonly PersistedLiftJob[]) =>
      jobs.map((job) => (job as unknown as { failure: { message: string } }).failure.message);
    const none: IntentLookupResult = { kind: 'none' };
    expect(publisherIntentLookupView(none)).toBe(none);

    const active = publisherIntentLookupView({ kind: 'active', job: long('a'), superseded: [long('b')] });
    if (active.kind !== 'active') throw new Error('expected active');
    for (const message of reasons([active.job, ...active.superseded])) expectShortReason(message);

    for (const kind of ['superseded', 'conflict'] as const) {
      const ended = publisherIntentLookupView({ kind, jobs: [long('c'), long('d')] });
      if (ended.kind !== kind || !('jobs' in ended)) throw new Error(`expected ${kind}`);
      for (const message of reasons(ended.jobs)) expectShortReason(message);
    }
  });
});

describe('promote worker failure reason', () => {
  it('logs the whole reduced text once when the reason is cut, and nothing otherwise', () => {
    const lines: string[] = [];
    const job = promoteJob('');
    expectShortReason(promoteFailureReason(job, LONG_TEXT, (line) => lines.push(line)));
    expect(lines).toHaveLength(1);
    const logged = JSON.parse(lines[0]!.replace('[async-promote-worker] ', '')) as Record<string, unknown>;
    expect(logged).toMatchObject({ event: 'async_promote_failure_detail', schemaVersion: 1, jobId: 'share-1', attempt: 1 });
    expect(logged['detail']).toMatch(/^send failed at rpc\.example: refused; .* raw \[hex, 402 bytes\]$/);

    expect(promoteFailureReason(job, 'transient blip', (line) => lines.push(line))).toBe('transient blip');
    expect(lines).toHaveLength(1);
  });
});
