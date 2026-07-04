import type { PublishEligibility } from '../hooks/usePublishEligibility.js';

/**
 * The SWM→VM publish-blocked DECISION — a PURE function of an already-resolved eligibility
 * (no store subscription, no poll), so any CTA that already has a `PublishEligibility` can
 * reuse it and it's unit-testable in isolation.
 *
 * Blocked on the DANGER verdict (`fallthrough-no-funds` = no signing wallet can fund the
 * publish) UNLESS an owner-CG publish also has a gas-funded wallet: the registration escrow
 * covers the TRAC fee but NOT native gas, so an all-out-of-gas fall-through still fails
 * on-chain even for an owner. 'eligible'/'fallthrough' (has TRAC) and 'unknown' (inconclusive
 * → fail OPEN) are never blocked.
 */
export function pcaPublishBlocked(eligibility: PublishEligibility): boolean {
  return (
    eligibility.verdict === 'fallthrough-no-funds' &&
    !(eligibility.ownerPublish && eligibility.anyGasFunded)
  );
}
