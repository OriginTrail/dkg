// Plans & meters. The purchase flow mounts here: as the never-subscribed
// empty state, as "Period ended → Start a new period", as every exhausted
// meter's "Top up", as the "Not on your plan yet" list's "Add to this period",
// and whenever there is an open purchase to resume. Fixture data in this step.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceData } from '../data.js';
import type { Allowance, Catalog, Offer, PlanStatus, PurchaseIntent, PurchaseLine } from '../types.js';
import { PurchaseFlow } from '../purchase/PurchaseFlow.js';
import { cheapestSeller, offerAvailable } from '../purchase/Composer.js';
import { SellerForm } from '../purchase/SellerForm.js';
import { ErrorCard, fmtClock, shortAddr, tracFromMicro } from '../purchase/shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';
import { DEFAULT_TRAC_USD } from '../format.js';

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase();

const fmtUnits = (n: number, unit: string) => {
  const s = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
  return `${s} ${unit === 'query-units' ? copy('play.units.query') : copy('play.units.tokens')}`;
};

const expiresIn = (expiresAt: string, now: number) => {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d} d`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
};

/** One pace sentence per meter, computed from the buyer's own numbers. */
function pace(m: Allowance, startedAt: string, expiresAt: string, now: number): { tone: 'warn' | 'quiet'; text: string } {
  const total = new Date(expiresAt).getTime() - new Date(startedAt).getTime();
  const elapsed = Math.max(1, now - new Date(startedAt).getTime());
  const used = m.guaranteedUnits === 0 ? 0 : m.consumedUnits / m.guaranteedUnits;
  const elapsedFrac = Math.min(1, elapsed / total);
  if (used > 0 && elapsedFrac > 0 && used / elapsedFrac > 1.15) {
    const projectedMs = elapsed / used;
    const shortDays = Math.max(1, Math.round((total - projectedMs) / 86_400_000));
    return { tone: 'warn', text: copy('meter.pace.warn', { d: shortDays }) };
  }
  return { tone: 'quiet', text: copy('meter.pace.ok') };
}

function Spark({ series }: { series: number[] }) {
  const max = Math.max(...series, 1);
  return (
    <span className="mkt-spark" aria-hidden>
      {series.map((v, i) => <i key={i} style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }} />)}
    </span>
  );
}

type FlowReq =
  | { kind: 'subscribe' }
  | { kind: 'new-period' }
  | { kind: 'topup'; planId: string; offeringId: string; seller: string; unit: string }
  | { kind: 'addon'; planId: string; offeringId: string; seller: string; unit: string; expiresAt: string };

export function PlansView(): React.ReactElement {
  const [st, setSt] = useState<PlanStatus | null>(null);
  const [err, setErr] = useState<unknown | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [flow, setFlow] = useState<FlowReq | null>(null);
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [sellerFormOpen, setSellerFormOpen] = useState(false);
  const [editDraft, setEditDraft] = useState(false);
  const inflight = useRef(false);
  const request = useMarketplaceDraftStore((s) => s.request);
  const consumeRequest = useMarketplaceDraftStore((s) => s.consumeRequest);
  const queued = useMarketplaceDraftStore((s) => s.queued);
  const removeQueued = useMarketplaceDraftStore((s) => s.removeQueued);
  const now = Date.now();

  const load = () => {
    if (inflight.current) return;
    inflight.current = true;
    marketplaceData.planStatus().then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(e)).finally(() => { inflight.current = false; });
  };
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { marketplaceData.catalog().then(setCat).catch(() => undefined); }, []);

  // one-shot requests from the Marketplace (Add to plan / Top up / Add to this period / Start a new period)
  useEffect(() => {
    if (!request || !st) return;
    if (request.kind === 'addon' && !cat) return;   // the seller's add-on capability lives on its shelf row: wait for the catalog
    const r = consumeRequest();
    if (!r) return;
    if (r.kind === 'topup') {
      const m = st.meters.find((x) => x.offeringId === r.offeringId && x.seller.toLowerCase() === r.seller.toLowerCase());
      if (m && m.enrollment !== 'blocked') setFlow({ kind: 'topup', planId: m.planId, offeringId: m.offeringId, seller: m.seller, unit: m.unit });
    } else if (r.kind === 'addon') {
      // a held offering or a seller without add-ons does nothing; the node would refuse E_ALREADY_ON_PLAN / E_SELLER_NO_ADDON
      const shelf = cat?.shelves.find((s) => s.seller.toLowerCase() === r.seller.toLowerCase());
      if (st.plan && shelf?.addOn === true && !st.meters.some((m) => m.offeringId === r.offeringId)) {
        const unit = shelf.offers.find((o) => o.offeringId === r.offeringId)?.ask?.unit ?? 'tokens';
        setFlow({ kind: 'addon', planId: st.plan.planId, offeringId: r.offeringId, seller: r.seller, unit, expiresAt: st.plan.expiresAt });
      }
    } else if (r.kind === 'new-period') {
      if (!st.plan) setFlow({ kind: 'new-period' });
    } else if (!st.plan) {
      setFlow({ kind: 'subscribe' });
    }
  }, [request, st, cat, consumeRequest]);

  const sparks = useMemo(() => {
    const out: Record<string, number[]> = {};
    if (!st?.plan) return out;
    const start = new Date(st.plan.startedAt).getTime();
    const span = Math.max(1, now - start);
    for (const m of st.meters) out[m.offeringId] = [0, 0, 0, 0, 0, 0, 0];
    for (const a of st.activity) {
      if (a.kind !== 'consumed' || !a.offeringId) continue;
      const idx = Math.min(6, Math.floor(((new Date(a.at).getTime() - start) / span) * 7));
      if (out[a.offeringId]) out[a.offeringId][Math.max(0, idx)] += a.units ?? 0;
    }
    return out;
  }, [st, now]);

  if (err && !st) {
    return (
      <div className="mkt-frame" data-testid="mkt-plans">
        <div className="mkt-card">
          <div data-copy="empty.error">{copy('empty.error')}</div>
          <ErrorCard err={err} onRetry={load} />
        </div>
      </div>
    );
  }
  if (!st) return <div className="mkt-frame" data-testid="mkt-plans"><div className="mkt-card mkt-muted" data-copy="plans.loading">{copy('plans.loading')}</div></div>;

  const fx = cat?.fx?.tracUsd ?? DEFAULT_TRAC_USD;
  const seatOk = !st.seat || (st.seat.configured && st.seat.rpc);
  const history = st.planHistory ?? { count: 0, last: null };
  const pending = st.pendingSwitches ?? [];
  const open: PurchaseIntent | null = st.openPurchase ?? null;
  const closeFlow = () => { setFlow(null); load(); };

  const seatCard = !seatOk ? (
    <div className="mkt-card mkt-seatcard" data-testid="mkt-seat-card">
      <h2 data-copy="plans.seat.title">{copy('plans.seat.title')}</h2>
      <p className="mkt-sec mkt-sm" data-copy="plans.seat.body">{copy('plans.seat.body')}</p>
      <ul className="mkt-xs mkt-sec">
        <li data-copy="plans.seat.item.config" className={st.seat && !st.seat.configured ? 'mkt-missing' : ''}>{copy('plans.seat.item.config')}</li>
        <li data-copy="plans.seat.item.rpc" className={st.seat && !st.seat.rpc ? 'mkt-missing' : ''}>{copy('plans.seat.item.rpc')}</li>
      </ul>
      {st.seat?.buyer && <div className="mkt-muted mkt-xs"><span data-copy="plans.seat.buyer">{copy('plans.seat.buyer')}</span>{' '}<span className="mkt-mono" data-copy="_data">{shortAddr(st.seat.buyer)}</span></div>}
      {sellerFormOpen
        ? <SellerForm onSaved={() => { load(); }} onCancel={() => setSellerFormOpen(false)} />
        : <div className="mkt-fork"><button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-add-seller" data-copy="seller.add" onClick={() => setSellerFormOpen(true)}>{copy('seller.add')}</button></div>}
    </div>
  ) : null;

  // A next-period DRAFT while the current period runs: shown as a queued draft, its terms locked until expiry
  const queuedDraft = st.plan && open && open.kind === 'new-period' && (open.state === 'draft' || open.state === 'terms_frozen') ? open : null;
  const queuedDraftCard = queuedDraft ? (
    <div className="mkt-card" data-testid="mkt-queued-draft">
      <h2 data-copy="plans.draft.title">{copy('plans.draft.title')}</h2>
      <p className="mkt-muted mkt-xs" data-copy="plans.draft.body">{copy('plans.draft.body')}</p>
      <ul className="mkt-xs">
        {queuedDraft.lines.map((l) => (
          <li key={`${l.offeringId}:${l.seller}`} data-copy="plans.draft.line">{copy('plans.draft.line', { offering: l.offeringId, seller: shortAddr(l.seller), amount: tracFromMicro(l.allocationMicroTrac) })}</li>
        ))}
      </ul>
      <div className="mkt-fork">
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-draft-open" data-copy="plans.draft.opens.after" disabled
          title={copy('plans.draft.opens.after', { t: fmtClock(st.plan!.expiresAt) })}>{copy('plans.draft.opens.after', { t: fmtClock(st.plan!.expiresAt) })}</button>
        <span className="mkt-muted mkt-xs" data-copy="plans.draft.opens.after">{copy('plans.draft.opens.after', { t: fmtClock(st.plan!.expiresAt) })}</span>
        <button type="button" className="mkt-btn" data-testid="mkt-draft-edit" data-copy="plans.draft.edit" aria-expanded={editDraft} onClick={() => setEditDraft((e) => !e)}>{copy('plans.draft.edit')}</button>
      </div>
      {editDraft && (
        <PurchaseFlow key={queuedDraft.id} kind="new-period" intent={queuedDraft} catalog={cat} fx={fx}
          termsLocked={{ untilIso: st.plan!.expiresAt }} onActivated={closeFlow} onClosed={() => { setEditDraft(false); load(); }} />
      )}
    </div>
  ) : null;

  const pendingChips = pending.length > 0 ? (
    <div className="mkt-fchips mkt-wrap" data-testid="mkt-pending-switches">
      {pending.map((sw) => (
        <span key={`${sw.offeringId}:${sw.toSeller}`} className="mkt-chipq" title={copy('plans.switch.boundary', { t: st.plan ? fmtClock(st.plan.expiresAt) : '—' })} data-copy="plans.switch.chip">
          {copy('plans.switch.chip', { offering: sw.offeringId, seller: shortAddr(sw.toSeller) })}
          <span className="mkt-muted" data-copy="plans.switch.boundary"> · {copy('plans.switch.boundary', { t: st.plan ? fmtClock(st.plan.expiresAt) : '—' })}</span>
        </span>
      ))}
    </div>
  ) : null;

  const queuedChips = queued.length > 0 ? (
    <div className="mkt-fchips mkt-wrap" data-testid="mkt-queued-lines">
      {queued.map((q) => (
        <span key={q.offeringId} className="mkt-chipq" data-copy="plans.queued.chip">
          {copy('plans.queued.chip', { offering: q.offeringId, seller: shortAddr(q.seller) })}
          <button type="button" className="mkt-linkbtn mkt-xs" data-copy="plans.queued.remove" onClick={() => removeQueued(q.offeringId)} title={copy('plans.queued.remove')}>{copy('plans.queued.remove')}</button>
        </span>
      ))}
    </div>
  ) : null;

  // ── a purchase in flight (resume) or one the operator just opened ──
  let flowNode: React.ReactNode = null;
  if (queuedDraft) {
    flowNode = queuedDraftCard;
  } else if (seatOk && open) {
    const m = open.topUp ? st.meters.find((x) => x.offeringId === open.topUp!.offeringId && x.seller.toLowerCase() === open.topUp!.seller.toLowerCase()) : null;
    // an open add-on has no meter yet — its unit comes from the catalog offer (fallback: the meter's, then tokens)
    const shelfUnit = open.kind === 'addon' && open.topUp
      ? cat?.shelves.find((s) => lc(s.seller) === lc(open.topUp!.seller))?.offers.find((o) => o.offeringId === open.topUp!.offeringId)?.ask?.unit : undefined;
    flowNode = (
      <PurchaseFlow key={open.id} kind={open.kind} intent={open} catalog={cat} fx={fx}
        topUp={open.topUp ? { planId: open.topUp.planId, offeringId: open.topUp.offeringId, seller: open.topUp.seller, unit: shelfUnit ?? m?.unit ?? 'tokens', expiresAt: open.frozen?.plan?.expiresAt ?? st.plan?.expiresAt } : null}
        onActivated={closeFlow} onClosed={closeFlow} />
    );
  } else if (seatOk && flow) {
    if (flow.kind === 'topup') {
      flowNode = <PurchaseFlow key={`topup:${flow.offeringId}`} kind="topup" topUp={flow} catalog={cat} fx={fx} onActivated={closeFlow} onClosed={closeFlow} />;
    } else if (flow.kind === 'addon') {
      flowNode = <PurchaseFlow key={`addon:${flow.offeringId}`} kind="addon" topUp={flow} catalog={cat} fx={fx} onActivated={closeFlow} onClosed={closeFlow} />;
    } else if (flow.kind === 'new-period') {
      const base: PurchaseLine[] = (history.last?.lines ?? []).map((l) => {
        const sw = pending.find((s) => s.offeringId === l.offeringId);
        return { offeringId: l.offeringId, seller: sw ? sw.toSeller : l.seller, allocationMicroTrac: l.allocationMicroTrac };
      });
      for (const q of queued) if (!base.some((b) => b.offeringId === q.offeringId)) base.push({ offeringId: q.offeringId, seller: q.seller, allocationMicroTrac: 0 });
      flowNode = (
        <PurchaseFlow key="new-period" kind="new-period" catalog={cat} fx={fx}
          prefill={{ lines: base, noteKey: 'plans.newperiod.prefill', noteVars: { switches: pending.length ? copy('plans.newperiod.switches') : '' } }}
          onActivated={closeFlow} onClosed={closeFlow} />
      );
    } else {
      flowNode = <PurchaseFlow key="subscribe" kind="subscribe" starter={queued.length === 0} catalog={cat} fx={fx} prefill={{ lines: queued }} onActivated={closeFlow} onClosed={closeFlow} />;
    }
  }

  // ── no active plan ──
  if (!st.plan) {
    if (flowNode) return <div className="mkt-frame" data-testid="mkt-plans" data-state="purchase">{seatCard}{flowNode}</div>;
    if (history.count > 0) {
      return (
        <div className="mkt-frame" data-testid="mkt-plans" data-state="period-ended">
          {seatCard}
          <div className="mkt-card">
            <h2 data-copy="meter.period.ended">{copy('meter.period.ended')}</h2>
            {history.last && <div className="mkt-muted mkt-xs" data-copy="plans.last.period">{copy('plans.last.period', { id: history.last.periodId, t: fmtClock(history.last.expiresAt) })}</div>}
            <p className="mkt-muted mkt-xs" data-copy="meter.expired.tip">{copy('meter.expired.tip')}</p>
            <p className="mkt-muted" data-copy="meter.newperiod.note">{copy('meter.newperiod.note')}</p>
            {pendingChips}{queuedChips}
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-new-period" data-copy="meter.newperiod" onClick={() => setFlow({ kind: 'new-period' })}
                disabled={!seatOk} title={!seatOk ? copy('plans.seat.title') : undefined}>{copy('meter.newperiod')}</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="mkt-frame" data-testid="mkt-plans" data-state="never-subscribed">
        {seatCard}
        {seatOk && <PurchaseFlow key="onboard" kind="subscribe" starter={queued.length === 0} catalog={cat} fx={fx} prefill={{ lines: queued }} onActivated={closeFlow} onClosed={closeFlow} />}
      </div>
    );
  }

  // ── active plan ──
  const plan = st.plan;
  const exp = expiresIn(plan.expiresAt, now);
  const activity = st.activity.filter((a) => a.kind === 'consumed' && (!keyFilter || a.keyId === keyFilter));
  const keys = [...new Set(st.activity.map((a) => a.keyId).filter(Boolean))] as string[];
  const fresh = st.freshness[0];
  const stmt = st.statements[st.statements.length - 1];

  // "Not on your plan yet": every purchasable offering the plan lacks whose cheapest available provider is
  // already on the plan AND advertises add-on lines (shelf `addOn: true`); a seller without add-ons never gets the control
  const addOnRows: Array<{ offeringId: string; seller: string; offer: Offer }> = [];
  if (cat) {
    for (const row of cat.shelves) for (const o of row.offers ?? []) {
      if (addOnRows.some((r) => r.offeringId === o.offeringId) || !offerAvailable(row, o) || st.meters.some((m) => m.offeringId === o.offeringId)) continue;
      const seller = cheapestSeller(cat, o.offeringId);
      const shelf = seller ? cat.shelves.find((s) => lc(s.seller) === lc(seller)) : null;
      if (!seller || !shelf || shelf.addOn !== true || !st.meters.some((m) => lc(m.seller) === lc(seller))) continue;
      const offer = shelf.offers.find((x) => x.offeringId === o.offeringId);
      if (offer?.ask) addOnRows.push({ offeringId: o.offeringId, seller, offer });
    }
  }

  return (
    <div className="mkt-frame" data-testid="mkt-plans" data-state="active">
      {seatCard}
      {flowNode}
      {err ? <ErrorCard err={err} onRetry={load} /> : null}
      <div className="mkt-card">
        <div className="mkt-planhead">
          <h1 data-copy="meter.summary">{copy('meter.summary', { pct: st.summaryPct ?? 0 })}</h1>
          <span className="mkt-sec" data-copy="meter.plan.resets">{exp ? copy('meter.plan.resets', { n: exp }).replace(' days', '') : ''}</span>
        </div>
        <p className="mkt-muted mkt-xs" data-copy="meter.summary.note">{copy('meter.summary.note')}</p>
        {pendingChips}{queuedChips}

        {st.meters.map((m) => {
          const pct = m.guaranteedUnits === 0 ? 0 : Math.round((m.consumedUnits / m.guaranteedUnits) * 100);
          const p = pace(m, plan.startedAt, plan.expiresAt, now);
          const others = st.meters.filter((x) => x.offeringId !== m.offeringId && x.state === 'active' && x.enrollment !== 'blocked');
          const blocked = m.enrollment === 'blocked';
          const pendingEnroll = m.enrollment === 'pending';
          return (
            <div key={`${m.offeringId}:${m.seller}`} className={`mkt-mrow${blocked ? ' blocked' : ''}`} data-testid={`mkt-meter-${m.offeringId}`} data-state={blocked ? 'blocked' : m.state}>
              <div className="mkt-mhead">
                <span data-copy="meter.offering.line">
                  <strong data-copy="_data">{m.offeringId}</strong>{' '}
                  <span className="mkt-muted mkt-xs" data-copy="_data">via {shortAddr(m.seller)}</span>
                  {' — '}{pct}% used{exp ? ` · ${copy('meter.plan.resets', { n: exp }).replace(' days', '')}` : ''}
                </span>
                {blocked
                  ? <span className="mkt-chipblock" data-copy="plans.meter.blocked">{copy('plans.meter.blocked')}</span>
                  : pendingEnroll
                    ? <span className="mkt-chipwarn" data-copy="plans.meter.pending">{copy('plans.meter.pending')}</span>
                    : <span className="mkt-mono mkt-sec" data-copy="chip.left">{copy('chip.left', { pct: Math.max(0, 100 - pct) })}</span>}
              </div>
              <div className={`mkt-bar${m.state === 'exhausted' ? ' hit' : pct >= 85 ? ' warn' : ''}`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
              <div className="mkt-muted mkt-xs" data-copy="meter.offering.tap">
                {fmtUnits(m.consumedUnits, m.unit)} of {fmtUnits(m.guaranteedUnits, m.unit)}
              </div>
              {blocked ? (
                <div className="mkt-xs mkt-errline" data-copy="plans.meter.blocked.body">
                  {copy('plans.meter.blocked.body', { seller: shortAddr(m.seller) })}
                  {m.enrollmentError ? <span className="mkt-mono mkt-muted" data-copy="_data"> · {m.enrollmentError}</span> : null}
                </div>
              ) : m.state === 'exhausted' ? (
                <div className="mkt-fork">
                  <div className="mkt-xs" data-copy="meter.hit.title">{copy('meter.hit.title')}</div>
                  <button type="button" className="mkt-btn mkt-btn--primary" data-testid={`mkt-topup-${m.offeringId}`} data-copy="fork.topup"
                    onClick={() => setFlow({ kind: 'topup', planId: m.planId, offeringId: m.offeringId, seller: m.seller, unit: m.unit })}
                    disabled={!seatOk || !!open} title={!seatOk ? copy('plans.seat.title') : open ? copy('purchase.resume.title') : undefined}>{copy('fork.topup')}</button>
                  <span className="mkt-sec mkt-sm" data-copy="fork.line.v2">
                    {others.length ? copy('fork.line.v2', { alt: others[0].offeringId, pct: Math.round((1 - others[0].consumedUnits / others[0].guaranteedUnits) * 100) }) : ''}
                  </span>
                </div>
              ) : (
                <div className="mkt-sparkrow">
                  <Spark series={sparks[m.offeringId] ?? []} />
                  <span className={`mkt-pace ${p.tone}`} data-copy={p.tone === 'warn' ? 'meter.pace.warn' : 'meter.pace.ok'}>{p.text}</span>
                </div>
              )}
            </div>
          );
        })}

        {cat && (
          <div data-testid="mkt-addon-list">
            <h3 data-copy="plans.addon.section">{copy('plans.addon.section')}</h3>
            <p className="mkt-muted mkt-xs" data-copy="plans.addon.section.note">{copy('plans.addon.section.note', { t: fmtClock(plan.expiresAt) })}</p>
            {addOnRows.length === 0 && <div className="mkt-muted mkt-xs" data-copy="plans.addon.none">{copy('plans.addon.none')}</div>}
            {addOnRows.map(({ offeringId, seller, offer }) => (
              <div key={offeringId} className="mkt-mhead mkt-prow" data-testid={`mkt-addon-row-${offeringId}`}>
                <span>
                  <strong data-copy="_data">{offeringId}</strong>{' '}
                  <span className="mkt-muted mkt-xs" data-copy="_data">via {shortAddr(seller)}</span>{' '}
                  <span className="mkt-mono mkt-sec" data-copy="catalog.price.micro">{copy('catalog.price.micro', { micro: offer.ask!.askMicroPerUnit, unit: offer.ask!.unit === 'query-units' ? 'unit' : 'tok' })}</span>{' '}
                  <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference">{copy('catalog.fx.reference', { usd: (offer.ask!.askMicroPerUnit * fx).toFixed(2) })}</span>
                </span>
                <button type="button" className="mkt-btn mkt-btn--primary" data-testid={`mkt-addon-${offeringId}`} data-copy="catalog.addon"
                  onClick={() => setFlow({ kind: 'addon', planId: plan.planId, offeringId, seller, unit: offer.ask!.unit, expiresAt: plan.expiresAt })}
                  disabled={!seatOk || !!open} title={!seatOk ? copy('plans.seat.title') : open ? copy('purchase.resume.title') : undefined}>{copy('catalog.addon')}</button>
              </div>
            ))}
          </div>
        )}

        {stmt ? (
          <div className="mkt-stmtline" data-copy={stmt.resolution === 'agreed' ? 'stmt.line.ok' : 'stmt.line.disputed'}>
            {copy(stmt.resolution === 'agreed' ? 'stmt.line.ok' : 'stmt.line.disputed', {
              ours: stmt.items.reduce((s, i) => s + i.buyerCount, 0).toLocaleString(),
              theirs: stmt.items.reduce((s, i) => s + i.sellerCount, 0).toLocaleString() })}
          </div>
        ) : fresh && fresh.agree ? (
          <div className="mkt-muted mkt-xs" data-copy="stmt.freshness">
            {copy('stmt.freshness', { t: fresh.checkedAgoMs != null ? `${Math.max(1, Math.round(fresh.checkedAgoMs / 60_000))} min` : '—' })}
          </div>
        ) : null}
      </div>

      <div className="mkt-card">
        <div className="mkt-mhead">
          <h2 data-copy="activity.title">{copy('activity.title')}</h2>
          <span className="mkt-fchips">
            <button type="button" className={keyFilter === null ? 'on' : ''} data-copy="activity.filter.all" onClick={() => setKeyFilter(null)}>{copy('activity.filter.all')}</button>
            {keys.map((k) => (
              <button type="button" key={k} className={keyFilter === k ? 'on' : ''} data-copy="_data" onClick={() => setKeyFilter(k)}>{k}</button>
            ))}
          </span>
        </div>
        <table className="mkt-act">
          <tbody>
            {activity.slice(0, 20).map((a, i) => (
              <tr key={i}>
                <td className="mkt-mono" data-copy="_data">{new Date(a.at).toTimeString().slice(0, 5)}</td>
                <td data-copy="_data">{a.offeringId}</td>
                <td className="mkt-muted" data-copy="_data">via {shortAddr(a.seller)}</td>
                <td data-copy="_data">{(a.units ?? 0).toLocaleString()} {a.phase === 'admission' || st.meters.find((m) => m.offeringId === a.offeringId)?.unit === 'query-units' ? copy('play.units.query') : copy('play.units.tokens')}</td>
                <td className="mkt-muted" data-copy="_data">{a.keyId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {activity.length === 0 && <div className="mkt-muted mkt-xs" data-copy="empty.activity">{copy('empty.activity')}</div>}
        <div className="mkt-muted mkt-xs" data-copy="activity.note">{copy('activity.note')}</div>
      </div>
    </div>
  );
}
