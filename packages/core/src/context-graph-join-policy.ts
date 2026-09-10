// SPDX-License-Identifier: Apache-2.0

/** Persisted schema version for private context-graph admission policies. */
export const CONTEXT_GRAPH_JOIN_POLICY_VERSION = 1 as const;

/** Hard safety ceilings for curator-configured open enrollment. */
export const OPEN_ENROLLMENT_MAX_MEMBERS = 10_000;
export const OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR = 1_000;
export const OPEN_ENROLLMENT_MAX_AGENT_NAME_LENGTH = 128;

export type ContextGraphJoinPolicyMode = 'manual' | 'open';

export interface ContextGraphJoinPolicyRecord {
  version: typeof CONTEXT_GRAPH_JOIN_POLICY_VERSION;
  contextGraphId: string;
  mode: ContextGraphJoinPolicyMode;
  /** Exact curator DID at the time the policy was written. */
  ownerDid: string;
  /** Required for `open`; counts active allowed agents, including the curator. */
  maxMembers?: number;
  /** Required for `open`; rolling per-CG one-hour admission ceiling. */
  maxApprovalsPerHour?: number;
  updatedAt: number;
}

export type BoundedOpenEnrollmentPolicy = ContextGraphJoinPolicyRecord & {
  mode: 'open';
  maxMembers: number;
  maxApprovalsPerHour: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value as number);
}

/**
 * Parse untrusted persisted policy state into its canonical representation.
 *
 * Invalid or future-version records return `null`, allowing every consumer to
 * use the same fail-closed `manual` fallback. Fields that are meaningful only
 * for open enrollment are deliberately stripped from manual records.
 */
export function parseContextGraphJoinPolicyRecord(
  value: unknown,
  expectedContextGraphId?: string,
): ContextGraphJoinPolicyRecord | null {
  if (!isRecord(value)) return null;
  if (value.version !== CONTEXT_GRAPH_JOIN_POLICY_VERSION) return null;
  if (typeof value.contextGraphId !== 'string' || value.contextGraphId.length === 0) return null;
  if (expectedContextGraphId !== undefined && value.contextGraphId !== expectedContextGraphId) return null;
  if (value.mode !== 'manual' && value.mode !== 'open') return null;
  if (typeof value.ownerDid !== 'string' || value.ownerDid.length === 0) return null;
  if (!isFiniteNumber(value.updatedAt)) return null;

  if (value.mode === 'open') {
    if (
      !Number.isInteger(value.maxMembers)
      || (value.maxMembers as number) <= 0
      || (value.maxMembers as number) > OPEN_ENROLLMENT_MAX_MEMBERS
      || !Number.isInteger(value.maxApprovalsPerHour)
      || (value.maxApprovalsPerHour as number) <= 0
      || (value.maxApprovalsPerHour as number) > OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR
    ) {
      return null;
    }
    return {
      version: CONTEXT_GRAPH_JOIN_POLICY_VERSION,
      contextGraphId: value.contextGraphId,
      mode: 'open',
      ownerDid: value.ownerDid,
      maxMembers: value.maxMembers as number,
      maxApprovalsPerHour: value.maxApprovalsPerHour as number,
      updatedAt: value.updatedAt,
    };
  }

  return {
    version: CONTEXT_GRAPH_JOIN_POLICY_VERSION,
    contextGraphId: value.contextGraphId,
    mode: 'manual',
    ownerDid: value.ownerDid,
    updatedAt: value.updatedAt,
  };
}

/** Validate a complete policy record without changing its representation. */
export function isContextGraphJoinPolicyRecord(
  value: unknown,
  expectedContextGraphId?: string,
): boolean {
  return parseContextGraphJoinPolicyRecord(value, expectedContextGraphId) !== null;
}

/** Shared guard for the only policy shape that can authorize auto-admission. */
export function isBoundedOpenEnrollmentPolicy(
  value: unknown,
  expectedContextGraphId?: string,
): value is BoundedOpenEnrollmentPolicy {
  return parseContextGraphJoinPolicyRecord(value, expectedContextGraphId)?.mode === 'open';
}
