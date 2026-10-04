/**
 * A VM reconcile pass asks the chain whether this node may read the graph
 * before it does anything else. When that read gets no answer (the node's own
 * RPC budget did not admit it, or the endpoint did not reply in time) the pass
 * says nothing about the graph, so the graph is asked again shortly instead of
 * waiting for the periodic sweep.
 *
 * These run the production gate, pass, dispatcher and wait. Only the chain
 * read is scripted, together with the work a pass does once the gate is open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainRpcTransportError, type ContextGraphLiveAuthority } from '@origintrail-official/dkg-chain';
import { ContextGraphNotFoundError } from '../src/dkg-agent-types.js';
import { VmReconcileReadAuthorityUnansweredError } from '../src/internal/vm-reconcile-read-authority.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import type { ContextGraphReconcileResult } from '../src/vm-reconcile-service.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const CORE = '12D3KooWReadAuthorityWaitCore';
const localCgId = '0x0000000000000000000000000000000000000001/read-authority-wait';
/** The wait's delay between two attempts that got no answer. */
const RETRY_MS = 2_500;
/** The request-scoped deadline of one authority read. */
const AUTHORITY_READ_TIMEOUT_MS = 2_500;

type LiveAuthorityRead = () => Promise<ContextGraphLiveAuthority | null>;

/** What the transport raises when a read's attempt deadline ran out in the node's own RPC queue. */
const notAdmitted: LiveAuthorityRead = () => Promise.reject(new ChainRpcTransportError(
  'RPC_REQUEST_GOVERNOR_QUEUE_FULL',
  'cgStorage.getContextGraph waited 1000ms for local RPC admission and was not sent',
));
const publicGraph: LiveAuthorityRead = async () => ({ active: true, accessPolicy: 0, participantAgents: [] });
/** The chain answered: the id names no live graph. Final, not a missing answer. */
const inactiveGraph: LiveAuthorityRead = async () => ({ active: false, accessPolicy: 0, participantAgents: [] });
const neverAnswers: LiveAuthorityRead = () => new Promise<never>(() => undefined);

/**
 * A subscribed, bound public graph on a node whose authority read is
 * scripted: each read takes the next entry, and the last one repeats.
 */
async function subscribedHost(script: readonly LiveAuthorityRead[]) {
  const h = await createVmRecoveryHostHarness({
    name: 'VmReadAuthorityWait', localCgId, peers: [CORE], targetCount: 0,
    targetForOrdinal: (ordinal) => ({
      localCgId, onChainCgId: '1', ordinal, reason: 'no-swm' as const,
      kaId: String(ordinal), merkleRoot: `root-${ordinal}`,
      ual: `did:dkg:base:84532/0x0000000000000000000000000000000000000001/${ordinal}`,
    }),
    onFetch: () => 'found',
  });
  // The one cast exposes private host seams. Target resolution, the read
  // authority behind it, the dispatcher and the wait stay production code.
  const internals = h.agent as any;
  internals.subscribedContextGraphs.set(localCgId, {
    subscribed: true, synced: false, syncMode: 'always-on', onChainId: h.contextGraphId.toString(),
  });
  const authorityReads = vi.fn<LiveAuthorityRead>();
  let next = 0;
  authorityReads.mockImplementation(() => script[Math.min(next++, script.length - 1)]!());
  h.chainAdapter.getContextGraphLiveAuthority = authorityReads;

  // Past the gate a pass has nothing to do here; `passesPastGate` counts them.
  const passesPastGate = vi.fn();
  internals.startVmRefreshWorker = () => undefined;
  internals.emitVmReconcileTelemetry = () => undefined;
  internals.healStrandedScopedKCs = async () => undefined;
  internals.toContextGraphReconcileResult = () => ({ status: 'current' });
  internals.createVmReconcileDeps = () => {
    passesPastGate();
    return {
      getKCCount: async () => 0,
      getHeadBlock: async () => 100,
      reconcileOrdinal: async () => ({ status: 'reconciled', blockNumber: 100 }),
      recoverPendingOrdinals: async () => ({ recovered: 0 }),
      persistWatermark: () => undefined,
      confirmationDepth: 0,
      maxOrdinalsPerPass: 10,
      log: () => undefined,
    };
  };

  const info = vi.spyOn(internals.log, 'info');
  const debug = vi.spyOn(internals.log, 'debug');
  const warn = vi.spyOn(internals.log, 'warn');
  const messages = (spy: typeof info): string[] => spy.mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('VM reconcile for'));
  const runtime: VmReconcileSchedulingRuntime<ContextGraphReconcileResult> =
    internals.ensureVmReconcileScheduling();
  return {
    h, internals, runtime, authorityReads, passesPastGate,
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

describe('VM reconcile whose read-authority check gets no answer', () => {
  it('asks again as soon as the check answers, without waiting for the periodic sweep', async () => {
    const host = await subscribedHost([notAdmitted, publicGraph]);
    const { runtime, authorityReads, passesPastGate, logged } = host;
    useFakeClock();
    try {
      // The nudge a finished phonebook fetch or a chain event sends.
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(1);
      expect(passesPastGate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      expect(authorityReads).toHaveBeenCalledTimes(1);

      // No sweep ran and nothing nudged the graph from outside.
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(passesPastGate).toHaveBeenCalledTimes(1);

      // Not a failed pass: nothing was left to the sweep, and the log says why.
      expect(logged.warn()).toEqual([]);
      expect(logged.info()).toEqual([
        `VM reconcile for "${localCgId}" is waiting for read authority `
          + '(registered-chain/chain-access-policy-unavailable/chain): '
          + 'the chain read got no answer; asking again shortly',
      ]);

      // The graph is no longer waiting: no further pass comes on its own.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(2);
    } finally {
      await host.close();
    }
  });

  it('keeps asking, one attempt per delay, for as long as there is no answer', async () => {
    const host = await subscribedHost([notAdmitted, notAdmitted, notAdmitted, publicGraph]);
    const { runtime, authorityReads, passesPastGate, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      // The pass ended as a failed one, so a chain event's nudge is held as
      // after any failed pass: only the wait asks again.
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(1);
      for (const attempt of [2, 3]) {
        await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
        expect(authorityReads).toHaveBeenCalledTimes(attempt - 1);
        await vi.advanceTimersByTimeAsync(1);
        await runtime.waitForIdle();
        expect(authorityReads).toHaveBeenCalledTimes(attempt);
        expect(passesPastGate).not.toHaveBeenCalled();
      }
      // Said once where an operator sees it; the repeats stay at debug level.
      expect(logged.info()).toHaveLength(1);
      expect(logged.debug()).toHaveLength(2);
      expect(logged.warn()).toEqual([]);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(4);
      expect(passesPastGate).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
    }
  });

  it('counts a check that ran out of time as unanswered', async () => {
    const host = await subscribedHost([neverAnswers, publicGraph]);
    const { runtime, authorityReads, passesPastGate, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await vi.advanceTimersByTimeAsync(AUTHORITY_READ_TIMEOUT_MS);
      await runtime.waitForIdle();
      expect(passesPastGate).not.toHaveBeenCalled();
      expect(logged.info()).toEqual([
        expect.stringContaining('(registered-chain/chain-access-policy-timeout/chain)'),
      ]);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(passesPastGate).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
    }
  });

  it('gives a periodic pass the same wait', async () => {
    const host = await subscribedHost([notAdmitted, publicGraph]);
    const { runtime, authorityReads, passesPastGate, logged } = host;
    useFakeClock();
    try {
      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(passesPastGate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(passesPastGate).toHaveBeenCalledTimes(1);
      expect(logged.warn()).toEqual([]);
    } finally {
      await host.close();
    }
  });

  it('leaves an operator request the refusal it always was', async () => {
    const host = await subscribedHost([notAdmitted, publicGraph]);
    const { runtime, authorityReads, passesPastGate } = host;
    useFakeClock();
    try {
      const refusal = await runtime.triggerManual(localCgId).then(() => undefined, (error: unknown) => error);
      expect(refusal).toBeInstanceOf(ContextGraphNotFoundError);
      expect(refusal).not.toBeInstanceOf(VmReconcileReadAuthorityUnansweredError);
      expect((refusal as Error).message)
        .toBe(`Context graph "${localCgId}" does not exist or is not subscribed locally`);

      // Nothing was parked on the operator's behalf.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(1);
      expect(passesPastGate).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });

  it('still fails the pass, and holds live nudges until the sweep, when the chain answered', async () => {
    const host = await subscribedHost([inactiveGraph]);
    const { runtime, authorityReads, passesPastGate, logged } = host;
    useFakeClock();
    try {
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(logged.warn()).toEqual([
        `VM reconcile for "${localCgId}" failed; retrying on the periodic sweep: `
          + `Context graph "${localCgId}" does not exist or is not subscribed locally`,
      ]);
      expect(logged.info()).toEqual([]);

      // No wait, and a live nudge is held as after any failed pass.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(1);

      runtime.triggerPeriodic(localCgId);
      await runtime.waitForIdle();
      expect(authorityReads).toHaveBeenCalledTimes(2);
      expect(passesPastGate).not.toHaveBeenCalled();
    } finally {
      await host.close();
    }
  });
});

describe('the read-authority check of VM reconcile target resolution', () => {
  it('marks only a missing answer; a denial and a host-supplied refusal stay plain', async () => {
    const host = await subscribedHost([notAdmitted, inactiveGraph]);
    const { internals, h } = host;
    try {
      const unanswered = await internals.resolveVmReconcileTarget(localCgId)
        .then(() => undefined, (error: unknown) => error);
      expect(unanswered).toBeInstanceOf(VmReconcileReadAuthorityUnansweredError);
      // To a caller it is the refusal it always was.
      expect(unanswered).toBeInstanceOf(ContextGraphNotFoundError);
      expect(unanswered).toMatchObject({
        code: 'ContextGraphNotFound',
        message: `Context graph "${localCgId}" does not exist or is not subscribed locally`,
        readAuthority: 'registered-chain/chain-access-policy-unavailable/chain',
      });

      const answeredUnknown = await internals.resolveVmReconcileTarget(localCgId)
        .then(() => undefined, (error: unknown) => error);
      expect(answeredUnknown).toBeInstanceOf(ContextGraphNotFoundError);
      expect(answeredUnknown).not.toBeInstanceOf(VmReconcileReadAuthorityUnansweredError);

      // A host that answers the question itself reports no decision.
      const readPolicy = vi.spyOn(h.agent, 'canReadContextGraph').mockResolvedValue(false);
      const refused = await internals.resolveVmReconcileTarget(localCgId)
        .then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(ContextGraphNotFoundError);
      expect(refused).not.toBeInstanceOf(VmReconcileReadAuthorityUnansweredError);
      expect(readPolicy).toHaveBeenCalledWith(localCgId, {
        allowSubscriptionFallback: false,
        onReadAuthorityDecision: expect.any(Function),
      });
    } finally {
      await host.close();
    }
  });

  it('gets the decision behind the answer from canReadContextGraph', async () => {
    const host = await subscribedHost([publicGraph, notAdmitted]);
    const { h } = host;
    try {
      const resolve = vi.spyOn(h.agent, 'resolveContextGraphReadAuthority');
      const decisions: unknown[] = [];
      const onReadAuthorityDecision = (decision: unknown) => { decisions.push(decision); };

      await expect(h.agent.canReadContextGraph(localCgId, {
        allowSubscriptionFallback: false, onReadAuthorityDecision,
      })).resolves.toBe(true);
      await expect(h.agent.canReadContextGraph(localCgId, {
        allowSubscriptionFallback: false, onReadAuthorityDecision,
      })).resolves.toBe(false);

      expect(decisions).toEqual([
        expect.objectContaining({ outcome: 'allowed', source: 'registered-chain', reason: 'chain-public' }),
        expect.objectContaining({
          outcome: 'unavailable', reason: 'chain-access-policy-unavailable', dependency: 'chain',
        }),
      ]);
      // The observer is the caller's; the resolver is asked exactly what it was before.
      expect(resolve).toHaveBeenCalledWith(localCgId, { allowSubscriptionFallback: false });
    } finally {
      await host.close();
    }
  });
});

describe('graphs deferred for an unanswered check, in the local admission wait', () => {
  function schedulingRuntime(options: { maxPending?: number } = {}) {
    const passes: string[] = [];
    const runtime = new VmReconcileSchedulingRuntime<string>(
      async (key) => { passes.push(key); return key; },
      vi.fn(),
      options,
    );
    return { runtime, passes };
  }
  /** A graph whose fetch could start: the readiness every waiter is read by. */
  const ready = { isCurrent: () => true, canAdmit: () => true };

  it('go behind the graphs already waiting, and nothing is nudged for one delay', async () => {
    const { runtime, passes } = schedulingRuntime();
    useFakeClock();
    try {
      // A graph refused by sync admission whose capacity is back.
      runtime.retryLocalAdmission('refused-by-sync', ready);
      expect(runtime.deferForReadAuthority('unanswered', ready)).toBe('parked');

      // A pass ending is when a waiter with capacity is normally nudged. Not
      // now: the chain just failed to answer, and its pass would ask it too.
      await runtime.dispatch('other', 'live');
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
      expect(passes).toEqual(['other']);

      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      // One nudge at a time, in the order they wait.
      expect(passes).toEqual(['other', 'refused-by-sync', 'unanswered']);
    } finally {
      await runtime.close();
    }
  });

  it('report a repeat when the nudged pass comes back unanswered', async () => {
    const answers: Array<'parked' | 'again' | undefined> = [];
    let unanswered = 2;
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        if (unanswered-- > 0) {
          answers.push(runtime.deferForReadAuthority(key, ready));
          throw new Error('no answer');
        }
        return key;
      },
      vi.fn(),
    );
    useFakeClock();
    try {
      runtime.triggerLive('unanswered');
      await runtime.waitForIdle();
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(answers).toEqual(['parked', 'again']);
      // The pass that got its answer ends the wait.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(unanswered).toBe(-1);
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(unanswered).toBe(-1);
    } finally {
      await runtime.close();
    }
  });

  it('are not taken when the pass is stale, cancelled, beyond the bound, or the runtime is closed', async () => {
    const { runtime, passes } = schedulingRuntime({ maxPending: 1 });
    useFakeClock();
    try {
      expect(runtime.deferForReadAuthority('stale', { ...ready, isCurrent: () => false })).toBeUndefined();
      const cancelled = new AbortController();
      cancelled.abort();
      expect(runtime.deferForReadAuthority('cancelled', { ...ready, signal: cancelled.signal }))
        .toBeUndefined();
      expect(runtime.deferForReadAuthority('first', ready)).toBe('parked');
      expect(runtime.deferForReadAuthority('over-the-bound', ready)).toBeUndefined();

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(passes).toEqual(['first']);

      await runtime.close();
      expect(runtime.deferForReadAuthority('after-close', ready)).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('keep nudges from elsewhere held and lift that hold only for their own nudge', async () => {
    let take = true;
    const passes: string[] = [];
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        passes.push(key);
        runtime.deferForReadAuthority(key, { ...ready, isCurrent: () => take });
        throw new Error('no answer');
      },
      vi.fn(),
    );
    useFakeClock();
    try {
      runtime.triggerLive('unanswered');
      await runtime.waitForIdle();
      // The pass ended as a failed one: a nudge from elsewhere is still held.
      runtime.triggerLive('unanswered');
      await runtime.waitForIdle();
      expect(passes).toEqual(['unanswered']);
      // The wait's own nudge is that pass's retry.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(passes).toEqual(['unanswered', 'unanswered']);

      // A graph the wait did not take is left to the sweep, as before.
      take = false;
      runtime.triggerLive('not-taken');
      await runtime.waitForIdle();
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      runtime.triggerLive('not-taken');
      await runtime.waitForIdle();
      expect(passes).toEqual(['unanswered', 'unanswered', 'not-taken']);
    } finally {
      await runtime.close();
    }
  });

  it('are not asked again while their fetch could not start', async () => {
    const { runtime, passes } = schedulingRuntime();
    let capacity = false;
    useFakeClock();
    try {
      expect(runtime.deferForReadAuthority('graph', { ...ready, canAdmit: () => capacity })).toBe('parked');
      await vi.advanceTimersByTimeAsync(4 * RETRY_MS);
      expect(passes).toEqual([]);

      capacity = true;
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(passes).toEqual(['graph']);
    } finally {
      await runtime.close();
    }
  });
});
