// NSM v3.5 marketplace — the buyer-side surfaces (spec pack docs/ui-spec/).
// One tab hosts the buyer surfaces behind an internal switcher; Operate
// (surface 07, seller-facing) stays its own shell tab. Surfaces appear here
// one per commit as they pass integration.
import React, { useCallback, useEffect, useState } from 'react';
import { OnboardingCard } from '../nsm/OnboardingCard.js';
import { fetchOperateStatus, type NsmOperateStatus } from '../nsm/api.js';
import { copy } from '../nsm/copy.generated.js';

type Pane = 'models';

export function MarketplaceV35View(): React.ReactElement {
  const [status, setStatus] = useState<NsmOperateStatus | null | 'error'>(null);
  const [pane] = useState<Pane>('models');

  const refresh = useCallback(() => {
    fetchOperateStatus().then(setStatus).catch(() => setStatus('error'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="nsmx nsmx--page">
      <div className="frame">
        <OnboardingCard status={status} onDone={refresh} />
        {/* Surface 02 (catalog) integrates next — until then the pane states
            the honest truth about what this node can see. */}
        {pane === 'models' && status !== null && status !== 'error' && (
          <div className="card card--pad" style={{ textAlign: 'center' }}>
            <span className="sec">{copy('empty.catalog')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
