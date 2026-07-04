import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility, type PublishEligibility } from '../../hooks/usePublishEligibility.js';
import { pcaPublishBlocked } from '../../pca/publishGate.js';

/**
 * The SWM→VM publish spend-gate — PURE POLICY (no DOM ids, no chip props, no presentation).
 * Returns the gate DECISION plus the whole resolved eligibility for the CTA to render from.
 */
export interface VmPublishGate {
  /** The publish CTA must be gated — a DANGER verdict with no owner-escrow-with-gas escape. */
  blocked: boolean;
  /** Cause-agnostic gate reason (TRAC coverage OR gas) for the CTA to surface when blocked. */
  reason: string;
  /** Whether the CTA should render the eligibility chip (node tracks ≥1 PCA). */
  chipVisible: boolean;
  /** The resolved S5 eligibility — passed straight to the chip (no prop re-listing). */
  eligibility: PublishEligibility;
}

/**
 * The SWM→VM publish spend-gate policy — owned by the PCA domain (not the memory-layer
 * widget) and pure: it resolves the S5 eligibility ONCE (so the chip + the button share a
 * single 30s poll and can't disagree), applies the owner-escrow exception, and hands the CTA
 * the decision + the eligibility. All presentation (DOM ids, chip render, aria wiring) lives
 * in the consumer.
 *
 * `blocked` = `verdict === 'fallthrough-no-funds' && !(ownerPublish && anyGasFunded)`. The
 * registration escrow (owner CG) covers the TRAC fee but NOT native gas, so an all-out-of-gas
 * fall-through still fails on-chain even for an owner and MUST stay gated; 'eligible'/
 * 'fallthrough' (has TRAC) and 'unknown' (inconclusive → fail OPEN) stay enabled. The reason
 * is cause-agnostic because `fallthrough-no-funds` fires for both no-coverage and no-gas.
 */
export function useVmPublishGate(contextGraphId: string): VmPublishGate {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const eligibility = usePublishEligibility(contextGraphId, 30_000);

  // The hook owns the single poll + store read; the DECISION is a pure, reusable helper.
  const blocked = pcaPublishBlocked(eligibility);
  const reason = 'Publish will fail — no signing wallet can fund it (coverage or gas).';
  const chipVisible = trackedIds.length > 0;

  return { blocked, reason, chipVisible, eligibility };
}
