// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import { withContextGraphReadinessMutationLock, type ContextGraphSubscriptionStatePatch } from './context-graph-readiness.js';
import { mergeContextGraphPlaneEvidence, type ContextGraphReadinessPatch } from './context-graph-readiness-policy.js';

/** A finalized zero-VM proof grants durable readiness only, never SWM. */
export function classifyEmptyPrivateVmReadiness(
  previous: ContextGraphReadinessProvenance,
): { statePatch: ContextGraphSubscriptionStatePatch; readinessPatch: ContextGraphReadinessPatch } {
  const readinessPatch = mergeContextGraphPlaneEvidence(previous, {
    durableVerified: true, sharedMemoryVerified: false,
  });
  return {
    readinessPatch,
    statePatch: {
      synced: true,
      sharedMemorySynced: readinessPatch.sharedMemoryVerified,
      metaSynced: true,
      pendingMeta: false,
    },
  };
}

/** The caller supplies the synchronous readiness commit inside the agent fence. */
export async function withProvenEmptyPrivateVmReadiness(input: {
  agent: DKGAgent;
  contextGraphId: string;
  callerAgentAddress: string;
  commit: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  return withContextGraphReadinessMutationLock(input.agent, input.contextGraphId, () =>
    input.agent.proveRegisteredPrivateEmptyVmV1(
      input.contextGraphId,
      input.callerAgentAddress,
      input.commit,
      input.signal,
    ),
  );
}
