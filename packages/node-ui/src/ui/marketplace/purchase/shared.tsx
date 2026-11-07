// Purchase-flow primitives shared by every step: the error card (the node's
// refusal shape or anything else), display formatting of node numbers, and
// the code→copy map. Nothing here derives a protocol value.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError } from '../data.js';
import type { IntentError, TermsDiff } from '../types.js';
import { DEFAULT_TRAC_USD, fmtUsd } from '../format.js';
import { truncateAddress } from '../../components/Wallet/truncateAddress.js';

/** The terms diff rows of a refusal, wherever the node put them. */
function termsDiffOf(e: unknown): TermsDiff[] {
  if (!isMarketplaceError(e)) return [];
  const b = (e.body ?? {}) as { diff?: unknown; detail?: { diff?: unknown } };
  const raw = Array.isArray(b.diff) ? b.diff : Array.isArray(b.detail?.diff) ? b.detail.diff : [];
  return raw.filter((d): d is TermsDiff => !!d && typeof d === 'object' && typeof (d as TermsDiff).field === 'string');
}

export const MICRO = 1_000_000;

/** `2.8` — TRAC from the node's µTRAC integer, trailing zeros trimmed (max 6 dp). */
export function tracFromMicro(micro: number): string {
  const s = (micro / MICRO).toFixed(6).replace(/\.?0+$/, '');
  return s === '' || s === '-' ? '0' : s;
}

/** `~$0.78` reference conversion of a µTRAC amount. */
export function usdFromMicro(micro: number, fx?: number | null): string {
  return `~${fmtUsd((micro / MICRO) * (fx ?? DEFAULT_TRAC_USD))}`;
}

/** wei string → `0.00123` (5 dp) for balance readouts. */
export function ethFromWei(wei: string | null | undefined): string {
  if (!wei) return '—';
  try {
    const n = Number(BigInt(wei)) / 1e18;
    return n.toFixed(n >= 1 ? 4 : 5).replace(/\.?0+$/, '') || '0';
  } catch { return '—'; }
}

export const shortAddr = (a: string | null | undefined): string => (a ? truncateAddress(a) : '—');

export const unitWord = (unit: string): string => (unit === 'query-units' ? copy('play.units.query') : copy('play.units.tokens'));

export function fmtUnits(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return n.toLocaleString('en-US');
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const ms = now - new Date(iso).getTime();
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return copy('time.justnow');
  if (m < 60) return copy(ms >= 0 ? 'time.ago.min' : 'time.in.min', { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return copy(ms >= 0 ? 'time.ago.h' : 'time.in.h', { n: h });
  return copy(ms >= 0 ? 'time.ago.d' : 'time.in.d', { n: Math.round(h / 24) });
}

export const fmtClock = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/** Node error code → plain-words copy key (the code itself stays one reveal deeper). */
const CODE_COPY: Record<string, string> = {
  E_INSUFFICIENT_TRAC: 'wallet.insufficient-trac',
  E_INSUFFICIENT_GAS: 'wallet.insufficient-gas',
  E_NO_RPC: 'purchase.error.norpc',
  E_TERMS_CHANGED: 'purchase.terms.changed',
  E_ASK_MISMATCH: 'purchase.terms.changed',
  E_TERMS_EXPIRED: 'purchase.terms.expired',
  E_TERMS_STALE: 'purchase.terms.stale',
  E_INTENT_OPEN: 'purchase.error.intentopen',
  E_OFFLINE: 'err.offline',
  E_TIMEOUT: 'err.offline',
  E_NO_MATCH: 'purchase.recover.nomatch',
  E_AMBIGUOUS: 'purchase.recover.ambiguous',
  E_HAS_PAYMENT: 'purchase.cancel.blocked',
  E_PAYMENT_IN_FLIGHT: 'purchase.pay.inflight',
  E_LINE_PAID: 'purchase.pay.paid',
  E_PERIOD_STILL_ACTIVE: 'purchase.error.periodactive',
  E_OFFERING_UNAVAILABLE: 'purchase.error.unavailable',
  E_SHELF_IDENTITY_MISMATCH: 'catalog.identity.mismatch',
  E_CHAIN_POLICY: 'purchase.error.chainpolicy',
  E_TX_ALREADY_USED: 'purchase.error.txused',
  E_BAD_BUYER: 'purchase.error.badbuyer',
  E_INTENT_UNKNOWN: 'purchase.error.unknownintent',
  E_TOKEN: 'purchase.error.token',
  E_REVENUE_WALLET_UNPINNED: 'purchase.revenue.unpinned',
  E_REVENUE_WALLET_MISMATCH: 'purchase.revenue.mismatch',
  E_WALLET_TX_PENDING: 'purchase.recover.txpending',
  E_SCAN_FAILED: 'purchase.recover.scanfailed',
  E_UNEXPECTED_TRANSFER: 'purchase.recover.unexpected',
  E_ATTEST_TOO_SOON: 'purchase.recover.none.toosoon',
  E_ATTEST_NOT_ALLOWED: 'purchase.recover.none.toosoon',
  E_TX_UNKNOWN: 'purchase.recover.txunknown',
  E_SELLER_UNCONFIGURED: 'catalog.seller.unconfigured',
  E_PROVIDER_UNREACHABLE: 'catalog.unreachable',
  E_NO_ASK: 'catalog.unavailable.noask',
  E_BAD_SELLER: 'seller.form.invalid.address',
  E_BAD_API_BASE: 'seller.form.invalid.apibase',
  E_BAD_REVENUE_WALLET: 'seller.form.invalid.address',
  // add-on lines: the plan gate, the seller's capability, the seller's replies
  E_NO_ACTIVE_PLAN: 'purchase.error.noactiveplan',
  E_ALREADY_ON_PLAN: 'purchase.error.alreadyonplan',
  E_PLAN_ENDING: 'purchase.error.planending',
  E_PLAN_MISMATCH: 'purchase.error.planmismatch',
  E_SELLER_NOT_ON_PLAN: 'purchase.error.sellernotonplan',
  E_SELLER_NOT_ENROLLED: 'purchase.error.sellernotenrolled',
  E_SELLER_NO_ADDON: 'purchase.error.sellernoaddon',
  E_ROUTE_UNKNOWN: 'purchase.error.routeunknown',
  E_ALLOCATION_BELOW_ASK: 'purchase.error.allocationbelowask',
  E_NO_SUCH_ALLOWANCE: 'purchase.error.nosuchallowance',
  E_PLAN_EXPIRED: 'purchase.error.planexpired',
  E_SELLER_ACK_DIFFERS: 'purchase.error.sellerackdiffers',
  E_PAYMENT_REPLAYED: 'purchase.error.txused',
  E_ADDON_MISMATCH: 'purchase.error.generic',
  E_BAD_ADDON: 'purchase.error.generic',
};

/** The node's `blockedReason` → plain-words key (falls back to the offer's own reason). */
export function blockedReasonKey(code: string | undefined, unavailableReason?: string): string | null {
  if (!code) return null;
  if (code === 'E_OFFERING_UNAVAILABLE') return unavailableReason === 'not_mounted' ? 'catalog.unavailable.notmounted' : 'catalog.unavailable.generic';
  if (code === 'E_SHELF_IDENTITY_MISMATCH') return 'catalog.identity.mismatch';
  return CODE_COPY[code] ?? 'catalog.unavailable.generic';
}

/** Why the node refuses `attest: 'no_payment_sent'` right now → copy key. */
export function attestBlockedKey(reason: string | undefined): string {
  switch (reason) {
    case 'too_soon': return 'purchase.recover.none.toosoon';
    case 'pending_tx': case 'wallet_tx_pending': return 'purchase.recover.txpending';
    case 'unexpected_transfer': return 'purchase.recover.unexpected';
    case 'scan_failed': return 'purchase.recover.scanfailed';
    default: return 'purchase.recover.none.gate';
  }
}

export interface DescribedError { copyKey: string; message: string; code: string | null; detail: string | null; retryable: boolean; diff: TermsDiff[] }

/** The intent's own recorded `error` (never thrown — read off the object the node returns). */
const isIntentError = (e: unknown): e is IntentError =>
  !!e && typeof e === 'object' && typeof (e as IntentError).code === 'string' && typeof (e as IntentError).retryable === 'boolean';

/** A seller-side enrollment outcome (`payments[seller].enrollment.error`): the node writes `{ code, detail, … }`,
 *  older rows a bare string. `copyKey` is the plain-words line when the code has one; the code stays one reveal deeper. */
export function enrollErrorOf(err: string | IntentError | null | undefined): { code: string; detail: string | null; copyKey: string | null } | null {
  if (!err) return null;
  const code = typeof err === 'string' ? err : err.code;
  return { code, detail: typeof err === 'string' ? null : err.detail ?? null, copyKey: CODE_COPY[code] ?? null };
}

export function describeError(e: unknown): DescribedError {
  if (isMarketplaceError(e)) {
    const copyKey = CODE_COPY[e.code] ?? (e.status >= 500 ? 'purchase.error.generic' : 'purchase.error.generic');
    const detail = typeof e.detail === 'string' ? e.detail : e.detail != null ? JSON.stringify(e.detail) : null;
    let diff = termsDiffOf(e);
    if (e.code === 'E_REVENUE_WALLET_MISMATCH') {
      const d = (e.detail && typeof e.detail === 'object' ? e.detail : e.body ?? {}) as { pinned?: unknown; live?: unknown; seller?: unknown };
      if (d.pinned != null || d.live != null) diff = [{ field: `revenueWallet${d.seller ? ` (${shortAddr(String(d.seller))})` : ''}`, frozen: d.pinned ?? '—', live: d.live ?? '—' }];
    }
    return { copyKey, message: copy(copyKey), code: e.code, detail, retryable: e.retryable, diff };
  }
  if (isIntentError(e)) {
    const copyKey = CODE_COPY[e.code] ?? 'purchase.error.generic';
    const diff = Array.isArray(e.diff) ? e.diff.filter((d): d is TermsDiff => !!d && typeof d === 'object' && typeof (d as TermsDiff).field === 'string') : [];
    return { copyKey, message: copy(copyKey), code: e.code, detail: e.detail ?? null, retryable: e.retryable, diff };
  }
  const msg = e instanceof Error ? e.message : String(e);
  return { copyKey: 'purchase.error.generic', message: copy('purchase.error.generic'), code: null, detail: msg, retryable: true, diff: [] };
}

/** One error card: plain words first, code one reveal deeper, Retry when retryable. */
export function ErrorCard({ err, onRetry, retryKey = 'ctl.retry', children }: {
  err: unknown; onRetry?: () => void; retryKey?: string; children?: React.ReactNode;
}): React.ReactElement {
  const d = describeError(err);
  const [open, setOpen] = useState(false);
  return (
    <div className="mkt-errcard" role="alert" data-testid="mkt-error-card" data-code={d.code ?? ''}>
      <div className="mkt-errcard-line" data-copy={d.copyKey}>{d.message}</div>
      {d.diff.length > 0 && (
        <table className="mkt-diff" data-testid="mkt-terms-diff">
          <thead><tr>
            <th data-copy="purchase.terms.field">{copy('purchase.terms.field')}</th>
            <th data-copy="purchase.terms.frozen">{copy('purchase.terms.frozen')}</th>
            <th data-copy="purchase.terms.live">{copy('purchase.terms.live')}</th>
          </tr></thead>
          <tbody>
            {d.diff.map((r, i) => (
              <tr key={i}><td className="mkt-mono" data-copy="_data">{r.field}</td>
                <td className="mkt-mono" data-copy="_data">{String(r.frozen)}</td>
                <td className="mkt-mono" data-copy="_data">{String(r.live)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="mkt-fork">
        {onRetry && d.retryable && (
          <button type="button" className="mkt-btn" data-copy={retryKey} onClick={onRetry}>{copy(retryKey)}</button>
        )}
        {children}
        {(d.code || d.detail) && (
          <button type="button" className="mkt-linkbtn mkt-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span data-copy="purchase.error.code">{copy('purchase.error.code')}</span>{' '}<span className="mkt-mono" data-copy="_data">{d.code ?? '—'}</span>
          </button>
        )}
      </div>
      {open && d.detail && <div className="mkt-muted mkt-xs mkt-mono" data-copy="_data">{d.detail}</div>}
    </div>
  );
}
