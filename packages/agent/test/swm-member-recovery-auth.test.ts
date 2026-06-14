import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { isMemberRecoveryAuthorized } from '../src/swm/member-recovery-auth.js';

const A = ethers.getAddress('0x' + 'a'.repeat(40));
const B = ethers.getAddress('0x' + 'b'.repeat(40));
const C = ethers.getAddress('0x' + 'c'.repeat(40));

/**
 * WS-0.3 — the #1 security item. The member-recovery gate HARD-DENIES on a
 * null/empty gate (the inversion of the fail-open) and never widens.
 */
describe('OT-RFC-49 WS-0.3 — isMemberRecoveryAuthorized', () => {
  it('HARD-DENIES on a null gate (the #1 fix — no widening to a weaker check)', () => {
    expect(isMemberRecoveryAuthorized(A, null)).toBe(false);
  });

  it('HARD-DENIES on an empty gate', () => {
    expect(isMemberRecoveryAuthorized(A, [])).toBe(false);
  });

  it('allows an EOA that is in the gate', () => {
    expect(isMemberRecoveryAuthorized(A, [A, B])).toBe(true);
  });

  it('denies an EOA that is not in the gate', () => {
    expect(isMemberRecoveryAuthorized(C, [A, B])).toBe(false);
  });

  it('is checksum/case-insensitive', () => {
    expect(isMemberRecoveryAuthorized(A.toLowerCase(), [A.toUpperCase().replace('0X', '0x')])).toBe(true);
  });

  it('denies (never throws) on a malformed requester or gate entries', () => {
    expect(isMemberRecoveryAuthorized('not-an-address', [A])).toBe(false);
    expect(isMemberRecoveryAuthorized(A, ['garbage', A])).toBe(true); // ignores bad entry, still matches A
    expect(isMemberRecoveryAuthorized(B, ['garbage'])).toBe(false);
  });
});
