import { describe, expect, it, vi } from 'vitest';
import {
  DURABLE_RECOVERY_PARKED_IDLE_MS,
  DurableRecoveryTurns,
  durableRecoveryRetryDelayMs,
  type DurableRecoveryRetry,
} from '../src/sync/durable-recovery-turns.js';
import { DurableRecoveryRunner, type DurableRecoveryRunnerDependencies } from '../src/sync/durable-recovery-runner.js';
import { exactRecoveryActionOutcome } from '../src/sync/durable-recovery-action.js';
import { getSyncCheckpointKey, MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { createIncompleteDurableSyncResult } from '../src/sync/durable-progress.js';
import type { DurableRecoveryRoundOutcome } from '../src/sync/durable-recovery-round.js';

/** Timers that fire only when the test moves the clock, earliest first. */
function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    clock: {
      setTimeout: (callback: () => void, ms: number) => {
        nextId += 1;
        timers.set(nextId, { at: now + ms, callback });
        return nextId;
      },
      clearTimeout: (timer: unknown) => { timers.delete(timer as number); },
      now: () => now,
      random: () => 0,
    },
    advance(ms: number) {
      const end = now + ms;
      for (let fired = 0; ; fired += 1) {
        // A timer that keeps re-arming without the clock moving on fails the test instead of spinning.
        if (fired > 10_000) throw new Error('timers keep firing without the clock moving on');
        let due: [number, { at: number; callback: () => void }] | undefined;
        for (const timer of timers) if (timer[1].at <= end && (!due || timer[1].at < due[1].at)) due = timer;
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = end;
    },
  };
}

const macrotask = () => new Promise<void>((resolve) => { setImmediate(resolve); });

/** Let the owners run until `done` holds, within a bounded number of event-loop turns, and at least one. */
async function settle(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    await macrotask();
    if (done()) return;
  }
  expect(done()).toBe(true);
}

/** A retry that records its runs; `admissible` stands for the admission's answer. */
function retryOf(runs: string[], graph: string, admissible: () => boolean = () => true): DurableRecoveryRetry {
  return { run: () => { runs.push(graph); }, admissible };
}

describe('durable recovery turns', () => {
  it('backs off 1 s doubling to 60 s, plus up to a quarter more', () => {
    expect([1, 2, 3, 6, 7, 40].map((refusals) => durableRecoveryRetryDelayMs(refusals, () => 0)))
      .toEqual([1_000, 2_000, 4_000, 32_000, 60_000, 60_000]);
    expect(durableRecoveryRetryDelayMs(1, () => 0.999)).toBe(1_249);
    expect(durableRecoveryRetryDelayMs(7, () => 0.999)).toBe(74_985);
  });

  it('asks the admission after each back-off, and retries a graph only when it would take its slice', () => {
    const { clock, advance } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const asked: number[] = [];
    const runs: string[] = [];
    let free = false;
    const retry = retryOf(runs, 'g', () => {
      asked.push(clock.now());
      return free;
    });
    turns.sliceStarting('g');
    turns.refused('g', retry);
    expect(turns.isDeferred('g')).toBe(true);

    // While the slot stays taken, each back-off counts as one more refusal, without a round.
    advance(200_000);
    expect(asked).toEqual([1_000, 3_000, 7_000, 15_000, 31_000, 63_000, 123_000, 183_000]);
    expect(runs).toEqual([]);
    free = true;
    advance(60_000);
    expect(runs).toEqual(['g']);
    expect(turns.isDeferred('g')).toBe(false);
  });

  it('retries during another graph\'s slice, but never while a turn is being handed over', () => {
    const { clock, advance } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];
    turns.sliceStarting('a');
    turns.refused('b', retryOf(runs, 'b'));
    turns.refused('c', retryOf(runs, 'c'));
    turns.sliceRan('a');
    void turns.handOver('a', retryOf(runs, 'a'));
    expect(runs).toEqual(['b']);

    // c's back-off ends while b has not started the slice it was handed: c waits.
    advance(10_000);
    expect(runs).toEqual(['b']);
    // Once b's slice starts, c may ask for a slot another slot frees.
    turns.sliceStarting('b');
    advance(1_000);
    expect(runs).toEqual(['b', 'c']);
  });

  it('hands the slot on in the order graphs waited, and lets a continuing owner wait at the back', async () => {
    const { clock } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];
    const resumed: string[] = [];
    const handOver = (graph: string) => {
      void turns.handOver(graph, retryOf(runs, graph)).then((turn) => { resumed.push(`${graph}:${turn}`); });
    };

    turns.sliceStarting('a');
    turns.refused('b', retryOf(runs, 'b'));
    turns.refused('c', retryOf(runs, 'c'));
    turns.sliceRan('a');
    handOver('a');
    expect(runs).toEqual(['b']);

    turns.sliceStarting('b');
    turns.sliceRan('b');
    handOver('b');
    expect(runs).toEqual(['b', 'c']);

    turns.sliceStarting('c');
    turns.sliceRan('c');
    turns.roundEnded('c');
    await Promise.resolve();
    expect(resumed).toEqual(['a:true']);

    // b waited while a's next slice ran: b's turn, then a's.
    turns.sliceStarting('a');
    turns.sliceRan('a');
    handOver('a');
    await Promise.resolve();
    expect(resumed).toEqual(['a:true', 'b:true']);
    turns.sliceStarting('b');
    turns.sliceRan('b');
    turns.roundEnded('b');
    await Promise.resolve();
    expect(resumed).toEqual(['a:true', 'b:true', 'a:true']);

    // Alone in line, a keeps its turn.
    turns.sliceStarting('a');
    turns.sliceRan('a');
    await expect(turns.handOver('a', retryOf(runs, 'a'))).resolves.toBe(true);
    expect(runs).toEqual(['b', 'c']);
  });

  it('gives a turn back to the owner that handed it over when its graph cannot use it', async () => {
    const { clock } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];
    const resumed: string[] = [];
    const handOver = () => {
      void turns.handOver('s', retryOf(runs, 's')).then((turn) => { resumed.push(`s:${turn}`); });
    };
    turns.sliceStarting('s');
    turns.refused('b', retryOf(runs, 'b'));
    turns.refused('c', retryOf(runs, 'c'));
    turns.sliceRan('s');
    handOver();
    expect(runs).toEqual(['b']);

    // b's kind of slot is still taken: s, whose kind is free, has its turn back, and b keeps its place.
    turns.sliceStarting('b');
    turns.refused('b', retryOf(runs, 'b'));
    await Promise.resolve();
    expect(resumed).toEqual(['s:true']);
    expect(turns.isDeferred('b')).toBe(true);

    turns.sliceStarting('s');
    turns.sliceRan('s');
    handOver();
    expect(runs).toEqual(['b', 'b']);
    // A round that finds no peer gives the turn back too.
    turns.roundEnded('b');
    await Promise.resolve();
    expect(resumed).toEqual(['s:true', 's:true']);
    expect(runs).toEqual(['b', 'b']);
    expect(turns.isDeferred('c')).toBe(true);
  });

  it('passes on a turn its graph did not use, keeps the place of a graph refused in its turn, and passes nothing on for a retry', () => {
    const { clock, advance } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];

    turns.sliceStarting('a');
    turns.refused('b', retryOf(runs, 'b'));
    turns.refused('c', retryOf(runs, 'c', () => false));
    turns.refused('d', retryOf(runs, 'd', () => false));
    turns.roundEnded('a');
    expect(runs).toEqual(['b']);

    // b's round found no peer: its turn goes to c.
    turns.roundEnded('b');
    expect(runs).toEqual(['b', 'c']);

    // Other work took the slot before c's slice: c keeps its place, and nobody else is woken.
    turns.sliceStarting('c');
    turns.refused('c', retryOf(runs, 'c', () => false));
    expect(runs).toEqual(['b', 'c']);
    expect(turns.isDeferred('c')).toBe(true);

    // A graph not in line runs a slice and ends: the slot goes to c again, ahead of d.
    turns.sliceStarting('e');
    turns.sliceRan('e');
    turns.roundEnded('e');
    expect(runs).toEqual(['b', 'c', 'c']);
    turns.roundEnded('c');
    expect(runs).toEqual(['b', 'c', 'c', 'd']);

    // A graph retried after its back-off holds no slot to pass on when its round ends unused.
    turns.roundEnded('d');
    turns.refused('f', retryOf(runs, 'f'));
    advance(1_000);
    expect(runs).toEqual(['b', 'c', 'c', 'd', 'f']);
    turns.refused('g', retryOf(runs, 'g', () => false));
    turns.roundEnded('f');
    expect(runs).toEqual(['b', 'c', 'c', 'd', 'f']);
  });

  it('keeps a parked owner waiting while slices run, and stops it once none has run for the idle bound', async () => {
    const { clock, advance } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];
    // Other work holds the slot whenever the admission is asked.
    const busy = () => false;
    turns.sliceStarting('a');
    turns.refused('d1', retryOf(runs, 'd1', busy));
    turns.refused('d2', retryOf(runs, 'd2', busy));
    turns.sliceRan('a');
    let aTurn: boolean | undefined;
    void turns.handOver('a', retryOf(runs, 'a')).then((turn) => { aTurn = turn; });
    expect(runs).toEqual(['d1']);
    // d1 uses the slot it was handed, and its graph is complete: the slot goes to d2, which waited before a.
    turns.sliceStarting('d1');
    turns.sliceRan('d1');
    turns.roundEnded('d1');
    expect(runs).toEqual(['d1', 'd2']);
    // Other work took the slot first: no graph-owned slice holds a turn, and a keeps waiting.
    turns.sliceStarting('d2');
    turns.refused('d2', retryOf(runs, 'd2', busy));

    // A slice of another graph runs halfway through: the wait starts over from it.
    advance(DURABLE_RECOVERY_PARKED_IDLE_MS / 2);
    turns.sliceStarting('y');
    turns.sliceRan('y');
    turns.roundEnded('y');
    expect(runs).toEqual(['d1', 'd2', 'd2']);
    turns.sliceStarting('d2');
    turns.refused('d2', retryOf(runs, 'd2', busy));
    advance(DURABLE_RECOVERY_PARKED_IDLE_MS - 1);
    await Promise.resolve();
    expect(aTurn).toBeUndefined();

    advance(1);
    await Promise.resolve();
    expect(aTurn).toBe(false);
    expect(turns.isDeferred('a')).toBe(true);
    // It waits as a refused graph now, and is retried after its back-off.
    advance(1_000);
    expect(runs.at(-1)).toBe('a');
  });

  it('keeps time with the process clock by default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const turns = new DurableRecoveryTurns();
      const runs: string[] = [];
      turns.sliceStarting('a');
      turns.refused('b', retryOf(runs, 'b'));
      turns.sliceRan('a');
      const turn = turns.handOver('a', retryOf(runs, 'a'));
      expect(runs).toEqual(['b']);
      turns.sliceStarting('b');
      turns.sliceRan('b');
      turns.refused('c', retryOf(runs, 'c'));
      vi.advanceTimersByTime(1_250);
      expect(runs).toEqual(['b', 'c']);
      turns.roundEnded('b');
      await expect(turn).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a parked owner waiting at once when the node stops', async () => {
    const { clock, advance } = manualClock();
    const turns = new DurableRecoveryTurns(clock);
    const runs: string[] = [];
    const stop = new AbortController();
    turns.sliceStarting('a');
    turns.refused('b', retryOf(runs, 'b'));
    turns.sliceRan('a');
    const turn = turns.handOver('a', retryOf(runs, 'a'), stop.signal);
    expect(runs).toEqual(['b']);

    stop.abort();
    await expect(turn).resolves.toBe(false);
    // Its graph leaves the line: nothing wakes it later.
    expect(turns.isDeferred('a')).toBe(false);
    turns.sliceStarting('b');
    turns.sliceRan('b');
    turns.roundEnded('b');
    advance(10 * DURABLE_RECOVERY_PARKED_IDLE_MS);
    expect(runs).toEqual(['b']);
    // An owner of a stopped node does not wait at all.
    turns.sliceStarting('c');
    turns.refused('d', retryOf(runs, 'd'));
    turns.sliceRan('c');
    await expect(turns.handOver('c', retryOf(runs, 'c'), stop.signal)).resolves.toBe(false);
  });
});

const PEERS = ['peer-aaaaaaaa', 'peer-bbbbbbbb'];
const ASSET = { ual: 'did:dkg:test/1/2', assertionVersion: '1' };

/** What one slice of a graph does once it has the slot. */
type Step = 'progress' | 'meta' | 'missing' | 'done';

/**
 * Graph owners of one runner on a node with one durable-sync slot, plus one
 * slot of its own for each graph listed in `selected`, as a selected graph may
 * take a slot that background recovery may not. A slice that finds its slot
 * taken comes back deferred, as the admission defers it; a slice that takes it
 * holds it until the test releases the slice.
 */
function oneSlotNode(steps: Record<string, Step[]>, options: { selected?: readonly string[]; stop?: AbortSignal } = {}) {
  const { clock, advance } = manualClock();
  const store = new MemorySyncCheckpointStore();
  const turns = new DurableRecoveryTurns(clock);
  const runner = new DurableRecoveryRunner({ turns });
  const selected = new Set(options.selected ?? []);
  let holder: string | undefined;
  const attempts: Array<{ graph: string; peerId: string }> = [];
  const asked: number[] = [];
  const refused: string[] = [];
  const ran: string[] = [];
  const pending: Array<{ graph: string; release: () => void }> = [];
  const warnings: string[] = [];
  const deferredResult = () => ({ ...createIncompleteDurableSyncResult(), deferredBackpressure: 1 });

  const dependencies = (graph: string): DurableRecoveryRunnerDependencies => ({
    checkpointStore: store,
    isRunning: () => true,
    resolvePreferredPeerId: async () => undefined,
    connectRequestedPeer: async () => {},
    primeConnections: async () => {},
    liveConnectionPeerIds: () => PEERS,
    admitPeer: async () => true,
    isPrivateContextGraph: async () => false,
    orderPeerIds: (peerIds) => [...peerIds],
    isSyncCapable: async () => true,
    executeSlice: async (peerId, recovery): Promise<DurableRecoveryRoundOutcome> => {
      attempts.push({ graph, peerId });
      if (!selected.has(graph)) {
        if (holder !== undefined) {
          refused.push(graph);
          return { result: deferredResult(), decision: { strategy: 'not-started' } };
        }
        holder = graph;
      }
      await new Promise<void>((release) => { pending.push({ graph, release }); });
      if (!selected.has(graph)) holder = undefined;
      ran.push(graph);
      const step = steps[graph]!.shift()!;
      recovery.meta.state = step === 'meta'
        ? { checkpointKey: `meta:${graph}`, quads: [], bytesReceived: 0, nextOffset: 1, rawNextOffset: 1 }
        : undefined;
      if (step === 'done') {
        return { result: { ...createIncompleteDurableSyncResult(), complete: true }, decision: { strategy: 'legacy' } };
      }
      if (step === 'missing') {
        // Other work takes the slot before the owner's exact request.
        holder = 'other';
        return { result: createIncompleteDurableSyncResult(), decision: { strategy: 'exact-missing', batches: [[ASSET]] } };
      }
      if (step === 'meta') return { result: { ...createIncompleteDurableSyncResult(), checkpointAdvances: 1 }, decision: { strategy: 'full', continuation: 'full-graph' } };
      const key = getSyncCheckpointKey(peerId, graph, false, 'data');
      store.set(key, (store.get(key)?.offset ?? 0) + 1);
      return { result: createIncompleteDurableSyncResult(), decision: { strategy: 'full', continuation: 'full-graph' } };
    },
    executeExactSlice: async () => {
      attempts.push({ graph, peerId: 'exact' });
      if (holder !== undefined) {
        refused.push(graph);
        return exactRecoveryActionOutcome(deferredResult(), false);
      }
      return exactRecoveryActionOutcome({ ...createIncompleteDurableSyncResult(), complete: true });
    },
    logDebug: () => {},
    logInfo: () => {},
    logWarn: (message) => { warnings.push(message); },
    stopSignal: () => options.stop,
    admissionAvailable: () => {
      asked.push(clock.now());
      return selected.has(graph) || holder === undefined;
    },
  });
  const run = (graph: string, candidatePeerIds?: string[]) => runner.run({
    contextGraphId: graph,
    ...(candidatePeerIds ? { options: { candidatePeerIds } } : {}),
    dependencies: dependencies(graph),
  });
  /** Release the one slice that holds the slot, which must be `graph`'s. */
  const release = async (graph: string) => {
    await settle(() => pending.length === 1);
    expect(pending[0]!.graph).toBe(graph);
    pending.shift()!.release();
  };
  const health = (graph: string, peerId: string) => (
    runner as unknown as { healthByGraphPeer: Map<string, { attempts: number; successfulSlices: number }> }
  ).healthByGraphPeer.get(`${graph}\0${peerId}`);
  return {
    run, release, health, advance, turns, attempts, asked, refused, ran, pending, warnings,
    takeSlot: () => { holder = 'other'; },
    freeSlot: () => { holder = undefined; },
  };
}

describe('durable recovery under local backpressure', () => {
  it('ends a round whose slice finds no free slot, charges no peer, and retries after its back-off', async () => {
    const node = oneSlotNode({ g: ['done', 'done'] });
    node.takeSlot();

    const first = await node.run('g');
    expect(first.outcome).toBe('deferred');
    expect(first.result).toMatchObject({ complete: false, deferredBackpressure: 1, failedPeers: 0 });
    // The other peer would meet the same busy slot: it is not tried.
    expect(node.attempts).toEqual([{ graph: 'g', peerId: PEERS[0] }]);
    expect(first.peerResults.map(({ peerId, result }) => [peerId, result.deferredBackpressure])).toEqual([[PEERS[0], 1]]);
    for (const peerId of PEERS) expect(node.health('g', peerId)).toMatchObject({ attempts: 0, successfulSlices: 0 });

    // A trigger while the graph waits is answered at once, without a round.
    const again = await node.run('g', [PEERS[1]]);
    expect(again).toMatchObject({ outcome: 'deferred', slices: 0, result: { deferredBackpressure: 1 } });
    expect(again.peerResults.map(({ peerId }) => peerId)).toEqual([PEERS[1]]);
    expect(node.attempts).toHaveLength(1);

    // While the slot stays taken the runner only asks the admission, after 1 s, 2 s and 4 s.
    node.advance(999);
    expect(node.asked).toEqual([]);
    node.advance(1 + 2_000 + 4_000);
    expect(node.asked).toEqual([1_000, 3_000, 7_000]);
    await macrotask();
    expect(node.attempts).toHaveLength(1);

    // Once the slot is free, the next retry completes the graph, which then waits no more.
    node.freeSlot();
    node.advance(8_000);
    await node.release('g');
    await settle(() => node.ran.length === 1);
    const after = node.run('g');
    await node.release('g');
    expect((await after).outcome).toBe('terminal');
    expect(node.warnings).toEqual([]);
  });

  it('ends the round in the same step as its refused slice, so that no wake can land in between', async () => {
    const node = oneSlotNode({ g: ['done'] });
    const order: string[] = [];
    const { refused, roundEnded } = node.turns;
    node.turns.refused = (graph, retry) => {
      order.push('refused');
      refused.call(node.turns, graph, retry);
      queueMicrotask(() => order.push('next microtask'));
    };
    node.turns.roundEnded = (graph) => {
      order.push('round ended');
      roundEnded.call(node.turns, graph);
    };
    node.takeSlot();

    expect((await node.run('g')).outcome).toBe('deferred');
    expect(order).toEqual(['refused', 'round ended', 'next microtask']);
  });

  it('gives graphs turns slice by slice under one slot', async () => {
    const node = oneSlotNode({
      a: ['progress', 'progress', 'progress', 'done'], b: ['done'], c: ['progress', 'done'],
    });
    const a = node.run('a');
    await settle(() => node.pending.length === 1);
    expect((await node.run('b')).outcome).toBe('deferred');
    expect((await node.run('c')).outcome).toBe('deferred');
    expect(node.refused).toEqual(['b', 'c']);

    // Each slice that ends hands the slot to the graph that waited longest.
    for (const graph of ['a', 'b', 'c', 'a', 'c', 'a', 'a']) await node.release(graph);
    expect((await a).outcome).toBe('terminal');
    expect(node.ran).toEqual(['a', 'b', 'c', 'a', 'c', 'a', 'a']);
    // Nobody asked for the slot while it was handed on.
    expect(node.refused).toEqual(['b', 'c']);
  });

  it('keeps a selected graph running while a waiting graph cannot use its slot', async () => {
    const node = oneSlotNode({ s: ['progress', 'progress', 'done'], b: ['done'] }, { selected: ['s'] });
    node.takeSlot();
    const s = node.run('s');
    await settle(() => node.pending.length === 1);
    expect((await node.run('b')).outcome).toBe('deferred');

    // Each slice of s hands its turn to b, which cannot use it and gives it back at once: no wait for a timer.
    for (const graph of ['s', 's', 's']) await node.release(graph);
    expect((await s).outcome).toBe('terminal');
    expect(node.ran).toEqual(['s', 's', 's']);
    // When s is complete its turn goes to b once more, which still cannot use it.
    await settle(() => node.refused.length === 4);
    expect(node.refused).toEqual(['b', 'b', 'b', 'b']);
  });

  it('ends the round of a waiting owner at once when the node stops, with the deferral on its peer too', async () => {
    const stop = new AbortController();
    const node = oneSlotNode({ a: ['progress', 'done'], b: ['progress', 'done'] }, { stop: stop.signal });
    const a = node.run('a');
    await settle(() => node.pending.length === 1);
    expect((await node.run('b')).outcome).toBe('deferred');
    // a hands the slot to b and waits for its next turn.
    await node.release('a');
    await settle(() => node.pending.length === 1);
    expect(node.pending[0]!.graph).toBe('b');

    stop.abort();
    const execution = await a;
    expect(execution.outcome).toBe('deferred');
    expect(execution.result).toMatchObject({ deferredBackpressure: 1, complete: false });
    expect(execution.peerResults.map(({ peerId, result }) => [peerId, result.deferredBackpressure])).toEqual([[PEERS[0], 1]]);
    await node.release('b');
  });

  it('keeps the turn of an owner that retains a META prefix until its META is complete', async () => {
    const node = oneSlotNode({ a: ['meta', 'progress', 'done'], b: ['done'] });
    const a = node.run('a');
    await settle(() => node.pending.length === 1);
    expect((await node.run('b')).outcome).toBe('deferred');

    for (const graph of ['a', 'a', 'b', 'a']) await node.release(graph);
    expect((await a).outcome).toBe('terminal');
    expect(node.ran).toEqual(['a', 'a', 'b', 'a']);
  });

  it('ends the round when an exact request finds no free slot, without falling back or charging the peer', async () => {
    const node = oneSlotNode({ g: ['missing'] });
    const round = node.run('g');
    await node.release('g');

    const execution = await round;
    expect(execution.outcome).toBe('deferred');
    expect(node.attempts).toEqual([{ graph: 'g', peerId: PEERS[0] }, { graph: 'g', peerId: 'exact' }]);
    expect(node.warnings).toEqual([]);
    expect(node.health('g', PEERS[0])).toMatchObject({ attempts: 1 });
  });
});
