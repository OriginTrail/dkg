// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  catchupResultHasCleanResponse,
  classifyContextGraphCatchupReadiness,
  readContextGraphReadiness,
  withContextGraphReadinessMutationLock,
  type ContextGraphCatchupCompletionAuthority,
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

  const inspectMetadata = async () => {
    const hasConfirmedMeta = catchupResultHasCleanResponse(result) || privateZeroVmCandidate
      ? await agent.hasConfirmedMetaState(contextGraphId).catch(() => undefined)
      : undefined;
    const isPrivate = hasConfirmedMeta
      ? await agent.isPrivateContextGraph(contextGraphId).catch(() => true)
      : false;
    return { hasConfirmedMeta, isPrivate };
  };
  const decide = (
    metadata: Awaited<ReturnType<typeof inspectMetadata>>,
    completionAuthority: ContextGraphCatchupCompletionAuthority,
    finalizedEmptyRegisteredPrivateVm: boolean,
  ) => {
    const classification = classifyContextGraphCatchupReadiness({
      result, includeSharedMemory: input.includeSharedMemory,
      completionAuthority, ...metadata, finalizedEmptyRegisteredPrivateVm,
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
    const metadata = await inspectMetadata();
    if (metadata.hasConfirmedMeta && metadata.isPrivate) {
      let provenClassification: ReturnType<typeof decide> | undefined;
      await withContextGraphReadinessMutationLock(agent, contextGraphId, () =>
        agent.proveRegisteredPrivateEmptyVmV1(contextGraphId, callerAgentAddress, () => {
          // The agent's final chain, membership, metadata, and revision fence
          // is immediately before this synchronous commit. A valid proof is
          // itself current registered-private authority for this decision.
          provenClassification = decide(
            { hasConfirmedMeta: true, isPrivate: true },
            { outcome: 'allowed' },
            true,
          );
        }),
      );
      if (provenClassification) return provenClassification;
    }
  }

  return withContextGraphReadinessMutationLock(agent, contextGraphId, async () => {
    // A failed proof may mean revoked membership, not merely a transient read
    // error. Never reuse admission-time authority or metadata in that path.
    const completionAuthority = privateZeroVmCandidate
      || input.admissionAuthority.registration === 'unregistered'
      ? await agent.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
          callerAgentAddress, allowSubscriptionFallback: false,
        }).catch(() => ({ outcome: 'unavailable' as const }))
      : input.admissionAuthority;
    return decide(await inspectMetadata(), completionAuthority, false);
  });
}
