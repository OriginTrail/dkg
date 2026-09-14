import type { VerifyNetworkIdentityResponseResult } from '../src/p2p/network-identity-proof.js';

// `verifyNetworkIdentityResponse` produces exactly three states. They are pinned
// here rather than in a runtime test because no runtime assertion can observe
// that the contradictory combinations below fail to compile.

const ADDRESS = '0x00000000000000000000000000000000000000aa';

// 1. Rejected, always with the reason the coordinator interpolates into its log.
const rejected: VerifyNetworkIdentityResponseResult = { ok: false, reason: 'invalid signature' };
// 2. A legacy peer that verified without advertising a wallet binding.
const acceptedWithoutBinding: VerifyNetworkIdentityResponseResult = { ok: true };
// 3. A peer whose fresh wallet binding authenticated its operational address.
const acceptedWithBinding: VerifyNetworkIdentityResponseResult = { ok: true, authenticatedAgentAddress: ADDRESS };

// @ts-expect-error a rejection can never carry wallet evidence.
const rejectedWithAddress: VerifyNetworkIdentityResponseResult = { ok: false, reason: 'peer id mismatch', authenticatedAgentAddress: ADDRESS };

// @ts-expect-error an accepted peer can never carry a rejection reason.
const acceptedWithReason: VerifyNetworkIdentityResponseResult = { ok: true, reason: 'invalid signature' };

// @ts-expect-error a rejection without a reason is not representable.
const rejectedWithoutReason: VerifyNetworkIdentityResponseResult = { ok: false };

// The discriminant narrows, so the coordinator reads `reason` without a fallback
// and `authenticatedAgentAddress` only on the accepted branch.
function consume(result: VerifyNetworkIdentityResponseResult): string {
  if (result.ok) {
    const address: string | undefined = result.authenticatedAgentAddress;
    return address ?? 'accepted';
  }
  const reason: string = result.reason;
  return reason;
}

export type NetworkIdentityProofResultTypecheck = [
  typeof rejected,
  typeof acceptedWithoutBinding,
  typeof acceptedWithBinding,
  typeof rejectedWithAddress,
  typeof acceptedWithReason,
  typeof rejectedWithoutReason,
  typeof consume,
];
