import { afterEach, expect, it } from 'vitest';
import { DKGEvent } from '@origintrail-official/dkg-core';
import { startActivationCatchups } from '../src/daemon/context-graph-activation-catchup.js';
import { daemonState } from '../src/daemon/state.js';
import { cancelContextGraphReadinessRepeats } from '../src/daemon/context-graph-readiness-repeat.js';
import { CG, cleanEmptyRound, memberEdge, waitUntil } from './_helpers/readiness-member-edge.js';

const previousRunner = daemonState.catchupRunner;
afterEach(() => { cancelContextGraphReadinessRepeats(); daemonState.catchupRunner = previousRunner; });

it('starts no catch-up from a provisional authority-recovery row, but catches up its committed activation', async () => {
  const member = memberEdge();
  const row = { subscribed: true, synced: false, sharedMemorySynced: false, metaSynced: true, syncMode: 'always-on' };
  member.restore(row);
  let dormant = true;
  Object.assign(member.agent, { getContextGraphSubscriptionRehydrationStatus: () => ({ dormantIds: dormant ? [CG] : [] }) });
  const runs: string[] = [];
  daemonState.catchupRunner = { run: async request => { runs.push(request.contextGraphId); return cleanEmptyRound(); }, close: async () => {} };
  const stop = startActivationCatchups({ agent: member.agent, store: member.store,
    catchupTracker: { jobs: new Map(), latestByContextGraph: new Map() }, log: () => {} });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runs).toEqual([]);
    expect(member.node.admissionCallers).toEqual([]);
    // The speculative activation is rolled back. Nothing should have started
    // using its temporarily subscribed row or spent its read-authority budget.
    member.restore({ ...row, subscribed: false });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(runs).toEqual([]);
    member.restore(row); dormant = false;
    member.agent.eventBus.emit(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, { contextGraphId: CG });
    await waitUntil(() => member.subscription()?.synced === true ? true : undefined, 'committed activation catch-up');
    expect(runs).toEqual([CG]);
  } finally { stop(); }
});
