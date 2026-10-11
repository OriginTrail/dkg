/**
 * A VM reconcile pass works on the graph's subscription row as it was when
 * the pass resolved its target, and checks at every step that the row is
 * still the graph's current one. A subscribe request for a graph the node
 * already holds stores that row again, unchanged, when the graph's shared
 * memory is carried by the catalog. A pass that is running then stops at its
 * next check, with the error a pass also ends on at shutdown.
 *
 * On a running node that is not a failed pass: the graph is asked again
 * shortly, on the row as it is now, instead of losing its live nudges until
 * its turn in the periodic sweep.
 *
 * The host tests run the production target resolution, pass, engine deps,
 * dispatcher and wait, and store the row through the agent's own setter.
 * Only the chain adapter's reads are scripted.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChainAdapter, ContextGraphLiveAuthority } from '@origintrail-official/dkg-chain';
import { VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS } from '../src/internal/vm-reconcile-local-rpc-refusal.js';
import {
  askVmReconcileAgainAfterOvertakenPass,
  VmReconcileOvertakenError,
} from '../src/internal/vm-reconcile-overtaken-pass.js';
import { VmReconcileSchedulingRuntime } from '../src/vm-reconcile-dispatcher.js';
import {
  VmReconcileQueueClosedError,
  type ContextGraphReconcileResult,
} from '../src/vm-reconcile-service.js';
import { createVmRecoveryHostHarness } from './_helpers/vm-recovery-host.js';

const CORE = '12D3KooWOvertakenPassCore';
const localCgId = '0x0000000000000000000000000000000000000001/overtaken-pass';
/** The wait's delay before a graph is asked again. */
const RETRY_MS = 2_500;
const WINDOW_MS = VM_RECONCILE_LOCAL_RPC_REFUSAL_WINDOW_MS;

const overtakenLine = (contextGraphId: string): string =>
  `VM reconcile for "${contextGraphId}" was overtaken by a change to the graph's `
    + 'subscription or binding; asking again shortly';
const sweepLine = (contextGraphId: string): string =>
  `VM reconcile for "${contextGraphId}" failed; retrying on the periodic sweep: `
    + 'VM reconcile queue is closed for node shutdown';

/** The private host seams these tests reach. Everything else is the agent's own. */
interface HostSeams {
  subscribedContextGraphs: Map<string, Record<string, unknown>>;
  setContextGraphSubscription(
    contextGraphId: string, next: Record<string, unknown>, options: { persist: boolean },
  ): unknown;
  startVmRefreshWorker: () => void;
  healStrandedScopedKCs: () => Promise<undefined>;
  vmReconcileLifecycleGeneration: number;
  log: Record<'info' | 'debug' | 'warn', (context: unknown, message: string) => void>;
  ensureVmReconcileScheduling(): VmReconcileSchedulingRuntime<ContextGraphReconcileResult>;
}

/**
 * A subscribed, bound public graph with nothing to reconcile. Its asset-count
 * read can be held open, so that a pass is still running when the test
 * changes something under it.
 */
async function subscribedHost() {
  const h = await createVmRecoveryHostHarness({
    name: 'VmOvertakenPass', localCgId, peers: [CORE], targetCount: 0,
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
  const chain: ChainAdapter = h.chainAdapter;
  chain.getContextGraphLiveAuthority = async (): Promise<ContextGraphLiveAuthority> => (
    { active: true, accessPolicy: 0, participantAgents: [] }
  );
  let held: { readonly answered: Promise<void>; readonly answer: () => void } | undefined;
  const count = vi.fn(async (): Promise<bigint> => {
    if (held) await held.answered;
    return 0n;
  });
  chain.getContextGraphKCCount = count;
  // Work beside and after the slice that these tests do not look at.
  seams.startVmRefreshWorker = () => undefined;
  seams.healStrandedScopedKCs = async () => undefined;

  const info = vi.spyOn(seams.log, 'info');
  const debug = vi.spyOn(seams.log, 'debug');
  const warn = vi.spyOn(seams.log, 'warn');
  const messages = (spy: typeof info): string[] => spy.mock.calls
    .map(([, message]) => String(message))
    .filter((message) => message.startsWith('VM reconcile for'));
  const runtime = seams.ensureVmReconcileScheduling();
  return {
    h, seams, runtime, count,
    logged: { info: () => messages(info), debug: () => messages(debug), warn: () => messages(warn) },
    /** The next asset-count read stays out until `answer` is called. */
    holdNextCountRead(): void {
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      held = { answered, answer };
    },
    answer(): void {
      const waiting = held;
      held = undefined;
      waiting?.answer();
    },
    /** Wait, in real event-loop turns, until a pass has issued its `reads`-th count read. */
    async passIsRunning(reads: number): Promise<void> {
      for (let turn = 0; turn < 500 && count.mock.calls.length < reads; turn++) {
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      expect(count).toHaveBeenCalledTimes(reads);
    },
    /**
     * What a subscribe request does for a graph the node already holds and
     * whose shared memory the catalog carries: it stores the graph's row
     * again, as it is (`installContextGraphSubscription`).
     */
    subscribeAgain(): void {
      const before = seams.subscribedContextGraphs.get(localCgId)!;
      seams.setContextGraphSubscription(
        localCgId,
        { ...before, subscribed: true, synced: before.synced ?? false, syncMode: before.syncMode },
        { persist: false },
      );
      // Nothing about the graph changed, and its row is another object.
      expect(seams.subscribedContextGraphs.get(localCgId)).not.toBe(before);
      expect(seams.subscribedContextGraphs.get(localCgId)).toMatchObject(before);
    },
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

describe('VM reconcile pass overtaken by a subscribe request for its graph', () => {
  it('starts the next pass after one delay and not at the sweep, on the row as it is now', async () => {
    const host = await subscribedHost();
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      // A chain event starts a live pass, and its asset-count read is still out.
      host.holdNextCountRead();
      const pass = runtime.dispatch(localCgId, 'live').then(() => undefined, (error: unknown) => error);
      await host.passIsRunning(1);

      // A client subscribes to the graph again while the pass runs, and
      // another chain event for the graph arrives.
      host.subscribeAgain();
      runtime.triggerLive(localCgId);

      host.answer();
      const ended = await pass;
      await runtime.waitForIdle();
      // The pass stopped: its row is no longer the graph's. It is not reported
      // as a failed pass that waits for the sweep.
      expect(ended).toBeInstanceOf(VmReconcileOvertakenError);
      expect((ended as Error).cause).toBeInstanceOf(VmReconcileQueueClosedError);
      expect(logged.warn()).toEqual([]);
      expect(logged.info()).toEqual([overtakenLine(localCgId)]);
      expect(count).toHaveBeenCalledTimes(1);

      // More chain events arrive after it ended. They are held, as after any
      // pass that did not get through, and start nothing on their own.
      await vi.advanceTimersByTimeAsync(1_000);
      runtime.triggerLive(localCgId);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);

      // No sweep ran. One delay after the overtaken pass the graph gets its
      // next one, on the row as it is now.
      await vi.advanceTimersByTimeAsync(RETRY_MS - 1_000 - 1);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);

      // That pass got through: the graph is no longer waiting, and the next
      // chain event starts a pass at once.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
      runtime.triggerLive(localCgId);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(3);
      expect(logged.warn()).toEqual([]);
      expect(logged.info()).toEqual([overtakenLine(localCgId)]);
    } finally {
      host.answer();
      await host.close();
    }
  });

  it('asks again each time while the row keeps being stored under the pass', async () => {
    const host = await subscribedHost();
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      // Three passes in a row are overtaken: the chain event's, and the two
      // the wait starts.
      host.holdNextCountRead();
      runtime.triggerLive(localCgId);
      for (let overtaken = 1; overtaken <= 3; overtaken++) {
        await host.passIsRunning(overtaken);
        host.subscribeAgain();
        host.answer();
        if (overtaken < 3) host.holdNextCountRead();
        await runtime.waitForIdle();
        expect(count).toHaveBeenCalledTimes(overtaken);
        await vi.advanceTimersByTimeAsync(RETRY_MS);
      }
      await host.passIsRunning(4);
      await runtime.waitForIdle();

      // Said once where an operator sees it; the wait's own repeats are at debug.
      expect(logged.info()).toEqual([overtakenLine(localCgId)]);
      expect(logged.debug()).toEqual([overtakenLine(localCgId), overtakenLine(localCgId)]);
      expect(logged.warn()).toEqual([]);

      // The fourth pass got through, so nothing is asked again.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(4);
    } finally {
      host.answer();
      await host.close();
    }
  });

  it('gives a periodic pass the same treatment', async () => {
    const host = await subscribedHost();
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      host.holdNextCountRead();
      runtime.triggerPeriodic(localCgId);
      await host.passIsRunning(1);
      host.subscribeAgain();
      host.answer();
      await runtime.waitForIdle();
      expect(logged.info()).toEqual([overtakenLine(localCgId)]);
      expect(logged.warn()).toEqual([]);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(2);
    } finally {
      host.answer();
      await host.close();
    }
  });

  it('leaves an operator request the error it always got', async () => {
    const host = await subscribedHost();
    const { runtime, count, logged } = host;
    useFakeClock();
    try {
      host.holdNextCountRead();
      const request = runtime.triggerManual(localCgId).then(() => undefined, (error: unknown) => error);
      await host.passIsRunning(1);
      host.subscribeAgain();
      host.answer();
      const failure = await request;
      expect(failure).toBeInstanceOf(VmReconcileQueueClosedError);
      expect(failure).not.toBeInstanceOf(VmReconcileOvertakenError);

      // Nothing was parked on the operator's behalf.
      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);
      expect(logged.info()).toEqual([]);
    } finally {
      host.answer();
      await host.close();
    }
  });

  it('does not ask again for a graph the node no longer holds', async () => {
    const host = await subscribedHost();
    const { runtime, count, seams, logged } = host;
    useFakeClock();
    try {
      host.holdNextCountRead();
      runtime.triggerLive(localCgId);
      await host.passIsRunning(1);
      // Unsubscribed while the pass runs: there is no row to ask about.
      seams.subscribedContextGraphs.delete(localCgId);
      host.answer();
      await runtime.waitForIdle();
      expect(logged.info()).toEqual([]);
      expect(logged.warn()).toEqual([sweepLine(localCgId)]);

      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      host.answer();
      await host.close();
    }
  });

  it('ends as it always did when the node is shutting down', async () => {
    const host = await subscribedHost();
    const { runtime, count, seams, logged } = host;
    useFakeClock();
    try {
      host.holdNextCountRead();
      runtime.triggerLive(localCgId);
      await host.passIsRunning(1);
      // The reconcile lifecycle the pass started in has ended.
      seams.vmReconcileLifecycleGeneration += 1;
      host.answer();
      await runtime.waitForIdle();
      expect(logged.info()).toEqual([]);
      expect(logged.warn()).toEqual([sweepLine(localCgId)]);

      await vi.advanceTimersByTimeAsync(10 * RETRY_MS);
      await runtime.waitForIdle();
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      host.answer();
      await host.close();
    }
  });
});

describe('graphs deferred for an overtaken pass, in the scheduling runtime', () => {
  /** A graph whose fetch could start: the readiness every waiter is read by. */
  const ready = { isCurrent: () => true, canAdmit: () => true };

  it('are asked again one at a time, and no longer once the window has run out', async () => {
    const answers: Array<'parked' | 'again' | undefined> = [];
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        answers.push(runtime.deferForOvertakenPass(key, ready));
        throw new VmReconcileQueueClosedError();
      },
      vi.fn(),
    );
    useFakeClock();
    try {
      runtime.triggerLive('graph');
      await runtime.waitForIdle();
      const repeats = WINDOW_MS / RETRY_MS - 1;
      for (let repeat = 1; repeat <= repeats; repeat++) {
        await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
        await runtime.waitForIdle();
        expect(answers).toHaveLength(repeat);
        await vi.advanceTimersByTimeAsync(1);
        await runtime.waitForIdle();
      }
      expect(answers).toEqual(['parked', ...Array.from({ length: repeats }, () => 'again')]);

      // The attempt that ends as the window runs out is not taken, and the
      // graph is left to the sweep.
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await runtime.waitForIdle();
      expect(answers).toHaveLength(repeats + 2);
      expect(answers.at(-1)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(WINDOW_MS);
      await runtime.waitForIdle();
      expect(answers).toHaveLength(repeats + 2);
    } finally {
      await runtime.close();
    }
  });

  it('share the one window with graphs waiting for a refused read', async () => {
    let ending: 'refused' | 'overtaken' | 'succeeds' = 'refused';
    const answers: Array<'parked' | 'again' | undefined> = [];
    const runtime: VmReconcileSchedulingRuntime<string> = new VmReconcileSchedulingRuntime<string>(
      async (key) => {
        if (ending === 'succeeds') return key;
        answers.push(ending === 'refused'
          ? runtime.deferForLocalRpcRefusal(key, ready)
          : runtime.deferForOvertakenPass(key, ready));
        throw new VmReconcileQueueClosedError();
      },
      vi.fn(),
    );
    const sweepPass = async (next: typeof ending) => {
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

      // The window ran out on refused reads: an overtaken pass opens no other.
      await sweepPass('overtaken');
      expect(answers.at(-1)).toBeUndefined();

      // A pass that gets through closes it for both.
      await sweepPass('succeeds');
      await sweepPass('overtaken');
      expect(answers.at(-1)).toBe('parked');
    } finally {
      await runtime.close();
    }
  });
});

describe('what counts as an overtaken pass', () => {
  const ask = (
    overrides: Partial<Parameters<typeof askVmReconcileAgainAfterOvertakenPass>[0]>,
  ) => {
    const defer = vi.fn((): 'parked' | 'again' | undefined => 'parked');
    const log = vi.fn();
    const asked = askVmReconcileAgainAfterOvertakenPass({
      contextGraphId: 'graph', error: new VmReconcileQueueClosedError(),
      automatic: true, stillReconciled: () => true, defer, log, ...overrides,
    });
    return { asked, deferred: defer.mock.calls.length, logged: log.mock.calls };
  };

  it('is an automatic pass that stopped on a changed target while the node runs', () => {
    expect(ask({})).toEqual({ asked: true, deferred: 1, logged: [['info', overtakenLine('graph')]] });
    expect(ask({ defer: () => 'again' }).logged).toEqual([['debug', overtakenLine('graph')]]);
  });

  it('is not an operator request, a graph the node stopped reconciling, or another failure', () => {
    expect(ask({ automatic: false })).toEqual({ asked: false, deferred: 0, logged: [] });
    expect(ask({ stillReconciled: () => false })).toEqual({ asked: false, deferred: 0, logged: [] });
    expect(ask({ error: new Error('execution reverted') })).toEqual({ asked: false, deferred: 0, logged: [] });
    expect(ask({ error: undefined })).toEqual({ asked: false, deferred: 0, logged: [] });
    // Another failure does not even ask whether the graph is still reconciled.
    const stillReconciled = vi.fn(() => true);
    ask({ error: new Error('execution reverted'), stillReconciled });
    ask({ automatic: false, stillReconciled });
    expect(stillReconciled).not.toHaveBeenCalled();
    // Asked, and not taken: nothing is said, the pass ends as it always did.
    expect(ask({ defer: () => undefined })).toMatchObject({ asked: false, logged: [] });
  });

  it('carries the error the pass stopped on as its cause', () => {
    const stopped = new VmReconcileQueueClosedError();
    const overtaken = new VmReconcileOvertakenError(stopped);
    expect(overtaken).toMatchObject({
      name: 'VmReconcileOvertakenError',
      message: 'VM reconcile target changed while the pass ran',
    });
    expect(overtaken.cause).toBe(stopped);
    expect(overtaken).not.toBeInstanceOf(VmReconcileQueueClosedError);
  });
});
