// Plans & meters — the P5 centerpiece, per surfaces/09-plans-meters.md and
// the CP-R-approved runthrough (Part-0 separate meters, D8/D9/D11).
// Every meter is per (offering, seller) in native units; the plan summary is
// a readout, never a limit. Strings render via copy(key) and carry data-copy.
import React, { useEffect, useMemo, useState } from 'react';
import { copy } from '../nsm/copy.generated.js';
import { fetchSubsStatus, type V5SubsStatus, type V5Allowance } from '../nsm/v5-api.js';

const t = (key: string, vars: Record<string, string | number> = {}) => {
  let s = copy(key);
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};

const fmtUnits = (n: number, unit: string) => {
  const s = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n);
  return `${s} ${unit === 'query-units' ? 'query units' : 'tokens'}`;
};

const expiresIn = (expiresAt: string, now: number) => {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return `${d} d`;
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min`;
};

/** D9 — one pace sentence per meter, computed from the buyer's own numbers:
 *  nothing new is measured. Amber when the consumption pace beats the
 *  period pace by enough to run out before expiry. */
function pace(m: V5Allowance, startedAt: string, expiresAt: string, now: number):
  { tone: 'warn' | 'quiet'; text: string } {
  const total = new Date(expiresAt).getTime() - new Date(startedAt).getTime();
  const elapsed = Math.max(1, now - new Date(startedAt).getTime());
  const used = m.guaranteedUnits === 0 ? 0 : m.consumedUnits / m.guaranteedUnits;
  const elapsedFrac = Math.min(1, elapsed / total);
  if (used > 0 && elapsedFrac > 0 && used / elapsedFrac > 1.15) {
    const projectedMs = elapsed / used;                    // ms to exhaustion at pace
    const shortDays = Math.max(1, Math.round((total - projectedMs) / 86_400_000));
    return { tone: 'warn', text: t('meter.pace.warn', { d: shortDays }) };
  }
  return { tone: 'quiet', text: copy('meter.pace.ok') };
}

/** D9 sparkline — period-to-date consumption buckets from the activity feed. */
function Spark({ series }: { series: number[] }) {
  const max = Math.max(...series, 1);
  return (
    <span className="nsm5-spark" aria-hidden>
      {series.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }} />
      ))}
    </span>
  );
}

export function PlansV5View(): React.ReactElement {
  const [st, setSt] = useState<V5SubsStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    let live = true;
    const load = () => fetchSubsStatus().then((s) => { if (live) { setSt(s); setErr(null); } })
      .catch((e) => { if (live) setErr(String((e as Error).message)); });
    load();
    const iv = setInterval(load, 5_000);
    return () => { live = false; clearInterval(iv); };
  }, []);

  const sparks = useMemo(() => {
    // bucket consumed activity per offering into 7 period slices
    const out: Record<string, number[]> = {};
    if (!st?.plan) return out;
    const start = new Date(st.plan.startedAt).getTime();
    const span = Math.max(1, now - start);
    for (const m of st.meters) out[m.offeringId] = [0, 0, 0, 0, 0, 0, 0];
    for (const a of st.activity) {
      if (a.kind !== 'consumed' || !a.offeringId) continue;
      const idx = Math.min(6, Math.floor(((new Date(a.at).getTime() - start) / span) * 7));
      if (out[a.offeringId]) out[a.offeringId][Math.max(0, idx)] += a.units ?? 0;
    }
    return out;
  }, [st, now]);

  if (err) return <div className="nsm5-frame"><div className="nsm5-card nsm5-muted">{copy('empty.error')} <span className="nsm-mono">{err}</span></div></div>;
  if (!st) return <div className="nsm5-frame"><div className="nsm5-card nsm5-muted">…</div></div>;

  if (!st.plan) {
    return (
      <div className="nsm5-frame">
        <div className="nsm5-card">
          <h2 data-copy="meter.period.ended">{copy('meter.period.ended')}</h2>
          <p className="nsm5-muted" data-copy="meter.newperiod.note">{copy('meter.newperiod.note')}</p>
          <button className="nsm5-btn nsm5-btn--primary" data-copy="meter.newperiod">{copy('meter.newperiod')}</button>
        </div>
      </div>
    );
  }

  const plan = st.plan;
  const exp = expiresIn(plan.expiresAt, now);
  const activity = st.activity.filter((a) => a.kind === 'consumed' && (!keyFilter || a.keyId === keyFilter));
  const keys = [...new Set(st.activity.map((a) => a.keyId).filter(Boolean))] as string[];
  const fresh = st.freshness[0];
  const stmt = st.statements[st.statements.length - 1];

  return (
    <div className="nsm5-frame">
      <div className="nsm5-card">
        <div className="nsm5-planhead">
          <h1 data-copy="meter.summary">{t('meter.summary', { pct: st.summaryPct ?? 0 })}</h1>
          <span className="nsm5-sec">{exp ? t('meter.plan.resets', { n: exp }).replace(' days', '') : ''}</span>
        </div>
        <p className="nsm5-muted nsm5-xs" data-copy="meter.summary.note">{copy('meter.summary.note')}</p>

        {st.meters.map((m) => {
          const pct = m.guaranteedUnits === 0 ? 0 : Math.round((m.consumedUnits / m.guaranteedUnits) * 100);
          const p = pace(m, plan.startedAt, plan.expiresAt, now);
          const others = st.meters.filter((x) => x.offeringId !== m.offeringId && x.state === 'active');
          return (
            <div key={m.offeringId} className="nsm5-mrow">
              <div className="nsm5-mhead">
                <span data-copy="meter.offering.line">
                  <strong>{m.offeringId}</strong>{' '}
                  <span className="nsm5-muted nsm5-xs">via {m.seller.slice(0, 8)}…</span>
                  {' — '}{pct}% used{exp ? ` · Expires in ${exp}` : ''}
                </span>
                <span className="nsm-mono nsm5-sec" data-copy="chip.left">{Math.max(0, 100 - pct)}% left</span>
              </div>
              <div className={`nsm5-bar${m.state === 'exhausted' ? ' hit' : pct >= 85 ? ' warn' : ''}`}>
                <i style={{ width: `${Math.min(100, pct)}%` }} />
              </div>
              <div className="nsm5-muted nsm5-xs" data-copy="meter.offering.tap">
                {fmtUnits(m.consumedUnits, m.unit)} of {fmtUnits(m.guaranteedUnits, m.unit)}
              </div>
              {m.state === 'exhausted' ? (
                <div className="nsm5-fork">
                  <button className="nsm5-btn nsm5-btn--primary" data-copy="fork.topup">{copy('fork.topup')}</button>
                  <span className="nsm5-sec nsm5-sm" data-copy="fork.line.v2">
                    {others.length
                      ? t('fork.line.v2', { alt: others[0].offeringId,
                          pct: Math.round((1 - others[0].consumedUnits / others[0].guaranteedUnits) * 100) })
                      : ''}
                  </span>
                </div>
              ) : (
                <div className="nsm5-sparkrow">
                  <Spark series={sparks[m.offeringId] ?? []} />
                  <span className={`nsm5-pace ${p.tone}`} data-copy={p.tone === 'warn' ? 'meter.pace.warn' : 'meter.pace.ok'}>{p.text}</span>
                </div>
              )}
            </div>
          );
        })}

        {stmt ? (
          <div className="nsm5-stmtline" data-copy={stmt.resolution === 'agreed' ? 'stmt.line.ok' : 'stmt.line.disputed'}>
            {stmt.resolution === 'agreed'
              ? t('stmt.line.ok', { ours: stmt.items.reduce((s, i) => s + i.buyerCount, 0).toLocaleString(),
                                    theirs: stmt.items.reduce((s, i) => s + i.sellerCount, 0).toLocaleString() })
              : t('stmt.line.disputed', { ours: stmt.items.reduce((s, i) => s + i.buyerCount, 0).toLocaleString(),
                                          theirs: stmt.items.reduce((s, i) => s + i.sellerCount, 0).toLocaleString() })}
          </div>
        ) : fresh && fresh.agree ? (
          <div className="nsm5-muted nsm5-xs" data-copy="stmt.freshness">
            {t('stmt.freshness', { t: fresh.checkedAgoMs != null ? `${Math.max(1, Math.round(fresh.checkedAgoMs / 60_000))} min` : '—' })}
          </div>
        ) : null}
      </div>

      <div className="nsm5-card">
        <div className="nsm5-mhead">
          <h2 data-copy="activity.title">{copy('activity.title')}</h2>
          <span className="nsm5-fchips">
            <button className={keyFilter === null ? 'on' : ''} onClick={() => setKeyFilter(null)}>All</button>
            {keys.map((k) => (
              <button key={k} className={keyFilter === k ? 'on' : ''} onClick={() => setKeyFilter(k)}>{k}</button>
            ))}
          </span>
        </div>
        <table className="nsm5-act">
          <tbody>
            {activity.slice(0, 20).map((a, i) => (
              <tr key={i}>
                <td className="nsm-mono">{new Date(a.at).toTimeString().slice(0, 5)}</td>
                <td>{a.offeringId?.includes('knowledge') || a.phase === 'admission' ? 'query' : a.offeringId}</td>
                <td className="nsm5-muted">via {a.seller?.slice(0, 8)}…</td>
                <td>{(a.units ?? 0).toLocaleString()} {a.offeringId?.includes('knowledge') ? 'units' : 'tokens'}</td>
                <td className="nsm5-muted">{a.keyId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {activity.length === 0 && <div className="nsm5-muted nsm5-xs">—</div>}
      </div>
    </div>
  );
}
