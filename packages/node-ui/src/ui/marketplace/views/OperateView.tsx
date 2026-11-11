// Operate (seller): the Core Node gate and whether the node has proved this
// epoch; each offering's backend and price, with the next epoch's editable;
// this epoch's ledger (served, sent, landed, refused, missed) and the next
// landing, with Land now; recent batches with their gas; this epoch's served
// and weighted value and the pool so far, each ended epoch's gross; and the
// operational wallets' ETH. Selling switched off is an explicit card.
import React, { useState } from 'react';
import { copy, type CopyKey } from '../copy.generated.js';
import { isMarketplaceAbsent, isMarketplaceOff, marketplaceApi } from '../api/client.js';
import type { LandNowAnswer, LandingReport, LandingStop, Listing, ListingProblem, Offering } from '../api/types.js';
import { fmtAt, fmtHex, fmtMicro, fmtTrac, modelName, weiOfMicro } from '../amounts.js';
import { CoreNodeChecks, ErrorCard, MarketplacePage, OffCard, coreNodeBasics, relAt, useLoad } from '../shared.js';

/** Why an offer is not listed, in plain words. */
const LISTING_PROBLEM: Record<ListingProblem, CopyKey> = {
  'not-core-node': 'operate.listing.not-core-node',
  'not-admitted': 'operate.listing.not-admitted',
  'no-trac': 'operate.listing.no-trac',
  'no-ack-quorum': 'operate.listing.no-ack-quorum',
  'graph-not-registered': 'operate.listing.graph-not-registered',
  'catalog-pending': 'operate.listing.catalog-pending',
  expired: 'operate.listing.expired',
  error: 'operate.listing.error',
};

/** Whether an offering's offer is listed, in one line; the node's own words, if any, beneath it. */
function ListingLine({ serviceId, listing }: { serviceId: string; listing: Listing }): React.ReactElement {
  // No problem named: not listed yet. A problem this page does not know reads as a failed publish.
  const problemKey: CopyKey = !listing.problem ? 'operate.listing.none' : LISTING_PROBLEM[listing.problem] ?? 'operate.listing.error';
  const state = listing.listed ? 'listed' : listing.withdrawn ? 'withdrawn' : 'not-listed';
  return (
    <div className="mkt-xs" data-testid={`mkt-listing-${serviceId}`} data-state={state} data-problem={listing.problem ?? ''}>
      {state === 'listed' && <span className="mkt-yours" data-copy="operate.listing.listed">{copy('operate.listing.listed', { n: listing.validUntilEpoch ?? '—' })}</span>}
      {state === 'withdrawn' && <span className="mkt-muted" data-copy="operate.listing.withdrawn">{copy('operate.listing.withdrawn')}</span>}
      {state === 'not-listed' && (
        <span className="mkt-errline">
          <span data-copy={problemKey}>{copy(problemKey)}</span>
          {listing.retryAt != null && <span data-copy="operate.listing.retry"> · {copy('operate.listing.retry', { t: fmtAt(listing.retryAt) })}</span>}
        </span>
      )}
      {listing.message && <div className="mkt-muted mkt-mono" data-copy="_data">{listing.message}</div>}
    </div>
  );
}

/** What a landing came to, in the fields the last landing's report and a Land now answer share. */
type Landed = { stopped: LandingStop } | { batches: ReadonlyArray<{ items: number }>; refused: number; waiting: boolean };

/** The last landing's report in those fields: its sent batches are the batches. */
const landedOf = (r: LandingReport): Landed => ('stopped' in r ? r : { batches: r.sent, refused: r.refused, waiting: r.waiting });

function landedLine(r: Landed): { key: CopyKey; vars: Record<string, string | number> } {
  if ('stopped' in r) return { key: `operate.stopped.${r.stopped}`, vars: {} };
  if (r.batches.length === 0) return { key: r.waiting ? 'operate.land.waiting' : 'operate.land.none', vars: { refused: r.refused } };
  return { key: 'operate.land.sent', vars: { n: r.batches.length, items: r.batches.reduce((s, b) => s + b.items, 0), refused: r.refused } };
}

export function OperateView(): React.ReactElement {
  const st = useLoad(() => marketplaceApi.sellerStatus());
  const cat = useLoad(() => marketplaceApi.catalog());
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [updated, setUpdated] = useState<Record<string, Offering>>({});
  const [priceErr, setPriceErr] = useState<{ id: string; err: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [landed, setLanded] = useState<LandNowAnswer | null>(null);
  const [landErr, setLandErr] = useState<unknown>(null);
  const label = (id: string) => modelName(cat.data?.services.find((s) => s.serviceId === id)?.label ?? fmtHex(id));

  const setPrice = (serviceId: string) => {
    const wei = weiOfMicro(edits[serviceId] ?? '');
    if (!wei || busy) return;
    setBusy(serviceId); setPriceErr(null);
    marketplaceApi.setNextPrice(serviceId, wei.toString())
      .then((o) => { setUpdated((u) => ({ ...u, [serviceId]: o })); setEdits((e) => ({ ...e, [serviceId]: '' })); })
      .catch((err: unknown) => setPriceErr({ id: serviceId, err }))
      .finally(() => setBusy(null));
  };
  const landNow = () => {
    if (busy) return;
    setBusy('land'); setLandErr(null);
    marketplaceApi.landNow().then((r) => { setLanded(r); st.reload(); }).catch(setLandErr).finally(() => setBusy(null));
  };

  if (isMarketplaceOff(st.err)) {
    return (
      <MarketplacePage page="operate" state="inactive">
        <OffCard selling testId="mkt-operate-inactive" />
      </MarketplacePage>
    );
  }
  if (isMarketplaceAbsent(st.err)) return <MarketplacePage page="operate" state="absent"><OffCard absent /></MarketplacePage>;
  if (st.err && !st.data) {
    return (
      <MarketplacePage page="operate" state="error">
        <div className="mkt-card"><div data-copy="operate.error">{copy('operate.error')}</div><ErrorCard err={st.err} onRetry={st.reload} /></div>
      </MarketplacePage>
    );
  }
  if (!st.data) return <MarketplacePage page="operate" state="loading"><div className="mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></MarketplacePage>;
  const s = st.data;
  const epoch = s.epoch;
  const g = s.gate;
  const l = s.ledger;
  const report: Landed | null = landed ?? (s.lastLanding ? landedOf(s.lastLanding) : null);
  const line = report ? landedLine(report) : null;

  return (
    <MarketplacePage page="operate" state="active">
      {st.err ? <ErrorCard err={st.err} onRetry={st.reload} /> : null}
      <div className="mkt-card">
        <h2 data-copy="operate.price.title">{copy('operate.price.title')}</h2>
        <div className="mkt-muted mkt-xs" data-copy="operate.price.epoch" data-testid="mkt-ask-cycle">
          {copy('operate.price.epoch', { n: epoch, next: epoch + 1, t: relAt(s.endsAt) })}
        </div>
        {s.offerings.length === 0 && <div className="mkt-muted mkt-xs" data-copy="operate.services.none">{copy('operate.services.none')}</div>}
        {s.offerings.map((o0) => {
          const o = updated[o0.serviceId] ?? o0;
          const wei = weiOfMicro(edits[o.serviceId] ?? '');
          const changed = o.nextPrice !== o.price;
          return (
            <div key={o.serviceId} className="mkt-mhead mkt-prow" data-testid={`mkt-ask-${o.serviceId}`} data-connector={o.connector}>
              <span>
                <strong title={o.serviceId} data-copy="_data">{label(o.serviceId)}</strong>{' '}
                {o.connector === 'up'
                  ? <span className="mkt-yours" data-copy="operate.connector.up">{copy('operate.connector.up')}</span>
                  : <span className="mkt-chipblock" data-copy="operate.connector.down">{copy('operate.connector.down')}</span>}
                <div className="mkt-muted mkt-xs" data-copy={changed ? 'operate.price.queued' : 'operate.price.none'}>
                  {changed ? copy('operate.price.queued', { price: fmtMicro(o.nextPrice) }) : copy('operate.price.none')}
                </div>
                {o.listing ? <ListingLine serviceId={o.serviceId} listing={o.listing} /> : null}
                {priceErr?.id === o.serviceId ? <ErrorCard err={priceErr.err} onRetry={() => setPrice(o.serviceId)}><span className="mkt-muted mkt-xs" data-copy="operate.price.error">{copy('operate.price.error')}</span></ErrorCard> : null}
              </span>
              <span className="mkt-mono mkt-sec mkt-askedit">
                <span data-copy="catalog.price.micro">{copy('catalog.price.micro', { micro: fmtMicro(o.price), unit: 'tok' })}</span>
                {' → '}
                <input className="mkt-input mkt-input--short" inputMode="decimal" data-testid={`mkt-ask-input-${o.serviceId}`} value={edits[o.serviceId] ?? ''} placeholder={fmtMicro(o.nextPrice)}
                  aria-label={copy('operate.price.cta')} onChange={(e) => setEdits((x) => ({ ...x, [o.serviceId]: e.target.value }))} />
                <button type="button" className="mkt-btn" data-testid={`mkt-ask-queue-${o.serviceId}`} data-copy="operate.price.cta" onClick={() => setPrice(o.serviceId)}
                  disabled={!wei || busy === o.serviceId} title={!wei ? copy('operate.price.invalid') : undefined}>{busy === o.serviceId ? copy('state.working') : copy('operate.price.cta')}</button>
              </span>
            </div>
          );
        })}
        <p className="mkt-muted mkt-xs" data-copy="operate.price.note">{copy('operate.price.note')}</p>
      </div>

      <div className="mkt-card" data-testid="mkt-ledger">
        <h2 data-copy="operate.epoch.title">{copy('operate.epoch.title')}</h2>
        <div className="mkt-muted mkt-xs" data-copy="gate.core" data-testid="mkt-operate-gate">
          {/* Not proved yet is pending while the epoch runs, not a failed check, so it has no mark. */}
          <CoreNodeChecks items={[...coreNodeBasics(g),
            s.scoredThisEpoch ? { ok: true, label: copy('operate.proved') } : { label: copy('operate.proved.not') }]} />
        </div>
        <div className="mkt-sec mkt-sm" data-testid="mkt-ledger-counts" data-copy="operate.ledger">{copy('operate.ledger', { served: l.served, sent: l.sent, landed: l.landed, refused: l.refused, missed: l.missed })}</div>
        <div className="mkt-muted mkt-xs" data-copy="operate.ledger.value">{copy('operate.ledger.value', { held: fmtTrac(l.heldValue), landed: fmtTrac(l.landedValue), counted: fmtTrac(l.counted) })}</div>
        <div className="mkt-muted mkt-xs" data-copy="operate.thisepoch">{copy('operate.thisepoch', { served: fmtTrac(s.thisEpoch.servedValue), weighted: fmtTrac(s.thisEpoch.weightedValue), pool: fmtTrac(s.thisEpoch.poolSoFar) })}</div>
        <div className="mkt-mhead">
          <span className="mkt-sec mkt-sm" data-copy="operate.nextlanding">{copy('operate.nextlanding', { t: relAt(s.nextLandingAt) })}</span>
          <button type="button" className="mkt-btn" data-testid="mkt-land-now" data-copy="operate.land.cta" onClick={landNow} disabled={busy === 'land'}>{busy === 'land' ? copy('state.working') : copy('operate.land.cta')}</button>
        </div>
        {line && <div className="mkt-muted mkt-xs" data-testid="mkt-land-result" data-copy={line.key}>{copy(line.key, line.vars)}</div>}
        {landErr ? <ErrorCard err={landErr} onRetry={landNow} /> : null}
      </div>

      <div className="mkt-card" data-testid="mkt-batches">
        <h2 data-copy="operate.batches">{copy('operate.batches')}</h2>
        {s.batches.length === 0 && <div className="mkt-muted mkt-xs" data-copy="operate.batches.none">{copy('operate.batches.none')}</div>}
        <div className="ds-table-scroll">
        <table className="mkt-act">
          <tbody>
            {s.batches.slice(0, 10).map((b) => (
              <tr key={b.tx}>
                <td className="mkt-mono" data-copy="_data">{fmtHex(b.tx)}</td>
                <td className="mkt-muted" data-copy="_data">{fmtAt(b.at)}</td>
                <td data-copy="operate.batch.items">{copy('operate.batch.items', { n: b.items })}</td>
                <td data-copy="operate.batch.value">{copy('operate.batch.value', { value: fmtTrac(b.value), counted: fmtTrac(b.counted) })}</td>
                <td className="mkt-muted" data-copy="operate.batch.gas">{copy('operate.batch.gas', { n: b.gasUsed.toLocaleString('en-US') })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <h3 data-copy="operate.ended">{copy('operate.ended')}</h3>
        {s.ended.length === 0 && <div className="mkt-muted mkt-xs" data-copy="operate.ended.none">{copy('operate.ended.none')}</div>}
        <div className="ds-table-scroll">
        <table className="mkt-act" data-testid="mkt-ended">
          <tbody>
            {s.ended.map((e) => (
              <tr key={e.epoch}>
                <td className="mkt-mono" data-copy="store.epoch">{copy('store.epoch', { n: e.epoch })}</td>
                <td data-copy="operate.ended.gross">{copy('operate.ended.gross', { trac: fmtTrac(e.gross) })}</td>
                <td className="mkt-muted" data-copy="operate.ended.pool">{copy('operate.ended.pool', { trac: fmtTrac(e.pool) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      <div className="mkt-card">
        <h2 data-copy="op.wallets">{copy('op.wallets')}</h2>
        {s.wallets.map((w) => (
          <div key={w.address} className="mkt-wallet" data-testid="mkt-ops-wallet">
            <strong data-copy="operate.ops.wallet">{copy('operate.ops.wallet')}</strong><br />
            <span className="mkt-mono" data-copy="_data">{w.address}</span><br />
            <span className="mkt-sec mkt-xs" data-copy="operate.ops.wallet.eth">{copy('operate.ops.wallet.eth', { eth: w.ethEther })}</span><br />
            <span className="mkt-muted mkt-xs" data-copy="operate.ops.wallet.note">{copy('operate.ops.wallet.note')}</span>
          </div>
        ))}
        <div className="mkt-muted mkt-xs" data-copy="operate.identity">{copy('operate.identity', { id: s.identityId })}</div>
      </div>
    </MarketplacePage>
  );
}
