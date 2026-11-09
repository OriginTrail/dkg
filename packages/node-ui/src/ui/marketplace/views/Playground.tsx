// The playground: a chat with a service this epoch's subscription funds,
// through the node's gateway. The gateway takes access keys only, so on the
// first send the page makes one for itself with `POST /keys` (the node-admin
// token's) and keeps its secret in memory, never in storage; the node's own
// token never goes to the gateway, and one playground key per browser is live. Under each answer, what it cost and who served it; at the soft
// ceiling, the fork inline: top up, or wait for the next epoch.
import React, { useState } from 'react';
import { copy, type CopyKey } from '../copy.generated.js';
import { isMarketplaceError, marketplaceApi, marketplaceGateway, needsNodeAdmin, type ChatRequest } from '../api/client.js';
import type { Budget, CatalogAnswer, Served } from '../api/types.js';
import { fmtCount, fmtTrac, modelName, pctOf } from '../amounts.js';
import { AdminCard, ErrorCard, describeError, relAt, sellerName, useLoad, useMarketplaceNav } from '../shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';

/** The playground's key: in this page's memory only, and good for an hour. */
let pageKey: { secret: string; keyId: string; expiresAt: number } | null = null;
const KEY_LIFETIME_SECONDS = 3_600;

/**
 * The keyId of the last playground key this browser made, never its secret:
 * the next key revokes it, so at most one playground key per browser is live.
 */
export const PLAYGROUND_KEY_STORAGE = 'dkg-marketplace-playground-key';
const KEY_ID_RE = /^dkgmk_[0-9a-f]{8}$/;

function lastKeyId(): string | null {
  try {
    const v = localStorage.getItem(PLAYGROUND_KEY_STORAGE);
    return v && KEY_ID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function rememberKeyId(keyId: string): void {
  try { localStorage.setItem(PLAYGROUND_KEY_STORAGE, keyId); } catch { /* storage unavailable: the key still expires within the hour */ }
}

/** Forget the page's key (tests, and a key the gateway no longer takes). */
export function forgetPlaygroundKey(): void { pageKey = null; }

/**
 * The page's key, made on the first send. The key made before it, by this
 * page or an earlier one in this browser, is revoked first; a revoke that
 * fails (that key expired, or was revoked elsewhere) does not stop the new one.
 */
async function playgroundKey(budget: string): Promise<{ secret: string; keyId: string }> {
  const now = Math.floor(Date.now() / 1000);
  if (pageKey && pageKey.expiresAt - 60 > now) return pageKey;
  const previous = pageKey?.keyId ?? lastKeyId();
  pageKey = null;
  if (previous) await marketplaceApi.revokeKey(previous).catch(() => undefined);
  const made = await marketplaceApi.makeKey({ label: copy('play.key.label'), budget, services: null, rps: 2, expiresAt: now + KEY_LIFETIME_SECONDS });
  pageKey = { secret: made.secret, keyId: made.keyId, expiresAt: made.expiresAt ?? now + KEY_LIFETIME_SECONDS };
  rememberKeyId(made.keyId);
  return pageKey;
}

const KEY_GONE = new Set(['missing_key', 'unknown_key', 'revoked_key', 'expired_key']);

/**
 * The gateway's refusals given before it calls a seller: the caller's key,
 * rate and services, the request, the epoch, the subscription and its budget,
 * a seller to route to, the session key and the key's budget. Nothing was
 * charged for these. Any other failure of a call that went out (no answer, an
 * answer that cannot be read, a seller that did not answer or refused, a
 * receipt that failed its check, a failure the node does not explain) leaves
 * open whether the call was served and charged.
 */
const REFUSED_BEFORE_CALL = new Set([
  ...KEY_GONE, 'key_rate', 'bad_request', 'service_not_allowed', 'epoch_ending', 'no_subscription', 'no_seller',
  'soft_ceiling', 'session_key_missing', 'request_too_large', 'key_budget', 'MarketplaceOff',
]);

/** A failed send: in plain words, its code, and whether it may have been charged. */
interface SendError { copyKey: CopyKey; code: string; outcome: 'uncharged' | 'unknown' }

interface Msg { role: 'user' | 'assistant'; content: string; served?: Served; error?: SendError }
type Fork = { kind: 'ceiling'; serviceId: string; nextEpochAt: number | null } | { kind: 'fund'; serviceId: string } | { kind: 'ending'; seconds: number | null };

/** What a budget has for calls: its value left, less what the node holds. */
const freeOf = (b: Budget): bigint => { const f = BigInt(b.left) - BigInt(b.held); return f > 0n ? f : 0n; };

export function Playground({ catalog }: { catalog: CatalogAnswer }): React.ReactElement {
  const subs = useLoad(() => marketplaceApi.subscriptions(catalog.epoch));
  const current = subs.data?.subscriptions.find((s) => s.epoch === catalog.epoch) ?? null;
  const budgets = current?.budgets ?? [];
  const [serviceId, setServiceId] = useState<string>('');
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [fork, setFork] = useState<Fork | null>(null);
  const [busy, setBusy] = useState(false);
  const [keyErr, setKeyErr] = useState<unknown>(null);
  const [keyId, setKeyId] = useState<string | null>(pageKey?.keyId ?? null);
  const [left, setLeft] = useState<Record<string, string>>({});
  const askPlans = useMarketplaceDraftStore((s) => s.askPlans);
  const go = useMarketplaceNav();
  const label = (id: string) => modelName(catalog.services.find((s) => s.serviceId === id)?.label ?? id);

  const selected = budgets.find((b) => b.serviceId === serviceId) ?? budgets.find((b) => freeOf(b) > 0n) ?? budgets[0];
  const pctLeftOf = (b: Budget) => Math.round(pctOf(left[b.serviceId] ?? freeOf(b), b.value));
  const sendDisabledKey = !selected ? 'play.nosub' : !input.trim() ? 'play.empty.input' : null;

  const send = async () => {
    if (sendDisabledKey || busy || !selected || !current) return;
    const content = input.trim();
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }));
    const request: ChatRequest = { model: selected.serviceId, messages: [...history, { role: 'user', content }] };
    setBusy(true); setFork(null); setKeyErr(null);
    setMsgs((m) => [...m, { role: 'user', content }]);
    setInput('');
    // Whether a call has gone to the gateway whose outcome a failure would leave open: until one has, nothing can be charged.
    let called = false;
    const chat = (secret: string) => { called = true; return marketplaceGateway.chat(secret, request); };
    try {
      let key = await playgroundKey(current.value);
      setKeyId(key.keyId);
      let answer;
      try {
        answer = await chat(key.secret);
      } catch (err) {
        if (!isMarketplaceError(err) || !KEY_GONE.has(err.code)) throw err;
        // The gateway refused that key before calling anyone: only the next key's call can be charged.
        called = false;
        forgetPlaygroundKey();
        key = await playgroundKey(current.value);
        setKeyId(key.keyId);
        answer = await chat(key.secret);
      }
      const served = answer.marketplace;
      setLeft((l) => ({ ...l, [served.serviceId]: served.budgetLeft }));
      setMsgs((m) => [...m, { role: 'assistant', content: answer.choices[0]?.message.content ?? '', served }]);
    } catch (err) {
      if (needsNodeAdmin(err)) { setKeyErr(err); setMsgs((m) => m.slice(0, -1)); setInput(content); return; }
      if (isMarketplaceError(err) && err.code === 'soft_ceiling') {
        setFork({ kind: 'ceiling', serviceId: selected.serviceId, nextEpochAt: err.extra.fork?.nextEpochAt ?? err.extra.nextEpochAt ?? null });
        if (err.extra.left !== undefined) setLeft((l) => ({ ...l, [selected.serviceId]: err.extra.left! }));
      } else if (isMarketplaceError(err) && err.code === 'no_subscription') {
        setFork({ kind: 'fund', serviceId: selected.serviceId });
      } else if (isMarketplaceError(err) && err.code === 'epoch_ending') {
        setFork({ kind: 'ending', seconds: err.retryAfter });
      }
      // The fork says what happened for these three; anything else is an error bubble.
      if (isMarketplaceError(err) && ['soft_ceiling', 'no_subscription', 'epoch_ending'].includes(err.code)) return;
      const d = describeError(err);
      const uncharged = !called || (isMarketplaceError(err) && REFUSED_BEFORE_CALL.has(err.code));
      setMsgs((m) => [...m, { role: 'assistant', content: '', error: { copyKey: d.copyKey, code: d.code ?? 'Error', outcome: uncharged ? 'uncharged' : 'unknown' } }]);
    } finally {
      setBusy(false);
    }
  };

  const fund = () => { askPlans({ kind: 'compose' }); go('plans'); };
  const topUp = (id: string) => { askPlans({ kind: 'top-up', serviceId: id }); go('plans'); };

  if (subs.err && !subs.data) return <div className="mkt-card" data-testid="mkt-playground" data-state="error"><ErrorCard err={subs.err} onRetry={subs.reload} /></div>;
  if (!subs.data) return <div className="mkt-card mkt-muted" data-testid="mkt-playground" data-state="loading" data-copy="state.loading">{copy('state.loading')}</div>;
  if (!current || budgets.length === 0) {
    return (
      <div className="mkt-card" data-testid="mkt-playground" data-state="no-plan">
        <div data-copy="play.nosub">{copy('play.nosub')}</div>
        <div className="mkt-fork">
          <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-play-fund" data-copy="play.fund.cta" onClick={fund}>{copy('play.fund.cta')}</button>
        </div>
      </div>
    );
  }
  if (keyErr) return <div data-testid="mkt-playground" data-state="admin"><AdminCard what="admin.playground" /></div>;

  const others = budgets.filter((b) => b.serviceId !== selected?.serviceId && freeOf(b) > 0n);
  const switchChips = others.length > 0 ? (
    <>
      <span className="mkt-sec mkt-sm" data-copy="play.fork.switch">{copy('play.fork.switch')}</span>
      {others.map((b) => (
        <button type="button" key={b.serviceId} className="mkt-chipbtn" data-testid={`mkt-fork-switch-${b.serviceId}`} data-copy="play.remaining"
          onClick={() => { setServiceId(b.serviceId); setFork(null); }}>{copy('play.remaining', { model: label(b.serviceId), pct: pctLeftOf(b) })}</button>
      ))}
    </>
  ) : null;

  return (
    <div className="mkt-card" data-testid="mkt-playground" data-mode="chat">
      <div className="mkt-mhead">
        <span className="mkt-sec mkt-sm" data-copy="play.epoch">{copy('play.epoch', { n: current.epoch, t: relAt(current.endsAt) })}</span>
        <span className="mkt-muted mkt-xs" data-copy="play.service">{copy('play.service')}</span>
      </div>
      <div className="mkt-fchips mkt-wrap" role="radiogroup" aria-label={copy('play.service')} data-testid="mkt-offering-chips">
        {budgets.map((b) => {
          const on = selected?.serviceId === b.serviceId;
          return (
            <button type="button" key={b.serviceId} role="radio" aria-checked={on} className={on ? 'on' : ''} data-copy="play.remaining" data-testid={`mkt-chip-${b.serviceId}`}
              onClick={() => { setServiceId(b.serviceId); setFork(null); }}>
              {copy('play.remaining', { model: label(b.serviceId), pct: pctLeftOf(b) })}
            </button>
          );
        })}
      </div>
      <div className="mkt-chat">
        {msgs.length === 0 && <div className="mkt-muted mkt-xs" data-copy="play.empty.chat">{copy('play.empty.chat')}</div>}
        {msgs.map((m, i) => (
          <div key={i}>
            {m.error ? (
              <div className="mkt-bubble assistant error" role="alert" data-testid="mkt-error-bubble" data-code={m.error.code} data-outcome={m.error.outcome}>
                {m.error.outcome === 'uncharged'
                  ? <span data-copy="play.error.bubble">{copy('play.error.bubble', { reason: copy(m.error.copyKey) })}</span>
                  : <span data-copy="play.error.unknown">{copy('play.error.unknown', { reason: copy(m.error.copyKey) })}</span>}
              </div>
            ) : (
              <>
                <div className={`mkt-bubble ${m.role}`} data-copy="_data">{m.content}</div>
                {m.served && (
                  <div className="mkt-muted mkt-xs" data-copy="play.servedby" data-testid="mkt-served">
                    {copy('play.servedby', { seller: sellerName(m.served.seller), units: fmtCount(m.served.units), trac: fmtTrac(m.served.value), left: fmtTrac(m.served.budgetLeft) })}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {fork?.kind === 'ceiling' && (
          <div className="mkt-forkinline" data-testid="mkt-fork-ceiling">
            <strong data-copy="play.fork.ceiling">{copy('play.fork.ceiling')}</strong>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-fork-topup" data-copy="fork.topup" onClick={() => topUp(fork.serviceId)}>{copy('fork.topup')}</button>
              {fork.nextEpochAt != null && <span className="mkt-sec mkt-sm" data-copy="play.fork.wait">{copy('play.fork.wait', { t: relAt(fork.nextEpochAt) })}</span>}
              {switchChips}
            </div>
          </div>
        )}
        {fork?.kind === 'fund' && (
          <div className="mkt-forkinline" data-testid="mkt-fork-fund">
            <strong data-copy="play.fork.fund">{copy('play.fork.fund')}</strong>
            <div className="mkt-fork">
              <button type="button" className="mkt-btn mkt-btn--primary" data-copy="play.fund.cta" onClick={fund}>{copy('play.fund.cta')}</button>
              {switchChips}
            </div>
          </div>
        )}
        {fork?.kind === 'ending' && (
          <div className="mkt-forkinline" data-testid="mkt-fork-ending">
            <strong data-copy="play.fork.ending">{copy('play.fork.ending', { n: fork.seconds ?? '—' })}</strong>
          </div>
        )}
      </div>
      <div className="mkt-inputrow">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void send(); }} data-testid="mkt-play-input"
          aria-label={copy('play.composer')} placeholder={copy('play.composer')} />
        <button type="button" className="mkt-btn mkt-btn--primary" data-testid="mkt-play-send" data-copy="ctl.send" disabled={busy || !!sendDisabledKey}
          title={sendDisabledKey ? copy(sendDisabledKey) : undefined} onClick={() => { void send(); }}>
          {busy ? copy('state.working') : copy('ctl.send')}
        </button>
      </div>
      <span className="mkt-muted mkt-xs" data-testid="mkt-play-key" data-copy={keyId ? 'play.key.note' : 'play.key.first'}>
        {keyId ? copy('play.key.note', { key: keyId }) : copy('play.key.first')}
      </span>
    </div>
  );
}
