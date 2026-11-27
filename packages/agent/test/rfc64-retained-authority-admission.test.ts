// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { RpcEndpointsExhaustedError } from '@origintrail-official/dkg-chain';
import { Rfc64AuthorityReadCoordinatorV1, type Rfc64AuthorityRpcProbeEvidenceV1 } from '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

const exhausted = () => new RpcEndpointsExhaustedError('pool exhausted', { exhaustionKind: 'all-throttled' });
function fixture() {
  let now = 1000;
  const coordinator = new Rfc64AuthorityReadCoordinatorV1({ now: () => now, baseBackoffMs: 100, maxBackoffMs: 800, jitterRatio: 0 });
  return { coordinator, advance: () => { now += 100; },
    trip: () => expect(coordinator.run(undefined, async () => { throw exhausted(); })).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' }) };
}

describe('retained authority admission', () => {
  it('chooses retained evidence only after the foreground permit observes a trip', async () => {
    const { coordinator } = fixture();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const first = coordinator.runForeground(undefined, async () => { await gate; throw exhausted(); });
    const firstResult = expect(first).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    const normal = vi.fn(async () => 'rpc');
    const retainedFallback = vi.fn(async () => 'retained');
    const queued = coordinator.runForeground(undefined, normal, { retainedFallback });
    expect(retainedFallback).not.toHaveBeenCalled();
    release();
    await firstResult;
    await expect(queued).resolves.toBe('retained');
    expect(normal).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toEqual({ state: 'open', consecutiveExhaustions: 1, retryAtMs: 1100 });
  });

  it('owns repeated miss deferral and returns to the normal RPC recovery path after cooldown', async () => {
    const { coordinator, trip, advance } = fixture();
    await trip();
    const normal = vi.fn(async (signal: AbortSignal, evidence: Rfc64AuthorityRpcProbeEvidenceV1) => { evidence.chainReadOptions(signal); return 'rpc'; });
    const retainedFallback = vi.fn(async () => undefined);
    for (let i = 0; i < 2; i++) {
      await expect(coordinator.runForeground(undefined, normal, { retainedFallback }))
        .rejects.toMatchObject({ code: 'RFC64_AUTHORITY_RPC_CIRCUIT_OPEN', retryAtMs: 1100, retryAfterMs: 100 });
    }
    expect(normal).not.toHaveBeenCalled();
    expect(retainedFallback).toHaveBeenCalledTimes(2);
    advance();
    await expect(coordinator.runForeground(undefined, normal, { retainedFallback })).resolves.toBe('rpc');
    expect(normal).toHaveBeenCalledTimes(1);
    expect(retainedFallback).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot().state).toBe('closed');
  });

  it('does not return retained evidence after cancellation or run a cancelled queued fallback', async () => {
    const { coordinator, trip } = fixture();
    await trip();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const normal = vi.fn(async () => 'rpc');
    const first = coordinator.runForeground(controller.signal, normal, { retainedFallback: async () => { started(); await gate; return 'late'; } });
    await ready;
    const queuedFallback = vi.fn(async () => 'must not run');
    const queued = coordinator.runForeground(controller.signal, normal, { retainedFallback: queuedFallback });
    const settlements = Promise.allSettled([first, queued]);
    controller.abort(reason);
    expect(await settlements).toEqual([{ status: 'rejected', reason }, { status: 'rejected', reason }]);
    release();
    await coordinator.whenIdle();
    expect(queuedFallback).not.toHaveBeenCalled();
    expect(normal).not.toHaveBeenCalled();
    expect(coordinator.snapshot().state).toBe('open');
  });
});
