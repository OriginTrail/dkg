// A top-up of this epoch's subscription: more value for a service it funds,
// or a budget for one it lacks. It is paid from the subscription's own
// source, at that source's discount. The node's dry run says what it would
// cost and what it would refuse before anything is sent. A top-up adds to
// the budget, so one whose outcome is unknown (no answer, or a failure the
// node does not explain) is looked up on the node before another can go.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, ServiceRequest, Subscription } from '../api/types.js';
import { fmtHex, fmtTrac, microOfWei, modelName, usdOf, weiOfMicro, weiOfTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { PreviewLine, lineFor } from './Composer.js';
import { usePreview } from './usePreview.js';

/** A top-up as the node takes it: the subscription, and what to add. */
interface TopUpRequest { subscriptionId: string; services: ServiceRequest[] }

/**
 * After a send whose outcome is unknown: the budget value it would have left,
 * and what the node's subscription shows.
 */
type Unsure =
  | { state: 'checking'; expected: bigint }
  | { state: 'landed'; expected: bigint; now: bigint }
  | { state: 'missing'; expected: bigint }
  | { state: 'unread'; expected: bigint; err: unknown };

/** A refusal the node answered (4xx): the top-up did not go through. No answer, or a 5xx, leaves it unknown. */
const definitelyRefused = (e: unknown): boolean => isMarketplaceError(e) && e.status >= 400 && e.status < 500;

/** The value of the subscription's budget for `serviceId` as the node shows it now; 0 while it has none. */
async function budgetValueOf(subscriptionId: string, epoch: number, serviceId: string): Promise<bigint> {
  const { subscriptions } = await marketplaceApi.subscriptions(epoch);
  const s = subscriptions.find((x) => x.subscriptionId === subscriptionId);
  if (!s) throw new Error(`subscription ${subscriptionId} is not on the node`);
  const b = s.budgets.find((x) => x.serviceId === serviceId);
  return b ? BigInt(b.value) : 0n;
}

export function TopUp({ catalog, subscription, serviceId, onDone, onCancel }: {
  catalog: CatalogAnswer; subscription: Subscription; serviceId: string; onDone: () => void; onCancel: () => void;
}): React.ReactElement {
  const budget = subscription.budgets.find((b) => b.serviceId === serviceId);
  const service = catalog.services.find((s) => s.serviceId === serviceId);
  const [amount, setAmount] = useState('1');
  // A budget the subscription has keeps its cap: shown exactly, and sent back as the node stores it, in wei.
  const [cap, setCap] = useState(budget ? microOfWei(budget.maxPricePerUnit) : service ? lineFor(service, 'current').capMicro : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [sent, setSent] = useState<FundedAnswer | null>(null);
  const [unsure, setUnsure] = useState<Unsure | null>(null);
  // A failed send asks for a fresh dry run before the next one.
  const [round, setRound] = useState(0);
  const value = weiOfTrac(amount);
  const capWei = budget ? budget.maxPricePerUnit : weiOfMicro(cap)?.toString() ?? null;
  const request: TopUpRequest | null = value && capWei
    ? { subscriptionId: subscription.subscriptionId, services: [{ serviceId, serviceClass: service?.serviceClass ?? 'inference', value: value.toString(), maxPricePerUnit: capWei }] }
    : null;
  const dryRun = usePreview(request, (r) => marketplaceApi.topUpPreview(r.subscriptionId, r.services), { retain: 'none', round });
  const name = modelName(service?.label ?? serviceId);
  const source = subscription.source.kind === 'account' ? copy('source.account', { id: subscription.source.accountId }) : copy('source.wallet');
  // Only the dry run of exactly this top-up lets it go, and what goes is the request that dry run answered;
  // after a send of unknown outcome, only once the subscription shows that it did not land.
  const ready = !!dryRun.current && !dryRun.current.preview.refusal && (unsure === null || unsure.state === 'missing');

  /** The node reads the budget again: whether the value a lost answer would have left is there. */
  const check = (expected: bigint) => {
    setUnsure({ state: 'checking', expected });
    budgetValueOf(subscription.subscriptionId, subscription.epoch, serviceId)
      .then((now) => {
        if (now >= expected) { setUnsure({ state: 'landed', expected, now }); return; }
        setUnsure({ state: 'missing', expected });
        setRound((r) => r + 1);
      })
      .catch((e: unknown) => setUnsure({ state: 'unread', expected, err: e }));
  };

  const send = async () => {
    const asked = dryRun.current;
    if (!asked || !ready || busy) return;
    setBusy(true); setErr(null); setUnsure(null);
    try {
      // The budget as it stands, so a lost answer can be told from a top-up that landed.
      let before: bigint;
      try {
        before = await budgetValueOf(asked.request.subscriptionId, subscription.epoch, serviceId);
      } catch (e) {
        setErr(e);
        return;
      }
      try {
        setSent(await marketplaceApi.topUp(asked.request.subscriptionId, asked.request.services));
      } catch (e) {
        setErr(e);
        // A refusal changed nothing: ask the node afresh before the next send.
        if (definitelyRefused(e)) setRound((r) => r + 1);
        // No answer, or a failure the node does not explain: it may have landed.
        else check(before + BigInt(asked.request.services[0].value));
      }
    } finally {
      setBusy(false);
    }
  };
  if (sent || unsure?.state === 'landed') {
    return (
      <div className="mkt-notice" role="status" data-testid="mkt-topup-sent">
        {sent
          ? <span data-copy="topup.sent">{copy('topup.sent', { name, tx: fmtHex(sent.txHash) })}</span>
          : <span data-copy="topup.unsure.landed">{copy('topup.unsure.landed', { name, trac: fmtTrac(unsure?.state === 'landed' ? unsure.now : 0n) })}</span>}{' '}
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
      {unsure && (
        <div className="mkt-notice" role="status" data-testid="mkt-topup-unsure" data-state={unsure.state}>
          <span data-copy={`topup.unsure.${unsure.state}`}>{copy(`topup.unsure.${unsure.state}`)}</span>
          {unsure.state !== 'checking' && (
            <button type="button" className="mkt-linkbtn" data-testid="mkt-topup-check" data-copy="topup.unsure.again" onClick={() => check(unsure.expected)} disabled={busy}>{copy('topup.unsure.again')}</button>
          )}
          {unsure.state === 'unread' && <ErrorCard err={unsure.err} />}
        </div>
      )}
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel} disabled={busy}>{copy('gate.cancel')}</button>
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-topup-confirm" data-copy="topup.cta" onClick={() => { void send(); }} disabled={busy || !ready}>
          {busy ? copy('state.working') : copy('topup.cta')}
        </button>
      </div>
    </div>
  );
}
