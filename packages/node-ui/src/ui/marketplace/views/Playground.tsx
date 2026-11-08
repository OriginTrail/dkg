// The playground: a chat with a service this epoch's subscription funds,
// through the node's gateway. The gateway takes access keys only, so the page
// makes one for itself with `POST /keys` (the node-admin token's) and keeps
// its secret in memory, never in storage; the node's own token never goes to
// the gateway. Under each answer, what it cost and who served it; at the soft
// ceiling, the fork inline: top up, or wait for the next epoch.
import React, { useState } from 'react';
import { copy } from '../copy.generated.js';
import { isMarketplaceError, marketplaceApi, marketplaceGateway, needsNodeAdmin, type ChatRequest } from '../api/client.js';
import type { Budget, CatalogAnswer, Served } from '../api/types.js';
import { fmtCount, fmtTrac, modelName, pctOf } from '../amounts.js';
import { AdminCard, ErrorCard, describeError, relAt, sellerName, useLoad, useMarketplaceNav } from '../shared.js';
import { useMarketplaceDraftStore } from '../draftStore.js';

/** The playground's key: in this page's memory only, and good for an hour. */
let pageKey: { secret: string; keyId: string; expiresAt: number } | null = null;
const KEY_LIFETIME_SECONDS = 3_600;

/** Forget the page's key (tests, and a key the gateway no longer takes). */
export function forgetPlaygroundKey(): void { pageKey = null; }

async function playgroundKey(budget: string): Promise<{ secret: string; keyId: string }> {
  const now = Math.floor(Date.now() / 1000);
  if (pageKey && pageKey.expiresAt - 60 > now) return pageKey;
  const made = await marketplaceApi.makeKey({ label: copy('play.key.label'), budget, services: null, rps: 2, expiresAt: now + KEY_LIFETIME_SECONDS });
  pageKey = { secret: made.secret, keyId: made.keyId, expiresAt: made.expiresAt ?? now + KEY_LIFETIME_SECONDS };
  return pageKey;
}

const KEY_GONE = new Set(['missing_key', 'unknown_key', 'revoked_key', 'expired_key']);

interface Msg { role: 'user' | 'assistant'; content: string; served?: Served; error?: { copyKey: string; code: string } }
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
    try {
      let key = await playgroundKey(current.value);
      setKeyId(key.keyId);
      let answer;
      try {
        answer = await marketplaceGateway.chat(key.secret, request);
      } catch (err) {
        if (!isMarketplaceError(err) || !KEY_GONE.has(err.code)) throw err;
        forgetPlaygroundKey();
        key = await playgroundKey(current.value);
        setKeyId(key.keyId);
        answer = await marketplaceGateway.chat(key.secret, request);
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
      const d = describeError(err);
      setMsgs((m) => [...m, { role: 'assistant', content: '', error: { copyKey: d.copyKey, code: d.code ?? 'Error' } }]);
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
              <div className="mkt-bubble assistant error" role="alert" data-testid="mkt-error-bubble" data-code={m.error.code}>
                <span data-copy="play.error.bubble">{copy('play.error.bubble', { reason: copy(m.error.copyKey) })}</span>
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
