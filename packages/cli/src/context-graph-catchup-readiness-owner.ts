// SPDX-License-Identifier: Apache-2.0

import {
  isRegisteredPrivateEmptyVmReadinessCandidateV1,
  type ContextGraphReadAuthorityDecision,
  type DKGAgent,
  type InspectedPrivateEmptyVmReadinessV1,
} from '@origintrail-official/dkg-agent';
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
/** Own metadata inspection, live authority, classification, and persistence at completion. */
export async function classifyAndCommitContextGraphCatchup(input: CompletionInputs & {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  callerAgentAddress?: string;
  admissionAuthority: ContextGraphReadAuthorityDecision;
}): Promise<ReturnType<typeof classifyContextGraphCatchupReadiness>> {
  const { agent, store, contextGraphId, result, callerAgentAddress } = input;
  const privateZeroVmCandidate = isRegisteredPrivateEmptyVmReadinessCandidateV1(
    input.admissionAuthority, callerAgentAddress,
  ) && result.dataSynced === 0;

  const decide = (completion: InspectedPrivateEmptyVmReadinessV1) => {
    // The agent's final inspection and proof arrive in the same synchronous
    // callback. Normalize this source to durable-plane evidence here; the
    // classifier handles only plane evidence and peer status.
    const independentPlaneEvidence = completion.proven
      ? { durable: { ready: true, persistable: true } } : undefined;
    const classification = classifyContextGraphCatchupReadiness({
      result, includeSharedMemory: input.includeSharedMemory,
      inspection: completion.inspection, independentPlaneEvidence,
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

  // Finalized chain reads can take tens of seconds. Prepare that optional
  // evidence first so catalog readiness for this graph is not lock-starved.
  const preparation = await agent.prepareContextGraphReadinessWithPrivateEmptyVmV1({
    contextGraphId,
    attemptPrivateEmptyVm: privateZeroVmCandidate,
    callerAgentAddress,
  });
  return withContextGraphReadinessMutationLock(agent, contextGraphId, () => {
    // The agent owns one final live inspection for both proof outcomes. A
    // failed proof cannot reuse admission-time authority, and no await can
    // separate the final fence from classification or persistence.
    return preparation.inspectAndCommit({
      inspectMetadata: catchupResultHasCleanResponse(result) || privateZeroVmCandidate,
    }, decide);
  });
}
