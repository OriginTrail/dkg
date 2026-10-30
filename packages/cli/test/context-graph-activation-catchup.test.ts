// A persisted subscription that the agent restores unsynced gets a catch-up
// job (issue #3251: a member's subscription to an older public graph came back
// unsynced after a restart and stayed so, because restoring a subscription
// installs its persisted flags and starts no job).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DKGEvent } from '@origintrail-official/dkg-core';
import type { CatchupJobResult, CatchupRunner } from '../src/catchup-runner.js';
import {
  ACTIVATION_ADMISSION_RETRY_DELAYS_MS,
  startActivationCatchups,
} from '../src/daemon/context-graph-activation-catchup.js';
import {
  cancelContextGraphReadinessRepeats,
  readinessRepeatTimers,
} from '../src/daemon/context-graph-readiness-repeat.js';
import { daemonState } from '../src/daemon/state.js';
import {
  CG,
  DEFAULT_AGENT,
  PUBLIC_UNREGISTERED,
  cleanEmptyRound,
  lossyEmptyRound,
  memberEdge,
  waitUntil,
} from './_helpers/readiness-member-edge.js';

/** The row the agent installs when it restores a subscription whose job never finished. */
const RESTORED_UNSYNCED = Object.freeze({
  subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true, syncMode: 'always-on',
});

/** A second local agent of the member Edge, the only member of a private graph. */
const MEMBER_AGENT = '0x2222222222222222222222222222222222222222';
const PRIVATE_MEMBER = Object.freeze({
  outcome: 'allowed', source: 'rfc64-private', reason: 'rfc64-participant',
  metadataBootstrap: 'eligible', grantScope: 'caller',
});
const PRIVATE_REFUSED = Object.freeze({
  outcome: 'denied', source: 'rfc64-private', reason: 'agent-not-in-rfc64-roster',
});

interface ArmedTimer {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
  fired: boolean;
}

describe('a subscription restored unsynced is caught up', () => {
  const previousRunner = daemonState.catchupRunner;
  const originalTimers = { set: readinessRepeatTimers.set, clear: readinessRepeatTimers.clear };
  const timers: ArmedTimer[] = [];
  const stops: Array<() => void> = [];

  beforeEach(() => {
    readinessRepeatTimers.set = (callback: () => void, delayMs: number) => {
      const timer: ArmedTimer = { callback, delayMs, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    };
    readinessRepeatTimers.clear = (handle: unknown) => {
      (handle as ArmedTimer).cleared = true;
    };
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    cancelContextGraphReadinessRepeats();
    readinessRepeatTimers.set = originalTimers.set;
    readinessRepeatTimers.clear = originalTimers.clear;
    timers.length = 0;
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
  });

  /** Timers armed and not yet fired or cleared. */
  const armed = () => timers.filter((timer) => !timer.cleared && !timer.fired);

  function fire(timer: ArmedTimer | undefined): void {
    if (!timer) throw new Error('nothing armed');
    timer.fired = true;
    timer.callback();
  }

  function runner(rounds: Array<() => CatchupJobResult>, hold?: Promise<void>) {
    const runs: string[] = [];
    const stub: CatchupRunner = {
      run: async (request) => {
        runs.push(request.contextGraphId);
        if (runs.length === 1 && hold) await hold;
        return rounds[Math.min(runs.length, rounds.length) - 1]();
      },
      close: async () => {},
    };
    daemonState.catchupRunner = stub;
    return runs;
  }

  function start(member: ReturnType<typeof memberEdge>) {
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    const logs: string[] = [];
    const stop = startActivationCatchups({
      agent: member.agent, store: member.store, catchupTracker, log: (line) => logs.push(line),
    });
    stops.push(stop);
    return { catchupTracker, logs, stop };
  }

  it('runs the subscribe job for a subscription the agent restored unsynced before the daemon was ready', async () => {
    // The member subscribed, and the node stopped before the job proved the
    // graph: the row persisted as subscribed and unsynced. After the restart
    // the agent restores it as it was, and starts no job.
    const member = memberEdge();
    member.restore({ ...RESTORED_UNSYNCED });
    const runs = runner([cleanEmptyRound]);

    const { catchupTracker, logs } = start(member);
    await waitUntil(() => (member.subscription()?.synced === true ? true : undefined), 'the graph to be proven');

    expect(runs).toEqual([CG]);
    expect(member.subscription()).toMatchObject({ subscribed: true, synced: true, sharedMemorySynced: true });
    expect(member.readiness()).toMatchObject({ version: 1, sharedMemoryVerified: true });
    expect(catchupTracker.jobs.get(catchupTracker.latestByContextGraph.get(CG)!)).toMatchObject({ status: 'done' });
    expect(logs).toContain(`[catchup] catching up "${CG}": its subscription came back unsynced`);
  });

  it('runs it for a subscription the agent activates later, when its authority recovers', async () => {
    const member = memberEdge();
    const runs = runner([cleanEmptyRound]);
    start(member);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toEqual([]);

    member.restore({ ...RESTORED_UNSYNCED });
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => (member.subscription()?.synced === true ? true : undefined), 'the graph to be proven');

    expect(runs).toEqual([CG]);
  });

  it('reads the graph as its own local agent, not as the node default agent', async () => {
    // Two local agents; only the second is a member of the private graph.
    const privateGraph = (callerAgentAddress: string | undefined) => (
      callerAgentAddress === MEMBER_AGENT ? PRIVATE_MEMBER : PRIVATE_REFUSED
    );

    // The graph names no local agent here: the default is read first, then
    // the other local agent, which is admitted.
    const unnamed = memberEdge();
    unnamed.node.localAgents = [DEFAULT_AGENT, MEMBER_AGENT];
    unnamed.node.authority = privateGraph;
    unnamed.restore({ ...RESTORED_UNSYNCED });
    let runs = runner([cleanEmptyRound]);
    let { catchupTracker } = start(unnamed);
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the job of the unnamed graph');
    await waitUntil(
      () => catchupTracker.jobs.get(catchupTracker.latestByContextGraph.get(CG)!)?.finishedAt,
      'the job of the unnamed graph to end',
    );
    // The default refused, the member admitted, and the job's readiness check
    // read as the member too.
    expect(unnamed.node.admissionCallers).toEqual([DEFAULT_AGENT, MEMBER_AGENT, MEMBER_AGENT]);

    // The graph names its agent: that one alone is read.
    const named = memberEdge();
    named.node.localAgents = [DEFAULT_AGENT, MEMBER_AGENT];
    named.node.namedAgent = MEMBER_AGENT;
    named.node.authority = privateGraph;
    named.restore({ ...RESTORED_UNSYNCED });
    runs = runner([cleanEmptyRound]);
    ({ catchupTracker } = start(named));
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the job of the named graph');
    await waitUntil(
      () => catchupTracker.jobs.get(catchupTracker.latestByContextGraph.get(CG)!)?.finishedAt,
      'the job of the named graph to end',
    );
    // The admission, then the job's readiness check.
    expect(named.node.admissionCallers).toEqual([MEMBER_AGENT, MEMBER_AGENT]);

    // No local agent is a member: nothing starts, and a refusal is not asked again.
    const outsider = memberEdge();
    outsider.node.localAgents = [DEFAULT_AGENT, MEMBER_AGENT];
    outsider.node.authority = PRIVATE_REFUSED;
    outsider.restore({ ...RESTORED_UNSYNCED });
    runs = runner([cleanEmptyRound]);
    start(outsider);
    await waitUntil(() => (outsider.node.admissionCallers.length === 2 ? true : undefined), 'both reads');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect({ runs, armed: armed().length }).toEqual({ runs: [], armed: 0 });
  });

  it('a repeat reads the admission as the local agent that was admitted', async () => {
    const member = memberEdge();
    member.node.localAgents = [DEFAULT_AGENT, MEMBER_AGENT];
    member.node.namedAgent = MEMBER_AGENT;
    member.restore({ ...RESTORED_UNSYNCED });
    const runs = runner([lossyEmptyRound, cleanEmptyRound]);
    start(member);
    await waitUntil(() => (armed().length === 1 ? true : undefined), 'the first repeat');

    fire(armed()[0]);
    await waitUntil(() => (member.subscription()?.synced === true ? true : undefined), 'the graph to be proven');
    expect(runs).toEqual([CG, CG]);
    // Each attempt's admission and its job's readiness check.
    expect(member.node.admissionCallers).toEqual([MEMBER_AGENT, MEMBER_AGENT, MEMBER_AGENT, MEMBER_AGENT]);
  });

  it('leaves a synced, unsubscribed or system graph alone, and a graph whose job is in flight', async () => {
    const member = memberEdge();
    member.restore({ ...RESTORED_UNSYNCED, synced: true, sharedMemorySynced: true });
    member.restore({ ...RESTORED_UNSYNCED, subscribed: false }, `${CG}-unsubscribed`);
    member.restore({ ...RESTORED_UNSYNCED }, 'agents');
    member.restore({ ...RESTORED_UNSYNCED }, `${CG}-in-flight`);
    const runs = runner([cleanEmptyRound]);
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    catchupTracker.jobs.set('running-job', { jobId: 'running-job', contextGraphId: `${CG}-in-flight`, status: 'running', queuedAt: 0 });
    catchupTracker.latestByContextGraph.set(`${CG}-in-flight`, 'running-job');
    stops.push(startActivationCatchups({ agent: member.agent, store: member.store, catchupTracker, log: () => {} }));
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: 42 });
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, null);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toEqual([]);
  });

  it('starts nothing without admission or while the daemon stops taking jobs; only an unread admission is asked again', async () => {
    for (const blocked of ['denied', 'unavailable', 'unanswered', 'shutdown'] as const) {
      const member = memberEdge();
      member.restore({ ...RESTORED_UNSYNCED });
      if (blocked === 'denied') {
        member.node.authority = { ...PUBLIC_UNREGISTERED, outcome: 'denied', grantScope: 'none' };
      } else if (blocked === 'unavailable') {
        member.node.authority = { outcome: 'unavailable', source: 'registered-chain', reason: 'chain-name-binding-unavailable' };
      } else if (blocked === 'unanswered') {
        member.node.authority = () => { throw new Error('authority read timed out'); };
      } else {
        daemonState.catchupAcceptingJobs = false;
      }
      const runs = runner([cleanEmptyRound]);
      const { stop } = start(member);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const retries = armed().map((timer) => timer.delayMs);
      expect({ blocked, runs, retries }).toEqual({
        blocked,
        runs: [],
        retries: blocked === 'unavailable' || blocked === 'unanswered' ? [ACTIVATION_ADMISSION_RETRY_DELAYS_MS[0]] : [],
      });
      stop();
      daemonState.catchupAcceptingJobs = true;
    }
  });

  it('asks again when the admission could not be read, and starts the job once it is', async () => {
    const member = memberEdge();
    member.restore({ ...RESTORED_UNSYNCED });
    let reads = 0;
    member.node.authority = () => {
      reads += 1;
      if (reads <= 2) throw new Error('authority read timed out');
      return PUBLIC_UNREGISTERED;
    };
    const runs = runner([cleanEmptyRound]);
    const { logs } = start(member);

    for (const delayMs of ACTIVATION_ADMISSION_RETRY_DELAYS_MS.slice(0, 2)) {
      await waitUntil(() => (armed().length === 1 ? true : undefined), `the read after ${delayMs} ms`);
      expect(armed()[0].delayMs).toBe(delayMs);
      expect(runs).toEqual([]);
      fire(armed()[0]);
    }
    await waitUntil(() => (member.subscription()?.synced === true ? true : undefined), 'the graph to be proven');

    expect(runs).toEqual([CG]);
    expect(armed()).toEqual([]);
    expect(logs.filter((line) => line.includes('could not be read'))).toEqual([
      `[catchup] the admission of "${CG}" could not be read after its activation; asking again in 15 s (1 of 8)`,
      `[catchup] the admission of "${CG}" could not be read after its activation; asking again in 30 s (2 of 8)`,
    ]);
  });

  it('stops asking after the last delay; a new activation starts the count over', async () => {
    const member = memberEdge();
    member.restore({ ...RESTORED_UNSYNCED });
    member.node.authority = () => { throw new Error('authority read timed out'); };
    const runs = runner([cleanEmptyRound]);
    const { logs } = start(member);

    for (const delayMs of ACTIVATION_ADMISSION_RETRY_DELAYS_MS) {
      await waitUntil(() => (armed().length === 1 ? true : undefined), `the read after ${delayMs} ms`);
      expect(armed()[0].delayMs).toBe(delayMs);
      fire(armed()[0]);
    }
    const last = `[catchup] the admission of "${CG}" could not be read after its activation, `
      + `${ACTIVATION_ADMISSION_RETRY_DELAYS_MS.length + 1} times; subscribe again to catch it up`;
    await waitUntil(() => (logs.includes(last) ? true : undefined), 'the last read');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect({ runs, armed: armed().length }).toEqual({ runs: [], armed: 0 });

    // The agent activates the subscription again: asked anew, from the first delay.
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => (armed().length === 1 ? true : undefined), 'a new first read');
    expect(armed()[0].delayMs).toBe(ACTIVATION_ADMISSION_RETRY_DELAYS_MS[0]);
    // And again while that read waits: its timer is replaced, not added to.
    const waiting = armed()[0];
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => (armed().length === 1 && armed()[0] !== waiting ? true : undefined), 'the replaced read');
    expect(waiting.cleared).toBe(true);
    expect(armed()[0].delayMs).toBe(ACTIVATION_ADMISSION_RETRY_DELAYS_MS[0]);
  });

  it('catches up a subscription saved under its name hash that the agent adopted while it waited', async () => {
    const member = memberEdge();
    const nameHash = `0x${'ab'.repeat(32)}`;
    const cleartext = `${CG}-cleartext`;
    member.restore({ ...RESTORED_UNSYNCED });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runs = runner([cleanEmptyRound], held);
    const { logs } = start(member);
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the first job');

    // A subscription saved under its name hash comes back while the first job
    // runs, and name resolution adopts its cleartext id before the queue gets to it.
    member.restore({ ...RESTORED_UNSYNCED }, nameHash);
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: nameHash });
    member.adopt(nameHash, cleartext);
    release();

    await waitUntil(() => (runs.length === 2 ? true : undefined), 'the job of the adopted graph');
    expect(runs).toEqual([CG, cleartext]);
    expect(logs).toContain(`[catchup] catching up "${cleartext}": its subscription came back unsynced`);
  });

  it('catches it up under its cleartext id when the agent adopts that while the admission is read', async () => {
    const member = memberEdge();
    const nameHash = `0x${'ab'.repeat(32)}`;
    const cleartext = `${CG}-cleartext`;
    member.restore({ ...RESTORED_UNSYNCED }, nameHash);
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const asked: string[] = [];
    const read = member.agent.resolveContextGraphSubscriptionBootstrapAuthority.bind(member.agent);
    member.agent.resolveContextGraphSubscriptionBootstrapAuthority = (async (...args: Parameters<typeof read>) => {
      asked.push(args[0]);
      if (args[0] === nameHash) await answered;
      return read(...args);
    }) as typeof read;
    const runs = runner([cleanEmptyRound]);
    start(member);
    await waitUntil(() => (asked.length === 1 ? true : undefined), 'the admission read of the name hash');

    member.adopt(nameHash, cleartext);
    answer();
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the job under the cleartext id');
    // The cleartext id is admitted on its own before its job starts.
    expect(asked.slice(0, 2)).toEqual([nameHash, cleartext]);
    expect(runs).toEqual([cleartext]);
  });

  it('runs one job at a time', async () => {
    const member = memberEdge();
    const second = `${CG}-second`;
    member.restore({ ...RESTORED_UNSYNCED });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const runs = runner([cleanEmptyRound], held);
    start(member);
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the first job');

    member.restore({ ...RESTORED_UNSYNCED }, second);
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: second });
    // The same graph again, while it waits: it is queued once.
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: second });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toEqual([CG]);

    release();
    await waitUntil(() => (runs.length === 2 ? true : undefined), 'the second job');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runs).toEqual([CG, second]);
  });

  it('stops listening and asking again when stopped', async () => {
    const member = memberEdge();
    member.restore({ ...RESTORED_UNSYNCED });
    member.node.authority = () => { throw new Error('authority read timed out'); };
    const runs = runner([cleanEmptyRound]);
    const { stop } = start(member);
    await waitUntil(() => (armed().length === 1 ? true : undefined), 'a read to wait');
    const waiting = armed()[0];

    stop();
    expect(waiting.cleared).toBe(true);
    // A timer that fires anyway, or a later activation, starts nothing.
    member.node.authority = PUBLIC_UNREGISTERED;
    fire(waiting);
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect({ runs, armed: armed().length }).toEqual({ runs: [], armed: 0 });
  });

  it('starts no job and asks nothing again when stopped while it reads the admission', async () => {
    const unavailable = { outcome: 'unavailable', source: 'registered-chain', reason: 'chain-name-binding-unavailable' };
    for (const answerWith of [PUBLIC_UNREGISTERED, unavailable]) {
      const member = memberEdge();
      member.restore({ ...RESTORED_UNSYNCED });
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => { answer = resolve; });
      let asked = false;
      member.node.authority = () => answerWith;
      const read = member.agent.resolveContextGraphSubscriptionBootstrapAuthority.bind(member.agent);
      member.agent.resolveContextGraphSubscriptionBootstrapAuthority = (async (...args: Parameters<typeof read>) => {
        asked = true;
        await answered;
        return read(...args);
      }) as typeof read;
      const runs = runner([cleanEmptyRound]);
      const { stop } = start(member);
      await waitUntil(() => (asked ? true : undefined), 'the admission read');

      stop();
      answer();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({ outcome: answerWith.outcome, runs, armed: armed().length })
        .toEqual({ outcome: answerWith.outcome, runs: [], armed: 0 });
    }
  });

  it('logs a catch-up that fails and goes on with the next one', async () => {
    const member = memberEdge();
    const second = `${CG}-second`;
    member.restore({ ...RESTORED_UNSYNCED });
    member.restore({ ...RESTORED_UNSYNCED }, second);
    const runs = runner([cleanEmptyRound]);
    let reads = 0;
    const read = member.store.getContextGraphReadinessProvenance;
    member.store.getContextGraphReadinessProvenance = () => {
      reads += 1;
      if (reads === 1) throw new Error('readiness store busy');
      return read();
    };

    const { logs } = start(member);
    await waitUntil(() => (runs.length === 1 ? true : undefined), 'the second catch-up');

    expect(logs).toContain(`[catchup] could not catch up "${CG}" after its activation: readiness store busy`);
    expect(runs).toEqual([second]);
    expect(armed()).toEqual([]);
  });

  it('migrates a row that was dormant during the startup migration before judging it', async () => {
    // A row written before readiness carried provenance, activated after the
    // startup pass: it says synced, and nothing has classified it yet.
    const kept = memberEdge();
    const keptRuns = runner([cleanEmptyRound]);
    start(kept);
    kept.restore({ ...RESTORED_UNSYNCED, synced: true, sharedMemorySynced: true });
    kept.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => (kept.readiness() ? true : undefined), 'the migration of the kept row');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A confirmed public graph keeps its flags, now with current provenance.
    expect(kept.readiness()).toMatchObject({ version: 1, durableVerified: true, sharedMemoryVerified: true });
    expect(kept.subscription()).toMatchObject({ synced: true });
    expect(keptRuns).toEqual([]);

    // One whose definition is not confirmed is reset, and caught up.
    const reset = memberEdge();
    reset.node.confirmedMeta = false;
    const resetRuns = runner([lossyEmptyRound]);
    start(reset);
    reset.restore({ ...RESTORED_UNSYNCED, synced: true, sharedMemorySynced: true });
    reset.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => (resetRuns.length === 1 ? true : undefined), 'the job of the reset row');
    expect(reset.subscription()).toMatchObject({ synced: false });
  });
});
