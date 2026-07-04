import React from 'react';
import { usePcaStore } from '../../stores/pca.js';
import { usePublishEligibility } from '../../hooks/usePublishEligibility.js';
import { EligibilityVerdictBanner } from '../../components/Pca/index.js';
import type { PcaVerdict } from '../../components/Pca/EligibilityVerdictBanner.js';

/**
 * S5 — the PRESENTATION of the eligibility chip: a PURE view over an already-resolved
 * verdict (no hook, no fetch). Both the standalone `PublishEligibilityChip` container
 * and LayerActionsWidget (which resolves the verdict ONCE for its CTA gate and the chip
 * together) render this, so the chip and the button can never disagree and there's no
 * duplicate poll. It carries its own aria-live (via EligibilityVerdictBanner: amber AND
 * danger = role=alert/assertive). `id` lets the publish button reference the verdict via
 * aria-describedby so a screen-reader user activating Publish hears the direct-cost/fail state.
 */
export function PublishEligibilityChipView({
  verdict,
  accountId,
  discountBps,
  accountUntracked,
  ownerPublish,
  id,
}: {
  verdict: PcaVerdict;
  accountId?: string;
  discountBps?: number;
  accountUntracked?: boolean;
  ownerPublish?: boolean;
  id?: string;
}) {
  return (
    <div className="v10-pca-publish-chip" id={id} data-testid="pca-publish-eligibility">
      <EligibilityVerdictBanner
        variant="chip"
        verdict={verdict}
        accountId={accountId}
        discountBps={discountBps}
        accountUntracked={accountUntracked}
        ownerPublish={ownerPublish}
      />
    </div>
  );
}

/**
 * Standalone container: resolves the verdict via its own 30s poll and renders the view.
 * Rendered only when the node tracks ≥1 PCA — a node not using conviction gets no chip
 * noise. (LayerActionsWidget bypasses this container and drives the view from its own
 * shared read; see that widget for the single-poll path.)
 */
export function PublishEligibilityChip({ contextGraphId, id }: { contextGraphId: string; id?: string }) {
  const trackedIds = usePcaStore((s) => s.trackedIds);
  const elig = usePublishEligibility(contextGraphId, 30_000);

  // No tracked PCA → no expectation of a discount → no chip.
  if (trackedIds.length === 0) return null;

  return (
    <PublishEligibilityChipView
      verdict={elig.verdict}
      accountId={elig.accountId}
      discountBps={elig.discountBps}
      accountUntracked={elig.accountUntracked}
      ownerPublish={elig.ownerPublish}
      id={id}
    />
  );
}
