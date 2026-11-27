import { afterEach, describe, expect, it, vi } from 'vitest';
import * as exactRecovery from '../src/exact-recovery-execution.js';
import type { ExactKnowledgeAssetSyncResult } from '../src/durable-recovery-types.js';
import { recoverPublicSnapshotExact } from '../src/public-snapshot-exact.js';
import {
  PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS, PUBLIC_SNAPSHOT_RETRY_MS, PublicSnapshotRecoveryPacing,
} from '../src/public-snapshot-exact-pacing.js';
import { createDurableSyncAccumulator, finalizeDurableSyncCompletion } from '../src/sync/durable-progress.js';
import { exactAssetUalsForSelection } from '../src/sync/exact-assets.js';

const graph = 'snapshot-pacing';
const uals = Array.from({ length: 12 }, (_, index) => `did:dkg:evm:31337/0x${'cd'.repeat(20)}/${index + 1}`);
const host = { log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() } } as never;
const evidence = {} as never;

function outcome(extra: Partial<ExactKnowledgeAssetSyncResult> = {}): ExactKnowledgeAssetSyncResult {
  return { admission: 'work-started', result: finalizeDurableSyncCompletion(createDurableSyncAccumulator()), disposition: 'incomplete', ...extra };
}
type Request = Parameters<typeof exactRecovery.runExactRecovery>[0];
const selected = (request: Request) => exactAssetUalsForSelection(request.policy.selection);

function recover(options: { deadline?: number; signal?: AbortSignal; peers?: string[]; uals?: string[];
  peerBatches?: () => AsyncIterable<readonly string[]>; canAdmit?: () => boolean;
  holds?: (ual: string) => Promise<boolean>; owned?: () => boolean } = {}) {
  const signal = options.signal ?? new AbortController().signal;
  return recoverPublicSnapshotExact(host, {
    contextGraphId: graph, peerBatches: options.peerBatches ?? (async function* () { yield options.peers ?? ['core-a']; }),
    uals: options.uals ?? uals, evidence, signal,
    assertCurrent: () => {
      if (signal.aborted) throw new Error('job cancelled');
      if (options.owned && !options.owned()) throw new Error('Snapshot job ownership changed');
    },
    deadline: options.deadline ?? Date.now() + 3_600_000,
    ...(options.canAdmit ? { canAdmit: options.canAdmit } : {}),
    ...(options.holds ? { holds: options.holds } : {}),
  });
}

async function settle<T>(job: Promise<T>, stepMs = 500, maxSteps = 2_000) {
  let result: { value: T } | { error: unknown } | undefined;
  job.then(value => { result = { value }; }, error => { result = { error }; });
  for (let step = 0; step < maxSteps && !result; step++) await vi.advanceTimersByTimeAsync(stepMs);
  if (!result) throw new Error('Recovery did not settle');
  return result;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public snapshot exact recovery pacing', () => {
  it('prefers the peer that completed the prior batch while retaining fallback providers', async () => {
    const calls: string[] = [];
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      calls.push(request.remotePeerId);
      if (request.remotePeerId === 'partial-core' && calls.length === 1) return outcome();
      if (request.remotePeerId === 'complete-core' && calls.length === 3) return outcome();
      return outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' });
    });
    const result = await recover({ peers: ['partial-core', 'complete-core'] });
    expect(result.committed).toEqual(new Set(uals));
    expect(calls).toEqual(['partial-core', 'complete-core', 'complete-core', 'partial-core']);
  });

  it('asks a peer whose stream broke again only after it has served the graph', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: Array<{ peer: string; transport: string | undefined; at: number }> = [];
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      calls.push({ peer: request.remotePeerId, transport: request.options.exactRecoveryTransportMode, at: Date.now() });
      // The first batch is served in full; the second exchange breaks once and is then served.
      if (calls.length === 2) return outcome({ streamOutcome: 'stream-interrupted' });
      return outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' });
    });
    const result = await settle(recover());
    expect(result).toEqual({ value: { committed: new Set(uals), alreadyPresent: 0 } });
    expect(calls.map(call => call.transport)).toEqual(['stream-preferred', 'stream-preferred', 'stream-preferred']);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(15_000);
  });

  it('moves on from a peer whose stream broke before it ever served the graph', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transports: Array<string | undefined> = [];
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      transports.push(request.options.exactRecoveryTransportMode);
      if (request.options.exactRecoveryTransportMode === 'stream-preferred') return outcome({ streamOutcome: 'stream-interrupted' });
      return outcome({ committedExactAssetUals: selected(request), disposition: 'found' });
    });
    const result = await settle(recover());
    expect(result).toHaveProperty('value');
    // Each batch: one stream attempt, then the bounded singleton transport, as before.
    expect(transports).toEqual(['stream-preferred', ...Array(10).fill('legacy'), 'stream-preferred', 'legacy', 'legacy']);
  });

  it('uses a healthy later content batch before waiting on a busy first batch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const startedAt = Date.now();
    const calls: string[] = [];
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      calls.push(request.remotePeerId);
      return request.remotePeerId === 'busy-first' ? outcome({ streamOutcome: 'responder-busy' })
        : outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' });
    });
    const result = await recover({ uals: [uals[0]!], deadline: startedAt + PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS,
      peerBatches: async function* () { yield ['busy-first']; yield ['healthy-later']; } });
    expect(result).toEqual({ committed: new Set([uals[0]]), alreadyPresent: 0 });
    expect(calls).toEqual(['busy-first', 'healthy-later']);
    expect(Date.now()).toBe(startedAt);
  });

  it('retries deferred busy peers after later batches answer without the asset', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: Array<{ peer: string; at: number }> = [];
    let busyAttempts = 0;
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      calls.push({ peer: request.remotePeerId, at: Date.now() });
      if (request.remotePeerId === 'busy-first') return ++busyAttempts === 1
        ? outcome({ streamOutcome: 'responder-busy' })
        : outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' });
      return outcome();
    });
    const result = await settle(recover({ uals: [uals[0]!],
      peerBatches: async function* () { yield ['busy-first']; yield ['empty-later']; } }));
    expect(result).toEqual({ value: { committed: new Set([uals[0]]), alreadyPresent: 0 } });
    expect(calls.map(c => c.peer)).toEqual(['busy-first', 'empty-later', 'empty-later', 'busy-first']);
    expect(calls[3]!.at - calls[0]!.at).toBeGreaterThanOrEqual(15_000);
  });

  it('keeps the committed count when the configured cores stay busy until the job limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let call = 0;
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => (
      ++call === 1
        ? outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' })
        : outcome({ streamOutcome: 'responder-busy' })));
    const deadline = Date.now() + PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS + 60_000;
    const result = await settle(recover({ deadline }));
    expect(result).toHaveProperty('error');
    expect((result as { error: Error }).error.message)
      .toBe('Snapshot recovery incomplete: 10/12 committed (the configured cores stayed busy)');
    expect(Date.now()).toBeLessThanOrEqual(deadline - PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS);
  });

  it('waits for local admission before discovering more peers and closes discovery after success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const calls: string[] = [], discovered: string[] = [];
    let closed = false;
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      calls.push(request.remotePeerId);
      return calls.length === 1 ? outcome({ admission: 'local-admission-deferred' })
        : outcome({ committedExactAssetUals: selected(request), disposition: 'found', streamOutcome: 'complete' });
    });
    const result = await settle(recover({ uals: [uals[0]!], canAdmit: () => true,
      peerBatches: async function* () {
        try {
          discovered.push('first'); yield ['first'];
          discovered.push('later'); yield ['later'];
        } finally { closed = true; }
      } }));
    expect(result).toEqual({ value: { committed: new Set([uals[0]]), alreadyPresent: 0 } });
    expect(calls).toEqual(['first', 'first']);
    expect(discovered).toEqual(['first']);
    expect(closed).toBe(true);
  });

  it('keeps the committed count when the job limit passes during an attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const deadline = Date.now() + 600_000;
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      vi.setSystemTime(deadline + 1);
      return outcome({ committedExactAssetUals: selected(request).slice(0, 4), disposition: 'incomplete' });
    });
    await expect(recover({ deadline })).rejects.toThrow('Snapshot recovery incomplete: 4/12 committed (job time limit reached)');
  });

  it('retries after the hold alone when the capacity read cannot answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let call = 0;
    const canAdmit = vi.fn(() => { throw new Error('limiter unavailable'); });
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => (
      ++call === 1
        ? outcome({ admission: 'local-admission-deferred' })
        : outcome({ committedExactAssetUals: selected(request), disposition: 'found' })));
    const result = await settle(recover({ canAdmit }));
    expect(result).toHaveProperty('value');
    expect(canAdmit).toHaveBeenCalledOnce();
  });

  it('counts assets another sync stored during a wait without fetching them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const stored = new Set<string>();
    const requests: string[][] = [];
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async request => {
      requests.push(selected(request));
      if (requests.length === 1) {
        for (const ual of uals.slice(0, 6)) stored.add(ual);
        return outcome({ result: { ...finalizeDurableSyncCompletion(createDurableSyncAccumulator()), deferredBackpressure: 1 }, admission: 'not-started' });
      }
      return outcome({ committedExactAssetUals: selected(request), disposition: 'found' });
    });
    const result = await settle(recover({ holds: async ual => stored.has(ual) }));
    expect(result).toEqual({ value: { committed: new Set(uals), alreadyPresent: 6 } });
    expect(new Set(requests[1])).toEqual(new Set(uals.slice(6, 10)));
  });

  it('ends a wait within one interval when the job loses its graph', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let owned = true;
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async () => outcome({ streamOutcome: 'responder-busy' }));
    let rejectedAt = 0;
    const job = recover({ owned: () => owned });
    const rejected = expect(job.finally(() => { rejectedAt = Date.now(); })).rejects.toThrow('ownership changed');
    await vi.advanceTimersByTimeAsync(40_000);
    owned = false;
    const lostAt = Date.now();
    await vi.advanceTimersByTimeAsync(PUBLIC_SNAPSHOT_RETRY_MS);
    expect(rejectedAt).toBeGreaterThan(0);
    expect(rejectedAt - lostAt).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_RETRY_MS);
    await rejected;
  });

  it('ends a wait at once when the job is cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const controller = new AbortController();
    vi.spyOn(exactRecovery, 'runExactRecovery').mockImplementation(async () => outcome({ admission: 'local-admission-deferred' }));
    const job = recover({ signal: controller.signal, canAdmit: () => false });
    const rejected = expect(job).rejects.toThrow('job cancelled');
    await vi.advanceTimersByTimeAsync(PUBLIC_SNAPSHOT_RETRY_MS * 4);
    controller.abort(new Error('stop'));
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
  });
});

describe('public snapshot pacing waits', () => {
  it('throws the job cancellation from the wait without sleeping', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const assertCurrent = () => { if (controller.signal.aborted) throw new Error('job cancelled'); };
    const pacing = new PublicSnapshotRecoveryPacing({ contextGraphId: graph, deadline: Date.now() + 3_600_000,
      signal: controller.signal, assertCurrent, canAdmit: () => false });
    const startedAt = performance.now();
    await expect(pacing.waitForAdmission()).rejects.toThrow('job cancelled');
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('returns once a held-off peer is free again, and false only when time runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const pacing = new PublicSnapshotRecoveryPacing({ contextGraphId: graph, deadline: Date.now() + 3_600_000,
      signal: new AbortController().signal, assertCurrent: () => {} });
    expect(pacing.settle('core-a', outcome({ streamOutcome: 'responder-busy' }), 0)).toBe('retry-peer');
    const waited = pacing.waitForPeer(['core-a']);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(waited).resolves.toBe(true);
    expect(pacing.heldOff('core-a')).toBe(false);
  });

  it('refuses a wait that would reach into the final read reserve', async () => {
    const pacing = new PublicSnapshotRecoveryPacing({ contextGraphId: graph,
      deadline: Date.now() + PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS, signal: new AbortController().signal, assertCurrent: () => {} });
    await expect(pacing.waitForAdmission()).resolves.toBe(false);
    expect(pacing.attemptTimeoutMs()).toBeLessThanOrEqual(PUBLIC_SNAPSHOT_FINAL_READ_RESERVE_MS);
  });
});
