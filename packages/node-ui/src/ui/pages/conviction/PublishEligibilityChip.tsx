import React from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility } from '../../hooks/usePublishEligibility.js';
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
 */
export function PublishEligibilityChip({ contextGraphId, id }: { contextGraphId: string; id?: string }) {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const elig = usePublishEligibility(contextGraphId, 30_000);

  // No tracked PCA → no expectation of a discount → no chip.
  if (trackedIds.length === 0) return null;

  return (
    <div className="v10-pca-publish-chip" id={id} data-testid="pca-publish-eligibility">
      <EligibilityVerdictBanner
        variant="chip"
        verdict={elig.verdict}
        accountId={elig.accountId}
        discountBps={elig.discountBps}
        accountUntracked={elig.accountUntracked}
        ownerPublish={elig.ownerPublish}
      />
    </div>
  );
}
