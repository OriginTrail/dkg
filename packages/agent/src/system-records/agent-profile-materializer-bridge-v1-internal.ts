// SPDX-License-Identifier: Apache-2.0

import {
  SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS,
  SYSTEM_RECORD_SLICE_TIMEOUT_MS,
} from '@origintrail-official/dkg-core/system-record-v1';
import type {
  SystemRecordApplyOutcomeV1,
  SystemRecordLaneSessionV1,
} from '@origintrail-official/dkg-storage';

import type {
  AgentProfileAdmittedSliceContextV1,
  AgentProfileAdmittedSliceSnapshotV1,
} from './admitted-slice-context-v1.js';
import {
  assertAuthenticAgentProfileReceiverCandidateV1,
  type AgentProfileReceiverAnyCandidateV1,
  type CreateAgentProfileCandidateReceiverOptionsV1,
} from './receiver-v1.js';

export interface AgentProfileMaterializerBridgeDepsV1 {
  /** Captured from the single authentic managed ownership runtime; never caller supplied. */
  readonly runtime: AgentProfileMaterializerProofRuntimeV1;
  /** Exact facade returned by the currently open lifecycle activation. */
  readonly session: SystemRecordLaneSessionV1;
  /** Authenticate the original nonrenewable reconciliation context. */
  readonly inspectAdmittedContext: (
    context: AgentProfileAdmittedSliceContextV1,
  ) => AgentProfileAdmittedSliceSnapshotV1;
  /** Resolve the private session/generation/epoch binding synchronously. */
  readonly resolveBinding: (
    context: AgentProfileAdmittedSliceContextV1,
  ) => AgentProfileMaterializerLaneBindingV1 | null;
}

/** Private structural port implemented by Storage's non-exported proof registry. */
export interface AgentProfileMaterializerProofRuntimeV1 {
  readonly issuer: Readonly<{
    issueCandidate(input: AgentProfileMaterializerCandidateIssueV1): unknown;
  }>;
  readonly consumer: Readonly<{
    discardProof(proof: unknown): void;
  }>;
}

/** Private structural port implemented by the activation-owned lane binding. */
export interface AgentProfileMaterializerLaneBindingV1 {
  readonly networkId: AgentProfileReceiverAnyCandidateV1['head']['networkId'];
  readonly kind: 'agents';
  readonly mode: 'shadow' | 'authoritative';
  readonly sessionIdentity: object;
  readonly activationGeneration: string;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
}

type ActiveCandidateV1 = Extract<
  AgentProfileReceiverAnyCandidateV1,
  { readonly operation: 'active' }
>;
type TombstoneCandidateV1 = Extract<
  AgentProfileReceiverAnyCandidateV1,
  { readonly operation: 'tombstone' }
>;
type QuarantineCandidateV1 = Extract<
  AgentProfileReceiverAnyCandidateV1,
  { readonly operation: 'quarantine' }
>;

interface AgentProfileMaterializerIssueCommonV1 {
  readonly networkId: AgentProfileReceiverAnyCandidateV1['head']['networkId'];
  readonly kind: 'agents';
  readonly mode: 'shadow' | 'authoritative';
  readonly sessionIdentity: object;
  readonly activationGeneration: string;
  readonly childGeneration: string;
  readonly materializationEpoch: string;
  readonly admittedDeadlineMs: number;
}

/** Exact private issue shape consumed structurally by Storage's internal issuer. */
export type AgentProfileMaterializerCandidateIssueV1 =
  | Readonly<AgentProfileMaterializerIssueCommonV1 & {
      readonly operation: 'active';
      readonly head: ActiveCandidateV1['head'];
      readonly verifiedAuthoritySummary: ActiveCandidateV1['verifiedAuthoritySummary'];
      readonly canonicalProjectionBytes: ActiveCandidateV1['canonicalProjectionBytes'];
      readonly projectionQuads: ActiveCandidateV1['projectionQuads'];
      readonly ownedSubjectTable: ActiveCandidateV1['ownedSubjectTable'];
    }>
  | Readonly<AgentProfileMaterializerIssueCommonV1 & {
      readonly operation: 'tombstone';
      readonly head: TombstoneCandidateV1['head'];
      readonly verifiedAuthoritySummary: TombstoneCandidateV1['verifiedAuthoritySummary'];
      readonly deletionOwnedSubjectTable: TombstoneCandidateV1['deletionOwnedSubjectTable'];
    }>
  | Readonly<AgentProfileMaterializerIssueCommonV1 & {
      readonly operation: 'quarantine';
      readonly head: QuarantineCandidateV1['head'];
      readonly verifiedAuthoritySummary: QuarantineCandidateV1['verifiedAuthoritySummary'];
      readonly canonicalProjectionBytes: QuarantineCandidateV1['canonicalProjectionBytes'];
      readonly projectionQuads: QuarantineCandidateV1['projectionQuads'];
      readonly ownedSubjectTable: QuarantineCandidateV1['ownedSubjectTable'];
      readonly conflictEvidenceDigest: QuarantineCandidateV1['conflictEvidenceDigest'];
      readonly canonicalConflictEvidenceBytes:
        QuarantineCandidateV1['canonicalConflictEvidenceBytes'];
      readonly terminalTransitionConflict: QuarantineCandidateV1['terminalTransitionConflict'];
    }>;

/**
 * Default-unused receiver-to-storage preparation. D7 owns production composition;
 * this module only guarantees that proof authority is created at dispatch and
 * immediately transferred to the captured lane session.
 */
export function createAgentProfileMaterializerPrepareBridgeV1(
  deps: AgentProfileMaterializerBridgeDepsV1,
): CreateAgentProfileCandidateReceiverOptionsV1['prepareCandidateApply'] {
  const { runtime, session, inspectAdmittedContext, resolveBinding } = deps;
  return (candidate, admittedContext, signal) => {
    assertAuthenticAgentProfileReceiverCandidateV1(candidate);
    signal.throwIfAborted();
    const preparedContext = snapshotAdmittedContext(
      inspectAdmittedContext(admittedContext),
    );
    const preparedRemainingMs = preparedContext.admittedDeadlineMs - preparedContext.nowMs;
    if (preparedRemainingMs > SYSTEM_RECORD_SLICE_TIMEOUT_MS) {
      throw new Error('agent-profile admitted deadline exceeds its physical slice bound');
    }
    const preparedBinding = matchingBinding(
      resolveBinding(admittedContext),
      candidate,
      session,
    );
    let invoked = false;
    return Object.freeze({
      existingMonotonicDeadlineMs: preparedContext.admittedDeadlineMs,
      monotonicNowMs: preparedContext.nowMs,
      apply(admittedDeadlineMs: number) {
        if (invoked) throw new Error('agent-profile materializer bridge was already invoked');
        invoked = true;
        const currentContext = snapshotAdmittedContext(
          inspectAdmittedContext(admittedContext),
        );
        if (currentContext.admittedDeadlineMs !== preparedContext.admittedDeadlineMs) {
          throw new Error('agent-profile admitted deadline changed before proof issuance');
        }
        if (!Number.isSafeInteger(admittedDeadlineMs)
            || admittedDeadlineMs < 0
            || admittedDeadlineMs > preparedContext.admittedDeadlineMs) {
          throw new Error('agent-profile receiver selected an invalid apply deadline');
        }
        if (admittedDeadlineMs - currentContext.nowMs
            < SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS) {
          return deferred('insufficient-apply-budget');
        }
        if (preparedBinding === null) return deferred('generation-changed');
        const currentBinding = matchingBinding(
          resolveBinding(admittedContext),
          candidate,
          session,
        );
        if (currentBinding === null
            || !sameBinding(currentBinding, preparedBinding)) {
          return deferred('generation-changed');
        }
        if (session.state === 'shutdown'
            || session.state === 'unavailable'
            || session.state === 'detached') {
          return Object.freeze({ outcome: 'capability-lost' as const });
        }
        if (session.state !== 'enabled') return deferred('generation-changed');
        signal.throwIfAborted();
        const proof = runtime.issuer.issueCandidate(candidateIssue(
          candidate,
          currentBinding,
          admittedDeadlineMs,
        ));
        try {
          // Invocation transfers ownership. Do not await or recheck cancellation
          // between issue and this call, and never return the proof to the receiver.
          return session.applyVerified(proof);
        } catch (error) {
          runtime.consumer.discardProof(proof);
          throw error;
        }
      },
    });
  };
}

function matchingBinding(
  binding: AgentProfileMaterializerLaneBindingV1 | null,
  candidate: AgentProfileReceiverAnyCandidateV1,
  session: SystemRecordLaneSessionV1,
): AgentProfileMaterializerLaneBindingV1 | null {
  return binding !== null
    && binding.networkId === candidate.head.networkId
    && binding.kind === 'agents'
    && binding.activationGeneration === session.activationGeneration
    ? binding
    : null;
}

function sameBinding(
  current: AgentProfileMaterializerLaneBindingV1,
  prepared: AgentProfileMaterializerLaneBindingV1,
): boolean {
  return current.networkId === prepared.networkId
    && current.kind === prepared.kind
    && current.mode === prepared.mode
    && current.sessionIdentity === prepared.sessionIdentity
    && current.activationGeneration === prepared.activationGeneration
    && current.childGeneration === prepared.childGeneration
    && current.materializationEpoch === prepared.materializationEpoch;
}

function deferred(
  reason: Extract<SystemRecordApplyOutcomeV1, { outcome: 'deferred' }>['reason'],
): SystemRecordApplyOutcomeV1 {
  return Object.freeze({ outcome: 'deferred', reason });
}

function candidateIssue(
  candidate: AgentProfileReceiverAnyCandidateV1,
  binding: AgentProfileMaterializerLaneBindingV1,
  admittedDeadlineMs: number,
): AgentProfileMaterializerCandidateIssueV1 {
  const common = Object.freeze({
    networkId: candidate.head.networkId,
    kind: binding.kind,
    mode: binding.mode,
    sessionIdentity: binding.sessionIdentity,
    activationGeneration: binding.activationGeneration,
    childGeneration: binding.childGeneration,
    materializationEpoch: binding.materializationEpoch,
    admittedDeadlineMs,
  });
  if (candidate.operation === 'tombstone') {
    return Object.freeze({
      operation: 'tombstone',
      ...common,
      head: candidate.head,
      verifiedAuthoritySummary: candidate.verifiedAuthoritySummary,
      deletionOwnedSubjectTable: candidate.deletionOwnedSubjectTable,
    });
  }
  const active = {
    ...common,
    head: candidate.head,
    verifiedAuthoritySummary: candidate.verifiedAuthoritySummary,
    canonicalProjectionBytes: candidate.canonicalProjectionBytes,
    projectionQuads: candidate.projectionQuads,
    ownedSubjectTable: candidate.ownedSubjectTable,
  } as const;
  if (candidate.operation === 'active') {
    return Object.freeze({ operation: 'active', ...active });
  }
  return Object.freeze({
    operation: 'quarantine',
    ...active,
    conflictEvidenceDigest: candidate.conflictEvidenceDigest,
    canonicalConflictEvidenceBytes: candidate.canonicalConflictEvidenceBytes,
    terminalTransitionConflict: candidate.terminalTransitionConflict,
  });
}

function snapshotAdmittedContext(
  value: AgentProfileAdmittedSliceSnapshotV1,
): AgentProfileAdmittedSliceSnapshotV1 {
  if (value === null || typeof value !== 'object'
      || !Number.isSafeInteger(value.nowMs) || value.nowMs < 0
      || !Number.isSafeInteger(value.admittedDeadlineMs) || value.admittedDeadlineMs < 0) {
    throw new Error('agent-profile admission returned an invalid context snapshot');
  }
  return Object.freeze({
    nowMs: value.nowMs,
    admittedDeadlineMs: value.admittedDeadlineMs,
  });
}
