import { ethers } from 'ethers';

/**
 * ACL hard-deny gate (the #1 security item).
 *
 * Once recovery serves PLAINTEXT member-to-member, the ACL is the ONLY barrier
 * between a non-member and a private CG's cleartext. The existing
 * `authorizePrivateSyncRequest` FAILS OPEN — on a null/failed gate resolve it
 * widens to a weaker participant/peer check (request-authorize.ts:163-169), so a
 * transient chain/meta hiccup turns a private CG public. This authorizer is the
 * member-recovery path's distinct gate and it does the opposite:
 *
 *  1. **HARD-DENY on a null/empty gate.** No gate ⇒ deny. Never widen.
 *  2. **Membership check only** — no participant/peer/node-operator fallback.
 *
 * The caller MUST supply a gate resolved from a FRESH authenticated read of the
 * CG `_meta` (`allowedAgents ∪ participantAgents` minus revoked) — NOT the
 * network-influenced subscription cache (poisonable; see the adversarial review).
 * This function only decides membership; sourcing the gate safely is the
 * caller's responsibility and the other half of the ACL-gate fix.
 */
export function isMemberRecoveryAuthorized(
  requesterAgentAddress: string,
  agentGate: readonly string[] | null,
): boolean {
  // Absent/empty gate → DENY. This is the load-bearing inversion of the fail-open.
  if (!agentGate || agentGate.length === 0) return false;

  let requester: string;
  try {
    requester = ethers.getAddress(requesterAgentAddress).toLowerCase();
  } catch {
    return false; // unparseable requester → deny
  }

  return agentGate.some((entry) => {
    try {
      return ethers.getAddress(entry).toLowerCase() === requester;
    } catch {
      return false; // ignore malformed gate entries, never widen
    }
  });
}
