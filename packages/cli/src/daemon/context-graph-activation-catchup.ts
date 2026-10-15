// daemon/context-graph-activation-catchup.ts
//
// Catches up a persisted subscription that came back unsynced.
//
// The agent restores a persisted subscription at start, or later when the read
// authority it waited for recovers or a rolling activation slot frees, by
// installing the flags it had persisted. That brings `synced` back only for a
// graph a catch-up job had already proven. A subscription whose job never
// finished (the node stopped first) or never proved the graph came back
// unsynced and stayed so until the operator subscribed again, because only the
// subscribe route starts catch-up jobs.
//
// So the daemon runs the subscribe route's job for such a subscription: once
// for every unsynced subscription that is live when the catch-up runner is
// ready, and again whenever the agent activates one later. Jobs run one at a
// time, as background work. A subscription that was dormant during the startup
// readiness migration is migrated first, so its persisted flags are judged as
// those of every other row.

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  migrateLegacyContextGraphReadiness,
  type ContextGraphReadinessStore,
} from '../context-graph-readiness.js';
import { startContextGraphCatchupJob } from './context-graph-catchup-job.js';
import { followContextGraphCatchupJob } from './context-graph-readiness-repeat.js';
import { readContextGraphSubscriptionAdmission } from './context-graph-subscription-admission.js';
import { daemonState } from './state.js';
import type { CatchupTracker } from './types.js';

export interface ActivationCatchupInput {
  readonly agent: DKGAgent;
  readonly store: Partial<ContextGraphReadinessStore>;
  readonly catchupTracker: CatchupTracker;
  readonly log: (message: string) => void;
}

const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

/**
 * Start catching up unsynced subscriptions, now and on every later
 * activation. Call it once the catch-up runner exists. Returns a function that
 * stops listening and starts no further job; a job already started runs on as
 * any other job does.
 */
export function startActivationCatchups(input: ActivationCatchupInput): () => void {
  const { agent } = input;
  const queue: string[] = [];
  let draining = false;
  let stopped = false;

  const enqueue = (contextGraphId: string): void => {
    if (stopped || queue.includes(contextGraphId)) return;
    queue.push(contextGraphId);
    void drain();
  };
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined && !stopped; next = queue.shift()) {
        await catchUp(input, next).catch((err: unknown) => {
          input.log(
            `[catchup] could not catch up "${next}" after its activation: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
    } finally {
      draining = false;
    }
  };
  const onActivated = (data: unknown): void => {
    if (data === null || typeof data !== 'object') return;
    const { contextGraphId } = data as { contextGraphId?: unknown };
    if (typeof contextGraphId === 'string') enqueue(contextGraphId);
  };

  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, onActivated);
  // Subscriptions the agent restored before this listener existed.
  for (const [contextGraphId, subscription] of agent.getSubscribedContextGraphs()) {
    if (subscription.subscribed === true && subscription.synced !== true) enqueue(contextGraphId);
  }
  return () => {
    stopped = true;
    queue.length = 0;
    agent.eventBus.off(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, onActivated);
  };
}

/** Whether a job may start for this subscription now. */
function wanted(input: ActivationCatchupInput, contextGraphId: string): boolean {
  if (!daemonState.catchupAcceptingJobs || !daemonState.catchupRunner) return false;
  if (systemContextGraphs.has(contextGraphId)) return false;
  const subscription = input.agent.getSubscribedContextGraphs().get(contextGraphId);
  if (subscription?.subscribed !== true || subscription.synced === true) return false;
  const latestJobId = input.catchupTracker.latestByContextGraph.get(contextGraphId);
  const latest = latestJobId === undefined ? undefined : input.catchupTracker.jobs.get(latestJobId);
  return latest?.status !== 'queued' && latest?.status !== 'running';
}

async function catchUp(input: ActivationCatchupInput, contextGraphId: string): Promise<void> {
  // A stopping daemon touches no readiness store.
  if (!daemonState.catchupAcceptingJobs) return;
  // A no-op for rows that carry current provenance; a row that was dormant
  // when the startup pass ran is classified here instead.
  await migrateLegacyContextGraphReadiness({ agent: input.agent, store: input.store, log: input.log });
  if (!wanted(input, contextGraphId)) return;
  const admission = await readContextGraphSubscriptionAdmission(input.agent, contextGraphId, undefined)
    .catch(() => undefined);
  if (admission?.authority.outcome !== 'allowed') return;
  // No await from here to the mint, as on the subscribe route.
  if (!wanted(input, contextGraphId)) return;
  input.log(`[catchup] catching up "${contextGraphId}": its subscription came back unsynced`);
  const job = {
    agent: input.agent,
    store: input.store,
    catchupTracker: input.catchupTracker,
    contextGraphId,
    includeSharedMemory: true,
    callerAgentAddress: admission.callerAgentAddress,
    admissionAuthority: admission.authority,
  };
  const started = startContextGraphCatchupJob(job);
  followContextGraphCatchupJob({ ...job, requestAgentAddress: undefined }, started);
  await started.settled;
}
