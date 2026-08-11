/** Focused acceptance lane for exact-VM provider affinity and settlement. */
import { describe, expect, it } from 'vitest';
import {
  VmRecoveryProviderPolicy,
  type VmRecoveryUalDisposition,
} from '../src/vm-recovery-provider-policy.js';

function dispositions(
  ...entries: Array<readonly [string, VmRecoveryUalDisposition]>
): ReadonlyMap<string, VmRecoveryUalDisposition> {
  return new Map(entries);
}

describe('VM recovery provider policy — adversarial transitions', () => {
  it('revokes provider affinity on partial or incomplete per-UAL outcomes', () => {
    const peerId = '12D3KooWPolicyHolder';
    const policy = new VmRecoveryProviderPolicy();
    expect(policy.selectNextCandidate([peerId], 3)).toBe(peerId);
    const probe = policy.beginAttempt(peerId)!;
    expect(probe.kind).toBe('probe');
    policy.finishAttempt(probe, 'found', dispositions(['ual-0', 'found']));
    expect(policy.selectNextCandidate([peerId], 3)).toBe(peerId);
    const reuse = policy.beginAttempt(peerId)!;
    expect(reuse.kind).toBe('proven-holder-reuse');

    policy.finishAttempt(reuse, 'found', dispositions(
      ['ual-1', 'found'],
      ['ual-2', 'incomplete'],
    ));

    expect(policy.selectNextCandidate([peerId], 3)).toBeUndefined();

    const nextSweep = new VmRecoveryProviderPolicy();
    expect(nextSweep.selectNextCandidate([peerId], 3)).toBe(peerId);
    expect(nextSweep.beginAttempt(peerId)?.kind).toBe('probe');
  });

  it('revokes provider affinity when the aggregate response is incomplete', () => {
    const peerId = '12D3KooWAggregateIncomplete';
    const policy = new VmRecoveryProviderPolicy();
    const probe = policy.beginAttempt(peerId)!;
    policy.finishAttempt(probe, 'found', dispositions(['ual-0', 'found']));
    const reuse = policy.beginAttempt(peerId)!;
    expect(reuse.kind).toBe('proven-holder-reuse');

    policy.finishAttempt(reuse, 'incomplete', dispositions(
      ['ual-1', 'found'],
      ['ual-2', 'found'],
    ));

    expect(policy.selectNextCandidate([peerId], 3)).toBeUndefined();
  });

  it('spends proven-holder affinity once and cannot re-arm it in the same slice', () => {
    const peerId = '12D3KooWOneReusePerSlice';
    const policy = new VmRecoveryProviderPolicy();
    const probe = policy.beginAttempt(peerId)!;
    policy.finishAttempt(probe, 'found', dispositions(['ual-0', 'found']));

    const reuse = policy.beginAttempt(peerId)!;
    expect(reuse.kind).toBe('proven-holder-reuse');
    expect(policy.beginAttempt(peerId)).toBeUndefined();

    policy.finishAttempt(reuse, 'found', dispositions(
      ['ual-1', 'found'],
      ['ual-2', 'found'],
    ));
    expect(policy.selectNextCandidate([peerId], 3)).toBeUndefined();
  });

  it('settles only the exact attempt token returned by beginAttempt', () => {
    const peerId = '12D3KooWAttemptToken';
    const policy = new VmRecoveryProviderPolicy();
    const attempt = policy.beginAttempt(peerId)!;

    expect(() => policy.finishAttempt(
      { ...attempt },
      'found',
      dispositions(['ual-0', 'found']),
    )).toThrow(/not active/);

    policy.finishAttempt(attempt, 'found', dispositions(['ual-0', 'found']));
    expect(policy.selectNextCandidate([peerId], 3)).toBe(peerId);
  });

  it('does not admit a second fresh peer after the considered-peer cap is spent', () => {
    const first = '12D3KooWFirstCappedPeer';
    const second = '12D3KooWSecondCappedPeer';
    const policy = new VmRecoveryProviderPolicy();

    expect(policy.selectNextCandidate([first, second], 1)).toBe(first);
    policy.markUnavailable(first);

    expect(policy.selectNextCandidate([first, second], 1)).toBeUndefined();
  });

  it('reuses an already-considered proven holder without widening the peer cap', () => {
    const holder = '12D3KooWReusableCappedHolder';
    const fresh = '12D3KooWFreshOutsideCap';
    const policy = new VmRecoveryProviderPolicy();

    expect(policy.selectNextCandidate([holder, fresh], 1)).toBe(holder);
    const probe = policy.beginAttempt(holder)!;
    policy.finishAttempt(probe, 'found', dispositions(['ual-0', 'found']));

    expect(policy.selectNextCandidate([fresh, holder], 1)).toBe(holder);
    expect(policy.beginAttempt(holder)?.kind).toBe('proven-holder-reuse');
  });
});
