// SPDX-License-Identifier: Apache-2.0

import type { OperationContext } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from '../dkg-agent-base.js';
import type { DKGAgent } from '../dkg-agent.js';
import { retireRfc64LegacySwmAfterFinalizedVmV1 } from '../rfc64/legacy-swm-boundary-v1.js';
import { completeVerifiedVmMarkerRetirement, type VerifiedVmMarkerRetirementEvidence } from './finalized-swm-retirement-completion.js';
import type { FinalizedSwmTwinReconciliationResult, FinalizedSwmTwinRetirement } from '../sync/requester/finalized-swm-twin-reconciliation.js';

/** Agent-owned completion and recovery-marker retirement after verified VM convergence. */
export class FinalizedSwmRetirementMethods extends DKGAgentBase {
  async completeVerifiedVmMarkerRetirement(
    this: DKGAgent,
    evidence: VerifiedVmMarkerRetirementEvidence,
    ctx: OperationContext,
  ): Promise<void> {
    await completeVerifiedVmMarkerRetirement({
      evidence,
      retireMarker: (input) => this.retireLegacySwmAfterVerifiedVmTwin(input),
      warn: (message) => this.log.warn(ctx, message),
      scheduleRetry: (key, work) => this.rfc64BackgroundWorkDispatcherV1.scheduleKeyed(key, work),
    });
    this.invalidateListContextGraphsCache();
  }

  async completeFinalizedSwmTwinRetirement(
    this: DKGAgent,
    result: FinalizedSwmTwinReconciliationResult,
    ctx: OperationContext,
  ): Promise<FinalizedSwmTwinReconciliationResult> {
    if ('retirement' in result) {
      await this.completeVerifiedVmMarkerRetirement(result.retirement, ctx);
    }
    return result;
  }

  async retireLegacySwmAfterVerifiedVmTwin(
    this: DKGAgent,
    input: Readonly<{
      contextGraphId: string;
      kaUal: string;
      assertionVersion: string | bigint;
      subGraphName?: string;
    }>,
  ): Promise<void> {
    await retireRfc64LegacySwmAfterFinalizedVmV1(
      this,
      input.contextGraphId,
      input.kaUal,
      String(input.assertionVersion),
      input.subGraphName,
    );
  }

  async retireFinalizedSwmTwinCandidate(
    candidate: FinalizedSwmTwinRetirement,
    ctx: OperationContext,
  ): Promise<void> {
    await this.publisher.clearPublishedKnowledgeAssetSwm(
      candidate.contextGraphId,
      {
        kind: 'named-lifecycle',
        identity: {
          agentAddress: candidate.agentAddress,
          kaNumber: candidate.kaNumber,
        },
      },
      candidate.subGraphName,
      ctx,
      candidate.kaUal,
    );
  }

}

/** Keep all executor retirement callbacks bound to the same lifecycle owner. */
export function bindFinalizedSwmRetirement(owner: DKGAgent) {
  return {
    retireFinalizedSwmTwin: (...args: Parameters<DKGAgent['retireFinalizedSwmTwinCandidate']>) => owner.retireFinalizedSwmTwinCandidate(...args),
    completeFinalizedSwmTwinRetirement: (...args: Parameters<DKGAgent['completeFinalizedSwmTwinRetirement']>) => owner.completeFinalizedSwmTwinRetirement(...args),
    retireLegacySwmAfterVerifiedVmTwin: (...args: Parameters<DKGAgent['retireLegacySwmAfterVerifiedVmTwin']>) => owner.retireLegacySwmAfterVerifiedVmTwin(...args),
  };
}
