import React, { useId } from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility } from '../../hooks/usePublishEligibility.js';
import { PublishEligibilityChipView } from './PublishEligibilityChip.js';

/** The resolved SWM→VM publish spend-gate: everything a publish CTA needs to render. */
export interface VmPublishGate {
  /** The publish CTA must be gated — a DANGER verdict with no owner-escrow-with-gas escape. */
  blocked: boolean;
  /** Cause-agnostic gate reason (TRAC coverage OR gas). */
  reason: string;
  /** id of the visually-hidden gate-reason node the widget renders when blocked. */
  reasonId: string;
  /** The pure eligibility chip view, or null when the node tracks no PCA (no chip noise). */
  chip: React.ReactNode;
  /** The aria-describedby ids — ONLY targets that are actually rendered (the chip when a PCA
   *  is tracked, the reason node when blocked), so the button never references a missing id. */
  describedByIds: string[];
  /** Spread onto the publish button so the whole a11y wiring lives in one place. */
  ariaProps: {
    'aria-disabled': true | undefined;
    title: string | undefined;
    'aria-describedby': string | undefined;
  };
}

/**
 * The SWM→VM publish spend-gate policy — owned by the PCA domain (not the memory-layer
 * widget). Resolves the S5 eligibility ONCE (the chip + the button share it, so they can't
 * disagree, and there's a single 30s poll), applies the owner-escrow exception, and returns
 * the a11y wiring + the pure chip.
 *
 * `blocked` = `verdict === 'fallthrough-no-funds' && !(ownerPublish && anyGasFunded)`. The
 * registration escrow (owner CG) covers the TRAC fee but NOT native gas, so an all-out-of-gas
 * fall-through still fails on-chain even for an owner and MUST stay gated; 'eligible'/
 * 'fallthrough' (has TRAC) and 'unknown' (inconclusive → fail OPEN) stay enabled. The reason
 * is cause-agnostic because `fallthrough-no-funds` fires for both no-coverage and no-gas.
 */
export function useVmPublishGate(contextGraphId: string): VmPublishGate {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const elig = usePublishEligibility(contextGraphId, 30_000);
  const { verdict, ownerPublish, anyGasFunded } = elig;

  const blocked = verdict === 'fallthrough-no-funds' && !(ownerPublish && anyGasFunded);
  const reason = 'Publish will fail — no signing wallet can fund it (coverage or gas).';
  const verdictId = useId();
  const reasonId = useId();

  // Render targets and their aria-describedby refs are derived from the SAME conditions, so
  // the button never references an id that isn't in the DOM (no dangling aria-describedby):
  // the chip (id=verdictId) renders only when a PCA is tracked; the reason node (id=reasonId)
  // only when blocked.
  const chipShown = trackedIds.length > 0;
  const chip = chipShown ? <PublishEligibilityChipView {...elig} id={verdictId} /> : null;
  const describedByIds = [
    ...(chipShown ? [verdictId] : []),
    ...(blocked ? [reasonId] : []),
  ];

  const ariaProps = {
    // Persistent policy gate uses aria-disabled (keeps the button focusable + announceable);
    // native `disabled` is reserved for the transient busy state by the consumer.
    'aria-disabled': (blocked || undefined) as true | undefined,
    title: blocked ? reason : undefined,
    'aria-describedby': describedByIds.join(' ') || undefined,
  };

  return { blocked, reason, reasonId, chip, describedByIds, ariaProps };
}
