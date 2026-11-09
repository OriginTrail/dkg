// Plans: this epoch's subscription and the prefunded next one, the standing
// plan and its renewal, top-ups, the reconciliation of what this node holds
// against what landed, recent calls by key, and the funding behind it all.
// A node that never subscribed gets three steps: fund the buyer wallet or add
// it to an account, compose a plan, mint a key.
import React, { useEffect, useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceAbsent, isMarketplaceOff, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, Plan, Subscription } from '../api/types.js';
import { fmtMicro, fmtTrac, microOfWei, modelName, sumWei } from '../amounts.js';
import { ErrorCard, OffCard, refusalKey, relAt, sellerName, useLoad } from '../shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';
import { FundFlow } from '../purchase/FundFlow.js';
import { lineFor, type Draft } from '../purchase/Composer.js';
import { Meters } from '../purchase/Meters.js';
import { Activity, Reconciliation } from '../purchase/Ledger.js';
import { ProgressSteps } from '../purchase/ProgressSteps.js';
import { TopUp } from '../purchase/TopUp.js';
import { Treasury } from '../purchase/Treasury.js';

type Flow = { kind: 'fund'; epoch: 'current' | 'next'; serviceId?: string } | { kind: 'plan' } | { kind: 'top-up'; serviceId: string };

/** A draft from the plan, or a fresh one with `serviceId` picked. Each cap is the plan's to the wei, so an edit elsewhere saves it unchanged. */
function draftOf(catalog: CatalogAnswer, plan: Plan | null, epoch: 'current' | 'next', serviceId?: string): Draft {
  const lines = plan
    ? plan.services.map((s) => ({ serviceId: s.serviceId, valueTrac: s.valueTrac.replace(/\.0$/, ''), capMicro: microOfWei(s.maxPricePerUnit), pinned: s.pinnedSeller ?? null }))
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

function NextEpoch({ catalog, next, plan, onChange, onFundNext }: { catalog: CatalogAnswer; next: Subscription | null; plan: Plan | null; onChange: () => void; onFundNext: () => void }): React.ReactElement {
  const n = catalog.epoch + 1;
  const source = (s: { kind: string; accountId?: string }) => (s.kind === 'account' ? copy('source.account', { id: s.accountId ?? '' }) : copy('source.wallet'));
  return (
    <div className="mkt-card" data-testid="mkt-next-epoch" data-funded={!!next}>
      <div className="mkt-planhead">
        <h2 data-copy={next ? 'next.funded' : 'next.title'}>{copy(next ? 'next.funded' : 'next.title', { n })}</h2>
        {plan && <button type="button" className="mkt-btn" data-testid="mkt-change-plan" data-copy="next.change" onClick={onChange}>{copy('next.change')}</button>}
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
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-fund-next" data-copy="next.fund" onClick={onFundNext}>{copy('next.fund', { n })}</button>
        </div>
      )}
      <div className="mkt-muted mkt-xs" data-copy={plan?.renew ? 'plan.renews' : plan ? 'plan.once' : 'plan.none'}>
        {plan?.renew ? copy('plan.renews', { n: plan.renewUntilEpoch ?? '—', source: source(plan.source) }) : copy(plan ? 'plan.once' : 'plan.none')}
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
  const plan = planned.data;
  const reloadAll = () => { cat.reload(); subs.reload(); planned.reload(); funding.reload(); activity.reload(); };
  const close = () => { setFlow(null); reloadAll(); };

  // One-shot asks from Browse and the playground: compose with a service picked, or top it up.
  useEffect(() => {
    if (!ask || !catalog || !subs.data) return;
    const a = takeAsk();
    if (!a) return;
    if (current) setFlow(a.kind === 'top-up' || a.serviceId ? { kind: 'top-up', serviceId: a.serviceId ?? '' } : { kind: 'plan' });
    else setFlow({ kind: 'fund', epoch: 'current', ...(a.serviceId ? { serviceId: a.serviceId } : {}) });
  }, [ask, catalog, subs.data, current, takeAsk]);

  const loadErr = cat.err ?? subs.err ?? planned.err;
  if ([cat.err, subs.err, planned.err, funding.err].some(isMarketplaceOff)) return <div className="mkt-frame" data-testid="mkt-plans" data-state="off"><OffCard /></div>;
  if ([cat.err, subs.err, planned.err, funding.err].some(isMarketplaceAbsent)) return <div className="mkt-frame" data-testid="mkt-plans" data-state="absent"><OffCard absent /></div>;
  if (loadErr && !(catalog && subs.data)) {
    return (
      <div className="mkt-frame" data-testid="mkt-plans" data-state="error">
        <div className="mkt-card"><div data-copy="empty.error">{copy('empty.error')}</div><ErrorCard err={loadErr} onRetry={reloadAll} /></div>
      </div>
    );
  }
  if (!catalog || !subs.data || planned.loading && plan === null && !planned.err) {
    return <div className="mkt-frame" data-testid="mkt-plans" data-state="loading"><div className="mkt-card mkt-muted" data-copy="plans.loading">{copy('plans.loading')}</div></div>;
  }

  const endsAt = funding.data?.epochEndsAt ?? current?.endsAt ?? null;
  const treasury = funding.data ? <Treasury funding={funding.data} onChanged={funding.reload} /> : funding.err ? <ErrorCard err={funding.err} onRetry={funding.reload} /> : null;
  const fundFlow = (f: Extract<Flow, { kind: 'fund' }>, onboarding: boolean) => (
    <FundFlow key={`${f.epoch}:${f.serviceId ?? ''}`} catalog={catalog} funding={funding.data} initial={draftOf(catalog, plan, f.epoch, f.serviceId)}
      fundsEpoch onboarding={onboarding} endsAt={endsAt} onDone={close} onCancel={onboarding ? undefined : () => setFlow(null)} />
  );

  // ── no subscription this epoch ──
  if (!current) {
    if (!plan) {
      const w = funding.data?.buyerWallet;
      const funded = !!w && BigInt(w.trac) > 0n || (funding.data?.accounts ?? []).some((a) => a.serviceCapable && a.grant?.live);
      const f = flow?.kind === 'fund' ? flow : { kind: 'fund' as const, epoch: 'current' as const };
      return (
        <div className="mkt-frame" data-testid="mkt-plans" data-state="never-subscribed">
          <h1 className="mkt-h1" data-copy="onboard.p5.title">{copy('onboard.p5.title')}</h1>
          {!funded && <ProgressSteps step={1} />}
          {treasury}
          {funded && fundFlow(f, true)}
        </div>
      );
    }
    return (
      <div className="mkt-frame" data-testid="mkt-plans" data-state="period-ended">
        {flow?.kind === 'fund' ? fundFlow(flow, false) : (
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
  if (flow?.kind === 'top-up') {
    flowNode = <TopUp key={flow.serviceId} catalog={catalog} subscription={current} serviceId={flow.serviceId} onDone={close} onCancel={() => setFlow(null)} />;
  } else if (flow?.kind === 'plan') {
    flowNode = <FundFlow key="plan" catalog={catalog} funding={funding.data} initial={draftOf(catalog, plan, 'next')} fundsEpoch={false} onboarding={false} endsAt={endsAt} onDone={close} onCancel={() => setFlow(null)} />;
  } else if (flow?.kind === 'fund') {
    flowNode = fundFlow(flow, false);
  }
  return (
    <div className="mkt-frame" data-testid="mkt-plans" data-state="active">
      {flowNode}
      {loadErr ? <ErrorCard err={loadErr} onRetry={reloadAll} /> : null}
      <Meters subscription={current} catalog={catalog} plan={plan} calls={activity.data?.calls ?? []} onTopUp={(serviceId) => setFlow({ kind: 'top-up', serviceId })} />
      <NextEpoch catalog={catalog} next={next} plan={plan} onChange={() => setFlow({ kind: 'plan' })} onFundNext={() => setFlow({ kind: 'fund', epoch: 'next' })} />
      <NotOnPlan catalog={catalog} current={current} onAdd={(serviceId) => setFlow({ kind: 'top-up', serviceId })} />
      <Reconciliation catalog={catalog} epoch={catalog.epoch} />
      <Activity catalog={catalog} calls={activity.data?.calls ?? null} err={activity.err} />
      {treasury}
    </div>
  );
}
