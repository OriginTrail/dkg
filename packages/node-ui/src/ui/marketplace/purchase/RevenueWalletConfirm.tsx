// The operator-controlled root for a provider's revenue wallet. When
// this node holds no pin for a seller, the first payment prompt waits until
// the operator reads the wallet the node froze and re-types its last four
// characters. The body posted is the frozen value verbatim.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { ErrorCard, shortAddr } from './shared.js';

export function RevenueWalletConfirm({ seller, revenueWallet, busy, err, onConfirm, onCancel }: {
  seller: string; revenueWallet: string; busy: boolean; err: unknown | null;
  onConfirm: (revenueWallet: string) => void; onCancel: () => void;
}): React.ReactElement {
  const [typed, setTyped] = useState('');
  const want = revenueWallet.slice(-4).toLowerCase();
  const matches = typed.trim().toLowerCase() === want;
  const showMismatch = typed.trim().length >= 4 && !matches;
  return (
    <div className="mkt-card mkt-rwconfirm" role="dialog" aria-modal="true" aria-label={copy('purchase.revenue.confirm.title')} data-testid="mkt-rw-confirm" data-seller={seller.toLowerCase()}>
      <h2 data-copy="purchase.revenue.confirm.title">{copy('purchase.revenue.confirm.title')}</h2>
      <p className="mkt-sec mkt-sm" data-copy="purchase.revenue.confirm.body">{copy('purchase.revenue.confirm.body', { seller: shortAddr(seller) })}</p>
      <div className="mkt-snippet mkt-mono" data-testid="mkt-rw-address" data-copy="_data">{revenueWallet}</div>
      <label className="mkt-field">
        <span data-copy="purchase.revenue.confirm.input">{copy('purchase.revenue.confirm.input')}</span>
        <input className="mkt-input mkt-mono mkt-input--short" data-testid="mkt-rw-input" value={typed} maxLength={4} autoComplete="off" spellCheck={false}
          onChange={(e) => setTyped(e.target.value)} aria-invalid={showMismatch} />
      </label>
      {showMismatch && <div className="mkt-errline mkt-xs" data-copy="purchase.revenue.confirm.mismatch">{copy('purchase.revenue.confirm.mismatch')}</div>}
      {err ? <ErrorCard err={err} onRetry={matches ? () => onConfirm(revenueWallet) : undefined} /> : null}
      <div className="mkt-fork">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel} disabled={busy}>{copy('gate.cancel')}</button>
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-rw-confirm-cta" data-copy="purchase.revenue.confirm.cta"
          onClick={() => onConfirm(revenueWallet)} disabled={!matches || busy} title={matches ? undefined : copy('purchase.revenue.confirm.mismatch')}>
          {busy ? copy('state.working') : copy('purchase.revenue.confirm.cta')}
        </button>
      </div>
    </div>
  );
}
