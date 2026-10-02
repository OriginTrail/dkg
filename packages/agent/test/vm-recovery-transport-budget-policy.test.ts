import { describe, expect, it } from 'vitest';
import { VmRecoveryTransportBudgetPolicy } from '../src/vm-recovery-transport-budget-policy.js';

const target = {
  localCgId: '0x0000000000000000000000000000000000000001/public',
  onChainCgId: '1',
  ordinal: 7,
  ual: 'did:dkg:base:84532/0x0000000000000000000000000000000000000001/7',
  merkleRoot: '0xAbCd',
};
const peerId = '12D3KooWLegacy';

function competingProbe(policy: VmRecoveryTransportBudgetPolicy) {
  return policy.timeoutFor({
    target, peerId, providerAttemptKind: 'probe', registeredPublicAccess: true,
    competingStreamAvailable: true, streamEligible: false,
  });
}

describe('VM recovery transport budget policy', () => {
  it('gives every fourth admitted physical attempt the ordinary budget', () => {
    const policy = new VmRecoveryTransportBudgetPolicy();
    const budgets = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      budgets.push(competingProbe(policy));
      policy.recordAdmitted(target, peerId);
    }
    expect(budgets).toEqual([120_000, 120_000, 120_000, undefined, 120_000]);
  });

  it('preserves ordinary budgets outside competing public legacy probes', () => {
    const policy = new VmRecoveryTransportBudgetPolicy();
    const base = {
      target, peerId, providerAttemptKind: 'probe' as const,
      registeredPublicAccess: true, competingStreamAvailable: true, streamEligible: false,
    };
    expect(policy.timeoutFor({ ...base, registeredPublicAccess: false })).toBeUndefined();
    expect(policy.timeoutFor({ ...base, competingStreamAvailable: false })).toBeUndefined();
    expect(policy.timeoutFor({ ...base, streamEligible: true })).toBeUndefined();
    expect(policy.timeoutFor({ ...base, providerAttemptKind: 'proven-holder-reuse' })).toBeUndefined();
    expect(competingProbe(policy)).toBe(120_000);
  });

  it('separates version and peer identity and clears one graph without affecting another', () => {
    const policy = new VmRecoveryTransportBudgetPolicy();
    for (let attempt = 0; attempt < 3; attempt += 1) policy.recordAdmitted(target, peerId);
    expect(competingProbe(policy)).toBeUndefined();
    expect(policy.attemptOrdinal({ ...target, merkleRoot: '0xabcd' }, peerId)).toBe(3);
    expect(policy.attemptOrdinal({ ...target, merkleRoot: '0xnew' }, peerId)).toBe(0);
    expect(policy.attemptOrdinal(target, '12D3KooWOther')).toBe(0);
    const otherGraph = { ...target, localCgId: `${target.localCgId}-other` };
    policy.recordAdmitted(otherGraph, peerId);
    policy.forgetContextGraph(target.localCgId);
    expect(policy.attemptOrdinal(target, peerId)).toBe(0);
    expect(policy.attemptOrdinal(otherGraph, peerId)).toBe(1);
    policy.clear();
    expect(policy.attemptOrdinal(otherGraph, peerId)).toBe(0);
  });

  it('bounds history and keeps the recently retried target', () => {
    const policy = new VmRecoveryTransportBudgetPolicy(2);
    const first = target;
    const second = { ...target, ordinal: 8 };
    const third = { ...target, ordinal: 9 };
    policy.recordAdmitted(first, peerId);
    policy.recordAdmitted(second, peerId);
    policy.recordAdmitted(first, peerId);
    policy.recordAdmitted(third, peerId);
    expect(policy.attemptOrdinal(first, peerId)).toBe(2);
    expect(policy.attemptOrdinal(second, peerId)).toBe(0);
    expect(policy.attemptOrdinal(third, peerId)).toBe(1);
  });
});
