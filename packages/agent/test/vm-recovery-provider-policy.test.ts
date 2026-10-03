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
  it('spends a carried holder once without bypassing the considered-peer cap', () => {
    const policy = new VmRecoveryProviderPolicy();
    policy.seedProvenHolder('holder');
    expect(policy.selectNextCandidate(['fresh', 'holder'], 1)).toBe('holder');
    const reuse = policy.beginAttempt('holder')!;
    expect(reuse.kind).toBe('proven-holder-reuse');
    policy.finishAttempt(reuse, 'found', dispositions(['ual-0', 'found']));
    policy.seedProvenHolder('holder');
    expect(policy.beginAttempt('holder')).toBeUndefined();
    expect(policy.selectNextCandidate(['fresh', 'holder'], 1)).toBeUndefined();
  });

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

  it('lets a released peer be attempted again in the same slice, as a probe', () => {
    const peerId = '12D3KooWReleasedHolder';
    const policy = new VmRecoveryProviderPolicy();
    const probe = policy.beginAttempt(peerId)!;
    policy.finishAttempt(probe, 'found', dispositions(['ual-0', 'found']));
    const reuse = policy.beginAttempt(peerId)!;
    expect(reuse.kind).toBe('proven-holder-reuse');

    policy.releaseAttempt(reuse);

    // Not spent, and not a proven holder either: it has to earn reuse again.
    expect(policy.selectNextCandidate([peerId], 3)).toBe(peerId);
    const again = policy.beginAttempt(peerId)!;
    expect(again.kind).toBe('probe');
    policy.finishAttempt(again, 'found', dispositions(['ual-1', 'found']));
    expect(policy.beginAttempt(peerId)?.kind).toBe('proven-holder-reuse');
  });

  it('releases only the exact attempt token returned by beginAttempt', () => {
    const peerId = '12D3KooWReleaseToken';
    const policy = new VmRecoveryProviderPolicy();
    const attempt = policy.beginAttempt(peerId)!;
    expect(() => policy.releaseAttempt({ ...attempt })).toThrow(/not active/);
    policy.releaseAttempt(attempt);
    // Released once: the token is no longer the active attempt.
    expect(() => policy.releaseAttempt(attempt)).toThrow(/not active/);
  });

  it('keeps a reserved peer inside the considered-peer cap while the others are tried', () => {
    const waiting = '12D3KooWReservedWaiting';
    const others = ['12D3KooWOtherA', '12D3KooWOtherB', '12D3KooWOtherC'];
    const policy = new VmRecoveryProviderPolicy();

    policy.reserve(waiting, 3);
    // Two more peers fit beside the reserved one; the third does not.
    for (const peerId of others.slice(0, 2)) {
      expect(policy.selectNextCandidate(others, 3)).toBe(peerId);
      policy.markUnavailable(peerId);
    }
    expect(policy.selectNextCandidate(others, 3)).toBeUndefined();
    // The reserved peer is still attemptable once it is offered.
    expect(policy.selectNextCandidate([waiting, ...others], 3)).toBe(waiting);
    expect(policy.beginAttempt(waiting)?.kind).toBe('probe');
  });

  it('does not let a reservation exceed the considered-peer cap', () => {
    const policy = new VmRecoveryProviderPolicy();
    expect(policy.selectNextCandidate(['12D3KooWFirst'], 1)).toBe('12D3KooWFirst');
    policy.reserve('12D3KooWLate', 1);
    policy.markUnavailable('12D3KooWFirst');
    expect(policy.selectNextCandidate(['12D3KooWLate'], 1)).toBeUndefined();
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
