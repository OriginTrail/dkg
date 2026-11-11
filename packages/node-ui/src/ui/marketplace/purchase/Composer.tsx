// The plan composer: the services, each with a budget in TRAC (and about how
// many tokens it buys at the best price under its cap), the cap, and an
// optional pinned seller; the epoch (this one, from now to its end, or the
// next); the source, the buyer wallet or an account, with its discount; and
// renewal. The node's dry run says what it would cost and what it would
// refuse. Nothing here is sent to a seller.
import React from 'react';
import { copy } from '../copy.generated.js';
import { needsNodeAdmin } from '../api/client.js';
import type { CatalogAnswer, Funding, FundingRequest, Fx, Offer, Preview, Service, ServiceRequest, SourceRequest } from '../api/types.js';
import { fmtCount, fmtHex, fmtMicro, fmtTrac, microOfWei, modelName, unitsOf, usdOf, weiOfMicro, weiOfTrac } from '../amounts.js';
import { ErrorCard, refusalKey, relAt, sellerName } from '../shared.js';

/** One service of the plan. Its class goes with it, so a service the catalog lacks this epoch is saved back as it was. */
export interface Line { serviceId: string; serviceClass: Service['serviceClass']; valueTrac: string; capMicro: string; pinned: number | null }

export interface Draft {
  epoch: 'current' | 'next';
  source: SourceRequest;
  lines: Line[];
  renew: boolean;
  renewUntil: string;
}

/** The prices that hold in the epoch being funded: the next one's where a seller has set it. */
function priceIn(o: Offer, epoch: 'current' | 'next'): bigint {
  return BigInt(epoch === 'next' ? o.nextPricePerUnit ?? o.pricePerUnit : o.pricePerUnit);
}

/** A new line: one TRAC, capped at the dearest seller's price, so every seller qualifies. */
export function lineFor(s: Service, epoch: 'current' | 'next', valueTrac = '1'): Line {
  const top = s.offers.reduce((m, o) => (priceIn(o, epoch) > m ? priceIn(o, epoch) : m), 0n);
  return { serviceId: s.serviceId, serviceClass: s.serviceClass, valueTrac, capMicro: microOfWei(top), pinned: null };
}

/** The lines as the node takes them, or null while any is not a positive amount. */
export function servicesOf(draft: Draft): ServiceRequest[] | null {
  const out: ServiceRequest[] = [];
  for (const l of draft.lines) {
    const value = weiOfTrac(l.valueTrac);
    const cap = weiOfMicro(l.capMicro);
    if (!value || !cap) return null;
    out.push({ serviceId: l.serviceId, serviceClass: l.serviceClass, value: value.toString(), maxPricePerUnit: cap.toString(), ...(l.pinned !== null ? { pinnedSeller: l.pinned } : {}) });
  }
  return out.length ? out : null;
}

export const fundingRequestOf = (draft: Draft, services: ServiceRequest[]): FundingRequest => ({ epoch: draft.epoch, source: draft.source, services });

/** The cheapest seller's price under the cap, or the pinned seller's. */
function bestPrice(s: Service, l: Line, epoch: 'current' | 'next'): bigint | null {
  const cap = weiOfMicro(l.capMicro) ?? 0n;
  const prices = s.offers.filter((o) => (l.pinned === null || o.seller === l.pinned) && o.available !== false).map((o) => priceIn(o, epoch)).filter((p) => p <= cap);
  return prices.length ? prices.reduce((a, b) => (a < b ? a : b)) : null;
}

/** The dry run's answer in one line: the cost from the source, or what the node would refuse. */
export function PreviewLine({ preview, err, busy }: { preview: Preview | null; err: unknown; busy: boolean }): React.ReactElement | null {
  if (busy && !preview) return <div className="mkt-muted mkt-xs" data-copy="composer.preview.updating">{copy('composer.preview.updating')}</div>;
  if (err) return needsNodeAdmin(err) ? <div className="mkt-muted mkt-xs" data-copy="composer.preview.admin">{copy('composer.preview.admin')}</div> : <ErrorCard err={err} />;
  if (!preview) return null;
  const source = preview.source.kind === 'wallet' ? copy('source.wallet') : copy('source.account', { id: preview.source.accountId });
  return (
    <div data-testid="mkt-preview" data-refusal={preview.refusal?.code ?? ''}>
      <div className="mkt-sec mkt-sm" data-copy={preview.discountBps ? 'composer.cost.discount' : 'composer.cost'}>
        {copy(preview.discountBps ? 'composer.cost.discount' : 'composer.cost', { cost: fmtTrac(preview.cost), value: fmtTrac(preview.value), pct: preview.discountBps / 100, source, epoch: preview.epoch })}
      </div>
      {preview.refusal && <div className="mkt-xs mkt-errline" data-testid="mkt-preview-refusal" data-copy={refusalKey(preview.refusal.code)}>{copy(refusalKey(preview.refusal.code))}{' '}<span className="mkt-mono mkt-muted" data-copy="_data">{preview.refusal.code}</span></div>}
    </div>
  );
}

/** A line's budget, about what it is worth, and its cap: the fields of every line, its service in the catalog or not. */
function Amounts({ line, fx, onChange }: { line: Line; fx: Fx; onChange: (l: Line) => void }): React.ReactElement {
  const value = weiOfTrac(line.valueTrac);
  return (
    <>
      <label className="mkt-xs">
        <span data-copy="composer.budget">{copy('composer.budget')}</span>{' '}
        <input type="text" inputMode="decimal" value={line.valueTrac} aria-label={copy('composer.budget')} data-testid={`mkt-value-${line.serviceId}`}
          onChange={(e) => onChange({ ...line, valueTrac: e.target.value })} />
        {' '}<span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span>
      </label>
      <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">
        {value ? `${usdOf(value, fx.tracUsd) ?? ''}${fx.tracUsd != null ? ` · ${copy('catalog.fx.reference.short')}` : ''}` : copy('composer.budget.zero')}
      </span>
      <label className="mkt-xs">
        <span data-copy="composer.cap">{copy('composer.cap')}</span>{' '}
        <input type="text" inputMode="decimal" value={line.capMicro} aria-label={copy('composer.cap')} data-testid={`mkt-cap-${line.serviceId}`}
          onChange={(e) => onChange({ ...line, capMicro: e.target.value })} />
        {' '}<span data-copy="composer.cap.unit">{copy('composer.cap.unit')}</span>
      </label>
    </>
  );
}

export function Composer({ catalog, funding, draft, onChange, fundsEpoch, endsAt }: {
  catalog: CatalogAnswer;
  funding: Funding | null;
  draft: Draft;
  onChange: (d: Draft) => void;
  /** False when the composer only saves the plan for its renewals. */
  fundsEpoch: boolean;
  endsAt: number | null;
}): React.ReactElement {
  const fx = catalog.fx;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const lineOf = (serviceId: string) => draft.lines.find((l) => l.serviceId === serviceId) ?? null;
  const setLine = (l: Line) => set({ lines: [...draft.lines.filter((x) => x.serviceId !== l.serviceId), l] });
  const accounts = funding?.accounts ?? [];
  const sourceKey = draft.source.kind === 'wallet' ? 'wallet' : draft.source.accountId;

  return (
    <div className="mkt-card" data-testid="mkt-composer">
      <h2 data-copy="composer.title">{copy('composer.title')}</h2>

      {fundsEpoch && (
        <div className="mkt-mhead">
          <span data-copy="composer.epoch">{copy('composer.epoch')}</span>
          <span className="mkt-fchips" role="radiogroup" aria-label={copy('composer.epoch')}>
            {(['current', 'next'] as const).map((e) => (
              <button key={e} type="button" role="radio" aria-checked={draft.epoch === e} className={draft.epoch === e ? 'on' : ''} data-testid={`mkt-epoch-${e}`}
                data-copy={`composer.epoch.${e}`} onClick={() => set({ epoch: e })}>{copy(`composer.epoch.${e}`, { n: e === 'current' ? catalog.epoch : catalog.epoch + 1, t: relAt(endsAt) })}</button>
            ))}
          </span>
        </div>
      )}

      <div className="mkt-mhead">
        <span data-copy="composer.source">{copy('composer.source')}</span>
        <span className="mkt-fchips mkt-wrap" role="radiogroup" aria-label={copy('composer.source')}>
          <button type="button" role="radio" aria-checked={sourceKey === 'wallet'} className={sourceKey === 'wallet' ? 'on' : ''} data-testid="mkt-source-wallet" data-copy="source.wallet.balance"
            onClick={() => set({ source: { kind: 'wallet' } })}>{copy('source.wallet.balance', { trac: funding ? fmtTrac(funding.buyerWallet.trac) : '—' })}</button>
          {accounts.map((a) => {
            const usable = a.serviceCapable && !!a.grant?.live;
            return (
              <button key={a.accountId} type="button" role="radio" aria-checked={sourceKey === a.accountId} className={sourceKey === a.accountId ? 'on' : ''} data-testid={`mkt-source-${a.accountId}`}
                disabled={!usable} title={usable ? undefined : copy(a.refusal ? refusalKey(a.refusal) : 'err.grant.none')} data-copy="source.account.discount"
                onClick={() => set({ source: { kind: 'account', accountId: a.accountId } })}>{copy('source.account.discount', { id: a.accountId, pct: a.discountBps / 100 })}</button>
            );
          })}
        </span>
      </div>

      {catalog.services.length === 0 && <div className="mkt-muted" data-copy="catalog.empty.offers">{copy('catalog.empty.offers')}</div>}
      {catalog.services.map((s) => {
        const line = lineOf(s.serviceId);
        const off = s.offers.every((o) => o.available === false);
        const best = line ? bestPrice(s, line, draft.epoch) : null;
        const value = line ? weiOfTrac(line.valueTrac) : null;
        return (
          <div key={s.serviceId} className={`mkt-orow${off ? ' off' : ''}`} data-testid={`mkt-line-${s.serviceId}`}>
            <label className="mkt-orow-main">
              <input type="checkbox" checked={!!line} data-testid={`mkt-pick-${s.serviceId}`}
                onChange={(e) => set({ lines: e.target.checked ? [...draft.lines, lineFor(s, draft.epoch)] : draft.lines.filter((l) => l.serviceId !== s.serviceId) })} />
              <span data-copy="_data"><strong title={s.label}>{modelName(s.label)}</strong></span>
              <span className="mkt-muted mkt-xs" data-copy="catalog.price.micro">
                {copy('catalog.price.micro', { micro: fmtMicro(s.priceMin) === fmtMicro(s.priceMax) ? fmtMicro(s.priceMin) : `${fmtMicro(s.priceMin)}–${fmtMicro(s.priceMax)}`, unit: 'tok' })}
                {' · '}{copy('catalog.via', { sellers: [...new Set(s.offers.map((o) => o.seller))].map(sellerName).join(' · ') })}
              </span>
            </label>
            {line && (
              <div className="mkt-alloc">
                <Amounts line={line} fx={fx} onChange={setLine} />
                <label className="mkt-xs">
                  <span data-copy="composer.pin">{copy('composer.pin')}</span>{' '}
                  <select value={line.pinned ?? ''} data-testid={`mkt-pin-${s.serviceId}`} aria-label={copy('composer.pin')}
                    onChange={(e) => setLine({ ...line, pinned: e.target.value === '' ? null : Number(e.target.value) })}>
                    <option value="">{copy('composer.pin.any')}</option>
                    {[...new Set(s.offers.map((o) => o.seller))].map((id) => <option key={id} value={id}>{sellerName(id)}</option>)}
                  </select>
                </label>
                <span className="mkt-sec mkt-xs" data-testid={`mkt-units-${s.serviceId}`} data-copy={best && value ? 'composer.units' : 'composer.units.none'}>
                  {best && value ? copy('composer.units', { n: fmtCount(unitsOf(value, best)), price: fmtMicro(best) }) : copy('composer.units.none')}
                </span>
              </div>
            )}
          </div>
        );
      })}
      {/* A saved line whose service the catalog lacks this epoch: shown with its saved terms, to keep, edit or remove. */}
      {draft.lines.filter((l) => !catalog.services.some((s) => s.serviceId === l.serviceId)).map((line) => (
        <div key={line.serviceId} className="mkt-orow" data-testid={`mkt-line-${line.serviceId}`}>
          <div className="mkt-fork">
            <span className="mkt-muted" data-copy="_data"><strong className="mkt-mono" title={line.serviceId}>{fmtHex(line.serviceId)}</strong></span>
            <span className="mkt-muted mkt-xs" data-copy="composer.unavailable">{copy('composer.unavailable')}</span>
            <button type="button" className="mkt-linkbtn mkt-xs" data-testid={`mkt-remove-${line.serviceId}`} data-copy="composer.remove"
              onClick={() => set({ lines: draft.lines.filter((l) => l.serviceId !== line.serviceId) })}>{copy('composer.remove')}</button>
          </div>
          <div className="mkt-alloc">
            <Amounts line={line} fx={fx} onChange={setLine} />
            {line.pinned !== null && <span className="mkt-muted mkt-xs" data-copy="composer.pin.saved">{copy('composer.pin.saved', { seller: sellerName(line.pinned) })}</span>}
          </div>
        </div>
      ))}

      <label className="mkt-fork mkt-xs" data-testid="mkt-renew">
        <input type="checkbox" checked={draft.renew} onChange={(e) => set({ renew: e.target.checked })} />{' '}
        <span data-copy="composer.renew">{copy('composer.renew')}</span>{' '}
        {draft.renew && (
          <input className="mkt-input mkt-input--short mkt-mono" inputMode="numeric" value={draft.renewUntil} aria-label={copy('composer.renew.until')} data-testid="mkt-renew-until"
            onChange={(e) => set({ renewUntil: e.target.value })} />
        )}
      </label>
      <p className="mkt-muted mkt-xs" data-copy={fundsEpoch ? 'composer.note' : 'composer.note.plan'}>{copy(fundsEpoch ? 'composer.note' : 'composer.note.plan')}</p>
    </div>
  );
}
