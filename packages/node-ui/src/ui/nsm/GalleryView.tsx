// /dev/gallery — §Loop rule 5: every component in every state, driven by
// fixtures.json (real REPORT-v3 numbers). This page is the self-screenshot
// target; it is ALWAYS fixture-fed and labeled as such (rule 9).
import React, { useState } from 'react';
import fixtures from './fixtures.json';
import { copy, COPY } from './copy.generated.js';
import { fmtMicro, fmtTrac, fmtUsd, DEFAULT_TRAC_USD } from './format.js';
import {
  Chip, StateChip, ProvBadge, ModelLogo, RadialGauge, LinearGauge, MiniBar,
  ReceiptDrawer, CostChip, WithholdBody, ModelCard, ProviderRow,
  ConservationLine, useCountdown, type LegState, type CatalogModel, type ReceiptLeg,
} from './components.js';

const FX = fixtures.fx.tracUsd ?? DEFAULT_TRAC_USD;

function Sect({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <>
      <div className="state-label">{title}</div>
      {children}
    </>
  );
}

const verifiedLeg: ReceiptLeg = {
  legId: fixtures.legs.verified.legId, state: 'verified',
  costMicro: fixtures.legs.verified.costMicro,
  counts: fixtures.legs.verified.counts,
  priceIn: 2, priceOut: 6,
  bytesDigest: fixtures.legs.verified.bytesDigest,
  sellerSig: fixtures.legs.verified.sellerSig,
  countersig: fixtures.legs.verified.countersig,
  closeDigest: fixtures.legs.verified.closeDigest,
  chainUrl: `${fixtures.chain.explorer}/tx/${fixtures.tab.openTx}`,
};

const blockedLeg: ReceiptLeg = {
  legId: fixtures.legs.blocked.legId, state: 'blocked',
  costMicro: fixtures.legs.blocked.recountMicro,
  counts: fixtures.legs.blocked.counts,
  withholdCode: fixtures.legs.blocked.code,
  claimedMicro: fixtures.legs.blocked.claimedMicro,
};

export function NsmGalleryView(): React.ReactElement {
  const [pendingDeadline] = useState(() => Date.now() + 4 * 60_000 + 12_000);
  const countdown = useCountdown(pendingDeadline);

  return (
    <div className="nsmx nsmx--page">
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: 'color-mix(in srgb, var(--state-pending) 14%, var(--surface-0))',
        color: 'var(--state-pending)', borderBottom: '1px solid var(--border-subtle)',
        fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)' as unknown as number,
        letterSpacing: '0.06em', textTransform: 'uppercase',
        padding: 'var(--sp-2) var(--sp-4)',
      }}>
        Component gallery · fixture data (REPORT-v3 numbers) · not live
      </div>
      <div className="frame">
        <h1>NSM component gallery</h1>

        <Sect title="lifecycle chips — all five states">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {(['checking', 'verified', 'pending', 'blocked', 'voided'] as LegState[]).map((s) => <StateChip key={s} state={s} />)}
            <StateChip state="verified" short={false} />
          </div>
        </Sect>

        <Sect title="provenance badges">
          <div className="row"><ProvBadge cls="weights-pinned" withText /><ProvBadge cls="upstream-claimed" withText /></div>
        </Sect>

        <Sect title="logos — known families (monogram until CP3 pack) + unknown-family fallback">
          <div className="row">
            <ModelLogo family="qwen" displayName="Qwen2.5" size="lg" />
            <ModelLogo family="openai" displayName="GPT-5.4" size="md" />
            <ModelLogo family="deepseek" displayName="DeepSeek" size="md" />
            <ModelLogo family="unknown-fam" displayName="Custom Net" size="md" />
            <ModelLogo family="qwen" displayName="Qwen2.5" size="sm" />
          </div>
        </Sect>

        <Sect title={`radial gauge — the honest 0.03% (${fixtures.threshold.earnedMicro} / ${fixtures.threshold.thresholdMicro}) · 52% · 106% · zero`}>
          <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-6)' }}>
            <RadialGauge pct={fixtures.threshold.pct} mode="low"
              title={copy('gauge.threshold.tip', { earned: `${fmtMicro(fixtures.threshold.earnedMicro)}`, threshold: `${fmtMicro(fixtures.threshold.thresholdMicro)}` })}>
              <div><div className="mono" style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>0.03%</div><div className="xs muted">{copy('operate.gauge.sub')}</div></div>
            </RadialGauge>
            <RadialGauge pct={52} mode="mid"><div className="mono" style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>52%</div></RadialGauge>
            <RadialGauge pct={106} mode="ready"><div className="mono" style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>106%</div></RadialGauge>
            <RadialGauge pct={0} mode="low"><div className="mono" style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>0%</div></RadialGauge>
          </div>
        </Sect>

        <Sect title="linear gauges — 61% · exhausted (cap) · revoked-low · ready">
          <div className="stack" style={{ maxWidth: 'var(--card-min-w)' }}>
            <LinearGauge pct={61} />
            <LinearGauge pct={100} mode="over" />
            <LinearGauge pct={12} mode="low" />
            <LinearGauge pct={100} mode="ready" />
          </div>
        </Sect>

        <Sect title="tab mini-bar — 761 µ billed of 1,000,000 µ">
          <div style={{ maxWidth: 'var(--card-min-w)' }}>
            <MiniBar billedMicro={fixtures.tab.billedMicro} totalMicro={fixtures.tab.fundedMicro} />
          </div>
        </Sect>

        <Sect title="cost chips — normal · voided (struck)">
          <div className="row">
            <CostChip micro={258} fxRate={FX} />
            <CostChip micro={258} fxRate={FX} voided />
          </div>
        </Sect>

        <Sect title="pending-delivery with LIVE countdown (state.pending.deadline)">
          <div className="msg-footer">
            <CostChip micro={fixtures.legs.pending.costMicro} fxRate={FX} />
            <StateChip state="pending" />
            <span className="xs muted countdown">{copy('state.pending.deadline', { t: countdown ?? '—' })}</span>
          </div>
        </Sect>

        <Sect title="withhold — plain words per code (all five), code one reveal deeper">
          <div className="stack">
            {(fixtures.withholdCodes as string[]).map((code) => (
              <div key={code}><WithholdBody code={code} /></div>
            ))}
          </div>
        </Sect>

        <Sect title="receipt drawer — verified leg (leg_e1552c0a, 258 µ, counts 42/29)">
          <div style={{ maxWidth: 'calc(var(--card-min-w) * 1.4)' }}><ReceiptDrawer leg={verifiedLeg} fxRate={FX} /></div>
        </Sect>

        <Sect title="receipt drawer — blocked leg (E_OVERBILL: claimed 310 µ, recount 258 µ)">
          <div style={{ maxWidth: 'calc(var(--card-min-w) * 1.4)' }}><ReceiptDrawer leg={blockedLeg} fxRate={FX} /></div>
        </Sect>

        <Sect title="model cards — 2-provider ⛓ group · 1-provider ☁ · loading skeleton">
          <div className="grid-cards" style={{ maxWidth: 'calc(var(--card-min-w) * 3)' }}>
            {(fixtures.models as CatalogModel[]).map((m) => <ModelCard key={m.modelRef} model={m} fxRate={FX} />)}
            <div className="card mcard" aria-hidden>
              <div className="name"><span className="logo-monogram logo--md skel">··</span> <span className="skel">Model name</span></div>
              <div className="fam skel" style={{ width: '60%' }}>family</div>
              <div className="provline skel" style={{ width: '40%' }}>providers</div>
              <div className="price skel" style={{ width: '50%' }}>price</div>
            </div>
          </div>
        </Sect>

        <Sect title="provider rows — live ok · quote-unverifiable (disabled) · unreachable + no telemetry · loading">
          <div className="card scroll-x">
            <table className="table">
              <thead><tr><th>Provider</th><th className="num">Price / 1M</th><th>Class</th><th className="num">TTFT</th><th className="num">tok/s</th><th>Via</th><th>Up</th><th /></tr></thead>
              <tbody>
                <ProviderRow p={fixtures.models[0].providers[0]} fxRate={FX} quoteStatus="live" />
                <ProviderRow p={fixtures.models[0].providers[1]} fxRate={FX} quoteStatus="unverifiable" />
                <ProviderRow p={{ ...fixtures.models[0].providers[0], ttftMs: null, tokS: null, up: false }} fxRate={FX} quoteStatus="unreachable" />
                <tr aria-hidden>
                  <td><span className="skel">provider line</span></td>
                  <td className="num"><span className="skel">$0.00</span></td>
                  <td><span className="skel">⛓</span></td>
                  <td className="num"><span className="skel">000ms</span></td>
                  <td className="num"><span className="skel">00</span></td>
                  <td><span className="skel">via</span></td>
                  <td><span className="skel">●</span></td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </Sect>

        <Sect title="conservation line — intact (REPORT-v3 identity) and broken (fixture break)">
          <div className="stack">
            <ConservationLine lhsMicro={fixtures.conservation.lhs} billedMicro={fixtures.conservation.billed} refundableMicro={fixtures.conservation.refundable} />
            <ConservationLine lhsMicro={fixtures.conservationBroken.lhs} billedMicro={fixtures.conservationBroken.billed} refundableMicro={fixtures.conservationBroken.refundable} />
          </div>
        </Sect>

        <Sect title="key-mint plaintext-once (mint modal state) — unrecoverable after dismiss">
          <MintOnceDemo />
        </Sect>

        <Sect title="toasts — KPI · rerouted">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="toast"><span className="chip chip--verified">✓</span> {copy('onboard.kpi', { 'mm:ss': fixtures.kpi.firstVerifiedMmss })}</div>
            <div className="toast"><span className="chip chip--checking">↷</span> {copy('state.rerouted', { provider: '0x633E5a7C…' })}</div>
          </div>
        </Sect>

        <Sect title="empty states — all four">
          <div className="stack">
            {(['empty.catalog', 'empty.tabs', 'empty.keys', 'empty.activity'] as const).map((k) => (
              <div key={k} className="card card--pad" style={{ textAlign: 'center' }}><span className="sec">{copy(k)}</span></div>
            ))}
          </div>
        </Sect>

        <Sect title="errors — normalized set">
          <div className="stack">
            {(['err.401', 'err.402.budget', 'err.402.unfunded', 'err.429', 'err.5xx', 'err.offline'] as const).map((k) => (
              <div key={k} className="card" style={{ padding: 'var(--sp-3) var(--sp-4)' }}><span className="sec sm">{copy(k)}</span></div>
            ))}
          </div>
        </Sect>

        <div className="footnote">strings: {Object.keys(COPY).length} keys from UI-COPY.md · balance sample {fmtTrac(fixtures.treasury.ringTrac)} TRAC ({fmtUsd(fixtures.treasury.ringUsd)})</div>
      </div>
    </div>
  );
}

/** Gallery proof for spec-01 acceptance: plaintext rendered once, then
 *  unrecoverable — the component holds no copy of it after dismiss. */
function MintOnceDemo(): React.ReactElement {
  const [plain, setPlain] = useState<string | null>(fixtures.mintedKeyPlaintextOnce);
  return (
    <div className="stack" style={{ maxWidth: 'calc(var(--card-min-w) * 1.6)' }}>
      {plain ? (
        <div className="drawer">
          <div className="sm" style={{ marginBottom: 'var(--sp-2)' }}>{copy('key.mint.title')}</div>
          <div className="mono xs" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: 'var(--sp-3)', overflowWrap: 'anywhere' }}>{plain}</div>
          <div className="warn-once" style={{ marginTop: 'var(--sp-2)' }}>⚠ {copy('onboard.key.once')}</div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-3)' }}>
            <button className="btn btn--primary btn--sm" onClick={() => setPlain(null)}>{copy('ctl.done')}</button>
          </div>
        </div>
      ) : (
        <div className="row"><span className="mono">nsm_k_9f…</span><span className="xs muted">plaintext dismissed — only the prefix remains anywhere in the DOM</span></div>
      )}
    </div>
  );
}
