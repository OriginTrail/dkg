// A top-up of this epoch's subscription: more value for a service it funds,
// or a budget for one it lacks. It is paid from the subscription's own
// source, at that source's discount. The node's dry run says what it would
// cost and what it would refuse before anything is sent.
//
// A top-up adds to the budget, so each confirmed one carries a key of its
// own, which the node carries out once: a repeat of the request gets the
// first answer and adds nothing. When the outcome is unknown (no answer, or a
// failure the node does not explain), the form offers only Retry, which sends
// that same request with that same key, until the node answers it: the
// top-up went through, or the node refused it. Meanwhile the request waits in
// the tab's session storage, so closing the form or reloading the page brings
// it back rather than opening a new top-up. What the budget holds is read
// beside Retry for the operator to see, never as leave to send another: a
// budget that does not show the top-up yet may still receive it.
import React, { useEffect, useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, FundedAnswer, ServiceRequest, Subscription, TopUpRequest } from '../api/types.js';
import { fmtHex, fmtTrac, microOfWei, modelName, tracOfWei, usdOf, weiOfMicro, weiOfTrac } from '../amounts.js';
import { ErrorCard } from '../shared.js';
import { randomUUID } from '../../lib/randomUUID.js';
import { PreviewLine, lineFor } from './Composer.js';
import { usePreview } from './usePreview.js';

/** What a top-up's dry run is asked about: the subscription, and what to add. */
interface Addition { subscriptionId: string; services: ServiceRequest[] }

/** A confirmed top-up: the request as sent, with its key, and the budget's value just before the first send, in wei. */
interface Attempt { subscriptionId: string; request: TopUpRequest; before: string }

/** Where a top-up waits for the node's answer: one per subscription and service. */
const pendingId = (subscriptionId: string, serviceId: string): string => `dkg-marketplace-topup:${subscriptionId}:${serviceId}`;

/** Top-ups waiting for an answer, kept in this page's memory where the browser refuses session storage. */
const unstored = new Map<string, string>();

/** The top-up of `serviceId` that waits for the node's answer, if there is one. */
function pendingOf(subscriptionId: string, serviceId: string): Attempt | null {
  const id = pendingId(subscriptionId, serviceId);
  let raw = unstored.get(id) ?? null;
  if (raw === null) {
    try { raw = window.sessionStorage.getItem(id); } catch { /* storage unavailable */ }
  }
  if (raw === null) return null;
  try {
    const a = JSON.parse(raw) as Attempt;
    if (a.subscriptionId === subscriptionId && typeof a.before === 'string' && typeof a.request?.idempotencyKey === 'string' && a.request.services?.[0]?.serviceId === serviceId) return a;
  } catch { /* not a top-up this form wrote */ }
  return null;
}

function keepPending(a: Attempt): void {
  const id = pendingId(a.subscriptionId, a.request.services[0].serviceId);
  const raw = JSON.stringify(a);
  try { window.sessionStorage.setItem(id, raw); } catch { unstored.set(id, raw); }
}

function forgetPending(a: Attempt): void {
  const id = pendingId(a.subscriptionId, a.request.services[0].serviceId);
  unstored.delete(id);
  try { window.sessionStorage.removeItem(id); } catch { /* storage unavailable */ }
}

/**
 * Whether the node refused the top-up itself (a 4xx), so nothing was added
 * under its key. No answer, a 5xx, or a refusal that says nothing of the key
 * leaves the outcome unknown: those given before the top-up is looked at (no
 * valid token, too many requests, a token that is not the node admin's, a
 * node without these routes), and the key held for another request.
 */
function refusedOutright(e: unknown): boolean {
  if (!isMarketplaceError(e) || e.status < 400 || e.status >= 500) return false;
  return e.status !== 401 && e.status !== 429 && !['NodeAdminRequired', 'MarketplaceAbsent', 'IdempotencyKeyReused'].includes(e.code);
}

/** The value of the subscription's budget for `serviceId` as the node shows it now; 0 while it has none. */
async function budgetValueOf(subscriptionId: string, epoch: number, serviceId: string): Promise<bigint> {
  const { subscriptions } = await marketplaceApi.subscriptions(epoch);
  const s = subscriptions.find((x) => x.subscriptionId === subscriptionId);
  if (!s) throw new Error(`subscription ${subscriptionId} is not on the node`);
  const b = s.budgets.find((x) => x.serviceId === serviceId);
  return b ? BigInt(b.value) : 0n;
}

/** What the budget holds after an unknown outcome: for the operator to see beside Retry. */
type Read = { state: 'checking' } | { state: 'read'; now: bigint } | { state: 'unread'; err: unknown };

type Phase =
  /** Composing, with the refusal of the last send or the failure that kept it from going, if any. */
  | { kind: 'compose'; err: unknown }
  /** A send on its way: a confirmed top-up's first, or a retry of one whose outcome is unknown. */
  | { kind: 'sending'; retry: boolean }
  /** No conclusive answer to `attempt` yet: Retry alone, with the same request and key. */
  | { kind: 'unknown'; attempt: Attempt; err: unknown; read: Read }
  | { kind: 'sent'; answer: FundedAnswer };

export function TopUp({ catalog, subscription, serviceId, onDone, onCancel }: {
  catalog: CatalogAnswer; subscription: Subscription; serviceId: string; onDone: () => void; onCancel: () => void;
}): React.ReactElement {
  const budget = subscription.budgets.find((b) => b.serviceId === serviceId);
  const service = catalog.services.find((s) => s.serviceId === serviceId);
  // A top-up still waiting for the node's answer comes back as it was sent.
  const [pending] = useState(() => pendingOf(subscription.subscriptionId, serviceId));
  const [amount, setAmount] = useState(() => (pending ? tracOfWei(pending.request.services[0].value) : '1'));
  // A budget the subscription has keeps its cap: shown exactly, and sent back as the node stores it, in wei.
  const [cap, setCap] = useState(() => (pending ? microOfWei(pending.request.services[0].maxPricePerUnit)
    : budget ? microOfWei(budget.maxPricePerUnit) : service ? lineFor(service, 'current').capMicro : ''));
  const [phase, setPhase] = useState<Phase>(() => (pending ? { kind: 'unknown', attempt: pending, err: null, read: { state: 'checking' } } : { kind: 'compose', err: null }));
  // A refused send asks for a fresh dry run before the next one.
  const [round, setRound] = useState(0);
  // A top-up whose outcome is unknown is fixed: no dry run, no edit, Retry instead of Confirm.
  const fixed = phase.kind === 'unknown' || (phase.kind === 'sending' && phase.retry);
  const value = weiOfTrac(amount);
  const capWei = budget ? budget.maxPricePerUnit : weiOfMicro(cap)?.toString() ?? null;
  const addition: Addition | null = value && capWei && !fixed
    ? { subscriptionId: subscription.subscriptionId, services: [{ serviceId, serviceClass: service?.serviceClass ?? 'inference', value: value.toString(), maxPricePerUnit: capWei }] }
    : null;
  const dryRun = usePreview(addition, (r) => marketplaceApi.topUpPreview(r.subscriptionId, r.services), { retain: 'none', round });
  const name = modelName(service?.label ?? serviceId);
  const source = subscription.source.kind === 'account' ? copy('source.account', { id: subscription.source.accountId }) : copy('source.wallet');
  // Only the dry run of exactly this top-up lets it go, and what goes is the request that dry run answered.
  const ready = phase.kind === 'compose' && !!dryRun.current && !dryRun.current.preview.refusal;

  // While the outcome is unknown, read what the budget holds.
  useEffect(() => {
    if (phase.kind !== 'unknown' || phase.read.state !== 'checking') return undefined;
    const { attempt } = phase;
    let live = true;
    const settle = (read: Read) => {
      if (live) setPhase((p) => (p.kind === 'unknown' && p.attempt === attempt ? { ...p, read } : p));
    };
    budgetValueOf(attempt.subscriptionId, subscription.epoch, serviceId)
      .then((now) => settle({ state: 'read', now }), (err: unknown) => settle({ state: 'unread', err }));
    return () => { live = false; };
  }, [phase, subscription.epoch, serviceId]);

  /** Send `attempt` and take the node's answer: the top-up went through, the node refused it, or the outcome is unknown. */
  const deliver = async (attempt: Attempt, retry: boolean) => {
    setPhase({ kind: 'sending', retry });
    keepPending(attempt);
    try {
      const answer = await marketplaceApi.topUp(attempt.subscriptionId, attempt.request);
      forgetPending(attempt);
      setPhase({ kind: 'sent', answer });
    } catch (e) {
      if (!refusedOutright(e)) {
        setPhase({ kind: 'unknown', attempt, err: e, read: { state: 'checking' } });
        return;
      }
      // Nothing was added under this key: the next top-up is a new one, after a fresh dry run.
      forgetPending(attempt);
      setPhase({ kind: 'compose', err: e });
      setRound((r) => r + 1);
    }
  };

  const confirm = async () => {
    const asked = dryRun.current;
    if (!asked || !ready) return;
    setPhase({ kind: 'sending', retry: false });
    let attempt: Attempt;
    try {
      // The budget as it stands, to show beside Retry should the answer be lost.
      const before = await budgetValueOf(asked.request.subscriptionId, subscription.epoch, serviceId);
      attempt = { subscriptionId: asked.request.subscriptionId, request: { services: asked.request.services, idempotencyKey: randomUUID() }, before: before.toString() };
    } catch (e) {
      // Nothing was sent.
      setPhase({ kind: 'compose', err: e });
      return;
    }
    await deliver(attempt, false);
  };
  const retry = () => { if (phase.kind === 'unknown') void deliver(phase.attempt, true); };
  const readAgain = () => setPhase((p) => (p.kind === 'unknown' ? { ...p, read: { state: 'checking' } } : p));

  if (phase.kind === 'sent') {
    return (
      <div className="mkt-notice" role="status" data-testid="mkt-topup-sent">
        <span data-copy="topup.sent">{copy('topup.sent', { name, tx: fmtHex(phase.answer.txHash) })}</span>{' '}
        <button type="button" className="mkt-linkbtn" data-copy="ctl.done" onClick={onDone}>{copy('ctl.done')}</button>
      </div>
    );
  }
  const sending = phase.kind === 'sending';
  // What the budget shows of a top-up whose outcome is unknown.
  let seen: 'checking' | 'shows' | 'missing' | 'unread' | null = null;
  if (phase.kind === 'unknown') {
    const { read, attempt } = phase;
    seen = read.state !== 'read' ? read.state : read.now >= BigInt(attempt.before) + BigInt(attempt.request.services[0].value) ? 'shows' : 'missing';
  }
  return (
    <div className="mkt-card mkt-gate" data-testid="mkt-topup" data-phase={phase.kind}>
      <h2 data-copy={budget ? 'topup.title' : 'topup.title.new'}>{copy(budget ? 'topup.title' : 'topup.title.new', { name, n: subscription.epoch })}</h2>
      <p className="mkt-muted mkt-xs" data-copy="topup.body">{copy('topup.body', { source })}</p>
      <div className="mkt-alloc">
        <label className="mkt-xs"><span data-copy="topup.amount">{copy('topup.amount')}</span>{' '}
          <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={sending || fixed} data-testid="mkt-topup-amount" aria-label={copy('topup.amount')} />{' '}
          <span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span></label>
        <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{value ? usdOf(value, catalog.fx.tracUsd) ?? '' : copy('composer.budget.zero')}</span>
        <label className="mkt-xs"><span data-copy="composer.cap">{copy('composer.cap')}</span>{' '}
          <input type="text" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} disabled={!!budget || sending || fixed} data-testid="mkt-topup-cap" aria-label={copy('composer.cap')} />{' '}
          <span data-copy="composer.cap.unit">{copy('composer.cap.unit')}</span></label>
      </div>
      {budget && <div className="mkt-muted mkt-xs" data-copy="topup.after">{copy('topup.after', { trac: fmtTrac(BigInt(budget.value) + (value ?? 0n)) })}</div>}
      {!fixed && <PreviewLine preview={dryRun.shown?.preview ?? null} err={dryRun.err} busy={dryRun.busy} />}
      {phase.kind === 'compose' && phase.err ? <ErrorCard err={phase.err} /> : null}
      {phase.kind === 'unknown' && seen && (
        <div className="mkt-notice" role="status" data-testid="mkt-topup-unsure" data-state={seen}>
          <span data-copy="topup.unknown">{copy('topup.unknown')}</span>{' '}
          <span data-copy={`topup.unknown.${seen}`}>
            {copy(`topup.unknown.${seen}`, { now: fmtTrac(phase.read.state === 'read' ? phase.read.now : 0n), before: fmtTrac(phase.attempt.before) })}
          </span>{' '}
          {seen !== 'checking' && (
            <button type="button" className="mkt-linkbtn" data-testid="mkt-topup-check" data-copy="topup.unknown.again" onClick={readAgain}>{copy('topup.unknown.again')}</button>
          )}
          {phase.read.state === 'unread' && <ErrorCard err={phase.read.err} />}
          {phase.err ? <ErrorCard err={phase.err} /> : null}
        </div>
      )}
      <div className="mkt-fork mkt-gate-actions">
        <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={onCancel} disabled={sending}>{copy('gate.cancel')}</button>
        {fixed ? (
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-topup-retry" data-copy="topup.unknown.retry" onClick={retry} disabled={sending}>
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
