// SPDX-License-Identifier: Apache-2.0

import {
  ChainRpcTransportError,
  EVMChainAdapter,
  RpcEndpointsExhaustedError,
  type ContextGraphAuthorityIndexId,
} from '@origintrail-official/dkg-chain';
import { ContextGraphAuthorityIndexProjectionCache } from
  '../../chain/src/context-graph-authority-index-projection.js';
import { MemoryAuthorityIndexStore } from
  '../../chain/test/helpers/context-graph-authority-index.js';
import {
  createAuthorityScenario,
  GOVERNANCE,
} from '../../chain/test/helpers/context-graph-authority-scenario.js';
import { describe, expect, it, vi } from 'vitest';

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
      evidence.agentResolverReadOptions().onRpcRead();
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
      evidence.agentResolverReadOptions().onRpcRead();
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
        evidence.agentResolverReadOptions().onContextGraphAuthorityProjectionServed?.({
          source: 'cache', ageMs: 40,
        });
        return 'served-from-cache';
      });
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('counts a completed scan as RPC health', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        evidence.agentResolverReadOptions().onContextGraphAuthorityProjectionServed?.({
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
        const options = evidence.agentResolverReadOptions();
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
        const options = evidence.agentResolverReadOptions();
        options.onContextGraphAuthorityProjectionServed?.({
          source: 'stale-cache', ageMs: T + 1,
        });
        options.onRpcRead();
        options.onContextGraphAuthorityProjectionServed?.({ source: 'scan', ageMs: 0 });
        return 'mixed-evidence';
      });
      expect(breaker.snapshot()).toMatchObject({ state: 'closed', consecutiveExhaustions: 0 });
    });

    it('still classifies a direct read\'s report when a consumer observes it too', async () => {
      const { breaker } = await halfOpenBreaker();
      const observed: string[] = [];
      await breaker.run(undefined, async (_signal, evidence) => {
        // Building the options is the eager attempt mark. Only the circuit's
        // own observer can void it, so the consumer's must not displace it.
        evidence.chainReadOptions(undefined, (served) => observed.push(served.source))
          .onContextGraphAuthorityProjectionServed?.({ source: 'log', ageMs: 0 });
        return 'folded';
      });
      expect(observed).toEqual(['log']);
      expect(breaker.snapshot()).toMatchObject({ state: 'half-open', consecutiveExhaustions: 1 });

      await breaker.run(undefined, async (_signal, evidence) => {
        evidence.chainReadOptions(undefined, (served) => observed.push(served.source))
          .onContextGraphAuthorityProjectionServed?.({ source: 'scan', ageMs: 0 });
        return 'scanned';
      });
      expect(observed).toEqual(['log', 'scan']);
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('does not let a cache hit that predates the exhaustion close the circuit', async () => {
      const { breaker } = await halfOpenBreaker();
      await breaker.run(undefined, async (_signal, evidence) => {
        const options = evidence.agentResolverReadOptions();
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
        origin: { kind: 'scan' as const },
      });
      const read = (
        cache: ContextGraphAuthorityIndexProjectionCache,
        observe?: Parameters<ContextGraphAuthorityIndexProjectionCache['read']>[0]['onServed'],
      ) => cache.read({
        scope,
        project: (projection) => ({ complete: true, value: projection }),
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
          evidence.agentResolverReadOptions().onContextGraphAuthorityProjectionServed,
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
          evidence.agentResolverReadOptions().onContextGraphAuthorityProjectionServed,
        );
        return 'newer-cache';
      });
      expect(newerBreaker.snapshot()).toEqual({
        state: 'closed',
        consecutiveExhaustions: 0,
        retryAtMs: null,
      });
    });

    it('keeps the circuit open when the one log serves while the pool is exhausted', async () => {
      // A fold out of node-local SQLite rows contacted NO endpoint. Reported
      // as `scan` it closed this circuit unconditionally (`provePool()`), so a
      // node answering every authority read from its own log looked healthy
      // while every provider was down — and then the whole refresh fan-out was
      // re-admitted against a pool that had never recovered.
      //
      // The anchor here is stamped AFTER the exhaustion on purpose. That is
      // the discriminating case: it is exactly when a `cache`-shaped branch
      // (prove if the fetch post-dates `#exhaustedAtMs`) would have credited
      // the fold. It must not, because the instant belongs to the background
      // tick's capped point read, not to a paged scan through this pool.
      const scope = 'deployment:0x0000000000000000000000000000000000000002';
      const clock = { now: 10_000 };
      const breaker = new Rfc64AuthorityReadCoordinatorV1({
        baseBackoffMs: 100,
        maxBackoffMs: 800,
        jitterRatio: 0,
        now: () => clock.now,
      });
      await expect(breaker.run(undefined, async () => { throw exhausted(); }))
        .rejects.toBeInstanceOf(ChainRpcTransportError);
      clock.now = 10_100;
      expect(breaker.snapshot().state).toBe('half-open');

      const cache = new ContextGraphAuthorityIndexProjectionCache({
        tickMs: T,
        now: () => clock.now,
      });
      // What the log fast path hands the cache: a completed projection that
      // declares the instant its DATA was fetched, because it fetched none.
      const folded = (dataFetchedAtMs: number) => async () => ({
        scope,
        chainId: '31337',
        contractAddress: '0x0000000000000000000000000000000000000002',
        finalized: { number: 10, hash: `0x${'10'.repeat(32)}` },
        head: {
          number: 10,
          hash: `0x${'10'.repeat(32)}`,
          timestampSeconds: Math.floor(clock.now / 1_000),
        },
        view: {} as never,
        origin: { kind: 'log' as const, dataFetchedAtMs },
      });
      const evidence: { source: string; ageMs: number }[] = [];
      const readFold = async (
        forward: Parameters<ContextGraphAuthorityIndexProjectionCache['read']>[0]['onServed'],
      ) => cache.read({
        scope,
        project: (projection) => ({ complete: true, value: projection }),
        // 50ms after the exhaustion: newer than `#exhaustedAtMs`, and still a fold.
        refresh: folded(10_050),
        onServed: (served) => {
          evidence.push({ ...served });
          forward?.(served);
        },
      });

      await breaker.run(undefined, async (_signal, probe) => {
        // Building `chainReadOptions` IS the eager `markRpcAttempt` — the
        // hazard at the top of this path. Nothing else here proves the pool,
        // so if the fold merely declined to prove it, that mark would stand
        // and the circuit would close on a read that touched no endpoint. The
        // fold has to VOID it.
        const options = probe.chainReadOptions();
        await readFold(options.onContextGraphAuthorityProjectionServed);
        return 'folded-from-the-log';
      });
      // The BEHAVIOUR first, so a regression reports what actually broke — a
      // circuit closed by local rows — rather than only a changed string.
      expect(breaker.snapshot()).toMatchObject({
        state: 'half-open',
        consecutiveExhaustions: 1,
      });
      expect(evidence).toEqual([{ source: 'log', ageMs: 50 }]);

      // The RETAINED fold, re-served by `#serve` inside the same tick. It must
      // not be relabelled `cache` on the way out: `cache` is credited when its
      // fetch post-dates the exhaustion, and this one's does.
      clock.now = 10_200;
      await breaker.run(undefined, async (_signal, probe) => {
        await readFold(probe.agentResolverReadOptions().onContextGraphAuthorityProjectionServed);
        return 're-served-fold';
      });
      expect(breaker.snapshot()).toMatchObject({
        state: 'half-open',
        consecutiveExhaustions: 1,
      });
      expect(evidence.at(-1)).toEqual({ source: 'log', ageMs: 150 });

      // And a real scan still closes it, so this is a truthfulness fix and not
      // a circuit that can no longer recover.
      await breaker.run(undefined, async (_signal, probe) => {
        probe.agentResolverReadOptions().onContextGraphAuthorityProjectionServed?.({
          source: 'scan', ageMs: 0,
        });
        return 'scanned';
      });
      expect(breaker.snapshot().state).toBe('closed');
    });

    it('forwards real adapter projection evidence through stale fallback and recovery', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(10_000);
      const scenario = createAuthorityScenario();
      let providerUnavailable = false;
      const adapter: any = new EVMChainAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        hubAddress: GOVERNANCE,
        privateKey: `0x${'11'.repeat(32)}`,
        allowNoAdminSigner: true,
        chainId: 'evm:31337',
        localContextGraphAuthorityIndexStore: new MemoryAuthorityIndexStore(),
        indexTickMs: T,
      });
      adapter.initialized = true;
      adapter.init = async () => undefined;

      const contract = {
        interface: {
          getEvent: (name: string) => ({ topicHash: `topic:${name}` }),
          parseLog: (log: { parsed: unknown }) => log.parsed,
        },
        filters: Object.fromEntries([
          'ContextGraphCreated',
          'ContextGraphDeactivated',
          'Transfer',
          'PublishPolicyUpdated',
          'PublishAuthorityUpdated',
          'AgentParticipantAdded',
          'AgentParticipantRemoved',
        ].map((name) => [name, () => ({ name })])),
        getAddress: async () => GOVERNANCE,
      };
      const provider = {
        getBlockNumber: () => scenario.getBlockNumber(),
        getBlock: async (tag: string | number) => {
          if (providerUnavailable) throw exhausted();
          const block = await scenario.getBlock(tag);
          return {
            ...block,
            timestamp: Math.floor(Date.now() / 1_000) - 2,
          };
        },
        getNetwork: async () => ({ chainId: 31_337n }),
        getLogs: async (filter: { fromBlock: number; toBlock: number }) => {
          if (providerUnavailable) throw exhausted();
          return scenario.renderParsedLogs(filter.fromBlock, filter.toBlock);
        },
      };
      adapter.contracts = {
        contextGraphStorage: { connect: () => contract, getAddress: contract.getAddress },
      };
      adapter.readTipProvider = async (
        _label: string,
        read: (selected: typeof provider) => Promise<unknown>,
      ) => read(provider);
      adapter.resolveContractDeployBlock = async () => ({
        fromBlock: 7,
        head: 30,
        scanProviders: [],
      });

      try {
        const reader = adapter.contextGraphAuthorityIndexRevisionReader!;
        const ids = ['9' as ContextGraphAuthorityIndexId];
        await reader.readContextGraphAuthorityIndexRevisions(ids);

        vi.advanceTimersByTime(T);
        const breaker = new Rfc64AuthorityReadCoordinatorV1({
          baseBackoffMs: 100,
          maxBackoffMs: 800,
          jitterRatio: 0,
          now: Date.now,
        });
        await expect(breaker.run(undefined, async () => { throw exhausted(); }))
          .rejects.toBeInstanceOf(ChainRpcTransportError);

        vi.advanceTimersByTime(100);
        providerUnavailable = true;
        await expect(breaker.run(undefined, (signal, evidence) =>
          reader.readContextGraphAuthorityIndexRevisions(
            ids,
            evidence.chainReadOptions(signal),
          )))
          .resolves.toBeInstanceOf(Map);
        expect(breaker.snapshot()).toMatchObject({
          state: 'half-open',
          consecutiveExhaustions: 1,
        });

        providerUnavailable = false;
        vi.advanceTimersByTime(T);
        await expect(breaker.run(undefined, (signal, evidence) =>
          reader.readContextGraphAuthorityIndexRevisions(
            ids,
            evidence.chainReadOptions(signal),
          )))
          .resolves.toBeInstanceOf(Map);
        expect(breaker.snapshot()).toEqual({
          state: 'closed',
          consecutiveExhaustions: 0,
          retryAtMs: null,
        });
      } finally {
        adapter.destroy();
        vi.useRealTimers();
      }
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

  it('admits a foreground read while the bulk serializer is busy', async () => {
    // The bulk queue is the anti-stampede mechanism for per-graph passes. A
    // latency-bounded foreground read must not inherit it, or it spends its
    // whole budget waiting behind a cold scan.
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
    });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let queuedReleased = false;
    const queued = breaker.run(undefined, async () => {
      entered.resolve();
      await release.promise;
      queuedReleased = true;
      return 'queued';
    });
    await entered.promise;

    await expect(breaker.runForeground(undefined, async () => 'foreground'))
      .resolves.toBe('foreground');
    expect(queuedReleased).toBe(false);

    release.resolve();
    await expect(queued).resolves.toBe('queued');
  });

  it('applies circuit state and evidence to a foreground read', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });

    // Skipping the BULK queue does not skip the circuit: exhaustion still
    // trips it.
    await expect(breaker.runForeground(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toMatchObject({ state: 'open', consecutiveExhaustions: 1 });
    await expect(breaker.runForeground(undefined, async () => 'must-not-run'))
      .rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);

    now = 100;
    await expect(breaker.runForeground(undefined, async () => 'local-only'))
      .resolves.toBe('local-only');
    expect(breaker.snapshot().state).toBe('half-open');

    await expect(breaker.runForeground(undefined, async (_signal, evidence) => {
      evidence.agentResolverReadOptions().onRpcRead();
      return 'provider-recovered';
    })).resolves.toBe('provider-recovered');
    expect(breaker.snapshot()).toEqual({
      state: 'closed',
      consecutiveExhaustions: 0,
      retryAtMs: null,
    });
  });

  it('does not let a read admitted before a trip erase the fresh exhaustion', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    // Admitted against a healthy pool and still in flight when the pool fails:
    // it reached the providers, but says nothing about the state they are in
    // now, so it must not count as recovery from the newer exhaustion.
    const stale = breaker.runForeground(undefined, async (_signal, evidence) => {
      evidence.agentResolverReadOptions().onRpcRead();
      entered.resolve();
      await release.promise;
      return 'stale-success';
    });
    await entered.promise;

    await expect(breaker.run(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });

    release.resolve();
    await expect(stale).resolves.toBe('stale-success');
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });
  });

  it('bounds a foreground fan-out to one probe against an exhausted pool', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    const release = Promise.withResolvers<void>();
    let providerReads = 0;
    // Registration discovery is fanned out once per candidate graph, so the
    // foreground lane admits one at a time and re-evaluates the gate after the
    // permit: once the first read trips the circuit its siblings are refused
    // instead of walking the same exhausted pool.
    const fanOut = Array.from({ length: 8 }, () => breaker.runForeground(
      undefined,
      async () => {
        providerReads += 1;
        await release.promise;
        throw exhausted();
      },
    ));
    release.resolve();

    await expect(fanOut[0]).rejects.toBeInstanceOf(ChainRpcTransportError);
    for (const refused of fanOut.slice(1)) {
      await expect(refused).rejects.toSatisfy(isRfc64AuthorityRpcCircuitOpenErrorV1);
    }
    // Counted in the operation body: the rejection types alone cannot show how
    // many reads actually reached a provider.
    expect(providerReads).toBe(1);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });
  });

  it('counts one backoff step per outage round across the two lanes', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    const release = Promise.withResolvers<void>();
    const enteredBulk = Promise.withResolvers<void>();
    const enteredForeground = Promise.withResolvers<void>();
    // Each lane has its own permit, so both of these are already past the gate
    // when the first of them exhausts. One outage must stay one step.
    const bulk = breaker.run(undefined, async () => {
      enteredBulk.resolve();
      await release.promise;
      throw exhausted();
    });
    const foreground = breaker.runForeground(undefined, async () => {
      enteredForeground.resolve();
      await release.promise;
      throw exhausted();
    });
    await Promise.all([enteredBulk.promise, enteredForeground.promise]);
    release.resolve();

    // Both reject with the PROVIDER's error rather than the circuit-open
    // deferral, which is what shows the second failure reached `#open`'s
    // coalescing branch instead of being turned away at the admission gate.
    await expect(bulk).rejects.toBeInstanceOf(ChainRpcTransportError);
    await expect(foreground).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });

    // Escalation still belongs to the read that fails past the deadline.
    now = 100;
    await expect(breaker.runForeground(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 2,
      retryAtMs: 300,
    });
  });

  it('keeps a mid-round cache answer from closing a coalesced outage', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });

    await expect(breaker.run(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });

    // A sibling of the SAME round fails again inside the window. The ladder is
    // coalesced, but the pool was observed failing at t=50, so the freshness
    // watermark must move with it.
    now = 50;
    await expect(breaker.run(
      undefined,
      async () => { throw exhausted(); },
      { admitWhileOpen: true },
    )).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });

    // Fetched at t=40: after the round's first failure but before its second,
    // so it is not proof that the pool recovered.
    now = 60;
    await breaker.run(undefined, async (_signal, evidence) => {
      evidence.agentResolverReadOptions().onContextGraphAuthorityProjectionServed?.({
        source: 'cache', ageMs: 20,
      });
      return 'served-from-mid-round-cache';
    }, { admitWhileOpen: true });
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });
  });

  it('extends the shared deadline for an in-window provider hint without escalating', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });

    await expect(breaker.run(undefined, async () => { throw exhausted(); }))
      .rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 100,
    });

    // A rare caller-initiated read is admitted mid-cooldown and is told by the
    // provider to back off far longer than the round's own step. Coalescing
    // owns the ladder, not the provider's instruction.
    now = 50;
    await expect(breaker.run(
      undefined,
      async () => { throw exhausted(600); },
      { admitWhileOpen: true },
    )).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 650,
    });

    // A later in-window sibling without a hint must not pull the deadline back.
    now = 60;
    await expect(breaker.run(
      undefined,
      async () => { throw exhausted(); },
      { admitWhileOpen: true },
    )).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 650,
    });

    // Nor may a shorter hint shorten it.
    now = 70;
    await expect(breaker.run(
      undefined,
      async () => { throw exhausted(10); },
      { admitWhileOpen: true },
    )).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot().retryAtMs).toBe(650);
  });

  it('keeps a cross-lane sibling\'s provider hint on the shared deadline', async () => {
    let now = 0;
    const breaker = new Rfc64AuthorityReadCoordinatorV1({
      baseBackoffMs: 100,
      maxBackoffMs: 800,
      jitterRatio: 0,
      now: () => now,
    });
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const enteredSecond = Promise.withResolvers<void>();

    // One sibling per lane, both admitted while the pool was healthy: the bulk
    // read trips the circuit, the foreground read then learns the provider's
    // own backoff.
    const first = breaker.run(undefined, async () => {
      await releaseFirst.promise;
      throw exhausted();
    });
    const second = breaker.runForeground(undefined, async () => {
      enteredSecond.resolve();
      await releaseSecond.promise;
      throw exhausted(600);
    });
    await enteredSecond.promise;

    releaseFirst.resolve();
    await expect(first).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot().retryAtMs).toBe(100);

    now = 50;
    releaseSecond.resolve();
    // It reaches the provider and rejects with the provider's error, so the
    // deadline moved through `#open`'s coalescing branch, not the gate.
    await expect(second).rejects.toBeInstanceOf(ChainRpcTransportError);
    expect(breaker.snapshot()).toEqual({
      state: 'open',
      consecutiveExhaustions: 1,
      retryAtMs: 650,
    });
  });

  it('retires a foreground read before close settles', async () => {
    const breaker = new Rfc64AuthorityReadCoordinatorV1();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<AbortSignal>();
    let operationFinished = false;
    const read = breaker.runForeground(undefined, async (signal) => {
      entered.resolve(signal);
      await release.promise;
      operationFinished = true;
      return 'done';
    });
    const signal = await entered.promise;

    let settled = false;
    const closing = breaker.close().then(() => { settled = true; });
    expect(signal.aborted).toBe(true);
    // Both lanes settle their caller on its own abort rather than leaving it
    // waiting on a read the coordinator has already given up on.
    await expect(read).rejects.toThrow(/coordinator is closing/u);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // Retirement is the separate guarantee: the physical read is still running,
    // so shutdown must not report itself complete yet.
    expect(settled).toBe(false);
    expect(operationFinished).toBe(false);

    release.resolve();
    await closing;
    expect(settled).toBe(true);
    expect(operationFinished).toBe(true);
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
