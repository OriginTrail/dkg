// Surface 06 — Access, keys for agents (spec docs/ui-spec/surfaces/06-access-keys.md).
// The account console with budget discipline: per-key linear gauges, spend
// chart from real usage rows, key-conservation check, mint-once modal
// (reusing the onboarding form contract), revoke with next-call semantics.
import React, { useMemo, useState } from 'react';
import { copy } from './copy.generated.js';
import { LinearGauge, ProvBadge } from './components.js';
import { fmtMicro } from './format.js';
import { mintGatewayKey, revokeGatewayKey, type NsmKeyRecord, type NsmOperateStatus } from './api.js';

function keyState(k: NsmKeyRecord): 'active' | 'exhausted' | 'revoked' | 'expired' {
  if (k.revoked) return 'revoked';
  if (k.scopes.expiresAt && Date.now() > Date.parse(k.scopes.expiresAt)) return 'expired';
  if (k.spentMicroTrac >= k.scopes.budgetMicroTrac) return 'exhausted';
  return 'active';
}

export function AccessView({ status, refresh }: {
  status: NsmOperateStatus | null | 'error'; refresh: () => void;
}): React.ReactElement {
  const [minting, setMinting] = useState(false);
  const [keyName, setKeyName] = useState('my-agent');
  const [keyCap, setKeyCap] = useState('250000');
  const [minted, setMinted] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const keys = status !== null && status !== 'error' ? status.keys : [];
  const usage = status !== null && status !== 'error'
    ? ((status as unknown as { keyUsage?: Array<{ keyId: string; costMicroTrac: number; at: string }> }).keyUsage ?? [])
    : [];

  // key-conservation: Σ per-key sub-ledgers vs the sum of usage rows —
  // recomputed here, red on mismatch (fixture-breakable in the gallery)
  const conservation = useMemo(() => {
    const fromKeys = keys.reduce((s, k) => s + k.spentMicroTrac, 0);
    const fromUsage = usage.reduce((s, u) => s + Number(u.costMicroTrac ?? 0), 0);
    return { ok: fromKeys === fromUsage, fromKeys, fromUsage };
  }, [keys, usage]);

  const doMint = () => {
    setErr(null);
    mintGatewayKey({ label: keyName, budgetMicroTrac: Math.max(1, Math.round(Number(keyCap) || 0)), allowQuery: true, rps: 5 })
      .then((r) => { setMinted(r.key); refresh(); })
      .catch((e) => setErr(String((e as Error).message)));
  };
  const doRevoke = (keyId: string) => {
    setRevoking(null); setErr(null);
    revokeGatewayKey(keyId).then(() => refresh()).catch((e) => setErr(String((e as Error).message)));
  };

  if (status === null) {
    return <div className="card card--pad"><span className="skel">loading keys</span></div>;
  }
  if (status === 'error') {
    return (
      <div className="card card--pad row row--between" style={{ flexWrap: 'wrap' }}>
        <span className="sec">{copy('err.offline')}</span>
        <button className="btn" onClick={refresh}>{copy('ctl.retry')}</button>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 'var(--sp-5)' }}>
      <div className="row row--between">
        <h2>{copy('nav.access')}</h2>
        <button className="btn btn--primary" onClick={() => { setMinting(true); setMinted(null); }}>{copy('key.mint')}</button>
      </div>

      {err && <div className="card" style={{ padding: 'var(--sp-3) var(--sp-4)' }}><span className="sec sm">{copy('err.5xx')} <span className="mono xs">({err})</span></span></div>}

      {keys.length === 0 ? (
        <div className="card card--pad" style={{ textAlign: 'center' }}><span className="sec">{copy('empty.keys')}</span></div>
      ) : (
        <div className="card scroll-x">
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Budget</th><th>Models</th><th>Q</th><th className="num">rps</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => {
                const st = keyState(k);
                const pct = k.scopes.budgetMicroTrac > 0 ? (k.spentMicroTrac / k.scopes.budgetMicroTrac) * 100 : 0;
                return (
                  <tr key={k.keyId} className={`keyrow${st === 'revoked' ? ' tr--revoked' : ''}`}
                    onClick={() => setDetail(detail === k.keyId ? null : k.keyId)} style={{ cursor: 'pointer' }}>
                    <td>{k.scopes.label ?? (k.implicit ? 'node-operator' : '—')}</td>
                    <td className="mono">{k.keyId}…</td>
                    <td>
                      <LinearGauge pct={pct} mode={st === 'exhausted' ? 'over' : st === 'revoked' ? 'low' : 'mid'} />
                      <div className="xs" style={{
                        marginTop: 'var(--sp-1)',
                        color: st === 'exhausted' ? 'var(--gauge-over)' : 'var(--text-muted)',
                      }}>
                        {st === 'exhausted' ? copy('key.exhausted')
                          : st === 'revoked' ? copy('key.revoked')
                          : copy('key.budget', { spent: fmtMicro(k.spentMicroTrac), cap: fmtMicro(k.scopes.budgetMicroTrac) })}
                      </div>
                    </td>
                    <td>
                      <div className="scopes">
                        {k.scopes.modelAllowlist
                          ? k.scopes.modelAllowlist.map((m) => <span key={m} className="chip">{m} <ProvBadge cls="weights-pinned" /></span>)
                          : <span className="chip">any</span>}
                      </div>
                    </td>
                    <td>{k.scopes.allowQuery ? <span className="badge--pinned">✓</span> : <span className="muted">—</span>}</td>
                    <td className="num mono">{k.scopes.rps}</td>
                    <td className="num">
                      {st !== 'revoked' && !k.implicit && (
                        <button className="btn btn--danger btn--sm" onClick={(e) => { e.stopPropagation(); setRevoking(k.keyId); }}>{copy('key.revoke')}</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail && (() => {
        const k = keys.find((x) => x.keyId === detail);
        if (!k) return null;
        const rows = usage.filter((u) => u.keyId === k.keyId);
        const byDay = new Map<string, number>();
        for (const u of rows) {
          const day = String(u.at).slice(0, 10);
          byDay.set(day, (byDay.get(day) ?? 0) + Number(u.costMicroTrac ?? 0));
        }
        const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14);
        const max = Math.max(1, ...days.map(([, v]) => v));
        return (
          <div className="card card--pad stack" style={{ maxWidth: 'calc(var(--card-min-w) * 2)' }}>
            <div className="row row--between">
              <div><span className="mono">{k.keyId}…</span> <span className="sec">{k.scopes.label ?? ''}</span></div>
              {k.scopes.expiresAt && <div className="xs muted">{copy('key.expiry', { n: Math.max(0, Math.ceil((Date.parse(k.scopes.expiresAt) - Date.now()) / 86_400_000)) })}</div>}
            </div>
            {days.length > 0 ? (
              <div className="spark" aria-label="spend by day">
                {days.map(([d, v]) => <i key={d} style={{ height: `${Math.round((v / max) * 100)}%` }} title={`${d}: ${fmtMicro(v)}`} />)}
              </div>
            ) : (
              <div className="sec sm">{copy('empty.activity')}</div>
            )}
            <div className="sm">
              {conservation.ok
                ? <><span className="badge--pinned">✓</span> {copy('key.sum.ok')} <span className="xs muted">— {copy('key.sum.gloss')}</span></>
                : <span style={{ color: 'var(--state-blocked)' }}>⚠ {copy('key.sum.broken', { sum: conservation.fromKeys.toLocaleString('en-US'), billed: conservation.fromUsage.toLocaleString('en-US') })}</span>}
            </div>
          </div>
        );
      })()}

      {minting && (
        <div className="drawer" style={{ maxWidth: 'calc(var(--card-min-w) * 1.6)' }}>
          <div className="sm" style={{ marginBottom: 'var(--sp-3)' }}>{copy('key.mint.title')}</div>
          {!minted ? (
            <>
              <div className="row row--wrap-mobile" style={{ marginBottom: 'var(--sp-3)' }}>
                <label className="sec sm" htmlFor="ak-name">{copy('key.name.label')}</label>
                <input id="ak-name" className="input mono" size={14} value={keyName} onChange={(e) => setKeyName(e.target.value)} />
                <label className="sec sm" htmlFor="ak-cap">{copy('key.cap.label')}</label>
                <input id="ak-cap" className="input mono" size={10} value={keyCap} onChange={(e) => setKeyCap(e.target.value)} />
                <span className="xs muted">µ</span>
              </div>
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn--ghost btn--sm" onClick={() => setMinting(false)}>{copy('ctl.cancel')}</button>
                <button className="btn btn--primary btn--sm" onClick={doMint}>{copy('key.mint')}</button>
              </div>
            </>
          ) : (
            <>
              <div className="mono xs" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: 'var(--sp-3)', overflowWrap: 'anywhere' }}>{minted}</div>
              <div className="warn-once" style={{ marginTop: 'var(--sp-2)' }}>⚠ {copy('onboard.key.once')}</div>
              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-3)' }}>
                <button className="btn btn--primary btn--sm" onClick={() => { setMinted(null); setMinting(false); }}>{copy('ctl.done')}</button>
              </div>
            </>
          )}
        </div>
      )}

      {revoking && (
        <div className="drawer" style={{ maxWidth: 'calc(var(--card-min-w) * 1.5)' }}>
          <div className="sm" style={{ marginBottom: 'var(--sp-2)' }}>{copy('key.revoke')} <span className="mono">{revoking}…</span>?</div>
          <div className="xs muted" style={{ marginBottom: 'var(--sp-3)' }}>{copy('key.revoked')}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn--ghost btn--sm" onClick={() => setRevoking(null)}>{copy('ctl.cancel')}</button>
            <button className="btn btn--danger btn--sm" onClick={() => doRevoke(revoking)}>{copy('key.revoke')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
