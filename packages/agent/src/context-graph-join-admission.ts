// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH,
  isBoundedOpenEnrollmentPolicy,
} from '@origintrail-official/dkg-core';
import type { SignedAgentDelegation } from './auth/agent-delegation.js';
import type { ContextGraphJoinAdmissionLockToken } from './context-graph-join-admission-lock.js';
import type { PreparedContextGraphAgentInviteMutation } from './dkg-agent-context-graph.js';
import { JOIN_DELEGATION_VALIDITY_MS } from './dkg-agent-constants.js';
import { normalizeAgentDid } from './dkg-agent-helpers.js';
import type {
  ContextGraphJoinPolicyRateReservation,
  ContextGraphJoinPolicyRecord,
  ContextGraphJoinPolicyStore,
} from './dkg-agent-types.js';

const OPEN_ENROLLMENT_REQUEST_MAX_AGE_MS = 10 * 60 * 1000;
const OPEN_ENROLLMENT_NODE_APPROVALS_PER_HOUR = 100;
const MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH = 1_000;
const RETRYABLE_JOIN_ADMISSION_ERROR_NAME = 'RetryableJoinAdmissionError';

type JoinAdmissionPendingEventType =
  | 'join_auto_decision'
  | 'join_admission_throttled'
  | 'join_admission_failed';

export interface IncomingJoinRequestDecision {
  status: 'pending' | 'approved';
  autoApproved: boolean;
  alreadyMember?: boolean;
  reason?: string;
}

export interface IncomingJoinRequestInput {
  contextGraphId: string;
  delegation: SignedAgentDelegation;
  agentName: string | undefined;
  carrierPeerId: string;
  ingressReserved?: boolean;
}

interface VerifiedIncomingJoinRequest extends IncomingJoinRequestInput {
  requestDigest: string;
  admissionLockToken: ContextGraphJoinAdmissionLockToken;
  repairPolicyEpoch: number | undefined;
}

interface DurableAutomaticApprovalRepair {
  policyEpoch: number;
  actor: string;
  agentAddress: string;
}

interface OpenEnrollmentAdmissionTarget {
  ownerDid: string;
  ownerAgentAddress: string;
  memberCount: number;
}

type SnapshotDecision<T> =
  | { kind: 'eligible'; value: T }
  | { kind: 'pending'; reason: string; eventType?: JoinAdmissionPendingEventType };

export interface ContextGraphJoinAdmissionHost {
  policyStore: ContextGraphJoinPolicyStore | undefined;
  verifyJoinRequest(contextGraphId: string, delegation: SignedAgentDelegation): void;
  getRetryableAdmission(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
  ): { policyEpoch: number | undefined } | null;
  markRetryableAdmission(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    policyEpoch?: number,
  ): void;
  clearRetryableAdmission(contextGraphId: string, delegation: SignedAgentDelegation): void;
  reserveIngress(contextGraphId: string, carrierPeerId: string): () => void;
  chargeVerifiedIngress(contextGraphId: string, agentAddress: string): void;
  withAdmissionLock<T>(
    contextGraphId: string,
    operation: (token: ContextGraphJoinAdmissionLockToken) => Promise<T>,
  ): Promise<T>;
  isPolicyDisableRequested(contextGraphId: string): boolean;
  getContextGraphMeta(contextGraphId: string): Promise<{ revokedAgents: string[] }>;
  getActiveMembers(contextGraphId: string): Promise<string[] | null>;
  getContextGraphOwner(contextGraphId: string): Promise<string | null>;
  resolveLocalOwnerAddress(ownerDid: string): string | null;
  assertAlreadyMemberDelegationRefresh(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    carrierPeerId: string,
  ): Promise<void>;
  prepareMemberRefresh(input: {
    admissionLockToken: ContextGraphJoinAdmissionLockToken;
    contextGraphId: string;
    delegation: SignedAgentDelegation;
    ownerAgentAddress: string | undefined;
  }): Promise<PreparedContextGraphAgentInviteMutation>;
  commitPreparedMemberRefresh(input: {
    admissionLockToken: ContextGraphJoinAdmissionLockToken;
    contextGraphId: string;
    prepared: PreparedContextGraphAgentInviteMutation;
  }): Promise<void>;
  getJoinRequestStatus(contextGraphId: string, agentAddress: string): Promise<string | null>;
  hasJoinRequestRecord(contextGraphId: string, agentAddress: string): Promise<boolean>;
  markJoinRequestApproved(contextGraphId: string, agentAddress: string): Promise<void>;
  flushJoinApprovalDurably(): Promise<void>;
  notifyJoinApproval(contextGraphId: string, agentAddress: string): void;
  countPendingJoinRequests(contextGraphId: string): Promise<number>;
  storePendingJoinRequest(
    contextGraphId: string,
    delegation: SignedAgentDelegation,
    agentName: string | undefined,
  ): Promise<void>;
  emitPendingJoinRequest(input: {
    contextGraphId: string;
    agentAddress: string;
    agentName: string | undefined;
  }): void;
  assertJoinPolicyTarget(
    contextGraphId: string,
    ownerAgentAddress: string,
    requireLocalOwner: boolean,
  ): Promise<OpenEnrollmentAdmissionTarget>;
  assertActiveEncryptionKey(agentAddress: string): Promise<void>;
  prepareJoinRequestApproval(input: {
    admissionLockToken: ContextGraphJoinAdmissionLockToken;
    contextGraphId: string;
    agentAddress: string;
    ownerAgentAddress: string;
  }): Promise<PreparedContextGraphAgentInviteMutation>;
  commitPreparedJoinRequestApproval(input: {
    admissionLockToken: ContextGraphJoinAdmissionLockToken;
    contextGraphId: string;
    agentAddress: string;
    prepared: PreparedContextGraphAgentInviteMutation;
  }): Promise<void>;
}

export function contextGraphJoinRequestDigest(delegation: SignedAgentDelegation): string {
  return createHash('sha256')
    .update(JSON.stringify({
      agentAddress: delegation.agentAddress.toLowerCase(),
      scope: delegation.scope,
      issuedAtMs: delegation.issuedAtMs,
      expiresAtMs: delegation.expiresAtMs ?? 0,
      delegateePeerId: delegation.delegateePeerId ?? '',
      delegateeOpKey: delegation.delegateeOpKey?.toLowerCase() ?? '',
      signature: delegation.signature,
    }))
    .digest('hex');
}

function retryableJoinAdmissionError(error: unknown): Error {
  const cause = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(
    `Automatic join admission crossed its membership mutation boundary but did not finish: ${cause.message}`,
  );
  wrapped.name = RETRYABLE_JOIN_ADMISSION_ERROR_NAME;
  return wrapped;
}

function evaluateDelegationSnapshot(input: {
  delegation: SignedAgentDelegation;
  carrierPeerId: string;
  now: number;
}): SnapshotDecision<true> {
  const { delegation, carrierPeerId, now } = input;
  if (!delegation.delegateePeerId || delegation.delegateePeerId !== carrierPeerId) {
    return { kind: 'pending', reason: 'carrier-peer-mismatch' };
  }
  if (delegation.issuedAtMs < now - OPEN_ENROLLMENT_REQUEST_MAX_AGE_MS) {
    return { kind: 'pending', reason: 'request-too-old' };
  }
  if (
    !delegation.expiresAtMs
    || delegation.expiresAtMs <= now
    || delegation.expiresAtMs <= delegation.issuedAtMs
    || delegation.expiresAtMs - delegation.issuedAtMs > JOIN_DELEGATION_VALIDITY_MS
  ) {
    return { kind: 'pending', reason: 'invalid-automatic-delegation-window' };
  }
  return { kind: 'eligible', value: true };
}

function evaluateCapacitySnapshot(input: {
  policy: ContextGraphJoinPolicyRecord;
  memberCount: number;
}): SnapshotDecision<{ maxMembers: number; maxApprovalsPerHour: number }> {
  const maxMembers = input.policy.maxMembers ?? 0;
  if (!Number.isInteger(maxMembers) || maxMembers <= 0 || input.memberCount >= maxMembers) {
    return {
      kind: 'pending',
      reason: 'member-cap-reached',
      eventType: 'join_admission_throttled',
    };
  }
  const maxApprovalsPerHour = input.policy.maxApprovalsPerHour ?? 0;
  if (!Number.isInteger(maxApprovalsPerHour) || maxApprovalsPerHour <= 0) {
    return { kind: 'pending', reason: 'invalid-approval-rate-cap' };
  }
  return { kind: 'eligible', value: { maxMembers, maxApprovalsPerHour } };
}

/**
 * Owns the incoming join admission pipeline. The host exposes mutation
 * boundaries explicitly; policy evaluation and orchestration stay out of the
 * general-purpose JoinRequestMethods mixin.
 */
export class ContextGraphJoinAdmission {
  constructor(private readonly host: ContextGraphJoinAdmissionHost) {}

  async process(input: IncomingJoinRequestInput): Promise<IncomingJoinRequestDecision> {
    this.assertAgentName(input.agentName);
    const requestDigest = contextGraphJoinRequestDigest(input.delegation);
    const durableRepair = await this.host.policyStore
      ?.getAutomaticApprovalRepair(input.contextGraphId, requestDigest)
      .catch(() => null) ?? null;
    const retryableAdmission = this.host.getRetryableAdmission(
      input.contextGraphId,
      input.delegation,
    );
    const releaseIngress = input.ingressReserved || retryableAdmission || durableRepair
      ? () => {}
      : this.host.reserveIngress(input.contextGraphId, input.carrierPeerId);

    try {
      if (durableRepair) {
        const repaired = await this.host.withAdmissionLock(
          input.contextGraphId,
          () => this.repairDurableAutomaticApproval({
            ...input,
            requestDigest,
            durableRepair,
          }),
        );
        if (repaired) return repaired;
      }
      this.host.verifyJoinRequest(input.contextGraphId, input.delegation);
      if (!retryableAdmission && !durableRepair) {
        this.host.chargeVerifiedIngress(input.contextGraphId, input.delegation.agentAddress);
      }
      return await this.host.withAdmissionLock(input.contextGraphId, async (admissionLockToken) =>
        this.processVerifiedUnderLock({
          ...input,
          requestDigest,
          admissionLockToken,
          repairPolicyEpoch: retryableAdmission?.policyEpoch,
        }));
    } finally {
      releaseIngress();
    }
  }

  /**
   * Finish a mutation that already crossed the durable membership boundary.
   * The exact request digest was signature-verified when its reservation was
   * created, so expiry must not prevent this idempotent bookkeeping repair.
   */
  private async repairDurableAutomaticApproval(input: IncomingJoinRequestInput & {
    requestDigest: string;
    durableRepair: DurableAutomaticApprovalRepair;
  }): Promise<IncomingJoinRequestDecision | null> {
    const {
      contextGraphId,
      delegation,
      carrierPeerId,
      requestDigest,
      durableRepair,
    } = input;
    if (
      durableRepair.agentAddress.toLowerCase() !== delegation.agentAddress.toLowerCase()
      || !delegation.delegateePeerId
      || delegation.delegateePeerId !== carrierPeerId
    ) {
      return null;
    }
    const meta = await this.host.getContextGraphMeta(contextGraphId);
    if (meta.revokedAgents.some(
      (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
    )) {
      return null;
    }
    const activeMembers = await this.host.getActiveMembers(contextGraphId) ?? [];
    if (!activeMembers.some(
      (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
    )) {
      return null;
    }

    try {
      const hasJoinRequest = await this.host.hasJoinRequestRecord(
        contextGraphId,
        delegation.agentAddress,
      );
      if (
        hasJoinRequest
        && await this.host.getJoinRequestStatus(contextGraphId, delegation.agentAddress)
          !== 'approved'
      ) {
        await this.host.markJoinRequestApproved(contextGraphId, delegation.agentAddress);
      }
      await this.host.flushJoinApprovalDurably();
      const committed = await this.host.policyStore?.commitAutomaticApproval({
        timestamp: Date.now(),
        contextGraphId,
        actor: durableRepair.actor,
        agentAddress: durableRepair.agentAddress,
        requestDigest,
        policyEpoch: durableRepair.policyEpoch,
        details: { recoveredFromDurableRepair: true },
      });
      if (!committed) {
        throw new Error('Automatic approval repair reservation is missing.');
      }
      this.host.notifyJoinApproval(contextGraphId, delegation.agentAddress);
      this.host.clearRetryableAdmission(contextGraphId, delegation);
      return {
        status: 'approved',
        autoApproved: true,
        alreadyMember: true,
      };
    } catch (error) {
      this.host.markRetryableAdmission(
        contextGraphId,
        delegation,
        durableRepair.policyEpoch,
      );
      throw retryableJoinAdmissionError(error);
    }
  }

  private assertAgentName(agentName: string | undefined): void {
    if (
      agentName !== undefined
      && (typeof agentName !== 'string' || agentName.length > OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH)
    ) {
      throw new Error(
        `Join-request agentName must be a string of at most ${OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH} characters.`,
      );
    }
  }

  private async processVerifiedUnderLock(
    request: VerifiedIncomingJoinRequest,
  ): Promise<IncomingJoinRequestDecision> {
    const repaired = await this.repairExistingMemberUnderLock(request);
    if (repaired) return repaired;

    await this.persistPendingUnderLock(request);
    return this.evaluatePolicyUnderLock(request);
  }

  private async repairExistingMemberUnderLock(
    request: VerifiedIncomingJoinRequest,
  ): Promise<IncomingJoinRequestDecision | null> {
    const {
      contextGraphId,
      delegation,
      carrierPeerId,
      requestDigest,
      admissionLockToken,
      repairPolicyEpoch,
    } = request;
    const initialMeta = await this.host.getContextGraphMeta(contextGraphId);
    const revokedNow = initialMeta.revokedAgents.some(
      (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
    );
    const activeMembersNow = await this.host.getActiveMembers(contextGraphId) ?? [];
    const isActiveMember = activeMembersNow.some(
      (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
    );
    if (revokedNow || !isActiveMember) return null;

    const ownerDid = await this.host.getContextGraphOwner(contextGraphId);
    const ownerAgentAddress = ownerDid
      ? this.host.resolveLocalOwnerAddress(ownerDid)
      : null;
    await this.host.assertAlreadyMemberDelegationRefresh(
      contextGraphId,
      delegation,
      carrierPeerId,
    );
    let refreshMutationStarted = false;
    try {
      const prepared = await this.host.prepareMemberRefresh({
        admissionLockToken,
        contextGraphId,
        delegation,
        ownerAgentAddress: ownerAgentAddress ?? undefined,
      });
      refreshMutationStarted = true;
      await this.host.commitPreparedMemberRefresh({
        admissionLockToken,
        contextGraphId,
        prepared,
      });
      const moderationStatus = await this.host.getJoinRequestStatus(
        contextGraphId,
        delegation.agentAddress,
      );
      const hasJoinRequest = await this.host.hasJoinRequestRecord(
        contextGraphId,
        delegation.agentAddress,
      );
      if (moderationStatus !== 'approved' && hasJoinRequest) {
        await this.host.markJoinRequestApproved(contextGraphId, delegation.agentAddress);
      }
      await this.host.flushJoinApprovalDurably();
      const recoveredAutomaticApproval = hasJoinRequest
        && this.host.policyStore
        && repairPolicyEpoch !== undefined
        ? await this.host.policyStore.commitAutomaticApproval({
            timestamp: Date.now(),
            contextGraphId,
            actor: ownerDid ?? 'unknown-owner',
            agentAddress: delegation.agentAddress,
            requestDigest,
            policyEpoch: repairPolicyEpoch,
            details: { recoveredFromMemberRetry: true },
          })
        : false;
      this.host.notifyJoinApproval(contextGraphId, delegation.agentAddress);
      this.host.clearRetryableAdmission(contextGraphId, delegation);
      return {
        status: 'approved',
        autoApproved: recoveredAutomaticApproval,
        alreadyMember: true,
      };
    } catch (error) {
      if (refreshMutationStarted) {
        this.host.markRetryableAdmission(contextGraphId, delegation, repairPolicyEpoch);
        throw retryableJoinAdmissionError(error);
      }
      throw error;
    }
  }

  private async persistPendingUnderLock(request: VerifiedIncomingJoinRequest): Promise<void> {
    const { contextGraphId, delegation, agentName } = request;
    const existingRequestStatus = await this.host.getJoinRequestStatus(
      contextGraphId,
      delegation.agentAddress,
    );
    if (
      existingRequestStatus !== 'pending'
      && await this.host.countPendingJoinRequests(contextGraphId)
        >= MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH
    ) {
      throw new Error(
        `Join-request queue for "${contextGraphId}" is full (${MAX_PENDING_JOIN_REQUESTS_PER_CONTEXT_GRAPH}); try again after curator review.`,
      );
    }
    await this.host.storePendingJoinRequest(contextGraphId, delegation, agentName);
  }

  private async leavePending(
    request: VerifiedIncomingJoinRequest,
    automaticEvaluationStarted: boolean,
    reason: string,
    eventType: JoinAdmissionPendingEventType = 'join_auto_decision',
  ): Promise<IncomingJoinRequestDecision> {
    const { contextGraphId, delegation, agentName, requestDigest } = request;
    if (this.host.policyStore && automaticEvaluationStarted) {
      await this.host.policyStore.appendAudit({
        timestamp: Date.now(),
        contextGraphId,
        eventType,
        agentAddress: delegation.agentAddress,
        outcome: 'pending',
        reason,
        requestDigest,
      }).catch(() => {});
    }
    this.host.emitPendingJoinRequest({
      contextGraphId,
      agentAddress: delegation.agentAddress,
      agentName,
    });
    return { status: 'pending', autoApproved: false, reason };
  }

  private async evaluatePolicyUnderLock(
    request: VerifiedIncomingJoinRequest,
  ): Promise<IncomingJoinRequestDecision> {
    const { contextGraphId, delegation, carrierPeerId, requestDigest } = request;
    const { policyStore } = this.host;
    let automaticEvaluationStarted = false;
    const leavePending = (
      reason: string,
      eventType: JoinAdmissionPendingEventType = 'join_auto_decision',
    ) => this.leavePending(request, automaticEvaluationStarted, reason, eventType);

    if (!policyStore) return leavePending('join-policy-store-unavailable');
    if (this.host.isPolicyDisableRequested(contextGraphId)) {
      return leavePending('manual-policy-requested');
    }
    let policy: ContextGraphJoinPolicyRecord | null;
    try {
      policy = await policyStore.load(contextGraphId);
    } catch {
      return leavePending('join-policy-read-failed');
    }
    if (!policy || policy.mode !== 'open') return leavePending('manual-policy');
    automaticEvaluationStarted = true;
    if (!isBoundedOpenEnrollmentPolicy(policy, contextGraphId)) {
      return leavePending('invalid-open-policy');
    }

    let target: OpenEnrollmentAdmissionTarget;
    try {
      target = await this.host.assertJoinPolicyTarget(
        contextGraphId,
        policy.ownerDid.replace(/^did:dkg:agent:/, ''),
        true,
      );
    } catch (error) {
      return leavePending(
        `policy-target-invalid:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (normalizeAgentDid(policy.ownerDid) !== normalizeAgentDid(target.ownerDid)) {
      return leavePending('policy-owner-changed');
    }

    const now = Date.now();
    const delegationDecision = evaluateDelegationSnapshot({ delegation, carrierPeerId, now });
    if (delegationDecision.kind === 'pending') {
      return leavePending(delegationDecision.reason, delegationDecision.eventType);
    }
    const meta = await this.host.getContextGraphMeta(contextGraphId);
    if (meta.revokedAgents.some(
      (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
    )) {
      return leavePending('agent-revoked');
    }
    try {
      await this.host.assertActiveEncryptionKey(delegation.agentAddress);
    } catch {
      return leavePending('verified-active-encryption-key-required');
    }

    const capacityDecision = evaluateCapacitySnapshot({ policy, memberCount: target.memberCount });
    if (capacityDecision.kind === 'pending') {
      return leavePending(capacityDecision.reason, capacityDecision.eventType);
    }
    const { maxMembers, maxApprovalsPerHour } = capacityDecision.value;

    let reservation: ContextGraphJoinPolicyRateReservation;
    try {
      reservation = await policyStore.reserveAutomaticApproval({
        contextGraphId,
        timestamp: now,
        contextGraphLimit: maxApprovalsPerHour,
        nodeLimit: OPEN_ENROLLMENT_NODE_APPROVALS_PER_HOUR,
        actor: target.ownerDid,
        agentAddress: delegation.agentAddress,
        requestDigest,
        policyVersion: policy.version,
        policyEpoch: policy.updatedAt,
      });
    } catch {
      return leavePending('approval-rate-store-failed', 'join_admission_failed');
    }
    if (!reservation.allowed) {
      return leavePending(
        reservation.reason ?? 'approval-rate-cap-reached',
        'join_admission_throttled',
      );
    }

    return this.commitReservedApprovalUnderLock(
      request,
      policyStore,
      policy,
      target,
      maxMembers,
      reservation,
      leavePending,
    );
  }

  private async commitReservedApprovalUnderLock(
    request: VerifiedIncomingJoinRequest,
    policyStore: ContextGraphJoinPolicyStore,
    policy: ContextGraphJoinPolicyRecord,
    target: OpenEnrollmentAdmissionTarget,
    maxMembers: number,
    reservation: ContextGraphJoinPolicyRateReservation,
    leavePending: (
      reason: string,
      eventType?: JoinAdmissionPendingEventType,
    ) => Promise<IncomingJoinRequestDecision>,
  ): Promise<IncomingJoinRequestDecision> {
    const { contextGraphId, delegation, requestDigest, admissionLockToken } = request;
    let membershipMutationStarted = false;
    try {
      if (this.host.isPolicyDisableRequested(contextGraphId)) {
        return leavePending('policy-disabled-before-commit');
      }
      const currentPolicy = await policyStore.load(contextGraphId);
      if (
        !currentPolicy
        || !isBoundedOpenEnrollmentPolicy(currentPolicy, contextGraphId)
        || normalizeAgentDid(currentPolicy.ownerDid) !== normalizeAgentDid(target.ownerDid)
        || currentPolicy.updatedAt !== policy.updatedAt
      ) {
        return leavePending('policy-disabled-before-commit');
      }
      let finalTarget: OpenEnrollmentAdmissionTarget;
      try {
        finalTarget = await this.host.assertJoinPolicyTarget(
          contextGraphId,
          target.ownerAgentAddress,
          true,
        );
      } catch (error) {
        return leavePending(
          `policy-target-invalid-before-commit:${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (normalizeAgentDid(finalTarget.ownerDid) !== normalizeAgentDid(target.ownerDid)) {
        return leavePending('policy-owner-changed-before-commit');
      }
      const finalMeta = await this.host.getContextGraphMeta(contextGraphId);
      if (finalMeta.revokedAgents.some(
        (address) => address.toLowerCase() === delegation.agentAddress.toLowerCase(),
      )) {
        return leavePending('agent-revoked-before-commit');
      }
      const finalMembers = new Set(
        (await this.host.getActiveMembers(contextGraphId) ?? [])
          .map((address) => address.toLowerCase()),
      );
      if (!finalMembers.has(delegation.agentAddress.toLowerCase()) && finalMembers.size >= maxMembers) {
        return leavePending('member-cap-reached-before-commit', 'join_admission_throttled');
      }
      try {
        await this.host.assertActiveEncryptionKey(delegation.agentAddress);
      } catch {
        return leavePending('encryption-key-invalid-before-commit');
      }
      const prepared = await this.host.prepareJoinRequestApproval({
        admissionLockToken,
        contextGraphId,
        agentAddress: delegation.agentAddress,
        ownerAgentAddress: target.ownerAgentAddress,
      });
      if (this.host.isPolicyDisableRequested(contextGraphId)) {
        throw new Error('Open enrollment was switched to manual before the membership mutation.');
      }
      const repairPendingRecorded = await policyStore.markAutomaticApprovalRepairPending({
        contextGraphId,
        requestDigest,
        policyEpoch: policy.updatedAt,
      });
      if (!repairPendingRecorded) {
        throw new Error('Automatic approval reservation is missing before membership mutation.');
      }
      membershipMutationStarted = true;
      await this.host.commitPreparedJoinRequestApproval({
        admissionLockToken,
        contextGraphId,
        agentAddress: delegation.agentAddress,
        prepared,
      });
      const committedAuditRecorded = await policyStore.commitAutomaticApproval({
        timestamp: Date.now(),
        contextGraphId,
        actor: target.ownerDid,
        agentAddress: delegation.agentAddress,
        requestDigest,
        policyEpoch: policy.updatedAt,
        details: {
          memberCountBefore: finalMembers.size,
          maxMembers,
          contextGraphApprovalsLastHour: reservation.contextGraphApprovalsLastHour,
          nodeApprovalsLastHour: reservation.nodeApprovalsLastHour,
        },
      });
      if (!committedAuditRecorded) {
        throw new Error('Automatic approval reservation is missing from the durable audit store.');
      }
      this.host.notifyJoinApproval(contextGraphId, delegation.agentAddress);
      this.host.clearRetryableAdmission(contextGraphId, delegation);
      return { status: 'approved', autoApproved: true };
    } catch (error) {
      if (membershipMutationStarted) {
        this.host.markRetryableAdmission(contextGraphId, delegation, policy.updatedAt);
        throw retryableJoinAdmissionError(error);
      }
      return leavePending(
        `automatic-approval-failed:${error instanceof Error ? error.message : String(error)}`,
        'join_admission_failed',
      );
    }
  }
}
