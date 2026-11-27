import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeRpcRequestContext } from '@origintrail-official/dkg-chain';
import {
  VM_RECOVERY_PREPARATION_LIMITS,
  VmRecoveryPreparation,
  resolveVmRecoveryPrefetchEnabled,
  vmRecoveryRetryDelay,
  type VmRecoveryPreparationScope,
} from '../src/vm-recovery-preparation.js';
import type { VmRecoveryUpdateContext } from '../src/vm-recovery-footprint.js';

interface ControlledRead {
  readonly kaId: bigint;
  readonly signal: AbortSignal | undefined;
  readonly requestClass: string;
  resolve(context?: Partial<VmRecoveryUpdateContext>): void;
  reject(error: Error): void;
}

function goodContext(overrides: Partial<VmRecoveryUpdateContext> = {}): VmRecoveryUpdateContext {
  return { merkleRootsCount: 2n, byteSize: 4_096n, merkleLeafCount: 12, ...overrides };
}

const openReaders: Array<{ reads: ControlledRead[] }> = [];

/** A sizing reader whose every physical read is held until the test releases it. */
function controlledReader() {
  const reads: ControlledRead[] = [];
  openReaders.push({ reads });
  let inFlight = 0;
  let maxInFlight = 0;
  const reader = {
    readUpdateContext(kaId: bigint, options?: { signal?: AbortSignal }): Promise<VmRecoveryUpdateContext> {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<VmRecoveryUpdateContext>((resolve, reject) => {
        const settle = (action: () => void): void => {
          inFlight -= 1;
          action();
        };
        reads.push({
          kaId,
          signal: options?.signal,
          requestClass: activeRpcRequestContext().requestClass,
          resolve: (context) => settle(() => resolve(goodContext(context))),
          reject: (error) => settle(() => reject(error)),
        });
      });
    },
  };
  return { reader, reads, maxInFlight: () => maxInFlight, inFlight: () => inFlight };
}

function scope(overrides: Partial<VmRecoveryPreparationScope> = {}): VmRecoveryPreparationScope {
  return {
    localCgId: '0xabc/public-graph',
    onChainCgId: 14n,
    generation: 1,
    isCurrent: () => true,
    ...overrides,
  };
}

const ids = (count: number, from = 100) => Array.from({ length: count }, (_, index) => ({ kaId: String(from + index) }));
const flush = async (turns = 5) => { for (let turn = 0; turn < turns; turn += 1) await Promise.resolve(); };

describe('VM recovery preparation owner', () => {
  const owners: VmRecoveryPreparation[] = [];
  const own = (preparation: VmRecoveryPreparation) => { owners.push(preparation); return preparation; };
  afterEach(async () => {
    vi.useRealTimers();
    // close() waits for physical settlement, so settle whatever a test left outstanding.
    const closing = Promise.all(owners.splice(0).map((owner) => owner.close()));
    let settled = false;
    void closing.then(() => { settled = true; });
    for (let round = 0; round < 50 && !settled; round += 1) {
      for (const reader of openReaders) {
        for (const read of reader.reads) {
          try { read.reject(new Error('teardown')); } catch { /* already settled */ }
        }
      }
      await flush(3);
    }
    openReaders.length = 0;
    await closing;
  });

  it('accepts one bounded stable prefix and ignores duplicates and malformed ids', () => {
    const { reader } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const result = owner.prepare(scope(), [
      ...ids(3),
      { kaId: '100' },
      { kaId: 'not-a-number' },
      { kaId: '' },
      ...ids(40, 200),
    ]);
    expect(result).toEqual({ accepted: VM_RECOVERY_PREPARATION_LIMITS.maxPreparedAssets });
    expect(owner.stats().accepted).toBe(10);
  });

  it('never has more than two speculative reads in flight and starts them in candidate order', async () => {
    const { reader, reads, maxInFlight } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    owner.prepare(scope(), ids(10));
    await flush();
    expect(reads.map((read) => read.kaId)).toEqual([100n, 101n]);

    reads[0]!.resolve();
    await flush();
    expect(reads.map((read) => read.kaId)).toEqual([100n, 101n, 102n]);
    for (const read of reads.slice(1)) read.resolve();
    for (let round = 0; round < 12; round += 1) {
      await flush();
      for (const read of reads.filter((candidate) => candidate.signal && !candidate.signal.aborted)) read.resolve();
    }
    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(owner.stats().maxActiveReads).toBeLessThanOrEqual(2);
    expect(reads.map((read) => read.kaId).slice(0, 5)).toEqual([100n, 101n, 102n, 103n, 104n]);
  });

  it('issues speculative reads in the background request class bound to the owner signal', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    owner.prepare(scope(), ids(1));
    await flush();
    expect(reads[0]!.requestClass).toBe('background');
    expect(reads[0]!.signal).toBeDefined();
    expect(reads[0]!.signal!.aborted).toBe(false);
  });

  it('hands out each prepared hint exactly once', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, ids(2));
    await flush();
    reads[0]!.resolve({ byteSize: 9_000n, merkleLeafCount: 20 });
    reads[1]!.resolve();
    await flush();

    const hints = owner.hintsFor(s);
    const first = await hints.take('100', { maxWaitMs: 50 });
    expect(first).toMatchObject({ kind: 'public-v10', byteSize: 9_000n, merkleLeafCount: 20n, anchor: { kind: 'latest-bounded' } });
    await expect(hints.take('100', { maxWaitMs: 50 })).resolves.toBeUndefined();
    expect(owner.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('retains a footprint the caller already holds without reading it again', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, [{
      kaId: '300',
      footprint: { kind: 'public-v10', byteSize: 77n, merkleLeafCount: 3n, assertionVersion: '4', anchor: { kind: 'latest-bounded' } },
    }]);
    await flush();
    expect(reads).toHaveLength(0);
    await expect(owner.hintsFor(s).take('300', { maxWaitMs: 10 })).resolves.toMatchObject({ byteSize: 77n });
  });

  it('refuses a second batch until the first is released', async () => {
    const { reader } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    expect(owner.prepare(s, ids(2))).toEqual({ accepted: 2 });
    expect(owner.prepare(s, ids(2, 500))).toEqual({ accepted: 0, refused: 'busy' });
    owner.release(s);
    expect(owner.prepare(s, ids(2, 500))).toEqual({ accepted: 2 });
  });

  it('release discards unused hints, cancels reads in flight and never applies their late result', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, ids(3));
    await flush();
    expect(reads).toHaveLength(2);

    owner.release(s);
    expect(reads.every((read) => read.signal!.aborted)).toBe(true);
    // The physical requests are still outstanding until the transport settles them.
    expect(owner.stats().activeReads).toBe(2);
    for (const read of reads) read.resolve();
    await flush(10);

    expect(owner.stats()).toMatchObject({ activeReads: 0, retainedBytes: 0, discardedUnused: 3, hits: 0 });
    expect(owner.stats().lateDropped).toBe(2);
    await expect(owner.hintsFor(s).take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    // The freed slot accepts the next batch and its reads start only as capacity truly frees.
    expect(owner.prepare(s, ids(1, 900))).toEqual({ accepted: 1 });
  });

  it('stops starting queued reads once recovery ownership is lost, while issued reads stay tracked until they settle', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    let current = true;
    const s = scope({ isCurrent: () => current });
    owner.prepare(s, ids(10));
    await flush();
    expect(reads).toHaveLength(2);

    // Ownership ends without any abort of the operation's signal.
    current = false;
    expect(s.signal?.aborted ?? false).toBe(false);
    reads[0]!.resolve();
    await flush(10);
    // The freed slot did not start a third read, and the other issued read is still accounted for.
    expect(reads).toHaveLength(2);
    expect(owner.stats().activeReads).toBe(1);
    reads[1]!.resolve();
    await flush(10);
    expect(reads).toHaveLength(2);
    expect(owner.stats()).toMatchObject({ activeReads: 0, retainedBytes: 0 });
    // Nothing the lost operation prepared is ever handed out.
    await expect(owner.hintsFor(s).take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
  });

  it('counts a cancelled read against capacity until it physically settles', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, ids(2));
    await flush();
    owner.release(s);
    owner.prepare(s, ids(2, 900));
    await flush();
    // Both slots are still held by the two cancelled physical reads.
    expect(reads).toHaveLength(2);
    reads[0]!.reject(new Error('aborted'));
    await flush(10);
    expect(reads.map((read) => read.kaId)).toContain(900n);
  });

  it('misses on a stale generation, a lost ownership, an aborted operation and an expired hint', async () => {
    let now = 0;
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader, {}, () => now));
    let current = true;
    const controller = new AbortController();
    const s = scope({ isCurrent: () => current, signal: controller.signal });
    owner.prepare(s, ids(4));
    await flush();
    for (const read of reads) read.resolve();
    await flush();

    const hints = owner.hintsFor(s);
    await expect(owner.hintsFor(scope({ generation: 2 })).take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    await expect(owner.hintsFor(scope({ localCgId: 'other' })).take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    await expect(owner.hintsFor(scope({ onChainCgId: 15n })).take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    current = false;
    await expect(hints.take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    current = true;
    now = VM_RECOVERY_PREPARATION_LIMITS.maxHintAgeMs + 1;
    await expect(hints.take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    now = 1_000;
    await expect(hints.take('100', { maxWaitMs: 5 })).resolves.toMatchObject({ kind: 'public-v10' });
    controller.abort(new Error('operation aborted'));
    await expect(hints.take('101', { maxWaitMs: 5 })).resolves.toBeUndefined();
    expect(owner.stats().staleMisses).toBeGreaterThanOrEqual(5);
  });

  it('turns a failed, malformed or zero-sized read into a plain miss', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, ids(2));
    await flush();
    reads[0]!.reject(new Error('rpc failed'));
    await flush();
    reads[1]!.resolve({ byteSize: 0n });
    await flush();
    const hints = owner.hintsFor(s);
    await expect(hints.take('100', { maxWaitMs: 5 })).resolves.toBeUndefined();
    await expect(hints.take('101', { maxWaitMs: 5 })).resolves.toBeUndefined();
    expect(owner.stats()).toMatchObject({ readsReady: 0, readsUnusable: 2, hits: 0 });
  });

  it('waits for an in-flight read only up to the consumer deadline', async () => {
    vi.useFakeTimers();
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader, { readTimeoutMs: 60_000 }));
    const s = scope();
    owner.prepare(s, ids(1));
    await vi.advanceTimersByTimeAsync(0);
    const hints = owner.hintsFor(s);

    const slow = hints.take('100', { maxWaitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(slow).resolves.toBeUndefined();

    owner.release(s);
    reads[0]!.resolve();
    owner.prepare(s, ids(1, 400));
    await vi.advanceTimersByTimeAsync(0);
    const quick = owner.hintsFor(s).take('400', { maxWaitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10);
    reads[1]!.resolve();
    await expect(quick).resolves.toMatchObject({ kind: 'public-v10' });
  });

  it('stops only the consumer\'s wait on a timeout or a cancellation, never the physical read', async () => {
    vi.useFakeTimers();
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader, { readTimeoutMs: 60_000 }));
    const s = scope();
    owner.prepare(s, ids(1));
    await vi.advanceTimersByTimeAsync(0);
    const hints = owner.hintsFor(s);
    expect(owner.stats().activeReads).toBe(1);

    // The consumer's own deadline ends its wait.
    const timedOut = hints.take('100', { maxWaitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toBeUndefined();
    expect(reads[0]!.signal!.aborted).toBe(false);
    expect(owner.stats().activeReads).toBe(1);

    // So does the consumer's cancellation, leaving no listener or timer behind.
    const consumer = new AbortController();
    const add = vi.spyOn(consumer.signal, 'addEventListener');
    const remove = vi.spyOn(consumer.signal, 'removeEventListener');
    const cancelled = hints.take('100', { maxWaitMs: 60_000, signal: consumer.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
    consumer.abort(new Error('consumer gave up'));
    await expect(cancelled).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(1); // only the read's own deadline remains
    expect(reads[0]!.signal!.aborted).toBe(false);
    expect(owner.stats().activeReads).toBe(1);

    // The read is still owned by the preparation: when it settles, the hint is there for the next consumer.
    reads[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(owner.hintsFor(s).take('100', { maxWaitMs: 5 })).resolves.toMatchObject({ kind: 'public-v10' });
    expect(owner.stats()).toMatchObject({ activeReads: 0, hits: 1 });
  });

  it('does not start a duplicate read for a queued candidate the consumer reads live', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const s = scope();
    owner.prepare(s, ids(4));
    await flush();
    expect(reads.map((read) => read.kaId)).toEqual([100n, 101n]);
    // 103 is still queued behind the two-read cap; the planner will read it live.
    await expect(owner.hintsFor(s).take('103', { maxWaitMs: 5 })).resolves.toBeUndefined();
    for (const read of reads) read.resolve();
    await flush(10);
    expect(reads.map((read) => read.kaId)).not.toContain(103n);
  });

  it('bounds retained descriptor memory explicitly', async () => {
    const { reader } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader, { maxRetainedBytes: 300 }));
    const result = owner.prepare(scope(), ids(10));
    expect(result.accepted).toBeGreaterThan(0);
    expect(result.accepted).toBeLessThan(10);
    expect(owner.stats().retainedBytes).toBeLessThanOrEqual(300);
    owner.discard();
    expect(owner.stats().retainedBytes).toBe(0);
  });

  it('refuses without a reader, after close, for a stale scope and for an empty prefix', async () => {
    const noReader = own(new VmRecoveryPreparation(null));
    expect(noReader.prepare(scope(), ids(1))).toEqual({ accepted: 0, refused: 'no-reader' });
    const { reader } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    expect(owner.prepare(scope({ isCurrent: () => false }), ids(1))).toEqual({ accepted: 0, refused: 'stale-scope' });
    const aborted = new AbortController();
    aborted.abort();
    expect(owner.prepare(scope({ signal: aborted.signal }), ids(1))).toEqual({ accepted: 0, refused: 'stale-scope' });
    expect(owner.prepare(scope(), [])).toEqual({ accepted: 0, refused: 'no-candidates' });
    expect(owner.prepare(scope(), [{ kaId: 'x' }])).toEqual({ accepted: 0, refused: 'no-candidates' });
    await owner.close();
    expect(owner.prepare(scope(), ids(1))).toEqual({ accepted: 0, refused: 'closed' });
  });

  it('close waits for physical settlement and removes the scope-signal listener', async () => {
    const { reader, reads } = controlledReader();
    const owner = new VmRecoveryPreparation(reader);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    owner.prepare(scope({ signal: controller.signal }), ids(2));
    await flush();
    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });

    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    await flush(10);
    expect(closed).toBe(false);
    expect(reads.every((read) => read.signal!.aborted)).toBe(true);
    for (const read of reads) read.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(owner.stats()).toMatchObject({ activeReads: 0, retainedBytes: 0 });
  });

  it('cancels preparation when the owning operation aborts', async () => {
    const { reader, reads } = controlledReader();
    const owner = own(new VmRecoveryPreparation(reader));
    const controller = new AbortController();
    owner.prepare(scope({ signal: controller.signal }), ids(2));
    await flush();
    controller.abort(new Error('lifecycle closed'));
    expect(reads.every((read) => read.signal!.aborted)).toBe(true);
    for (const read of reads) read.reject(new Error('aborted'));
    await flush(10);
    expect(owner.stats().lateDropped).toBe(2);
  });
});

describe('typed opt-in switch', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is off by default and follows env then config', () => {
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', undefined);
    expect(resolveVmRecoveryPrefetchEnabled()).toBe(false);
    expect(resolveVmRecoveryPrefetchEnabled(true)).toBe(true);
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '1');
    expect(resolveVmRecoveryPrefetchEnabled()).toBe(true);
    expect(resolveVmRecoveryPrefetchEnabled(false)).toBe(true);
    vi.stubEnv('DKG_VM_RECOVERY_PREFETCH_ENABLED', '0');
    expect(resolveVmRecoveryPrefetchEnabled(true)).toBe(false);
  });
});


describe('vmRecoveryRetryDelay', () => {
  it('resolves after the delay and leaves no abort listener behind', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const started = performance.now();
    await vmRecoveryRetryDelay(20, controller.signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('returns at once for a non-positive delay or an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    await Promise.all([vmRecoveryRetryDelay(0), vmRecoveryRetryDelay(-5), vmRecoveryRetryDelay(60_000, controller.signal)]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('resolves early when the signal aborts during the wait', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const waiting = vmRecoveryRetryDelay(60_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await waiting;
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
