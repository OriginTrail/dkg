// Add a provider to this node's buyer seat (address + API base, optional
// revenue-wallet pin). Saving does nothing yet: no backend in this step.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { noAction } from '../data.js';
import { ErrorCard } from './shared.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const API_BASE = /^(https:\/\/[^\s]+|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/[^\s]*)?)$/i;

export function SellerForm({ onCancel }: { onSaved: () => void; onCancel: () => void }): React.ReactElement {
  const [seller, setSeller] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [revenueWallet, setRevenueWallet] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown | null>(null);
  // The saved notice shows once a save succeeds; saving is a no-op in this step.
  const [saved] = useState(false);

  const invalidKey = !ADDR.test(seller.trim()) ? 'seller.form.invalid.address'
    : !API_BASE.test(apiBase.trim()) ? 'seller.form.invalid.apibase'
    : revenueWallet.trim() && !ADDR.test(revenueWallet.trim()) ? 'seller.form.invalid.address' : null;

  const save = async () => {
    if (invalidKey || busy) return;
    setBusy(true); setErr(null);
    try {
      noAction({ seller: seller.trim(), apiBase: apiBase.trim().replace(/\/+$/, ''), ...(revenueWallet.trim() ? { revenueWallet: revenueWallet.trim() } : {}) });
    } catch (e) { setErr(e); }
    finally { setBusy(false); }
  };

  return (
    <div className="mkt-card mkt-form" data-testid="mkt-seller-form">
      <h2 data-copy="seller.form.title">{copy('seller.form.title')}</h2>
      <label className="mkt-field"><span data-copy="seller.form.address">{copy('seller.form.address')}</span>
        <input className="mkt-input mkt-mono" data-testid="mkt-seller-address" value={seller} onChange={(e) => setSeller(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
      <label className="mkt-field"><span data-copy="seller.form.apibase">{copy('seller.form.apibase')}</span>
        <input className="mkt-input mkt-mono" data-testid="mkt-seller-apibase" value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://…" spellCheck={false} /></label>
      <label className="mkt-field"><span data-copy="seller.form.revenue">{copy('seller.form.revenue')}</span>
        <input className="mkt-input mkt-mono" data-testid="mkt-seller-revenue" value={revenueWallet} onChange={(e) => setRevenueWallet(e.target.value)} placeholder="0x…" spellCheck={false} /></label>
      {err ? <ErrorCard err={err} onRetry={save}><span className="mkt-muted mkt-xs" data-copy="seller.form.error">{copy('seller.form.error')}</span></ErrorCard> : null}
      {saved && <div className="mkt-chipleft" data-copy="seller.form.saved">{copy('seller.form.saved')}</div>}
      <div className="mkt-fork">
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-seller-save" data-copy="seller.form.cta" onClick={save}
          disabled={!!invalidKey || busy} title={invalidKey ? copy(invalidKey) : undefined}>{busy ? copy('state.working') : copy('seller.form.cta')}</button>
        {invalidKey && (seller || apiBase || revenueWallet) && <span className="mkt-muted mkt-xs" data-copy={invalidKey}>{copy(invalidKey)}</span>}
        <button type="button" className="mkt-btn" data-copy="ctl.cancel" onClick={onCancel} disabled={busy}>{copy('ctl.cancel')}</button>
      </div>
    </div>
  );
}
