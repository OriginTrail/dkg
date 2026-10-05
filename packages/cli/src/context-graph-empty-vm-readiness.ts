// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { CatchupJobResult } from './catchup-runner.js';
import { catchupResultHasCleanResponse } from './context-graph-readiness.js';

/** Inspect local metadata, then seek an independent finalized zero-VM proof. */
export async function inspectPrivateEmptyVmCatchup(
  agent: DKGAgent,
  contextGraphId: string,
  result: CatchupJobResult,
  authority: { source: string; registration?: 'unregistered' },
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
