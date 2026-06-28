import React from 'react';
import { usePcaAvailability } from '../hooks/usePcaAvailability.js';
import { EmptyState } from '../components/ContextGraphPrimitives.js';
import { ConvictionOverview } from './conviction/ConvictionOverview.js';

const PCA_DOCS_URL = 'https://docs.origintrail.io/';

/**
 * Root of the `conviction` tab. Runs the §6.6 deployment gate first: a 503
 * FEATURE_UNAVAILABLE from the capability probe replaces the WHOLE tab with the
 * Deployment-Unavailable state (not a per-card error), with a Recheck + docs
 * link. Otherwise it renders the S1 overview.
 */
export function PublishingConvictionPage() {
  const { status, recheck } = usePcaAvailability();

  return (
    <div data-testid="pca-view">
      {status === 'loading' ? (
        <div className="lazy-spinner">Loading publishing conviction…</div>
      ) : status === 'unavailable' ? (
        <div className="v10-pca-unavailable" data-testid="pca-unavailable">
          <EmptyState
            tone="neutral"
            title="Publishing conviction isn’t available on this network"
            description="This deployment’s chain adapter doesn’t support Publishing Conviction Accounts yet."
            actions={[
              { label: 'Recheck', onClick: recheck, variant: 'primary', testId: 'pca-recheck-btn' },
              { label: 'Learn more', onClick: () => window.open(PCA_DOCS_URL, '_blank', 'noopener') },
            ]}
          />
        </div>
      ) : (
        <ConvictionOverview />
      )}
    </div>
  );
}
