// SPDX-License-Identifier: Apache-2.0

import {
  ChainRpcTransportError,
  RpcEndpointsExhaustedError,
} from '@origintrail-official/dkg-chain';
import { describe, expect, it } from 'vitest';

import {
  Rfc64AuthorityReadCoordinatorV1,
  isRfc64AuthorityRpcCircuitOpenErrorV1,
} from '../src/rfc64/authority-rpc-circuit-breaker-v1.js';

function exhausted(retryAfterMs?: number): ChainRpcTransportError {
  return new RpcEndpointsExhaustedError(
    'authority read failed on every provider',
    {
      exhaustionKind: 'all-throttled',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}

function deterministicFailure(): Error {
  return Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
}

describe('RFC-64 authority RPC circuit breaker', () => {
  it('shares one open circuit across queued graph refreshes', async () => {
    let now = 1_000;
    let calls = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });

    const first = breaker.run(undefined, async () => {
      calls += 1;
      throw exhausted();
    });
    const queued = breaker.run(undefined, async () => {
      calls += 1;
      return 'must-not-run';
    });

    await expect(first).rejects.toMatchObject({ code: 'RPC_ENDPOINTS_EXHAUSTED' });
    await expect(queued).rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);
    expect(calls).toBe(1);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 1_100,
    });

    now = 1_099;
    await expect(breaker.run(undefined, async () => 'too-early'))
      .rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);
  });

  it('admits exactly one half-open probe and reopens when it exhausts', async () => {
    let now = 0;
    let calls = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    await expect(breaker.run(undefined, async () => {
      calls += 1;
      throw exhausted();
    })).rejects.toBeInstanceOf(ChainRpcTransportError);

    now = 100;
    let releaseProbe!: () => void;
    let markProbeStarted!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const probe = breaker.run(undefined, async () => {
      calls += 1;
      markProbeStarted();
      await probeGate;
      throw exhausted();
    });
    const queued = breaker.run(undefined, async () => {
      calls += 1;
      return 'must-not-run';
    });
    await probeStarted;
    expect(breaker.snapshot().state).toBe('half-open');
    expect(calls).toBe(2);
    releaseProbe();

    await expect(probe).rejects.toBeInstanceOf(ChainRpcTransportError);
    await expect(queued).rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);
    expect(calls).toBe(2);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 2,
      retryAtMs: 300,
    });
  });

  it('closes after a successful half-open probe and releases queued work', async () => {
    let now = 0;
    let calls = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    await expect(breaker.run(undefined, async () => {
      calls += 1;
      throw exhausted();
    })).rejects.toBeInstanceOf(ChainRpcTransportError);
    now = 100;

    const recovered = breaker.run(undefined, async () => {
      calls += 1;
      return 'recovered';
    });
    const next = breaker.run(undefined, async () => {
      calls += 1;
      return 'next-graph';
    });

    await expect(recovered).resolves.toBe('recovered');
    await expect(next).resolves.toBe('next-graph');
    expect(calls).toBe(3);
    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });
  });

  it('applies deterministic fleet jitter when no provider hint overrides it', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0.2,
      now: () => now,
      random: () => 1,
    });

    await expect(breaker.run(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot().retryAtMs).toBe(120);
  });

  it('honors Retry-After, exponential backoff, and the absolute cap', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0.2,
      now: () => now,
      random: () => 1,
    });

    await expect(breaker.run(undefined, async () => { throw exhausted(500); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot().retryAtMs).toBe(500);

    now = 500;
    await expect(breaker.run(undefined, async () => { throw exhausted(5_000); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 2,
      retryAtMs: 1_300,
    });
  });

  it('does not trip for deterministic failures', async () => {
    let calls = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
    });

    await expect(breaker.run(undefined, async () => {
      calls += 1;
      throw deterministicFailure();
    })).rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    expect(breaker.snapshot().state).toBe('closed');

    expect(calls).toBe(1);
  });

  it('settles a queued abort promptly without allowing later work to overtake', async () => {
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
    });
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = breaker.run(undefined, async () => {
      markStarted();
      await gate;
      return 'first';
    });
    await started;

    const controller = new AbortController();
    let cancelledCalls = 0;
    const second = breaker.run(controller.signal, async () => {
      cancelledCalls += 1;
      return 'must-not-run';
    });
    const third = breaker.run(undefined, async () => 'third');
    controller.abort(new Error('queued read cancelled'));

    await expect(second).rejects.toThrow('queued read cancelled');
    expect(cancelledCalls).toBe(0);
    await expect(Promise.race([
      third.then(() => 'overtook'),
      new Promise<string>((resolve) => setTimeout(() => resolve('still-queued'), 10)),
    ])).resolves.toBe('still-queued');
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(third).resolves.toBe('third');
    expect(cancelledCalls).toBe(0);
  });

  it('rejects unsafe timing configuration', () => {
    expect(() => new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 1_000,
      maxBackoffMs: 999,
    })).toThrow(/at least baseBackoffMs/u);
    expect(() => new Rfc64AuthorityReadCoordinatorV1({
      jitterRatio: 1.1,
    })).toThrow(/between 0 and 1/u);
  });
});
