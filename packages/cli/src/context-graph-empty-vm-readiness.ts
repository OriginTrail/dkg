// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import type { CatchupJobResult } from './catchup-runner.js';
import { catchupResultHasCleanResponse, readContextGraphReadiness, writeContextGraphReadiness } from './context-graph-readiness.js';

type RegisteredAuthority = { source: string; registration?: 'unregistered' };

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
  if (authority.source !== 'registered-chain' || authority.registration === 'unregistered'
    || callerAgentAddress === undefined) return false;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await agent.hasConfirmedMetaState(contextGraphId).catch(() => false)) {
      if (!await agent.isPrivateContextGraph(contextGraphId).catch(() => false)) return false;
      if (!await agent.proveRegisteredPrivateEmptyVmV1(contextGraphId, callerAgentAddress)) return false;
      const current = readContextGraphReadiness(dashboard, contextGraphId);
      writeContextGraphReadiness(dashboard, contextGraphId, {
        durableVerified: true,
        sharedMemoryVerified: current.sharedMemoryVerified,
      });
      agent.markContextGraphSubscriptionState(contextGraphId, {
        synced: true, metaSynced: true, pendingMeta: false,
      });
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Inspect local metadata, then seek an independent finalized zero-VM proof. */
export async function inspectPrivateEmptyVmCatchup(
  agent: DKGAgent,
  contextGraphId: string,
  result: CatchupJobResult,
  authority: RegisteredAuthority,
  callerAgentAddress?: string,
): Promise<{
  hasConfirmedMeta: boolean | undefined;
  isPrivate: boolean;
  finalizedEmptyRegisteredPrivateVm: boolean;
}> {
  const candidate = authority.source === 'registered-chain'
    && authority.registration !== 'unregistered'
    && callerAgentAddress !== undefined && result.dataSynced === 0;
  const hasConfirmedMeta = catchupResultHasCleanResponse(result) || candidate
    ? await agent.hasConfirmedMetaState(contextGraphId).catch(() => undefined)
    : undefined;
  const isPrivate = hasConfirmedMeta
    ? await agent.isPrivateContextGraph(contextGraphId).catch(() => true)
    : false;
  const finalizedEmptyRegisteredPrivateVm = candidate && isPrivate
    && hasConfirmedMeta === true && callerAgentAddress !== undefined
    ? await agent.proveRegisteredPrivateEmptyVmV1(contextGraphId, callerAgentAddress)
    : false;
  return { hasConfirmedMeta, isPrivate, finalizedEmptyRegisteredPrivateVm };
}
