// SPDX-License-Identifier: Apache-2.0

import { DKGEvent } from '@origintrail-official/dkg-core';
import type { DKGAgent } from './dkg-agent.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import { resolveChainFinalityConfirmationsV1 } from './chain-finality-confirmations-v1.js';
import {
  contextGraphReadAuthorityDependencyOf,
  unavailableContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityDecision,
} from './context-graph-read-authority.js';
import {
  attemptRegisteredPrivateEmptyVmV1,
  RETRYABLE_PRIVATE_EMPTY_VM,
  tracePrivateEmptyVm,
  UNPROVEN_PRIVATE_EMPTY_VM,
  type RegisteredPrivateEmptyVmAttemptV1,
} from './registered-private-empty-vm-attempt-v1.js';

/** The same-turn commit cannot return work that persists after its final fence. */
export type SynchronousReadinessCommitResult<T> = T extends PromiseLike<unknown> ? never : T;

export type ContextGraphReadinessMetadataV1 =
  | { readonly kind: 'unchecked' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'confirmed'; readonly accessPolicy: 'public' | 'private' };

export type InspectedContextGraphReadinessV1 =
  | {
      readonly kind: 'current';
      readonly metadata: ContextGraphReadinessMetadataV1;
      readonly authority: ContextGraphReadAuthorityDecision;
    }
  | {
      readonly kind: 'invalidated';
      readonly authority: ContextGraphReadAuthorityDecision;
    };

export type ProvenRegisteredPrivateEmptyVmInspectionV1 = {
  readonly kind: 'current';
  readonly metadata: { readonly kind: 'confirmed'; readonly accessPolicy: 'private' };
  readonly authority: ContextGraphReadAuthorityDecision & {
    readonly outcome: 'allowed';
    readonly source: 'registered-chain';
    readonly onChainId: bigint;
    readonly registration?: never;
  };
};

export type InspectedPrivateEmptyVmReadinessV1 =
  | { readonly proven: false; readonly retryable?: boolean; readonly inspection: InspectedContextGraphReadinessV1 }
  | { readonly proven: true; readonly inspection: ProvenRegisteredPrivateEmptyVmInspectionV1 };

export interface PreparedPrivateEmptyVmReadinessV1 {
  /** Consume the prepared evidence under the caller's readiness mutation lock. */
  inspectAndCommit<T>(
    input: { readonly inspectMetadata: boolean },
    commit: (completion: InspectedPrivateEmptyVmReadinessV1) => SynchronousReadinessCommitResult<T>,
  ): Promise<T>;
}

/** One canonical policy owner for deciding whether the zero-VM exception applies. */
export function isRegisteredPrivateEmptyVmReadinessCandidateV1(
  authority: ContextGraphReadAuthorityDecision,
  callerAgentAddress: string | undefined,
): callerAgentAddress is string {
  return authority.outcome === 'allowed'
    && authority.source === 'registered-chain'
    && authority.reason === 'chain-participant'
    && authority.registration !== 'unregistered'
    && callerAgentAddress !== undefined;
}

function hasValidatedPrivateEmptyVmInspection(
  inspection: Extract<InspectedContextGraphReadinessV1, { kind: 'current' }>,
  onChainId: bigint,
): inspection is ProvenRegisteredPrivateEmptyVmInspectionV1 {
  const { metadata, authority } = inspection;
  return metadata.kind === 'confirmed' && metadata.accessPolicy === 'private'
    && authority.outcome === 'allowed' && authority.source === 'registered-chain'
    && authority.registration !== 'unregistered' && authority.onChainId === onChainId;
}

function finalizePrivateEmptyVmEvidence(
  attempt: RegisteredPrivateEmptyVmAttemptV1,
  inspection: InspectedContextGraphReadinessV1,
  isSubscribed: () => boolean,
  signal?: AbortSignal,
): InspectedPrivateEmptyVmReadinessV1 {
  if (!attempt.proven) {
    // A transient pre-proof observation cannot overrule a later definitive
    // denial or a removed subscription at the final live fence.
    if (signal?.aborted || !isSubscribed() || inspection.authority.outcome === 'denied') {
      return { ...UNPROVEN_PRIVATE_EMPTY_VM, inspection };
    }
    return { ...attempt, inspection };
  }
  if (inspection.kind === 'invalidated') {
    tracePrivateEmptyVm('post-proof-metadata-changed');
    return {
      ...(signal?.aborted || !isSubscribed() ? UNPROVEN_PRIVATE_EMPTY_VM : RETRYABLE_PRIVATE_EMPTY_VM),
      inspection,
    };
  }
  if (inspection.authority.outcome === 'unavailable') {
    tracePrivateEmptyVm('post-proof-authority-unavailable');
    return { ...RETRYABLE_PRIVATE_EMPTY_VM, inspection };
  }
  if (!hasValidatedPrivateEmptyVmInspection(inspection, attempt.onChainId)) {
    tracePrivateEmptyVm('post-proof-authority-changed');
    return { ...UNPROVEN_PRIVATE_EMPTY_VM, inspection };
  }
  tracePrivateEmptyVm('proven');
  return { proven: true, inspection };
}

export class RegisteredPrivateEmptyVmMethods extends DKGAgentBase {
  /**
   * The curator metadata of a graph this node's agent was approved to join has
   * just become authoritative here. A readiness proof that needs it cannot
   * succeed earlier, and on a slow path it arrives after the subscribe call and
   * its catch-up job have made their attempts. Tell the readiness owner, unless
   * the graph is already ready or no longer subscribed.
   */
  announceJoinMetadataConfirmedV1(this: DKGAgent, contextGraphId: string): void {
    const agentAddress = this.localApprovedAgentByCG.get(contextGraphId);
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    if (agentAddress === undefined || subscription?.subscribed !== true || subscription.synced === true) return;
    this.eventBus.emit(DKGEvent.JOIN_METADATA_CONFIRMED, { contextGraphId, agentAddress });
  }

  /** Inspect and commit graph readiness under one agent-owned, same-turn fence. */
  async inspectAndCommitContextGraphReadinessV1<T>(
    this: DKGAgent,
    input: {
      contextGraphId: string;
      inspectMetadata: boolean;
      expectedRevision?: string;
      callerAgentAddress?: string;
      signal?: AbortSignal;
    },
    commit: (inspection: InspectedContextGraphReadinessV1) => SynchronousReadinessCommitResult<T>,
  ): Promise<T> {
    const { contextGraphId, signal } = input;
    const readRevision = () => {
      try {
        return this.contextGraphMetaProjection.readContextGraphAuthorityFactsRevision(contextGraphId);
      } catch {
        return undefined;
      }
    };
    const revision = input.expectedRevision ?? readRevision();
    let metadata: ContextGraphReadinessMetadataV1 = { kind: 'unchecked' };
    if (input.inspectMetadata) {
      const hasConfirmedMeta = await this.hasConfirmedMetaState(contextGraphId, { signal })
        .catch(() => undefined);
      if (hasConfirmedMeta === undefined) metadata = { kind: 'unavailable' };
      else if (!hasConfirmedMeta) metadata = { kind: 'absent' };
      else {
        try {
          metadata = {
            kind: 'confirmed',
            accessPolicy: await this.isPrivateContextGraph(contextGraphId) ? 'private' : 'public',
          };
        } catch {
          // Unknown policy proves neither public readiness nor the private
          // zero-VM exception.
          metadata = { kind: 'unavailable' };
        }
      }
    }
    const authority: ContextGraphReadAuthorityDecision =
      await this.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: input.callerAgentAddress,
        allowSubscriptionFallback: false,
        freshness: 'live',
        signal,
      }).catch((error: unknown) => unavailableContextGraphReadAuthorityDecision(
        'legacy-local', 'unexpected-authority-error', contextGraphReadAuthorityDependencyOf(error),
      ));
    // The callback is synchronous. No await can separate this final fence from
    // classification or persistence; a caller cannot turn stale facts into
    // durable readiness while an authority read is in flight.
    const current = signal?.aborted !== true
      && revision !== undefined
      && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true
      && readRevision() === revision;
    return commit(current
      ? { kind: 'current', metadata, authority }
      : { kind: 'invalidated', authority });
  }

  /** Collect optional chain evidence without holding the readiness mutation lock. */
  async prepareContextGraphReadinessWithPrivateEmptyVmV1(
    this: DKGAgent,
    input: {
      contextGraphId: string;
      attemptPrivateEmptyVm: boolean;
      callerAgentAddress?: string;
      signal?: AbortSignal;
    },
  ): Promise<PreparedPrivateEmptyVmReadinessV1> {
    const { contextGraphId, callerAgentAddress, signal } = input;
    const attempt = input.attemptPrivateEmptyVm && callerAgentAddress !== undefined
      ? await attemptRegisteredPrivateEmptyVmV1(this, {
        isSubscribed: () => this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true,
        readMetadataRevision: () => this.contextGraphMetaProjection
          .readContextGraphAuthorityFactsRevision(contextGraphId),
        readChainConfig: () => this.config.chainConfig,
        hasAuthorityReader: () => this.contextGraphAuthorityReaderCapability.status !== 'unsupported',
        readAdapterEvmChainId: () => this.chain.getEvmChainId(),
        readResolvedFinalityConfirmations: () => resolveChainFinalityConfirmationsV1(
          this.chain, this.config.chainConfig,
        ),
      }, contextGraphId, callerAgentAddress, signal)
      : UNPROVEN_PRIVATE_EMPTY_VM;
    let consumed = false;
    return Object.freeze({
      inspectAndCommit: async <T>(
        completionInput: { readonly inspectMetadata: boolean },
        commit: (completion: InspectedPrivateEmptyVmReadinessV1) => SynchronousReadinessCommitResult<T>,
      ): Promise<T> => {
        if (consumed) throw new Error('Private empty-VM readiness preparation already consumed');
        consumed = true;
        // Completion always obtains one last live authority and metadata view.
        // Its synchronous callback classifies and persists both proof outcomes
        // without another lock acquisition or a second final inspection.
        return this.inspectAndCommitContextGraphReadinessV1({
          contextGraphId,
          inspectMetadata: completionInput.inspectMetadata || input.attemptPrivateEmptyVm,
          ...(attempt.proven ? { expectedRevision: attempt.metadataRevision } : {}),
          callerAgentAddress,
          signal,
        }, (inspection) => commit(finalizePrivateEmptyVmEvidence(
          attempt, inspection,
          () => this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true,
          signal,
        )));
      },
    });
  }

}
