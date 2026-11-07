// PurchaseFlow renders ONE purchase through its states: draft → frozen terms
// → sign the binding → pay each seller → confirmations → enroll → active. In
// this step it is look-only: it renders whichever phase the purchase it is
// given is in, reads the catalog and the operations wallet from the fixture
// data module, takes the connected wallet from the shared wallet store, and
// its action controls do nothing (no node, wallet prompt or transfer).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceData, noAction } from '../data.js';
import {
  OPEN_STATES, hasAnyTxHash,
  type Catalog, type ChainInfo, type PaymentRecord, type PurchaseIntent, type PurchaseKind, type PurchaseLine,
} from '../types.js';
import { useWalletStore } from '../../stores/wallet.js';
// The connect control Publisher Conviction uses, from the same shared wallet store.
import { WalletConnectControl } from '../../components/Pca/index.js';
import { DEFAULT_TRAC_USD } from '../format.js';
import { Composer, allocMicroOf, cheapestSeller, offerAvailable, periodKeyOf, OpenIntentButton, type ComposerLine, type ComposerPreview, type PeriodKey } from './Composer.js';
import { ConfirmGate } from './ConfirmGate.js';
import { ProgressSteps, type ConfirmSub } from './ProgressSteps.js';
import { IdentityStrip } from './IdentityStrip.js';
import { RevenueWalletConfirm } from './RevenueWalletConfirm.js';
import { SellerForm } from './SellerForm.js';
import { ErrorCard, attestBlockedKey, describeError, enrollErrorOf, fmtClock, relTime, shortAddr, tracFromMicro, unitWord, usdFromMicro } from './shared.js';

export interface PurchaseFlowProps {
  kind: PurchaseKind;
  /** Resume an open purchase at its current step. */
  intent?: PurchaseIntent | null;
  /** Never-subscribed onboarding: starter card first. */
  starter?: boolean;
  /** Prefill for `new-period` (the last period + pending switches) or queued "Add to plan" lines. */
  prefill?: { lines?: Array<{ offeringId: string; seller: string; allocationMicroTrac?: number }>; periodMs?: number; noteKey?: string; noteVars?: Record<string, string | number> };
  /** `kind:'topup' | 'addon'`: the (offering, seller) line, the allowance to extend or the line to add to the
   *  active plan (`expiresAt` = the plan's end, shown on the add-on form and done step). */
  topUp?: { planId: string | null; offeringId: string; seller: string; unit: string; expiresAt?: string } | null;
  /** A next-period draft while the current period runs: its terms open after this time. */
  termsLocked?: { untilIso: string } | null;
  catalog?: Catalog | null;
  fx?: number | null;
  onActivated?: (intent: PurchaseIntent) => void;
  onClosed?: () => void;
}

type Phase = 'compose' | 'gate' | 'sign' | 'pay' | 'confirming' | 'enroll' | 'active' | 'cancelled' | 'expired';


function phaseOf(i: PurchaseIntent | null, gate: boolean): Phase {
  if (!i) return 'compose';
  switch (i.state) {
    case 'draft': return 'compose';
    case 'terms_frozen': return gate ? 'gate' : 'compose';
    case 'binding_required': return 'sign';
    case 'binding_signed': case 'paying': case 'wallet_rejected': case 'payment_failed': return 'pay';
    case 'payment_confirming': return 'confirming';
    case 'payment_confirmed': case 'plan_built': case 'enrolling': case 'enrollment_blocked': return 'enroll';
    case 'active': return 'active';
    case 'cancelled': return 'cancelled';
    case 'expired': return 'expired';
  }
}

const lc = (s: string | null | undefined) => (s ?? '').toLowerCase();
const paymentOf = (i: PurchaseIntent, seller: string): PaymentRecord | null => {
  const k = Object.keys(i.payments ?? {}).find((x) => lc(x) === lc(seller));
  return k ? i.payments[k] : null;
};
const sellersOf = (i: PurchaseIntent): string[] => Object.keys(i.frozen?.sellers ?? {});
const kindKey = (k: PurchaseKind) => `purchase.kind.${k}`;

const toLines = (ls: ComposerLine[]): PurchaseLine[] =>
  ls.map((l) => ({ offeringId: l.offeringId, seller: l.seller, allocationMicroTrac: allocMicroOf(l.allocTrac) })).filter((l) => l.allocationMicroTrac > 0);

/** Sellers whose revenue wallet still needs the operator's confirmation. */
function unpinnedSellers(i: PurchaseIntent | null, fromTerms: boolean | string[] | undefined): string[] {
  if (!i?.frozen) return [];
  const all = sellersOf(i);
  const out = new Set<string>();
  const flag = fromTerms ?? i.revenueWalletUnpinned;
  if (flag === true) all.forEach((s) => out.add(lc(s)));
  if (Array.isArray(flag)) flag.forEach((s) => out.add(lc(s)));
  for (const s of all) if (i.frozen.sellers[s]?.revenueWalletUnpinned) out.add(lc(s));
  return [...out];
}
function confirmedSellers(i: PurchaseIntent | null): string[] {
  if (!i) return [];
  const out = new Set<string>(Object.keys(i.revenueWalletConfirmations ?? {}).map(lc));
  for (const s of sellersOf(i)) {
    if (i.frozen?.sellers[s]?.revenueWalletConfirmed) out.add(lc(s));
    if (paymentOf(i, s)?.revenueWalletConfirmed) out.add(lc(s));
  }
  return [...out];
}

export function PurchaseFlow(props: PurchaseFlowProps): React.ReactElement {
  const { kind } = props;
  const address = useWalletStore((s) => s.address);
  const provider = useWalletStore((s) => s.provider);
  const walletChainId = useWalletStore((s) => s.chainId);
  const disconnect = useWalletStore((s) => s.disconnect);
  const w = { address, chainId: walletChainId, connected: !!address && !!provider, disconnect };
  const fx = props.fx ?? DEFAULT_TRAC_USD;

  const [intent, setIntent] = useState<PurchaseIntent | null>(props.intent ?? null);
  const resumed = !!props.intent;
  const [chain] = useState<ChainInfo | null>(null);
  const [gate, setGate] = useState<boolean>(props.intent?.state === 'terms_frozen');
  const busy = null as null | 'freeze' | 'sign' | 'pay' | 'advance' | 'recover' | 'cancel' | 'shrink' | 'mint' | 'load' | 'confirm' | 'enroll' | 'ack';
  const [err, setErr] = useState<unknown | null>(null);
  const pollErr = null as unknown | null;

  const [catalog, setCatalog] = useState<Catalog | null>(props.catalog ?? null);
  const [catalogErr, setCatalogErr] = useState<unknown | null>(null);
  const [opsWallet, setOpsWallet] = useState<string | null>(null);
  const [sellerFormOpen, setSellerFormOpen] = useState(false);

  const [mode, setMode] = useState<'starter' | 'compose'>(props.starter && !props.intent ? 'starter' : 'compose');
  const [lines, setLines] = useState<ComposerLine[]>(() =>
    (props.prefill?.lines ?? props.intent?.lines ?? []).map((l) => ({ offeringId: l.offeringId, seller: l.seller, allocTrac: l.allocationMicroTrac ? tracFromMicro(l.allocationMicroTrac) : '1' })));
  const [period, setPeriod] = useState<PeriodKey>(periodKeyOf(props.prefill?.periodMs ?? props.intent?.periodMs));
  const [topAmount, setTopAmount] = useState('1');

  const [rwOpen, setRwOpen] = useState<string | null>(null);
  const candidates = useRef<Record<string, Array<{ txHash: string; amountWei?: string; amountMicroTrac?: number; blockNumber?: number }>>>({}).current;
  const [hashInput, setHashInput] = useState<Record<string, string>>({});
  const scannedEmpty = useRef<Record<string, boolean>>({}).current;
  const [ackReason, setAckReason] = useState('');
  const [minted, setMinted] = useState<{ plaintext: string; keyId: string } | null>(null);
  const [keyLabel, setKeyLabel] = useState('my-agent');
  const [keyBudget, setKeyBudget] = useState<string>('');

  const phase = phaseOf(intent, gate);

  // ── loads: the catalog (composer) and the node's operations wallet (identity strip) ──
  const loadCatalog = () => {
    setCatalogErr(null);
    marketplaceData.catalog().then(setCatalog).catch((e) => setCatalogErr(e));
  };
  useEffect(() => { if (!props.catalog && kind !== 'topup' && kind !== 'addon') loadCatalog(); }, [props.catalog, kind]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (props.catalog) setCatalog(props.catalog); }, [props.catalog]);
  useEffect(() => { marketplaceData.operationsWallet().then(setOpsWallet).catch(() => setOpsWallet(null)); }, []);
  useEffect(() => { if (props.intent) { setIntent(props.intent); setGate(props.intent.state === 'terms_frozen'); } }, [props.intent]);

  // The composer's ceilings come from the node's frozen terms; without a node
  // they stay at their "appear after confirmation" line.
  const preview: ComposerPreview = useMemo(() => ({
    intent: null,
    status: props.termsLocked ? 'locked' : toLines(lines).length === 0 ? 'idle' : !w.connected ? 'nowallet' : 'idle',
    err: null,
  }), [props.termsLocked, lines, w.connected]);

  const unpinned = useMemo(() => unpinnedSellers(intent, undefined), [intent]);
  const confirmed = useMemo(() => confirmedSellers(intent), [intent]);
  const needsRw = (seller: string) => unpinned.includes(lc(seller)) && !confirmed.includes(lc(seller));

  // ── actions: visible and enabled, and none of them runs anything yet ──
  const run = (_b: typeof busy, _fn: () => Promise<void>) => noAction();
  const onConfirmPlan = noAction;
  const refreshTerms = noAction;
  const confirm = noAction;
  const sign = noAction;
  const retryLast = noAction;
  const payOne = (_seller: string) => noAction();
  const advanceNow = noAction;
  const switchNetwork = noAction;
  const confirmRw = (_seller: string, _revenueWallet: string) => noAction();
  const recover = (_seller: string, _opts: { txHash?: string; attest?: 'no_payment_sent' }) => noAction();
  const shrink = (_seller: string) => noAction();
  const retryEnrollment = (_seller: string) => noAction();
  const acknowledge = noAction;
  const cancel = noAction;
  const startLine = noAction;
  const mint = noAction;
  const openExisting = (_id: string) => noAction();
  const startOver = () => { setIntent(null); setGate(false); setErr(null); setMode(props.starter ? 'starter' : 'compose'); props.onClosed?.(); };
  void run; void setMinted;

  // ── starter: every available offering, cheapest provider each ──
  const starterLines = useMemo<ComposerLine[]>(() => {
    if (!catalog) return [];
    const seen = new Set<string>(); const out: ComposerLine[] = [];
    for (const row of catalog.shelves) for (const o of row.offers ?? []) {
      if (seen.has(o.offeringId) || !offerAvailable(row, o)) continue;
      const s = cheapestSeller(catalog, o.offeringId); if (!s) continue;
      seen.add(o.offeringId); out.push({ offeringId: o.offeringId, seller: s, allocTrac: '1' });
    }
    return out;
  }, [catalog]);
  const defaultKeyBudget = String((intent?.lines ?? []).reduce((s, l) => s + l.allocationMicroTrac, 0) || 1_000_000);

  // ── render ──
  const errDesc = err ? describeError(err) : null;
  const errNeedsTerms = !!errDesc && ['E_TERMS_STALE', 'E_TERMS_CHANGED', 'E_TERMS_EXPIRED', 'E_ASK_MISMATCH'].includes(errDesc.code ?? '');
  const canCancel = !!intent && OPEN_STATES.has(intent.state) && !hasAnyTxHash(intent);
  const cancelDisabledKey = intent && !canCancel ? 'purchase.cancel.blocked' : null;
  const sub: ConfirmSub = phase === 'gate' ? 'confirm' : phase === 'sign' ? 'sign' : phase === 'pay' ? 'pay' : phase === 'confirming' ? 'confirming' : phase === 'enroll' ? 'enroll' : null;
  void sub;

  const walletLine = w.connected ? (
    <div className="mkt-mhead mkt-xs" data-testid="mkt-wallet-line">
      <span><span data-copy="wallet.connected">{copy('wallet.connected')}</span>{' '}<span className="mkt-mono" title={w.address ?? ''} data-copy="_data">{shortAddr(w.address)}</span></span>
      <button type="button" className="mkt-linkbtn" data-copy="wallet.disconnect" onClick={w.disconnect}>{copy('wallet.disconnect')}</button>
    </div>
  ) : (
    <div className="mkt-walletcard" data-testid="mkt-wallet-connect">
      <strong data-copy="wallet.connect">{copy('wallet.connect')}</strong>
      <p className="mkt-muted mkt-xs" data-copy="wallet.connect.note">{copy('wallet.connect.note')}</p>
      <WalletConnectControl className="compact" />
    </div>
  );

  const resumeBanner = resumed && intent && OPEN_STATES.has(intent.state) ? (
    <div className="mkt-notice" role="status" data-testid="mkt-resume-banner">
      <strong data-copy="purchase.resume.title">{copy('purchase.resume.title')}</strong>{' '}
      <span data-copy="purchase.resume.body">{copy('purchase.resume.body', { kind: copy(kindKey(intent.kind)), t: relTime(intent.createdAt) })}</span>{' '}
      <button type="button" className="mkt-linkbtn" data-testid="mkt-cancel-resume" data-copy="purchase.cancel" onClick={cancel}
        disabled={!canCancel || !!busy} title={cancelDisabledKey ? copy(cancelDisabledKey) : undefined}>{copy('purchase.cancel')}</button>
      {cancelDisabledKey && <span className="mkt-muted mkt-xs" data-copy={cancelDisabledKey}>{copy(cancelDisabledKey)}</span>}
    </div>
  ) : null;

  const errCard = err ? (
    <ErrorCard err={err} onRetry={errNeedsTerms ? refreshTerms : errDesc?.retryable ? retryLast : undefined}
      retryKey={errNeedsTerms ? 'purchase.terms.again' : errDesc?.code === 'wrong_network' ? 'wallet.switch' : 'ctl.retry'}>
      <OpenIntentButton err={err} onOpenIntent={openExisting} />
    </ErrorCard>
  ) : null;

  const nodeErrorCard = intent?.error && phase !== 'compose' && phase !== 'gate' && !err ? (
    <div className="mkt-errcard" role="alert" data-testid="mkt-intent-error" data-code={intent.error.code}>
      <div data-copy={intent.error.code === 'E_TERMS_STALE' ? 'purchase.terms.stale' : 'purchase.error.node'}>
        {intent.error.code === 'E_TERMS_STALE' ? copy('purchase.terms.stale') : copy('purchase.error.node')}
      </div>
      <div className="mkt-fork">
        {intent.error.code === 'E_TERMS_STALE'
          ? <button type="button" className="mkt-btn" data-copy="purchase.terms.again" onClick={refreshTerms} disabled={!!busy}>{copy('purchase.terms.again')}</button>
          : intent.error.retryable && <button type="button" className="mkt-btn" data-copy="ctl.retry" onClick={advanceNow} disabled={!!busy}>{copy('ctl.retry')}</button>}
        <span className="mkt-muted mkt-xs"><span data-copy="purchase.error.code">{copy('purchase.error.code')}</span>{' '}<span className="mkt-mono" data-copy="_data">{intent.error.code}</span>{intent.error.detail ? <span data-copy="_data"> · {intent.error.detail}</span> : null}</span>
      </div>
    </div>
  ) : null;

  const pollErrCard = pollErr && !err ? <ErrorCard err={pollErr} onRetry={advanceNow} /> : null;

  const sellerFormNode = sellerFormOpen ? (
    <SellerForm onSaved={() => { loadCatalog(); }} onCancel={() => setSellerFormOpen(false)} />
  ) : (
    <button type="button" className="mkt-linkbtn mkt-xs" data-testid="mkt-add-seller" data-copy="seller.add" onClick={() => setSellerFormOpen(true)}>{copy('seller.add')}</button>
  );

  // compose ────────────────────────────────────────────────────────────────
  if (phase === 'compose') {
    if ((kind === 'topup' || kind === 'addon') && props.topUp) {
      const micro = allocMicroOf(topAmount);
      // the add-on form mirrors the top-up form: one amount, one provider, the plan's end named
      const addon = kind === 'addon';
      const expiresAt = props.topUp.expiresAt ?? intent?.frozen?.plan?.expiresAt;
      const k = addon
        ? { form: 'mkt-addon-form', amount: 'mkt-addon-amount', submit: 'mkt-addon-cta', title: 'plans.addon.title', body: 'plans.addon.body', label: 'plans.addon.amount', cta: 'plans.addon.cta' }
        : { form: 'mkt-topup-form', amount: 'mkt-topup-amount', submit: 'mkt-topup-cta', title: 'plans.topup.title', body: 'plans.topup.body', label: 'plans.topup.amount', cta: 'plans.topup.cta' };
      const bodyVars: Record<string, string> = addon ? { seller: shortAddr(props.topUp.seller), t: fmtClock(expiresAt) } : { seller: shortAddr(props.topUp.seller) };
      return (
        <div className="mkt-card" data-testid={k.form}>
          <h2 data-copy={k.title}>{copy(k.title, { offering: props.topUp.offeringId })}</h2>
          <p className="mkt-muted mkt-sm" data-copy={k.body}>{copy(k.body, bodyVars)}</p>
          {walletLine}
          <label className="mkt-alloc">
            <span data-copy={k.label}>{copy(k.label)}</span>{' '}
            <input type="number" min="0" step="0.1" inputMode="decimal" value={topAmount} data-testid={k.amount} aria-label={copy(k.label)} onChange={(e) => setTopAmount(e.target.value)} />
            {' '}<span data-copy="composer.allocation.trac">{copy('composer.allocation.trac')}</span>
            <span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{micro > 0 ? `${usdFromMicro(micro, fx)} · ${copy('catalog.fx.reference.short')}` : copy('composer.allocation.zero')}</span>
          </label>
          {errCard}
          <div className="mkt-fork">
            <button type="button" className="mkt-btn mkt-btn--primary" data-testid={k.submit} data-copy={k.cta} onClick={startLine}
              disabled={!w.connected || micro <= 0 || !!busy} title={!w.connected ? copy('wallet.none') : micro <= 0 ? copy('composer.allocation.zero') : undefined}>
              {busy ? copy('state.working') : copy(k.cta)}
            </button>
            {!w.connected && <span className="mkt-muted mkt-xs" data-copy="wallet.none">{copy('wallet.none')}</span>}
            <button type="button" className="mkt-btn" data-copy="gate.cancel" onClick={startOver}>{copy('gate.cancel')}</button>
          </div>
        </div>
      );
    }
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        {props.starter && <h1 className="mkt-h1" data-copy="onboard.p5.title">{copy('onboard.p5.title')}</h1>}
        <ProgressSteps step={1} />
        {resumeBanner}
        {mode === 'starter' ? (
          <div className="mkt-card" data-testid="mkt-starter">
            <h2 data-copy="onboard.sub.title">{copy('onboard.sub.title')}</h2>
            <p className="mkt-sec mkt-sm" data-copy="onboard.sub.body">{copy('onboard.sub.body')}</p>
            {catalogErr ? <ErrorCard err={catalogErr} onRetry={loadCatalog} retryKey="catalog.retry" /> : null}
            {!catalog && !catalogErr && <div className="mkt-muted" data-copy="state.loading">{copy('state.loading')}</div>}
            {catalog && starterLines.length === 0 && <div className="mkt-muted" data-copy="onboard.starter.none">{copy('onboard.starter.none')}</div>}
            {starterLines.length > 0 && (
              <div className="mkt-starter">
                <strong data-copy="onboard.starter.title">{copy('onboard.starter.title')}</strong>
                <div className="mkt-sec mkt-sm" data-copy="onboard.starter.body">
                  {copy('onboard.starter.body', {
                    offerings: starterLines.map((l) => l.offeringId).join(' + '),
                    providers: [...new Set(starterLines.map((l) => lc(l.seller)))].map(shortAddr).join(' · '),
                  })}
                </div>
                <div className="mkt-fork">
                  <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-starter-choose" data-copy="onboard.sub.cta"
                    onClick={() => { setLines(starterLines); setMode('compose'); }}>{copy('onboard.sub.cta')}</button>
                  <button type="button" className="mkt-linkbtn" data-testid="mkt-starter-customize" data-copy="onboard.customize"
                    onClick={() => setMode('compose')}>{copy('onboard.customize')}</button>
                </div>
              </div>
            )}
            {sellerFormNode}
          </div>
        ) : (
          <>
            {props.prefill?.noteKey && <div className="mkt-muted mkt-xs" data-copy={props.prefill.noteKey}>{copy(props.prefill.noteKey, props.prefill.noteVars)}</div>}
            {walletLine}
            <Composer catalog={catalog} catalogErr={catalogErr} onCatalogRetry={loadCatalog} lines={lines} period={period}
              onChange={(ls, p) => { setLines(ls); setPeriod(p); }} preview={preview} onConfirmPlan={onConfirmPlan} busy={!!busy}
              walletConnected={w.connected} fx={fx} onOpenIntent={openExisting} lockedUntil={props.termsLocked?.untilIso ?? null} />
            {sellerFormNode}
            {errCard}
          </>
        )}
      </div>
    );
  }

  // every later phase needs the intent
  if (!intent) return <div className="mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div>;
  const sellers = sellersOf(intent);

  // gate ───────────────────────────────────────────────────────────────────
  if (phase === 'gate') {
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        <ProgressSteps step={2} sub="confirm" />
        {resumeBanner}
        {!w.connected && walletLine}
        {unpinned.length > 0 && (
          <div className="mkt-notice mkt-xs" role="status" data-testid="mkt-rw-unpinned-note">
            <span data-copy="purchase.revenue.unpinned.note">{copy('purchase.revenue.unpinned.note', { sellers: unpinned.map(shortAddr).join(' · ') })}</span>
          </div>
        )}
        <ConfirmGate intent={intent} chain={chain} opsWallet={opsWallet} walletChainId={w.chainId} fx={fx} busy={!!busy} err={err}
          onConfirm={confirm} onCancel={canCancel ? cancel : () => undefined} onRetry={errNeedsTerms ? refreshTerms : errDesc?.retryable ? retryLast : undefined}
          onSwitchNetwork={switchNetwork} onRefreshTerms={refreshTerms} cancelDisabledKey={cancelDisabledKey} />
      </div>
    );
  }

  const stripSellers = sellers.map((s) => ({ seller: s, revenueWallet: intent.frozen?.sellers[s]?.revenueWallet ?? null }));

  // sign ───────────────────────────────────────────────────────────────────
  if (phase === 'sign') {
    const paidElsewhere = hasAnyTxHash(intent);
    const buyerMismatch = !!w.address && !!intent.buyer && lc(w.address) !== lc(intent.buyer);
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        <ProgressSteps step={2} sub="sign" />
        {resumeBanner}
        <div className="mkt-card" data-testid="mkt-sign-step">
          <h2 data-copy="purchase.sign.title">{copy('purchase.sign.title')}</h2>
          <p className="mkt-sec mkt-sm" data-copy="purchase.sign.body">{copy('purchase.sign.body')}</p>
          {paidElsewhere && <p className="mkt-notice" data-copy="purchase.sign.resign">{copy('purchase.sign.resign')}</p>}
          <IdentityStrip opsWallet={opsWallet} buyer={intent.buyer} sellers={stripSellers} />
          {!w.connected && walletLine}
          {buyerMismatch && (
            <div className="mkt-notice" role="status">
              <span data-copy="wallet.drift.account">{copy('wallet.drift.account')}</span>{' '}
              <span className="mkt-mono mkt-xs" data-copy="_data">{shortAddr(intent.buyer)}</span>{' '}
              <button type="button" className="mkt-linkbtn" data-copy="wallet.disconnect" onClick={w.disconnect}>{copy('wallet.disconnect')}</button>
            </div>
          )}
          <details className="mkt-xs">
            <summary data-copy="purchase.sign.statement">{copy('purchase.sign.statement')}</summary>
            <pre className="mkt-snippet" data-testid="mkt-binding-statement" data-copy="_data">{intent.bindingStatement ?? '—'}</pre>
          </details>
          {nodeErrorCard}{errCard}{pollErrCard}
          <div className="mkt-fork">
            <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-sign" data-copy="purchase.sign.cta" onClick={sign}
              disabled={!!busy || !w.connected || buyerMismatch || !intent.bindingStatement}
              title={!w.connected ? copy('wallet.none') : buyerMismatch ? copy('wallet.drift.account') : !intent.bindingStatement ? copy('purchase.terms.missing') : undefined}>
              {busy === 'sign' ? copy('purchase.pay.sending') : copy('purchase.sign.cta')}
            </button>
            {!intent.bindingStatement && <button type="button" className="mkt-btn" data-copy="purchase.terms.again" onClick={refreshTerms} disabled={!!busy}>{copy('purchase.terms.again')}</button>}
            <button type="button" className="mkt-btn" data-testid="mkt-cancel" data-copy="purchase.cancel" onClick={cancel} disabled={!canCancel || !!busy} title={cancelDisabledKey ? copy(cancelDisabledKey) : undefined}>{copy('purchase.cancel')}</button>
            {cancelDisabledKey && <span className="mkt-muted mkt-xs" data-copy={cancelDisabledKey}>{copy(cancelDisabledKey)}</span>}
          </div>
        </div>
      </div>
    );
  }

  // pay ────────────────────────────────────────────────────────────────────
  if (phase === 'pay') {
    const prompted = sellers.find((s) => paymentOf(intent, s)?.state === 'prompted') ?? null;
    const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        <ProgressSteps step={2} sub="pay" />
        {resumeBanner}
        <div className="mkt-card" data-testid="mkt-pay-step">
          <h2 data-copy="purchase.pay.title">{copy('purchase.pay.title')}</h2>
          <IdentityStrip opsWallet={opsWallet} buyer={intent.buyer} sellers={stripSellers} />
          {!w.connected && walletLine}
          {sellers.map((seller) => {
            const fs = intent.frozen!.sellers[seller];
            const p = paymentOf(intent, seller);
            const st = p?.state ?? 'pending';
            const isNext = !!intent.nextPaySeller && lc(intent.nextPaySeller) === lc(seller);
            const blockedByOther = !!prompted && lc(prompted) !== lc(seller);
            const rw = needsRw(seller);
            const canPay = (st === 'pending' || st === 'rejected' || st === 'failed') && !blockedByOther && w.connected;
            const payReasonKey = !w.connected ? 'wallet.none' : blockedByOther ? 'purchase.pay.inflight' : null;
            const hash = (hashInput[seller] ?? '').trim();
            const attestOk = p?.attestAllowed === true || !!scannedEmpty[lc(seller)];
            const attestReasonKey = p?.attestAllowed === true ? null : p?.attestBlockedReason ? attestBlockedKey(p.attestBlockedReason) : scannedEmpty[lc(seller)] ? null : 'purchase.recover.none.gate';
            const cands = candidates[lc(seller)] ?? [];
            return (
              <div key={seller} className="mkt-payrow" data-testid={`mkt-pay-row-${lc(seller)}`} data-state={st}>
                <div className="mkt-mhead">
                  <span className="mkt-mono" data-copy="purchase.pay.line">{copy('purchase.pay.line', { amount: tracFromMicro(fs.amountMicroTrac), seller: shortAddr(seller) })}
                    <span className="mkt-muted mkt-xs" data-copy="_data"> → {shortAddr(fs.revenueWallet)} · {usdFromMicro(fs.amountMicroTrac, fx)}</span></span>
                  <PayState p={p} />
                </div>
                {rwOpen && lc(rwOpen) === lc(seller) ? (
                  <RevenueWalletConfirm seller={seller} revenueWallet={fs.revenueWallet} busy={busy === 'confirm'} err={busy === 'confirm' ? null : err}
                    onConfirm={(rwAddr) => confirmRw(seller, rwAddr)} onCancel={() => setRwOpen(null)} />
                ) : null}
                {(st === 'pending' || st === 'rejected' || st === 'failed') && !(rwOpen && lc(rwOpen) === lc(seller)) && (
                  <div className="mkt-fork">
                    <button type="button" className={`mkt-btn${isNext || !intent.nextPaySeller ? ' mkt-btn--primary' : ''}`} data-testid={`mkt-pay-${lc(seller)}`} data-copy={rw ? 'purchase.revenue.confirm.cta' : 'purchase.pay.cta'}
                      onClick={() => (rw ? setRwOpen(seller) : payOne(seller))} disabled={!canPay || !!busy} title={payReasonKey ? copy(payReasonKey) : rw ? copy('purchase.revenue.confirm.gate') : undefined}>
                      {busy === 'pay' && isNext ? copy('purchase.pay.sending') : rw ? copy('purchase.revenue.confirm.cta') : copy('purchase.pay.cta', { seller: shortAddr(seller) })}
                    </button>
                    {payReasonKey && <span className="mkt-muted mkt-xs" data-copy={payReasonKey}>{copy(payReasonKey)}</span>}
                    {rw && !payReasonKey && <span className="mkt-muted mkt-xs" data-copy="purchase.revenue.confirm.gate">{copy('purchase.revenue.confirm.gate')}</span>}
                    {(st === 'rejected' || st === 'failed') && sellers.length > 1 && !p?.txHash && (
                      <button type="button" className="mkt-linkbtn" data-testid={`mkt-shrink-${lc(seller)}`} data-copy="purchase.shrink" onClick={() => shrink(seller)} disabled={!!busy}>
                        {copy('purchase.shrink', { seller: shortAddr(seller) })}
                      </button>
                    )}
                  </div>
                )}
                {st === 'prompted' && (
                  <div className="mkt-recover" data-testid={`mkt-recover-${lc(seller)}`}>
                    <strong data-copy="purchase.recover.title">{copy('purchase.recover.title')}</strong>
                    <p className="mkt-muted mkt-xs" data-copy="purchase.recover.body">{copy('purchase.recover.body')}</p>
                    <div className="mkt-fork">
                      <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-recover-chain" data-copy="purchase.recover.chain" onClick={() => recover(seller, {})} disabled={!!busy}>{copy('purchase.recover.chain')}</button>
                      <input className="mkt-input mkt-mono" data-testid="mkt-recover-hash-input" placeholder={copy('purchase.recover.hash.placeholder')} aria-label={copy('purchase.recover.hash')}
                        value={hashInput[seller] ?? ''} onChange={(e) => setHashInput((h) => ({ ...h, [seller]: e.target.value }))} />
                      <button type="button" className="mkt-btn" data-testid="mkt-recover-hash" data-copy="purchase.recover.hash" onClick={() => recover(seller, { txHash: hash })}
                        disabled={!!busy || !HASH_RE.test(hash)} title={HASH_RE.test(hash) ? undefined : copy('purchase.recover.hash.invalid')}>{copy('purchase.recover.hash')}</button>
                      <button type="button" className="mkt-btn" data-testid="mkt-recover-none" data-copy="purchase.recover.none" onClick={() => recover(seller, { attest: 'no_payment_sent' })}
                        disabled={!!busy || !attestOk} title={attestOk ? undefined : copy(attestReasonKey ?? 'purchase.recover.none.gate')}>{copy('purchase.recover.none')}</button>
                    </div>
                    {!attestOk && attestReasonKey && <span className="mkt-muted mkt-xs" data-testid="mkt-attest-reason" data-copy={attestReasonKey}>{copy(attestReasonKey)}</span>}
                    {cands.length > 0 && (
                      <div className="mkt-candidates" data-testid="mkt-candidates">
                        <strong className="mkt-xs" data-copy="purchase.recover.candidates">{copy('purchase.recover.candidates')}</strong>
                        <ul className="mkt-xs mkt-mono">
                          {cands.map((cd) => (
                            <li key={cd.txHash} data-copy="purchase.recover.candidate">
                              {copy('purchase.recover.candidate', { tx: shortAddr(cd.txHash), amount: cd.amountMicroTrac != null ? tracFromMicro(cd.amountMicroTrac) : cd.amountWei ? tracFromMicro(Number(BigInt(cd.amountWei) / 1_000_000_000_000n)) : '—', block: cd.blockNumber ?? '—' })}
                            </li>
                          ))}
                        </ul>
                        <span className="mkt-muted mkt-xs" data-copy="purchase.recover.unexpected">{copy('purchase.recover.unexpected')}</span>
                      </div>
                    )}
                    {sellers.length > 1 && !p?.txHash && (
                      <button type="button" className="mkt-linkbtn mkt-xs" data-testid={`mkt-shrink-${lc(seller)}`} data-copy="purchase.shrink" onClick={() => shrink(seller)} disabled={!!busy}>{copy('purchase.shrink', { seller: shortAddr(seller) })}</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {nodeErrorCard}{!(rwOpen && busy !== 'confirm' && err) ? errCard : null}{pollErrCard}
          <div className="mkt-fork">
            <button type="button" className="mkt-btn" data-testid="mkt-cancel" data-copy="purchase.cancel" onClick={cancel} disabled={!canCancel || !!busy} title={cancelDisabledKey ? copy(cancelDisabledKey) : undefined}>{copy('purchase.cancel')}</button>
            {cancelDisabledKey && <span className="mkt-muted mkt-xs" data-copy={cancelDisabledKey}>{copy(cancelDisabledKey)}</span>}
          </div>
        </div>
      </div>
    );
  }

  // confirming / enroll ────────────────────────────────────────────────────
  if (phase === 'confirming' || phase === 'enroll') {
    const blocked = intent.state === 'enrollment_blocked';
    const acknowledged = !!intent.acknowledged;
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        <ProgressSteps step={2} sub={phase} />
        {resumeBanner}
        <div className="mkt-card" data-testid={phase === 'confirming' ? 'mkt-confirming-step' : 'mkt-enroll-step'}>
          <h2 data-copy={phase === 'confirming' ? 'purchase.confirming.title' : 'purchase.enroll.title'}>{copy(phase === 'confirming' ? 'purchase.confirming.title' : 'purchase.enroll.title')}</h2>
          {sellers.map((seller) => {
            const p = paymentOf(intent, seller);
            const en = p?.enrollment;
            const ee = enrollErrorOf(en?.error);   // the seller's reply: plain words when the code has them, the code one reveal deeper
            return (
              <div key={seller} className="mkt-payrow" data-testid={`mkt-pay-row-${lc(seller)}`} data-state={p?.state ?? 'pending'} data-enroll={en?.state ?? ''}>
                <div className="mkt-mhead">
                  <span className="mkt-mono" data-copy="_data">{shortAddr(seller)}{p?.txHash ? <span className="mkt-muted mkt-xs"> · {shortAddr(p.txHash)}</span> : null}</span>
                  <PayState p={p} />
                </div>
                {phase === 'enroll' && (
                  <div className="mkt-xs" data-copy={`purchase.enroll.${en?.state ?? 'pending'}`}>
                    {copy(`purchase.enroll.${en?.state ?? 'pending'}`)}
                    {ee?.copyKey ? <span data-copy={ee.copyKey}> · {copy(ee.copyKey)}</span> : null}
                    {ee ? <span className="mkt-muted mkt-mono" data-copy="_data"> · {ee.code}{ee.detail ? ` — ${ee.detail}` : ''}</span> : null}
                  </div>
                )}
                {blocked && en?.state === 'blocked' && (
                  <div className="mkt-evidence mkt-xs" data-testid={`mkt-evidence-${lc(seller)}`}>
                    <strong data-copy="purchase.enroll.evidence">{copy('purchase.enroll.evidence')}</strong>
                    <div className="mkt-mono mkt-muted" data-copy="_data">tx {p?.txHash ?? '—'}{p?.logIndex != null ? ` · log ${p.logIndex}` : ''}{p?.identity ? ` · ${p.identity}` : ''}</div>
                    {ee ? <div className="mkt-mono mkt-errline" data-copy="_data">{ee.code}{ee.detail ? ` — ${ee.detail}` : ''}</div> : null}
                    {!acknowledged && (
                      <div className="mkt-fork">
                        <button type="button" className="mkt-btn mkt-btn--primary" data-testid={`mkt-retry-enroll-${lc(seller)}`} data-copy="purchase.enroll.retry.cta" onClick={() => retryEnrollment(seller)} disabled={!!busy}>
                          {busy === 'enroll' ? copy('state.working') : copy('purchase.enroll.retry.cta')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {blocked && (
            <div className="mkt-errcard" role="alert" data-testid="mkt-enroll-blocked">
              <span data-copy="purchase.enroll.blocked">{copy('purchase.enroll.blocked')}</span>
              {acknowledged ? (
                <span className="mkt-muted mkt-xs" data-copy="purchase.enroll.ack.done">{copy('purchase.enroll.ack.done')}</span>
              ) : (
                <div className="mkt-fork">
                  <label className="mkt-xs"><span data-copy="purchase.enroll.ack.reason">{copy('purchase.enroll.ack.reason')}</span>{' '}
                    <input className="mkt-input" data-testid="mkt-ack-reason" value={ackReason} onChange={(e) => setAckReason(e.target.value)} placeholder={copy('purchase.enroll.ack.default')} /></label>
                  <button type="button" className="mkt-btn" data-testid="mkt-ack-blocked" data-copy="purchase.enroll.ack.cta" onClick={acknowledge} disabled={!!busy}>
                    {busy === 'ack' ? copy('state.working') : copy('purchase.enroll.ack.cta')}
                  </button>
                </div>
              )}
            </div>
          )}
          {nodeErrorCard}{errCard}{pollErrCard}
          {!blocked && (
            <div className="mkt-fork">
              <button type="button" className="mkt-btn" data-testid="mkt-advance" data-copy="purchase.check.now" onClick={advanceNow} disabled={!!busy}>
                {busy === 'advance' ? copy('state.working') : copy('purchase.check.now')}
              </button>
              <span className="mkt-muted mkt-xs" data-copy="purchase.poll.note">{copy('purchase.poll.note')}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // active ─────────────────────────────────────────────────────────────────
  if (phase === 'active') {
    const units = (intent.addedUnits ?? 0).toLocaleString('en-US');
    const doneKey = kind === 'topup' ? 'purchase.topup.done' : kind === 'addon' ? 'purchase.addon.done' : 'purchase.active.title';
    const done = kind === 'topup' ? copy('purchase.topup.done', { units })
      : kind === 'addon' ? copy('purchase.addon.done', { offering: props.topUp?.offeringId ?? intent.topUp?.offeringId ?? '', units, unit: unitWord(props.topUp?.unit ?? 'tokens'), t: fmtClock(props.topUp?.expiresAt ?? intent.frozen?.plan?.expiresAt) })
      : copy('purchase.active.title');
    return (
      <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
        <ProgressSteps step={3} />
        <div className="mkt-card" data-testid="mkt-active-step">
          <h2 data-copy={doneKey}>{done}</h2>
          {kind === 'addon' && intent.error && (
            // the seller credited well-formed numbers that differ from the frozen line: booked as credited, shown here, never a dead end
            <div className="mkt-notice" role="status" data-testid="mkt-active-notice" data-code={intent.error.code}>
              <ErrorCard err={intent.error} />
            </div>
          )}
          {kind !== 'topup' && kind !== 'addon' && (
            <>
              <p className="mkt-sec mkt-sm" data-copy="purchase.active.body">{copy('purchase.active.body')}</p>
              <h3 data-copy="onboard.key.title">{copy('onboard.key.title')}</h3>
              <p className="mkt-muted mkt-xs" data-copy="onboard.key.body">{copy('onboard.key.body')}</p>
              {minted ? (
                <div className="mkt-card mkt-once" data-testid="mkt-key-once">
                  <div className="mkt-snippet" data-testid="mkt-key-plaintext" data-copy="_data">base_url = "{window.location.origin}/marketplace/gateway/v1"<br />api_key&nbsp;&nbsp;= "{minted.plaintext}"</div>
                  <div className="mkt-warnonce" data-copy="onboard.key.once">{copy('onboard.key.once')}</div>
                  <div className="mkt-muted mkt-xs" data-copy="onboard.key.covers">{copy('onboard.key.covers')}</div>
                  <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-key-done" data-copy="ctl.done" onClick={() => setMinted(null)}>{copy('ctl.done')}</button>
                </div>
              ) : (
                <div className="mkt-fork">
                  <label className="mkt-xs"><span data-copy="key.name.label">{copy('key.name.label')}</span>{' '}<input className="mkt-input" value={keyLabel} onChange={(e) => setKeyLabel(e.target.value)} /></label>
                  <label className="mkt-xs"><span data-copy="key.cap.label">{copy('key.cap.label')}</span>{' '}<input className="mkt-input mkt-mono" inputMode="numeric" value={keyBudget || defaultKeyBudget} onChange={(e) => setKeyBudget(e.target.value)} />{' '}<span data-copy="access.budget.micro">{copy('access.budget.micro')}</span></label>
                  <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-mint" data-copy="key.mint" onClick={mint} disabled={!!busy}>{busy === 'mint' ? copy('state.working') : copy('key.mint')}</button>
                </div>
              )}
            </>
          )}
          {errCard}
          <div className="mkt-fork">
            <button type="button" className="mkt-btn" data-testid="mkt-view-plan" data-copy="purchase.active.plans" onClick={() => props.onActivated?.(intent)}>{copy('purchase.active.plans')}</button>
          </div>
        </div>
      </div>
    );
  }

  // cancelled / expired ────────────────────────────────────────────────────
  return (
    <div className="mkt-flow" data-testid="mkt-purchase-flow" data-phase={phase}>
      <div className="mkt-card">
        <div data-copy={phase === 'cancelled' ? 'purchase.cancelled' : 'purchase.expired'}>{copy(phase === 'cancelled' ? 'purchase.cancelled' : 'purchase.expired')}</div>
        <div className="mkt-fork">
          {phase === 'expired' && <button type="button" className="mkt-btn mkt-btn--primary" data-copy="purchase.terms.again" onClick={refreshTerms} disabled={!!busy || !w.connected} title={!w.connected ? copy('wallet.none') : undefined}>{copy('purchase.terms.again')}</button>}
          <button type="button" className="mkt-btn" data-testid="mkt-startover" data-copy="purchase.startover" onClick={startOver}>{copy('purchase.startover')}</button>
        </div>
        {errCard}
      </div>
    </div>
  );
}

function PayState({ p }: { p: PaymentRecord | null }): React.ReactElement {
  const st = p?.state ?? 'pending';
  const key: Record<string, string> = {
    pending: 'purchase.pay.pending', prompted: 'purchase.pay.prompted', submitted: 'purchase.pay.submitted',
    confirming: 'chain.confirmations', confirmed: 'purchase.pay.paid', misdirected: 'purchase.pay.misdirected',
    rejected: 'purchase.pay.rejected', failed: 'purchase.pay.failed',
  };
  let k = key[st] ?? 'purchase.pay.pending';
  if (st === 'failed' && (p?.reason === 'dropped' || p?.reason === 'replaced')) k = `purchase.pay.failed.${p.reason}`;
  const vars: Record<string, string | number> = st === 'confirming' ? { n: p?.confirmations ?? 0, m: p?.required ?? '—' } : st === 'submitted' ? { tx: shortAddr(p?.txHash) } : {};
  const cls = st === 'confirmed' ? 'mkt-chipleft' : st === 'misdirected' || st === 'failed' || st === 'rejected' ? 'mkt-chipblock' : st === 'prompted' ? 'mkt-chipwarn' : 'mkt-muted mkt-xs';
  return (
    <span className={cls} data-copy={k} data-testid="mkt-pay-state" data-reason={p?.reason ?? ''}>
      {st === 'confirming' ? `${copy('chain.confirming')} ${copy(k, vars)}` : copy(k, vars)}
      {st === 'submitted' && p?.promptedAt ? <span className="mkt-muted" data-copy="_data"> · {fmtClock(p.promptedAt)}</span> : null}
    </span>
  );
}
