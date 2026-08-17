// NSM v3.5 marketplace — the buyer-side surfaces (spec pack docs/ui-spec/).
// One tab hosts the buyer surfaces behind an internal switcher; Operate
// (surface 07, seller-facing) stays its own shell tab. Surfaces appear here
// one per commit as they pass integration.
import React, { useCallback, useEffect, useState } from 'react';
import { OnboardingCard } from '../nsm/OnboardingCard.js';
import { CatalogView } from '../nsm/CatalogView.js';
import { ModelPageView } from '../nsm/ModelPageView.js';
import { fetchOperateStatus, type NsmOperateStatus } from '../nsm/api.js';
import { useCatalog } from '../nsm/useCatalog.js';

type Pane = { k: 'models' } | { k: 'model'; groupKey: string };

export function MarketplaceV35View(): React.ReactElement {
  const [status, setStatus] = useState<NsmOperateStatus | null | 'error'>(null);
  const [pane, setPane] = useState<Pane>({ k: 'models' });
  const cat = useCatalog();

  const refresh = useCallback(() => {
    fetchOperateStatus().then(setStatus).catch(() => setStatus('error'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="nsmx nsmx--page">
      <div className="frame">
        <OnboardingCard status={status} onDone={refresh} />
        {pane.k === 'models' && (
          <CatalogView cat={cat} onOpenModel={(groupKey) => setPane({ k: 'model', groupKey })} />
        )}
        {pane.k === 'model' && (
          <ModelPageView cat={cat} groupKey={pane.groupKey} onBack={() => setPane({ k: 'models' })} />
        )}
      </div>
    </div>
  );
}
