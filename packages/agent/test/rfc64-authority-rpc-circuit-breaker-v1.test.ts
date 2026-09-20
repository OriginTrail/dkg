// SPDX-License-Identifier: Apache-2.0

import {
  ChainRpcTransportError,
  RpcEndpointsExhaustedError,
} from '@origintrail-official/dkg-chain';
import { ContextGraphAuthorityIndexProjectionCache } from
  '../../chain/src/context-graph-authority-index-projection.js';
import { describe, expect, it } from 'vitest';

import {
  Rfc64AuthorityReadCoordinatorV1,
  isRfc64AuthorityRpcCircuitOpenErrorV1,
} from '../src/rfc64/authority-rpc-circuit-breaker-v1.js';
import { RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1 } from
  '../src/rfc64/catalog-authority-config-v1.js';

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
  it('keeps projection stale-if-error reuse inside the RFC-64 refresh interval', () => {
    expect(new ContextGraphAuthorityIndexProjectionCache({ tickMs: 180_000 }).staleMs)
      .toBeLessThanOrEqual(RFC64_CATALOG_AUTHORITY_REFRESH_POLICY_V1.intervalMs);
  });

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

    const recovered = breaker.run(undefined, async (_signal, evidence) => {
      calls += 1;
      evidence.agentReadOptions().onRpcRead();
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

  it('does not let a local result close a half-open provider circuit', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    await expect(breaker.run(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    now = 100;

    await expect(breaker.run(undefined, async () => 'local-only'))
      .resolves.toBe('local-only');
    expect(breaker.snapshot()).toEqual({
      state: 'half-open',
      consecutiveExhaustions: 1,
      retryAtMs: null,
    });

    await expect(breaker.run(undefined, async (_signal, evidence) => {
      evidence.agentReadOptions().onRpcRead();
      return 'provider-recovered';
    })).resolves.toBe('provider-recovered');
    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });
  });

  describe('projection-cache evidence', () => {
    const T = 6_000;
    async function halfOpenBreaker() {
      const clock = { now: 10_000 };
      const breaker = new Rfc64AuthorityReadCoordinatorV1({
        baseBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        now: () => clock.now,
      });
      await expect(breaker.run(undefined, async () => { throw exhausted(); }))
        .rejects.toBeInstanceOf(ChainRpcTransportError);
      clock.now += 100;
      expect(breaker.snapshot().state).toBe('half-open');
      return { breaker, clock };
    }

    it('counts a cache hit younger than T, fetched after the exhaustion, as RPC health', async () => {
      const { breaker, clock } = await halfOpenBreaker();
      clock.now += 50;
      // No onRpcRead callback: the projection's own account is the whole evidence.
      await breaker.run(undefined, async (_signal, evidence) => {
        evidence.agentReadOptions().onContextGraphAuthorityProjectionServed?.({
          source: 'cache', ageMs: 40,
        });
        return 'served-from-cache';
      });
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('counts a completed scan as RPC health', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        evidence.agentReadOptions().onContextGraphAuthorityProjectionServed?.({
          source: 'scan', ageMs: 0,
        });
        return 'scanned';
      });
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('does not let a projection served despite a failed refresh close the circuit', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        // Callers mark BEFORE they read; the stale answer voids that mark.
        const options = evidence.agentReadOptions();
        options.onRpcRead();
        options.onContextGraphAuthorityProjectionServed?.({
          source: 'stale-cache', ageMs: T + 1,
        });
        return 'served-stale';
      });
      expect(breaker.snapshot()).toMatchObject({ state: 'half-open', consecutiveExhaustions: 1 });
    });

    it('lets a later completed scan override earlier unproven projection evidence', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        const options = evidence.agentReadOptions();
        options.onContextGraphAuthorityProjectionServed?.({
          source: 'stale-cache', ageMs: T + 1,
        });
        options.onRpcRead();
        options.onContextGraphAuthorityProjectionServed?.({ source: 'scan', ageMs: 0 });
        return 'mixed-evidence';
      });
      expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveExhaustions: 0 });
    });

    it('does not let a cache hit that predates the exhaustion close the circuit', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        const options = evidence.agentReadOptions();
        options.onRpcRead();
        // Fetched 101ms ago: 1ms BEFORE the pool was seen exhausted.
        options.onContextGraphAuthorityProjectionServed?.({ source: 'cache', ageMs: 101 });
        return 'served-from-older-cache';
      });
      expect(breaker.snapshot().state).toBe('half-open');
    });

    it('uses the real projection cache age basis on both sides of exhaustion', async () => {
      const scope = 'deployment:0x0000000000000000000000000000000000000001';
      const clock = { now: 9_900 };
      const completed = () => ({
        scope,
        chainId: '31337',
        contractAddress: '0x0000000000000000000000000000000000000001',
        finalized: { number: 10, hash: `0x${'10'.repeat(32)}` },
        head: {
          number: 10,
          hash: `0x${'10'.repeat(32)}`,
          timestampSeconds: Math.floor(clock.now / 1_000),
        },
        view: {} as never,
      });
      const read = (
        cache: ContextGraphAuthorityIndexProjectionCache,
        observe?: Parameters<ContextGraphAuthorityIndexProjectionCache['read']>[0]['onServed'],
      ) => cache.read({
        scope,
        accepts: () => true,
        refresh: async () => completed(),
        ...(observe === undefined ? {} : { onServed: observe }),
      });

      const olderCache = new ContextGraphAuthorityIndexProjectionCache({
        tickMs: T,
        now: () => clock.now,
      });
      await read(olderCache);
      clock.now = 10_000;
      const olderBreaker = new Rfc64AuthorityReadCoordinatorV1({
        baseBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        now: () => clock.now,
      });
      await expect(olderBreaker.run(undefined, async () => { throw exhausted(); }))
        .rejects.toBeInstanceOf(ChainRpcTransportError);
      clock.now = 10_100;
      await olderBreaker.run(undefined, async (_signal, evidence) => {
        await read(
          olderCache,
          evidence.agentReadOptions().onContextGraphAuthorityProjectionServed,
        );
        return 'older-cache';
      });
      expect(olderBreaker.snapshot()).toMatchObject({ state: 'half-open' });

      const newerCache = new ContextGraphAuthorityIndexProjectionCache({
        tickMs: T,
        now: () => clock.now,
      });
      const newerBreaker = new Rfc64AuthorityReadCoordinatorV1({
        baseBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        now: () => clock.now,
      });
      await expect(newerBreaker.run(undefined, async () => { throw exhausted(); }))
        .rejects.toBeInstanceOf(ChainRpcTransportError);
      clock.now = 10_200;
      await read(newerCache);
      clock.now = 10_201;
      await newerBreaker.run(undefined, async (_signal, evidence) => {
        await read(
          newerCache,
          evidence.agentReadOptions().onContextGraphAuthorityProjectionServed,
        );
        return 'newer-cache';
      });
      expect(newerBreaker.snapshot()).toEqual({
        state: 'closed',
        consecutiveExhaustions: 0,
        retryAtMs: null,
      });
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
