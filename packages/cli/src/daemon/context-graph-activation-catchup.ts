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
// those of every other row. The graph is read as its own local agent, not as
// the node's default agent. An admission that cannot be read now is asked again
// after a growing delay, a bounded number of times; a refusal is final. A
// subscription saved under its on-chain name hash that the agent replaces by
// its verified cleartext id while it waits here is caught up under that id.

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { DKGEvent, SYSTEM_CONTEXT_GRAPHS } from '@origintrail-official/dkg-core';
import {
  migrateLegacyContextGraphReadiness,
  type ContextGraphReadinessStore,
} from '../context-graph-readiness.js';
import { startContextGraphCatchupJob } from './context-graph-catchup-job.js';
import { registerContextGraphCatchupProgress } from './context-graph-catchup-progress.js';
import {
  CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS,
  followContextGraphCatchupJob,
  readinessRepeatTimers,
} from './context-graph-readiness-repeat.js';
import { readLocalAgentSubscriptionAdmission } from './context-graph-subscription-admission.js';
import { daemonState } from './state.js';
import type { CatchupTracker } from './types.js';

export interface ActivationCatchupInput {
  readonly agent: DKGAgent;
  readonly store: Partial<ContextGraphReadinessStore>;
  readonly catchupTracker: CatchupTracker;
  readonly log: (message: string) => void;
}

/**
 * Delay before each new admission read of an activation whose admission could
 * not be read, in order: the readiness repeat's schedule, about an hour in all.
 */
export const ACTIVATION_ADMISSION_RETRY_DELAYS_MS = CONTEXT_GRAPH_READINESS_REPEAT_DELAYS_MS;

const systemContextGraphs = new Set<string>(Object.values(SYSTEM_CONTEXT_GRAPHS));

/**
 * What one catch-up did: started a job, found none wanted, could not read the
 * admission, or found the subscription under its cleartext id, to catch up anew.
 */
type CatchUpOutcome = 'started' | 'skipped' | 'unavailable' | { readonly requeue: string };

/**
 * Start catching up unsynced subscriptions, now and on every later
 * activation. Call it once the catch-up runner exists. Returns a function that
 * stops listening, cancels the pending admission reads and starts no further
 * job; a job already started runs on as any other job does.
 */
export function startActivationCatchups(input: ActivationCatchupInput): () => void {
  const { agent } = input;
  const queue: string[] = [];
  /** Graphs whose admission could not be read: the reads asked again so far, and the next one's timer. */
  const retries = new Map<string, { asked: number; timer?: unknown }>();
  let draining = false;
  let stopped = false;
  /** The graph `drain` is catching up now, its job included. */
  let current: string | undefined;
  const live = (): boolean => !stopped;
  // A write that finds a graph unsynced waits while this has it queued, in
  // hand, or due for another admission read (`context-graph-write-readiness.ts`).
  const unregisterProgress = registerContextGraphCatchupProgress({
    catchingUp: (contextGraphId) => current === contextGraphId
      || queue.includes(contextGraphId) || retries.get(contextGraphId)?.timer !== undefined,
  });

  const enqueue = (contextGraphId: string): void => {
    if (stopped || queue.includes(contextGraphId)) return;
    queue.push(contextGraphId);
    void drain();
  };
  const forgetRetry = (contextGraphId: string): void => {
    const retry = retries.get(contextGraphId);
    if (retry?.timer !== undefined) readinessRepeatTimers.clear(retry.timer);
    retries.delete(contextGraphId);
  };
  /** An activation, or a row found at start: a fresh start that counts no earlier reads. */
  const activated = (contextGraphId: string): void => {
    forgetRetry(contextGraphId);
    enqueue(contextGraphId);
  };
  const askAgainLater = (contextGraphId: string): void => {
    const retry = retries.get(contextGraphId) ?? { asked: 0 };
    const delayMs = ACTIVATION_ADMISSION_RETRY_DELAYS_MS[retry.asked];
    if (delayMs === undefined) {
      retries.delete(contextGraphId);
      input.log(
        `[catchup] the admission of "${contextGraphId}" could not be read after its activation, `
          + `${retry.asked + 1} times; subscribe again to catch it up`,
      );
      return;
    }
    retry.asked += 1;
    retry.timer = readinessRepeatTimers.set(() => {
      retry.timer = undefined;
      enqueue(contextGraphId);
    }, delayMs);
    retries.set(contextGraphId, retry);
    input.log(
      `[catchup] the admission of "${contextGraphId}" could not be read after its activation; asking again `
        + `in ${Math.round(delayMs / 1000)} s (${retry.asked} of ${ACTIVATION_ADMISSION_RETRY_DELAYS_MS.length})`,
    );
  };
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined && !stopped; next = queue.shift()) {
        const contextGraphId = next;
        current = contextGraphId;
        const outcome = await catchUp(input, contextGraphId, live).catch((err: unknown): CatchUpOutcome => {
          input.log(
            `[catchup] could not catch up "${contextGraphId}" after its activation: ${err instanceof Error ? err.message : String(err)}`,
          );
          return 'skipped';
        });
        current = undefined;
        if (stopped) break;
        if (outcome === 'unavailable') askAgainLater(contextGraphId);
        else forgetRetry(contextGraphId);
        if (typeof outcome === 'object') enqueue(outcome.requeue);
      }
    } finally {
      draining = false;
    }
  };
  const onActivated = (data: unknown): void => {
    if (data === null || typeof data !== 'object') return;
    const { contextGraphId } = data as { contextGraphId?: unknown };
    if (typeof contextGraphId === 'string') activated(contextGraphId);
  };

  agent.eventBus.on(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, onActivated);
  // Subscriptions the agent restored before this listener existed.
  for (const [contextGraphId, subscription] of agent.getSubscribedContextGraphs()) {
    if (subscription.subscribed === true && subscription.synced !== true) activated(contextGraphId);
  }
  return () => {
    stopped = true;
    unregisterProgress();
    queue.length = 0;
    for (const retry of retries.values()) {
      if (retry.timer !== undefined) readinessRepeatTimers.clear(retry.timer);
    }
    retries.clear();
    agent.eventBus.off(DKGEvent.CONTEXT_GRAPH_SUBSCRIPTION_ACTIVATED, onActivated);
  };
}

/**
 * The id a subscription is caught up under. One saved under its on-chain name
 * hash lives under its verified cleartext id once the agent has adopted that;
 * the hash-keyed row is gone then.
 */
function currentContextGraphId(input: ActivationCatchupInput, contextGraphId: string): string {
  return input.agent.resolveContextGraphIdAlias?.(contextGraphId) ?? contextGraphId;
}

/** Whether a job may start for this subscription now. */
function wanted(input: ActivationCatchupInput, contextGraphId: string, live: () => boolean): boolean {
  if (!live() || !daemonState.catchupAcceptingJobs || !daemonState.catchupRunner) return false;
  if (systemContextGraphs.has(contextGraphId)) return false;
  if (isDormant(input, contextGraphId)) return false;
  const subscription = input.agent.getSubscribedContextGraphs().get(contextGraphId);
  if (subscription?.subscribed !== true || subscription.synced === true) return false;
  const latestJobId = input.catchupTracker.latestByContextGraph.get(contextGraphId);
  const latest = latestJobId === undefined ? undefined : input.catchupTracker.jobs.get(latestJobId);
  return latest?.status !== 'queued' && latest?.status !== 'running';
}

/** Recovery may expose a provisional subscribed row before activation commits. */
function isDormant(input: ActivationCatchupInput, contextGraphId: string): boolean {
  return input.agent.getContextGraphSubscriptionRehydrationStatus?.()?.dormantIds.includes(contextGraphId) === true;
}

async function catchUp(
  input: ActivationCatchupInput,
  queuedContextGraphId: string,
  live: () => boolean,
): Promise<CatchUpOutcome> {
  // A stopping daemon touches no readiness store.
  if (!live() || !daemonState.catchupAcceptingJobs) return 'skipped';
  // The committed activation event will enqueue it later. Do not migrate or
  // read authority from a provisional row that recovery may still roll back.
  if (isDormant(input, queuedContextGraphId)) return 'skipped';
  // A no-op for rows that carry current provenance; a row that was dormant
  // when the startup pass ran is classified here instead.
  await migrateLegacyContextGraphReadiness({ agent: input.agent, store: input.store, log: input.log });
  const contextGraphId = currentContextGraphId(input, queuedContextGraphId);
  if (!wanted(input, contextGraphId, live)) return 'skipped';
  const admission = await readLocalAgentSubscriptionAdmission(input.agent, contextGraphId);
  // Adopted under its cleartext id while the admission was read: that id is
  // caught up anew, with an admission of its own.
  const adoptedContextGraphId = currentContextGraphId(input, contextGraphId);
  if (adoptedContextGraphId !== contextGraphId) return { requeue: adoptedContextGraphId };
  if (admission === 'unavailable') return 'unavailable';
  if (admission === 'denied') return 'skipped';
  // No await from here to the mint, as on the subscribe route.
  if (!wanted(input, contextGraphId, live)) return 'skipped';
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
  // A repeat reads the admission again as the same local agent.
  followContextGraphCatchupJob({ ...job, requestAgentAddress: admission.callerAgentAddress }, started);
  await started.settled;
  return 'started';
}
