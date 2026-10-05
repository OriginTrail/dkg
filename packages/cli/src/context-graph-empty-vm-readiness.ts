// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import { readContextGraphReadiness } from './context-graph-readiness.js';
import { classifyEmptyPrivateVmReadiness, withProvenEmptyPrivateVmReadiness } from './context-graph-empty-vm-readiness-owner.js';
import { commitContextGraphReadinessPatches } from './context-graph-readiness-commit.js';

type RegisteredAuthority = { source: string; reason?: string; registration?: 'unregistered' };
const trace = (stage: string) => {
  if (process.env.DKG_DEBUG_PRIVATE_EMPTY_VM === '1') console.info(`[private-empty-vm] subscribe-${stage}`);
};

/**
 * The first write follows subscribe, while a foreground catch-up can still be
 * fetching an empty graph. Wait briefly for authenticated local metadata, then
 * commit only the independently proven empty durable plane. The chain and
 * membership proof is the final await before the readiness commit.
 */
export async function settlePrivateEmptyVmAtSubscribe(
  agent: DKGAgent,
  dashboard: DashboardDB,
  contextGraphId: string,
  authority: RegisteredAuthority,
  callerAgentAddress?: string,
): Promise<boolean> {
  if (authority.source !== 'registered-chain' || authority.reason !== 'chain-participant'
    || authority.registration === 'unregistered'
    || callerAgentAddress === undefined) return false;
  trace('candidate');
  const signal = AbortSignal.timeout(8_000);
  const settle = async (): Promise<boolean> => {
    while (!signal.aborted) {
      if (await agent.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => false)) {
        trace('meta-confirmed');
        if (!await agent.isPrivateContextGraph(contextGraphId).catch(() => false)) {
          trace('not-private'); return false;
        }
        if (signal.aborted) return false;
        if (!await withProvenEmptyPrivateVmReadiness({
          agent, contextGraphId, callerAgentAddress, signal,
          commit: () => {
            const patches = classifyEmptyPrivateVmReadiness(
              readContextGraphReadiness(dashboard, contextGraphId),
            );
            commitContextGraphReadinessPatches({
              agent, store: dashboard, contextGraphId, ...patches,
            });
          },
        })) {
          trace('proof-false'); return false;
        }
        trace('vm-ready');
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  };
  // The agent also sees the same signal and rejects a late proof before its
  // synchronous commit. The race bounds this HTTP request even if a backend
  // ignores cancellation while finishing a read-only operation.
  const completed = await Promise.race([
    settle(),
    new Promise<false>((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true })),
  ]);
  if (completed) return true;
  trace('meta-timeout');
  return false;
}
