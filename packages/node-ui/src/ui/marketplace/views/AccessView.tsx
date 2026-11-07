// Access: keys with budget chips, per-key mix (who is burning the meters),
// the mint form with every scope a key carries (label · budget · expiry ·
// model allowlist · query · rps), the plaintext shown once behind Done,
// revoked keys marked and inert, the implicit operator key labeled. Minting
// and revoking do nothing yet: fixture data in this step.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { copy } from '../copy.generated.js';
import { marketplaceData, noAction } from '../data.js';
import type { PlanStatus } from '../types.js';
import { ErrorCard, fmtClock, relTime, usdFromMicro } from '../purchase/shared.js';
import { DEFAULT_TRAC_USD } from '../format.js';

type Expiry = 'never' | '7d' | '30d' | '90d';
const EXPIRY_MS: Record<Exclude<Expiry, 'never'>, number> = { '7d': 7 * 86_400_000, '30d': 30 * 86_400_000, '90d': 90 * 86_400_000 };

export function AccessView(): React.ReactElement {
  const [st, setSt] = useState<PlanStatus | null>(null);
  const [err, setErr] = useState<unknown | null>(null);
  const [minted, setMinted] = useState<{ plaintext: string; keyId: string } | null>(null);
  const [mintErr, setMintErr] = useState<unknown | null>(null);
  const [revokeErr, setRevokeErr] = useState<{ keyId: string; err: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('my-agent');
  const [budget, setBudget] = useState('1000000');
  const [expiry, setExpiry] = useState<Expiry>('never');
  const [allModels, setAllModels] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [allowQuery, setAllowQuery] = useState(true);
  const [rps, setRps] = useState('5');
  const inflight = useRef(false);

  const load = () => {
    if (inflight.current) return;
    inflight.current = true;
    marketplaceData.planStatus().then((s) => { setSt(s); setErr(null); }).catch((e) => setErr(e)).finally(() => { inflight.current = false; });
  };
  useEffect(() => { load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const mixByKey = useMemo(() => {
    const out: Record<string, Record<string, number>> = {};
    for (const a of st?.activity ?? []) {
      if (a.kind !== 'consumed' || !a.keyId || !a.offeringId) continue;
      out[a.keyId] = out[a.keyId] ?? {};
      out[a.keyId][a.offeringId] = (out[a.keyId][a.offeringId] ?? 0) + (a.units ?? 0);
    }
    return out;
  }, [st]);

  const activeModels = (st?.meters ?? []).filter((m) => m.unit === 'tokens' && m.state === 'active' && m.enrollment !== 'blocked').map((m) => m.offeringId);
  const budgetMicro = Math.round(Number(budget));
  const rpsNum = Number(rps);
  const mintDisabledKey = !label.trim() ? 'access.error.label' : !(budgetMicro > 0) ? 'access.error.budget' : !(rpsNum > 0) ? 'access.error.rps' : !allModels && models.length === 0 ? 'access.error.models' : null;

  // Minting and revoking need the node; in this step the controls do nothing.
  const mint = () => {
    if (mintDisabledKey || busy) return;
    noAction({
      label: label.trim(), budgetMicroTrac: budgetMicro,
      expiresAt: expiry === 'never' ? null : new Date(Date.now() + EXPIRY_MS[expiry]).toISOString(),
      modelAllowlist: allModels ? null : models, allowQuery, rps: rpsNum,
    });
  };
  const revoke = (keyId: string) => { if (!busy) noAction(keyId); };
  void setMinted; void setMintErr; void setRevokeErr; void setBusy;

  if (err && !st) {
    return (
      <div className="mkt-frame" data-testid="mkt-access" data-state="error">
        <div className="mkt-card"><div data-copy="empty.error">{copy('empty.error')}</div><ErrorCard err={err} onRetry={load} /></div>
      </div>
    );
  }
  if (!st) return <div className="mkt-frame" data-testid="mkt-access" data-state="loading"><div className="mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></div>;

  return (
    <div className="mkt-frame" data-testid="mkt-access" data-state="ok">
      <div className="mkt-card">
        <div className="mkt-planhead">
          <h1 data-copy="access.title">{copy('access.title')}</h1>
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-mint-open" data-copy="access.mint" aria-expanded={formOpen} onClick={() => setFormOpen((o) => !o)}>{copy('access.mint')}</button>
        </div>
        {err ? <ErrorCard err={err} onRetry={load} /> : null}
        {!st.plan && <div className="mkt-muted mkt-xs" data-copy="access.nomodels">{copy('access.nomodels')}</div>}

        {formOpen && (
          <div className="mkt-card mkt-form" data-testid="mkt-mint-form">
            <h2 data-copy="key.mint.title">{copy('key.mint.title')}</h2>
            <label className="mkt-field"><span data-copy="access.label">{copy('access.label')}</span><input className="mkt-input" data-testid="mkt-mint-label" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <label className="mkt-field"><span data-copy="access.budget">{copy('access.budget')}</span>
              <span><input className="mkt-input mkt-mono" data-testid="mkt-mint-budget" inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} />{' '}<span data-copy="access.budget.micro">{copy('access.budget.micro')}</span>
                {' '}<span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{budgetMicro > 0 ? `${usdFromMicro(budgetMicro, DEFAULT_TRAC_USD)} · ${copy('catalog.fx.reference.short')}` : ''}</span></span></label>
            <label className="mkt-field"><span data-copy="access.expiry">{copy('access.expiry')}</span>
              <select className="mkt-input" data-testid="mkt-mint-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                <option value="never">{copy('access.expiry.never')}</option>
                <option value="7d">{copy('access.expiry.days', { n: 7 })}</option>
                <option value="30d">{copy('access.expiry.days', { n: 30 })}</option>
                <option value="90d">{copy('access.expiry.days', { n: 90 })}</option>
              </select></label>
            <fieldset className="mkt-field" data-testid="mkt-mint-models">
              <legend data-copy="access.models">{copy('access.models')}</legend>
              <label className="mkt-xs"><input type="checkbox" checked={allModels} onChange={(e) => setAllModels(e.target.checked)} />{' '}<span data-copy="access.models.all">{copy('access.models.all')}</span></label>
              {!allModels && activeModels.length === 0 && <span className="mkt-muted mkt-xs" data-copy="access.models.none">{copy('access.models.none')}</span>}
              {!allModels && activeModels.map((id) => (
                <label key={id} className="mkt-xs"><input type="checkbox" checked={models.includes(id)} onChange={(e) => setModels((m) => (e.target.checked ? [...m, id] : m.filter((x) => x !== id)))} />{' '}<span data-copy="_data">{id}</span></label>
              ))}
            </fieldset>
            <label className="mkt-field mkt-xs"><input type="checkbox" data-testid="mkt-mint-query" checked={allowQuery} onChange={(e) => setAllowQuery(e.target.checked)} />{' '}<span data-copy="access.query">{copy('access.query')}</span></label>
            <label className="mkt-field"><span data-copy="access.rps">{copy('access.rps')}</span><input className="mkt-input mkt-mono" data-testid="mkt-mint-rps" inputMode="numeric" value={rps} onChange={(e) => setRps(e.target.value)} /></label>
            {mintErr ? <ErrorCard err={mintErr} onRetry={mint}><span data-copy="access.error.mint" className="mkt-muted mkt-xs">{copy('access.error.mint')}</span></ErrorCard> : null}
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-mint" data-copy="access.mint.cta" onClick={mint} disabled={!!mintDisabledKey || busy === 'mint'} title={mintDisabledKey ? copy(mintDisabledKey) : undefined}>
                {busy === 'mint' ? copy('state.working') : copy('access.mint.cta')}
              </button>
              {mintDisabledKey && <span className="mkt-muted mkt-xs" data-copy={mintDisabledKey}>{copy(mintDisabledKey)}</span>}
              <button type="button" className="mkt-btn" data-copy="ctl.cancel" onClick={() => setFormOpen(false)}>{copy('ctl.cancel')}</button>
            </div>
          </div>
        )}

        {minted && (
          <div className="mkt-card mkt-once" data-testid="mkt-key-once">
            <strong data-copy="access.minted">{copy('access.minted')}</strong>
            <div className="mkt-snippet" data-testid="mkt-key-plaintext" data-copy="_data">base_url = "{window.location.origin}/marketplace/gateway/v1"<br />api_key&nbsp;&nbsp;= "{minted.plaintext}"</div>
            <div className="mkt-warnonce" data-copy="onboard.key.once">{copy('onboard.key.once')}</div>
            <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-key-done" data-copy="ctl.done" onClick={() => setMinted(null)}>{copy('ctl.done')}</button>
          </div>
        )}

        {st.keys.length === 0 && <div className="mkt-muted mkt-xs" data-copy="empty.keys">{copy('empty.keys')}</div>}
        {st.keys.map((k) => {
          const mix = mixByKey[k.keyId] ?? {};
          const total = Object.values(mix).reduce((s, v) => s + v, 0);
          const top = Object.entries(mix).sort((a, b) => b[1] - a[1])[0];
          const capPct = k.scopes.budgetMicroTrac === 0 ? 0 : Math.round((k.spentMicroTrac / k.scopes.budgetMicroTrac) * 100);
          const scopeBits = [
            k.scopes.modelAllowlist ? copy('access.scope.models', { n: k.scopes.modelAllowlist.length }) : copy('access.models.all'),
            k.scopes.allowQuery ? copy('access.scope.query.on') : copy('access.scope.query.off'),
            copy('access.scope.rps', { n: k.scopes.rps }),
            k.scopes.expiresAt ? copy('access.expires.in', { t: relTime(k.scopes.expiresAt) }) : copy('access.expiry.never'),
          ].join(' · ');
          return (
            <div key={k.keyId} className={`mkt-krow${k.revoked ? ' revoked' : ''}`} data-testid={`mkt-key-${k.keyId}`} data-revoked={k.revoked}>
              <span>
                <strong data-copy="_data">{k.scopes.label ?? k.keyId}</strong>{' '}
                <span className="mkt-mono mkt-muted mkt-xs" data-copy="_data">{k.keyId}…</span>
                {k.implicit && <span className="mkt-muted mkt-xs" data-copy="access.implicit"> · {copy('access.implicit')}</span>}
                <div className="mkt-muted mkt-xs" data-copy="access.mix">
                  {top ? copy('access.mix', { mix: `${copy('access.mix.mostly', { top: top[0] })}${Object.keys(mix).length > 1 ? ` · ${Math.round(((total - top[1]) / total) * 100)}% ${copy('access.mix.other')}` : ''}` }) : copy('empty.activity')}
                </div>
                <div className="mkt-muted mkt-xs" data-copy="access.scopes">{scopeBits}{' · '}{copy('access.minted.at', { t: fmtClock(k.mintedAt) })}</div>
                {revokeErr?.keyId === k.keyId ? <ErrorCard err={revokeErr.err} onRetry={() => revoke(k.keyId)}><span className="mkt-muted mkt-xs" data-copy="access.error.revoke">{copy('access.error.revoke')}</span></ErrorCard> : null}
              </span>
              <span className="mkt-chipleft" data-copy="access.cap">{copy('access.cap', { pct: capPct })}</span>
              {k.revoked
                ? <span className="mkt-chipblock" data-copy="key.revoked">{copy('key.revoked')}</span>
                : k.implicit
                  ? <span className="mkt-muted mkt-xs" data-copy="access.implicit.norevoke">{copy('access.implicit.norevoke')}</span>
                  : <button type="button" className="mkt-btn" data-testid={`mkt-revoke-${k.keyId}`} data-copy="access.revoke.btn" onClick={() => revoke(k.keyId)} disabled={busy === k.keyId}>{busy === k.keyId ? copy('state.working') : copy('access.revoke.btn')}</button>}
            </div>
          );
        })}
        <p className="mkt-muted mkt-xs" data-copy="access.revoke">{copy('access.revoke')}</p>
      </div>
    </div>
  );
}
