import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RpcRequestGovernor,
  activeRpcRequestContext,
  withRpcRequestContext,
} from '@origintrail-official/dkg-chain';
import { CoalescingRecurringTask } from '../src/coalescing-recurring-task.js';
import { DKGAgentBase } from '../src/dkg-agent-base.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  ROLLING_CHECK_MIN_PAUSE_MS,
  RollingSubscriptionChecks,
} from '../src/context-graph-subscription-rolling-checks.js';

/**
 * Rolling activation against the node's real request governor (shipped
 * budget), with every timer faked.
 *
 * A check is modelled as it was measured on a node with several hundred saved
 * subscriptions: about five chain reads in the foreground class with
 * authority admission priority. An "ordinary read" is any other foreground
 * read of the node; the transport does not send one that waits four seconds
 * for local admission.
 */
const READS_PER_CHECK = 5;
const ROUND_TRIP_MS = 60;
const ORDINARY_READ_DEADLINE_MS = 4_000;

const ABSENT = Object.freeze({
  outcome: 'unavailable',
  source: 'registered-chain',
  reason: 'finalized-name-absence-unaccepted',
  metadataBootstrap: 'forbidden',
  dependency: 'chain',
});
const UNKNOWN = Object.freeze({ ...ABSENT, reason: 'chain-access-policy-unknown' });
const DENIED = Object.freeze({
  outcome: 'denied',
  source: 'registered-chain',
  reason: 'agent-not-in-chain-roster',
  metadataBootstrap: 'forbidden',
});
const ALLOWED = Object.freeze({
  outcome: 'allowed',
  source: 'registered-chain',
  reason: 'open-context-graph',
  metadataBootstrap: 'forbidden',
});

type Answer = typeof ABSENT | typeof UNKNOWN | typeof DENIED | typeof ALLOWED;

interface Host {
  [key: string]: any;
  contextGraphSubscriptionRehydrationPendingIds: Set<string>;
  contextGraphSubscriptionRehydrationSlotIds: Set<string>;
  contextGraphSubscriptionDormancyById: Map<string, string>;
  subscribedContextGraphs: Map<string, any>;
}

const promote = (host: Host, signal: AbortSignal): Promise<'rearm' | 'idle'> => (
  LifecycleSyncMethods.prototype.promoteDormantContextGraphSubscriptions.call(host as never, signal)
);

describe('rolling activation and the chain request lane', () => {
  let governor: RpcRequestGovernor;
  let lanes: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    governor = new RpcRequestGovernor();
    lanes = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** One chain read in the caller's request context. */
  async function chainRead(): Promise<void> {
    const context = activeRpcRequestContext();
    lanes.push(`${context.requestClass}/${context.admissionPriority ?? 'ordinary'}`);
    await governor.acquireActiveRequest();
    await new Promise<void>((resolve) => { setTimeout(resolve, ROUND_TRIP_MS); });
  }

  /** How long an ordinary foreground read waited for admission, or that it was not sent. */
  async function ordinaryRead(): Promise<number | 'not sent'> {
    const deadline = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => deadline.abort(new Error('deadline')), ORDINARY_READ_DEADLINE_MS);
    try {
      await governor.acquireActiveRequest(deadline.signal);
      return Date.now() - startedAt;
    } catch {
      return 'not sent';
    } finally {
      clearTimeout(timer);
    }
  }

  /** A stand-in for the agent with `ids` saved, all left dormant by the activation cap. */
  function hostWith(
    ids: readonly string[],
    options: {
      checks?: RollingSubscriptionChecks;
      answer?: (id: string) => Answer;
      cap?: number;
    } = {},
  ): Host {
    const rows = new Map(ids.map((id) => [id, { id, subscribed: true, synced: false }]));
    const answer = options.answer ?? (() => ABSENT);
    const host: Host = {
      config: { contextGraphSubscriptionStore: { load: async (id: string) => rows.get(id) ?? null } },
      contextGraphSubscriptionRehydrationStatus: {
        rehydrationEnabled: true,
        activationCap: options.cap ?? 64,
        updatedAt: 0,
      },
      contextGraphSubscriptionRehydrationPromotionRuntime: { owns: () => true, request: vi.fn() },
      contextGraphSubscriptionRollingChecks: options.checks ?? new RollingSubscriptionChecks(),
      contextGraphSubscriptionRehydrationPendingIds: new Set(ids),
      contextGraphSubscriptionRehydrationSlotIds: new Set<string>(),
      contextGraphSubscriptionDormancyById: new Map(ids.map((id) => [id, 'activationCap'])),
      contextGraphSubscriptionPersistRevisions: new Map<string, number>(),
      subscribedContextGraphs: new Map<string, any>(),
      started: true,
      log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      updateContextGraphSubscriptionRehydrationStatusAfterClear: vi.fn(),
      updateContextGraphSubscriptionRehydrationStatusAfterPersist: vi.fn(),
      persistContextGraphSubscriptionStrict: vi.fn(async () => undefined),
      reconcileRfc64CatalogResponsibilityV1: vi.fn(async () => undefined),
      resolveContextGraphSubscriptionBootstrapAuthority: vi.fn((id: string, read: { signal: AbortSignal }) => (
        withRpcRequestContext(
          { requestClass: 'foreground', admissionPriority: 'authority', signal: read.signal },
          async () => {
            for (let i = 0; i < READS_PER_CHECK; i++) await chainRead();
            return answer(id);
          },
        )
      )),
      activatePersistedContextGraphSubscriptionRecord: vi.fn(async (row: { id: string }) => {
        host.subscribedContextGraphs.set(row.id, { subscribed: true, synced: true, metaSynced: true });
      }),
    };
    return host;
  }

  /**
   * Run one pass to its end; meanwhile issue an ordinary read every second.
   * Returns the ordinary reads' outcomes and how long the pass took.
   */
  async function runPassWithOrdinaryReads(host: Host, ordinaryReads = true) {
    const startedAt = Date.now();
    let result: 'rearm' | 'idle' | undefined;
    let failure: unknown;
    void promote(host, new AbortController().signal).then(
      (value) => { result = value; },
      (error: unknown) => { failure = error ?? new Error('the pass failed'); },
    );
    const reads: Array<Promise<number | 'not sent'>> = [];
    while (result === undefined && failure === undefined) {
      if (ordinaryReads) reads.push(ordinaryRead());
      await vi.advanceTimersByTimeAsync(1_000);
    }
    if (failure !== undefined) throw failure;
    const tookMs = Date.now() - startedAt;
    await vi.advanceTimersByTimeAsync(ORDINARY_READ_DEADLINE_MS);
    return { result, tookMs, ordinary: await Promise.all(reads) };
  }

  const backlog = (count: number): string[] => (
    Array.from({ length: count }, (_, i) => `backlog-${String(i).padStart(4, '0')}`)
  );

  it('checked back to back, several hundred rows the chain does not confirm take the whole lane', async () => {
    const host = hostWith(backlog(300), {
      checks: new RollingSubscriptionChecks({ minPauseMs: 0, pausePerCheckTime: 0 }),
    });

    const { ordinary, tookMs } = await runPassWithOrdinaryReads(host);

    // 1,500 authority reads at the budget's ten a second.
    expect(tookMs).toBeGreaterThan(140_000);
    expect(tookMs).toBeLessThan(160_000);
    expect(new Set(lanes)).toEqual(new Set(['foreground/authority']));
    // The reads of the first three seconds find a token left of the burst
    // allowance, and those of the last four are admitted when the pass ends.
    // Every read between waits out its deadline and is not sent.
    expect(ordinary.slice(0, 3)).toEqual([0, 0, 0]);
    const starved = ordinary.slice(3, -4);
    expect(starved.length).toBeGreaterThan(140);
    expect(new Set(starved)).toEqual(new Set(['not sent']));
  });

  it('paced, the same backlog leaves every ordinary read admitted at once', async () => {
    const host = hostWith(backlog(300));

    const { result, ordinary, tookMs } = await runPassWithOrdinaryReads(host);

    expect(result).toBe('idle');
    expect(ordinary.length).toBeGreaterThan(900);
    expect(ordinary.filter((outcome) => outcome === 'not sent')).toEqual([]);
    expect(Math.max(...(ordinary as number[]))).toBe(0);
    // One check takes a third of a second; its pause is the shortest one.
    expect(tookMs).toBeGreaterThan(299 * ROLLING_CHECK_MIN_PAUSE_MS);
    expect(tookMs).toBeLessThan(300 * (ROLLING_CHECK_MIN_PAUSE_MS + 500));
    // Nothing is given up: every row was read and left to authority recovery.
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(300);
    expect(host.contextGraphSubscriptionRehydrationPendingIds.size).toBe(0);
    expect(new Set(host.contextGraphSubscriptionDormancyById.values())).toEqual(new Set(['authorityUnavailable']));
    // A summary every five minutes, not a line per row.
    expect(host.log.debug).toHaveBeenCalledTimes(300);
    expect(host.log.warn.mock.calls.length).toBeLessThanOrEqual(Math.ceil(tookMs / 300_000) + 1);
    const reported = host.log.warn.mock.calls
      .map(([, message]: [unknown, string]) => Number(/^Left (\d+) pending/.exec(message)?.[1]))
      .reduce((sum: number, count: number) => sum + count, 0);
    expect(reported).toBe(300);
  });

  it('keeps its share of the lane when the budget is small: a slower check is followed by a longer pause', async () => {
    governor = new RpcRequestGovernor({ maxRequestsPerSecond: 1, burstRequests: 1 });
    const host = hostWith(backlog(12));

    const { tookMs } = await runPassWithOrdinaryReads(host, false);

    // A read waits a second for its turn here, so a check takes about four
    // seconds and its pause about sixteen; with the shortest pause the twelve
    // rows would take a minute and a half and most of the budget.
    expect(tookMs).toBeGreaterThan(200_000);
    expect((12 * READS_PER_CHECK) / (tookMs / 1_000)).toBeLessThan(0.3);
  });

  it('checks a row that was asked for next, ahead of the backlog', async () => {
    const ids = [...backlog(60), 'zz-asked-for'];
    const host = hostWith(ids, { answer: (id) => (id === 'zz-asked-for' ? ALLOWED : ABSENT) });
    let result: 'rearm' | 'idle' | undefined;
    void promote(host, new AbortController().signal).then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(10_000);
    const checkedBefore = host.resolveContextGraphSubscriptionBootstrapAuthority.mock.calls.length;
    expect(checkedBefore).toBeLessThan(5);

    (DKGAgentBase.prototype as any).requestContextGraphSubscriptionPromotion.call(host, 'zz-asked-for');

    expect(host.contextGraphSubscriptionRehydrationPromotionRuntime.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS + 1_000);
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority.mock.calls.at(checkedBefore)?.[0])
      .toBe('zz-asked-for');
    expect(host.activatePersistedContextGraphSubscriptionRecord).toHaveBeenCalledOnce();
    expect(host.subscribedContextGraphs.get('zz-asked-for')?.subscribed).toBe(true);
    expect(host.contextGraphSubscriptionRehydrationPendingIds.has('zz-asked-for')).toBe(false);
    expect(result).toBeUndefined();
    expect(host.contextGraphSubscriptionRehydrationPendingIds.size).toBeGreaterThan(50);
  });

  it('checks rows with a saved chain id before the rest, and activates the confirmable ones back to back', async () => {
    const bound = Array.from({ length: 10 }, (_, i) => `zz-bound-${i}`);
    const host = hostWith([...backlog(40), ...bound], {
      answer: (id) => (id.startsWith('zz-bound-') ? ALLOWED : ABSENT),
    });
    for (const id of bound) host.subscribedContextGraphs.set(id, { subscribed: false, onChainId: '7' });
    void promote(host, new AbortController().signal);

    // Ten checks of five reads each, with no pause between them.
    await vi.advanceTimersByTimeAsync(10 * READS_PER_CHECK * ROUND_TRIP_MS + 500);

    expect(host.activatePersistedContextGraphSubscriptionRecord.mock.calls.map(([row]: [{ id: string }]) => row.id))
      .toEqual(bound);
    // The first row of the backlog was checked right after them; the second waits.
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(ROLLING_CHECK_MIN_PAUSE_MS + 1_000);
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(12);
  });

  it('records what the chain answered: denied, unknown to the chain, or not confirmed for now', async () => {
    const answers: Record<string, Answer> = { denied: DENIED, unknown: UNKNOWN, absent: ABSENT };
    const host = hostWith(Object.keys(answers), {
      answer: (id) => answers[id]!,
      checks: new RollingSubscriptionChecks({ minPauseMs: 0, pausePerCheckTime: 0 }),
    });

    const pass = promote(host, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(pass).resolves.toBe('idle');
    // An id the chain does not know is retired here, as authority recovery
    // retires it, instead of being read a second time there.
    expect(Object.fromEntries(host.contextGraphSubscriptionDormancyById)).toEqual({
      denied: 'authorityDenied',
      unknown: 'deactivated',
      absent: 'authorityUnavailable',
    });
    expect(host.log.warn).toHaveBeenCalledOnce();
    expect(host.log.warn.mock.calls[0]![1]).toBe(
      'Left 3 pending persisted context-graph subscription(s) dormant: '
        + '1 denied by registered-chain (agent-not-in-chain-roster), '
        + '1 unavailable by registered-chain (chain-access-policy-unknown), '
        + '1 unavailable by registered-chain (finalized-name-absence-unaccepted). '
        + '0 more wait for their check. '
        + "Inspect 'GET /api/context-graph/subscriptions' for dormant ids.",
    );
  });

  it('stops at once, without a failure report, when the node closes during a pause', async () => {
    const host = hostWith(backlog(20));
    const onError = vi.fn();
    const runtime = new CoalescingRecurringTask({
      retryIntervalMs: 30_000,
      requestWhileRunning: 'drop',
      runPass: (signal) => promote(host, signal),
      onError,
      closingMessage: 'Rolling context-graph subscription activation closing',
    });
    host.contextGraphSubscriptionRehydrationPromotionRuntime = runtime;
    runtime.request();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(1);
    expect(runtime.running).toBe(true);

    await runtime.close();

    expect(runtime.running).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(host.resolveContextGraphSubscriptionBootstrapAuthority).toHaveBeenCalledTimes(1);
  });
});
