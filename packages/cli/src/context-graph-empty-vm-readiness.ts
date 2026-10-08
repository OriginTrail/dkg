// SPDX-License-Identifier: Apache-2.0

import {
  isRegisteredPrivateEmptyVmReadinessCandidateV1,
  type ContextGraphReadAuthorityDecision,
  type DKGAgent,
} from '@origintrail-official/dkg-agent';
import { DKGEvent, resolveWithinAbort } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { readContextGraphReadiness } from './context-graph-readiness.js';
import { classifyEmptyPrivateVmReadiness, withProvenEmptyPrivateVmReadiness } from './context-graph-empty-vm-readiness-owner.js';
import { commitContextGraphReadinessPatches } from './context-graph-readiness-commit.js';

/** What asked for the proof; it only labels the debug trace. */
type SettlementOrigin = 'subscribe' | 'join-metadata';

const trace = (origin: SettlementOrigin, stage: string) => {
  if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') console.info(`[private-empty-vm] ${origin}-${stage}`);
};

/** How long a subscribe request waits for the proof before it answers. */
const SUBSCRIBE_SETTLEMENT_TIMEOUT_MS = 8_000;
/** No request waits on a join's metadata, so slow chain reads get more room. */
const JOIN_METADATA_SETTLEMENT_TIMEOUT_MS = 30_000;

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
  return settlePrivateEmptyVm(
    'subscribe', agent, dashboard, contextGraphId, callerAgentAddress, SUBSCRIBE_SETTLEMENT_TIMEOUT_MS,
  );
}

/**
 * A join approval, and the curator metadata fetched after it, can reach a
 * member after its subscribe call and the catch-up job that call started.
 * Both of those attempts then end before the proof can succeed, and an empty
 * graph gives nothing else a reason to try again, so the member could not
 * write until it subscribed a second time. Run the same proof when the agent
 * reports that metadata as confirmed.
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
}

/**
 * The agent's proof owns every prerequisite, this node's membership included,
 * so a graph it does not apply to settles nothing here. A proven graph is
 * announced the way a catch-up job that proved the same thing announces it.
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
  if (!await settlePrivateEmptyVm(
    'join-metadata', agent, dashboard, contextGraphId, callerAgentAddress, JOIN_METADATA_SETTLEMENT_TIMEOUT_MS,
  )) return false;
  agent.eventBus.emit(DKGEvent.PROJECT_SYNCED, { contextGraphId, dataSynced: 0, sharedMemorySynced: 0 });
  return true;
}

async function settlePrivateEmptyVm(
  origin: SettlementOrigin,
  agent: DKGAgent,
  dashboard: DashboardDB,
  contextGraphId: string,
  callerAgentAddress: string,
  timeoutMs: number,
): Promise<boolean> {
  const signal = AbortSignal.timeout(timeoutMs);
  // One second within the subscribe deadline; a longer deadline retries less often.
  const maxRetryDelayMs = Math.max(1_000, Math.floor(timeoutMs / 8));
  const settle = async (): Promise<boolean> => {
    let retryDelayMs = 250;
    while (!signal.aborted) {
      const proof = await withProvenEmptyPrivateVmReadiness({
        agent, contextGraphId, callerAgentAddress, signal,
        commit: () => {
          const patches = classifyEmptyPrivateVmReadiness(
            readContextGraphReadiness(dashboard, contextGraphId),
          );
          commitContextGraphReadinessPatches({
            agent, store: dashboard, contextGraphId, ...patches,
          });
        },
      });
      if (!proof.proven) {
        if (!proof.retryable || signal.aborted) {
          trace(origin, 'proof-false'); return false;
        }
        // A curator metadata refresh or temporary authority outage can
        // invalidate an otherwise valid proof while a fresh join settles.
        // Re-run the agent-owned proof within this deadline.
        trace(origin, 'proof-retry');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, maxRetryDelayMs);
        continue;
      }
      trace(origin, 'vm-ready');
      return true;
    }
    return false;
  };
  // The agent also sees the same signal and rejects a late proof before its
  // synchronous commit. Bound the wait if a backend ignores cancellation.
  const completed = await resolveWithinAbort(() => settle(), signal);
  if (completed) return true;
  trace(origin, signal.aborted ? 'meta-timeout' : 'settlement-incomplete');
  return false;
}
