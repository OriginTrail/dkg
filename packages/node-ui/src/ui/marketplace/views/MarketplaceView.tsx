// Marketplace: catalog · model page · playground. The catalog groups every
// configured provider's shelf by offering (row identity = the configured
// seller key; degraded rows say so and cannot be acted on); chips are the
// buyer's own meters; one provider per offering, chosen at plan time. The
// controls that would buy, switch or queue hand off to Plans or do nothing
// yet: this step is look-only and reads fixture data.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceData, noAction } from '../data.js';
import type { Allowance, Catalog, ForkOption, Offer, PendingSwitch, PurchaseIntent, ShelfRow } from '../types.js';
import { cheapestSeller, offerAvailable, unavailableReasonKey, SellerStatus } from '../purchase/Composer.js';
import { SellerForm } from '../purchase/SellerForm.js';
import { ErrorCard, shortAddr } from '../purchase/shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';
import { useTabsStore } from '../../stores/tabs.js';
import { DEFAULT_TRAC_USD } from '../format.js';
import { MARKETPLACE_TABS } from '../tabs.js';

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase();

function pctLeft(m?: Allowance): number | null {
  if (!m || m.guaranteedUnits === 0) return null;
  return Math.max(0, Math.round((1 - m.consumedUnits / m.guaranteedUnits) * 100));
}

const SPARQL_RE = /^\s*(PREFIX|SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i;

function usePlansNav() {
  const openTab = useTabsStore((s) => s.openTab);
  const setActiveTab = useTabsStore((s) => s.setActiveTab);
  return () => { openTab({ id: MARKETPLACE_TABS.plans.id, label: MARKETPLACE_TABS.plans.label, closable: true }); setActiveTab(MARKETPLACE_TABS.plans.id); };
}

// ── playground ──────────────────────────────────────────────────────────────

interface Msg { role: 'user' | 'assistant'; content: string; servedBy?: string; units?: number; isQuery?: boolean; error?: { code: string; detail: string | null } }
type Fork = { kind: 'noplan' } | { kind: 'ceiling'; offeringId: string; switch: ForkOption[]; addOn: boolean; addOnSeller: string | null };

export function Playground({ meters, hasPlan, catalog }: { meters: Allowance[]; hasPlan: boolean; catalog?: Catalog | null }): React.ReactElement {
  const models = meters.filter((m) => m.unit === 'tokens');
  const knowledge = meters.filter((m) => m.unit === 'query-units');
  const usable = (m: Allowance) => m.state === 'active' && m.enrollment !== 'blocked';
  const [mode, setMode] = useState<'chat' | 'query'>('chat');
  const [chatOffering, setChatOffering] = useState<string>(models.find(usable)?.offeringId ?? models[0]?.offeringId ?? '');
  const [queryOffering, setQueryOffering] = useState<string>(knowledge.find(usable)?.offeringId ?? knowledge[0]?.offeringId ?? '');
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [fork, setFork] = useState<Fork | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = useMarketplaceDraftStore();
  const goPlans = usePlansNav();

  useEffect(() => { if (!chatOffering && models[0]) setChatOffering(models.find(usable)?.offeringId ?? models[0].offeringId); }, [models.length]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!queryOffering && knowledge[0]) setQueryOffering(knowledge.find(usable)?.offeringId ?? knowledge[0].offeringId); }, [knowledge.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const selected = mode === 'chat' ? models.find((m) => m.offeringId === chatOffering) : knowledge.find((m) => m.offeringId === queryOffering);
  const list = mode === 'chat' ? models : knowledge;
  const looksSparql = SPARQL_RE.test(input);
  const suggestKey = mode === 'chat' && looksSparql && knowledge.length > 0 ? 'play.suggest.query' : mode === 'query' && input.trim() && !looksSparql && models.length > 0 ? 'play.suggest.chat' : null;
  const sendDisabledKey = !hasPlan ? 'play.noplan' : !selected ? 'play.no.offering' : selected.enrollment === 'blocked' ? 'plans.meter.blocked' : !input.trim() ? 'play.empty.input' : null;

  // Sending needs the node's gateway; in this step the control does nothing.
  const send = () => { if (sendDisabledKey || busy || !selected) return; noAction(input); };
  void setMsgs; void setBusy;

  const pickFork = (o: ForkOption) => {
    const m = meters.find((x) => x.offeringId === o.offeringId);
    if (!m) return;
    if (m.unit === 'tokens') { setMode('chat'); setChatOffering(m.offeringId); } else { setMode('query'); setQueryOffering(m.offeringId); }
    setFork(null);
  };
  // The provider for "Add to this period": the node's `addOnSeller` (already gated), else the catalog's cheapest
  // seller, which must itself advertise `addOn: true`; without one the button is disabled with the reason
  const addOnSeller = fork?.kind === 'ceiling' && fork.addOn ? fork.addOnSeller ?? (catalog ? cheapestSeller(catalog, fork.offeringId) : null) : null;
  const addOnCapable = !!addOnSeller && ((fork?.kind === 'ceiling' && !!fork.addOnSeller) || catalog?.shelves.find((s) => lc(s.seller) === lc(addOnSeller))?.addOn === true);
  const switchChips = fork?.kind === 'ceiling' ? (
    <>
      {fork.switch.length > 0 && <span className="mkt-sec mkt-sm" data-copy="play.fork.switch">{copy('play.fork.switch')}</span>}
      {fork.switch.map((o) => (
        <button type="button" key={o.offeringId} className="mkt-chipbtn" data-copy="play.remaining" data-testid={`mkt-fork-switch-${o.offeringId}`} onClick={() => pickFork(o)}>
          {copy('play.remaining', { model: o.offeringId, pct: o.pctLeft })}
        </button>
      ))}
    </>
  ) : null;

  if (!hasPlan || meters.length === 0) {
    return (
      <div className="mkt-card" data-testid="mkt-playground" data-state="no-plan">
        <div data-copy="play.noplan">{copy('play.noplan')}</div>
        <div className="mkt-fork">
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-play-newperiod" data-copy="play.noplan.cta" onClick={() => { draft.requestNewPeriod(); goPlans(); }}>{copy('play.noplan.cta')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mkt-card" data-testid="mkt-playground" data-mode={mode}>
      <div className="mkt-mhead">
        <span className="mkt-fchips mkt-modes" role="radiogroup" aria-label={copy('play.mode.label')}>
          <button type="button" role="radio" aria-checked={mode === 'chat'} className={mode === 'chat' ? 'on' : ''} data-testid="mkt-mode-chat" data-copy="play.mode.chat" onClick={() => { setMode('chat'); setFork(null); }}>{copy('play.mode.chat')}</button>
          <button type="button" role="radio" aria-checked={mode === 'query'} className={mode === 'query' ? 'on' : ''} data-testid="mkt-mode-query" data-copy="play.mode.query" onClick={() => { setMode('query'); setFork(null); }}>{copy('play.mode.query')}</button>
        </span>
        <span className="mkt-muted mkt-xs" data-copy="play.offering">{copy('play.offering')}</span>
      </div>
      <div className="mkt-fchips mkt-wrap" role="radiogroup" aria-label={copy('play.offering')} data-testid="mkt-offering-chips">
        {list.length === 0 && <span className="mkt-muted mkt-xs" data-copy="play.no.offering">{copy('play.no.offering', { mode: copy(mode === 'chat' ? 'play.mode.chat' : 'play.mode.query') })}</span>}
        {list.map((m) => {
          const on = selected?.offeringId === m.offeringId;
          const blocked = m.enrollment === 'blocked';
          return (
            <button type="button" key={m.offeringId} role="radio" aria-checked={on} className={on ? 'on' : ''} data-copy="chip.left" data-testid={`mkt-chip-${m.offeringId}`}
              disabled={blocked} title={blocked ? copy('plans.meter.blocked') : undefined}
              onClick={() => (mode === 'chat' ? setChatOffering(m.offeringId) : setQueryOffering(m.offeringId))}>
              {blocked ? `${m.offeringId} · ${copy('plans.meter.blocked')}` : copy('play.remaining', { model: m.offeringId, pct: pctLeft(m) ?? 0 })}
            </button>
          );
        })}
      </div>
      <div className="mkt-chat">
        {msgs.length === 0 && <div className="mkt-muted mkt-xs" data-copy={mode === 'chat' ? 'play.empty.chat' : 'play.empty.query'}>{copy(mode === 'chat' ? 'play.empty.chat' : 'play.empty.query')}</div>}
        {msgs.map((m, i) => (
          <div key={i}>
            {m.error ? (
              <div className="mkt-bubble assistant error" role="alert" data-testid="mkt-error-bubble" data-code={m.error.code}>
                <span data-copy="play.error.bubble">{copy('play.error.bubble', { code: m.error.code })}</span>
                {m.error.detail ? <span className="mkt-muted mkt-xs mkt-mono" data-copy="_data"> · {m.error.detail}</span> : null}
              </div>
            ) : (
              <>
                <div className={`mkt-bubble ${m.role}`} data-copy="_data">{m.content}</div>
                {m.role === 'assistant' && (
                  <div className="mkt-muted mkt-xs" data-copy="play.servedby">
                    {copy('play.servedby', { seller: shortAddr(m.servedBy), prov: '' })} · {m.units?.toLocaleString() ?? 0} {m.isQuery ? copy('play.units.query') : copy('play.units.tokens')}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {fork?.kind === 'noplan' && (
          <div className="mkt-forkinline" data-testid="mkt-fork-noplan">
            <strong data-copy="play.fork.noplan">{copy('play.fork.noplan')}</strong>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-copy="play.fork.newperiod" onClick={() => { draft.requestNewPeriod(); goPlans(); }}>{copy('play.fork.newperiod')}</button>
            </div>
          </div>
        )}
        {fork?.kind === 'ceiling' && fork.addOn && (
          <div className="mkt-forkinline" data-testid="mkt-fork-ceiling">
            <strong data-copy="play.fork.addon">{copy('play.fork.addon')}</strong>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-fork-addon" data-copy="fork.addon"
                disabled={!addOnCapable} title={!addOnCapable ? copy('catalog.unavailable.noask') : undefined}
                onClick={() => { if (addOnSeller) { draft.requestAddOn(fork.offeringId, addOnSeller); goPlans(); } }}>{copy('fork.addon')}</button>
              {switchChips}
            </div>
          </div>
        )}
        {fork?.kind === 'ceiling' && !fork.addOn && (
          <div className="mkt-forkinline" data-testid="mkt-fork-ceiling">
            <strong data-copy="play.fork.inline">{copy('play.fork.inline')}</strong>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-fork-topup" data-copy="fork.topup"
                onClick={() => { const m = meters.find((x) => x.offeringId === fork.offeringId); if (m) draft.requestTopUp(m.offeringId, m.seller); goPlans(); }}>{copy('fork.topup')}</button>
              {switchChips}
            </div>
          </div>
        )}
      </div>
      {suggestKey && (
        <div className="mkt-notice mkt-xs" role="status" data-testid="mkt-mode-suggest">
          <span data-copy={suggestKey}>{copy(suggestKey)}</span>{' '}
          <button type="button" className="mkt-linkbtn" data-copy="play.suggest.switch" onClick={() => setMode(mode === 'chat' ? 'query' : 'chat')}>{copy('play.suggest.switch')}</button>
        </div>
      )}
      <div className="mkt-inputrow">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} data-testid="mkt-play-input"
          aria-label={copy(mode === 'chat' ? 'play.composer' : 'play.input.query')} placeholder={copy(mode === 'chat' ? 'play.composer' : 'play.input.query')} />
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-play-send" data-copy="ctl.send" disabled={busy || !!sendDisabledKey}
          title={sendDisabledKey ? copy(sendDisabledKey, { mode: copy(mode === 'chat' ? 'play.mode.chat' : 'play.mode.query') }) : undefined} onClick={send}>
          {busy ? copy('state.working') : copy('ctl.send')}
        </button>
      </div>
      {sendDisabledKey && sendDisabledKey !== 'play.empty.input' && <span className="mkt-muted mkt-xs" data-copy={sendDisabledKey}>{copy(sendDisabledKey, { mode: copy(mode === 'chat' ? 'play.mode.chat' : 'play.mode.query') })}</span>}
    </div>
  );
}

// ── catalog + model page ────────────────────────────────────────────────────

interface Row { row: ShelfRow; offer: Offer }

export function MarketplaceView(): React.ReactElement {
  const [tab, setTab] = useState<'models' | 'playground'>('models');
  const [cat, setCat] = useState<Catalog | null>(null);
  const [err, setErr] = useState<unknown | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingSwitch[]>([]);
  const [switching, setSwitching] = useState<{ offeringId: string; toSeller: string } | null>(null);
  const [switchErr, setSwitchErr] = useState<unknown | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [nextDraft, setNextDraft] = useState<PurchaseIntent | null>(null);
  const [queueErr, setQueueErr] = useState<unknown | null>(null);
  const [queueBusy, setQueueBusy] = useState<string | null>(null);
  const [sellerFormOpen, setSellerFormOpen] = useState(false);
  const inflight = useRef(false);
  const addToPlan = useMarketplaceDraftStore((s) => s.addToPlan);
  const requestAddOn = useMarketplaceDraftStore((s) => s.requestAddOn);
  const goPlans = usePlansNav();

  // "Add to this period": hand the (offering, provider) to Plans, which opens the add-on form (kind addon)
  const addNow = (offeringId: string, seller: string) => { requestAddOn(offeringId, seller); goPlans(); };

  // "Add to plan" with no plan hands the line to Plans; while a period runs it
  // would queue the line for the next period, which needs the node (no-op here).
  const queuedOfferings = new Set((nextDraft?.lines ?? []).map((l) => l.offeringId));
  const addLine = (offeringId: string, seller: string) => {
    if (!cat?.plan) { addToPlan({ offeringId, seller }); goPlans(); return; }
    noAction(offeringId, seller);
  };
  void setQueueErr; void setQueueBusy;

  const load = () => {
    if (inflight.current) return;
    inflight.current = true;
    marketplaceData.catalog().then((c) => { setCat(c); setErr(null); }).catch((e) => setErr(e)).finally(() => { inflight.current = false; });
  };
  const loadPending = () => marketplaceData.planStatus().then((s) => {
    setPending((prev) => { const server = s.pendingSwitches ?? []; return [...server, ...prev.filter((p) => !server.some((x) => x.offeringId === p.offeringId))]; });
    if (s.plan) marketplaceData.nextPeriodDraft().then(setNextDraft).catch(() => undefined);
  }).catch(() => undefined);
  const retry = () => { setRefreshing(false); noAction(); };
  useEffect(() => { load(); void loadPending(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const byModel = useMemo(() => {
    const out = new Map<string, Row[]>();
    for (const sh of cat?.shelves ?? []) for (const o of sh.offers ?? []) {
      if (!out.has(o.offeringId)) out.set(o.offeringId, []);
      out.get(o.offeringId)!.push({ row: sh, offer: o });
    }
    return out;
  }, [cat]);

  const fx = cat?.fx?.tracUsd ?? DEFAULT_TRAC_USD;
  const meterFor = (offeringId: string) => cat?.meters.find((m) => m.offeringId === offeringId);
  // The add-on control needs a provider already on the plan whose shelf advertises `addOn: true`, never inferred
  const onPlan = (seller: string) => (cat?.meters ?? []).some((m) => lc(m.seller) === lc(seller));
  const servesAddOn = (row: ShelfRow) => row.addOn === true;
  const priceLine = (o: Offer) => o.ask ? (
    <>
      <span className="mkt-mono mkt-sec" data-copy="catalog.price.micro">{copy('catalog.price.micro', { micro: o.ask.askMicroPerUnit, unit: o.ask.unit === 'query-units' ? 'unit' : 'tok' })}</span>{' '}
      <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference">{copy('catalog.fx.reference', { usd: (o.ask.askMicroPerUnit * fx).toFixed(2) })}</span>
    </>
  ) : <span className="mkt-muted mkt-xs" data-copy="catalog.unavailable.noask">{copy('catalog.unavailable.noask')}</span>;

  const sellerStrip = cat ? (
    <div className="mkt-card mkt-sellerstrip" data-testid="mkt-seller-strip">
      <div className="mkt-mhead">
        <span className="mkt-fchips mkt-wrap">
          {cat.shelves.length === 0 && <span className="mkt-muted mkt-xs" data-copy="catalog.empty.sellers">{copy('catalog.empty.sellers')}</span>}
          {cat.shelves.map((row) => (
            <span key={row.seller} className={`mkt-sellerchip${row.identityMismatch ? ' blocked' : ''}`} data-testid={`mkt-seller-${row.seller.toLowerCase()}`} data-state={row.identityMismatch ? 'mismatch' : row.source === 'cache' ? 'cache' : row.ok ? 'ok' : 'unreachable'}>
              <span className="mkt-mono" title={row.seller} data-copy="_data">{shortAddr(row.seller)}</span>{' '}<SellerStatus row={row} />
            </span>
          ))}
        </span>
        <span className="mkt-fork">
          <button type="button" className="mkt-linkbtn mkt-xs" data-testid="mkt-add-seller" data-copy="seller.add" aria-expanded={sellerFormOpen} onClick={() => setSellerFormOpen((o) => !o)}>{copy('seller.add')}</button>
          <button type="button" className="mkt-btn" data-testid="mkt-catalog-retry" data-copy="catalog.retry" onClick={retry} disabled={refreshing} title={refreshing ? copy('catalog.refreshing') : undefined}>
            {refreshing ? copy('catalog.refreshing') : copy('catalog.retry')}
          </button>
        </span>
      </div>
      {sellerFormOpen && <SellerForm onSaved={() => { retry(); }} onCancel={() => setSellerFormOpen(false)} />}
      {queueErr ? <ErrorCard err={queueErr}><span className="mkt-muted mkt-xs" data-copy="catalog.queue.error">{copy('catalog.queue.error')}</span></ErrorCard> : null}
      {cat.shelves.some((r) => r.source === 'cache') && <div className="mkt-muted mkt-xs" data-copy="catalog.stale.note">{copy('catalog.stale.note')}</div>}
      {cat.shelves.some((r) => r.identityMismatch) && <div className="mkt-xs mkt-errline" data-copy="catalog.identity.mismatch.row">{copy('catalog.identity.mismatch.row', { sellers: cat.shelves.filter((r) => r.identityMismatch).map((r) => `${shortAddr(r.seller)} ≠ ${shortAddr(r.sellerClaimed)}`).join(' · ') })}</div>}
    </div>
  ) : null;

  if (err && !cat) {
    return (
      <div className="mkt-frame" data-testid="mkt-marketplace" data-state="error">
        <div className="mkt-card">
          <div data-copy="catalog.error">{copy('catalog.error')}</div>
          <ErrorCard err={err} onRetry={load} retryKey="catalog.retry" />
        </div>
      </div>
    );
  }
  if (!cat) return <div className="mkt-frame" data-testid="mkt-marketplace" data-state="loading"><div className="mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></div>;

  const doSwitch = () => { if (switching) noAction(switching); };
  void setSwitchErr; void setSwitchBusy;

  if (selected) {
    const rows = byModel.get(selected) ?? [];
    const m = meterFor(selected);
    const pendingFor = pending.find((p) => p.offeringId === selected) ?? null;
    return (
      <div className="mkt-frame" data-testid="mkt-model-page" data-offering={selected}>
        <div className="mkt-card">
          <button type="button" className="mkt-linkbtn mkt-xs" data-copy="catalog.back" onClick={() => setSelected(null)}>{copy('catalog.back')}</button>
          <h1 className="mkt-h1" data-copy="_data">{rows[0]?.offer.modelId ?? selected}{' '}
            {m && <span className="mkt-chipleft" data-copy="chip.left">{copy('chip.left', { pct: pctLeft(m) ?? 0 })}</span>}</h1>
          {rows[0]?.offer.weightsDigest && <p className="mkt-muted mkt-xs mkt-mono" data-copy="model.weights">{copy('model.weights', { digest: `${rows[0].offer.weightsDigest.slice(0, 22)}…` })}</p>}
          {rows.length === 0 && <div className="mkt-muted" data-copy="catalog.unavailable.generic">{copy('catalog.unavailable.generic')}</div>}
          {pendingFor && <div className="mkt-chipq" data-testid="mkt-switch-pending" data-copy="model.switch.pending">{copy('model.switch.pending', { seller: shortAddr(pendingFor.toSeller) })}</div>}
          {rows.map(({ row, offer }) => {
            const avail = offerAvailable(row, offer);
            const reasonKey = avail ? null : unavailableReasonKey(row, offer);
            const mine = !!m && m.seller.toLowerCase() === row.seller.toLowerCase();
            const pendingHere = !!pendingFor && pendingFor.toSeller.toLowerCase() === row.seller.toLowerCase();
            return (
              <div key={row.seller} className={`mkt-mhead mkt-prow${avail ? '' : ' off'}`} data-testid={`mkt-provider-${row.seller.toLowerCase()}`} data-available={avail}>
                <span>
                  <strong className="mkt-mono" title={row.seller} data-copy="_data">{shortAddr(row.seller)}</strong>{' '}<SellerStatus row={row} />{' '}
                  {priceLine(offer)}
                  {offer.queuedAsk && <span className="mkt-muted mkt-xs" data-copy="model.next.cycle"> · {copy('model.next.cycle', { ask: offer.queuedAsk.askMicroPerUnit })}</span>}
                  {reasonKey && <span className="mkt-muted mkt-xs" data-copy={reasonKey}> · {copy('catalog.unavailable', { reason: copy(reasonKey) })}</span>}
                </span>
                {mine ? (
                  <span className="mkt-yours" data-copy="model.provider.yours">{copy('model.provider.yours')}</span>
                ) : m ? (
                  <button type="button" className="mkt-chipadd" data-testid={`mkt-switch-${row.seller.toLowerCase()}`} data-copy="model.provider.switch"
                    disabled={!avail || pendingHere} title={!avail ? copy(reasonKey!) : pendingHere ? copy('model.switch.pending', { seller: shortAddr(row.seller) }) : undefined}
                    onClick={() => { setSwitchErr(null); setSwitching({ offeringId: selected, toSeller: row.seller }); }}>{copy('model.provider.switch')}</button>
                ) : cat.plan && onPlan(row.seller) && servesAddOn(row) ? (
                  <span className="mkt-fork">
                    <button type="button" className="mkt-chipadd" data-testid={`mkt-addon-${lc(row.seller)}`} data-copy="catalog.addon"
                      disabled={!avail} title={!avail ? copy(reasonKey!) : undefined} onClick={() => addNow(selected, row.seller)}>{copy('catalog.addon')}</button>
                    {queuedOfferings.has(selected) && lc(nextDraft?.lines.find((l) => l.offeringId === selected)?.seller) === lc(row.seller)
                      ? <span className="mkt-chipq" data-testid="mkt-queued-next" data-copy="catalog.queued.next">{copy('catalog.queued.next')}</span>
                      : <button type="button" className="mkt-linkbtn mkt-xs" data-testid={`mkt-queue-${lc(row.seller)}`} data-copy="catalog.queue.next"
                          disabled={!avail || queueBusy === selected} title={!avail ? copy(reasonKey!) : queueBusy === selected ? copy('state.working') : undefined}
                          onClick={() => { void addLine(selected, row.seller); }}>{queueBusy === selected ? copy('state.working') : copy('catalog.queue.next')}</button>}
                  </span>
                ) : (
                  queuedOfferings.has(selected) && lc(nextDraft?.lines.find((l) => l.offeringId === selected)?.seller) === lc(row.seller)
                    ? <span className="mkt-chipq" data-testid="mkt-queued-next" data-copy="catalog.queued.next">{copy('catalog.queued.next')}</span>
                    : <button type="button" className="mkt-chipadd" data-testid={`mkt-add-${row.seller.toLowerCase()}`} data-copy="catalog.add"
                        disabled={!avail || queueBusy === selected} title={!avail ? copy(reasonKey!) : undefined}
                        onClick={() => { void addLine(selected, row.seller); }}>{queueBusy === selected ? copy('state.working') : copy('catalog.add')}</button>
                )}
              </div>
            );
          })}
          <p className="mkt-muted mkt-xs" data-copy="model.provider.note">{copy('model.provider.note')}</p>
        </div>
        {switching && (
          <div className="mkt-card mkt-dialog" role="dialog" aria-modal="true" aria-label={copy('model.provider.switch')} data-testid="mkt-switch-dialog">
            <div data-copy="model.switch.confirm">{copy('model.switch.confirm', { offering: switching.offeringId, seller: shortAddr(switching.toSeller) })}</div>
            {switchErr ? <ErrorCard err={switchErr} onRetry={doSwitch} /> : null}
            <div className="mkt-fork">
              <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={() => setSwitching(null)} disabled={switchBusy}>{copy('gate.cancel')}</button>
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-switch-confirm" data-copy="gate.confirm" onClick={doSwitch} disabled={switchBusy}>{switchBusy ? copy('state.working') : copy('gate.confirm')}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  const offerings = [...byModel.entries()];
  return (
    <div className="mkt-frame" data-testid="mkt-marketplace" data-state="ok">
      <div className="mkt-fchips mkt-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'models'} className={tab === 'models' ? 'on' : ''} data-copy="nav.models" onClick={() => setTab('models')}>{copy('nav.models')}</button>
        <button type="button" role="tab" aria-selected={tab === 'playground'} className={tab === 'playground' ? 'on' : ''} data-copy="nav.playground" onClick={() => setTab('playground')}>{copy('nav.playground')}</button>
      </div>
      {tab === 'playground' ? <Playground meters={cat.meters} hasPlan={!!cat.plan} catalog={cat} /> : (
        <>
          {sellerStrip}
          {err ? <ErrorCard err={err} onRetry={load} retryKey="catalog.retry" /> : null}
          {offerings.length === 0 && (
            <div className="mkt-card mkt-muted" data-testid="mkt-catalog-empty">
              <span data-copy={cat.shelves.length === 0 ? 'catalog.empty.sellers' : 'catalog.empty.offers'}>{copy(cat.shelves.length === 0 ? 'catalog.empty.sellers' : 'catalog.empty.offers')}</span>
            </div>
          )}
          <div className="mkt-grid">
            {offerings.map(([offeringId, rows]) => {
              const m = meterFor(offeringId);
              const left = pctLeft(m);
              const first = rows[0].offer;
              const isQuery = first.ask?.unit === 'query-units';
              const availRows = rows.filter((r) => offerAvailable(r.row, r.offer));
              const cheapest = availRows.reduce<Row | null>((b, r) => (!b || (r.offer.ask!.askMicroPerUnit < b.offer.ask!.askMicroPerUnit) ? r : b), null);
              const reasonKey = availRows.length ? null : unavailableReasonKey(rows[0].row, rows[0].offer);
              const open = () => setSelected(offeringId);
              return (
                <div key={offeringId} className={`mkt-card mkt-mcard${availRows.length ? '' : ' off'}`} role="button" tabIndex={0} data-testid={`mkt-card-${offeringId}`} data-available={availRows.length > 0}
                  onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
                  <h3 data-copy="_data">{first.modelId}</h3>
                  <div className="mkt-mhead">
                    <span className="mkt-sec mkt-sm" data-copy="catalog.via">
                      {copy(isQuery ? 'catalog.cardtype.query' : 'catalog.cardtype.text')} · {copy('catalog.via', { sellers: rows.map((r) => shortAddr(r.row.seller)).join(' · ') })}
                    </span>
                    <span className="mkt-sm mkt-prov" data-copy={first.provenanceClass === 'weights-pinned' ? 'prov.pinned' : isQuery ? 'catalog.query.plain' : 'prov.claimed'}>
                      {first.provenanceClass === 'weights-pinned' ? `⛓ ${copy('prov.pinned')}` : isQuery ? copy('catalog.query.plain') : `☁ ${copy('prov.claimed')}`}
                    </span>
                  </div>
                  <div className="mkt-mhead">
                    <span>{cheapest ? priceLine(cheapest.offer) : priceLine(first)}</span>
                    {left != null
                      ? <span className="mkt-chipleft" data-copy="chip.left">{copy('chip.left', { pct: left })}</span>
                      : cat.plan && cheapest && onPlan(cheapest.row.seller) && servesAddOn(cheapest.row)
                        ? (
                        <span className="mkt-fork">
                          <button type="button" className="mkt-chipadd" data-testid={`mkt-addon-${offeringId}`} data-copy="catalog.addon"
                            onClick={(e) => { e.stopPropagation(); addNow(offeringId, cheapest.row.seller); }}>{copy('catalog.addon')}</button>
                          {queuedOfferings.has(offeringId)
                            ? <span className="mkt-chipq" data-testid={`mkt-queued-${offeringId}`} data-copy="catalog.queued.next">{copy('catalog.queued.next')}</span>
                            : <button type="button" className="mkt-linkbtn mkt-xs" data-testid={`mkt-queue-${offeringId}`} data-copy="catalog.queue.next"
                                disabled={queueBusy === offeringId} title={queueBusy === offeringId ? copy('state.working') : undefined}
                                onClick={(e) => { e.stopPropagation(); void addLine(offeringId, cheapest.row.seller); }}>{queueBusy === offeringId ? copy('state.working') : copy('catalog.queue.next')}</button>}
                        </span>
                      )
                      : queuedOfferings.has(offeringId)
                        ? <span className="mkt-chipq" data-testid={`mkt-queued-${offeringId}`} data-copy="catalog.queued.next">{copy('catalog.queued.next')}</span>
                        : (
                        <button type="button" className="mkt-chipadd" data-testid={`mkt-add-${offeringId}`} data-copy="catalog.add" disabled={!cheapest || queueBusy === offeringId} title={reasonKey ? copy(reasonKey) : undefined}
                          onClick={(e) => { e.stopPropagation(); if (cheapest) void addLine(offeringId, cheapest.row.seller); }}>{queueBusy === offeringId ? copy('state.working') : copy('catalog.add')}</button>
                      )}
                  </div>
                  {reasonKey && <div className="mkt-muted mkt-xs" data-copy={reasonKey}>{copy('catalog.unavailable', { reason: copy(reasonKey) })}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
