// Surface 07 — Operate, the seller's cockpit (spec docs/ui-spec/surfaces/07-operate-seller.md).
// The honest gauge (761/2,941,000 renders without breakage), the pending
// queue with live countdowns, the withhold mix with a plain-word legend, and
// a publish wizard whose preview IS the buyer's ModelCard — same component,
// zero drift. Gauge binds to the loopback status projection only.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { copy, CODE_TO_KEY } from '../nsm/copy.generated.js';
import {
  ModelCard, ModelLogo, ProvBadge, RadialGauge, StateChip, useCountdown,
  type CatalogModel, type LegState,
} from '../nsm/components.js';
import { DEFAULT_TRAC_USD, fmtMicro } from '../nsm/format.js';
import { fetchOperateStatus, type NsmOperateStatus } from '../nsm/api.js';
import { authHeaders } from '../http.js';

interface OperateLeg {
  legId: string; legType: string; offeringId: string; provenanceClass: string;
  cost: number; at: string;
  status: { state?: string; status?: string; code?: string; deadline?: string };
}

const LIFECYCLE_TO_CHIP: Record<string, LegState> = {
  'pending-delivery': 'pending', delivered: 'checking',
  countersigned: 'verified', withheld: 'blocked', voided: 'voided',
  // v3-plugin nodes project { status } instead of the lifecycle { state }
  open: 'checking',
};

const legChip = (l: OperateLeg): LegState =>
  LIFECYCLE_TO_CHIP[l.status.state ?? l.status.status ?? ''] ?? 'checking';

function LegRow({ leg, fxRate }: { leg: OperateLeg; fxRate: number }): React.ReactElement {
  const deadlineMs = leg.status.state === 'pending-delivery' && leg.status.deadline
    ? Date.parse(leg.status.deadline) : null;
  const countdown = useCountdown(deadlineMs);
  const chip = legChip(leg);
  const wKey = leg.status.code ? CODE_TO_KEY[leg.status.code] : undefined;
  return (
    <tr>
      <td className="mono">{leg.legId}</td>
      <td><StateChip state={chip} /></td>
      <td className="sec xs">
        {chip === 'pending' && countdown && <span className="mono countdown">due in {countdown}</span>}
        {chip === 'blocked' && wKey && copy(wKey).split(' — ')[0]}
      </td>
      <td className="num mono">{fmtMicro(chip === 'blocked' || chip === 'voided' ? 0 : leg.cost)}</td>
    </tr>
  );
}

export function OperateV35View(): React.ReactElement {
  const [status, setStatus] = useState<NsmOperateStatus | null | 'error'>(null);
  const [wizard, setWizard] = useState<{ step: 'connect' | 'price' | 'preview' | 'publish'; offeringId?: string } | null>(null);
  const [publishResult, setPublishResult] = useState<Record<string, unknown> | null>(null);
  const fxRate = DEFAULT_TRAC_USD;

  const refresh = useCallback(() => {
    fetchOperateStatus().then(setStatus).catch(() => setStatus('error'));
  }, []);
  useEffect(() => { refresh(); const t = setInterval(refresh, 15_000); return () => clearInterval(t); }, [refresh]);

  const legs = useMemo(() => (status !== null && status !== 'error'
    ? (status.legs as unknown as OperateLeg[]) : []), [status]);
  const pending = legs.filter((l) => l.status.state === 'pending-delivery');
  const withheld = legs.filter((l) => (l.status.state ?? l.status.status) === 'withheld');
  const withholdMix = useMemo(() => {
    const mix = new Map<string, number>();
    for (const l of withheld) if (l.status.code) mix.set(l.status.code, (mix.get(l.status.code) ?? 0) + 1);
    return [...mix.entries()];
  }, [withheld]);

  if (status === null) return <div className="nsmx nsmx--page"><div className="frame"><div className="card card--pad"><span className="skel">loading operate status</span></div></div></div>;
  if (status === 'error') {
    return (
      <div className="nsmx nsmx--page"><div className="frame">
        <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
          <span className="sec">{copy('err.offline')}</span>
          <button className="btn" onClick={refresh}>{copy('ctl.retry')}</button>
        </div>
      </div></div>
    );
  }

  const earned = status.threshold.unsettledEarnedMicroTrac;
  const thresholdMicro = (status.threshold as { thresholdMicroTrac?: number }).thresholdMicroTrac ?? 2_941_000;
  const allowed = (status.threshold as { allowed?: boolean }).allowed ?? false;
  const pct = thresholdMicro > 0 ? (earned / thresholdMicro) * 100 : 0;
  const gaugeMode = allowed ? 'ready' : pct >= 25 ? 'mid' : 'low';
  const gaugeCopy = allowed ? copy('gauge.threshold.ready') : pct >= 25 ? copy('gauge.threshold.mid') : copy('gauge.threshold.low');

  // ListingPreview data — the SAME ModelCard the catalog renders
  const previewModel = (offeringId: string): CatalogModel | null => {
    const o = status.offerings.find((x) => x.id === offeringId);
    if (!o) return null;
    return {
      modelRef: '', displayName: o.modelId, family: guessFamily(o.modelId), modality: 'text', contextLength: 0,
      providers: [{
        addr: '(this node)', inMicro: o.pricing.perInputTokenMicroTrac, outMicro: o.pricing.perOutputTokenMicroTrac,
        class: o.provenanceClass, via: 'direct', up: true,
      }],
      settledTokens: 0,
    };
  };

  const doPublish = (offeringId: string) => {
    setWizard({ step: 'publish', offeringId });
    fetch('/marketplace/operate/publish', {
      method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ offeringId }),
      signal: AbortSignal.timeout(90_000),
    }).then((r) => r.json()).then((d) => setPublishResult(d as Record<string, unknown>))
      .catch(() => setPublishResult({ error: 'offline' }));
  };

  return (
    <div className="nsmx nsmx--page">
      <div className="frame">
        <div className="cols">
          <div className="stack">
            <div className="card card--pad row" style={{ gap: 'var(--sp-5)' }}>
              <RadialGauge pct={pct} mode={gaugeMode}
                title={copy('gauge.threshold.tip', { earned: fmtMicro(earned), threshold: fmtMicro(thresholdMicro) })}>
                <div>
                  <div className="mono" style={{ fontSize: 'var(--fs-lg)', fontWeight: 600 }}>
                    {pct < 1 && pct > 0 ? pct.toFixed(2) : Math.round(pct)}%
                  </div>
                  <div className="xs muted">{copy('operate.gauge.sub')}</div>
                </div>
              </RadialGauge>
              <div className="stack" style={{ gap: 'var(--sp-1)' }}>
                <h2>{copy('operate.earnings.title')}</h2>
                <div className="mono sm">{fmtMicro(earned)} of {fmtMicro(thresholdMicro)}</div>
                <div className="sec sm" style={allowed ? { color: 'var(--state-verified)' } : undefined}>{gaugeCopy}</div>
                <div><button className="btn btn--primary" disabled={!allowed} title={copy('operate.settle.local')}>{copy('operate.settle')}</button></div>
                <div className="xs muted">{copy('operate.settle.local')}</div>
              </div>
            </div>

            <div className="card card--pad stack" style={{ gap: 'var(--sp-2)' }}>
              <h2>{copy('operate.legs.title')}</h2>
              {legs.length === 0 ? (
                <div className="sec sm">{copy('empty.activity')}</div>
              ) : (
                <div className="scroll-x">
                  <table className="table"><tbody>
                    {legs.slice(-12).reverse().map((l) => <LegRow key={l.legId} leg={l} fxRate={fxRate} />)}
                  </tbody></table>
                </div>
              )}
              {pending.length > 0 && (
                <div className="xs muted">
                  {pending.length === 1
                    ? copy('operate.pending.aging.one', { t: pending[0].status.deadline ? countdownText(pending[0].status.deadline) : '—' })
                    : copy('operate.pending.aging', { n: pending.length, t: oldestDeadline(pending) })}
                </div>
              )}
              {withholdMix.length > 0 && (
                <div className="stack" style={{ gap: 'var(--sp-1)' }}>
                  <div className="xs muted">{copy('operate.withhold.mix')}</div>
                  <div className="wmix">
                    {withholdMix.map(([code, n], i) => (
                      <span key={code} style={{ flex: n, background: i % 2 ? 'var(--state-pending)' : 'var(--state-blocked)' }} />
                    ))}
                  </div>
                  <div className="wmix-legend">
                    {withholdMix.map(([code, n], i) => (
                      <span key={code} className="row" style={{ gap: 'var(--sp-1)' }}>
                        <span className="swatch" style={{ background: i % 2 ? 'var(--state-pending)' : 'var(--state-blocked)' }} />
                        {CODE_TO_KEY[code] ? copy(CODE_TO_KEY[code]).split(' — ')[0] : code} · {n}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="stack">
            <div className="card card--pad stack" style={{ gap: 'var(--sp-2)' }}>
              <h2>{copy('operate.offerings.title')}</h2>
              {status.offerings.length === 0 && <div className="sec sm">{copy('empty.catalog')}</div>}
              {status.offerings.map((o) => (
                <div key={o.id} className="offering-row">
                  <ModelLogo family={guessFamily(o.modelId)} displayName={o.modelId} size="sm" />
                  {o.modelId} <ProvBadge cls={o.provenanceClass} />
                  <span className="live-tag">{copy('operate.offering.live')}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => setWizard({ step: 'preview', offeringId: o.id })}>{copy('wizard.preview')}</button>
                  </span>
                </div>
              ))}
            </div>

            {wizard?.offeringId && (
              <div className="card card--pad stack">
                <div className="wizard">
                  <span className="wstep is-done">✓ {copy('wizard.connect')}</span>
                  <span className="wstep is-done">✓ {copy('wizard.price')}</span>
                  <span className={`wstep${wizard.step === 'preview' ? ' is-active' : ''}`}>{copy('wizard.preview')}</span>
                  <span className={`wstep${wizard.step === 'publish' ? ' is-active' : ''}`}>{copy('wizard.publish')}</span>
                </div>
                <div className="xs muted">{copy('listing.preview')}</div>
                <div className="preview-frame">
                  {(() => { const m = previewModel(wizard.offeringId); return m ? <div style={{ maxWidth: 'var(--card-min-w)' }}><ModelCard model={m} fxRate={fxRate} /></div> : null; })()}
                </div>
                {publishResult ? (
                  publishResult.error
                    ? <span className="sec sm">{copy('err.5xx')} <span className="mono xs">{String(publishResult.detail ?? publishResult.error)}</span></span>
                    : <span className="sm" style={{ color: 'var(--state-verified)' }}>{copy('state.verified.short')} <span className="mono xs">{String(publishResult.ual ?? publishResult.ka ?? '')}</span></span>
                ) : (
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn btn--ghost btn--sm" onClick={() => { setWizard(null); setPublishResult(null); }}>{copy('ctl.back')}</button>
                    <button className="btn btn--primary btn--sm" onClick={() => doPublish(wizard.offeringId!)}>{copy('wizard.publish')}</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function guessFamily(modelId: string): string {
  if (/qwen/i.test(modelId)) return 'qwen';
  if (/gpt|codex|o[0-9]/i.test(modelId)) return 'openai';
  if (/deepseek/i.test(modelId)) return 'deepseek';
  if (/llama/i.test(modelId)) return 'meta';
  if (/mistral|mixtral/i.test(modelId)) return 'mistral';
  return 'unknown';
}

function countdownText(deadline: string): string {
  const ms = Date.parse(deadline) - Date.now();
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function oldestDeadline(pending: OperateLeg[]): string {
  const ds = pending.map((l) => l.status.deadline).filter(Boolean) as string[];
  if (!ds.length) return '—';
  return countdownText(ds.sort()[0]);
}
