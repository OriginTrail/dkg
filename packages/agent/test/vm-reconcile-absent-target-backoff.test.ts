// SPDX-License-Identifier: Apache-2.0

/**
 * The periodic sweep spaces discovery of graphs whose name the chain holds no id for.
 *
 * A Core node subscribes to every context graph it hears of over ontology
 * gossip. One that was never registered failed every pass with the same
 * answer, after a live authority scan, and the sweep offered it again on every
 * turn, so a few such names took the unbound lane's whole per-sweep allowance.
 *
 * Pure: the real backoff and scheduling runtime over a fake clock, and the real
 * target resolution over a stubbed finalized authority index. No hardhat.
 */
import { describe, expect, it, vi } from 'vitest';
import { VmReconcileAbsentTargetBackoff } from '../src/internal/vm-reconcile-absent-target-backoff.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import {
  ContextGraphNameAbsentError,
  ContextGraphOnChainIdUnresolvedError,
} from '../src/vm-reconcile-service.js';
import {
  LOCAL_ID,
  NAME_HASH,
  selectedFixture,
} from './context-graph-registration-binding.fixture.js';

const BASE_MS = 60_000;
const MAX_MS = 3_600_000;

function fakeClock() {
  const clock = { now: 1_000_000, read: () => clock.now, advance: (ms: number) => { clock.now += ms; } };
  return clock;
}

describe('VmReconcileAbsentTargetBackoff', () => {
  it('waits one base interval after the first absent answer, doubling up to the ceiling', () => {
    const clock = fakeClock();
    const backoff = new VmReconcileAbsentTargetBackoff({ baseMs: BASE_MS, maxMs: 300_000, now: clock.read });
    const waits: number[] = [];
    for (let answer = 0; answer < 5; answer += 1) {
      backoff.noteAbsent('ghost');
      let waited = 0;
      while (backoff.isWaiting('ghost')) {
        clock.advance(10_000);
        waited += 10_000;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([60_000, 120_000, 240_000, 300_000, 300_000]);
  });

  it('lets a cleared graph go at once and starts its next wait from the base again', () => {
    const clock = fakeClock();
    const backoff = new VmReconcileAbsentTargetBackoff({ baseMs: BASE_MS, maxMs: MAX_MS, now: clock.read });
    backoff.noteAbsent('ghost');
    backoff.noteAbsent('ghost');
    expect(backoff.isWaiting('ghost')).toBe(true);
    backoff.clear('ghost');
    expect(backoff.isWaiting('ghost')).toBe(false);
    backoff.noteAbsent('ghost');
    clock.advance(BASE_MS - 1);
    expect(backoff.isWaiting('ghost')).toBe(true);
    clock.advance(1);
    expect(backoff.isWaiting('ghost')).toBe(false);
  });

  it('offers the keys that are not waiting, in their given order', () => {
    const clock = fakeClock();
    const backoff = new VmReconcileAbsentTargetBackoff({ baseMs: BASE_MS, now: clock.read });
    const keys = ['a', 'ghost', 'b'];
    expect(backoff.due(keys)).toBe(keys);
    backoff.noteAbsent('ghost');
    expect(backoff.due(keys)).toEqual(['a', 'b']);
    clock.advance(BASE_MS);
    expect(backoff.due(keys)).toEqual(keys);
  });

  it('forgets the oldest answer beyond its bound, and that graph is offered again', () => {
    const backoff = new VmReconcileAbsentTargetBackoff({ maxEntries: 2, now: () => 0 });
    backoff.noteAbsent('first');
    backoff.noteAbsent('second');
    backoff.noteAbsent('first');
    backoff.noteAbsent('third');
    expect(backoff.isWaiting('second')).toBe(false);
    expect(backoff.isWaiting('first')).toBe(true);
    expect(backoff.isWaiting('third')).toBe(true);
  });

  it('refuses a base or ceiling that is not positive and finite, and an entry bound below one', () => {
    expect(() => new VmReconcileAbsentTargetBackoff({ baseMs: 0 })).toThrow(RangeError);
    expect(() => new VmReconcileAbsentTargetBackoff({ baseMs: Number.NaN })).toThrow(RangeError);
    expect(() => new VmReconcileAbsentTargetBackoff({ maxMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
    expect(() => new VmReconcileAbsentTargetBackoff({ maxEntries: 0 })).toThrow(RangeError);
    expect(() => new VmReconcileAbsentTargetBackoff({ maxEntries: 1.5 })).toThrow(RangeError);
  });
});

describe('periodic sweep over a graph whose name the chain holds no id for', () => {
  /** `ghost` answers absent until `registered`; `other` fails for another reason every time. */
  function runtimeFixture() {
    const clock = fakeClock();
    const state = { registered: false };
    const passes: string[] = [];
    const runtime = new VmReconcileSchedulingRuntime<void>(
      async (key, source) => {
        passes.push(`${source}:${key}`);
        if (key === 'ghost' && !state.registered) throw new ContextGraphNameAbsentError(key);
        if (key === 'other') throw new ContextGraphOnChainIdUnresolvedError(key);
      },
      () => undefined,
      {
        concurrency: 1,
        discoveryBatchSize: 8,
        absentTargetBackoff: { baseMs: BASE_MS, maxMs: MAX_MS, now: clock.read },
      },
    );
    const sweep = async (bound: readonly string[], unbound: readonly string[]): Promise<string[]> => {
      const before = passes.length;
      await runtime.completeSweep(bound, unbound, () => true);
      await runtime.waitForIdle();
      // The lane's round-robin cursor carries over between turns, so compare the set of passes.
      return passes.slice(before).sort();
    };
    return { clock, state, passes, runtime, sweep };
  }

  it('leaves it out of the unbound lane until its wait ends, while other failures retry every sweep', async () => {
    const { clock, sweep } = runtimeFixture();
    expect(await sweep([], ['ghost', 'other'])).toEqual(['periodic:ghost', 'periodic:other']);
    expect(await sweep([], ['ghost', 'other'])).toEqual(['periodic:other']);
    clock.advance(BASE_MS);
    expect(await sweep([], ['ghost', 'other'])).toEqual(['periodic:ghost', 'periodic:other']);
    // The second absent answer doubles the wait.
    clock.advance(BASE_MS);
    expect(await sweep([], ['ghost', 'other'])).toEqual(['periodic:other']);
    clock.advance(BASE_MS);
    expect(await sweep([], ['ghost', 'other'])).toEqual(['periodic:ghost', 'periodic:other']);
  });

  it('leaves it out of the timer sweep too', async () => {
    const { runtime, passes, sweep } = runtimeFixture();
    await sweep([], ['ghost']);
    const before = passes.length;
    runtime.scheduleSweep([], ['ghost', 'other'], () => true);
    await runtime.waitForIdle();
    expect(passes.slice(before)).toEqual(['periodic:other']);
  });

  it('never holds back the bound lane or an operator pass', async () => {
    const { runtime, passes, sweep } = runtimeFixture();
    await sweep([], ['ghost']);
    expect(await sweep(['ghost'], [])).toEqual(['periodic:ghost']);
    let before = passes.length;
    runtime.scheduleSweep(['ghost'], [], () => true);
    await runtime.waitForIdle();
    expect(passes.slice(before)).toEqual(['periodic:ghost']);
    before = passes.length;
    await expect(runtime.triggerManual('ghost')).rejects.toBeInstanceOf(ContextGraphNameAbsentError);
    expect(passes.slice(before)).toEqual(['manual:ghost']);
  });

  it('offers it again at once after a new binding, which also lets its live nudge run', async () => {
    const { runtime, passes, sweep } = runtimeFixture();
    await sweep([], ['ghost']);
    runtime.releaseLiveHold('ghost');
    expect(await sweep([], ['ghost'])).toEqual(['periodic:ghost']);
    runtime.releaseLiveHold('ghost');
    const before = passes.length;
    runtime.triggerLive('ghost');
    await runtime.waitForIdle();
    expect(passes.slice(before)).toEqual(['live:ghost']);
  });

  it('offers it again at once after a pass for it succeeds', async () => {
    const { runtime, state, sweep } = runtimeFixture();
    await sweep([], ['ghost']);
    state.registered = true;
    await runtime.triggerManual('ghost');
    expect(await sweep([], ['ghost'])).toEqual(['periodic:ghost']);
    expect(await sweep([], ['ghost'])).toEqual(['periodic:ghost']);
  });
});

describe('subscription target resolution for a name the finalized index holds no id for', () => {
  /** A live finalized index that projects no snapshot for the fixture's name commitment. */
  function withEmptyFinalizedIndex() {
    const fixture = selectedFixture();
    // The fixture switches VM reconcile off, and the subscription path asks that first.
    Reflect.set(fixture.agent, 'vmReconcileEnabled', () => true);
    const resolveSnapshots = vi.fn(async () => new Map<string, never>());
    Reflect.set(fixture.agent.chain, 'contextGraphAuthorityIndexRevisionReader', {
      resolveFinalizedContextGraphAuthoritySnapshotsByNameHashes: resolveSnapshots,
      whenIdle: vi.fn(async () => undefined),
    });
    Reflect.set(fixture.agent, 'contextGraphRegistrationsInFlight', new Set<string>());
    const host = fixture.agent as unknown as {
      resolveVmReconcileTarget(localCgId: string, isCurrent: () => boolean): Promise<unknown>;
    };
    return { host, resolveSnapshots };
  }

  it('answers with ContextGraphNameAbsentError, which callers still see as unresolved', async () => {
    const { host, resolveSnapshots } = withEmptyFinalizedIndex();
    const error = await host.resolveVmReconcileTarget(LOCAL_ID, () => true).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ContextGraphNameAbsentError);
    expect(error).toBeInstanceOf(ContextGraphOnChainIdUnresolvedError);
    expect(error).toMatchObject({
      code: 'ContextGraphOnChainIdUnresolved',
      name: 'ContextGraphOnChainIdUnresolvedError',
      message: `Context graph "${LOCAL_ID}" has no resolved on-chain id`,
    });
    expect(resolveSnapshots).toHaveBeenCalledWith([NAME_HASH], expect.anything());
  });
});
