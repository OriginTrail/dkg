// NSM v3.5 marketplace — the buyer-side surfaces (spec pack docs/ui-spec/).
// One tab hosts the buyer surfaces behind an internal switcher; Operate
// (surface 07, seller-facing) stays its own shell tab. Surfaces appear here
// one per commit as they pass integration.
import React, { useCallback, useEffect, useState } from 'react';
import { OnboardingCard } from '../nsm/OnboardingCard.js';
import { CatalogView } from '../nsm/CatalogView.js';
import { ModelPageView } from '../nsm/ModelPageView.js';
import { PlaygroundView } from '../nsm/PlaygroundView.js';
import { TreasuryView } from '../nsm/TreasuryView.js';
import { AccessView } from '../nsm/AccessView.js';
import { fetchOperateStatus, type NsmOperateStatus } from '../nsm/api.js';
import { useCatalog } from '../nsm/useCatalog.js';
import { copy } from '../nsm/copy.generated.js';

type Pane =
  | { k: 'models' }
  | { k: 'model'; groupKey: string }
  | { k: 'playground'; initialModel?: string }
  | { k: 'treasury' }
  | { k: 'access' };

const NAV: Array<{ label: string; pane: Pane }> = [
  { label: copy('nav.models'), pane: { k: 'models' } },
  { label: copy('nav.playground'), pane: { k: 'playground' } },
  { label: copy('nav.treasury'), pane: { k: 'treasury' } },
  { label: copy('nav.access'), pane: { k: 'access' } },
];

export function MarketplaceV35View(): React.ReactElement {
  const [status, setStatus] = useState<NsmOperateStatus | null | 'error'>(null);
  const [pane, setPane] = useState<Pane>({ k: 'models' });
  const cat = useCatalog();

  const refresh = useCallback(() => {
    fetchOperateStatus().then(setStatus).catch(() => setStatus('error'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const navKey = pane.k === 'model' ? 'models' : pane.k;

  return (
    <div className="nsmx nsmx--page">
      <div className="frame">
        <OnboardingCard status={status} onDone={refresh} />
        <div className="mnav">
          {NAV.map((n) => (
            <button key={n.label} className={navKey === n.pane.k ? 'is-active' : ''}
              onClick={() => setPane(n.pane)}>{n.label}</button>
          ))}
        </div>
        {pane.k === 'models' && (
          <CatalogView cat={cat} onOpenModel={(groupKey) => setPane({ k: 'model', groupKey })} />
        )}
        {pane.k === 'model' && (
          <ModelPageView cat={cat} groupKey={pane.groupKey}
            onBack={() => setPane({ k: 'models' })}
            onTry={(groupKey) => setPane({ k: 'playground', initialModel: groupKey })} />
        )}
        {pane.k === 'playground' && (
          <PlaygroundView cat={cat} initialModel={pane.initialModel} />
        )}
        {pane.k === 'treasury' && <TreasuryView />}
        {pane.k === 'access' && <AccessView status={status} refresh={refresh} />}
      </div>
    </div>
  );
}
