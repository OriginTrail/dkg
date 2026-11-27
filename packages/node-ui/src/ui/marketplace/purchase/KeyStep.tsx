// An access key's secret, shown once beside the gateway's base URL, and the
// short form that makes one: a label and a budget in TRAC.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { GATEWAY_BASE, marketplaceApi } from '../api/client.js';
import type { MadeKey } from '../api/types.js';
import { weiOfTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';

/** The secret, once: the two lines an OpenAI client needs, then Done forgets it. */
export function KeyOnce({ made, onDone }: { made: MadeKey; onDone: () => void }): React.ReactElement {
  return (
    <div className="ds-card mkt-card mkt-once" data-testid="mkt-key-once">
      <strong data-copy="access.minted">{copy('access.minted')}</strong>
      <div className="mkt-snippet" data-testid="mkt-key-plaintext" data-copy="_data">base_url = "{window.location.origin}{GATEWAY_BASE}"<br />api_key&nbsp;&nbsp;= "{made.secret}"</div>
      <div className="mkt-warnonce" data-copy="onboard.key.once">{copy('onboard.key.once')}</div>
      <button type="button" className="ds-btn ds-primary" data-testid="mkt-key-done" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>
    </div>
  );
}

export function KeyStep({ budgetTrac, onPlans }: { budgetTrac: string; onPlans: () => void }): React.ReactElement {
  const [label, setLabel] = useState('my-agent');
  const [budget, setBudget] = useState(budgetTrac);
  const [made, setMade] = useState<MadeKey | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const wei = weiOfTrac(budget);
  const mint = () => {
    if (!label.trim() || !wei || busy) return;
    setBusy(true); setErr(null);
    marketplaceApi.makeKey({ label: label.trim(), budget: wei.toString(), services: null })
      .then(setMade).catch(setErr).finally(() => setBusy(false));
  };
  return (
    <div className="ds-card mkt-card" data-testid="mkt-key-step">
      <h2 data-copy="onboard.key.title">{copy('onboard.key.title')}</h2>
      <p className="mkt-muted mkt-xs" data-copy="onboard.key.body">{copy('onboard.key.body')}</p>
      {made ? <KeyOnce made={made} onDone={() => setMade(null)} /> : (
        <div className="mkt-fork">
          <label className="mkt-xs"><span data-copy="key.name.label">{copy('key.name.label')}</span>{' '}
            <input className="ds-input mkt-input mkt-mono" value={label} onChange={(e) => setLabel(e.target.value)} data-testid="mkt-key-label" /></label>
          <label className="mkt-xs"><span data-copy="key.cap.label">{copy('key.cap.label')}</span>{' '}
            <input className="ds-input mkt-input mkt-mono" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} data-testid="mkt-key-budget" />{' '}
            <span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span></label>
          <button type="button" className="ds-btn ds-primary" data-testid="mkt-mint" data-copy="key.mint" onClick={mint} disabled={busy || !wei || !label.trim()}>
            {busy ? copy('state.working') : copy('key.mint')}
          </button>
        </div>
      )}
      {err ? <ErrorCard err={err} onRetry={mint} /> : null}
      <div className="mkt-fork">
        <button type="button" className="ds-btn" data-testid="mkt-view-plan" data-copy="purchase.active.plans" onClick={onPlans}>{copy('purchase.active.plans')}</button>
      </div>
    </div>
  );
}
