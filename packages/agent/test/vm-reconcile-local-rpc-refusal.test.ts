/**
 * After its read-authority check a VM reconcile pass reads the chain again:
 * the graph's asset count, the head block, and each ordinal it resolves. When
 * the node's own RPC admission refuses one of those reads, nothing was sent,
 * so the pass says nothing about the graph. The graph is asked again shortly
 * instead of waiting for its turn in the periodic sweep.
 *
 * The host tests run the production target resolution, pass, engine deps,
 * dispatcher and wait. Only the chain adapter's reads are scripted, together
 * with the peers a recovery would ask.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChainRpcTransportError,
  RpcEndpointsExhaustedError,
  RpcRequestGovernorQueueFullError,
  type ChainAdapter,
  type ContextGraphLiveAuthority,
} from '@origintrail-official/dkg-chain';
import {
  askVmReconcileAgainAfterLocalRpcRefusal,
  isLocalRpcRefusal,
  VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS,
  VmReconcileLocalRpcRefusalError,
  VmReconcileLocalRpcRefusalWindow,
  VmReconcileRefusedSliceReads,
} from '../src/internal/vm-reconcile-local-rpc-refusal.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import type { ContextGraphReconcileResult } from '../src/vm-reconcile-service.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const CORE = '12D3KooWLocalRpcRefusalCore';
const localCgId = '0x0000000000000000000000000000000000000001/local-rpc-refusal';
/** The wait's delay after an attempt that was refused. */
const RETRY_MS = 2_500;
const WINDOW_MS = VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS;

/** What the transport raises when a read's deadline ran out in the node's own RPC queue. */
function notSent(read: string): ChainRpcTransportError {
  return new ChainRpcTransportError(
    'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
    `${read} via RPC #1 waited 4000ms for local RPC admission and was not sent`,
  );
}
const COUNT_NOT_SENT = 'cgStorage.getContextGraphKaCount via RPC #1 waited 4000ms for local RPC admission and was not sent';
const waitingLine = (contextGraphId: string, refusal: string): string =>
  `VM reconcile for "${contextGraphId}" is waiting for local RPC admission; asking again shortly: ${refusal}`;
const sweepLine = (contextGraphId: string, failure: string): string =>
  `VM reconcile for "${contextGraphId}" failed; retrying on the periodic sweep: ${failure}`;
/** The chain answered: the call reverted. Final for the pass, not a missing answer. */
const reverted = (): Error => Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });

type Step<T> = () => T | Promise<T>;
/** A read that takes the next step of its script each time; the last step repeats. */
function scripted<TArgs extends unknown[], T>(...script: Step<T>[]) {
  let next = 0;
  return vi.fn(async (..._args: TArgs): Promise<T> => script[Math.min(next++, script.length - 1)]!());
}
const refuse = (read: string): Step<never> => () => { throw notSent(read); };

/** The private host seams these tests reach. Everything else is the agent's own. */
interface HostSeams {
  subscribedContextGraphs: Map<string, unknown>;
  startVmRefreshWorker: () => void;
  healStrandedScopedKCs: () => Promise<undefined>;
  reconcileChainOrdinal?: (
    localCgId: string, onChainCgId: bigint, ordinal: number, ...rest: unknown[]
  ) => Promise<unknown>;
  log: Record<'info' | 'debug' | 'warn', (context: unknown, message: string) => void>;
  ensureVmReconcileScheduling(): VmReconcileSchedulingRuntime<ContextGraphReconcileResult>;
}

/**
 * A subscribed, bound public graph whose read-authority check answers. The
 * graph has `assets` registered assets; the count, head and ordinal reads are
 * the caller's scripts. With an `ordinal` script the agent's own ordinal
 * resolution runs, except for the ordinals in `settled`: those reconcile at
 * once, since promoting an asset needs a store and peers these tests leave out.
 */
async function subscribedHost(reads: {
  count: ReturnType<typeof scripted<[bigint], bigint>>;
  head?: ReturnType<typeof scripted<[], number>>;
  ordinal?: (contextGraphId: bigint, index: bigint) => Promise<bigint>;
  assets?: number;
  settled?: ReadonlySet<number>;
}) {
  const h = await createVmRecoveryHostHarness({
    name: 'VmLocalRpcRefusal', localCgId, peers: [CORE], targetCount: reads.assets ?? 0,
    targetForOrdinal: (ordinal) => ({
      localCgId, onChainCgId: '1', ordinal, reason: 'no-swm' as const,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    }),
    onFetch: () => 'found',
  });
  const seams = h.agent as unknown as HostSeams;
  seams.subscribedContextGraphs.set(localCgId, {
    subscribed: true, synced: false, syncMode: 'always-on', onChainId: h.contextGraphId.toString(),
  });
  const authority = vi.fn(async (): Promise<ContextGraphLiveAuthority> => (
    { active: true, accessPolicy: 0, participantAgents: [] }
  ));
  const chain: ChainAdapter = h.chainAdapter;
  chain.getContextGraphLiveAuthority = authority;
  chain.getContextGraphKCCount = reads.count;
  chain.getBlockNumber = reads.head ?? scripted<[], number>(() => 100);
  const ordinal = reads.ordinal ? vi.fn(reads.ordinal) : undefined;
  /** Every ordinal a pass visited, settled or not, in the order they were visited. */
  const visited: number[] = [];
  if (ordinal) {
    chain.getContextGraphKCAt = ordinal;
    // Drop the harness stand-in: the method is the agent's own again.
    delete seams.reconcileChainOrdinal;
    const resolveOrdinal = seams.reconcileChainOrdinal!;
    seams.reconcileChainOrdinal = (cgId, onChainCgId, index, ...rest) => {
      visited.push(index);
      return reads.settled?.has(index)
        ? Promise.resolve({ status: 'reconciled', blockNumber: 100 })
        : resolveOrdinal.call(h.agent, cgId, onChainCgId, index, ...rest);
    };
  }
  // Work beside and after the slice that these tests do not look at.
  seams.startVmRefreshWorker = () => undefined;
  const heal = vi.fn(async () => undefined);
  seams.healStrandedScopedKCs = heal;

  const info = vi.spyOn(seams.log, 'info');
  const debug = vi.spyOn(seams.log, 'debug');
  const warn = vi.spyOn(seams.log, 'warn');
  const messages = (spy: typeof info): string[] => spy.mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('VM reconcile for'));
  const runtime = seams.ensureVmReconcileScheduling();
  return {
    h, seams, runtime, authority, heal, count: reads.count, head: reads.head, ordinal, visited,
    logged: { info: () => messages(info), debug: () => messages(debug), warn: () => messages(warn) },
    async close() {
      await runtime.close();
      vi.useRealTimers();
      await h.agent.stop();
    },
  };
}

function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
}

afterEach(() => { vi.useRealTimers(); });

describe('VM reconcile whose asset-count read the node did not send', () => {
  it('asks again after one delay, without the periodic sweep', async () => {
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(refuse('cgStorage.getContextGraphKaCount'), () => 0n),
    });
    const { runtime, authority, count, logged } = host;
    useFakeClock();
    try {
      // The nudge a chain event sends for an asset registered to the graph.
      const pass = runtime.dispatch(localCgId, 'live').then(() => undefined, (error: unknown) => error);
      await runtime.waitForIdle();
      // The pass had its authority answer; the read after it was refused.
      expect(authority).toHaveBeenCalledTimes(1);
      expect(count).toHaveBeenCalledTimes(1);
      const ended = await pass;
      expect(ended).toBeInstanceOf(VmReconcileLocalRpcRefusalError);
      expect(ended).toMatchObject({ message: COUNT_NOT_SENT, cause: { code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' } });

      // It ended as a failed pass: another chain event's nudge is held, as
      // after any failed pass. Only the wait asks again.
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);

      // No sweep ran and nothing nudged the graph from outside.
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
      expect(authority).toHaveBeenCalledTimes(2);

      // Nothing was left to the sweep, and the log says why.
      expect(logged.warn()).toEqual([]);
      expect(logged.info()).toEqual([waitingLine(localCgId, COUNT_NOT_SENT)]);
      expect(logged.debug()).toEqual([]);

      // The graph is no longer waiting, and its live nudges run again.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(3);
    } finally {
      await host.close();
    }
  });

  it('keeps asking, one attempt per delay, while the read is still refused', async () => {
    const refused = refuse('cgStorage.getContextGraphKaCount');
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(refused, refused, refused, () => 0n),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      for (const attempt of [2, 3]) {
        await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
        await runtime.waitForIdle();
        expect(count).toHaveBeenCalledTimes(attempt - 1);
        await vi.advanceTimersByTimeAsync(1);
        await runtime.waitForIdle();
        expect(count).toHaveBeenCalledTimes(attempt);
      }
      // Said once where an operator sees it; the repeats stay at debug level.
      expect(logged.info()).toEqual([waitingLine(localCgId, COUNT_NOT_SENT)]);
      expect(logged.debug()).toEqual([
        waitingLine(localCgId, COUNT_NOT_SENT),
        waitingLine(localCgId, COUNT_NOT_SENT),
      ]);
      expect(logged.warn()).toEqual([]);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(4);
    } finally {
      await host.close();
    }
  });

  it('stops asking when its window has run out, and is left to the sweep until a pass gets through', async () => {
    let lane: 'closed' | 'open' = 'closed';
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(() => {
        if (lane === 'closed') throw notSent('cgStorage.getContextGraphKaCount');
        return 0n;
      }),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      // One attempt per delay for as long as the window is open.
      const retries = WINDOW_MS / RETRY_MS;
      for (let retry = 1; retry <= retries; retry++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await runtime.waitForIdle();
        expect(count).toHaveBeenCalledTimes(1 + retry);
      }
      // The attempt that ended past the window was not parked: it failed the
      // way every such pass did before, and the graph waits for the sweep.
      expect(logged.info()).toEqual([waitingLine(localCgId, COUNT_NOT_SENT)]);
      expect(logged.debug()).toHaveLength(retries - 1);
      expect(logged.warn()).toEqual([sweepLine(localCgId, COUNT_NOT_SENT)]);
      await vi.advanceTimersByTimeAsync(4 * WINDOW_MS);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1 + retries);

      // The sweep's own pass is refused as well. It opens no new window.
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2 + retries);
      expect(logged.warn()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(4 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2 + retries);

      // Nor does an operator's request that is refused: the sweep pass after
      // it is still not asked again.
      await expect(runtime.triggerManual(localCgId)).rejects.toMatchObject({ message: COUNT_NOT_SENT });
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      await vi.advanceTimersByTimeAsync(4 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(4 + retries);
      expect(logged.info()).toHaveLength(1);
      expect(logged.warn()).toHaveLength(3);

      // A pass that gets through closes the window ...
      lane = 'open';
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(5 + retries);
      // ... so the next refusal is asked again shortly, like the first.
      lane = 'closed';
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(6 + retries);
      expect(logged.info()).toHaveLength(2);
      lane = 'open';
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(7 + retries);
      expect(logged.warn()).toHaveLength(3);
    } finally {
      await host.close();
    }
  });

  it('gives a periodic pass the same wait, and lets a sweep visit settle a waiting graph', async () => {
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(refuse('cgStorage.getContextGraphKaCount'), () => 0n),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(logged.info()).toEqual([waitingLine(localCgId, COUNT_NOT_SENT)]);
      expect(logged.warn()).toEqual([]);

      // The sweep still visits a waiting graph. Its pass gets through, so the
      // graph is no longer waiting when the delay runs out.
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('treats a full admission queue like a read that waited too long', async () => {
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(() => { throw new RpcRequestGovernorQueueFullError(256); }, () => 0n),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(logged.info()).toEqual([
        waitingLine(localCgId, 'RPC request governor queue is full (256 requests)'),
      ]);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
      expect(logged.warn()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('leaves an operator request the failure it always was', async () => {
    const refusal = notSent('cgStorage.getContextGraphKaCount');
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(() => { throw refusal; }, () => 0n),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      const failure = await runtime.triggerManual(localCgId).then(() => undefined, (error: unknown) => error);
      expect(failure).toBe(refusal);

      // Nothing was parked on the operator's behalf.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);
      expect(logged.info()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it.each([
    ['the chain answered with a revert', reverted, 'execution reverted'],
    [
      'every endpoint failed the read',
      () => new RpcEndpointsExhaustedError('cgStorage.getContextGraphKaCount failed on all 2 RPC endpoints'),
      'cgStorage.getContextGraphKaCount failed on all 2 RPC endpoints',
    ],
    [
      'the read was sent and timed out',
      () => new ChainRpcTransportError('RPC_TIMEOUT', 'cgStorage.getContextGraphKaCount timed out after 4000ms'),
      'cgStorage.getContextGraphKaCount timed out after 4000ms',
    ],
  ])('still fails the pass and waits for the sweep when %s', async (_case, failure, message) => {
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(() => { throw failure(); }),
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(logged.warn()).toEqual([sweepLine(localCgId, message)]);
      expect(logged.info()).toEqual([]);

      // No wait, and a live nudge is held as after any failed pass.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);

      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });
});

describe('VM reconcile that goes on without a read the node did not send', () => {
  it('asks again when the head block was not read, and heals only after the slice that did its work', async () => {
    const host = await subscribedHost({
      assets: 1,
      count: scripted<[bigint], bigint>(() => 1n),
      head: scripted<[], number>(refuse('getBlockNumber'), () => 100),
    });
    const { h, runtime, head, heal, logged } = host;
    h.recovered.add(0);
    useFakeClock();
    try {
      // The engine holds the watermark and ends the slice; the pass succeeds.
      const first = await runtime.dispatch(localCgId, 'live');
      expect(first).toMatchObject({ status: 'pending', reconciledOrdinals: 0, unresolvedOrdinals: 1 });
      expect(logged.info()).toEqual([waitingLine(
        localCgId,
        'getBlockNumber via RPC #1 waited 4000ms for local RPC admission and was not sent',
      )]);
      expect(heal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(2);
      expect(heal).toHaveBeenCalledTimes(1);
      expect(logged.warn()).toEqual([]);

      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('asks again when an ordinal was not resolved, but not when the chain answered for it', async () => {
    let refused = 1;
    const host = await subscribedHost({
      assets: 1,
      count: scripted<[bigint], bigint>(() => 1n),
      ordinal: async () => {
        if (refused-- > 0) throw notSent('cgStorage.getContextGraphKaAt');
        throw reverted();
      },
    });
    const { runtime, ordinal, heal, logged } = host;
    useFakeClock();
    try {
      // The ordinal stays pending and the pass succeeds, as before.
      const first = await runtime.dispatch(localCgId, 'live');
      expect(first).toMatchObject({ status: 'pending', unresolvedOrdinals: 1 });
      expect(logged.info()).toEqual([waitingLine(
        localCgId,
        'cgStorage.getContextGraphKaAt via RPC #1 waited 4000ms for local RPC admission and was not sent',
      )]);
      expect(heal).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(ordinal).toHaveBeenCalledTimes(2);
      // The chain answered this time: the ordinal waits for a later pass.
      expect(heal).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(ordinal).toHaveBeenCalledTimes(2);
      expect(logged.info()).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it('asks again for the unresolved ordinal alone when every other one settled', async () => {
    let refused = 1;
    const host = await subscribedHost({
      assets: 2,
      settled: new Set([0]),
      count: scripted<[bigint], bigint>(() => 2n),
      ordinal: async () => {
        if (refused-- > 0) throw notSent('cgStorage.getContextGraphKaAt');
        throw reverted();
      },
    });
    const { runtime, ordinal, visited, logged } = host;
    useFakeClock();
    try {
      const first = await runtime.dispatch(localCgId, 'live');
      expect(first).toMatchObject({ status: 'progress', reconciledOrdinals: 1, unresolvedOrdinals: 1 });
      expect([...visited].sort()).toEqual([0, 1]);
      expect(logged.info()).toHaveLength(1);

      // The retry visits the ordinal that was refused, not the one that settled.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(visited.slice(2)).toEqual([1]);
      expect(ordinal).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('asks again when none of a slice\'s ordinals was resolved, and then goes on to the ones it had not visited', async () => {
    let refused = true;
    const host = await subscribedHost({
      count: scripted<[bigint], bigint>(() => 15n),
      ordinal: async () => {
        if (refused) throw notSent('cgStorage.getContextGraphKaAt');
        throw reverted();
      },
    });
    const { runtime, ordinal, logged } = host;
    useFakeClock();
    try {
      // More ordinals are outstanding than one slice visits.
      const first = await runtime.dispatch(localCgId, 'live');
      expect(first).toMatchObject({ status: 'pending', reconciledOrdinals: 0, unresolvedOrdinals: 15 });
      const firstSlice = new Set(ordinal?.mock.calls.map(([, index]) => index));
      expect(firstSlice.size).toBeLessThan(15);
      expect(logged.info()).toHaveLength(1);

      // The chain answers from here on.
      refused = false;
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      const visited = new Set(ordinal?.mock.calls.map(([, index]) => index));
      expect(visited.size).toBeGreaterThan(firstSlice.size);
      // Those ordinals were answered for: the slice is not asked again.
      const reads = ordinal?.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(ordinal).toHaveBeenCalledTimes(reads ?? 0);
      expect(logged.info()).toHaveLength(1);
    } finally {
      await host.close();
    }
  });

  it('leaves a slice with other ordinals pending to the sweep, as before', async () => {
    const host = await subscribedHost({
      assets: 2,
      count: scripted<[bigint], bigint>(() => 2n),
      // The first ordinal's read is refused; the chain answers for the second.
      ordinal: async (_contextGraphId, index) => {
        if (index === 0n) throw notSent('cgStorage.getContextGraphKaAt');
        throw reverted();
      },
    });
    const { runtime, ordinal, heal, logged } = host;
    useFakeClock();
    try {
      const first = await runtime.dispatch(localCgId, 'live');
      expect(first).toMatchObject({ status: 'pending', unresolvedOrdinals: 2 });
      // Asking again would read the answered ordinal a second time.
      expect(logged.info()).toEqual([]);
      expect(heal).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(ordinal).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('stops asking for a head block when the window has run out, and the slice ends as before', async () => {
    const host = await subscribedHost({
      assets: 1,
      count: scripted<[bigint], bigint>(() => 1n),
      head: scripted<[], number>(refuse('getBlockNumber')),
    });
    const { runtime, head, heal, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      const retries = WINDOW_MS / RETRY_MS;
      for (let retry = 1; retry <= retries; retry++) {
        // Asked again, the graph gets no heal: its slice has not done its work.
        expect(heal).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await runtime.waitForIdle();
        expect(head).toHaveBeenCalledTimes(1 + retry);
      }
      // Past the window the pass ends as it did before: no wait, the heal runs.
      expect(heal).toHaveBeenCalledTimes(1);
      expect(logged.info()).toHaveLength(1);
      expect(logged.warn()).toEqual([]);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(1 + retries);
    } finally {
      await host.close();
    }
  });

  it('does not ask again for a head block an endpoint failed to give', async () => {
    const host = await subscribedHost({
      assets: 1,
      count: scripted<[bigint], bigint>(() => 1n),
      head: scripted<[], number>(
        () => { throw new ChainRpcTransportError('RPC_TIMEOUT', 'getBlockNumber timed out after 4000ms'); },
      ),
    });
    const { runtime, head, heal, logged } = host;
    useFakeClock();
    try {
      await expect(runtime.dispatch(localCgId, 'live')).resolves.toMatchObject({ status: 'pending' });
      expect(heal).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(1);
      expect(logged.info()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('keeps a run-out window through a slice that met a refused read and was not asked again', async () => {
    let lane: 'closed' | 'half-open' = 'closed';
    const host = await subscribedHost({
      assets: 2,
      count: scripted<[bigint], bigint>(() => {
        if (lane === 'closed') throw notSent('cgStorage.getContextGraphKaCount');
        return 2n;
      }),
      // Half open: the first ordinal's read is refused, the chain answers for the second.
      ordinal: async (_contextGraphId, index) => {
        if (index === 0n) throw notSent('cgStorage.getContextGraphKaAt');
        throw reverted();
      },
    });
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      const retries = WINDOW_MS / RETRY_MS;
      for (let retry = 1; retry <= retries; retry++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await runtime.waitForIdle();
      }
      expect(logged.warn()).toHaveLength(1);

      // The sweep's pass succeeds, with one ordinal's read refused and the
      // other pending for a reason of its own: not asked again.
      lane = 'half-open';
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(logged.info()).toHaveLength(1);

      // It did not show the node's RPC admission open: the next refusal is
      // still past the window, and is left to the sweep.
      lane = 'closed';
      const reads = count.mock.calls.length;
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      await vi.advanceTimersByTimeAsync(4 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(reads + 1);
      expect(logged.info()).toHaveLength(1);
      expect(logged.warn()).toHaveLength(2);
    } finally {
      await host.close();
    }
  });

  it('gives an operator request its result and parks nothing', async () => {
    const host = await subscribedHost({
      assets: 1,
      count: scripted<[bigint], bigint>(() => 1n),
      head: scripted<[], number>(refuse('getBlockNumber'), () => 100),
    });
    const { runtime, head, heal, logged } = host;
    useFakeClock();
    try {
      await expect(runtime.triggerManual(localCgId)).resolves.toMatchObject({ status: 'pending' });
      expect(heal).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(head).toHaveBeenCalledTimes(1);
      expect(logged.info().filter((line) => line.includes('is waiting for local RPC admission')))
        .toEqual([]);
    } finally {
      await host.close();
    }
  });
});

describe('graphs deferred for a refused read, in the scheduling runtime', () => {
  /** A graph whose fetch could start: the readiness every waiter is read by. */
  const ready = { isCurrent: () => true, canAdmit: () => true };

  /** Passes of the graphs in `refused` end on a read that was not sent. */
  function schedulingRuntime(refused: Set<string>, options: { maxPending?: number } = {}) {
    const passes: string[] = [];
    const answers: Array<'parked' | 'again' | undefined> = [];
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        passes.push(key);
        if (!refused.has(key)) return key;
        answers.push(runtime.deferForLocalRpcRefusal(key, ready));
        throw notSent('cgStorage.getContextGraphKaCount');
      },
      vi.fn(),
      options,
    );
    return { runtime, passes, answers };
  }

  it('do not hold back a live nudge for another graph', async () => {
    const { runtime, passes } = schedulingRuntime(new Set(['refused']));
    useFakeClock();
    try {
      runtime.triggerLive('refused');
      await runtime.waitForIdle();
      // Another graph's chain event runs at once, inside the waiting graph's delay.
      runtime.triggerLive('other');
      await runtime.waitForIdle();
      expect(passes).toEqual(['refused', 'other']);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(passes).toEqual(['refused', 'other', 'refused']);
    } finally {
      await runtime.close();
    }
  });

  it('are asked one at a time, one attempt per delay, however many wait', async () => {
    const graphs = ['a', 'b', 'c', 'd'];
    const { runtime, passes } = schedulingRuntime(new Set(graphs));
    useFakeClock();
    try {
      for (const graph of graphs) runtime.triggerLive(graph);
      await runtime.waitForIdle();
      expect(passes).toHaveLength(graphs.length);

      // Each graph gets its turn, and the node starts one pass per delay.
      for (let attempt = 1; attempt <= 2 * graphs.length; attempt++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
        await runtime.waitForIdle();
        expect(passes).toHaveLength(graphs.length + attempt - 1);
        await vi.advanceTimersByTimeAsync(1);
        await runtime.waitForIdle();
        expect(passes).toHaveLength(graphs.length + attempt);
      }
      expect(passes.slice(graphs.length)).toEqual([...graphs, ...graphs]);
    } finally {
      await runtime.close();
    }
  });

  it('report the wait\'s own repeat, and nothing once the window has run out', async () => {
    const { runtime, passes, answers } = schedulingRuntime(new Set(['refused']));
    useFakeClock();
    try {
      runtime.triggerLive('refused');
      await runtime.waitForIdle();
      const repeats = WINDOW_MS / RETRY_MS - 1;
      for (let repeat = 1; repeat <= repeats; repeat++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await runtime.waitForIdle();
      }
      expect(answers).toEqual(['parked', ...Array.from({ length: repeats }, () => 'again')]);

      // The attempt that ends as the window runs out is not taken.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(answers).toHaveLength(repeats + 2);
      expect(answers.at(-1)).toBeUndefined();
      const attempts = passes.length;
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      await runtime.waitForIdle();
      expect(passes).toHaveLength(attempts);
    } finally {
      await runtime.close();
    }
  });

  it('are not nudged while a pass of theirs is already running', async () => {
    const passes: string[] = [];
    const answers: Array<'parked' | 'again' | undefined> = [];
    let gate: Promise<void> | undefined;
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        passes.push(key);
        if (gate) await gate;
        answers.push(runtime.deferForLocalRpcRefusal(key, ready));
        throw notSent('cgStorage.getContextGraphKaCount');
      },
      vi.fn(),
    );
    useFakeClock();
    try {
      runtime.triggerLive('graph');
      await runtime.waitForIdle();
      // The sweep reaches the waiting graph, and its pass is still out when
      // the wait's delay ends.
      let open!: () => void;
      gate = new Promise<void>((resolve) => { open = resolve; });
      await vi.advanceTimersByTimeAsync(1_000);
      runtime.triggerPeriodic('graph');
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      expect(passes).toHaveLength(2);

      // That pass is refused too. No second pass was queued behind it: the
      // graph is asked again one delay later, like after any refused attempt.
      gate = undefined;
      open();
      await runtime.waitForIdle();
      expect(passes).toHaveLength(2);
      expect(answers).toEqual(['parked', 'parked']);
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      await runtime.waitForIdle();
      expect(passes).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(passes).toHaveLength(3);
      expect(answers.at(-1)).toBe('again');
    } finally {
      await runtime.close();
    }
  });

  it('are not graphs a fetching graph gives its turn to', async () => {
    const { runtime } = schedulingRuntime(new Set(['refused']));
    useFakeClock();
    try {
      runtime.triggerLive('refused');
      await runtime.waitForIdle();
      expect(runtime.deferForReadAuthority('unanswered', ready)).toBe('parked');
      // Both wait for a read, not for the sync admission the fetching graph used.
      expect(runtime.yieldLocalAdmissionTurn('fetching', ready)).toBe(false);

      // A graph the sync admission refused is one to stand behind, as before.
      runtime.retryLocalAdmission('needs-sync-admission', { ...ready, canAdmit: () => false });
      expect(runtime.yieldLocalAdmissionTurn('fetching', ready)).toBe(true);
    } finally {
      await runtime.close();
    }
  });

  it('keep their window when a pass met a refused read without asking again, and through a failed pass', async () => {
    type Ending = 'refused' | 'met' | 'fails' | 'succeeds';
    let ending: Ending = 'refused';
    const answers: Array<'parked' | 'again' | undefined> = [];
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        if (ending === 'refused') {
          answers.push(runtime.deferForLocalRpcRefusal(key, ready));
          throw notSent('cgStorage.getContextGraphKaCount');
        }
        if (ending === 'met') runtime.noteLocalRpcRefusal(key);
        if (ending === 'fails') throw reverted();
        return key;
      },
      vi.fn(),
    );
    /** One sweep pass of the graph with the given ending. */
    const sweepPass = async (next: Ending) => {
      ending = next;
      await runtime.dispatch('graph', 'periodic').catch(() => undefined);
      await runtime.waitForIdle();
    };
    useFakeClock();
    try {
      await sweepPass('refused');
      for (let retry = 1; retry <= WINDOW_MS / RETRY_MS; retry++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS);
        await runtime.waitForIdle();
      }
      expect(answers.at(-1)).toBeUndefined();

      // Neither a pass that met a refused read nor one that failed for
      // another reason shows the node's RPC admission open again.
      await sweepPass('met');
      await sweepPass('refused');
      expect(answers.at(-1)).toBeUndefined();
      await sweepPass('fails');
      await sweepPass('refused');
      expect(answers.at(-1)).toBeUndefined();

      // A pass that succeeds without meeting one does.
      await sweepPass('succeeds');
      await sweepPass('refused');
      expect(answers.at(-1)).toBe('parked');
    } finally {
      await runtime.close();
    }
  });

  it('are not taken when the pass is stale, or the runtime is closed', async () => {
    const { runtime } = schedulingRuntime(new Set());
    try {
      expect(runtime.deferForLocalRpcRefusal('stale', { ...ready, isCurrent: () => false })).toBeUndefined();
      expect(runtime.deferForLocalRpcRefusal('current', ready)).toBe('parked');
      await runtime.close();
      expect(runtime.deferForLocalRpcRefusal('after-close', ready)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});

describe('the window in which a graph is asked again', () => {
  function useClockAt(now: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
  }
  /** One pass of the graph that met a refused read: whether it is inside its window. */
  function refusedPass(window: VmReconcileLocalRpcRefusalWindow, graph: string, succeeded = false): boolean {
    const inside = window.refused(graph);
    window.passEnded(graph, succeeded);
    return inside;
  }

  it('opens with the first refused pass and runs out after its length', () => {
    useClockAt(1_000_000);
    const window = new VmReconcileLocalRpcRefusalWindow(8, 10_000);
    expect(refusedPass(window, 'graph')).toBe(true);
    vi.setSystemTime(1_000_000 + 9_999);
    expect(refusedPass(window, 'graph')).toBe(true);
    vi.setSystemTime(1_000_000 + 10_000);
    expect(refusedPass(window, 'graph')).toBe(false);
    // Run out, it stays so for as long as the graph's passes are refused.
    vi.setSystemTime(1_000_000 + 1_000_000);
    expect(refusedPass(window, 'graph')).toBe(false);
  });

  it('closes with a pass that succeeded without meeting a refused read, and with no other', () => {
    useClockAt(1_000_000);
    const window = new VmReconcileLocalRpcRefusalWindow(8, 10_000);
    expect(refusedPass(window, 'graph')).toBe(true);
    vi.setSystemTime(1_000_000 + 60_000);
    expect(refusedPass(window, 'graph')).toBe(false);

    // A pass that succeeded although it met one, and a pass that failed for
    // another reason: neither shows the node's RPC admission open again.
    expect(refusedPass(window, 'graph', true)).toBe(false);
    window.passEnded('graph', false);
    expect(refusedPass(window, 'graph')).toBe(false);

    window.passEnded('graph', true);
    expect(refusedPass(window, 'graph')).toBe(true);
    vi.setSystemTime(1_000_000 + 60_000 + 9_999);
    expect(refusedPass(window, 'graph')).toBe(true);
  });

  it('is kept per graph', () => {
    useClockAt(1_000_000);
    const window = new VmReconcileLocalRpcRefusalWindow(8, 10_000);
    expect(refusedPass(window, 'first')).toBe(true);
    vi.setSystemTime(1_000_000 + 10_000);
    expect(refusedPass(window, 'second')).toBe(true);
    expect(refusedPass(window, 'first')).toBe(false);
    // Another graph's pass that got through closes nothing of this one's.
    window.passEnded('second', true);
    expect(refusedPass(window, 'first')).toBe(false);
  });

  it('remembers a bounded number of graphs and forgets the window that opened first', () => {
    useClockAt(1_000_000);
    const window = new VmReconcileLocalRpcRefusalWindow(2, 10_000);
    expect(refusedPass(window, 'first')).toBe(true);
    expect(refusedPass(window, 'second')).toBe(true);
    vi.setSystemTime(1_000_000 + 10_000);
    expect(refusedPass(window, 'second')).toBe(false);
    // A third graph takes the place of the first, which then starts anew.
    expect(refusedPass(window, 'third')).toBe(true);
    expect(refusedPass(window, 'second')).toBe(false);
    expect(refusedPass(window, 'first')).toBe(true);
  });
});

describe('the reads a slice went on without', () => {
  const refusal = (read: string) => notSent(read);

  it('ask again for a head block that was not read, whatever the slice left', () => {
    const reads = new VmReconcileRefusedSliceReads();
    expect(reads.met).toBe(false);
    const head = refusal('getBlockNumber');
    reads.headBlockFailed(head);
    expect(reads.met).toBe(true);
    expect(reads.askAgainFor({ visited: 0, outstanding: 40 })).toBe(head);
    reads.ordinalFailed(refusal('cgStorage.getContextGraphKaAt'));
    expect(reads.askAgainFor({ visited: 5, outstanding: 40 })).toBe(head);
  });

  it('ask again for unresolved ordinals when the slice resolved none, or nothing else is outstanding', () => {
    const reads = new VmReconcileRefusedSliceReads();
    expect(reads.askAgainFor({ visited: 0, outstanding: 0 })).toBeUndefined();
    const first = refusal('cgStorage.getContextGraphKaAt');
    reads.ordinalFailed(first);
    reads.ordinalFailed(refusal('knowledgeAssets.getLatestMerkleRoot'));
    // The slice visited two ordinals and resolved neither; thirteen more wait.
    expect(reads.askAgainFor({ visited: 2, outstanding: 15 })).toBe(first);
    // It visited ten and settled eight: the two are all that is left.
    expect(reads.askAgainFor({ visited: 10, outstanding: 2 })).toBe(first);
    // It visited ten, and others are pending for reasons of their own.
    expect(reads.askAgainFor({ visited: 10, outstanding: 9 })).toBeUndefined();
    // The slice met refused reads all the same.
    expect(reads.met).toBe(true);
    // Equal counts are the test, not "at least as many".
    expect(reads.askAgainFor({ visited: 3, outstanding: 1 })).toBeUndefined();
    expect(reads.askAgainFor({ visited: 1, outstanding: 9 })).toBeUndefined();
  });

  it('do not count a read the chain answered or an endpoint failed', () => {
    const reads = new VmReconcileRefusedSliceReads();
    reads.headBlockFailed(new ChainRpcTransportError('RPC_TIMEOUT', 'getBlockNumber timed out after 4000ms'));
    reads.ordinalFailed(reverted());
    reads.ordinalFailed(new RpcEndpointsExhaustedError('all endpoints failed'));
    expect(reads.askAgainFor({ visited: 2, outstanding: 2 })).toBeUndefined();
    expect(reads.askAgainFor({ visited: 0, outstanding: 0 })).toBeUndefined();
    expect(reads.met).toBe(false);
  });
});

describe('what counts as a read the node did not send', () => {
  it('is the transport\'s local refusal, by its code, and nothing else', () => {
    expect(isLocalRpcRefusal(notSent('cgStorage.getContextGraphKaCount'))).toBe(true);
    expect(isLocalRpcRefusal(new RpcRequestGovernorQueueFullError(256))).toBe(true);
    // The code survives a plain-object re-wrap, as for every transport code.
    expect(isLocalRpcRefusal({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' })).toBe(true);

    expect(isLocalRpcRefusal(new RpcEndpointsExhaustedError('all endpoints failed'))).toBe(false);
    expect(isLocalRpcRefusal(new ChainRpcTransportError('RPC_TIMEOUT', 'timed out'))).toBe(false);
    expect(isLocalRpcRefusal(reverted())).toBe(false);
    expect(isLocalRpcRefusal(new Error('waited 4000ms for local RPC admission and was not sent'))).toBe(false);
    expect(isLocalRpcRefusal(undefined)).toBe(false);
    expect(isLocalRpcRefusal(null)).toBe(false);
  });

  it('is carried as the cause of the pass\'s failure', () => {
    const refusal = notSent('cgStorage.getContextGraphKaCount');
    const failure = new VmReconcileLocalRpcRefusalError(refusal);
    expect(failure).toMatchObject({ name: 'VmReconcileLocalRpcRefusalError', message: COUNT_NOT_SENT });
    expect(failure.cause).toBe(refusal);
    expect(new VmReconcileLocalRpcRefusalError({ code: 'RPC_REQUEST_GOVERNOR_QUEUE_FULL' }).message)
      .toBe('[object Object]');
  });

  it('parks only an automatic pass that met one, and says so at info, the wait\'s own repeats at debug', () => {
    const refusal = notSent('cgStorage.getContextGraphKaCount');
    const ask = (
      overrides: Partial<Parameters<typeof askVmReconcileAgainAfterLocalRpcRefusal>[0]>,
    ) => {
      const defer = vi.fn((): 'parked' | 'again' | undefined => 'parked');
      const log = vi.fn();
      const asked = askVmReconcileAgainAfterLocalRpcRefusal({
        contextGraphId: 'graph', refusal, automatic: true, defer, log, ...overrides,
      });
      return { asked, deferred: defer.mock.calls.length, logged: log.mock.calls };
    };

    expect(ask({})).toEqual({ asked: true, deferred: 1, logged: [['info', waitingLine('graph', COUNT_NOT_SENT)]] });
    expect(ask({ defer: () => 'again' }).logged).toEqual([['debug', waitingLine('graph', COUNT_NOT_SENT)]]);
    // Not asked at all: an operator's request, another failure, no failure.
    expect(ask({ automatic: false })).toEqual({ asked: false, deferred: 0, logged: [] });
    expect(ask({ refusal: reverted() })).toEqual({ asked: false, deferred: 0, logged: [] });
    expect(ask({ refusal: undefined })).toEqual({ asked: false, deferred: 0, logged: [] });
    // Asked, and not taken: nothing is said, the pass ends as it always did.
    expect(ask({ defer: () => undefined })).toMatchObject({ asked: false, logged: [] });
  });
});
