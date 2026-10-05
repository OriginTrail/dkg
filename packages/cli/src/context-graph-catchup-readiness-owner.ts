// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent, InspectedContextGraphReadinessV1 } from '@origintrail-official/dkg-agent';
import {
  catchupResultHasCleanResponse,
  classifyContextGraphCatchupReadiness,
  readContextGraphReadiness,
  withContextGraphReadinessMutationLock,
  type ContextGraphReadinessStore,
} from './context-graph-readiness.js';
import { commitContextGraphReadinessPatches } from './context-graph-readiness-commit.js';

type CompletionInputs = Pick<
  Parameters<typeof classifyContextGraphCatchupReadiness>[0],
  'result' | 'includeSharedMemory'
>;
type AdmissionAuthority = Awaited<ReturnType<DKGAgent['resolveContextGraphSubscriptionBootstrapAuthority']>>;

/** Own metadata inspection, live authority, classification, and persistence at completion. */
export async function classifyAndCommitContextGraphCatchup(input: CompletionInputs & {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  callerAgentAddress?: string;
  admissionAuthority: AdmissionAuthority;
}): Promise<ReturnType<typeof classifyContextGraphCatchupReadiness>> {
  const { agent, store, contextGraphId, result, callerAgentAddress } = input;
  const privateZeroVmCandidate = input.admissionAuthority.outcome === 'allowed'
    && input.admissionAuthority.source === 'registered-chain'
    && input.admissionAuthority.reason === 'chain-participant'
    && input.admissionAuthority.registration !== 'unregistered'
    && callerAgentAddress !== undefined && result.dataSynced === 0;

  const decide = (inspection: InspectedContextGraphReadinessV1, finalizedEmptyRegisteredPrivateVm: boolean) => {
    const classification = inspection.kind === 'invalidated'
      ? {
          durablePlane: inspection.authority.outcome === 'allowed'
            && inspection.authority.registration === 'unregistered'
            ? 'not-applicable' as const : 'required' as const,
          jobStatus: inspection.authority.outcome === 'denied' ? 'denied' as const : 'unreachable' as const,
          error: inspection.authority.outcome === 'denied'
            ? 'Context-graph authority denied access at catch-up completion.'
            : 'Context-graph readiness inspection was invalidated before completion. Retry after metadata stabilizes.',
          statePatch: { synced: false, sharedMemorySynced: false },
          readinessPatch: { durableVerified: false, sharedMemoryVerified: false },
        }
      : classifyContextGraphCatchupReadiness({
          result, includeSharedMemory: input.includeSharedMemory,
          completionAuthority: inspection.authority,
          metadata: inspection.metadata,
          finalizedEmptyRegisteredPrivateVm,
          // Catalog recovery can finish while the foreground catch-up runs.
          readinessBeforeCatchup: readContextGraphReadiness(store, contextGraphId),
        });
    commitContextGraphReadinessPatches({
      agent, store, contextGraphId,
      statePatch: classification.statePatch,
      readinessPatch: classification.readinessPatch,
    });
    return classification;
  };

  return withContextGraphReadinessMutationLock(agent, contextGraphId, () => {
    // The agent owns one final live inspection for both proof outcomes. A
    // failed proof cannot reuse admission-time authority, and no await can
    // separate the final fence from classification or persistence.
    return agent.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId,
      inspectMetadata: catchupResultHasCleanResponse(result) || privateZeroVmCandidate,
      attemptPrivateEmptyVm: privateZeroVmCandidate,
      callerAgentAddress,
    }, (inspection, proof) => decide(inspection, proof.proven));
  });
}
