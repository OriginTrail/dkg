// SPDX-License-Identifier: Apache-2.0

import type { DKGAgent } from './dkg-agent.js';
import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import {
  attemptRegisteredPrivateEmptyVmV1,
  RETRYABLE_PRIVATE_EMPTY_VM,
  tracePrivateEmptyVm,
  UNPROVEN_PRIVATE_EMPTY_VM,
  type RegisteredPrivateEmptyVmAttemptV1,
} from './registered-private-empty-vm-attempt-v1.js';

export type RegisteredPrivateEmptyVmReadinessResult<T> =
  | { readonly proven: false; readonly retryable?: boolean }
  | { readonly proven: true; readonly value: T };

export type ContextGraphReadinessAuthorityV1 =
  | ContextGraphReadAuthorityDecision
  | { readonly outcome: 'unavailable' };

export interface InspectedContextGraphReadinessV1 {
  readonly current: boolean;
  readonly hasConfirmedMeta: boolean | undefined;
  readonly isPrivate: boolean;
  readonly authority: ContextGraphReadinessAuthorityV1;
}

function finalizePrivateEmptyVmEvidence(
  attempt: RegisteredPrivateEmptyVmAttemptV1,
  inspection: InspectedContextGraphReadinessV1,
  isSubscribed: () => boolean,
  signal?: AbortSignal,
): { readonly proven: false; readonly retryable?: boolean } | { readonly proven: true } {
  if (!attempt.proven) {
    // A transient pre-proof observation cannot overrule a later definitive
    // denial or a removed subscription at the final live fence.
    if (signal?.aborted || !isSubscribed() || inspection.authority.outcome === 'denied') {
      return UNPROVEN_PRIVATE_EMPTY_VM;
    }
    return attempt;
  }
  const { current, hasConfirmedMeta, isPrivate, authority } = inspection;
  if (!current) {
    tracePrivateEmptyVm('post-proof-metadata-changed');
    return signal?.aborted || !isSubscribed()
      ? UNPROVEN_PRIVATE_EMPTY_VM : RETRYABLE_PRIVATE_EMPTY_VM;
  }
  if (authority.outcome === 'unavailable') {
    tracePrivateEmptyVm('post-proof-authority-unavailable');
    return RETRYABLE_PRIVATE_EMPTY_VM;
  }
  if (!hasConfirmedMeta || !isPrivate
    || authority.outcome !== 'allowed' || authority.source !== 'registered-chain'
    || authority.registration === 'unregistered'
    || authority.onChainId !== attempt.onChainId) {
    tracePrivateEmptyVm('post-proof-authority-changed');
    return UNPROVEN_PRIVATE_EMPTY_VM;
  }
  tracePrivateEmptyVm('proven');
  return { proven: true };
}

export class RegisteredPrivateEmptyVmMethods {
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
    commit: (inspection: InspectedContextGraphReadinessV1) => T,
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
    let hasConfirmedMeta = input.inspectMetadata
      ? await this.hasConfirmedMetaState(contextGraphId, { signal }).catch(() => undefined)
      : undefined;
    let isPrivate = false;
    if (hasConfirmedMeta) {
      try {
        isPrivate = await this.isPrivateContextGraph(contextGraphId);
      } catch {
        // Unknown policy cannot prove either public readiness or the private
        // zero-VM exception. Preserve the private fail-closed posture while
        // withholding the confirmed-metadata fact.
        hasConfirmedMeta = undefined;
        isPrivate = true;
      }
    }
    const authority: ContextGraphReadinessAuthorityV1 =
      await this.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
        callerAgentAddress: input.callerAgentAddress,
        allowSubscriptionFallback: false,
        freshness: 'live',
        signal,
      }).catch(() => ({ outcome: 'unavailable' as const }));
    // The callback is synchronous. No await can separate this final fence from
    // classification or persistence; a caller cannot turn stale facts into
    // durable readiness while an authority read is in flight.
    const current = signal?.aborted !== true
      && revision !== undefined
      && this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true
      && readRevision() === revision;
    return commit(current
      ? { current, hasConfirmedMeta, isPrivate, authority }
      : {
          current, hasConfirmedMeta: undefined, isPrivate: false,
          authority: authority.outcome === 'allowed' ? { outcome: 'unavailable' } : authority,
        });
  }

  /** One final agent-owned inspection for optional chain evidence and peer classification. */
  async inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1<T>(
    this: DKGAgent,
    input: {
      contextGraphId: string;
      inspectMetadata: boolean;
      attemptPrivateEmptyVm: boolean;
      callerAgentAddress?: string;
      signal?: AbortSignal;
    },
    commit: (
      inspection: InspectedContextGraphReadinessV1,
      proof: { readonly proven: false; readonly retryable?: boolean } | { readonly proven: true },
    ) => T,
  ): Promise<T> {
    const { contextGraphId, callerAgentAddress, signal } = input;
    const attempt = input.attemptPrivateEmptyVm && callerAgentAddress !== undefined
      ? await attemptRegisteredPrivateEmptyVmV1(this, {
        isSubscribed: () => this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true,
        readMetadataRevision: () => this.contextGraphMetaProjection
          .readContextGraphAuthorityFactsRevision(contextGraphId),
        readChainConfig: () => this.config.chainConfig,
        hasAuthorityReader: () => this.contextGraphAuthorityReaderCapability.status !== 'unsupported',
        readFinalityConfirmations: () => this.chain.getFinalityConfirmations?.(),
      }, contextGraphId, callerAgentAddress, signal)
      : UNPROVEN_PRIVATE_EMPTY_VM;
    // Completion always obtains one last live authority and metadata view. Its
    // synchronous callback classifies and persists both proof outcomes without
    // another lock acquisition or a second final inspection.
    return this.inspectAndCommitContextGraphReadinessV1({
      contextGraphId,
      inspectMetadata: input.inspectMetadata || input.attemptPrivateEmptyVm,
      ...(attempt.proven ? { expectedRevision: attempt.metadataRevision } : {}),
      callerAgentAddress,
      signal,
    }, (inspection) => commit(
      inspection,
      finalizePrivateEmptyVmEvidence(
        attempt, inspection,
        () => this.subscribedContextGraphs.get(contextGraphId)?.subscribed === true,
        signal,
      ),
    ));
  }

  /** A zero-VM proof grants durable readiness only; SWM still needs its own proof. */
  async proveRegisteredPrivateEmptyVmV1<T>(
    this: DKGAgent,
    contextGraphId: string,
    callerAgentAddress: string,
    commit: (inspection: InspectedContextGraphReadinessV1) => T,
    signal?: AbortSignal,
  ): Promise<RegisteredPrivateEmptyVmReadinessResult<T>> {
    return this.inspectAndCommitContextGraphReadinessWithPrivateEmptyVmV1({
      contextGraphId,
      inspectMetadata: true,
      attemptPrivateEmptyVm: true,
      callerAgentAddress,
      signal,
    }, (inspection, proof) => proof.proven
      ? { proven: true, value: commit(inspection) }
      : proof);
  }
}
