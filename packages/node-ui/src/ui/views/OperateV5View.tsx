// Seller Operate v5 — ask editor (takes effect next cycle), subscriber
// list, statement queue, the DEDICATED revenue wallet (visibly separate
// from ops), calibration export. Replaces the tab-era Operate surface.
import React, { useEffect, useState } from 'react';
import { copy } from '../nsm/copy.generated.js';
import { authHeaders } from '../http.js';

interface OperateStatus {
  sellerActive: boolean;
  offerings: Array<{ id: string; modelId: string; tokenizerBundleRef: string; offeringUal: string | null;
    ask: { askMicroPerUnit: number; unit: string; effectiveFromCycle: number } | null;
    queuedAsk: { askMicroPerUnit: number } | null }>;
  subscribers: Array<{ buyer: string; periodId: string; expiresAt: string; offerings: string[]; paymentIdentity: string }>;
  revenueWallet: string | null;
  statements: Array<{ pair: string; periodId: string; resolution: string;
    items: Array<{ offeringId: string; buyerCount: number; sellerCount: number }> }>;
  checkpointChains: Array<{ pair: string; length: number; freshness: { agree: boolean; checkedAgoMs: number | null } }>;
  keys: Array<{ keyId: string }>;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export function OperateV5View(): React.ReactElement {
  const [st, setSt] = useState<OperateStatus | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = () => req<OperateStatus>('/marketplace/operate/status').then(setSt).catch(() => undefined);
  useEffect(() => { load(); const iv = setInterval(load, 8_000); return () => clearInterval(iv); }, []);

  const queueAsk = async (offeringId: string, unit: string) => {
    const v = Number(edits[offeringId]);
    if (!v || v <= 0) return;
    const cur = st?.subscribers[0]?.periodId ? 1 : 1;   // current cycle from status when available
    await req('/marketplace/operate/ask', { method: 'POST',
      body: JSON.stringify({ offeringId, unit, askMicroPerUnit: v, effectiveFromCycle: cur + 1, currentCycle: cur }) });
    setEdits((e) => ({ ...e, [offeringId]: '' }));
    load();
  };

  const exportCalibration = async () => {
    const data = await req<Record<string, unknown>>('/marketplace/operate/calibration');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'nsm-calibration.json';
    a.click();
  };

  if (!st) return <div className="nsm5-frame"><div className="nsm5-card nsm5-muted">…</div></div>;

  return (
    <div className="nsm5-frame">
      <div className="nsm5-card">
        <h2 style={{ margin: 0 }} data-copy="op.ask.editor">{copy('op.ask.editor')}</h2>
        {st.offerings.map((o) => (
          <div key={o.id} className="nsm5-mhead" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--sp-3)' }}>
            <span><strong>{o.id}</strong>{' '}
              {o.offeringUal
                ? <span className="nsm5-yours">✓ KA</span>
                : <span className="nsm5-muted nsm5-xs">— not yet</span>}
            </span>
            <span className="nsm-mono nsm5-sec">
              {o.ask ? `${o.ask.askMicroPerUnit} µ/${o.ask.unit === 'query-units' ? 'unit' : 'tok'}` : '—'}
              {' → '}
              <input value={edits[o.id] ?? ''} placeholder={o.queuedAsk ? String(o.queuedAsk.askMicroPerUnit) : '…'}
                onChange={(e) => setEdits((x) => ({ ...x, [o.id]: e.target.value }))}
                style={{ width: '6ch', background: 'var(--surface-0)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', color: 'var(--text-primary)', padding: '0 var(--sp-2)' }} />
              <button className="nsm5-btn" style={{ marginLeft: 'var(--sp-2)' }}
                onClick={() => queueAsk(o.id, o.ask?.unit ?? 'tokens')}>next cycle</button>
            </span>
          </div>
        ))}
        <p className="nsm5-muted nsm5-xs">Current subscribers keep their frozen price until their period expires.</p>
      </div>

      <div className="nsm5-card">
        <h2 style={{ margin: 0 }} data-copy="op.subscribers">{st.subscribers.length} active subscriptions this period</h2>
        {st.subscribers.map((s) => (
          <div key={s.paymentIdentity} className="nsm5-mhead" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--sp-3)' }}>
            <span className="nsm-mono">{s.buyer.slice(0, 10)}…</span>
            <span className="nsm5-sec nsm5-sm">{s.offerings.join(' · ')} · expires {new Date(s.expiresAt).toTimeString().slice(0, 5)}</span>
          </div>
        ))}
        {st.checkpointChains.map((c) => (
          <div key={c.pair} className="nsm5-muted nsm5-xs" data-copy="stmt.freshness">
            checkpoints: {c.length} · {c.freshness.agree
              ? `Counts agree ✓ · checked ${Math.max(1, Math.round((c.freshness.checkedAgoMs ?? 0) / 60_000))} min ago`
              : 'no agreement recorded yet'}
          </div>
        ))}
      </div>

      <div className="nsm5-card">
        <h2 style={{ margin: 0 }} data-copy="op.wallets">{copy('op.wallets')}</h2>
        <div className="nsm5-wallet rev">
          <strong data-copy="op.revenue.wallet">{copy('op.revenue.wallet')}</strong><br />
          <span className="nsm-mono">{st.revenueWallet ?? '—'}</span><br />
          <span className="nsm5-muted nsm5-xs" data-copy="op.revenue.note">{copy('op.revenue.note')}</span>
        </div>
        <div className="nsm5-mhead">
          <span className="nsm5-muted nsm5-xs">Prototype 4 archive (read-only)</span>
          <button className="nsm5-btn" data-copy="op.calibration" onClick={exportCalibration}>{copy('op.calibration')}</button>
        </div>
      </div>
    </div>
  );
}
