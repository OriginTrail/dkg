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
    { label: 'an empty graph', patch: { contextGraphId: '' } },
    { label: 'a non-string graph with a length', patch: { contextGraphId: { length: 1 } } },
    { label: 'an unknown mode', patch: { mode: 'automatic' } },
    { label: 'a zero member cap', patch: { maxMembers: 0 } },
    { label: 'a negative member cap', patch: { maxMembers: -1 } },
    { label: 'a zero approval cap', patch: { maxApprovalsPerHour: 0 } },
    { label: 'a negative approval cap', patch: { maxApprovalsPerHour: -1 } },
    { label: 'a future version', patch: { version: 2 } },
    { label: 'an empty owner', patch: { ownerDid: '' } },
    { label: 'a non-finite update time', patch: { updatedAt: Number.NaN } },
    { label: 'a non-number update time', patch: { updatedAt: '1234' } },
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
    expect(parseContextGraphJoinPolicyRecord(policy)).toBeNull();
  });

  it('accepts a valid record without a context constraint and rejects a different expected graph', () => {
    const policy = { ...base, mode: 'open', maxMembers: 100, maxApprovalsPerHour: 10 };
    expect(parseContextGraphJoinPolicyRecord(policy)).toEqual(policy);
    expect(parseContextGraphJoinPolicyRecord(policy, 'did:dkg:cg:other')).toBeNull();
    expect(isBoundedOpenEnrollmentPolicy(policy, 'did:dkg:cg:other')).toBe(false);
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

  it('rejects array objects even if they carry otherwise valid policy fields', () => {
    const array = Object.assign([], { ...base, mode: 'manual' });
    expect(parseContextGraphJoinPolicyRecord(array)).toBeNull();
    expect(isBoundedOpenEnrollmentPolicy(array)).toBe(false);
  });

  it('rejects null without attempting to read policy fields', () => {
    expect(parseContextGraphJoinPolicyRecord(null)).toBeNull();
    expect(isBoundedOpenEnrollmentPolicy(null)).toBe(false);
  });

  it('rejects functions carrying otherwise valid policy fields', () => {
    const callable = Object.assign(() => undefined, { ...base, mode: 'manual' });
    expect(parseContextGraphJoinPolicyRecord(callable)).toBeNull();
  });
});
