// Plan composer: period · one provider per offering · allocation in TRAC with
// a reference-rate USD subtext · seller groups · a live preview
// "≈ {ceiling} {unit} per period" taken from the node's frozen terms
// (guaranteedUnits), never computed here.
import React from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError } from '../data.js';
import type { Catalog, Offer, PurchaseIntent, PurchaseState, ShelfRow } from '../types.js';
import { ErrorCard, blockedReasonKey, fmtClock, fmtUnits, relTime, shortAddr, unitWord, usdFromMicro, MICRO } from './shared.js';

export type PeriodKey = 'monthly' | 'weekly' | 'daily';
const PERIOD_MS: Record<PeriodKey, number> = { monthly: 30 * 86_400_000, weekly: 7 * 86_400_000, daily: 86_400_000 };
export const periodKeyOf = (ms: number | undefined): PeriodKey =>
  ms === PERIOD_MS.weekly ? 'weekly' : ms === PERIOD_MS.daily ? 'daily' : 'monthly';

export interface ComposerLine { offeringId: string; seller: string; allocTrac: string }

export type PreviewStatus = 'nowallet' | 'idle' | 'updating' | 'ready' | 'stale' | 'locked';

export interface ComposerPreview { intent: PurchaseIntent | null; status: PreviewStatus; err: unknown | null }

/** µTRAC integer from the operator's TRAC input (a unit conversion of their own number). */
export const allocMicroOf = (allocTrac: string): number => {
  const n = Number(allocTrac);
  return Number.isFinite(n) && n > 0 ? Math.round(n * MICRO) : 0;
};

function offerUnit(o: Offer): string { return o.ask?.unit ?? 'tokens'; }
/** The node's `purchasable` verdict wins; the inference below only covers older nodes. */
export function offerAvailable(row: ShelfRow, o: Offer): boolean {
  if (typeof o.purchasable === 'boolean') return o.purchasable;
  if (typeof row.purchasable === 'boolean' && !row.purchasable) return false;
  return row.ok && row.source !== 'cache' && !row.identityMismatch && !!o.ask && o.available !== false;
}
export function unavailableReasonKey(row: ShelfRow, o: Offer): string {
  const fromNode = blockedReasonKey(o.blockedReason ?? row.blockedReason, o.unavailableReason);
  if (fromNode) return fromNode;
  if (row.identityMismatch) return 'catalog.identity.mismatch';
  if (row.source === 'cache') return 'catalog.stale.note';
  if (!row.ok) return 'catalog.unreachable';
  if (o.available === false) return o.unavailableReason === 'not_mounted' ? 'catalog.unavailable.notmounted' : 'catalog.unavailable.generic';
  if (!o.ask) return 'catalog.unavailable.noask';
  return 'catalog.unavailable.generic';
}

/** "cheapest is pre-selected" — the lowest in-force ask among available sellers of an offering. */
export function cheapestSeller(cat: Catalog, offeringId: string): string | null {
  let best: { seller: string; ask: number } | null = null;
  for (const row of cat.shelves) {
    for (const o of row.offers ?? []) {
      if (o.offeringId !== offeringId || !offerAvailable(row, o) || !o.ask) continue;
      if (!best || o.ask.askMicroPerUnit < best.ask) best = { seller: row.seller, ask: o.ask.askMicroPerUnit };
    }
  }
  return best?.seller ?? null;
}

function previewLine(intent: PurchaseIntent | null, seller: string, offeringId: string) {
  const fs = intent?.frozen?.sellers ?? {};
  const key = Object.keys(fs).find((k) => k.toLowerCase() === seller.toLowerCase());
  return key ? fs[key].lines.find((l) => l.offeringId === offeringId) ?? null : null;
}

export function Composer({ catalog, catalogErr, onCatalogRetry, lines, period, onChange, preview, onConfirmPlan, busy, walletConnected, fx, onOpenIntent, lockedUntil }: {
  catalog: Catalog | null;
  catalogErr: unknown | null;
  onCatalogRetry: () => void;
  lines: ComposerLine[];
  period: PeriodKey;
  onChange: (lines: ComposerLine[], period: PeriodKey) => void;
  preview: ComposerPreview;
  onConfirmPlan: () => void;
  busy: boolean;
  walletConnected: boolean;
  fx: number;
  onOpenIntent?: (id: string) => void;
  /** A next-period draft while the current period runs: its terms open after this time. */
  lockedUntil?: string | null;
}): React.ReactElement {
  const lineFor = (offeringId: string) => lines.find((l) => l.offeringId === offeringId) ?? null;
  const setLine = (offeringId: string, seller: string, allocTrac?: string) => {
    const cur = lineFor(offeringId);
    const next: ComposerLine = { offeringId, seller, allocTrac: allocTrac ?? cur?.allocTrac ?? '1' };
    onChange([...lines.filter((l) => l.offeringId !== offeringId), next], period);
  };
  const dropLine = (offeringId: string) => onChange(lines.filter((l) => l.offeringId !== offeringId), period);

  const validLines = lines.filter((l) => allocMicroOf(l.allocTrac) > 0);
  const sellersInPlan = [...new Set(validLines.map((l) => l.seller.toLowerCase()))];
  const frozenSellers = preview.intent?.frozen?.sellers ?? {};
  const canConfirm = walletConnected && validLines.length > 0 && !busy && !lockedUntil;
  const confirmReasonKey = lockedUntil ? 'plans.draft.opens.after' : !walletConnected ? 'wallet.none' : validLines.length === 0 ? 'composer.empty' : null;
  const confirmReasonVars = lockedUntil ? { t: fmtClock(lockedUntil) } : undefined;

  return (
    <div className="mkt-card" data-testid="mkt-composer">
      <h2 data-copy="composer.title">{copy('composer.title')}</h2>

      <div className="mkt-mhead">
        <span data-copy="composer.period">{copy('composer.period')}</span>
        <span className="mkt-fchips" role="radiogroup" aria-label={copy('composer.period')}>
          {(['monthly', 'weekly', 'daily'] as PeriodKey[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={period === p} className={period === p ? 'on' : ''}
              data-copy={`composer.period.${p}`} onClick={() => onChange(lines, p)}>{copy(`composer.period.${p}`)}</button>
          ))}
        </span>
      </div>

      {catalogErr ? <ErrorCard err={catalogErr} onRetry={onCatalogRetry} retryKey="catalog.retry" /> : null}
      {!catalog && !catalogErr && <div className="mkt-muted" data-copy="state.loading">{copy('state.loading')}</div>}
      {catalog && catalog.shelves.length === 0 && <div className="mkt-muted" data-copy="catalog.empty.sellers">{copy('catalog.empty.sellers')}</div>}

      {catalog?.shelves.map((row) => (
        <div key={row.seller} className="mkt-sellergroup" data-testid={`mkt-seller-group-${row.seller.toLowerCase()}`}>
          <div className="mkt-mhead">
            <strong className="mkt-mono" title={row.seller} data-copy="composer.seller.group">
              {copy('composer.seller.group', { seller: shortAddr(row.seller), n: row.offers?.length ?? 0 })}
            </strong>
            <SellerStatus row={row} />
          </div>
          {(row.offers ?? []).map((o) => {
            const line = lineFor(o.offeringId);
            const mine = !!line && line.seller.toLowerCase() === row.seller.toLowerCase();
            const elsewhere = !!line && !mine;
            const avail = offerAvailable(row, o);
            const unit = offerUnit(o);
            const pv = mine ? previewLine(preview.intent, row.seller, o.offeringId) : null;
            const micro = line ? allocMicroOf(line.allocTrac) : 0;
            return (
              <div key={o.offeringId} className={`mkt-orow${avail ? '' : ' off'}`} data-testid={`mkt-offer-${row.seller.toLowerCase()}-${o.offeringId}`}>
                <label className="mkt-orow-main">
                  <input type="checkbox" checked={mine} disabled={!avail}
                    title={avail ? undefined : copy(unavailableReasonKey(row, o))}
                    onChange={(e) => (e.target.checked ? setLine(o.offeringId, row.seller) : dropLine(o.offeringId))} />
                  <span data-copy="_data"><strong>{o.modelId}</strong>{' '}<span className="mkt-muted mkt-xs">{o.offeringId}</span></span>
                  <span className="mkt-muted mkt-xs" data-copy="_data">
                    {o.provenanceClass === 'weights-pinned' ? '⛓ ' : unit === 'query-units' ? '' : '☁ '}
                    {o.ask ? copy('catalog.price.micro', { micro: o.ask.askMicroPerUnit, unit: unit === 'query-units' ? 'unit' : 'tok' }) : '—'}
                    {o.ask && <>{' · '}<span data-copy="catalog.fx.reference">{copy('catalog.fx.reference', { usd: (o.ask.askMicroPerUnit * fx).toFixed(2) })}</span></>}
                  </span>
                </label>
                {!avail && <span className="mkt-muted mkt-xs" data-copy={unavailableReasonKey(row, o)}>{copy('composer.unavailable', { reason: copy(unavailableReasonKey(row, o)) })}</span>}
                {elsewhere && avail && (
                  <span className="mkt-xs mkt-fork">
                    <span className="mkt-muted" data-copy="composer.chosen.elsewhere">{copy('composer.chosen.elsewhere', { seller: shortAddr(line!.seller) })}</span>
                    <button type="button" className="mkt-linkbtn" data-copy="composer.choose.here" onClick={() => setLine(o.offeringId, row.seller)}>{copy('composer.choose.here')}</button>
                  </span>
                )}
                {mine && (
                  <div className="mkt-alloc">
                    <label className="mkt-xs">
                      <span data-copy="composer.allocation">{copy('composer.allocation')}</span>{' '}
                      <input type="number" min="0" step="0.1" inputMode="decimal" value={line!.allocTrac}
                        aria-label={copy('composer.allocation.trac')}
                        onChange={(e) => setLine(o.offeringId, row.seller, e.target.value)} />
                      {' '}<span data-copy="composer.allocation.trac">{copy('composer.allocation.trac')}</span>
                    </label>
                    <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">
                      {micro > 0 ? `${usdFromMicro(micro, fx)} · ${copy('catalog.fx.reference.short')}` : copy('composer.allocation.zero')}
                    </span>
                    <span className="mkt-sec mkt-xs" data-testid={`mkt-preview-${o.offeringId}`}
                      data-copy={pv && preview.status === 'ready' ? 'composer.preview.offering' : `composer.preview.${preview.status}`}>
                      {pv && preview.status === 'ready'
                        ? copy('composer.preview.offering', { ceiling: fmtUnits(pv.guaranteedUnits), unit: unitWord(pv.unit) })
                        : copy(`composer.preview.${preview.status}`)}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {preview.err ? (
        <ErrorCard err={preview.err} onRetry={onConfirmPlan} retryKey="purchase.terms.again">
          {onOpenIntent ? <OpenIntentButton err={preview.err} onOpenIntent={onOpenIntent} /> : null}
        </ErrorCard>
      ) : null}

      <p className="mkt-sec mkt-sm" data-copy="composer.payments">
        {copy('composer.payments', {
          n: sellersInPlan.length,
          lines: sellersInPlan.map((s) => {
            const key = Object.keys(frozenSellers).find((k) => k.toLowerCase() === s);
            const amt = key && preview.status === 'ready' ? ` ${(frozenSellers[key].amountMicroTrac / MICRO).toString()} TRAC` : '';
            return `${shortAddr(s)}${amt}`;
          }).join(' · ') || '—',
        })}
      </p>
      <p className="mkt-muted mkt-xs" data-copy="composer.provider.note">{copy('composer.provider.note')}</p>
      <p className="mkt-muted mkt-xs" data-copy="composer.period.note">{copy('composer.period.note')}</p>
      <div className="mkt-fork">
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-confirm-plan" data-copy={lockedUntil ? 'plans.draft.opens.after' : 'composer.payments.cta'}
          disabled={!canConfirm} title={confirmReasonKey ? copy(confirmReasonKey, confirmReasonVars) : undefined} onClick={onConfirmPlan}>
          {busy ? copy('state.working') : lockedUntil ? copy('plans.draft.opens.after', confirmReasonVars) : copy('composer.payments.cta')}
        </button>
        {confirmReasonKey && <span className="mkt-muted mkt-xs" data-copy={confirmReasonKey}>{copy(confirmReasonKey, confirmReasonVars)}</span>}
      </div>
    </div>
  );
}

export function SellerStatus({ row }: { row: ShelfRow }): React.ReactElement {
  if (row.identityMismatch) return <span className="mkt-chipblock" data-copy="catalog.identity.mismatch">{copy('catalog.identity.mismatch')}</span>;
  if (row.source === 'cache') return <span className="mkt-chipwarn" data-copy="catalog.offline">{copy('catalog.offline', { t: relTime(row.staleSince) })}</span>;
  if (!row.ok) return <span className="mkt-chipblock" data-copy="catalog.unreachable">{copy('catalog.unreachable')}{row.error ? <span className="mkt-xs mkt-mono" data-copy="_data"> · {row.error}</span> : null}</span>;
  if (row.notSelling) return <span className="mkt-muted mkt-xs" data-copy="catalog.notselling">{copy('catalog.notselling')}</span>;
  return <span className="mkt-chipleft" data-copy="catalog.online">{copy('catalog.online')}</span>;
}

/** A refusal because another purchase is already open: which one, and its state. */
function intentOpenDetail(e: unknown): { existingIntentId: string; state: PurchaseState } | null {
  if (!isMarketplaceError(e) || e.code !== 'E_INTENT_OPEN') return null;
  const b = (e.body ?? {}) as { existingIntentId?: unknown; state?: unknown; detail?: { existingIntentId?: unknown; state?: unknown } };
  const id = typeof b.existingIntentId === 'string' ? b.existingIntentId
    : typeof b.detail?.existingIntentId === 'string' ? b.detail.existingIntentId : null;
  const state = (typeof b.state === 'string' ? b.state : typeof b.detail?.state === 'string' ? b.detail.state : 'draft') as PurchaseState;
  return id ? { existingIntentId: id, state } : null;
}

export function OpenIntentButton({ err, onOpenIntent }: { err: unknown; onOpenIntent: (id: string) => void }): React.ReactElement | null {
  const d = intentOpenDetail(err);
  if (!d) return null;
  return (
    <button type="button" className="mkt-btn" data-testid="mkt-open-existing" data-copy="purchase.error.intentopen.cta" onClick={() => onOpenIntent(d.existingIntentId)}>
      {copy('purchase.error.intentopen.cta', { state: d.state })}
    </button>
  );
}
