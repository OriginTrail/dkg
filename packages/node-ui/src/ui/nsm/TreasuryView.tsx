// Surface 05 — Treasury (spec docs/ui-spec/surfaces/05-treasury.md).
// One balance over many tabs. The ring is wallet + Σ refundable from the
// buyer's OWN projection (deposit journal − countersigned spend); the
// conservation line is recomputed client-side and a break renders red with a
// diagnostic — never hidden. Tabs funded outside the UI (no journal row)
// show funded = "—" honestly rather than inventing a number.
import React, { useCallback, useEffect, useState } from 'react';
import { copy } from './copy.generated.js';
import { ConservationLine, MiniBar, RadialGauge } from './components.js';
import { DEFAULT_TRAC_USD, fmtCompact, fmtHash, fmtMicro, fmtTrac, fmtUsd, microToTrac } from './format.js';
import { authHeaders } from '../http.js';

interface TreasuryTab {
  tabId: string; provider: string | null;
  fundedMicro: number | null; billedMicro: number; refundableMicro: number | null;
}
interface Treasury {
  configured: boolean;
  wallet?: { address?: string; tracMicro?: number; rpcError?: string };
  tabs?: TreasuryTab[];
}

export function TreasuryView({ fxRate = DEFAULT_TRAC_USD }: { fxRate?: number }): React.ReactElement {
  const [data, setData] = useState<Treasury | null | 'error'>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<Record<string, unknown> | null>(null);

  const refresh = useCallback(() => {
    fetch('/marketplace/buyer/treasury', { headers: authHeaders(), signal: AbortSignal.timeout(30_000) })
      .then((r) => r.json())
      .then((d) => setData(d as Treasury))
      .catch(() => setData('error'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const doClose = useCallback((tabId: string) => {
    setClosing(null);
    fetch('/marketplace/buyer/close', { method: 'POST', headers: authHeaders() })
      .then((r) => r.json())
      .then((d) => { setCloseResult(d as Record<string, unknown>); refresh(); })
      .catch(() => setCloseResult({ error: 'offline' }));
  }, [refresh]);

  if (data === null) {
    return <div className="card card--pad stack" aria-hidden>
      <div className="skel" style={{ width: '40%' }}>balance</div>
      <div className="skel" style={{ width: '70%' }}>tabs</div>
    </div>;
  }
  if (data === 'error' || !data.configured) {
    return (
      <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
        <span className="sec">{data === 'error' ? copy('err.offline') : copy('onboard.unconfigured')}</span>
        <button className="btn" onClick={refresh}>{copy('ctl.retry')}</button>
      </div>
    );
  }

  const walletMicro = data.wallet?.tracMicro ?? 0;
  const tabs = data.tabs ?? [];
  const refundable = tabs.reduce((s, t) => s + (t.refundableMicro ?? 0), 0);
  const ringMicro = walletMicro + refundable;
  const journaled = tabs.filter((t) => t.fundedMicro != null);

  return (
    <div className="stack" style={{ gap: 'var(--sp-5)' }}>
      <div className="card card--pad stack">
        <div className="hero">
          <RadialGauge pct={100} mode="ready">
            <div>
              {/* ring interior is 120px — compact form there, exact beside it */}
              <div className="mono" style={{ fontSize: 'var(--fs-xl)', fontWeight: 600 }}>
                {microToTrac(ringMicro) >= 1000 ? fmtCompact(Math.round(microToTrac(ringMicro))) : fmtTrac(microToTrac(ringMicro))}
              </div>
              <div className="xs muted">TRAC</div>
            </div>
          </RadialGauge>
          <div className="stack" style={{ gap: 'var(--sp-1)' }}>
            <div className="sec sm" title={copy('treasury.balance.tip')}>{copy('treasury.balance')}</div>
            <div className="hero"><span className="big">{fmtTrac(microToTrac(ringMicro))}</span>{' '}
              <span className="usd">{fmtUsd(microToTrac(ringMicro) * fxRate)}</span></div>
            <div className="xs muted">{copy('treasury.ring.parts', {
              a: fmtTrac(microToTrac(walletMicro)), b: fmtTrac(microToTrac(refundable)),
            })}</div>
          </div>
        </div>

        {journaled.map((t) => (
          <ConservationLine key={t.tabId}
            lhsMicro={t.fundedMicro ?? 0} billedMicro={t.billedMicro} refundableMicro={t.refundableMicro ?? 0} />
        ))}

        {tabs.length === 0 ? (
          <div className="card card--pad" style={{ textAlign: 'center' }}>
            <span className="sec">{copy('empty.tabs')}</span>
          </div>
        ) : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Tab</th><th>Provider</th><th className="num">Refundable</th><th className="num">Billed</th><th /></tr></thead>
              <tbody>
                {tabs.map((t) => (
                  <tr key={t.tabId} className="tabrow">
                    <td className="mono">{t.tabId}</td>
                    <td className="mono">{t.provider ? fmtHash(t.provider) : '—'}</td>
                    <td className="num mono">{t.refundableMicro != null ? fmtMicro(t.refundableMicro) : '—'}</td>
                    <td className="num mono">{fmtMicro(t.billedMicro)}</td>
                    <td className="num">
                      <div className="stack" style={{ gap: 'var(--sp-2)', alignItems: 'flex-end' }}>
                        {t.fundedMicro != null && (
                          <MiniBar billedMicro={t.billedMicro} totalMicro={t.fundedMicro}
                            title={`${fmtMicro(t.billedMicro)} billed of ${fmtMicro(t.fundedMicro)} funded`} />
                        )}
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn btn--ghost btn--sm" onClick={() => setClosing(t.tabId)}>{copy('treasury.close')}</button>
                          <button className="btn btn--sm" onClick={() => setClosing(t.tabId)}>{copy('treasury.refund')}</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {closing && (
        <div className="drawer" style={{ maxWidth: 'calc(var(--card-min-w) * 1.5)' }}>
          <div className="sm" style={{ marginBottom: 'var(--sp-2)' }}>{copy('treasury.close')} <span className="mono">{closing}</span>?</div>
          <div className="xs muted" style={{ marginBottom: 'var(--sp-3)' }}>{copy('treasury.balance.tip')}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn--ghost btn--sm" onClick={() => setClosing(null)}>{copy('ctl.cancel')}</button>
            <button className="btn btn--primary btn--sm" onClick={() => doClose(closing)}>{copy('treasury.close')}</button>
          </div>
        </div>
      )}

      {closeResult && (
        <div className="card card--pad stack" style={{ gap: 'var(--sp-2)' }}>
          {closeResult.close ? (
            <>
              <div className="row"><span className="chip chip--verified">{copy('state.verified.short')}</span>
                <span className="sm sec mono">{fmtHash(String(closeResult.closeDigest ?? ''))}</span></div>
              <div className="xs muted">{copy('receipt.close', { digest: fmtHash(String(closeResult.closeDigest ?? '')) })}</div>
            </>
          ) : (
            <span className="sec sm">{copy('err.5xx')} <span className="mono xs">{String(closeResult.error ?? '')}</span></span>
          )}
        </div>
      )}
    </div>
  );
}
