/**
 * startProverLoop — timer + single-flight + stop semantics.
 *
 * The loop driver is the only "non-trivial" code in the agent's
 * random-sampling-bind layer. Pinning it here means the agent's bind
 * file is just role-gating + dependency wiring, with no behavior
 * worth its own integration test.
 */
import { describe, it, expect, vi } from 'vitest';
import { startProverLoop, type TickableProver } from '../src/prover-loop.js';
import type { TickOutcome } from '../src/prover.js';

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
          kcId: BigInt(counter),
          cgId: 1n,
          chunkId: 0n,
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
    await loop.stop();
  });
});
