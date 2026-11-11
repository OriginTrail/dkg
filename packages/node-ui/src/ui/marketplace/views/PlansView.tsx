// Plans: this epoch's subscription and the prefunded next one, the standing
// plan and its renewal, top-ups, the reconciliation of what this node holds
// against what landed, recent calls by key, and the funding behind it all.
// A node that never subscribed gets three steps: fund the buyer wallet or add
// it to an account, compose a plan, mint a key. A confirmation that waits for
// the user with no flow on show for it (a funding of unknown outcome, a plan
// not saved) is shown above the page, with what it allows.
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PageHeader } from '../../components/ds/PageHeader.js';
import { copy } from '../copy.generated.js';
import { isMarketplaceAbsent, isMarketplaceOff, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, Plan, Subscription } from '../api/types.js';
import { fmtMicro, fmtTrac, microOfWei, modelName, sumWei } from '../amounts.js';
import { ErrorCard, OffCard, refusalKey, relAt, sellerName, useLoad } from '../shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';
import { FundFlow, WaitingConfirmation } from '../purchase/FundFlow.js';
import { fundings } from '../purchase/fundings.js';
import { lineFor, type Draft } from '../purchase/Composer.js';
import { Meters } from '../purchase/Meters.js';
import { Activity, Reconciliation } from '../purchase/Ledger.js';
import { ProgressSteps } from '../purchase/ProgressSteps.js';
import { TopUp, WaitingTopUp } from '../purchase/TopUp.js';
import { topUpAttempts } from '../purchase/topUpAttempts.js';
import { Treasury } from '../purchase/Treasury.js';
import { useVisibilityPolling } from '../../hooks/useVisibilityPolling.js';

/** How often the funding is read again while the node is still reading the account list. */
const ACCOUNTS_PENDING_RELOAD_MS = 10_000;

/** The flow on show; `confirmed` is the confirmation it made, once the coordinator holds it. */
type Flow = ({ kind: 'fund'; epoch: 'current' | 'next'; serviceId?: string } | { kind: 'plan' } | { kind: 'top-up'; serviceId: string }) & { confirmed?: number };

/**
 * A draft from the plan, or a fresh one with `serviceId` picked. Each line
 * keeps the plan's class and its cap to the wei, so an edit elsewhere saves
 * it unchanged, even when the catalog lacks its service this epoch.
 */
function draftOf(catalog: CatalogAnswer, plan: Plan | null, epoch: 'current' | 'next', serviceId?: string): Draft {
  const lines = plan
    ? plan.services.map((s) => ({ serviceId: s.serviceId, serviceClass: s.serviceClass, valueTrac: s.valueTrac.replace(/\.0$/, ''), capMicro: microOfWei(s.maxPricePerUnit), pinned: s.pinnedSeller ?? null }))
    : [];
  const extra = serviceId && !lines.some((l) => l.serviceId === serviceId) ? catalog.services.find((s) => s.serviceId === serviceId) : undefined;
  return {
    epoch,
    source: plan?.source.kind === 'account' ? { kind: 'account', accountId: plan.source.accountId } : { kind: 'wallet' },
    lines: extra ? [...lines, lineFor(extra, epoch)] : lines,
    renew: plan?.renew ?? true,
    renewUntil: String(plan?.renewUntilEpoch ?? catalog.epoch + 6),
  };
}

/** The plan could not be read: why, and a read again, which is always safe to ask for. */
function PlanUnread({ err, onRetry }: { err: unknown; onRetry: () => void }): React.ReactElement {
  return (
    <ErrorCard err={err}>
      <span className="mkt-xs" data-testid="mkt-plan-unread" data-copy="plan.unread">{copy('plan.unread')}</span>
      <button type="button" className="mkt-btn" data-testid="mkt-plan-reload" data-copy="ctl.retry" onClick={onRetry}>{copy('ctl.retry')}</button>
    </ErrorCard>
  );
}

function NextEpoch({ catalog, next, plan, planUnknown, onChange, onFundNext }: {
  catalog: CatalogAnswer; next: Subscription | null;
  /** The plan as last read; null when there is none, or none could be read. */
  plan: Plan | null;
  /** The latest read of the plan failed and none before it found one: whether there is a plan is not known. */
  planUnknown: boolean;
  /** A plan change and a funding of the next epoch, each passed only where it may be offered. */
  onChange?: () => void; onFundNext?: () => void;
}): React.ReactElement {
  const n = catalog.epoch + 1;
  const source = (s: { kind: string; accountId?: string }) => (s.kind === 'account' ? copy('source.account', { id: s.accountId ?? '' }) : copy('source.wallet'));
  const planKey = planUnknown ? 'plan.unknown' : plan?.renew ? 'plan.renews' : plan ? 'plan.once' : 'plan.none';
  return (
    <div className="mkt-card" data-testid="mkt-next-epoch" data-funded={!!next}>
      <div className="mkt-planhead">
        <h2 data-copy={next ? 'next.funded' : 'next.title'}>{copy(next ? 'next.funded' : 'next.title', { n })}</h2>
        {onChange && <button type="button" className="mkt-btn" data-testid="mkt-change-plan" data-copy="next.change" onClick={onChange}>{copy('next.change')}</button>}
      </div>
      {next ? (
        <p className="mkt-sec mkt-sm" data-copy="next.funded.body">{copy('next.funded.body', { value: fmtTrac(next.value), cost: fmtTrac(next.cost), n: next.budgets.length, source: source(next.source), t: relAt(next.startsAt) })}</p>
      ) : plan?.next ? (
        <>
          <p className="mkt-sec mkt-sm" data-copy="next.renews">{copy('next.renews', { n: plan.next.epoch, t: relAt(plan.next.at), cost: fmtTrac(plan.next.cost), source: source(plan.source) })}</p>
          {plan.next.refusal && <div className="mkt-xs mkt-errline" data-testid="mkt-renewal-refusal" data-copy={refusalKey(plan.next.refusal)}>{copy('next.refusal', { reason: copy(refusalKey(plan.next.refusal)) })}</div>}
        </>
      ) : (
        <div className="mkt-fork">
          <span className="mkt-sec mkt-sm" data-copy="next.none">{copy('next.none', { n })}</span>
          {onFundNext && <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-fund-next" data-copy="next.fund" onClick={onFundNext}>{copy('next.fund', { n })}</button>}
        </div>
      )}
      <div className="mkt-muted mkt-xs" data-copy={planKey}>
        {plan && planKey === 'plan.renews' ? copy('plan.renews', { n: plan.renewUntilEpoch ?? '—', source: source(plan.source) }) : copy(planKey)}
      </div>
    </div>
  );
}

function NotOnPlan({ catalog, current, onAdd }: { catalog: CatalogAnswer; current: Subscription; onAdd: (serviceId: string) => void }): React.ReactElement {
  const missing = catalog.services.filter((s) => !current.budgets.some((b) => b.serviceId === s.serviceId) && s.offers.some((o) => o.available !== false));
  return (
    <div className="mkt-card" data-testid="mkt-addon-list">
      <h3 data-copy="plans.addon.section">{copy('plans.addon.section')}</h3>
      <p className="mkt-muted mkt-xs" data-copy="plans.addon.section.note">{copy('plans.addon.section.note', { t: relAt(current.endsAt) })}</p>
      {missing.length === 0 && <div className="mkt-muted mkt-xs" data-copy="plans.addon.none">{copy('plans.addon.none')}</div>}
      {missing.map((s) => (
        <div key={s.serviceId} className="mkt-mhead mkt-prow" data-testid={`mkt-addon-row-${s.serviceId}`}>
          <span>
            <strong title={s.label} data-copy="_data">{modelName(s.label)}</strong>{' '}
            <span className="mkt-muted mkt-xs" data-copy="catalog.via">{copy('catalog.via', { sellers: [...new Set(s.offers.map((o) => o.seller))].map(sellerName).join(' · ') })}</span>{' '}
            <span className="mkt-mono mkt-sec" data-copy="catalog.price.micro">{copy('catalog.price.micro', { micro: fmtMicro(s.priceMin), unit: 'tok' })}</span>
          </span>
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid={`mkt-addon-${s.serviceId}`} data-copy="catalog.addon" onClick={() => onAdd(s.serviceId)}>{copy('catalog.addon')}</button>
        </div>
      ))}
    </div>
  );
}

export function PlansView(): React.ReactElement {
  const cat = useLoad(() => marketplaceApi.catalog());
  const subs = useLoad(() => marketplaceApi.subscriptions());
  const planned = useLoad(() => marketplaceApi.plan());
  const funding = useLoad(() => marketplaceApi.funding());
  const activity = useLoad(() => marketplaceApi.activity());
  const ask = useMarketplaceDraftStore((s) => s.ask);
  const takeAsk = useMarketplaceDraftStore((s) => s.takeAsk);
  const [flow, setFlow] = useState<Flow | null>(null);
  const catalog = cat.data;
  const epoch = catalog?.epoch ?? null;
  const current = subs.data?.subscriptions.find((s) => s.epoch === epoch) ?? null;
  const next = subs.data?.subscriptions.find((s) => epoch !== null && s.epoch === epoch + 1) ?? null;
  const planRead = planned.status;
  // The plan as last read: null while there is none, and after a failed read, the one read before it, if any.
  const plan = planned.data;
  // The node answers a node without a plan with PlanNotFound, which reads as null. Any other failure of the
  // latest read leaves the plan unknown, whatever an earlier read said: until a read succeeds, nothing that
  // saves a plan is offered (onboarding, a funding, a plan change), as it would write over the plan there is.
  // This is the one place that decides it.
  const mayEditPlan = planRead.state === 'resolved';
  // The flow on show: a top-up saves no plan, so it stays while the plan cannot be read; a plan change or a funding does not.
  const shown = flow && (flow.kind === 'top-up' || mayEditPlan) ? flow : null;
  // The page waits while the plan is read for the first time, and while a read that found no plan is read again.
  const planPending = planned.loading && plan === null && planRead.state !== 'failed';
  const reloadAll = () => { cat.reload(); subs.reload(); planned.reload(); funding.reload(); activity.reload(); };
  const close = () => { setFlow(null); reloadAll(); };
  // The confirmations that wait for the user with no flow on show for them, and those whose plan the node took.
  const waiting = useSyncExternalStore(fundings.subscribe, fundings.waiting).filter((id) => id !== shown?.confirmed);
  const completed = useSyncExternalStore(fundings.subscribe, fundings.completed);
  // The page is read again when one starts to wait out of sight (its funding may have landed), and once the node took a
  // plan out of sight: after the write, not as a Retry sends it. The flow on show reads the page again when it is done.
  const seenWaiting = useRef(new Set(waiting));
  const seenCompleted = useRef(completed.length);
  useEffect(() => {
    const started = waiting.some((id) => !seenWaiting.current.has(id));
    const saved = completed.slice(seenCompleted.current).some((id) => id !== shown?.confirmed);
    seenWaiting.current = new Set(waiting);
    seenCompleted.current = completed.length;
    if (started || saved) reloadAll();
  });
  // The top-ups this epoch's subscription holds, whatever its budgets show: each waits for the node's answer.
  const heldTopUps = useSyncExternalStore(topUpAttempts.subscribe, () => topUpAttempts.pending(current?.subscriptionId ?? null));
  // A top-up the node carried out adds to a budget and takes from its source. The subscriptions and the funding are read
  // again when its answer comes, whatever became of its form, and nothing else is: reading a missing plan again shows the
  // loading frame, which would close the flow on show.
  const toppedUp = useSyncExternalStore(topUpAttempts.subscribe, topUpAttempts.completed);
  const seenToppedUp = useRef(toppedUp);
  const { reload: reloadSubs } = subs;
  const { reload: reloadFunding } = funding;
  useEffect(() => {
    if (toppedUp === seenToppedUp.current) return;
    seenToppedUp.current = toppedUp;
    reloadSubs();
    reloadFunding();
  }, [toppedUp, reloadSubs, reloadFunding]);
  // The node answers the funding before it has read the account list when that takes long (the first read on a public
  // RPC can). While the last funding read says so, the funding is read again on the UI's polling policy: paused while
  // the tab is hidden, and kept up after a read that failed, until a read brings the list. A poll that finds a funding
  // read still running skips its turn, so a newer read never supersedes a slow one before it answers.
  const accountsPending = funding.data?.accountsPending === true;
  const fundingLoading = funding.loading;
  useVisibilityPolling(() => { if (!fundingLoading) reloadFunding(); }, accountsPending ? ACCOUNTS_PENDING_RELOAD_MS : 0, { runImmediately: false });
  // The flow on show made a confirmation; the onboarding one is on show with no flow asked for, and is one from here.
  const confirmed = (id: number) => setFlow((f) => ({ ...(f ?? { kind: 'fund', epoch: 'current' }), confirmed: id }));

  // One-shot asks from Browse and the playground: compose with a service picked, or top it up.
  useEffect(() => {
    if (!ask || !catalog || !subs.data) return;
    // An ask that composes saves a plan: it waits, untaken, until the plan is read.
    const topsUp = !!current && (ask.kind === 'top-up' || !!ask.serviceId);
    if (!topsUp && (!mayEditPlan || planned.loading)) return;
    const a = takeAsk();
    if (!a) return;
    if (current) setFlow(a.kind === 'top-up' || a.serviceId ? { kind: 'top-up', serviceId: a.serviceId ?? '' } : { kind: 'plan' });
    else setFlow({ kind: 'fund', epoch: 'current', ...(a.serviceId ? { serviceId: a.serviceId } : {}) });
  }, [ask, catalog, subs.data, current, takeAsk, mayEditPlan, planned.loading]);

  const loadErr = cat.err ?? subs.err ?? planned.err;
  if ([cat.err, subs.err, planned.err, funding.err].some(isMarketplaceOff)) return <div className="mkt-frame" data-testid="mkt-plans" data-state="off"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" /><OffCard /></div>;
  if ([cat.err, subs.err, planned.err, funding.err].some(isMarketplaceAbsent)) return <div className="mkt-frame" data-testid="mkt-plans" data-state="absent"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" /><OffCard absent /></div>;
  if (loadErr && !(catalog && subs.data)) {
    return (
      <div className="mkt-frame" data-testid="mkt-plans" data-state="error"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" />
        <div className="mkt-card"><div data-copy="empty.error">{copy('empty.error')}</div><ErrorCard err={loadErr} onRetry={reloadAll} /></div>
      </div>
    );
  }
  if (!catalog || !subs.data || planPending) {
    return <div className="mkt-frame" data-testid="mkt-plans" data-state="loading"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" /><div className="mkt-card mkt-muted" data-copy="plans.loading">{copy('plans.loading')}</div></div>;
  }

  const endsAt = funding.data?.epochEndsAt ?? current?.endsAt ?? null;
  const notices = mayEditPlan ? waiting.map((id) => <WaitingConfirmation key={id} id={id} onDone={close} />) : null;
  const treasury = funding.data ? <Treasury funding={funding.data} onChanged={funding.reload} /> : funding.err ? <ErrorCard err={funding.err} onRetry={funding.reload} /> : null;
  const planErr = planRead.state === 'failed' ? <PlanUnread err={planRead.err} onRetry={planned.reload} /> : null;
  const fundFlow = (f: Extract<Flow, { kind: 'fund' }>, onboarding: boolean) => (
    <FundFlow key={`${f.epoch}:${f.serviceId ?? ''}`} catalog={catalog} funding={funding.data} initial={draftOf(catalog, plan, f.epoch, f.serviceId)}
      fundsEpoch onboarding={onboarding} endsAt={endsAt} onDone={close} onCancel={onboarding ? undefined : () => setFlow(null)} onConfirmed={confirmed} />
  );

  // ── no subscription this epoch ──
  if (!current) {
    // Whether to onboard or to fund the plan's next epoch turns on the plan: unknown, neither is offered.
    if (!mayEditPlan) {
      return (
        <div className="mkt-frame" data-testid="mkt-plans" data-state="plan-unread"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" />
          <div className="mkt-card"><div data-copy="empty.error">{copy('empty.error')}</div>{planErr}</div>
        </div>
      );
    }
    if (!plan) {
      const w = funding.data?.buyerWallet;
      const funded = !!w && BigInt(w.trac) > 0n || (funding.data?.accounts ?? []).some((a) => a.serviceCapable && a.grant?.live);
      const f = shown?.kind === 'fund' ? shown : { kind: 'fund' as const, epoch: 'current' as const };
      return (
        <div className="mkt-frame" data-testid="mkt-plans" data-state="never-subscribed"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" />
          {notices}
          <h2 data-copy="onboard.p5.title">{copy('onboard.p5.title')}</h2>
          {!funded && <ProgressSteps step={1} />}
          {treasury}
          {funded && fundFlow(f, true)}
        </div>
      );
    }
    return (
      <div className="mkt-frame" data-testid="mkt-plans" data-state="period-ended"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" />
        {notices}
        {shown?.kind === 'fund' ? fundFlow(shown, false) : (
          <div className="mkt-card">
            <h2 data-copy="ended.title">{copy('ended.title', { n: catalog.epoch })}</h2>
            <p className="mkt-muted mkt-xs" data-copy={plan.renew ? 'ended.renewed.until' : 'ended.norenew'}>
              {plan.renew ? copy('ended.renewed.until', { n: plan.renewUntilEpoch ?? '—' }) : copy('ended.norenew')}
            </p>
            <p className="mkt-muted" data-copy="ended.note">{copy('ended.note', { value: fmtTrac(sumWei(plan.services.map((s) => s.value))) })}</p>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-new-period" data-copy="ended.fund" onClick={() => setFlow({ kind: 'fund', epoch: 'current' })}>{copy('ended.fund', { n: catalog.epoch })}</button>
            </div>
          </div>
        )}
        <Reconciliation catalog={catalog} epoch={catalog.epoch - 1} />
        {treasury}
      </div>
    );
  }

  // ── this epoch's subscription ──
  let flowNode: React.ReactNode = null;
  if (shown?.kind === 'top-up') {
    flowNode = <TopUp key={shown.serviceId} catalog={catalog} subscription={current} serviceId={shown.serviceId} onDone={close} onCancel={() => setFlow(null)} />;
  } else if (shown?.kind === 'plan') {
    flowNode = <FundFlow key="plan" catalog={catalog} funding={funding.data} initial={draftOf(catalog, plan, 'next')} fundsEpoch={false} onboarding={false} endsAt={endsAt} onDone={close} onCancel={() => setFlow(null)} onConfirmed={confirmed} />;
  } else if (shown?.kind === 'fund') {
    flowNode = fundFlow(shown, false);
  }
  const readErr = cat.err ?? subs.err;
  // A held top-up with no form on show for it, its own budget's or another's: the way back to it.
  const waitingTopUps = heldTopUps
    .filter((id) => !(shown?.kind === 'top-up' && shown.serviceId === id))
    .map((id) => <WaitingTopUp key={id} catalog={catalog} subscription={current} serviceId={id} onOpen={() => setFlow({ kind: 'top-up', serviceId: id })} />);
  return (
    <div className="mkt-frame" data-testid="mkt-plans" data-state="active"><PageHeader title="Plans" description="What this node pays for each epoch, and how much of it has landed" />
      {notices}
      {waitingTopUps}
      {flowNode}
      {readErr ? <ErrorCard err={readErr} onRetry={reloadAll} /> : null}
      {planErr}
      <Meters subscription={current} catalog={catalog} plan={plan} calls={activity.data?.calls ?? []} onTopUp={(serviceId) => setFlow({ kind: 'top-up', serviceId })} />
      <NextEpoch catalog={catalog} next={next} plan={plan} planUnknown={!mayEditPlan && !plan}
        onChange={mayEditPlan && plan ? () => setFlow({ kind: 'plan' }) : undefined} onFundNext={mayEditPlan ? () => setFlow({ kind: 'fund', epoch: 'next' }) : undefined} />
      <NotOnPlan catalog={catalog} current={current} onAdd={(serviceId) => setFlow({ kind: 'top-up', serviceId })} />
      <Reconciliation catalog={catalog} epoch={catalog.epoch} />
      <Activity catalog={catalog} calls={activity.data?.calls ?? null} err={activity.err} />
      {treasury}
    </div>
  );
}
