import React from 'react';
import { RefreshCw } from 'lucide-react';

/** The one Retry control on PCA screens. It sits outside the message it belongs to. */
export function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="v10-pca-card-btn ds-btn ds-sm" onClick={onClick}>
      <RefreshCw size={12} aria-hidden="true" />Retry
    </button>
  );
}
