// SPDX-License-Identifier: Apache-2.0

import {
  isRegisteredPrivateEmptyVmReadinessCandidateV1,
  type ContextGraphReadAuthorityDecision,
  type DKGAgent,
} from '@origintrail-official/dkg-agent';
import { resolveWithinAbort } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { readContextGraphReadiness } from './context-graph-readiness.js';
import { classifyEmptyPrivateVmReadiness, withProvenEmptyPrivateVmReadiness } from './context-graph-empty-vm-readiness-owner.js';
import { commitContextGraphReadinessPatches } from './context-graph-readiness-commit.js';

const trace = (stage: string) => {
  if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') console.info(`[private-empty-vm] subscribe-${stage}`);
};

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
  trace('candidate');
  const signal = AbortSignal.timeout(8_000);
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
          trace('proof-false'); return false;
        }
        // A curator metadata refresh or temporary authority outage can
        // invalidate an otherwise valid proof while a fresh join settles.
        // Re-run the agent-owned proof within this subscribe deadline.
        trace('proof-retry');
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
        continue;
      }
      trace('vm-ready');
      return true;
    }
    return false;
  };
  // The agent also sees the same signal and rejects a late proof before its
  // synchronous commit. Bound this HTTP request if a backend ignores cancellation.
  const completed = await resolveWithinAbort(() => settle(), signal);
  if (completed) return true;
  trace(signal.aborted ? 'meta-timeout' : 'settlement-incomplete');
  return false;
}
