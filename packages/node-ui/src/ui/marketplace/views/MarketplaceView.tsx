// Marketplace: the catalog, a service's page with a row per seller, a
// seller's storefront, and the playground. Everything comes from the node's
// catalog routes: this epoch's offers from sellers in the sharding table,
// and what this epoch's subscription has left for each service it funds.
// "Add to plan" hands the service to Plans.
import React, { useMemo, useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceAbsent, isMarketplaceOff, marketplaceApi } from '../api/client.js';
import type { CatalogAnswer, Fx, Offer, Service, Storefront } from '../api/types.js';
import { fmtMicro, fmtTrac, modelName, usdPerMillion } from '../amounts.js';
import { ErrorCard, OffCard, sellerName, useLoad, useMarketplaceNav } from '../shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';
import { Playground } from './Playground.js';

/** `0.6 µTRAC/tok` and, with a reference rate, `~$0.17/1M · reference rate`. */
export function PriceLine({ min, max, fx }: { min: string; max?: string; fx: Fx }): React.ReactElement {
  const lo = fmtMicro(min);
  const hi = max !== undefined ? fmtMicro(max) : lo;
  const usdLo = usdPerMillion(min, fx.tracUsd);
  const usdHi = max !== undefined ? usdPerMillion(max, fx.tracUsd) : usdLo;
  return (
    <>
      <span className="mkt-mono mkt-sec" data-copy="catalog.price.micro">{copy('catalog.price.micro', { micro: lo === hi ? lo : `${lo}–${hi}`, unit: 'tok' })}</span>
      {usdLo !== null && <>{' '}<span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference">{copy('catalog.fx.reference', { usd: usdLo === usdHi ? usdLo : `${usdLo}–${usdHi}` })}</span></>}
    </>
  );
}

/** A seller's availability as this node last saw it. */
export function SellerChip({ available }: { available: boolean | null }): React.ReactElement {
  if (available === true) return <span className="ds-badge ds-tone-success" data-copy="catalog.online">{copy('catalog.online')}</span>;
  if (available === false) return <span className="ds-badge ds-tone-danger" data-copy="catalog.unavailable.seller">{copy('catalog.unavailable.seller')}</span>;
  return <span className="ds-badge ds-tone-warning" data-copy="catalog.unquoted">{copy('catalog.unquoted')}</span>;
}

export function ProvBadge({ offers }: { offers: Offer[] }): React.ReactElement {
  const pinned = offers.length > 0 && offers.every((o) => o.provenance === 'weights-pinned');
  return (
    <span className="mkt-sm mkt-prov" data-copy={pinned ? 'prov.pinned' : 'prov.claimed'} title={copy(pinned ? 'prov.pinned.tip' : 'prov.claimed.tip')}>
      {pinned ? `⛓ ${copy('prov.pinned')}` : `☁ ${copy('prov.claimed')}`}
    </span>
  );
}

const sellersOf = (offers: Offer[]): number[] => [...new Set(offers.map((o) => o.seller))];

/** The next epoch's price, where it differs from this one's: every offer names one, the same when the price stays. */
function NextPrice({ offer }: { offer: Offer }): React.ReactElement | null {
  const next = offer.nextPricePerUnit;
  if (!next || next === offer.pricePerUnit) return null;
  return <span className="mkt-muted mkt-xs" data-copy="model.next.epoch"> · {copy('model.next.epoch', { price: fmtMicro(next) })}</span>;
}

function useAddToPlan(): (serviceId: string) => void {
  const askPlans = useMarketplaceDraftStore((s) => s.askPlans);
  const go = useMarketplaceNav();
  return (serviceId) => { askPlans({ kind: 'compose', serviceId }); go('plans'); };
}

// ── a seller's storefront ───────────────────────────────────────────────────

function StorefrontPage({ identityId, catalog, onBack }: { identityId: number; catalog: CatalogAnswer; onBack: () => void }): React.ReactElement {
  const s = useLoad(() => marketplaceApi.seller(identityId));
  const label = (serviceId: string) => modelName(catalog.services.find((x) => x.serviceId === serviceId)?.label ?? serviceId);
  return (
    <div className="mkt-frame" data-testid="mkt-storefront" data-seller={identityId}>
      <div className="ds-card mkt-card">
        <button type="button" className="mkt-linkbtn mkt-xs" data-copy="catalog.back" onClick={onBack}>{copy('catalog.back')}</button>
        {s.err && !s.data ? <ErrorCard err={s.err} onRetry={s.reload} /> : null}
        {!s.data && !s.err && <div className="mkt-muted" data-copy="state.loading">{copy('state.loading')}</div>}
        {s.data && <StorefrontBody store={s.data} fx={catalog.fx} label={label} />}
      </div>
    </div>
  );
}

function StorefrontBody({ store, fx, label }: { store: Storefront; fx: Fx; label: (serviceId: string) => string }): React.ReactElement {
  const g = store.gate;
  const factor = (Number(BigInt(store.stakeFactor18) / 10n ** 14n) / 10_000).toString();
  return (
    <>
      <h1 className="mkt-h1" data-copy="_data">{sellerName(store.identityId)}{' '}<SellerChip available={store.available} /></h1>
      <p className="mkt-muted mkt-xs" data-copy="store.gate">
        {copy('store.gate', {
          profile: g.profile ? '✓' : '✗', table: g.shardingTable ? '✓' : '✗',
          stake: fmtTrac(g.stake), min: fmtTrac(g.minimumStake), factor,
        })}
      </p>
      <h3 data-copy="store.offers">{copy('store.offers')}</h3>
      {store.offers.length === 0 && <div className="mkt-muted mkt-xs" data-copy="store.offers.none">{copy('store.offers.none')}</div>}
      {store.offers.map((o) => (
        <div key={o.serviceId} className="mkt-mhead mkt-prow" data-testid={`mkt-store-offer-${o.serviceId}`}>
          <span>
            <strong title={label(o.serviceId)} data-copy="_data">{label(o.serviceId)}</strong>{' '}
            <PriceLine min={o.pricePerUnit} fx={fx} />
            <NextPrice offer={o} />
          </span>
          <ProvBadge offers={[o]} />
        </div>
      ))}
      <h3 data-copy="store.served">{copy('store.served')}</h3>
      <table className="mkt-act" data-testid="mkt-store-served">
        <tbody>
          {store.recent.map((r) => (
            <tr key={r.epoch}>
              <td className="mkt-mono" data-copy="store.epoch">{copy('store.epoch', { n: r.epoch })}</td>
              <td data-copy="store.served.value">{copy('store.served.value', { trac: fmtTrac(r.servedValue) })}</td>
              <td className="mkt-muted" data-copy="store.weighted.value">{copy('store.weighted.value', { trac: fmtTrac(r.weightedValue) })}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mkt-muted mkt-xs" data-copy="store.note">{copy('store.note')}</p>
    </>
  );
}

// ── a service's page ────────────────────────────────────────────────────────

function ServicePage({ service, catalog, onBack, onSeller }: { service: Service; catalog: CatalogAnswer; onBack: () => void; onSeller: (id: number) => void }): React.ReactElement {
  const d = useLoad(() => marketplaceApi.service(service.serviceId));
  const addToPlan = useAddToPlan();
  const detail = d.data;
  const covered = (detail ?? service).covered;
  const fx = detail?.fx ?? catalog.fx;
  return (
    <div className="mkt-frame" data-testid="mkt-model-page" data-service={service.serviceId}>
      <div className="ds-card mkt-card">
        <button type="button" className="mkt-linkbtn mkt-xs" data-copy="catalog.back" onClick={onBack}>{copy('catalog.back')}</button>
        <h1 className="mkt-h1" data-copy="_data">{modelName(service.label)}{' '}
          {covered && <span className="ds-badge ds-tone-success" data-copy="catalog.covered">{copy('catalog.covered', { trac: fmtTrac(covered.left) })}</span>}</h1>
        <p className="mkt-muted mkt-xs mkt-mono" data-copy="_data">{service.label}</p>
        {d.err && !detail ? <ErrorCard err={d.err} onRetry={d.reload} /> : null}
        {!detail && !d.err && <div className="mkt-muted" data-copy="state.loading">{copy('state.loading')}</div>}
        {detail?.sellers.map((store) => {
          const o = store.offers.find((x) => x.serviceId === service.serviceId) ?? detail.offers.find((x) => x.seller === store.identityId);
          const last = store.recent.find((r) => r.epoch < catalog.epoch) ?? store.recent[0];
          const off = o?.available === false;
          return (
            <div key={store.identityId} className={`mkt-mhead mkt-prow${off ? ' off' : ''}`} data-testid={`mkt-provider-${store.identityId}`} data-available={o?.available ?? 'unknown'}>
              <span>
                <button type="button" className="mkt-sellerlink mkt-mono" data-testid={`mkt-open-seller-${store.identityId}`} data-copy="_data" onClick={() => onSeller(store.identityId)}>
                  <strong>{sellerName(store.identityId)}</strong>
                </button>{' '}<SellerChip available={o?.available ?? store.available} />{' '}
                {o && <PriceLine min={o.pricePerUnit} fx={fx} />}
                {o && <NextPrice offer={o} />}
                <div className="mkt-muted mkt-xs" data-copy="model.measured">
                  {o ? <ProvBadge offers={[o]} /> : null}{' · '}
                  {copy('model.measured', {
                    latency: o?.measured.latencyMs != null ? copy('model.latency', { ms: o.measured.latencyMs }) : copy('model.latency.none'),
                    tps: o?.measured.tokensPerSecond != null ? copy('model.tps', { n: o.measured.tokensPerSecond }) : copy('model.tps.none'),
                  })}
                  {last ? ` · ${copy('model.served.last', { trac: fmtTrac(last.servedValue), epoch: last.epoch })}` : ''}
                </div>
              </span>
              {covered
                ? <span className="mkt-yours" data-copy="model.covered">{copy('model.covered')}</span>
                : <button type="button" className="ds-btn ds-sm" data-testid={`mkt-add-${store.identityId}`} data-copy="catalog.add" onClick={() => addToPlan(service.serviceId)}>{copy('catalog.add')}</button>}
            </div>
          );
        })}
        <p className="mkt-muted mkt-xs" data-copy="model.route.note">{copy('model.route.note')}</p>
      </div>
    </div>
  );
}

// ── the catalog ─────────────────────────────────────────────────────────────

export function MarketplaceView(): React.ReactElement {
  const [tab, setTab] = useState<'models' | 'playground'>('models');
  const cat = useLoad(() => marketplaceApi.catalog());
  const [selected, setSelected] = useState<string | null>(null);
  const [seller, setSeller] = useState<number | null>(null);
  const addToPlan = useAddToPlan();
  const catalog = cat.data;

  const sellers = useMemo(() => {
    const out = new Map<number, boolean | null>();
    for (const o of (catalog?.services ?? []).flatMap((s) => s.offers)) {
      const was = out.get(o.seller);
      out.set(o.seller, was === true || o.available === true ? true : was === false || o.available === false ? false : null);
    }
    return [...out.entries()].sort((a, b) => a[0] - b[0]);
  }, [catalog]);

  if (isMarketplaceOff(cat.err)) return <div className="mkt-frame" data-testid="mkt-marketplace" data-state="off"><OffCard /></div>;
  if (isMarketplaceAbsent(cat.err)) return <div className="mkt-frame" data-testid="mkt-marketplace" data-state="absent"><OffCard absent /></div>;
  if (cat.err && !catalog) {
    return (
      <div className="mkt-frame" data-testid="mkt-marketplace" data-state="error">
        <div className="ds-card mkt-card">
          <div data-copy="catalog.error">{copy('catalog.error')}</div>
          <ErrorCard err={cat.err} onRetry={cat.reload} retryKey="catalog.retry" />
        </div>
      </div>
    );
  }
  if (!catalog) return <div className="mkt-frame" data-testid="mkt-marketplace" data-state="loading"><div className="ds-card mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></div>;

  if (seller !== null) return <StorefrontPage identityId={seller} catalog={catalog} onBack={() => setSeller(null)} />;
  const service = selected ? catalog.services.find((s) => s.serviceId === selected) : undefined;
  if (service) return <ServicePage service={service} catalog={catalog} onBack={() => setSelected(null)} onSeller={setSeller} />;

  const sellerStrip = (
    <div className="ds-card mkt-card mkt-sellerstrip" data-testid="mkt-seller-strip">
      <div className="mkt-mhead">
        <span className="mkt-fchips mkt-wrap">
          {sellers.length === 0 && <span className="mkt-muted mkt-xs" data-copy="catalog.empty.sellers">{copy('catalog.empty.sellers')}</span>}
          {sellers.map(([id, available]) => (
            <button type="button" key={id} className="mkt-sellerchip" data-testid={`mkt-seller-${id}`} data-state={available === true ? 'ok' : available === false ? 'unreachable' : 'unquoted'} onClick={() => setSeller(id)}>
              <span className="mkt-mono" data-copy="_data">{sellerName(id)}</span>{' '}<SellerChip available={available} />
            </button>
          ))}
        </span>
        <span className="mkt-fork">
          <button type="button" className="ds-btn" data-testid="mkt-catalog-retry" data-copy="catalog.retry" onClick={cat.reload} disabled={cat.loading} title={cat.loading ? copy('catalog.refreshing') : undefined}>
            {cat.loading ? copy('catalog.refreshing') : copy('catalog.retry')}
          </button>
        </span>
      </div>
      <div className="mkt-muted mkt-xs" data-copy={catalog.fx.tracUsd == null ? 'catalog.epoch.nofx' : 'catalog.epoch'}>
        {copy(catalog.fx.tracUsd == null ? 'catalog.epoch.nofx' : 'catalog.epoch', { n: catalog.epoch })}
      </div>
    </div>
  );

  return (
    <div className="mkt-frame" data-testid="mkt-marketplace" data-state="ok">
      <div className="mkt-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'models'} className={tab === 'models' ? 'ds-tab active' : 'ds-tab'} data-copy="nav.models" onClick={() => setTab('models')}>{copy('nav.models')}</button>
        <button type="button" role="tab" aria-selected={tab === 'playground'} className={tab === 'playground' ? 'ds-tab active' : 'ds-tab'} data-copy="nav.playground" onClick={() => setTab('playground')}>{copy('nav.playground')}</button>
      </div>
      {tab === 'playground' ? <Playground catalog={catalog} /> : (
        <>
          {sellerStrip}
          {cat.err ? <ErrorCard err={cat.err} onRetry={cat.reload} retryKey="catalog.retry" /> : null}
          {catalog.services.length === 0 && (
            <div className="ds-card mkt-card mkt-muted" data-testid="mkt-catalog-empty"><span data-copy="catalog.empty.offers">{copy('catalog.empty.offers')}</span></div>
          )}
          <div className="mkt-grid">
            {catalog.services.map((s) => {
              const off = s.offers.length > 0 && s.offers.every((o) => o.available === false);
              const open = () => setSelected(s.serviceId);
              return (
                <div key={s.serviceId} className={`ds-card mkt-card mkt-mcard${off ? ' off' : ''}`} role="button" tabIndex={0} data-testid={`mkt-card-${s.serviceId}`} data-available={!off}
                  onClick={open} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}>
                  <h3 title={s.label} data-copy="_data">{modelName(s.label)}</h3>
                  <div className="mkt-mhead">
                    <span className="mkt-sec mkt-sm" data-copy="catalog.via">
                      {copy(s.serviceClass === 'query' ? 'catalog.cardtype.query' : 'catalog.cardtype.text')} · {copy('catalog.via', { sellers: sellersOf(s.offers).map(sellerName).join(' · ') })}
                    </span>
                    <ProvBadge offers={s.offers} />
                  </div>
                  <div className="mkt-mhead">
                    <span><PriceLine min={s.priceMin} max={s.priceMax} fx={catalog.fx} /></span>
                    {s.covered
                      ? <span className="ds-badge ds-tone-success" data-testid={`mkt-covered-${s.serviceId}`} data-copy="catalog.covered">{copy('catalog.covered', { trac: fmtTrac(s.covered.left) })}</span>
                      : <button type="button" className="ds-btn ds-sm" data-testid={`mkt-add-${s.serviceId}`} data-copy="catalog.add" disabled={off} title={off ? copy('catalog.unavailable.all') : undefined}
                          onClick={(e) => { e.stopPropagation(); addToPlan(s.serviceId); }}>{copy('catalog.add')}</button>}
                  </div>
                  {off && <div className="mkt-muted mkt-xs" data-copy="catalog.unavailable.all">{copy('catalog.unavailable.all')}</div>}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
