// A persisted subscription that the agent restores unsynced gets a catch-up
// job (issue #3251: a member's subscription to an older public graph came back
// unsynced after a restart and stayed so, because restoring a subscription
// installs its persisted flags and starts no job).
import { afterEach, describe, expect, it } from 'vitest';
import { DKGEvent } from '@origintrail-official/dkg-core';
import type { CatchupJobResult, CatchupRunner } from '../src/catchup-runner.js';
import { startActivationCatchups } from '../src/daemon/context-graph-activation-catchup.js';
import { resetContextGraphReadinessRepeats } from '../src/daemon/context-graph-readiness-repeat.js';
import { daemonState } from '../src/daemon/state.js';
import {
  CG,
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

describe('a subscription restored unsynced is caught up', () => {
  const previousRunner = daemonState.catchupRunner;
  const stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    resetContextGraphReadinessRepeats();
    daemonState.catchupRunner = previousRunner;
    daemonState.catchupAcceptingJobs = true;
  });

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
    stops.push(startActivationCatchups({
      agent: member.agent, store: member.store, catchupTracker, log: (line) => logs.push(line),
    }));
    return { catchupTracker, logs };
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

  it('starts nothing without admission or while the daemon stops taking jobs', async () => {
    for (const blocked of ['denied', 'unavailable', 'shutdown'] as const) {
      const member = memberEdge();
      member.restore({ ...RESTORED_UNSYNCED });
      if (blocked === 'denied') {
        member.node.authority = { ...PUBLIC_UNREGISTERED, outcome: 'denied', grantScope: 'none' };
      } else if (blocked === 'unavailable') {
        member.node.authority = () => { throw new Error('authority read timed out'); };
      } else {
        daemonState.catchupAcceptingJobs = false;
      }
      const runs = runner([cleanEmptyRound]);
      start(member);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect({ blocked, runs }).toEqual({ blocked, runs: [] });
      daemonState.catchupAcceptingJobs = true;
    }
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

  it('stops listening when stopped', async () => {
    const member = memberEdge();
    const runs = runner([cleanEmptyRound]);
    const catchupTracker = { jobs: new Map<string, any>(), latestByContextGraph: new Map<string, string>() };
    const stop = startActivationCatchups({ agent: member.agent, store: member.store, catchupTracker, log: () => {} });
    stop();

    member.restore({ ...RESTORED_UNSYNCED });
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(runs).toEqual([]);
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
