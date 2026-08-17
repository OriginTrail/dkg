// NSM v3.5 shared components — the single source for chips, gauges, badges,
// receipt rows, and model cards. Surfaces 02/03 and the Operate publish
// wizard's ListingPreview consume the SAME ModelCard/ProviderRow (spec 07:
// "one source of truth, zero drift"). Styling: 30-nsm-tokens.css (law) +
// 31-nsm-ui.css (layout); strings: copy.generated.ts only.
import React, { useEffect, useState } from 'react';
import { copy, COPY, CODE_TO_KEY, WITHHOLD_CODE } from './copy.generated.js';
import { fmtCompact, fmtCountdown, fmtHash, fmtMicro, fmtUsd, microToUsd, usdPer1M, fmtUsdRange } from './format.js';

export type LegState = 'checking' | 'verified' | 'pending' | 'blocked' | 'voided';

// ── chips ──

export function Chip({ state, children, title }: { state: LegState; children: React.ReactNode; title?: string }): React.ReactElement {
  return <span className={`chip chip--${state}`} title={title}>{children}</span>;
}

/** Lifecycle chip bound to leg.state exactly (spec 04). Icons are
 *  presentation; the words come from the state.* table verbatim. */
export function StateChip({ state, short = true }: { state: LegState; short?: boolean }): React.ReactElement {
  switch (state) {
    case 'checking': return <Chip state="checking">◌ {copy('state.checking')}</Chip>;
    case 'verified': return short
      ? <Chip state="verified">{copy('state.verified.short')}</Chip>
      : <Chip state="verified">✓ {copy('state.verified')}</Chip>;
    case 'pending': return <Chip state="pending">◷ {copy('state.pending.short')}</Chip>;
    case 'blocked': return <Chip state="blocked">⚠ {copy('state.blocked.short')}</Chip>;
    case 'voided': return <Chip state="voided">{copy('state.voided')}</Chip>;
  }
}

/** ⛓ / ☁ provenance badge; tooltip carries the prov.*.tip explainer. */
export function ProvBadge({ cls, withText = false }: { cls: string; withText?: boolean }): React.ReactElement {
  const pinned = cls === 'weights-pinned';
  const key = pinned ? 'prov.pinned' : 'prov.claimed';
  return (
    <span className={pinned ? 'badge--pinned' : 'badge--claimed'} title={copy(`${key}.tip`)}>
      {pinned ? '⛓' : '☁'}{withText ? ` ${copy(key)}` : ''}
    </span>
  );
}

// ── logos ──

const FAMILY_MONOGRAM: Record<string, string> = {
  qwen: 'Qw', openai: 'G5', deepseek: 'DS', meta: 'Me', mistral: 'Mi',
};

/** Local licensed asset when the CP3 pack lands; `.logo-monogram` fallback
 *  always (rule 8: never hotlink). */
export function ModelLogo({ family, displayName, size = 'md' }: { family: string; displayName: string; size?: 'sm' | 'md' | 'lg' }): React.ReactElement {
  const [imgOk, setImgOk] = useState(true);
  const known = family in FAMILY_MONOGRAM;
  const src = `/ui/assets/model-logos/${family}.svg`;
  if (known && imgOk) {
    return <img className={`logo--${size}`} src={src} alt="" aria-hidden onError={() => setImgOk(false)}
      style={{ borderRadius: 'var(--r-sm)' }} />;
  }
  const mark = FAMILY_MONOGRAM[family] ?? displayName.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) ?? '··';
  return <span className={`logo-monogram logo--${size}`}>{mark}</span>;
}

// ── gauges ──

export function RadialGauge({ pct, mode, children, title }: {
  pct: number; mode: 'low' | 'mid' | 'ready' | 'over'; children?: React.ReactNode; title?: string;
}): React.ReactElement {
  // sub-1% earnings must stay visible (spec 07: 0.03% without breakage) — a
  // minimum sliver, never zero once anything is earned
  const shown = pct > 0 ? Math.max(0.75, Math.min(100, pct)) : 0;
  return (
    <div className="gauge-wrap" title={title}>
      <div className="gauge-radial" style={{ ['--pct' as string]: shown, ['--fill' as string]: `var(--gauge-${mode})` }} />
      <div className="readout">{children}</div>
    </div>
  );
}

export function LinearGauge({ pct, mode = 'mid' }: { pct: number; mode?: 'low' | 'mid' | 'ready' | 'over' }): React.ReactElement {
  return (
    <div className={`gauge-linear${mode !== 'mid' ? ` is-${mode}` : ''}`}>
      <i style={{ width: `${Math.min(100, pct)}%` }} />
    </div>
  );
}

export function MiniBar({ billedMicro, totalMicro, title }: { billedMicro: number; totalMicro: number; title?: string }): React.ReactElement {
  const pct = totalMicro > 0 ? (billedMicro / totalMicro) * 100 : 0;
  return (
    <div className="minibar" title={title}>
      <span className="billed" style={{ width: `${Math.max(pct, billedMicro > 0 ? 1 : 0)}%` }} />
      <span style={{ flex: 1 }} />
    </div>
  );
}

// ── countdown ──

/** Live mm:ss until `deadlineMs` (epoch). Ticks every second. */
export function useCountdown(deadlineMs: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineMs == null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deadlineMs]);
  if (deadlineMs == null) return null;
  return fmtCountdown(deadlineMs - now);
}

// ── receipt drawer ──

export interface ReceiptLeg {
  legId: string;
  state: LegState;
  costMicro: number;
  counts?: { claimedIn: number; claimedOut: number; ourIn: number; ourOut: number };
  priceIn?: number; priceOut?: number;
  bytesDigest?: string;
  sellerSig?: string;
  countersig?: string;
  closeDigest?: string;
  chainUrl?: string;
  withholdCode?: string;
  claimedMicro?: number;
}

/** Every receipt.* row bound to the leg record; close/Basescan rows appear
 *  only when their data exists (spec 04). */
export function ReceiptDrawer({ leg, fxRate }: { leg: ReceiptLeg; fxRate: number }): React.ReactElement {
  const wKey = leg.withholdCode ? CODE_TO_KEY[leg.withholdCode] : undefined;
  return (
    <div className="drawer" style={{ padding: 'var(--sp-3)' }}>
      {leg.withholdCode && (
        <div className="drow"><span>{copy('receipt.reason')}</span><span className="v">{leg.withholdCode}</span></div>
      )}
      {leg.counts && (
        // receipt.counts uses {a}/{b} twice (claimed, then our count) —
        // sequential first-occurrence replaces fill them in order
        <div className="drow"><span>{COPY['receipt.counts']
          .replace('{a}/{b}', `${leg.counts.claimedIn}/${leg.counts.claimedOut}`)
          .replace('{a}/{b}', `${leg.counts.ourIn}/${leg.counts.ourOut}`)}</span></div>
      )}
      {leg.priceIn != null && leg.priceOut != null && (
        <div className="drow"><span>{copy('receipt.price')}</span><span className="v">{leg.priceIn} µ in · {leg.priceOut} µ out</span></div>
      )}
      {leg.withholdCode && leg.claimedMicro != null && (
        <>
          <div className="drow"><span>{copy('receipt.claimed')}</span><span className="v">{leg.claimedMicro} µTRAC</span></div>
          <div className="drow"><span>{copy('receipt.recount')}</span><span className="v">{leg.costMicro} µTRAC</span></div>
        </>
      )}
      {leg.bytesDigest && (
        <div className="drow"><span>{copy('receipt.bytes')}</span><span className="v">{fmtHash(leg.bytesDigest)}</span></div>
      )}
      {leg.sellerSig && (
        <div className="drow"><span>{copy('receipt.sig')}</span><span className="v">{fmtHash(leg.sellerSig)} ✓</span></div>
      )}
      {leg.countersig && (
        <div className="drow"><span>{copy('receipt.countersign')}</span><span className="v">{fmtHash(leg.countersig)}</span></div>
      )}
      {leg.closeDigest && (
        <div className="drow"><span>{copy('receipt.close', { digest: fmtHash(leg.closeDigest) })}</span></div>
      )}
      {leg.chainUrl && (
        <div className="drow"><span><a href={leg.chainUrl} target="_blank" rel="noreferrer">{copy('receipt.chain')} ↗</a></span></div>
      )}
      {wKey && (
        <div className="drow"><span className="xs muted">{copy('withhold.explain')}</span></div>
      )}
    </div>
  );
}

/** Per-message cost chip; tooltip = play.cost.tip with exact µTRAC + USD. */
export function CostChip({ micro, fxRate, voided = false, onClick }: { micro: number; fxRate: number; voided?: boolean; onClick?: () => void }): React.ReactElement {
  return (
    <span className={`cost-chip${voided ? ' is-voided' : ''}`} onClick={onClick}
      title={copy('play.cost.tip', { exactMicro: micro.toLocaleString('en-US'), usd: microToUsd(micro, fxRate).toFixed(5) })}>
      {fmtMicro(micro)}
    </span>
  );
}

// ── withhold plain-words body (plain first; code only in the drawer) ──

export function WithholdBody({ code }: { code: string }): React.ReactElement {
  const key = CODE_TO_KEY[code];
  return (
    <div className="withhold-body">
      {key ? copy(key) : copy('state.blocked.short')}
      <div className="xs muted" style={{ marginTop: 'var(--sp-1)' }}>{copy('withhold.explain')}</div>
    </div>
  );
}

// ── model catalog card (shared with ListingPreview) ──

export interface CatalogProvider {
  addr: string; label?: string; inMicro: number; outMicro: number;
  /** raw offering modelId — what the gateway routes on */
  modelId?: string;
  class: string; via: string; up: boolean;
  ttftMs?: number | null; tokS?: number | null;
  rep?: { verified: number; disputed: number };
}

export interface CatalogModel {
  modelRef: string; displayName: string; family: string; modality: string;
  contextLength: number; quantization?: string;
  providers: CatalogProvider[]; settledTokens: number; trend?: string;
}

export function ModelCard({ model, fxRate, onOpen }: { model: CatalogModel; fxRate: number; onOpen?: () => void }): React.ReactElement {
  // price renders ONLY from providers with a verified live quote (finite µ)
  const priced = model.providers.filter((p) => Number.isFinite(p.inMicro) && Number.isFinite(p.outMicro));
  const usd = priced.map((p) => usdPer1M(p.inMicro, p.outMicro, fxRate));
  const classes = [...new Set(model.providers.map((p) => p.class))];
  const ins = [...new Set(priced.map((p) => p.inMicro))];
  const outs = [...new Set(priced.map((p) => p.outMicro))];
  const rng = (v: number[]) => (Math.min(...v) === Math.max(...v) ? `${v[0]}` : `${Math.min(...v)}–${Math.max(...v)}`);
  return (
    <div className="card mcard" onClick={onOpen} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter') onOpen(); } : undefined}>
      <div className="name"><ModelLogo family={model.family} displayName={model.displayName} size="md" /> {model.displayName}</div>
      <div className="fam">{cap(model.family)} · {model.modality}{model.contextLength > 0 ? ` · ${fmtCompact(model.contextLength)} context` : ''}</div>
      <div className="provline">
        {model.providers.length === 1 ? copy('catalog.provider.one') : copy('catalog.providers', { n: model.providers.length })}
        {classes.map((c) => <ProvBadge key={c} cls={c} withText />)}
      </div>
      <div className="price">
        {priced.length > 0
          ? <>{fmtUsdRange(usd)} / 1M tokens <span className="micro mono">{rng(ins)} µ / {rng(outs)} µ per token</span></>
          : <span className="muted">— <span className="micro">{copy('model.quote.unverifiable')}</span></span>}
      </div>
      <div className="vol" title={copy('catalog.volume.tip')}>
        {copy('catalog.volume', { n: fmtCompact(model.settledTokens) })}
        {model.trend === 'up' ? <span className="trend-up">↗</span> : <span className="muted">—</span>}
      </div>
    </div>
  );
}

// ── model-page provider row (shared with ListingPreview) ──

export type QuoteStatus = 'live' | 'loading' | 'unverifiable' | 'unreachable';

export function ProviderRow({ p, fxRate, quoteStatus, onTry, onBuy, onRepClick }: {
  p: CatalogProvider; fxRate: number; quoteStatus: QuoteStatus;
  onTry?: () => void; onBuy?: () => void; onRepClick?: () => void;
}): React.ReactElement {
  const disabled = quoteStatus !== 'live';
  const rowClass = quoteStatus === 'unverifiable' ? 'unverif' : quoteStatus === 'unreachable' ? 'tr--dim' : '';
  const noData = <>— <span className="xs">{copy('model.telemetry.none')}</span></>;
  return (
    <tr className={rowClass}>
      <td className="provider-cell">
        <span className="mono">{fmtHash(p.addr)} {p.label && <span className="sec">({p.label})</span>}</span>
        {quoteStatus === 'unverifiable'
          ? <span className="warnline">{copy('model.quote.unverifiable')}</span>
          : quoteStatus === 'unreachable'
            ? <span className="rep">{copy('model.uptime.down', { t: '12m' })}</span>
            : p.rep && <span className="rep" title={copy('model.rep.tip')} onClick={onRepClick}
                role={onRepClick ? 'button' : undefined}>{copy('model.rep', { a: p.rep.verified, d: p.rep.disputed })}</span>}
      </td>
      <td className="num price-cell">
        {quoteStatus === 'unverifiable'
          ? <div className="usd">—</div>
          : <>
              <div className="usd">~${usdPer1M(p.inMicro, p.outMicro, fxRate).toFixed(2)}</div>
              <div className="micro mono">{p.inMicro} µ / {p.outMicro} µ per token</div>
            </>}
      </td>
      <td><ProvBadge cls={p.class} /></td>
      <td className="num mono">{quoteStatus !== 'live' || p.ttftMs == null ? noData : `${p.ttftMs}ms`}</td>
      <td className="num mono">{quoteStatus !== 'live' || p.tokS == null ? noData : p.tokS}</td>
      <td><span className="via">{p.via}</span></td>
      <td><span className={`dot ${p.up && quoteStatus !== 'unreachable' ? 'dot--ok' : 'dot--down'}`}
        title={p.up && quoteStatus !== 'unreachable' ? copy('model.uptime.ok') : copy('model.uptime.down', { t: '12m' })} /></td>
      <td className="num">
        <button className="btn btn--sm" disabled={disabled} onClick={onTry}>{copy('model.try')}</button>{' '}
        <button className="btn btn--primary btn--sm" disabled={disabled} onClick={onBuy}>{copy('model.buy')}</button>
      </td>
    </tr>
  );
}

// ── conservation line ──

/** Recomputed client-side; a break renders red and links the diagnostic —
 *  never hide a break (spec 05). */
export function ConservationLine({ lhsMicro, billedMicro, refundableMicro, diagnosticHref }: {
  lhsMicro: number; billedMicro: number; refundableMicro: number; diagnosticHref?: string;
}): React.ReactElement {
  const ok = lhsMicro === billedMicro + refundableMicro;
  const f = (n: number) => n.toLocaleString('en-US');
  return (
    <div>
      <div className={`conservation-line${ok ? '' : ' is-broken'}`}>
        {copy('treasury.conservation', { lhs: '', billed: '', refundable: '' }).split(':')[0]}:{' '}
        <span className="mono">{f(lhsMicro)} {ok ? '=' : '≠'} {f(billedMicro)} + {f(refundableMicro)}</span>{' '}
        {ok ? <span className="badge--pinned">✓</span> : '⚠'}
      </div>
      {!ok && (
        <div className="xs" style={{ marginTop: 'var(--sp-1)' }}>
          <a href={diagnosticHref ?? '#'}>{copy('treasury.diag', { n: Math.abs(lhsMicro - (billedMicro + refundableMicro)) })} ↗</a>
        </div>
      )}
    </div>
  );
}

function cap(s: string): string {
  if (s === 'openai') return 'OpenAI';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export { WITHHOLD_CODE };
