// Funding: the buyer wallet (address, ETH for gas, TRAC and its allowance to
// the wallet contract) and each account it can use: whether the account can
// pay for services and why not, its discount, this window's allowance, the
// grant to this node with its limit per epoch and expiry, and its buyer and
// publisher wallets as two lists. On an account this node owns, the owner's
// actions go through the node; another owner adds the buyer wallet from
// their own wallet, with the consent the node signs here.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { Account, Consent, Funding, Tx } from '../api/types.js';
import { fmtAt, fmtHex, fmtTrac, weiOfTrac } from '../amounts.js';
import { ErrorCard, refusalKey, relAt } from '../shared.js';

const DAY = 86_400;

type Action = { kind: 'add' | 'limits' | 'consent'; accountId: string } | null;

function LimitsForm({ action, onSent, onCancel }: { action: NonNullable<Action>; onSent: (r: Tx | Consent) => void; onCancel: () => void }): React.ReactElement {
  const [limit, setLimit] = useState('20');
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const wei = weiOfTrac(limit);
  const d = Number(days);
  const ok = !!wei && Number.isInteger(d) && d > 0;
  const send = () => {
    if (!ok || busy) return;
    const limits = { maxCostPerEpoch: wei!.toString(), expiresAt: Math.floor(Date.now() / 1000) + d * DAY };
    setBusy(true); setErr(null);
    const call = action.kind === 'consent' ? marketplaceApi.buyerConsent(action.accountId, limits)
      : action.kind === 'add' ? marketplaceApi.addBuyer(action.accountId, limits)
        : marketplaceApi.funding().then((f) => marketplaceApi.setBuyerLimits(action.accountId, f.buyerWallet.address, limits));
    call.then(onSent).catch(setErr).finally(() => setBusy(false));
  };
  return (
    <div className="mkt-form" data-testid="mkt-limits-form">
      <div className="mkt-fork">
        <label className="mkt-xs"><span data-copy="treasury.limit">{copy('treasury.limit')}</span>{' '}
          <input className="ds-input mkt-input mkt-input--short mkt-mono" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} data-testid="mkt-limit" />{' '}
          <span data-copy="treasury.limit.unit">{copy('treasury.limit.unit')}</span></label>
        <label className="mkt-xs"><span data-copy="treasury.expiry">{copy('treasury.expiry')}</span>{' '}
          <input className="ds-input mkt-input mkt-input--short mkt-mono" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} data-testid="mkt-limit-days" />{' '}
          <span data-copy="treasury.expiry.unit">{copy('treasury.expiry.unit')}</span></label>
      </div>
      {err ? <ErrorCard err={err} onRetry={send} /> : null}
      <div className="mkt-fork">
        <button type="button" className="ds-btn" data-copy="gate.cancel" onClick={onCancel} disabled={busy}>{copy('gate.cancel')}</button>
        <button type="button" className="ds-btn ds-primary" data-testid="mkt-limits-send" data-copy={`treasury.${action.kind}.cta`} onClick={send} disabled={!ok || busy}>
          {busy ? copy('state.working') : copy(`treasury.${action.kind}.cta`)}
        </button>
      </div>
      {action.kind !== 'consent' && <div className="mkt-muted mkt-xs" data-copy="treasury.tx.note">{copy('treasury.tx.note')}</div>}
    </div>
  );
}

function AccountRow({ a, buyerWallet, onChanged }: { a: Account; buyerWallet: string; onChanged: () => void }): React.ReactElement {
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const run = (p: Promise<Tx>) => {
    setBusy(true); setErr(null);
    p.then((t) => { setDone(t.txHash); onChanged(); }).catch(setErr).finally(() => setBusy(false));
  };
  const sent = (r: Tx | Consent) => {
    setAction(null);
    if ('buyerSignature' in r) setConsent(r);
    else { setDone(r.txHash); onChanged(); }
  };
  const spendingOff = a.refusal === 'ServiceSpendingDisabled';
  const w = a.window;
  return (
    <div className="mkt-prow" data-testid={`mkt-account-${a.accountId}`} data-capable={a.serviceCapable}>
      <div className="mkt-mhead">
        <span>
          <strong data-copy="treasury.account">{copy('treasury.account', { id: a.accountId })}</strong>{' '}
          <span className="mkt-muted mkt-xs" data-copy={a.ownedByNode ? 'treasury.owned' : 'treasury.owned.other'}>{copy(a.ownedByNode ? 'treasury.owned' : 'treasury.owned.other')}</span>
        </span>
        {a.serviceCapable
          ? <span className="ds-badge ds-tone-success" data-copy="treasury.capable">{copy('treasury.capable', { pct: a.discountBps / 100 })}</span>
          : <span className="ds-badge ds-tone-danger" data-copy={refusalKey(a.refusal)}>{copy(refusalKey(a.refusal))}</span>}
      </div>
      <div className="mkt-muted mkt-xs" data-copy={w.expired ? 'treasury.window.expired' : 'treasury.window'}>
        {copy(w.expired ? 'treasury.window.expired' : 'treasury.window', { n: w.index, base: fmtTrac(w.baseRemaining), buffer: fmtTrac(w.topUpBuffer) })}
      </div>
      <div className="mkt-muted mkt-xs" data-copy={a.grant ? (a.grant.live ? 'treasury.grant' : 'treasury.grant.dead') : 'treasury.grant.none'}>
        {a.grant ? copy(a.grant.live ? 'treasury.grant' : 'treasury.grant.dead', { limit: fmtTrac(a.grant.maxCostPerEpoch), t: fmtAt(a.grant.expiresAt), rel: relAt(a.grant.expiresAt) }) : copy('treasury.grant.none')}
      </div>
      <div className="mkt-muted mkt-xs" data-copy="treasury.lists">
        {copy('treasury.lists', {
          buyers: a.buyerWallets.length ? a.buyerWallets.map((g) => `${fmtHex(g.buyer)}${g.buyer.toLowerCase() === buyerWallet.toLowerCase() ? ` (${copy('treasury.this.node')})` : ''}`).join(', ') : '—',
          publishers: a.publisherWallets.length ? a.publisherWallets.map(fmtHex).join(', ') : '—',
        })}
      </div>
      <div className="mkt-fork">
        {a.ownedByNode ? (
          <>
            {!a.grant?.live && <button type="button" className="ds-btn" data-testid={`mkt-add-buyer-${a.accountId}`} data-copy="treasury.add" onClick={() => setAction({ kind: 'add', accountId: a.accountId })} disabled={busy}>{copy('treasury.add')}</button>}
            {a.grant?.live && <button type="button" className="ds-btn" data-copy="treasury.limits" onClick={() => setAction({ kind: 'limits', accountId: a.accountId })} disabled={busy}>{copy('treasury.limits')}</button>}
            {a.grant?.live && <button type="button" className="ds-btn ds-danger" data-testid={`mkt-remove-buyer-${a.accountId}`} data-copy="treasury.remove" onClick={() => run(marketplaceApi.removeBuyer(a.accountId, a.grant!.buyer))} disabled={busy}>{copy('treasury.remove')}</button>}
            <button type="button" className="ds-btn" data-testid={`mkt-spending-${a.accountId}`} data-copy={spendingOff ? 'treasury.spending.on' : 'treasury.spending.off'}
              onClick={() => run(marketplaceApi.serviceSpending(a.accountId, spendingOff))} disabled={busy}>{copy(spendingOff ? 'treasury.spending.on' : 'treasury.spending.off')}</button>
          </>
        ) : (
          !a.grant?.live && <button type="button" className="ds-btn" data-testid={`mkt-consent-${a.accountId}`} data-copy="treasury.consent" onClick={() => setAction({ kind: 'consent', accountId: a.accountId })}>{copy('treasury.consent')}</button>
        )}
        {busy && <span className="mkt-muted mkt-xs" data-copy="state.working">{copy('state.working')}</span>}
        {done && <span className="mkt-muted mkt-xs" data-copy="treasury.sent">{copy('treasury.sent', { tx: fmtHex(done) })}</span>}
      </div>
      {action && <LimitsForm action={action} onSent={sent} onCancel={() => setAction(null)} />}
      {consent && (
        <div className="mkt-form" data-testid="mkt-consent">
          <div className="mkt-muted mkt-xs" data-copy="treasury.consent.body">{copy('treasury.consent.body', { id: consent.terms.accountId })}</div>
          <div className="mkt-snippet" data-copy="_data">{JSON.stringify(consent, null, 1)}</div>
        </div>
      )}
      {err ? <ErrorCard err={err} /> : null}
    </div>
  );
}

export function Treasury({ funding, onChanged }: { funding: Funding; onChanged: () => void }): React.ReactElement {
  const w = funding.buyerWallet;
  return (
    <div className="ds-card mkt-card" data-testid="mkt-treasury">
      <h2 data-copy="treasury.title">{copy('treasury.title')}</h2>
      <div className="mkt-wallet" data-testid="mkt-buyer-wallet">
        <strong data-copy="treasury.wallet">{copy('treasury.wallet')}</strong><br />
        <span className="mkt-mono" data-copy="_data">{w.address}</span><br />
        <span className="mkt-sec mkt-xs" data-copy="treasury.wallet.balances">{copy('treasury.wallet.balances', { eth: w.ethEther, trac: fmtTrac(w.trac), allowance: fmtTrac(w.walletContractAllowance) })}</span><br />
        <span className="mkt-muted mkt-xs" data-copy="treasury.wallet.note">{copy('treasury.wallet.note')}</span>
      </div>
      <h3 data-copy="treasury.accounts">{copy('treasury.accounts')}</h3>
      {funding.accountsPending
        ? funding.accountsError
          ? <div className="mkt-muted mkt-xs" data-copy="treasury.accounts.failed">{copy('treasury.accounts.failed', { error: funding.accountsError })}</div>
          : <div className="mkt-muted mkt-xs" data-copy="treasury.accounts.pending">{copy('treasury.accounts.pending')}</div>
        : funding.accounts.length === 0 && <div className="mkt-muted mkt-xs" data-copy="treasury.accounts.none">{copy('treasury.accounts.none')}</div>}
      {funding.accounts.map((a) => <AccountRow key={a.accountId} a={a} buyerWallet={w.address} onChanged={onChanged} />)}
      <p className="mkt-muted mkt-xs" data-copy="treasury.note">{copy('treasury.note')}</p>
    </div>
  );
}
