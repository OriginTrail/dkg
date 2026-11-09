// A top-up of this epoch's subscription: more value for a service it funds,
// or a budget for one it lacks. It is paid from the subscription's own
// source, at that source's discount. The node's dry run says what it would
// cost and what it would refuse before anything is sent.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, ServiceRequest, Subscription } from '../api/types.js';
import { fmtHex, fmtMicro, fmtTrac, modelName, usdOf, weiOfMicro, weiOfTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { PreviewLine, lineFor } from './Composer.js';
import { usePreview } from './usePreview.js';

/** A top-up as the node takes it: the subscription, and what to add. */
interface TopUpRequest { subscriptionId: string; services: ServiceRequest[] }

export function TopUp({ catalog, subscription, serviceId, onDone, onCancel }: {
  catalog: CatalogAnswer; subscription: Subscription; serviceId: string; onDone: () => void; onCancel: () => void;
}): React.ReactElement {
  const budget = subscription.budgets.find((b) => b.serviceId === serviceId);
  const service = catalog.services.find((s) => s.serviceId === serviceId);
  const [amount, setAmount] = useState('1');
  const [cap, setCap] = useState(budget ? fmtMicro(budget.maxPricePerUnit) : service ? lineFor(service, 'current').capMicro : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState<FundedAnswer | null>(null);
  // A failed send asks for a fresh dry run before the next one: the transaction may have gone out.
  const [round, setRound] = useState(0);
  const value = weiOfTrac(amount);
  const capWei = weiOfMicro(cap);
  const request: TopUpRequest | null = value && capWei
    ? { subscriptionId: subscription.subscriptionId, services: [{ serviceId, serviceClass: service?.serviceClass ?? 'inference', value: value.toString(), maxPricePerUnit: capWei.toString() }] }
    : null;
  const dryRun = usePreview(request, (r) => marketplaceApi.topUpPreview(r.subscriptionId, r.services), { retain: 'none', round });
  const name = modelName(service?.label ?? serviceId);
  const source = subscription.source.kind === 'account' ? copy('source.account', { id: subscription.source.accountId }) : copy('source.wallet');
  // Only the dry run of exactly this top-up lets it go, and what goes is the request that dry run answered.
  const ready = !!dryRun.current && !dryRun.current.preview.refusal;
  const send = () => {
    const asked = dryRun.current;
    if (!asked || asked.preview.refusal || busy) return;
    setBusy(true); setErr(null);
    marketplaceApi.topUp(asked.request.subscriptionId, asked.request.services)
      .then(setSent).catch((e: unknown) => { setErr(e); setRound((r) => r + 1); }).finally(() => setBusy(false));
  };
  if (sent) {
    return (
      <div className="mkt-notice" role="status" data-testid="mkt-topup-sent">
        <span data-copy="topup.sent">{copy('topup.sent', { name, tx: fmtHex(sent.txHash) })}</span>{' '}
        <button type="button" className="mkt-linkbtn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>
      </div>
    );
  }
  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-topup">
      <h2 data-copy={budget ? 'topup.title' : 'topup.title.new'}>{copy(budget ? 'topup.title' : 'topup.title.new', { name, n: subscription.epoch })}</h2>
      <p className="mkt-muted mkt-xs" data-copy="topup.body">{copy('topup.body', { source })}</p>
      <div className="mkt-alloc">
        <label className="mkt-xs"><span data-copy="topup.amount">{copy('topup.amount')}</span>{' '}
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="mkt-topup-amount" aria-label={copy('topup.amount')} />{' '}
          <span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span></label>
        <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{value ? usdOf(value, catalog.fx.tracUsd) ?? '' : copy('composer.budget.zero')}</span>
        <label className="mkt-xs"><span data-copy="composer.cap">{copy('composer.cap')}</span>{' '}
          <input type="text" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} disabled={!!budget} data-testid="mkt-topup-cap" aria-label={copy('composer.cap')} />{' '}
          <span data-copy="composer.cap.unit">{copy('composer.cap.unit')}</span></label>
      </div>
      {budget && <div className="mkt-muted mkt-xs" data-copy="topup.after">{copy('topup.after', { trac: fmtTrac(BigInt(budget.value) + (value ?? 0n)) })}</div>}
      <PreviewLine preview={dryRun.shown?.preview ?? null} err={dryRun.err} busy={dryRun.busy} />
      {err ? <ErrorCard err={err} /> : null}
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel} disabled={busy}>{copy('gate.cancel')}</button>
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-topup-confirm" data-copy="topup.cta" onClick={send} disabled={busy || !ready}>
          {busy ? copy('state.working') : copy('topup.cta')}
        </button>
      </div>
    </div>
  );
}
