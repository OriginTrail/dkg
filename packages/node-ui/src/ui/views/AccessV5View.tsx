// Access — keys with budget chips, per-key mix, mint (shown once), revoke
// semantics. D12: per-key attribution connects the activity ledger to WHO
// is burning the meters.
import React, { useEffect, useMemo, useState } from 'react';
import { copy } from '../nsm/copy.generated.js';
import { authHeaders } from '../http.js';
import { fetchSubsStatus, type V5SubsStatus } from '../nsm/v5-api.js';

export function AccessV5View(): React.ReactElement {
  const [st, setSt] = useState<V5SubsStatus | null>(null);
  const [minted, setMinted] = useState<{ plaintext: string; keyId: string } | null>(null);
  const [label, setLabel] = useState('my-agent');

  const load = () => fetchSubsStatus().then(setSt).catch(() => undefined);
  useEffect(() => { load(); const iv = setInterval(load, 8_000); return () => clearInterval(iv); }, []);

  const mixByKey = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const a of st?.activity ?? []) {
      if (a.kind !== 'consumed' || !a.keyId || !a.offeringId) continue;
      out[a.keyId] = out[a.keyId] ?? {};
      out[a.keyId][a.offeringId] = (out[a.keyId][a.offeringId] ?? 0) + (a.units ?? 0);
    }
    return out;
  }, [st]);

  const mint = async () => {
    const res = await fetch('/marketplace/gateway/v1/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ label, budgetMicroTrac: 1_000_000 }),
    });
    const out = (await res.json()) as { plaintext: string; record: { keyId: string } };
    setMinted({ plaintext: out.plaintext, keyId: out.record.keyId });
    load();
  };

  const revoke = async (keyId: string) => {
    await fetch(`/marketplace/gateway/v1/keys/${keyId}/revoke`, { method: 'POST', headers: authHeaders() });
    load();
  };

  if (!st) return <div className="nsm5-frame"><div className="nsm5-card nsm5-muted">…</div></div>;

  return (
    <div className="nsm5-frame">
      <div className="nsm5-card">
        <div className="nsm5-planhead">
          <h1 style={{ margin: 0 }} data-copy="access.title">{copy('access.title')}</h1>
          <span style={{ display: 'flex', gap: 'var(--sp-2)' }}>
            <input className="nsm5-inputrow-input" value={label} onChange={(e) => setLabel(e.target.value)}
              style={{ background: 'var(--surface-0)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', color: 'var(--text-primary)', padding: 'var(--sp-1) var(--sp-3)', fontSize: 'var(--fs-sm)', width: '12ch' }} />
            <button className="nsm5-btn nsm5-btn--primary" data-copy="access.mint" onClick={mint}>{copy('access.mint')}</button>
          </span>
        </div>
        {minted && (
          <div className="nsm5-card" style={{ background: 'var(--surface-2)' }}>
            <div className="nsm5-snippet">base_url = "{window.location.origin}/marketplace/gateway/v1"<br />api_key&nbsp;&nbsp;= "{minted.plaintext}"</div>
            <div className="nsm5-warnonce" data-copy="onboard.key.once">{copy('onboard.key.once')}</div>
          </div>
        )}
        {st.keys.map((k) => {
          const mix = mixByKey[k.keyId] ?? {};
          const total = Object.values(mix).reduce((s, v) => s + v, 0);
          const top = Object.entries(mix).sort((a, b) => b[1] - a[1])[0];
          const capPct = k.scopes.budgetMicroTrac === 0 ? 0 : Math.round((k.spentMicroTrac / k.scopes.budgetMicroTrac) * 100);
          return (
            <div key={k.keyId} className="nsm5-krow">
              <span>
                <strong>{k.scopes.label ?? k.keyId}</strong>{' '}
                <span className="nsm-mono nsm5-muted nsm5-xs">{k.keyId}…</span>
                <div className="nsm5-muted nsm5-xs" data-copy="access.mix">
                  {top ? `mostly ${top[0]}${Object.keys(mix).length > 1 ? ` · ${Math.round(((total - top[1]) / total) * 100)}% other` : ''}` : '—'}
                </div>
              </span>
              <span className="nsm5-chipleft" data-copy="access.cap">{capPct}% of cap</span>
              <button className="nsm5-btn" data-copy="access.revoke.btn" onClick={() => revoke(k.keyId)}>{copy('access.revoke.btn')}</button>
            </div>
          );
        })}
        <p className="nsm5-muted nsm5-xs" data-copy="access.revoke">{copy('access.revoke')}</p>
      </div>
    </div>
  );
}
