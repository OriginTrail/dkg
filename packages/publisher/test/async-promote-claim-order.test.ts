/**
 * Characterization of the share queue's `claimNext` order and its read/write sequence (OT-RFC-73 P4). Tagging the queue's
 * store calls must not change which job a worker is given, in what order, or what the claim reads and writes. This file passes
 * unchanged against the code before the tagging; later share-queue changes (paging, a bounded candidate read) have to keep it.
 *
 * Order: the jobs a claim may take are the queued ones and the retrying ones whose retry time has come, sorted by ready time
 * (`attempt.nextRetryAt` when set, else `enqueuedAt`) and then by `jobId.localeCompare`; a job whose claim lane a running job
 * still holds, one written by a newer format, and any job while the queue is paused are skipped.
 */
import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncPromoteQueue } from '../src/async-promote-queue-impl.js';
import { ASYNC_PROMOTE_QUEUE_FORMAT_VERSION, type PromoteJob, type PromoteJobState } from '../src/async-promote-queue-types.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, serializeJobRecord } from '../src/async-promote-queue-utils.js';
import { recordShareStore } from './_helpers/share-control-recorder.js';

const AGENT = '0x1111111111111111111111111111111111111111';
const NOW = 1_700_000_000_000;

interface RowSpec {
  id: string;
  state: PromoteJobState;
  enqueuedAt?: number;
  nextRetryAt?: number;
  /** Assertion name; rows sharing one (and the agent lane) share a claim lane. */
  name?: string;
  formatVersion?: number;
  leaseExpiresAt?: number;
}

function row(spec: RowSpec): PromoteJob {
  return {
    jobId: spec.id,
    request: { contextGraphId: 'cg-order', assertionName: spec.name ?? spec.id, entities: 'all', agentAddress: AGENT },
    state: spec.state,
    enqueuedAt: spec.enqueuedAt ?? NOW,
    updatedAt: NOW,
    attempt: { count: spec.state === 'failed_retrying' || spec.state === 'running' ? 1 : 0, maxRetries: 3, nextRetryAt: spec.nextRetryAt },
    formatVersion: spec.formatVersion ?? ASYNC_PROMOTE_QUEUE_FORMAT_VERSION,
    ...(spec.state === 'running'
      ? { lease: { workerId: 'other', acquiredAt: NOW, expiresAt: spec.leaseExpiresAt ?? NOW + 60_000, lastHeartbeatAt: NOW, claimToken: `other:${spec.id}:t` },
        commitMarker: { promoteStarted: false, swmInserted: false, wmCleaned: false, lifecycleStamped: false, gossiped: false } }
      : {}),
  };
}

async function seeded(specs: RowSpec[], clock = NOW) {
  const inner = new OxigraphStore();
  await inner.insert(specs.flatMap((spec) => serializeJobRecord(row(spec), DEFAULT_PROMOTE_CONTROL_GRAPH_URI).jobQuads));
  const recorder = recordShareStore(inner);
  let now = clock;
  const queue = new TripleStoreAsyncPromoteQueue(recorder.store, { now: () => now, claimTokenGenerator: () => 't', backoff: () => 1_000 });
  return { queue, recorder, setNow: (value: number) => { now = value; } };
}

/** Claim until the queue has nothing eligible; the ids in the order the worker was given them. */
async function drain(queue: TripleStoreAsyncPromoteQueue): Promise<string[]> {
  const order: string[] = [];
  for (;;) {
    const job = await queue.claimNext('worker');
    if (!job) return order;
    order.push(job.jobId);
  }
}

describe('claimNext order', () => {
  it('takes the oldest enqueued job first and breaks a tie on the job id', async () => {
    const { queue } = await seeded([
      { id: 'job-3', state: 'queued', enqueuedAt: NOW + 5 },
      { id: 'job-2', state: 'queued', enqueuedAt: NOW + 5 },
      { id: 'job-10', state: 'queued', enqueuedAt: NOW + 5 },
      { id: 'job-9', state: 'queued', enqueuedAt: NOW + 1 },
    ]);
    // job-9 is older; the same-millisecond rest sort as strings, so job-10 comes before job-2.
    expect(await drain(queue)).toEqual(['job-9', 'job-10', 'job-2', 'job-3']);
  });

  it('orders a retrying job by its retry time among queued jobs, and not before that time', async () => {
    const { queue, setNow } = await seeded([
      { id: 'queued-late', state: 'queued', enqueuedAt: NOW + 900 },
      { id: 'retry-soon', state: 'failed_retrying', enqueuedAt: NOW, nextRetryAt: NOW + 500 },
      { id: 'queued-early', state: 'queued', enqueuedAt: NOW + 100 },
      { id: 'retry-later', state: 'failed_retrying', enqueuedAt: NOW, nextRetryAt: NOW + 5_000 },
    ]);
    setNow(NOW + 400);
    expect(await queue.claimNext('worker')).toMatchObject({ jobId: 'queued-early' });
    expect(await queue.claimNext('worker')).toMatchObject({ jobId: 'queued-late' });
    expect(await queue.claimNext('worker')).toBeNull(); // retry-soon is not due yet at +400 ms: not before its time
    setNow(NOW + 600);
    expect(await queue.claimNext('worker')).toMatchObject({ jobId: 'retry-soon' });
    expect(await queue.claimNext('worker')).toBeNull();
    setNow(NOW + 5_000);
    expect(await queue.claimNext('worker')).toMatchObject({ jobId: 'retry-later' });
  });

  it('skips a job whose claim lane a running job still holds, until that lease ends', async () => {
    const { queue, setNow } = await seeded([
      { id: 'holder', state: 'running', name: 'same-asset', enqueuedAt: NOW, leaseExpiresAt: NOW + 60_000 },
      { id: 'waiting', state: 'queued', name: 'same-asset', enqueuedAt: NOW + 1 },
      { id: 'free', state: 'queued', name: 'other-asset', enqueuedAt: NOW + 2 },
    ]);
    expect(await drain(queue)).toEqual(['free']);
    // The holder's lease expires. Recovery finds the waiting job as the assertion's other active owner, so it parks the
    // holder for manual inspection instead of requeueing it, and the waiting job is the one claimed.
    setNow(NOW + 61_000);
    expect(await drain(queue)).toEqual(['waiting']);
    expect(await queue.getStatus('holder')).toMatchObject({ state: 'failed', reason: expect.stringContaining('recovery conflict') });
  });

  it('never claims a job written by a newer format, and claims nothing while paused', async () => {
    const { queue } = await seeded([
      { id: 'future', state: 'queued', enqueuedAt: NOW, formatVersion: ASYNC_PROMOTE_QUEUE_FORMAT_VERSION + 1 },
      { id: 'current', state: 'queued', enqueuedAt: NOW + 1 },
    ]);
    await queue.pause();
    expect(await queue.claimNext('worker')).toBeNull();
    await queue.resume();
    expect(await drain(queue)).toEqual(['current']);
  });
});

describe('claimNext store sequence', () => {
  it('reads the expired-lease rows, then the active rows, then writes the one claimed job', async () => {
    const { queue, recorder } = await seeded([
      { id: 'job-1', state: 'queued', enqueuedAt: NOW },
      { id: 'job-2', state: 'queued', enqueuedAt: NOW + 1 },
    ]);
    await recorder.mark('claim', () => queue.claimNext('worker'));
    expect(recorder.calls.map((call) => [call.method, call.source])).toEqual([
      ['createGraph', undefined],
      ['query', 'publisher.asyncPromote.recoverExpired'],
      ['query', 'publisher.asyncPromote.claimNext.candidates'],
      ['replaceSubject', 'publisher.asyncPromote.writeJob'],
      ['flush', undefined],
    ]);
  });

  it('reads twice and writes nothing when no job is eligible', async () => {
    const { queue, recorder } = await seeded([{ id: 'waiting', state: 'failed_retrying', nextRetryAt: NOW + 10_000 }]);
    expect(await recorder.mark('claim', () => queue.claimNext('worker'))).toBeNull();
    expect(recorder.calls.map((call) => [call.method, call.source])).toEqual([
      ['createGraph', undefined],
      ['query', 'publisher.asyncPromote.recoverExpired'],
      ['query', 'publisher.asyncPromote.claimNext.candidates'],
    ]);
  });
});
