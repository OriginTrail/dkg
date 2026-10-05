// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from '@origintrail-official/dkg-agent';
import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import {
  classifyContextGraphCatchupReadiness,
  readContextGraphReadiness,
  withContextGraphReadinessMutationLock,
  writeContextGraphReadiness,
  type ContextGraphReadinessStore,
  type ContextGraphSubscriptionStatePatch,
} from './context-graph-readiness.js';
import {
  mergeContextGraphPlaneEvidence,
  type ContextGraphReadinessPatch,
} from './context-graph-readiness-policy.js';

/** The same plane policy used by early subscribe and terminal catch-up. */
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

/** Apply one classifier decision without an await between its two stores. */
export function commitContextGraphReadinessPatches(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  statePatch?: ContextGraphSubscriptionStatePatch;
  readinessPatch?: ContextGraphReadinessPatch;
}): void {
  if (input.readinessPatch) {
    writeContextGraphReadiness(input.store, input.contextGraphId, input.readinessPatch);
  }
  if (input.statePatch) {
    input.agent.markContextGraphSubscriptionState(input.contextGraphId, input.statePatch);
  }
}

/** Commit inside the agent's metadata-generation fence and readiness lock. */
export async function withProvenEmptyPrivateVmReadiness(input: {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  callerAgentAddress: string;
  onProof?: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  return withContextGraphReadinessMutationLock(input.agent, input.contextGraphId, () =>
    input.agent.proveRegisteredPrivateEmptyVmV1(
      input.contextGraphId,
      input.callerAgentAddress,
      () => {
        if (input.onProof) {
          input.onProof();
        } else {
          const patches = classifyEmptyPrivateVmReadiness(
            readContextGraphReadiness(input.store, input.contextGraphId),
          );
          commitContextGraphReadinessPatches({ ...input, ...patches });
        }
      },
      input.signal,
    ),
  );
}

type CompletionInputs = Pick<
  Parameters<typeof classifyContextGraphCatchupReadiness>[0],
  'result' | 'includeSharedMemory' | 'completionAuthority'
>;

/** Finish a catch-up using live metadata and one canonical readiness commit. */
export async function classifyAndCommitEmptyPrivateVmCatchup(input: CompletionInputs & {
  agent: DKGAgent;
  store: Partial<ContextGraphReadinessStore>;
  contextGraphId: string;
  callerAgentAddress?: string;
  privateEmptyVmCandidate: boolean;
  hasConfirmedMeta: boolean | undefined;
  isPrivate: boolean;
}): Promise<ReturnType<typeof classifyContextGraphCatchupReadiness>> {
  const decide = (
    confirmedMeta: boolean | undefined,
    privateGraph: boolean,
    finalizedEmptyRegisteredPrivateVm: boolean,
  ) => {
    const classification = classifyContextGraphCatchupReadiness({
      result: input.result,
      includeSharedMemory: input.includeSharedMemory,
      completionAuthority: input.completionAuthority,
      hasConfirmedMeta: confirmedMeta,
      isPrivate: privateGraph,
      finalizedEmptyRegisteredPrivateVm,
      // Automatic catalog recovery may complete during foreground catch-up.
      readinessBeforeCatchup: readContextGraphReadiness(input.store, input.contextGraphId),
    });
    commitContextGraphReadinessPatches({
      agent: input.agent, store: input.store, contextGraphId: input.contextGraphId,
      statePatch: classification.statePatch,
      readinessPatch: classification.readinessPatch,
    });
    return classification;
  };
  let provenClassification: ReturnType<typeof decide> | undefined;
  if (input.privateEmptyVmCandidate && input.callerAgentAddress !== undefined) {
    await withProvenEmptyPrivateVmReadiness({
      ...input,
      callerAgentAddress: input.callerAgentAddress,
      onProof: () => { provenClassification = decide(true, true, true); },
    });
  }
  if (provenClassification) return provenClassification;
  return withContextGraphReadinessMutationLock(input.agent, input.contextGraphId, async () => {
    // Never reuse metadata inspected before the asynchronous chain proof.
    const confirmedMeta = input.privateEmptyVmCandidate
      ? await input.agent.hasConfirmedMetaState(input.contextGraphId).catch(() => false)
      : input.hasConfirmedMeta;
    const privateGraph = confirmedMeta && input.privateEmptyVmCandidate
      ? await input.agent.isPrivateContextGraph(input.contextGraphId).catch(() => true)
      : input.isPrivate;
    return decide(confirmedMeta, privateGraph, false);
  });
}
