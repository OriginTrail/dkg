// SPDX-License-Identifier: Apache-2.0

import {
  assertSafeIri,
  contextGraphMetaUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  swmKaWriteLockKey,
  withKeyedLocks,
  workspaceKnowledgeAssetHeadSubject,
} from '@origintrail-official/dkg-publisher';

export const FINALIZATION_RECOVERY_ELIGIBILITY_QUERY_SOURCE =
  'agent.finalization.localWorkspaceOwnership';

export interface FinalizationRecoveryEligibilityInput {
  readonly contextGraphId: string;
  readonly ual: string;
  readonly subGraphName?: string;
  readonly targetContextGraphId?: string;
  readonly onProbeError?: (error: unknown) => void;
}

export type FinalizationRecoveryEligibility = (
  input: FinalizationRecoveryEligibilityInput,
) => Promise<boolean>;

export interface DurableFinalizationRecoveryEligibilityOptions {
  readonly store: TripleStore;
  /** The publisher's canonical SWM per-KA lock domain. */
  readonly writeLocks?: Map<string, Promise<void>>;
}

/**
 * Create the durable-record admission policy used before inbox journaling.
 * SWM presence is observed under the same per-KA lock as head replacement,
 * while VM metadata remains an independent durable ownership signal. Store
 * failures fail open so a transient probe cannot discard a chain command.
 */
export function createDurableFinalizationRecoveryEligibility(
  options: DurableFinalizationRecoveryEligibilityOptions,
): FinalizationRecoveryEligibility {
  const graphManager = new GraphManager(options.store);
  return async (input) => {
    const probe = async (): Promise<boolean> => {
      try {
        const swmMetaGraph = graphManager.sharedMemoryMetaUri(
          input.contextGraphId,
          input.subGraphName,
        );
        const vmMetaGraphs = [contextGraphMetaUri(input.contextGraphId)];
        if (input.targetContextGraphId) {
          vmMetaGraphs.push(contextGraphMetaUri(
            input.contextGraphId,
            input.targetContextGraphId,
          ));
        }
        const headSubject = workspaceKnowledgeAssetHeadSubject(input.ual);
        const vmOwnershipPatterns = vmMetaGraphs.map((vmMetaGraph) => (
          `{ GRAPH <${assertSafeIri(vmMetaGraph)}> { `
            + `<${assertSafeIri(input.ual)}> ?p ?o . } }`
        ));
        const result = await options.store.query(
          `SELECT ?p WHERE { { GRAPH <${assertSafeIri(swmMetaGraph)}> { `
            + `<${assertSafeIri(headSubject)}> ?p ?o . } } UNION `
            + `${vmOwnershipPatterns.join(' UNION ')} } LIMIT 1`,
          { source: FINALIZATION_RECOVERY_ELIGIBILITY_QUERY_SOURCE },
        );
        return result.type === 'bindings' && result.bindings.length > 0;
      } catch (error) {
        input.onProbeError?.(error);
        return true;
      }
    };

    if (!options.writeLocks) return probe();
    return withKeyedLocks(
      options.writeLocks,
      [swmKaWriteLockKey(
        input.contextGraphId,
        input.subGraphName,
        input.ual,
      )],
      probe,
    );
  };
}
