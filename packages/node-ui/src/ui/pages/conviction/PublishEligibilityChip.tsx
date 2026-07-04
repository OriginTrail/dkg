import React from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility, type PublishEligibility } from '../../hooks/usePublishEligibility.js';
import { EligibilityVerdictBanner } from '../../components/Pca/index.js';

/**
 * S5 — the condensed PCA eligibility chip on the SWM→VM publish CTA. The chip is
 * the load-bearing fall-through guard at the moment of spend; it carries its own
 * aria-live (via EligibilityVerdictBanner: amber AND danger = role=alert/assertive).
 * Rendered only when the node tracks ≥1 PCA — a node not using conviction gets no
 * chip noise.
 *
 * `id` lets the publish button reference the verdict via aria-describedby so a
 * screen-reader user activating Publish hears the direct-cost/fail state.
 *
 * `elig` (#1382) lets a parent that ALSO needs the verdict — e.g. LayerActionsWidget,
 * which gates the publish button on it — compute it ONCE and pass it in, so the chip
 * and the button share a single 30s poll and never disagree. When absent the chip runs
 * its own hook (standalone use preserved).
 */
export function PublishEligibilityChip({
  contextGraphId,
  id,
  elig,
}: {
  contextGraphId: string;
  id?: string;
  elig?: PublishEligibility;
}) {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  // When the parent supplies `elig`, skip this hook's fetch (enabled:false) to avoid a
  // duplicate poll; the hook must still be called unconditionally (rules of hooks).
  const own = usePublishEligibility(contextGraphId, 30_000, { enabled: elig === undefined });
  const e = elig ?? own;

  // No tracked PCA → no expectation of a discount → no chip.
  if (trackedIds.length === 0) return null;

  return (
    <div className="v10-pca-publish-chip" id={id} data-testid="pca-publish-eligibility">
      <EligibilityVerdictBanner
        variant="chip"
        verdict={e.verdict}
        accountId={e.accountId}
        discountBps={e.discountBps}
        accountUntracked={e.accountUntracked}
        ownerPublish={e.ownerPublish}
      />
    </div>
  );
}
