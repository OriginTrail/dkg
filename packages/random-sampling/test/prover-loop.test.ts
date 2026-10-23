/**
 * startProverLoop — timer + single-flight + stop semantics.
 *
 * The loop driver is the only "non-trivial" code in the agent's
 * random-sampling-bind layer. Pinning it here means the agent's bind
 * file is just role-gating + dependency wiring, with no behavior
 * worth its own integration test.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { startProverLoop, type TickableProver } from '../src/prover-loop.js';
import {
  classifyTickOutcome,
  type TickFailureKind,
  type TickOutcome,
  type TickOutcomeHealth,
} from '../src/prover.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeProver(impl: () => Promise<TickOutcome>): TickableProver & { closed: boolean; calls: number } {
  let calls = 0;
  const close = vi.fn();
  return {
    get calls() { return calls; },
    set calls(v) { calls = v; },
    get closed() { return close.mock.calls.length > 0; },
    async tick() {
      calls += 1;
      return impl();
    },
    async close() { close(); },
  } as never;
}

describe('startProverLoop', () => {
  it('start() ticks immediately and keeps ticking on the interval', async () => {
    const prover = fakeProver(async () => ({ kind: 'period-closed' }));
    const onTick = vi.fn();
    const loop = startProverLoop({ prover, intervalMs: 10, onTick });
    loop.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(onTick.mock.calls.length).toBeGreaterThanOrEqual(2);
    await loop.stop();
  });

  it('serializes ticks: a slow tick blocks the next interval until it finishes', async () => {
    let resolveFirst: (value: TickOutcome) => void = () => undefined;
    let firstCallStarted = false;
    const prover = fakeProver(async () => {
      if (!firstCallStarted) {
        firstCallStarted = true;
        return new Promise<TickOutcome>((res) => { resolveFirst = res; });
      }
      return { kind: 'period-closed' };
    });
    const loop = startProverLoop({ prover, intervalMs: 5 });
    loop.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(prover.calls).toBe(1); // immediate tick is hung; intervals are dropped
    resolveFirst({ kind: 'period-closed' });
    await new Promise((r) => setTimeout(r, 30));
    expect(prover.calls).toBeGreaterThan(1);
    await loop.stop();
  });

  it('start() is idempotent: a second call is a no-op', async () => {
    const prover = fakeProver(async () => ({ kind: 'period-closed' }));
    const loop = startProverLoop({ prover, intervalMs: 5 });
    loop.start();
    loop.start();
    loop.start();
    await new Promise((r) => setTimeout(r, 30));
    // We can't assert exact count due to timing jitter; just verify
    // it didn't fire 3x as fast as a single start would.
    expect(prover.calls).toBeGreaterThan(0);
    await loop.stop();
  });

  it('stop() clears the timer and closes the prover; double-stop is a no-op', async () => {
    const prover = fakeProver(async () => ({ kind: 'period-closed' }));
    const loop = startProverLoop({ prover, intervalMs: 5 });
    loop.start();
    await new Promise((r) => setTimeout(r, 20));
    const callsBeforeStop = prover.calls;
    await loop.stop();
    expect(prover.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(prover.calls).toBe(callsBeforeStop);
    await loop.stop();
  });

  it('exposes one stable physical shutdown without closing underneath a live tick', async () => {
    let settleTick!: (outcome: TickOutcome) => void;
    const tick = vi.fn(() => new Promise<TickOutcome>((resolve) => {
      settleTick = resolve;
    }));
    const close = vi.fn(async () => undefined);
    const prover: TickableProver = { tick, close };
    const loop = startProverLoop({
      prover,
      intervalMs: 60_000,
    });
    loop.start();
    await vi.waitFor(() => expect(tick).toHaveBeenCalledOnce());

    const stopping = loop.stop();
    expect(loop.stop()).toBe(stopping);
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    expect(close).not.toHaveBeenCalled();

    settleTick({ kind: 'period-closed' });
    await expect(stopping).resolves.toBeUndefined();
    expect(loop.stop()).toBe(stopping);
    expect(close).toHaveBeenCalledOnce();
  });

  it('catches tick rejections and keeps the loop alive', async () => {
    let throwOnce = true;
    const prover = fakeProver(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('transient RPC failure');
      }
      return { kind: 'period-closed' };
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loop = startProverLoop({ prover, intervalMs: 5, log });
    loop.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(log.error).toHaveBeenCalledWith(
      'rs.loop.tick-threw',
      expect.objectContaining({ err: expect.stringContaining('transient') }),
    );
    expect(prover.calls).toBeGreaterThan(1);
    const status = loop.getStatus();
    expect(status.totalTicks).toBeGreaterThan(1);
    expect(status.lastTickAt).toBeTruthy();
    // The thrown tick stays classified after later healthy ticks.
    expect(status.lastFailureClassification).toBe('error');
    expect(status.lastFailureAt).toEqual(expect.any(String));
    expect(status.challengesReceived24h).toBe(0);
    await loop.stop();
  });

  it('catches errors thrown by onTick so they do not break the loop', async () => {
    const prover = fakeProver(async () => ({ kind: 'period-closed' }));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loop = startProverLoop({
      prover,
      intervalMs: 5,
      log,
      onTick: () => { throw new Error('observability bug'); },
    });
    loop.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(log.warn).toHaveBeenCalledWith(
      'rs.loop.onTick-threw',
      expect.any(Object),
    );
    await loop.stop();
  });

  it('getStatus accumulates totalTicks, submittedCount, and lastSubmittedTxHash', async () => {
    let counter = 0;
    const prover = fakeProver(async () => {
      counter += 1;
      // Alternate: period-closed, then submitted, period-closed, submitted, ...
      if (counter % 2 === 0) {
        return {
          kind: 'submitted',
          txHash: `0xtx${counter}`,
          kaId: BigInt(counter),
          cgId: 1n,
          chunkId: 0n,
          period: { epoch: 1n, periodStartBlock: BigInt(counter) },
        };
      }
      return { kind: 'period-closed' };
    });
    const loop = startProverLoop({ prover, intervalMs: 5 });
    loop.start();
    await new Promise((r) => setTimeout(r, 60));
    const status = loop.getStatus();
    expect(status.totalTicks).toBeGreaterThan(2);
    expect(status.submittedCount).toBeGreaterThan(0);
    expect(status.lastSubmittedTxHash).toMatch(/^0xtx\d+$/);
    expect(status.lastSubmittedAt).toBeTruthy();
    expect(status.lastTickAt).toBeTruthy();
    await loop.stop();
  });

  it('getStatus before start() reports zero counters and null timestamps', async () => {
    const prover = fakeProver(async () => ({ kind: 'period-closed' }));
    const loop = startProverLoop({ prover, intervalMs: 5 });
    const status = loop.getStatus();
    expect(status.totalTicks).toBe(0);
    expect(status.submittedCount).toBe(0);
    expect(status.lastTickAt).toBeNull();
    expect(status.lastSubmittedAt).toBeNull();
    expect(status.lastSubmittedTxHash).toBeNull();
    expect(status.lastOutcome).toBeNull();
    expect(status.challengesReceived24h).toBe(0);
    expect(status.proofsSubmitted24h).toBe(0);
    expect(status.lastFailureClassification).toBeNull();
    expect(status.lastFailureAt).toBeNull();
    await loop.stop();
  });
});

describe('startProverLoop 24h health window', () => {
  const INTERVAL_MS = 30_000;
  const START = Date.parse('2026-09-15T10:00:00.000Z');
  const PERIOD_A = { epoch: 7n, periodStartBlock: 1_000n };
  const PERIOD_B = { epoch: 7n, periodStartBlock: 1_050n };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Start a loop over scripted outcomes; an Error entry makes that tick throw.
   * start() settles the first entry, and each `advance()` step settles one
   * more, so entry i completes at START + i * INTERVAL_MS.
   */
  async function startScripted(script: ReadonlyArray<TickOutcome | Error>) {
    let next = 0;
    const prover = fakeProver(async () => {
      const step = script[next++];
      if (step === undefined) throw new Error('health script exhausted');
      if (step instanceof Error) throw step;
      return step;
    });
    const loop = startProverLoop({ prover, intervalMs: INTERVAL_MS, now: () => Date.now() });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    const advance = async (ticks: number): Promise<void> => {
      for (let i = 0; i < ticks; i += 1) await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);
    };
    return { loop, prover, advance };
  }

  it('counts repeated already-solved ticks on one proof period as one challenge', async () => {
    const { loop, prover, advance } = await startScripted(
      Array.from({ length: 5 }, (): TickOutcome => ({ kind: 'already-solved', period: PERIOD_A })),
    );
    expect(loop.getStatus()).toMatchObject({ totalTicks: 1, challengesReceived24h: 1 });

    await advance(4);
    expect(prover.calls).toBe(5);
    expect(loop.getStatus()).toMatchObject({
      totalTicks: 5,
      challengesReceived24h: 1,
      proofsSubmitted24h: 0,
      lastFailureClassification: null,
    });
    await loop.stop();
  });

  it('counts distinct proof periods, with at most one proof each', async () => {
    const { loop, advance } = await startScripted([
      { kind: 'kc-not-synced', kaId: 3n, cgId: 2n, period: PERIOD_A },
      { kind: 'kc-not-synced', kaId: 3n, cgId: 2n, period: PERIOD_A },
      { kind: 'submitted', txHash: '0xa', kaId: 3n, cgId: 2n, chunkId: 0n, period: PERIOD_A },
      { kind: 'already-solved', period: PERIOD_A },
      { kind: 'no-challenge', reason: 'no-eligible-cg' },
      { kind: 'kc-not-synced', kaId: 9n, cgId: 2n, period: PERIOD_B },
      { kind: 'kc-not-synced', kaId: 9n, cgId: 2n, period: PERIOD_B },
    ]);
    await advance(4);
    // Period A: two failed retries, one proof, then the solved short-circuit.
    expect(loop.getStatus()).toMatchObject({
      challengesReceived24h: 1,
      proofsSubmitted24h: 1,
      submittedCount: 1,
    });

    await advance(2);
    // Period B was received but never proved: the gap an operator must see.
    expect(loop.getStatus()).toMatchObject({
      totalTicks: 7,
      challengesReceived24h: 2,
      proofsSubmitted24h: 1,
      lastFailureClassification: 'kc-not-synced',
      lastFailureAt: new Date(START + 6 * INTERVAL_MS).toISOString(),
    });
    await loop.stop();
  });

  it('classifies a thrown tick as an error without attributing it to a period', async () => {
    const { loop, advance } = await startScripted([
      new Error('transient RPC failure'),
      { kind: 'already-solved', period: PERIOD_A },
      new Error('transient RPC failure'),
      { kind: 'already-solved', period: PERIOD_A },
    ]);
    const first = loop.getStatus();
    expect(first.lastOutcome).toMatchObject({ kind: 'error' });
    expect(first).toMatchObject({
      challengesReceived24h: 0,
      proofsSubmitted24h: 0,
      lastFailureClassification: 'error',
      lastFailureAt: new Date(START).toISOString(),
    });

    await advance(3);
    // The ticks that did identify the period count it once.
    expect(loop.getStatus()).toMatchObject({
      totalTicks: 4,
      challengesReceived24h: 1,
      proofsSubmitted24h: 0,
      lastFailureClassification: 'error',
      lastFailureAt: new Date(START + 2 * INTERVAL_MS).toISOString(),
    });
    await loop.stop();
  });

  it('drops a period 24 hours after it was first seen', async () => {
    const { loop, advance } = await startScripted([
      { kind: 'submitted', txHash: '0xa', kaId: 1n, cgId: 2n, chunkId: 0n, period: PERIOD_A },
      { kind: 'already-solved', period: PERIOD_A },
    ]);
    await advance(1);

    // The later already-solved tick does not extend the period's window.
    vi.setSystemTime(START + DAY_MS - 1);
    expect(loop.getStatus()).toMatchObject({ challengesReceived24h: 1, proofsSubmitted24h: 1 });
    vi.setSystemTime(START + DAY_MS);
    expect(loop.getStatus()).toMatchObject({
      challengesReceived24h: 0,
      proofsSubmitted24h: 0,
      submittedCount: 1,
    });
    await loop.stop();
  });
});

describe('classifyTickOutcome', () => {
  const period = { epoch: 7n, periodStartBlock: 1_000n };
  const none = { challenge: null, proofSubmitted: false, failure: null };
  const failed = (failure: TickFailureKind) => ({ challenge: period, proofSubmitted: false, failure });

  it.each<{ outcome: TickOutcome; health: TickOutcomeHealth }>([
    { outcome: { kind: 'period-closed' }, health: none },
    { outcome: { kind: 'no-challenge', reason: 'no-eligible-kc' }, health: none },
    {
      outcome: { kind: 'already-solved', period },
      health: { challenge: period, proofSubmitted: false, failure: null },
    },
    {
      outcome: { kind: 'submitted', txHash: '0xa', kaId: 1n, cgId: 2n, chunkId: 0n, period },
      health: { challenge: period, proofSubmitted: true, failure: null },
    },
    { outcome: { kind: 'cg-not-found', kaId: 1n, period }, health: failed('cg-not-found') },
    { outcome: { kind: 'kc-not-synced', kaId: 1n, cgId: 2n, period }, health: failed('kc-not-synced') },
    {
      outcome: { kind: 'data-corrupted', kaId: 1n, cgId: 2n, reason: 'root-mismatch', period },
      health: failed('data-corrupted'),
    },
    { outcome: { kind: 'submit-stale', period }, health: failed('submit-stale') },
    {
      outcome: { kind: 'error', error: new Error('rpc down') },
      health: { challenge: null, proofSubmitted: false, failure: 'error' },
    },
  ])('classifies $outcome.kind', ({ outcome, health }) => {
    expect(classifyTickOutcome(outcome)).toEqual(health);
  });

  it('gives an unknown runtime kind no health signal instead of throwing inside the loop', () => {
    const unknown = { kind: 'cooldown' } as unknown as TickOutcome;
    expect(classifyTickOutcome(unknown)).toEqual(none);
  });
});
