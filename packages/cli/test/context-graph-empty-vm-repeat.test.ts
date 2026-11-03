import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent, InspectedPrivateEmptyVmReadinessV1 } from '@origintrail-official/dkg-agent';
import * as core from '@origintrail-official/dkg-core';
import { DKGEvent, TypedEventBus } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  PRIVATE_EMPTY_VM_REPEAT_DELAYS_MS,
  PRIVATE_EMPTY_VM_REPEAT_WINDOW_MS,
  privateEmptyVmRepeatTimers,
} from '../src/context-graph-empty-vm-repeat.js';
import {
  registerJoinMetadataEmptyVmSettlement,
  runPrivateEmptyVmAttemptAtCatchup,
  settlePrivateEmptyVmAfterJoinMetadata,
  settlePrivateEmptyVmAtSubscribe,
} from '../src/context-graph-empty-vm-readiness.js';

const GRAPH = 'approved-private-graph';
const CALLER = `0x${'11'.repeat(20)}`;
const CANDIDATE = {
  outcome: 'allowed', source: 'registered-chain', reason: 'chain-participant', metadataBootstrap: 'eligible',
} as const;
const INSPECTION = {
  kind: 'current',
  metadata: { kind: 'confirmed', accessPolicy: 'private' },
  authority: CANDIDATE,
} as const;

type ProofAnswer = { proven: true } | { proven: false; retryable?: boolean; final?: boolean; stage?: string };
const TRY_LATER: ProofAnswer = { proven: false, stage: 'finalized-zero-proof-false' };

/** A member's node as the settlement sees it: subscribed, unsynced, with a scripted proof. */
function memberNode(answer: (attempt: number, signal?: AbortSignal) => ProofAnswer | Promise<ProofAnswer> = () => TRY_LATER) {
  const subscriptions = new Map<string, { subscribed: boolean; synced?: boolean }>([[GRAPH, { subscribed: true, synced: false }]]);
  const stop = new AbortController();
  const eventBus = new TypedEventBus();
  const emitted = vi.spyOn(eventBus, 'emit');
  let attempts = 0;
  const callers: Array<string | undefined> = [];
  const agent = {
    eventBus,
    node: { stopSignal: stop.signal },
    getSubscribedContextGraphs: () => subscriptions,
    markContextGraphSubscriptionState: (id: string, patch: Record<string, unknown>) => {
      Object.assign(subscriptions.get(id) ?? {}, patch);
    },
    prepareContextGraphReadinessWithPrivateEmptyVmV1: async (input: { callerAgentAddress?: string; signal?: AbortSignal }) => {
      attempts += 1;
      callers.push(input.callerAgentAddress);
      const result = await answer(attempts, input.signal);
      return {
        inspectAndCommit: async <T>(
          _input: { inspectMetadata: boolean },
          commit: (completion: InspectedPrivateEmptyVmReadinessV1) => T,
        ) => commit({ ...result, inspection: INSPECTION } as unknown as InspectedPrivateEmptyVmReadinessV1),
      };
    },
  } as unknown as DKGAgent;
  let readiness: unknown = null;
  const dashboard = {
    getContextGraphReadinessProvenance: () => readiness,
    setContextGraphReadinessProvenance: (_id: string, next: unknown) => { readiness = next; },
  } as unknown as DashboardDB;
  return {
    agent, dashboard, subscriptions, stop, emitted, callers,
    attempts: () => attempts,
    subscription: () => subscriptions.get(GRAPH)!,
    projectSynced: () => emitted.mock.calls.filter(([event]) => event === DKGEvent.PROJECT_SYNCED),
    settleAfterJoin: () => settlePrivateEmptyVmAfterJoinMetadata(agent, dashboard, GRAPH, CALLER),
    settleAtSubscribe: () => settlePrivateEmptyVmAtSubscribe(agent, dashboard, GRAPH, CANDIDATE, CALLER),
  };
}

describe('the repeat of the empty-VM proof', () => {
  const realTimers = { set: privateEmptyVmRepeatTimers.set, clear: privateEmptyVmRepeatTimers.clear };
  /** The repeats armed and not yet fired or cleared, oldest first. */
  let armed: Array<{ callback: () => void; delayMs: number }>;
  let logged: string[];

  /** Run the armed repeat and wait until the next one is armed, or none will be. */
  async function fireRepeat() {
    const repeat = armed.shift();
    expect(repeat).toBeDefined();
    repeat!.callback();
    await settled();
  }
  /** Let a repeat's attempt run its awaits, none of which waits on a timer here. */
  async function settled() {
    for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  }
  const settlementLines = () => logged.filter((line) => line.includes('settlement ended'));

  beforeEach(() => {
    armed = [];
    logged = [];
    privateEmptyVmRepeatTimers.set = (callback, delayMs) => {
      const handle = { callback, delayMs };
      armed.push(handle);
      return handle;
    };
    privateEmptyVmRepeatTimers.clear = (handle) => {
      armed = armed.filter((entry) => entry !== handle);
    };
    vi.spyOn(console, 'info').mockImplementation((message: unknown) => { logged.push(String(message)); });
  });
  afterEach(() => {
    privateEmptyVmRepeatTimers.set = realTimers.set;
    privateEmptyVmRepeatTimers.clear = realTimers.clear;
    vi.restoreAllMocks();
  });

  it('runs at 15, 30, 60 and 120 s, then every 5 minutes, and stops at its bound', async () => {
    const node = memberNode();
    expect(await node.settleAfterJoin()).toBe(false);

    const delays: number[] = [];
    while (armed.length > 0) {
      delays.push(armed[0]!.delayMs);
      await fireRepeat();
    }

    expect(delays).toEqual([15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000, 300_000, 300_000]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBeLessThanOrEqual(PRIVATE_EMPTY_VM_REPEAT_WINDOW_MS);
    expect(node.attempts()).toBe(1 + PRIVATE_EMPTY_VM_REPEAT_DELAYS_MS.length);
    expect(node.subscription().synced).toBe(false);
    expect(logged.at(-1)).toMatch(/still not proven after 9 repeated attempt/);
    expect(armed).toEqual([]);
  });

  it('starts no repeat later than its window, however long its attempts take', async () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const node = memberNode();
    await node.settleAfterJoin();

    let repeats = 0;
    while (armed.length > 0) {
      now += armed[0]!.delayMs + 200_000;
      await fireRepeat();
      repeats += 1;
    }

    expect(repeats).toBeLessThan(PRIVATE_EMPTY_VM_REPEAT_DELAYS_MS.length);
    expect(now - 1_000_000).toBeLessThanOrEqual(PRIVATE_EMPTY_VM_REPEAT_WINDOW_MS + 200_000);
  });

  it('proves a graph whose metadata came late, commits it and announces it once', async () => {
    let metadataArrived = false;
    const node = memberNode(() => (metadataArrived
      ? { proven: true }
      : { proven: false, stage: 'finalized-zero-proof-false' }));
    expect(await node.settleAfterJoin()).toBe(false);
    await fireRepeat();
    expect(node.subscription().synced).toBe(false);

    metadataArrived = true;
    await fireRepeat();

    expect(node.subscription().synced).toBe(true);
    expect(node.projectSynced()).toEqual([[DKGEvent.PROJECT_SYNCED, { contextGraphId: GRAPH, dataSynced: 0, sharedMemorySynced: 0 }]]);
    expect(armed).toEqual([]);
    expect(node.attempts()).toBe(3);
  });

  it('makes one pass per repeat, leaving a transient answer to its schedule', async () => {
    const node = memberNode((attempt) => (attempt === 1 ? TRY_LATER : { proven: false, retryable: true, stage: 'proof-error:TimeoutError' }));
    await node.settleAfterJoin();

    await fireRepeat();

    expect(node.attempts()).toBe(2);
    expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]);
  });

  it('commits nothing on an attempt the proof did not hold for', async () => {
    const node = memberNode();
    const write = vi.spyOn(node.dashboard, 'setContextGraphReadinessProvenance');
    await node.settleAfterJoin();
    await fireRepeat();
    await fireRepeat();

    expect(write).not.toHaveBeenCalled();
    expect(node.subscription().synced).toBe(false);
    expect(node.projectSynced()).toEqual([]);
  });

  it('ends at the first repeat after the graph became synced some other way, without a proof', async () => {
    const node = memberNode();
    await node.settleAfterJoin();
    node.subscription().synced = true;

    await fireRepeat();

    expect(node.attempts()).toBe(1);
    expect(armed).toEqual([]);
  });

  it('ends when the graph is no longer subscribed', async () => {
    const node = memberNode();
    await node.settleAfterJoin();
    node.subscription().subscribed = false;

    await fireRepeat();

    expect(node.attempts()).toBe(1);
    expect(armed).toEqual([]);
  });

  it('ends on an attempt that answers finally', async () => {
    const node = memberNode((attempt) => (attempt === 1 ? TRY_LATER : { proven: false, final: true, stage: 'finalized-not-empty' }));
    await node.settleAfterJoin();

    await fireRepeat();

    expect(node.attempts()).toBe(2);
    expect(armed).toEqual([]);
  });

  it('ends when an attempt fails, and reports it', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const node = memberNode((attempt) => {
      if (attempt === 1) return TRY_LATER;
      throw new Error('read failed');
    });
    await node.settleAfterJoin();

    await fireRepeat();

    expect(armed).toEqual([]);
    expect(warned.mock.calls.at(-1)?.[0]).toMatch(/repeat for "approved-private-graph" failed: read failed/);
  });

  it('ends when the node stops, leaving no timer and nothing on the stop signal', async () => {
    const node = memberNode();
    const removed = vi.spyOn(node.stop.signal, 'removeEventListener');
    await node.settleAfterJoin();
    expect(armed).toHaveLength(1);

    node.stop.abort();

    expect(armed).toEqual([]);
    expect(removed).toHaveBeenCalled();
    await settled();
    expect(node.attempts()).toBe(1);
  });

  it('arms nothing once the node is stopping', async () => {
    const node = memberNode();
    node.stop.abort();

    await node.settleAfterJoin();

    expect(armed).toEqual([]);
  });

  it('removes its listener from the stop signal when it ends on its own', async () => {
    const node = memberNode();
    const added = vi.spyOn(node.stop.signal, 'addEventListener');
    const removed = vi.spyOn(node.stop.signal, 'removeEventListener');
    await node.settleAfterJoin();
    node.subscription().synced = true;

    await fireRepeat();

    const stopListeners = (spy: typeof added | typeof removed) => spy.mock.calls.filter(([event]) => event === 'abort').length;
    expect(stopListeners(removed)).toBe(stopListeners(added));
  });

  it('keeps one schedule per graph: another settlement neither restarts nor doubles it', async () => {
    const node = memberNode();
    await node.settleAfterJoin();
    await fireRepeat();
    expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]);

    await node.settleAtSubscribe();

    expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]);
  });

  it('starts over from a later settlement once it has ended', async () => {
    const node = memberNode();
    await node.settleAfterJoin();
    while (armed.length > 0) await fireRepeat();

    await node.settleAtSubscribe();

    expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000]);
  });

  it('keeps a schedule for each caller, each repeating for its own', async () => {
    const node = memberNode();
    await node.settleAfterJoin();
    const other = `0x${'22'.repeat(20)}`;
    await settlePrivateEmptyVmAfterJoinMetadata(node.agent, node.dashboard, GRAPH, other);
    expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000, 15_000]);
    node.callers.length = 0;

    await fireRepeat();
    await fireRepeat();

    expect(node.callers).toEqual([CALLER, other]);
  });

  it('does not take one caller\'s final answer as another\'s schedule', async () => {
    const denied = `0x${'33'.repeat(20)}`;
    const node = memberNode((attempt) => (node.callers[attempt - 1] === denied
      ? { proven: false, final: true, stage: 'authority-not-registered-allowed' }
      : TRY_LATER));
    await node.settleAfterJoin();
    await settlePrivateEmptyVmAfterJoinMetadata(node.agent, node.dashboard, GRAPH, denied);

    expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000]);
    await fireRepeat();
    expect(node.callers.at(-1)).toBe(CALLER);
  });

  it.each([
    ['a proven settlement', { proven: true } as ProofAnswer],
    ['a final answer', { proven: false, final: true, stage: 'not-private' } as ProofAnswer],
  ])('arms nothing after %s', async (_label, answer) => {
    const node = memberNode(() => answer);
    await node.settleAfterJoin();
    expect(armed).toEqual([]);
  });

  it('arms nothing for a graph that is not subscribed or already synced', async () => {
    const node = memberNode();
    node.subscription().synced = true;
    expect(await node.settleAtSubscribe()).toBe(false);
    expect(armed).toEqual([]);
    expect(node.attempts()).toBe(1);

    node.subscription().synced = false;
    node.subscription().subscribed = false;
    await node.settleAtSubscribe();
    expect(armed).toEqual([]);
  });

  it('arms after a subscribe settlement that timed out', async () => {
    vi.spyOn(core, 'startRequestAbortLifecycle').mockImplementation(() => {
      const deadline = AbortSignal.timeout(20);
      return { signal: deadline, deadline, release: () => {} };
    });
    const node = memberNode(() => new Promise<ProofAnswer>(() => {}));

    expect(await node.settleAtSubscribe()).toBe(false);

    expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000]);
    expect(settlementLines()).toEqual([
      `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=subscribe stage=meta-timeout`,
    ]);
  });

  /** A catch-up job's attempt that ends with `completion`, or as `attempt` says. */
  const attemptAtCatchup = (
    node: ReturnType<typeof memberNode>,
    completion: Record<string, unknown>,
    attempt: () => Promise<string> = async () => 'classified',
  ) => runPrivateEmptyVmAttemptAtCatchup({
    agent: node.agent, store: node.dashboard, contextGraphId: GRAPH, callerAgentAddress: CALLER,
    attempt: async () => ({
      value: await attempt(),
      completion: { ...completion, inspection: INSPECTION } as unknown as InspectedPrivateEmptyVmReadinessV1,
    }),
  });

  it('arms after a catch-up job whose own proof ended unproven, and logs its end', async () => {
    const node = memberNode();

    await expect(attemptAtCatchup(node, { proven: false, stage: 'indexed-private-authority-absent' })).resolves.toBe('classified');

    expect(armed.map((repeat) => repeat.delayMs)).toEqual([15_000]);
    expect(settlementLines()).toEqual([
      `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=catchup stage=indexed-private-authority-absent`,
    ]);
  });

  it.each([
    ['a proven one', { proven: true }, 'vm-ready'],
    ['a final one', { proven: false, final: true, stage: 'finalized-not-empty' }, 'finalized-not-empty'],
    ['one that names no stage', { proven: false, final: true }, 'proof-false'],
  ])('arms nothing after %s at catch-up', async (_label, completion, stage) => {
    const node = memberNode();

    await attemptAtCatchup(node, completion);

    expect(armed).toEqual([]);
    expect(settlementLines()[0]).toContain(`stage=${stage}`);
  });

  it('reports a catch-up attempt that fails to its job, and leaves the graph free for the next', async () => {
    const node = memberNode();

    await expect(attemptAtCatchup(node, { proven: false }, async () => { throw new Error('commit failed'); }))
      .rejects.toThrow('commit failed');

    expect(armed).toEqual([]);
    expect(settlementLines()).toEqual([]);
    await node.settleAfterJoin();
    expect(node.attempts()).toBe(1);
  });

  describe('one attempt at a time', () => {
    function pendingProof() {
      let answerAll!: (answer: ProofAnswer) => void;
      const pending = new Promise<ProofAnswer>((resolve) => { answerAll = resolve; });
      return { pending, answerAll };
    }

    it('joins a subscribe, join metadata and a repeat onto the attempt already running', async () => {
      const { pending, answerAll } = pendingProof();
      let running = 0;
      let mostRunning = 0;
      const node = memberNode(async (attempt) => {
        if (attempt === 1) return TRY_LATER;
        running += 1;
        mostRunning = Math.max(mostRunning, running);
        const answer = await pending;
        running -= 1;
        return answer;
      });
      await node.settleAfterJoin();
      expect(node.attempts()).toBe(1);

      armed.shift()!.callback();
      await settled();
      expect(node.attempts()).toBe(2);
      const atSubscribe = node.settleAtSubscribe();
      const afterJoin = node.settleAfterJoin();
      await settled();
      expect(node.attempts()).toBe(2);

      answerAll({ proven: true });

      await expect(atSubscribe).resolves.toBe(true);
      await expect(afterJoin).resolves.toBe(true);
      await settled();
      expect(mostRunning).toBe(1);
      expect(node.attempts()).toBe(2);
      expect(node.subscription().synced).toBe(true);
    });

    it('runs one settlement line for all who joined it', async () => {
      const { pending, answerAll } = pendingProof();
      const node = memberNode(() => pending);
      const first = node.settleAfterJoin();
      const second = node.settleAtSubscribe();
      await settled();
      answerAll({ proven: false, stage: 'finalized-zero-proof-false' });
      await Promise.all([first, second]);

      expect(settlementLines()).toEqual([
        `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=join-metadata stage=finalized-zero-proof-false`,
      ]);
    });

    describe('with another caller running', () => {
      const OTHER = `0x${'22'.repeat(20)}`;
      const atJoinOfOther = (node: ReturnType<typeof memberNode>) => settlePrivateEmptyVmAfterJoinMetadata(node.agent, node.dashboard, GRAPH, OTHER);

      it('waits, then makes its own attempt when that one did not prove the graph', async () => {
        const { pending, answerAll } = pendingProof();
        const node = memberNode((attempt) => (attempt === 1 ? pending : { proven: true }));
        const denied = node.settleAfterJoin();
        await settled();

        const other = atJoinOfOther(node);
        await settled();
        expect(node.attempts()).toBe(1);

        answerAll({ proven: false, final: true, stage: 'authority-denied' });

        await expect(denied).resolves.toBe(false);
        await expect(other).resolves.toBe(true);
        expect(node.callers).toEqual([CALLER, OTHER]);
        expect(node.subscription().synced).toBe(true);
      });

      it('makes its own attempt after one that failed', async () => {
        const { pending, answerAll } = pendingProof();
        const node = memberNode(async (attempt) => {
          if (attempt === 1) throw new Error(`commit failed: ${JSON.stringify(await pending)}`);
          return { proven: true };
        });
        const failing = node.settleAfterJoin();
        await settled();
        const other = atJoinOfOther(node);
        await settled();

        answerAll(TRY_LATER);

        await expect(failing).rejects.toThrow('commit failed');
        await expect(other).resolves.toBe(true);
        expect(node.attempts()).toBe(2);
      });

      it('takes a proof that held: the graph is ready, whoever asked', async () => {
        const { pending, answerAll } = pendingProof();
        const node = memberNode(() => pending);
        const first = node.settleAfterJoin();
        await settled();
        const other = atJoinOfOther(node);
        await settled();

        answerAll({ proven: true });

        await expect(first).resolves.toBe(true);
        await expect(other).resolves.toBe(true);
        expect(node.attempts()).toBe(1);
      });

      it('runs one at a time when several callers wait', async () => {
        const answers = [pendingProof(), pendingProof(), pendingProof()];
        let running = 0;
        let mostRunning = 0;
        const node = memberNode(async (attempt) => {
          running += 1;
          mostRunning = Math.max(mostRunning, running);
          const answer = await answers[attempt - 1]!.pending;
          running -= 1;
          return answer;
        });
        const first = node.settleAfterJoin();
        await settled();
        const second = atJoinOfOther(node);
        const third = settlePrivateEmptyVmAfterJoinMetadata(node.agent, node.dashboard, GRAPH, `0x${'33'.repeat(20)}`);
        await settled();
        expect(node.attempts()).toBe(1);

        answers[0]!.answerAll(TRY_LATER);
        await settled();
        expect(node.attempts()).toBe(2);
        answers[1]!.answerAll(TRY_LATER);
        await settled();
        expect(node.attempts()).toBe(3);
        answers[2]!.answerAll(TRY_LATER);
        await Promise.all([first, second, third]);

        expect(mostRunning).toBe(1);
      });

      it('leaves it to its own deadline while it waits', async () => {
        vi.spyOn(core, 'startRequestAbortLifecycle')
          .mockImplementationOnce(() => {
            const deadline = new AbortController();
            return { signal: deadline.signal, deadline: deadline.signal, release: () => {} };
          })
          .mockImplementationOnce(() => {
            const deadline = AbortSignal.timeout(20);
            return { signal: deadline, deadline, release: () => {} };
          });
        const { pending, answerAll } = pendingProof();
        const node = memberNode(() => pending);
        const first = node.settleAfterJoin();
        await settled();

        await expect(atJoinOfOther(node)).resolves.toBe(false);

        expect(node.attempts()).toBe(1);
        answerAll(TRY_LATER);
        await first;
      });
    });

    it('leaves a joining caller to its own deadline', async () => {
      vi.spyOn(core, 'startRequestAbortLifecycle')
        .mockImplementationOnce(() => {
          const deadline = new AbortController();
          return { signal: deadline.signal, deadline: deadline.signal, release: () => {} };
        })
        .mockImplementationOnce(() => {
          const deadline = AbortSignal.timeout(20);
          return { signal: deadline, deadline, release: () => {} };
        });
      const { pending, answerAll } = pendingProof();
      const node = memberNode(() => pending);
      const first = node.settleAfterJoin();
      await settled();

      await expect(node.settleAtSubscribe()).resolves.toBe(false);

      answerAll(TRY_LATER);
      await first;
      expect(node.attempts()).toBe(1);
    });

    it('runs the attempts of different graphs side by side', async () => {
      const { pending, answerAll } = pendingProof();
      const node = memberNode(() => pending);
      node.subscriptions.set('other-graph', { subscribed: true, synced: false });
      const one = node.settleAfterJoin();
      const other = settlePrivateEmptyVmAfterJoinMetadata(node.agent, node.dashboard, 'other-graph', CALLER);
      await settled();
      expect(node.attempts()).toBe(2);
      answerAll(TRY_LATER);
      await Promise.all([one, other]);
    });

    it('starts a new attempt once the last one has ended', async () => {
      const node = memberNode();
      await node.settleAfterJoin();
      await node.settleAfterJoin();
      expect(node.attempts()).toBe(2);
    });

    it('has a catch-up job wait for the settlement running, not run beside it', async () => {
      const { pending, answerAll } = pendingProof();
      const node = memberNode(() => pending);
      const settling = node.settleAfterJoin();
      await settled();
      const attempt = vi.fn(async () => 'classified');

      const atCatchup = attemptAtCatchup(node, { proven: false, stage: 'finalized-zero-proof-false' }, attempt);
      await settled();
      expect(attempt).not.toHaveBeenCalled();

      answerAll(TRY_LATER);
      await settling;

      await expect(atCatchup).resolves.toBe('classified');
      expect(attempt).toHaveBeenCalledOnce();
    });

    it('has a settlement take the result of a catch-up attempt that is running', async () => {
      const { pending, answerAll } = pendingProof();
      const node = memberNode();
      const atCatchup = attemptAtCatchup(node, { proven: true }, async () => {
        await pending;
        return 'classified';
      });
      await settled();

      const atSubscribe = node.settleAtSubscribe();
      await settled();
      expect(node.attempts()).toBe(0);

      answerAll(TRY_LATER);

      await expect(atSubscribe).resolves.toBe(true);
      await expect(atCatchup).resolves.toBe('classified');
      expect(node.attempts()).toBe(0);
    });
  });

  describe('an accepted authority for the graph', () => {
    const accepted = (node: ReturnType<typeof memberNode>, contextGraphId: unknown = GRAPH) => {
      node.agent.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, { contextGraphId });
    };

    it('runs the armed repeat at once', async () => {
      const node = memberNode((attempt) => (attempt === 1 ? TRY_LATER : { proven: true }));
      registerJoinMetadataEmptyVmSettlement({ agent: node.agent, dashboard: node.dashboard, log: () => {} });
      await node.settleAfterJoin();
      expect(armed).toHaveLength(1);

      accepted(node);
      await settled();

      expect(node.attempts()).toBe(2);
      expect(node.subscription().synced).toBe(true);
      expect(armed).toEqual([]);
    });

    it('brings a repeat forward once per attempt: the next one keeps its delay', async () => {
      const node = memberNode();
      registerJoinMetadataEmptyVmSettlement({ agent: node.agent, dashboard: node.dashboard, log: () => {} });
      await node.settleAfterJoin();

      accepted(node);
      await settled();
      expect(node.attempts()).toBe(2);
      expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]);

      accepted(node);
      await settled();
      expect(node.attempts()).toBe(2);
      expect(armed.map((repeat) => repeat.delayMs)).toEqual([30_000]);

      await fireRepeat();
      expect(node.attempts()).toBe(3);
      accepted(node);
      await settled();
      expect(node.attempts()).toBe(4);
    });

    it('does not start a sequence that has ended, nor one for a graph that has none', async () => {
      const node = memberNode();
      registerJoinMetadataEmptyVmSettlement({ agent: node.agent, dashboard: node.dashboard, log: () => {} });
      accepted(node);
      await settled();
      expect(node.attempts()).toBe(0);

      await node.settleAfterJoin();
      while (armed.length > 0) await fireRepeat();
      const attempts = node.attempts();

      accepted(node);
      await settled();

      expect(node.attempts()).toBe(attempts);
      expect(armed).toEqual([]);
    });

    it('ignores an announcement that names no graph', async () => {
      const node = memberNode();
      registerJoinMetadataEmptyVmSettlement({ agent: node.agent, dashboard: node.dashboard, log: () => {} });
      await node.settleAfterJoin();
      for (const data of [null, 'graph', { contextGraphId: 7 }, {}]) {
        node.agent.eventBus.emit(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, data);
      }
      await settled();
      expect(node.attempts()).toBe(1);
      expect(armed).toHaveLength(1);
    });
  });

  describe('the log line of each settlement', () => {
    it('names its origin and stage, without the debug flag', async () => {
      vi.stubEnv('DKG_DEBUG_PRIVATE_EMPTY_VM', '');
      const node = memberNode((attempt) => (attempt < 3 ? TRY_LATER : { proven: true }));
      await node.settleAfterJoin();
      await fireRepeat();
      await fireRepeat();
      vi.unstubAllEnvs();

      expect(settlementLines()).toEqual([
        `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=join-metadata stage=finalized-zero-proof-false`,
        `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=repeat stage=finalized-zero-proof-false`,
        `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=repeat stage=vm-ready`,
      ]);
    });

    it('says what the attempts were waiting for when the deadline passed', async () => {
      vi.spyOn(core, 'startRequestAbortLifecycle').mockImplementation(() => {
        const deadline = AbortSignal.timeout(40);
        return { signal: deadline, deadline, release: () => {} };
      });
      const node = memberNode(() => ({ proven: false, retryable: true, stage: 'metadata-not-yet-confirmed' }));

      await node.settleAtSubscribe();

      expect(settlementLines()).toEqual([
        `[private-empty-vm] settlement ended: contextGraph=${GRAPH} origin=subscribe stage=meta-timeout after=metadata-not-yet-confirmed`,
      ]);
    });

    it('says when the node stopped it', async () => {
      const node = memberNode((_attempt, signal) => new Promise<ProofAnswer>((resolve) => {
        signal?.addEventListener('abort', () => resolve(TRY_LATER));
      }));
      const settling = node.settleAfterJoin();
      await settled();

      node.stop.abort();
      await settling;

      expect(settlementLines()).toHaveLength(1);
      expect(settlementLines()[0]).toMatch(/origin=join-metadata stage=(node-stopping|finalized-zero-proof-false)/);
      expect(armed).toEqual([]);
    });

    it('logs nothing for a graph it did not apply to', async () => {
      const node = memberNode();
      node.subscription().synced = true;
      await node.settleAfterJoin();
      await settlePrivateEmptyVmAtSubscribe(node.agent, node.dashboard, GRAPH, { ...CANDIDATE, reason: 'chain-public' } as never, CALLER);
      expect(settlementLines()).toEqual([]);
    });
  });

  it('never holds the process open with its real timers', () => {
    privateEmptyVmRepeatTimers.set = realTimers.set;
    privateEmptyVmRepeatTimers.clear = realTimers.clear;
    const timer = privateEmptyVmRepeatTimers.set(() => {}, 60_000) as NodeJS.Timeout;
    try {
      expect(timer.hasRef()).toBe(false);
    } finally {
      privateEmptyVmRepeatTimers.clear(timer);
    }
  });
});
