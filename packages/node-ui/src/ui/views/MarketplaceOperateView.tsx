// NSM v3 — Operate: the seller/buyer operator surface (spec A7, C-views).
// Three panels over ONE real endpoint (/marketplace/operate/status, node-token
// gated): Offerings (+ threshold meter) · Tabs & Usage (per-leg outcomes) ·
// Access (gateway keys). Minimal but real — every number is a live ledger
// projection; nothing here is illustrative.
import React, { useEffect, useState } from 'react';
import { getJson } from '../http.js';

interface OperateStatus {
  enabled: boolean;
  offerings: Array<{
    id: string; provenanceClass: string; modelId: string; tokenizerBundleRef: string;
    pricing: { perInputTokenMicroTrac: number; perOutputTokenMicroTrac: number; queryFlatMicroTrac: number; perReturnedQuadMicroTrac: number };
    offeringUal: string | null;
  }>;
  tabs: Array<{
    tabId: string; principal: string; txHash: string; depositMicroTrac: number; openedAt: string;
    quantities: { deposits: number; billed: number; released: number; balance: number };
  }>;
  legs: Array<{
    legId: string; legType: string; tabId: string; offeringId: string; provenanceClass: string;
    cost: number; status: { status: string; code?: string }; at: string;
  }>;
  threshold: { unsettledEarnedMicroTrac: number; allowed: boolean; thresholdMicroTrac: number };
  keys: Array<{ keyId: string; scopes: { budgetMicroTrac: number; rps: number; allowQuery: boolean }; revoked: boolean; spentMicroTrac: number; mintedAt: string }>;
}

const badge = (pc: string) => (pc === 'weights-pinned' ? '⛓' : '☁');
const µ = (n: number | undefined) => (n == null ? '—' : n.toLocaleString('en-US') + ' µ');

export function MarketplaceOperateView(): React.ReactElement {
  const [st, setSt] = useState<OperateStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    getJson<OperateStatus>('/marketplace/operate/status')
      .then((r) => { setSt(r); setErr(null); })
      .catch((e) => setErr(String(e).slice(0, 200)));
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [tick]);

  if (err) {
    return <div className="nsm-empty">Operate status unavailable: {err} — is <span className="nsm-mono">marketplace.enabled</span> true on this node?</div>;
  }
  if (!st) return <div className="nsm-empty">Loading operate status…</div>;

  const th = st.threshold;
  const pct = Math.min(100, Math.round((th.unsettledEarnedMicroTrac / Math.max(1, th.thresholdMicroTrac)) * 100));

  return (
    <div style={{ padding: '4px 2px' }}>
      {/* ── Offerings ── */}
      <div className="nsm-sec">
        <div className="nsm-colhead nsm-grid-op-off">
          <span>Offering</span><span>Class</span><span>per-in / per-out</span><span>query flat / per-quad</span><span>Tokenizer pin</span><span>Published</span>
        </div>
        {st.offerings.length === 0 && <div className="nsm-empty">No offerings mounted. Configure <span className="nsm-mono">marketplace/config.json</span> and restart.</div>}
        {st.offerings.map((o) => (
          <div className="nsm-row nsm-grid-op-off" key={o.id} style={{ cursor: 'default' }}>
            <span className="nsm-name">{o.modelId} <span className="nsm-dim">({o.id})</span></span>
            <span>{badge(o.provenanceClass)} <span className="nsm-dim">{o.provenanceClass}</span></span>
            <span className="nsm-mono">{o.pricing.perInputTokenMicroTrac}µ / {o.pricing.perOutputTokenMicroTrac}µ</span>
            <span className="nsm-mono">{o.pricing.queryFlatMicroTrac}µ / {o.pricing.perReturnedQuadMicroTrac}µ</span>
            <span className="nsm-mono" title={o.tokenizerBundleRef}>{o.tokenizerBundleRef.slice(0, 22)}…</span>
            <span className="nsm-mono">{o.offeringUal ? '✓ KA' : '— not yet'}</span>
          </div>
        ))}
        {/* threshold meter — settlement election posture, live */}
        <div className="nsm-detail" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
            <span>Settlement election — unsettled earned vs gas/ε threshold</span>
            <span className="nsm-mono">{µ(th.unsettledEarnedMicroTrac)} / {µ(th.thresholdMicroTrac)}</span>
          </div>
          <div style={{ background: 'var(--bg-hover)', borderRadius: 4, height: 8, marginTop: 6 }}>
            <div style={{ width: pct + '%', height: 8, borderRadius: 4, background: th.allowed ? 'var(--accent-success, #26796a)' : 'var(--accent-warning, #b1741f)' }} />
          </div>
          <div className="nsm-dim" style={{ fontSize: 11.5, marginTop: 6 }}>
            {th.allowed
              ? 'Above threshold — the provider MAY elect settlement (loopback-gated mutation; nothing auto-releases).'
              : `Refused — settling now would burn more gas than ε permits. Carry accumulates (${pct}% of threshold).`}
          </div>
        </div>
      </div>

      {/* ── Tabs & Usage ── */}
      <div className="nsm-sec">
        <div className="nsm-colhead nsm-grid-op-tab">
          <span>Tab</span><span>Principal</span><span>Deposit</span><span>Billed</span><span>Balance</span><span>Opened</span>
        </div>
        {st.tabs.length === 0 && <div className="nsm-empty">No open tabs.</div>}
        {st.tabs.map((t) => (
          <div className="nsm-row nsm-grid-op-tab" key={t.tabId} style={{ cursor: 'default' }}>
            <span className="nsm-mono">{t.tabId}</span>
            <span className="nsm-mono" title={t.principal}>{t.principal.slice(0, 10)}…{t.principal.slice(-4)}</span>
            <span className="nsm-mono">{µ(t.quantities.deposits)}</span>
            <span className="nsm-mono">{µ(t.quantities.billed)}</span>
            <span className="nsm-mono">{µ(t.quantities.balance)}</span>
            <span className="nsm-dim">{t.openedAt.slice(0, 19).replace('T', ' ')}</span>
          </div>
        ))}
        <div className="nsm-colhead nsm-grid-op-leg" style={{ marginTop: 12 }}>
          <span>Leg</span><span>Type</span><span>Class</span><span>Cost</span><span>Outcome</span><span>At</span>
        </div>
        {st.legs.length === 0 && <div className="nsm-empty">No legs served.</div>}
        {st.legs.slice(-40).reverse().map((l) => (
          <div className="nsm-row nsm-grid-op-leg" key={l.legId} style={{ cursor: 'default' }}>
            <span className="nsm-mono">{l.legId.slice(0, 14)}…</span>
            <span>{l.legType}</span>
            <span>{badge(l.provenanceClass)}</span>
            <span className="nsm-mono">{µ(l.cost)}</span>
            <span className={l.status.status === 'withheld' ? 'nsm-withheld' : l.status.status === 'countersigned' ? 'nsm-ok' : 'nsm-dim'}>
              {l.status.status}{l.status.code ? ` · ${l.status.code}` : ''}
            </span>
            <span className="nsm-dim">{String(l.at).slice(11, 19)}</span>
          </div>
        ))}
      </div>

      {/* ── Access (gateway keys) ── */}
      <div className="nsm-sec">
        <div className="nsm-colhead nsm-grid-op-key">
          <span>Key</span><span>Budget</span><span>Spent</span><span>rps</span><span>Query</span><span>State</span>
        </div>
        {st.keys.length === 0 && <div className="nsm-empty">No gateway keys minted. Mint via <span className="nsm-mono">POST /marketplace/gateway/v1/keys</span> (loopback).</div>}
        {st.keys.map((k) => (
          <div className="nsm-row nsm-grid-op-key" key={k.keyId} style={{ cursor: 'default' }}>
            <span className="nsm-mono">{k.keyId}…</span>
            <span className="nsm-mono">{µ(k.scopes.budgetMicroTrac)}</span>
            <span className="nsm-mono">{µ(k.spentMicroTrac)}</span>
            <span className="nsm-mono">{k.scopes.rps}</span>
            <span>{k.scopes.allowQuery ? '✓' : '—'}</span>
            <span className={k.revoked ? 'nsm-withheld' : 'nsm-ok'}>{k.revoked ? 'revoked' : 'active'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
