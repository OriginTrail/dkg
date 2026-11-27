// Access: the gateway's keys, in TRAC: label and prefix, budget spent,
// reserved for calls not yet settled, and left, the services a key may call,
// its rate, expiry and last use, and which service its calls mostly went to.
// Minting shows the secret once; revoking stops the key at its next call.
// Keys are the node admin's alone.
import { Badge } from '../../components/ds/Badge.js';
import React, { useMemo, useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceAbsent, isMarketplaceOff, marketplaceApi, needsNodeAdmin } from '../api/client.js';
import type { Key, MadeKey } from '../api/types.js';
import { fmtTrac, modelName, pctOf, usdOf, weiOfTrac } from '../amounts.js';
import { AdminCard, ErrorCard, MarketplacePage, OffCard, relAt, useLoad } from '../shared.js';
import { KeyOnce } from '../purchase/KeyStep.js';

type Expiry = 'never' | '7' | '30' | '90';
const DAY = 86_400;

/** What a key holds for calls not yet settled; a node from before reserved values answers without one. */
const reservedOf = (k: Key): bigint => BigInt(k.reserved ?? '0');

export function AccessView(): React.ReactElement {
  const keys = useLoad(() => marketplaceApi.keys());
  const cat = useLoad(() => marketplaceApi.catalog());
  const subs = useLoad(() => marketplaceApi.subscriptions());
  const activity = useLoad(() => marketplaceApi.activity());
  const [made, setMade] = useState<MadeKey | null>(null);
  const [mintErr, setMintErr] = useState<unknown>(null);
  const [revokeErr, setRevokeErr] = useState<{ keyId: string; err: unknown } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [label, setLabel] = useState('my-agent');
  const [budget, setBudget] = useState('1');
  const [expiry, setExpiry] = useState<Expiry>('never');
  const [allServices, setAllServices] = useState(true);
  const [services, setServices] = useState<string[]>([]);
  const [rps, setRps] = useState('5');

  const label_ = (id: string) => modelName(cat.data?.services.find((s) => s.serviceId === id)?.label ?? id);
  const funded = (subs.data?.subscriptions.find((s) => s.epoch === cat.data?.epoch)?.budgets ?? []).map((b) => b.serviceId);
  const mixByKey = useMemo(() => {
    const out: Record<string, Record<string, bigint>> = {};
    for (const c of activity.data?.calls ?? []) {
      out[c.keyId] = out[c.keyId] ?? {};
      out[c.keyId][c.serviceId] = (out[c.keyId][c.serviceId] ?? 0n) + BigInt(c.value);
    }
    return out;
  }, [activity.data]);

  const wei = weiOfTrac(budget);
  const rpsNum = Number(rps);
  const mintDisabledKey = !label.trim() ? 'access.error.label' : !wei ? 'access.error.budget'
    : !(Number.isInteger(rpsNum) && rpsNum >= 1 && rpsNum <= 1_000) ? 'access.error.rps' : !allServices && services.length === 0 ? 'access.error.models' : null;

  const mint = () => {
    if (mintDisabledKey || busy) return;
    setBusy('mint'); setMintErr(null);
    marketplaceApi.makeKey({
      label: label.trim(), budget: wei!.toString(), services: allServices ? null : services, rps: rpsNum,
      expiresAt: expiry === 'never' ? null : Math.floor(Date.now() / 1000) + Number(expiry) * DAY,
    }).then((k) => { setMade(k); setFormOpen(false); keys.reload(); }).catch(setMintErr).finally(() => setBusy(null));
  };
  const revoke = (keyId: string) => {
    if (busy) return;
    setBusy(keyId); setRevokeErr(null);
    marketplaceApi.revokeKey(keyId).then(() => keys.reload()).catch((err: unknown) => setRevokeErr({ keyId, err })).finally(() => setBusy(null));
  };

  if (isMarketplaceOff(keys.err)) return <MarketplacePage page="access" state="off"><OffCard /></MarketplacePage>;
  if (isMarketplaceAbsent(keys.err)) return <MarketplacePage page="access" state="absent"><OffCard absent /></MarketplacePage>;
  if (needsNodeAdmin(keys.err)) return <MarketplacePage page="access" state="admin"><AdminCard what="admin.access" /></MarketplacePage>;
  if (keys.err && !keys.data) {
    return (
      <MarketplacePage page="access" state="error">
        <div className="ds-card mkt-card"><div data-copy="empty.error">{copy('empty.error')}</div><ErrorCard err={keys.err} onRetry={keys.reload} /></div>
      </MarketplacePage>
    );
  }
  if (!keys.data) return <MarketplacePage page="access" state="loading"><div className="ds-card mkt-card mkt-muted" data-copy="state.loading">{copy('state.loading')}</div></MarketplacePage>;

  const scopeOf = (k: Key) => [
    k.services ? copy('access.scope.models', { n: k.services.length }) : copy('access.models.all'),
    copy('access.scope.rps', { n: k.rps }),
    k.expiresAt ? copy('access.expires', { t: relAt(k.expiresAt) }) : copy('access.expiry.never'),
    k.lastUsedAt ? copy('access.used', { t: relAt(k.lastUsedAt) }) : copy('access.used.never'),
  ].join(' · ');

  return (
    <MarketplacePage page="access" state="ok">
      <div className="ds-card mkt-card">
        <div className="mkt-planhead">
          <button type="button" className="ds-btn" data-testid="mkt-mint-open" data-copy="access.mint" aria-expanded={formOpen} onClick={() => setFormOpen((o) => !o)}>{copy('access.mint')}</button>
        </div>
        {keys.err ? <ErrorCard err={keys.err} onRetry={keys.reload} /> : null}
        {funded.length === 0 && subs.data && <div className="mkt-muted mkt-xs" data-copy="access.nomodels">{copy('access.nomodels')}</div>}

        {formOpen && (
          <div className="ds-card mkt-card mkt-form" data-testid="mkt-mint-form">
            <h2 data-copy="key.mint.title">{copy('key.mint.title')}</h2>
            <label className="mkt-field"><span data-copy="access.label">{copy('access.label')}</span><input className="ds-input mkt-input" data-testid="mkt-mint-label" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <label className="mkt-field"><span data-copy="access.budget">{copy('access.budget')}</span>
              <span><input className="ds-input mkt-input mkt-mono" data-testid="mkt-mint-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />{' '}<span data-copy="composer.budget.trac">{copy('composer.budget.trac')}</span>
                {' '}<span className="mkt-muted mkt-xs" data-copy="catalog.fx.reference.short">{wei && cat.data?.fx.tracUsd != null ? `${usdOf(wei, cat.data.fx.tracUsd)} · ${copy('catalog.fx.reference.short')}` : ''}</span></span></label>
            <label className="mkt-field"><span data-copy="access.expiry">{copy('access.expiry')}</span>
              <select className="ds-input mkt-input" data-testid="mkt-mint-expiry" value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                <option value="never">{copy('access.expiry.never')}</option>
                <option value="7">{copy('access.expiry.days', { n: 7 })}</option>
                <option value="30">{copy('access.expiry.days', { n: 30 })}</option>
                <option value="90">{copy('access.expiry.days', { n: 90 })}</option>
              </select></label>
            <fieldset className="mkt-field" data-testid="mkt-mint-models">
              <legend data-copy="access.models">{copy('access.models')}</legend>
              <label className="mkt-xs"><input type="checkbox" checked={allServices} onChange={(e) => setAllServices(e.target.checked)} data-testid="mkt-mint-all" />{' '}<span data-copy="access.models.all">{copy('access.models.all')}</span></label>
              {!allServices && funded.length === 0 && <span className="mkt-muted mkt-xs" data-copy="access.models.none">{copy('access.models.none')}</span>}
              {!allServices && funded.map((id) => (
                <label key={id} className="mkt-xs"><input type="checkbox" checked={services.includes(id)} data-testid={`mkt-mint-service-${id}`}
                  onChange={(e) => setServices((m) => (e.target.checked ? [...m, id] : m.filter((x) => x !== id)))} />{' '}<span data-copy="_data">{label_(id)}</span></label>
              ))}
            </fieldset>
            <label className="mkt-field"><span data-copy="access.rps">{copy('access.rps')}</span><input className="ds-input mkt-input mkt-mono" data-testid="mkt-mint-rps" inputMode="numeric" value={rps} onChange={(e) => setRps(e.target.value)} /></label>
            {mintErr ? <ErrorCard err={mintErr} onRetry={mint}><span data-copy="access.error.mint" className="mkt-muted mkt-xs">{copy('access.error.mint')}</span></ErrorCard> : null}
            <div className="mkt-fork">
              <button type="button" className="ds-btn ds-primary" data-testid="mkt-mint" data-copy="access.mint.cta" onClick={mint} disabled={!!mintDisabledKey || busy === 'mint'} title={mintDisabledKey ? copy(mintDisabledKey) : undefined}>
                {busy === 'mint' ? copy('state.working') : copy('access.mint.cta')}
              </button>
              {mintDisabledKey && <span className="mkt-muted mkt-xs" data-copy={mintDisabledKey}>{copy(mintDisabledKey)}</span>}
              <button type="button" className="ds-btn" data-copy="ctl.cancel" onClick={() => setFormOpen(false)}>{copy('ctl.cancel')}</button>
            </div>
          </div>
        )}

        {made && <KeyOnce made={made} onDone={() => setMade(null)} />}

        {keys.data.keys.length === 0 && <div className="mkt-muted mkt-xs" data-copy="empty.keys">{copy('empty.keys')}</div>}
        {keys.data.keys.map((k) => {
          const mix = mixByKey[k.keyId] ?? {};
          const total = Object.values(mix).reduce((s, v) => s + v, 0n);
          const top = Object.entries(mix).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))[0];
          const other = top && total > 0n ? Math.round(100 - pctOf(top[1], total)) : 0;
          // The gateway counts what is reserved against the budget as it does what is spent.
          const reserved = reservedOf(k);
          const committed = BigInt(k.spent) + reserved;
          const left = BigInt(k.budget) - committed;
          const spentKey = reserved > 0n ? 'access.spent.reserved' : 'access.spent';
          return (
            <div key={k.keyId} className={`mkt-krow${k.revoked ? ' revoked' : ''}`} data-testid={`mkt-key-${k.keyId}`} data-revoked={k.revoked}>
              <span>
                <strong data-copy="_data">{k.label}</strong>{' '}
                <span className="mkt-mono mkt-muted mkt-xs" data-copy="_data">{k.keyId}…</span>
                <div className="mkt-muted mkt-xs" data-copy={spentKey}>
                  {copy(spentKey, { spent: fmtTrac(k.spent), reserved: fmtTrac(reserved), budget: fmtTrac(k.budget), left: fmtTrac(left > 0n ? left : 0n) })}
                  {top ? ` · ${copy('access.mix.mostly', { top: label_(top[0]) })}${other > 0 ? ` · ${copy('access.mix.other', { pct: other })}` : ''}` : ''}
                </div>
                <div className="mkt-muted mkt-xs" data-copy="access.scopes">{scopeOf(k)}</div>
                {revokeErr?.keyId === k.keyId ? <ErrorCard err={revokeErr.err} onRetry={() => revoke(k.keyId)}><span className="mkt-muted mkt-xs" data-copy="access.error.revoke">{copy('access.error.revoke')}</span></ErrorCard> : null}
              </span>
              <Badge tone="success" data-copy="access.cap">{copy('access.cap', { pct: Math.round(pctOf(committed, k.budget)) })}</Badge>
              {k.revoked
                ? <Badge tone="danger" data-copy="key.revoked">{copy('key.revoked')}</Badge>
                : <button type="button" className="ds-btn ds-danger" data-testid={`mkt-revoke-${k.keyId}`} data-copy="access.revoke.btn" onClick={() => revoke(k.keyId)} disabled={busy === k.keyId}>{busy === k.keyId ? copy('state.working') : copy('access.revoke.btn')}</button>}
            </div>
          );
        })}
        {keys.data.keys.some((k) => reservedOf(k) > 0n) && <p className="mkt-muted mkt-xs" data-testid="mkt-reserved-note" data-copy="access.reserved.note">{copy('access.reserved.note')}</p>}
        <p className="mkt-muted mkt-xs" data-copy="access.revoke">{copy('access.revoke')}</p>
      </div>
    </MarketplacePage>
  );
}
