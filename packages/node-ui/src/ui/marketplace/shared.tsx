// What the marketplace surfaces share: refusals in plain words (the code one
// reveal deeper), the section's off and admin-needed states, one loader hook,
// relative times, seller names, and the hop to another marketplace tab.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { copy, type CopyKey } from './copy.generated.js';
import { isMarketplaceError } from './api/client.js';
import { fmtTracGrouped, spanOf } from './amounts.js';
import { MARKETPLACE_TABS } from './tabs.js';
import { chooseTab } from '../lib/shellNavigation.js';
import { PageHeader } from '../components/ds/PageHeader.js';

/** Whether a check passed, as an icon named for screen readers. */
export function CheckMark({ ok }: { ok: boolean }): React.ReactElement {
  return ok ? <Check size={12} aria-label="yes" /> : <X size={12} aria-label="no" />;
}

/** One of a Core node's requirements: its words, and whether it is met (no mark when it isn't a check). */
export interface CoreNodeCheck { label: React.ReactNode; ok?: boolean }

/** The requirements every Core node line shows: a profile, a place in the sharding table, and the minimum stake. */
export function coreNodeBasics(g: { profile: boolean; shardingTable: boolean; stake: string; minimumStake: string }): CoreNodeCheck[] {
  return [
    { ok: g.profile, label: copy('gate.profile') },
    { ok: g.shardingTable, label: copy('gate.table') },
    { ok: BigInt(g.stake) >= BigInt(g.minimumStake), label: copy('gate.stake', { stake: fmtTracGrouped(g.stake), min: fmtTracGrouped(g.minimumStake) }) },
  ];
}

/**
 * A Core node's requirements as separate items, each with its own check before it. The gaps
 * between items separate them, so the line needs no dots, and it wraps on a narrow screen.
 */
export function CoreNodeChecks({ items }: { items: CoreNodeCheck[] }): React.ReactElement {
  return (
    <span className="mkt-corenode">
      <span className="mkt-sec">{copy('gate.core')}</span>
      {items.map((item, i) => (
        <span key={i} className="mkt-corenode-item">
          {item.ok !== undefined && <CheckMark ok={item.ok} />}
          {item.label}
        </span>
      ))}
    </span>
  );
}

/** Each Marketplace page: its tab (for the title) and its one-line purpose. */
const PAGES = {
  browse: { testId: 'mkt-marketplace', tab: MARKETPLACE_TABS.browse, desc: 'page.browse.desc' },
  plans: { testId: 'mkt-plans', tab: MARKETPLACE_TABS.plans, desc: 'page.plans.desc' },
  access: { testId: 'mkt-access', tab: MARKETPLACE_TABS.access, desc: 'page.access.desc' },
  operate: { testId: 'mkt-operate', tab: MARKETPLACE_TABS.operate, desc: 'page.operate.desc' },
} as const satisfies Record<string, { testId: string; tab: { label: string }; desc: CopyKey }>;

/**
 * A Marketplace page: its frame and its page title, whatever state it is in. The state
 * (loading, off, an error, the page itself) only supplies the body and `data-state`.
 */
export function MarketplacePage({ page, state, children }: { page: keyof typeof PAGES; state: string; children: React.ReactNode }): React.ReactElement {
  const p = PAGES[page];
  return (
    <div className="mkt-frame" data-testid={p.testId} data-state={state}>
      <PageHeader title={p.tab.label} description={copy(p.desc)} />
      {children}
    </div>
  );
}

/** A refusal's code → its plain words. The codes are the node's, so any string; the words are the table's. */
const CODE_COPY: Record<string, CopyKey> = {
  MarketplaceOff: 'err.off',
  // A single route the node lacks; a surface whose loads all meet it shows the absent state instead.
  MarketplaceAbsent: 'err.notfound',
  NodeAdminRequired: 'err.admin',
  Offline: 'err.offline',
  UnreadableAnswer: 'err.unreadable',
  NotFound: 'err.notfound',
  Unauthorized: 'err.unauthorized',
  InvalidRequest: 'err.invalid',
  InvalidFundingRequest: 'err.invalid',
  InvalidBuyerTerms: 'err.invalid',
  BudgetTermsChanged: 'err.terms.changed',
  ServiceNotFound: 'err.service.none',
  SellerNotFound: 'err.seller.none',
  SubscriptionNotFound: 'err.subscription.none',
  SubscriptionAlreadyFunded: 'err.subscription.funded',
  SubscriptionEnded: 'err.subscription.ended',
  NotSubscriptionBuyer: 'err.subscription.buyer',
  IdempotencyKeyReused: 'err.topup.key',
  TopUpOutcomeUnknown: 'err.topup.pending',
  TopUpPending: 'err.topup.pending',
  TopUpNotSent: 'err.topup.notsent',
  TopUpReverted: 'err.topup.reverted',
  ERC20InsufficientBalance: 'err.wallet.trac',
  InsufficientAllowance: 'err.account.allowance',
  LimitExceeded: 'err.grant.limit',
  NotABuyer: 'err.grant.none',
  GrantRevoked: 'err.grant.revoked',
  GrantExpired: 'err.grant.expired',
  GrantEndsBeforeSubscription: 'err.grant.ends',
  GrantedByFormerOwner: 'err.grant.former',
  AccountExpired: 'err.account.expired',
  ServiceSpendingDisabled: 'err.account.spending',
  EmissionAlreadyScheduled: 'err.account.scheduled',
  ServiceFundingPausedTreasuryWired: 'err.account.treasury',
  ERC721NonexistentToken: 'err.account.none',
  NotAccountOwner: 'err.account.owner',
  ConsentMissing: 'err.consent',
  InvalidConsentSignature: 'err.consent',
  QueryInferencePaused: 'err.paused',
  QueryInferenceNotActive: 'err.notactive',
  KeyNotFound: 'err.key.none',
  EpochStarted: 'err.price.started',
  epoch_ending: 'err.epoch.ending',
  no_subscription: 'err.gw.nosub',
  soft_ceiling: 'err.gw.ceiling',
  budget_busy: 'err.gw.busy',
  gateway_busy: 'err.gw.nodebusy',
  key_budget: 'err.gw.keybudget',
  no_seller: 'err.gw.noseller',
  seller_unreachable: 'err.gw.unreachable',
  seller_refused: 'err.gw.refused',
  bad_receipt: 'err.gw.receipt',
  service_not_allowed: 'err.gw.notallowed',
  request_too_large: 'err.gw.toolarge',
  session_key_missing: 'err.gw.sessionkey',
  bad_request: 'err.gw.badrequest',
  missing_key: 'err.gw.key',
  unknown_key: 'err.gw.key',
  revoked_key: 'err.gw.key',
  expired_key: 'err.gw.key',
  key_rate: 'err.gw.rate',
};

/** The copy key for a refusal code; anything unknown reads as a general failure. */
export const refusalKey = (code: string | null | undefined): CopyKey => (code && CODE_COPY[code]) || 'err.generic';

/** Plain words for one reason of a code that covers several, by the code and its first argument. */
const REASON_COPY: Record<string, CopyKey> = {
  // A funding of an epoch that is neither the current nor the next one: an epoch boundary passed since its dry run.
  'InvalidFundingRequest:epoch': 'err.funding.epoch',
};

export interface DescribedError { copyKey: CopyKey; message: string; code: string | null; detail: string | null; retryable: boolean; retryAfter: number | null }

export function describeError(e: unknown): DescribedError {
  if (isMarketplaceError(e)) {
    const copyKey = REASON_COPY[`${e.code}:${e.args[0] ?? ''}`] ?? refusalKey(e.code);
    const detail = e.args.length ? `${e.code}(${e.args.join(', ')})` : e.message !== e.code ? e.message : null;
    return { copyKey, message: copy(copyKey), code: e.code, detail, retryable: e.retryable, retryAfter: e.retryAfter };
  }
  return { copyKey: 'err.generic', message: copy('err.generic'), code: null, detail: e instanceof Error ? e.message : String(e), retryable: true, retryAfter: null };
}

/** One error card: plain words first, the code one reveal deeper, Retry when the node says it may pass. */
export function ErrorCard({ err, onRetry, retryKey = 'ctl.retry', children }: {
  err: unknown; onRetry?: () => void; retryKey?: CopyKey; children?: React.ReactNode;
}): React.ReactElement {
  const d = describeError(err);
  const [open, setOpen] = useState(false);
  return (
    <div className="mkt-errcard" role="alert" data-testid="mkt-error-card" data-code={d.code ?? ''}>
      <div className="mkt-errcard-line" data-copy={d.copyKey}>{d.message}</div>
      {d.retryAfter != null && <div className="mkt-muted mkt-xs" data-copy="err.retry.after">{copy('err.retry.after', { n: d.retryAfter })}</div>}
      <div className="mkt-fork">
        {onRetry && d.retryable && <button type="button" className="ds-btn" data-copy={retryKey} onClick={onRetry}>{copy(retryKey)}</button>}
        {children}
        {(d.code || d.detail) && (
          <button type="button" className="mkt-linkbtn mkt-xs" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span data-copy="err.code">{copy('err.code')}</span>{' '}<span className="mkt-mono" data-copy="_data">{d.code ?? '—'}</span>
          </button>
        )}
      </div>
      {open && d.detail && <div className="mkt-muted mkt-xs mkt-mono" data-copy="_data">{d.detail}</div>}
    </div>
  );
}

/**
 * The section's state when the node runs without the marketplace (or without
 * selling), or, `absent`, has no marketplace routes at all.
 */
export function OffCard({ selling = false, absent = false, testId }: { selling?: boolean; absent?: boolean; testId?: string }): React.ReactElement {
  const k = absent ? 'off.absent' : selling ? 'off.seller' : 'off.buyer';
  return (
    <div className="ds-card mkt-card mkt-seatcard" data-testid={testId ?? 'mkt-off'}>
      <h2 data-copy={`${k}.title`}>{copy(`${k}.title`)}</h2>
      <p className="mkt-sec mkt-sm" data-copy={`${k}.body`}>{copy(`${k}.body`)}</p>
    </div>
  );
}

/** A surface that needs the node-admin token, opened with another one. */
export function AdminCard({ what }: { what: CopyKey }): React.ReactElement {
  return (
    <div className="ds-card mkt-card mkt-seatcard" data-testid="mkt-admin-needed">
      <h2 data-copy="admin.title">{copy('admin.title')}</h2>
      <p className="mkt-sec mkt-sm" data-copy={what}>{copy(what)}</p>
    </div>
  );
}

/**
 * Where a read stands, by its latest answer: none yet; answered with `value`,
 * which may be null (a node without a plan answers so); or failed, with the
 * last answer before, if there was one, as `stale`.
 */
export type ReadStatus<T> =
  | { state: 'unresolved' }
  | { state: 'resolved'; value: T }
  | { state: 'failed'; err: unknown; stale: T | null };

/** A read: its status, and the same as `data` (the last good answer), `err` (the latest failure) and whether one is on its way. */
export interface Loaded<T> { status: ReadStatus<T>; data: T | null; err: unknown; loading: boolean; reload: () => void }

/**
 * Load once on mount, keep the last good answer through a failed reload. A
 * reload while a read is on its way reads again at once: the read before may
 * answer from before what the reload was asked for (a write that landed
 * since), so only the latest read asked for is kept.
 */
export function useLoad<T>(load: () => Promise<T>): Loaded<T> {
  const [status, setStatus] = useState<ReadStatus<T>>({ state: 'unresolved' });
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const alive = useRef(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const reload = useCallback(() => {
    const read = ++latest.current;
    const current = () => alive.current && read === latest.current;
    setLoading(true);
    loadRef.current()
      .then((value) => { if (current()) setStatus({ state: 'resolved', value }); })
      .catch((err: unknown) => {
        if (current()) setStatus((s) => ({ state: 'failed', err, stale: s.state === 'resolved' ? s.value : s.state === 'failed' ? s.stale : null }));
      })
      .finally(() => { if (current()) setLoading(false); });
  }, []);
  useEffect(() => { alive.current = true; reload(); return () => { alive.current = false; }; }, [reload]);
  const data = status.state === 'resolved' ? status.value : status.state === 'failed' ? status.stale : null;
  return { status, data, err: status.state === 'failed' ? status.err : null, loading, reload };
}

/** `in 3 h` / `5 min ago` from chain seconds. */
export function relAt(at: number | null | undefined, nowMs = Date.now()): string {
  if (at == null) return '—';
  if (Math.abs(at * 1000 - nowMs) < 45_000) return copy('time.justnow');
  const s = spanOf(at, nowMs);
  return copy(`time.${s.past ? 'ago' : 'in'}.${s.unit}`, { n: s.n });
}

/** A seller as the buyer sees it: by its identity on chain. */
export const sellerName = (identityId: number): string => copy('seller.name', { id: identityId });

/** Open another marketplace tab in the centre panel. */
export function useMarketplaceNav(): (tab: keyof typeof MARKETPLACE_TABS) => void {
  return (tab) => {
    const t = MARKETPLACE_TABS[tab];
    chooseTab({ id: t.id, label: t.label, closable: true });
  };
}
