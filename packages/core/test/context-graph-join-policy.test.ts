import { describe, expect, it } from 'vitest';
import {
  CONTEXT_GRAPH_JOIN_POLICY_VERSION,
  OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR,
  OPEN_ENROLLMENT_MAX_MEMBERS,
  isBoundedOpenEnrollmentPolicy,
  parseContextGraphJoinPolicyRecord,
} from '../src/context-graph-join-policy.js';

const base = {
  version: CONTEXT_GRAPH_JOIN_POLICY_VERSION,
  contextGraphId: 'did:dkg:cg:private',
  ownerDid: 'did:dkg:agent:0x1234',
  updatedAt: 1_234,
};

describe('context graph join policy validation', () => {
  it('parses bounded open enrollment at both hard-cap boundaries', () => {
    const policy = {
      ...base,
      mode: 'open',
      maxMembers: OPEN_ENROLLMENT_MAX_MEMBERS,
      maxApprovalsPerHour: OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR,
    };

    expect(parseContextGraphJoinPolicyRecord(policy, base.contextGraphId)).toEqual(policy);
    expect(isBoundedOpenEnrollmentPolicy(policy, base.contextGraphId)).toBe(true);
  });

  it.each([
    { label: 'a future version', patch: { version: 2 } },
    { label: 'the wrong graph', patch: { contextGraphId: 'did:dkg:cg:other' } },
    { label: 'an empty owner', patch: { ownerDid: '' } },
    { label: 'a non-finite update time', patch: { updatedAt: Number.NaN } },
    { label: 'a missing member cap', patch: { maxMembers: undefined } },
    { label: 'an excessive member cap', patch: { maxMembers: OPEN_ENROLLMENT_MAX_MEMBERS + 1 } },
    { label: 'a fractional rate cap', patch: { maxApprovalsPerHour: 1.5 } },
    {
      label: 'an excessive rate cap',
      patch: { maxApprovalsPerHour: OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR + 1 },
    },
  ])('fails closed for $label', ({ patch }) => {
    const policy = {
      ...base,
      mode: 'open',
      maxMembers: 100,
      maxApprovalsPerHour: 10,
      ...patch,
    };

    expect(parseContextGraphJoinPolicyRecord(policy, base.contextGraphId)).toBeNull();
    expect(isBoundedOpenEnrollmentPolicy(policy, base.contextGraphId)).toBe(false);
  });

  it('canonicalizes manual policies without stale open-enrollment caps', () => {
    expect(parseContextGraphJoinPolicyRecord({
      ...base,
      mode: 'manual',
      maxMembers: OPEN_ENROLLMENT_MAX_MEMBERS + 1,
      maxApprovalsPerHour: OPEN_ENROLLMENT_MAX_APPROVALS_PER_HOUR + 1,
    })).toEqual({
      ...base,
      mode: 'manual',
    });
  });
});
