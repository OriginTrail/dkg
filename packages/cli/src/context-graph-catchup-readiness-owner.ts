// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
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

  const decide = (
    inspection: {
      hasConfirmedMeta: boolean | undefined;
      isPrivate: boolean;
      authority: { outcome: 'allowed' | 'denied' | 'unavailable'; registration?: 'unregistered' };
    },
    finalizedEmptyRegisteredPrivateVm: boolean,
  ) => {
    const classification = classifyContextGraphCatchupReadiness({
      result, includeSharedMemory: input.includeSharedMemory,
      completionAuthority: inspection.authority,
      hasConfirmedMeta: inspection.hasConfirmedMeta,
      isPrivate: inspection.isPrivate,
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

  if (privateZeroVmCandidate && callerAgentAddress !== undefined) {
    const proof = await withContextGraphReadinessMutationLock(agent, contextGraphId, () =>
      agent.proveRegisteredPrivateEmptyVmV1(
        contextGraphId, callerAgentAddress,
        (inspection) => decide(inspection, true),
      ),
    );
    if (proof.proven) return proof.value;
  }

  return withContextGraphReadinessMutationLock(agent, contextGraphId, () => {
    // A failed proof may mean revoked membership, not merely a transient read
    // error. Never reuse admission-time authority or metadata in that path.
    return agent.inspectAndCommitContextGraphReadinessV1({
      contextGraphId,
      inspectMetadata: catchupResultHasCleanResponse(result) || privateZeroVmCandidate,
      callerAgentAddress,
    }, (inspection) => decide(inspection, false));
  });
}
