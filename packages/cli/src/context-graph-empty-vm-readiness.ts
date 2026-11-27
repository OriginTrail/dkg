// SPDX-License-Identifier: Apache-2.0

import {
  isRegisteredPrivateEmptyVmReadinessCandidateV1,
  type ContextGraphReadAuthorityDecision,
  type DKGAgent,
  type InspectedPrivateEmptyVmReadinessV1,
} from '@origintrail-official/dkg-agent';
import { DKGEvent, resolveWithinAbort, startRequestAbortLifecycle } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { readContextGraphReadiness, type ContextGraphReadinessStore } from './context-graph-readiness.js';
import { classifyEmptyPrivateVmReadiness, withProvenEmptyPrivateVmReadiness } from './context-graph-empty-vm-readiness-owner.js';
import { armPrivateEmptyVmRepeat, expeditePrivateEmptyVmRepeat } from './context-graph-empty-vm-repeat.js';
import { commitContextGraphReadinessPatches } from './context-graph-readiness-commit.js';

/** What asked for the proof: it labels the settlement's log line. */
type SettlementOrigin = 'subscribe' | 'join-metadata' | 'catchup' | 'repeat';

const trace = (origin: SettlementOrigin, stage: string) => {
  if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') console.info(`[private-empty-vm] ${origin}-${stage}`);
};

/** How long a subscribe request waits for the proof before it answers. */
const SUBSCRIBE_SETTLEMENT_TIMEOUT_MS = 8_000;
/** No request waits on a join's metadata or a repeat, so slow chain reads get more room. */
const BACKGROUND_SETTLEMENT_TIMEOUT_MS = 30_000;

interface PrivateEmptyVmSettlement {
  readonly proven: boolean;
  /** Nothing a later attempt can see changes this answer. */
  readonly final?: boolean;
}

/** One log line for each settlement that ran, whatever its end: `stage` is where. */
function logSettlementEnd(origin: SettlementOrigin, contextGraphId: string, stage: string): void {
  console.info(`[private-empty-vm] settlement ended: contextGraph=${contextGraphId} origin=${origin} stage=${stage}`);
}

/**
 * A settlement that ended unproven, for a reason a later attempt can change, on
 * a graph still subscribed and unsynced: try again later. Each repeat is another
 * settlement, under the same proof and the same readiness lock.
 */
function repeatUnlessSettled(
  settlement: PrivateEmptyVmSettlement,
  agent: DKGAgent,
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  callerAgentAddress: string,
): void {
  if (settlement.proven || settlement.final === true) return;
  const subscription = agent.getSubscribedContextGraphs().get(contextGraphId);
  if (subscription?.subscribed !== true || subscription.synced === true) return;
  armPrivateEmptyVmRepeat({
    agent,
    contextGraphId,
    callerAgentAddress,
    attempt: async () => {
      const repeated = await settlePrivateEmptyVm(
        'repeat', agent, store, contextGraphId, callerAgentAddress, BACKGROUND_SETTLEMENT_TIMEOUT_MS,
        agent.node?.stopSignal,
      );
      if (repeated.proven) announceProvenEmptyGraph(agent, contextGraphId);
      return repeated;
    },
  });
}

/** A proven graph is announced the way a catch-up job that proved the same thing announces it. */
function announceProvenEmptyGraph(agent: DKGAgent, contextGraphId: string): void {
  agent.eventBus.emit(DKGEvent.PROJECT_SYNCED, { contextGraphId, dataSynced: 0, sharedMemorySynced: 0 });
}

/**
 * The first write follows subscribe, while a foreground catch-up can still be
 * fetching an empty graph. The agent owns metadata, privacy, chain, and
 * membership prerequisites; this caller only retries its transient outcome
 * within the subscribe deadline. The proof's final fence owns the commit.
 */
export async function settlePrivateEmptyVmAtSubscribe(
  agent: DKGAgent,
  dashboard: DashboardDB,
  contextGraphId: string,
  authority: ContextGraphReadAuthorityDecision,
  callerAgentAddress?: string,
): Promise<boolean> {
  if (!isRegisteredPrivateEmptyVmReadinessCandidateV1(authority, callerAgentAddress)) return false;
  trace('subscribe', 'candidate');
  const settlement = await settlePrivateEmptyVm(
    'subscribe', agent, dashboard, contextGraphId, callerAgentAddress, SUBSCRIBE_SETTLEMENT_TIMEOUT_MS,
    agent.node?.stopSignal,
  );
  repeatUnlessSettled(settlement, agent, dashboard, contextGraphId, callerAgentAddress);
  return settlement.proven;
}

/**
 * A catch-up job's own attempt at the proof, in its readiness commit
 * (`context-graph-catchup-readiness-owner.ts`), in its turn: it waits for a
 * settlement already running, whose deadline bounds the wait, and one that starts
 * meanwhile takes this attempt's result. It counts as a settlement: it logs its
 * end, and an unproven one is tried again later.
 */
export async function runPrivateEmptyVmAttemptAtCatchup<T>(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  callerAgentAddress: string;
  /** What the job classified, and the agent's final answer it classified it on. */
  attempt: () => Promise<{ readonly value: T; readonly completion: InspectedPrivateEmptyVmReadinessV1 }>;
}): Promise<T> {
  const { agent, store, contextGraphId, callerAgentAddress } = input;
  const running = settlementsRunning(agent);
  for (let inFlight = running.get(contextGraphId); inFlight !== undefined; inFlight = running.get(contextGraphId)) {
    await inFlight.settlement.catch(() => undefined);
  }
  const attempt = input.attempt();
  const settlement = attempt.then(({ completion }): PrivateEmptyVmSettlement => {
    logSettlementEnd('catchup', contextGraphId, completion.proven ? 'vm-ready' : completion.stage ?? 'proof-false');
    return { proven: completion.proven, ...(!completion.proven && completion.final === true ? { final: true } : {}) };
  }, (): PrivateEmptyVmSettlement => ({ proven: false }));
  running.set(contextGraphId, { callerAgentAddress, settlement });
  try {
    const { value } = await attempt;
    repeatUnlessSettled(await settlement, agent, store, contextGraphId, callerAgentAddress);
    return value;
  } finally {
    running.delete(contextGraphId);
  }
}

/**
 * A join approval, and the curator metadata fetched after it, can reach a
 * member after its subscribe call and the catch-up job that call started.
 * Both of those attempts then end before the proof can succeed, and an empty
 * graph gives nothing else a reason to try again, so the member could not
 * write until it subscribed a second time. Run the same proof when the agent
 * reports that metadata as confirmed. An accepted authority for the graph only
 * brings a repeat already armed forward.
 */
export function registerJoinMetadataEmptyVmSettlement(input: {
  agent: DKGAgent;
  dashboard: DashboardDB;
  log: (message: string) => void;
}): void {
  input.agent.eventBus.on(DKGEvent.JOIN_METADATA_CONFIRMED, (data: unknown) => {
    if (data === null || typeof data !== 'object') return;
    const { contextGraphId, agentAddress } = data as { contextGraphId?: unknown; agentAddress?: unknown };
    if (typeof contextGraphId !== 'string' || typeof agentAddress !== 'string') return;
    void settlePrivateEmptyVmAfterJoinMetadata(
      input.agent, input.dashboard, contextGraphId, agentAddress,
    ).catch((err) => {
      input.log(`[warn] Failed to settle empty-graph readiness after join metadata: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  input.agent.eventBus.on(DKGEvent.CATALOG_READINESS_CHECK_REQUESTED, (data: unknown) => {
    if (data === null || typeof data !== 'object') return;
    const { contextGraphId } = data as { contextGraphId?: unknown };
    if (typeof contextGraphId === 'string') expeditePrivateEmptyVmRepeat(input.agent, contextGraphId);
  });
}

/**
 * The agent's proof owns every prerequisite, this node's membership included,
 * so a graph it does not apply to settles nothing here. A proven graph is
 * announced the way a catch-up job that proved the same thing announces it.
 *
 * No request owns this work, so the node does: it ends when the node begins
 * to stop, and the proof's own fence then refuses to commit.
 */
export async function settlePrivateEmptyVmAfterJoinMetadata(
  agent: DKGAgent,
  dashboard: DashboardDB,
  contextGraphId: string,
  callerAgentAddress: string,
): Promise<boolean> {
  const subscription = agent.getSubscribedContextGraphs().get(contextGraphId);
  if (subscription?.subscribed !== true || subscription.synced === true) return false;
  trace('join-metadata', 'candidate');
  const settlement = await settlePrivateEmptyVm(
    'join-metadata', agent, dashboard, contextGraphId, callerAgentAddress, BACKGROUND_SETTLEMENT_TIMEOUT_MS,
    agent.node?.stopSignal,
  );
  repeatUnlessSettled(settlement, agent, dashboard, contextGraphId, callerAgentAddress);
  if (!settlement.proven) return false;
  announceProvenEmptyGraph(agent, contextGraphId);
  return true;
}

interface RunningSettlement {
  readonly callerAgentAddress: string;
  readonly settlement: Promise<PrivateEmptyVmSettlement>;
}

/** The settlement running for each graph of an agent. */
const settlementsInFlight = new WeakMap<DKGAgent, Map<string, RunningSettlement>>();

function settlementsRunning(agent: DKGAgent): Map<string, RunningSettlement> {
  let running = settlementsInFlight.get(agent);
  if (running === undefined) {
    running = new Map();
    settlementsInFlight.set(agent, running);
  }
  return running;
}

/**
 * One attempt runs per graph. A caller that finds one running waits for it,
 * within its own deadline. It takes the result of its own caller's attempt, and of
 * another caller's only if that proved the graph: a proof holds for the graph, but
 * a refusal is an answer for the caller it was read for, so the next caller then
 * makes its own attempt.
 */
async function settlePrivateEmptyVm(
  origin: SettlementOrigin,
  agent: DKGAgent,
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  callerAgentAddress: string,
  timeoutMs: number,
  stopSignal?: AbortSignal,
): Promise<PrivateEmptyVmSettlement> {
  const running = settlementsRunning(agent);
  const { signal, release } = startRequestAbortLifecycle(timeoutMs, [stopSignal]);
  try {
    for (let inFlight = running.get(contextGraphId); inFlight !== undefined; inFlight = running.get(contextGraphId)) {
      const { settlement } = inFlight;
      const sameCaller = inFlight.callerAgentAddress.toLowerCase() === callerAgentAddress.toLowerCase();
      const settled = await resolveWithinAbort(
        () => (sameCaller ? settlement : settlement.catch((): PrivateEmptyVmSettlement => ({ proven: false }))),
        signal,
      );
      if (settled === null) return { proven: false };
      if (sameCaller || settled.proven) return settled;
    }
    const settlement = runSettlement(origin, agent, store, contextGraphId, callerAgentAddress, timeoutMs, signal, stopSignal);
    running.set(contextGraphId, { callerAgentAddress, settlement });
    try {
      return await settlement;
    } finally {
      running.delete(contextGraphId);
    }
  } finally {
    release();
  }
}

async function runSettlement(
  origin: SettlementOrigin,
  agent: DKGAgent,
  store: Partial<ContextGraphReadinessStore>,
  contextGraphId: string,
  callerAgentAddress: string,
  timeoutMs: number,
  signal: AbortSignal,
  stopSignal?: AbortSignal,
): Promise<PrivateEmptyVmSettlement> {
  // One second within the subscribe deadline; a longer deadline retries less often.
  const maxRetryDelayMs = Math.max(1_000, Math.floor(timeoutMs / 8));
  const lastProof: { stage?: string } = {};
  const settle = async (): Promise<PrivateEmptyVmSettlement & { stage: string }> => {
    let retryDelayMs = 250;
    while (!signal.aborted) {
      const proof = await withProvenEmptyPrivateVmReadiness({
        agent, contextGraphId, callerAgentAddress, signal,
        commit: () => {
          const patches = classifyEmptyPrivateVmReadiness(
            readContextGraphReadiness(store, contextGraphId),
          );
          commitContextGraphReadinessPatches({
            agent, store, contextGraphId, ...patches,
          });
        },
      });
      if (proof.proven) return { proven: true, stage: 'vm-ready' };
      if (proof.stage !== undefined) lastProof.stage = proof.stage;
      // A repeat is one pass: its schedule is the retry.
      if (!proof.retryable || origin === 'repeat' || signal.aborted) {
        return { proven: false, stage: proof.stage ?? 'proof-false', ...(proof.final === true ? { final: true } : {}) };
      }
      // A curator metadata refresh or temporary authority outage can
      // invalidate an otherwise valid proof while a fresh join settles.
      // Re-run the agent-owned proof within this deadline.
      trace(origin, 'proof-retry');
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
    }
    return { proven: false, stage: 'meta-timeout' };
  };
  // The agent also sees the same signal and rejects a late proof before its
  // synchronous commit. Bound the wait if a backend ignores cancellation.
  const ended = await resolveWithinAbort(() => settle(), signal)
    ?? { proven: false, stage: stopSignal?.aborted ? 'node-stopping' : 'meta-timeout' };
  logSettlementEnd(
    origin, contextGraphId,
    ended.stage === 'meta-timeout' && lastProof.stage !== undefined ? `meta-timeout after=${lastProof.stage}` : ended.stage,
  );
  return ended;
}
