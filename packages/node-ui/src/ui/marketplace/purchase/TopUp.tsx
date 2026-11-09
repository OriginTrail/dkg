// A top-up of this epoch's subscription: more value for a service it funds,
// or a budget for one it lacks. It is paid from the subscription's own
// source, at that source's discount. The node's dry run says what it would
// cost and what it would refuse before anything is sent.
//
// A confirmed top-up belongs to the page, not to this form: topUpAttempts.ts
// keeps the request and its key from the moment Confirm is pressed, sends it
// once the budget is read, and, while its outcome is unknown, sends it again
// on Retry with that same key until the node answers. Every form of the
// budget shows that top-up as it was sent, with Retry alone while its outcome
// is unknown, so closing the form, opening another one or reloading the page
// brings it back rather than opening a new top-up. A form closed before the
// first send sends nothing: the top-up waits, with its key, for a Retry. The
// form owns only its draft, and what its own sends came to.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, ServiceRequest, Subscription, TopUpAnswer } from '../api/types.js';
import { fmtHex, fmtTrac, microOfWei, modelName, tracOfWei, usdOf, weiOfMicro, weiOfTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { PreviewLine, lineFor } from './Composer.js';
import { topUpAttempts, type Outcome } from './topUpAttempts.js';
import { usePreview } from './usePreview.js';

/** What a top-up's dry run is asked about: the subscription, and what to add. */
interface Addition { subscriptionId: string; service: ServiceRequest }

/**
 * A top-up this subscription holds with no form on show for it: one brought
 * back after a reload, or one whose form another flow replaced. Its budget
 * may no longer offer a top-up (past its soft ceiling, or no longer an
 * add-on), so the page shows it here, and opens its form, with its key, on
 * request.
 */
export function WaitingTopUp({ catalog, subscription, serviceId, onOpen }: {
  catalog: CatalogAnswer; subscription: Subscription; serviceId: string; onOpen: () => void;
}): React.ReactElement | null {
  const held = useSyncExternalStore(topUpAttempts.subscribe, () => topUpAttempts.held(subscription.subscriptionId, serviceId));
  if (!held) return null;
  const name = modelName(catalog.services.find((s) => s.serviceId === serviceId)?.label ?? serviceId);
  return (
    <div className="mkt-notice" role="status" data-testid={`mkt-topup-waiting-${serviceId}`} data-phase={held.kind === 'reserving' ? 'sending' : held.kind}>
      <span data-copy="topup.waiting">{copy('topup.waiting', { name, n: subscription.epoch, trac: fmtTrac(held.attempt.service.value) })}</span>{' '}
      <button type="button" className="mkt-linkbtn" data-testid={`mkt-topup-open-${serviceId}`} data-copy="topup.waiting.open" onClick={onOpen}>{copy('topup.waiting.open')}</button>
    </div>
  );
}

export function TopUp({ catalog, subscription, serviceId, onDone, onCancel }: {
  catalog: CatalogAnswer; subscription: Subscription; serviceId: string; onDone: () => void; onCancel: () => void;
}): React.ReactElement {
  const { subscriptionId } = subscription;
  const budget = subscription.budgets.find((b) => b.serviceId === serviceId);
  const service = catalog.services.find((s) => s.serviceId === serviceId);
  // The top-up this budget holds, if any: confirmed here, in another form, or before a reload.
  const held = useSyncExternalStore(topUpAttempts.subscribe, () => topUpAttempts.held(subscriptionId, serviceId));
  const terms = held?.attempt.service ?? null;
  const [amount, setAmount] = useState(() => (terms ? tracOfWei(terms.value) : '1'));
  // A budget the subscription has keeps its cap: shown exactly, and sent back as the node stores it, in wei.
  const [cap, setCap] = useState(() => (terms ? microOfWei(terms.maxPricePerUnit)
    : budget ? microOfWei(budget.maxPricePerUnit) : service ? lineFor(service, 'current').capMicro : ''));
  // What this form's last send came to: the node's answer, or why nothing was added.
  const [answer, setAnswer] = useState<TopUpAnswer | null>(null);
  const [err, setErr] = useState<unknown>(null);
  // A refused send asks for a fresh dry run before the next one.
  const [round, setRound] = useState(0);
  // Aborted when the form closes: a form closed while the budget is read before the first send does not send it.
  const closing = useRef<AbortController | null>(null);
  useEffect(() => {
    const c = new AbortController();
    closing.current = c;
    return () => c.abort();
  }, []);
  // A top-up brought back from before a reload: read what its budget holds.
  useEffect(() => { topUpAttempts.check(subscriptionId, serviceId); }, [subscriptionId, serviceId]);

  // A top-up whose outcome is unknown is fixed: no dry run, no edit, Retry instead of Confirm.
  const fixed = held?.kind === 'unknown' || (held?.kind === 'sending' && held.retry);
  const sending = held?.kind === 'reserving' || held?.kind === 'sending';
  const value = weiOfTrac(amount);
  const capWei = budget ? budget.maxPricePerUnit : weiOfMicro(cap)?.toString() ?? null;
  // A top-up repeats the class the chain stores for the budget, where the node names it; otherwise the catalog's. Never a guess.
  const serviceClass = budget?.serviceClass ?? service?.serviceClass ?? null;
  const addition: Addition | null = value && capWei && serviceClass && !fixed
    ? { subscriptionId, service: { serviceId, serviceClass, value: value.toString(), maxPricePerUnit: capWei } }
    : null;
  const dryRun = usePreview(addition, (r) => marketplaceApi.topUpPreview(r.subscriptionId, [r.service]), { retain: 'none', round });
  const name = modelName(service?.label ?? serviceId);
  const source = subscription.source.kind === 'account' ? copy('source.account', { id: subscription.source.accountId }) : copy('source.wallet');
  // Only the dry run of exactly this top-up lets it go, and what goes is the request that dry run answered.
  const ready = !held && !!dryRun.current && !dryRun.current.preview.refusal;

  const settled = (o: Outcome) => {
    if (o.kind === 'sent') setAnswer(o.answer);
    else if (o.kind === 'refused') { setErr(o.err); setRound((r) => r + 1); }
    else if (o.kind === 'unsent') setErr(o.err);
  };
  const confirm = async () => {
    const asked = dryRun.current;
    const closed = closing.current?.signal;
    if (!asked || !ready || !closed) return;
    setErr(null);
    settled(await topUpAttempts.confirm({ subscriptionId, epoch: subscription.epoch, service: asked.request.service, before: budget?.value ?? '0' }, closed));
  };
  const retry = async () => {
    setErr(null);
    settled(await topUpAttempts.retry(subscriptionId, serviceId));
  };

  if (answer) {
    return (
      <div className="mkt-notice" role="status" data-testid="mkt-topup-sent">
        {answer.txHash
          ? <span data-copy="topup.sent">{copy('topup.sent', { name, tx: fmtHex(answer.txHash) })}</span>
          : <span data-copy="topup.sent.shown">{copy('topup.sent.shown', { name })}</span>}{' '}
        <button type="button" className="mkt-linkbtn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>
      </div>
    );
  }
  // The terms on show: the held top-up's as it was sent, or the form's own draft.
  const shownAmount = terms ? tracOfWei(terms.value) : amount;
  const shownValue = weiOfTrac(shownAmount);
  // What the budget shows of a top-up whose outcome is unknown.
  let seen: 'checking' | 'shows' | 'missing' | 'unread' | null = null;
  if (held?.kind === 'unknown') {
    const { read, attempt } = held;
    seen = read.state !== 'read' ? read.state : read.now >= BigInt(attempt.before) + BigInt(attempt.service.value) ? 'shows' : 'missing';
  }
  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-topup" data-phase={held ? (held.kind === 'reserving' ? 'sending' : held.kind) : 'compose'}>
      <h2 data-copy={budget ? 'topup.title' : 'topup.title.new'}>{copy(budget ? 'topup.title' : 'topup.title.new', { name, n: subscription.epoch })}</h2>
      <p className="mkt-muted mkt-xs" data-copy="topup.body">{copy('topup.body', { source })}</p>
      <div className="mkt-alloc">
        <label className="mkt-xs"><span data-copy="topup.amount">{copy('topup.amount')}</span>{' '}
          <input type="text" inputMode="decimal" value={shownAmount} onChange={(e) => setAmount(e.target.value)} disabled={!!held} data-testid="mkt-topup-amount" aria-label={copy('topup.amount')} />{' '}
          <span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span></label>
        <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{shownValue ? usdOf(shownValue, catalog.fx.tracUsd) ?? '' : copy('composer.budget.zero')}</span>
        <label className="mkt-xs"><span data-copy="composer.cap">{copy('composer.cap')}</span>{' '}
          <input type="text" inputMode="decimal" value={terms ? microOfWei(terms.maxPricePerUnit) : cap} onChange={(e) => setCap(e.target.value)} disabled={!!budget || !!held} data-testid="mkt-topup-cap" aria-label={copy('composer.cap')} />{' '}
          <span data-copy="composer.cap.unit">{copy('composer.cap.unit')}</span></label>
      </div>
      {budget && <div className="mkt-muted mkt-xs" data-copy="topup.after">{copy('topup.after', { trac: fmtTrac(BigInt(budget.value) + (shownValue ?? 0n)) })}</div>}
      {!held && !serviceClass && <div className="mkt-xs mkt-errline" data-testid="mkt-topup-class" data-copy="topup.class.unknown">{copy('topup.class.unknown')}</div>}
      {!held && <PreviewLine preview={dryRun.shown?.preview ?? null} err={dryRun.err} busy={dryRun.busy} />}
      {!held && err ? <ErrorCard err={err} /> : null}
      {held?.kind === 'unknown' && seen && (
        <div className="mkt-notice" role="status" data-testid="mkt-topup-unsure" data-state={seen}>
          <span data-copy="topup.unknown">{copy('topup.unknown')}</span>{' '}
          <span data-copy={`topup.unknown.${seen}`}>
            {copy(`topup.unknown.${seen}`, { now: fmtTrac(held.read.state === 'read' ? held.read.now : 0n), before: fmtTrac(held.attempt.before) })}
          </span>{' '}
          {seen !== 'checking' && (
            <button type="button" className="mkt-linkbtn" data-testid="mkt-topup-check" data-copy="topup.unknown.again" onClick={() => topUpAttempts.readAgain(subscriptionId, serviceId)}>{copy('topup.unknown.again')}</button>
          )}
          {held.read.state === 'unread' && <ErrorCard err={held.read.err} />}
          {held.err ? <ErrorCard err={held.err} /> : null}
        </div>
      )}
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel} disabled={sending}>{copy('gate.cancel')}</button>
        {fixed ? (
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-topup-retry" data-copy="topup.unknown.retry" onClick={() => { void retry(); }} disabled={sending}>
            {sending ? copy('state.working') : copy('topup.unknown.retry')}
          </button>
        ) : (
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-topup-confirm" data-copy="topup.cta" onClick={() => { void confirm(); }} disabled={sending || !ready}>
            {sending ? copy('state.working') : copy('topup.cta')}
          </button>
        )}
      </div>
    </div>
  );
}
