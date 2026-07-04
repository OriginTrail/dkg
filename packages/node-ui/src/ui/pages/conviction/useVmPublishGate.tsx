import { useId } from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility } from '../../hooks/usePublishEligibility.js';
import type { PcaVerdict } from '../../components/Pca/EligibilityVerdictBanner.js';

/**
 * The resolved SWM→VM publish spend-gate — DATA ONLY (no JSX, no presentation import). The
 * CTA renders the eligibility chip itself and assembles the button props, so the policy hook
 * stays decoupled from the chip component.
 */
export interface VmPublishGate {
  /** The publish CTA must be gated — a DANGER verdict with no owner-escrow-with-gas escape. */
  blocked: boolean;
  /** Cause-agnostic gate reason (TRAC coverage OR gas). */
  reason: string;
  /** id for the eligibility chip element (an aria-describedby target when the chip is shown). */
  verdictId: string;
  /** id for the visually-hidden gate-reason node (an aria-describedby target when blocked). */
  reasonId: string;
  /** The aria-describedby ids — ONLY targets that are actually rendered (the chip when a PCA
   *  is tracked, the reason node when blocked), so the button never references a missing id. */
  describedByIds: string[];
  /** Whether the CTA should render the eligibility chip (node tracks ≥1 PCA). */
  chipVisible: boolean;
  // Resolved eligibility fields the CTA renders the chip from:
  verdict: PcaVerdict;
  accountId?: string;
  discountBps?: number;
  accountUntracked?: boolean;
  ownerPublish: boolean;
}

/**
 * The SWM→VM publish spend-gate policy — owned by the PCA domain (not the memory-layer
 * widget). Resolves the S5 eligibility ONCE (the chip + the button share it, so they can't
 * disagree, and there's a single 30s poll), applies the owner-escrow exception, and returns
 * the gate metadata + the eligibility fields the CTA needs.
 *
 * `blocked` = `verdict === 'fallthrough-no-funds' && !(ownerPublish && anyGasFunded)`. The
 * registration escrow (owner CG) covers the TRAC fee but NOT native gas, so an all-out-of-gas
 * fall-through still fails on-chain even for an owner and MUST stay gated; 'eligible'/
 * 'fallthrough' (has TRAC) and 'unknown' (inconclusive → fail OPEN) stay enabled. The reason
 * is cause-agnostic because `fallthrough-no-funds` fires for both no-coverage and no-gas.
 */
export function useVmPublishGate(contextGraphId: string): VmPublishGate {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const { verdict, ownerPublish, anyGasFunded, accountId, discountBps, accountUntracked } =
    usePublishEligibility(contextGraphId, 30_000);

  const blocked = verdict === 'fallthrough-no-funds' && !(ownerPublish && anyGasFunded);
  const reason = 'Publish will fail — no signing wallet can fund it (coverage or gas).';
  const verdictId = useId();
  const reasonId = useId();

  // Aria-describedby ids are derived from the SAME conditions that render the targets, so the
  // button never references an id that isn't in the DOM: the chip (id=verdictId) renders only
  // when a PCA is tracked; the reason node (id=reasonId) only when blocked.
  const chipVisible = trackedIds.length > 0;
  const describedByIds = [
    ...(chipVisible ? [verdictId] : []),
    ...(blocked ? [reasonId] : []),
  ];

  return {
    blocked,
    reason,
    verdictId,
    reasonId,
    describedByIds,
    chipVisible,
    verdict,
    accountId,
    discountBps,
    accountUntracked,
    ownerPublish,
  };
}
