// Neurosymbolic Marketplace — catalog · model page · playground, per the
// CP-R-approved runthrough (mount map: playground is a Marketplace tab).
// Catalog reads the buyer node's server-side merged shelves; chips are the
// buyer's OWN meters; one provider per offering, chosen at plan time.
import React, { useEffect, useMemo, useState } from 'react';
import { copy } from '../nsm/copy.generated.js';
import { authHeaders } from '../http.js';
import type { V5Allowance } from '../nsm/v5-api.js';

interface Offer {
  offeringId: string; modelId: string; provenanceClass: string;
  tokenizerBundleRef: string; weightsDigest: string | null;
  ask: { askMicroPerUnit: number; unit: string; effectiveFromCycle: number } | null;
  queuedAsk: { askMicroPerUnit: number } | null;
}
interface Catalog {
  shelves: Array<{ seller: string; ok: boolean; revenueWallet?: string; offers?: Offer[] }>;
  meters: V5Allowance[];
  plan: { periodId: string; expiresAt: string } | null;
}

const TRAC_USD = 0.28;
const usdPer1M = (micro: number) => `~$${((micro * 1_000_000 * TRAC_USD) / 1_000_000).toFixed(2)}/1M`;

async function req<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<{ status: number; body: T }> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, body: (await res.json()) as T };
}

function pctLeft(m?: V5Allowance): number | null {
  if (!m || m.guaranteedUnits === 0) return null;
  return Math.max(0, Math.round((1 - m.consumedUnits / m.guaranteedUnits) * 100));
}

// ── playground ──────────────────────────────────────────────────────────────

interface Msg { role: 'user' | 'assistant'; content: string; servedBy?: string; units?: number; isQuery?: boolean }

function Playground({ meters }: { meters: V5Allowance[] }): React.ReactElement {
  const models = meters.filter((m) => m.unit === 'tokens');
  const knowledge = meters.filter((m) => m.unit === 'query-units');
  const [model, setModel] = useState<string>(models[0]?.offeringId ?? '');
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [fork, setFork] = useState<{ switch: Array<{ offeringId: string; pctLeft: number }> } | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!input.trim() || busy) return;
    const text = input.trim();
    setInput('');
    setMsgs((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);
    try {
      const isQuery = text.toUpperCase().startsWith('SELECT') || text.toUpperCase().startsWith('ASK');
      if (isQuery && knowledge[0]) {
        const r = await req<{ body?: string; returnedRows?: number; units?: number; servedBy?: string; error?: string; fork?: { switch: Array<{ offeringId: string; pctLeft: number }> } }>(
          '/marketplace/gateway/v1/query', { method: 'POST', body: JSON.stringify({ offeringId: knowledge[0].offeringId, sparql: text }) }, 120_000);
        if (r.status === 402) { setFork({ switch: (r.body.fork as { switch?: Array<{ offeringId: string; pctLeft: number }> } | undefined)?.switch ?? [] }); return; }
        setMsgs((m) => [...m, { role: 'assistant', isQuery: true, units: r.body.units,
          servedBy: r.body.servedBy, content: `${r.body.returnedRows ?? 0} rows` }]);
      } else {
        const r = await req<{ choices?: Array<{ message: { content: string } }>; nsm?: { servedBy: string; units: number }; error?: string; fork?: { switch: Array<{ offeringId: string; pctLeft: number }> } }>(
          '/marketplace/gateway/v1/chat/completions', { method: 'POST',
            body: JSON.stringify({ model, max_tokens: 96, messages: [{ role: 'user', content: text }] }) }, 300_000);
        if (r.status === 402) { setFork({ switch: (r.body.fork as { switch?: Array<{ offeringId: string; pctLeft: number }> } | undefined)?.switch ?? [] }); return; }
        setMsgs((m) => [...m, { role: 'assistant', content: r.body.choices?.[0]?.message.content ?? `(${r.body.error ?? 'error'} — charged 0)`,
          servedBy: r.body.nsm?.servedBy, units: r.body.nsm?.units }]);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="nsm5-card">
      <div className="nsm5-fchips">
        {models.map((m) => (
          <button key={m.offeringId} className={model === m.offeringId ? 'on' : ''}
            data-copy="chip.left" onClick={() => setModel(m.offeringId)}>
            {m.offeringId} · {pctLeft(m) ?? 0}% left
          </button>
        ))}
        {knowledge.map((m) => (
          <button key={m.offeringId} data-copy="chip.left">{m.offeringId} · {pctLeft(m) ?? 0}% left</button>
        ))}
      </div>
      <div className="nsm5-chat">
        {msgs.map((m, i) => (
          <div key={i}>
            <div className={`nsm5-bubble ${m.role}`}>{m.content}</div>
            {m.role === 'assistant' && (
              <div className="nsm5-muted nsm5-xs" data-copy="play.servedby">
                via {m.servedBy?.slice(0, 8)}… · {m.units?.toLocaleString()} {m.isQuery ? 'units' : 'tokens'}
              </div>
            )}
          </div>
        ))}
        {fork && (
          <div className="nsm5-forkinline">
            <strong data-copy="play.fork.inline">{copy('play.fork.inline')}</strong>
            <div className="nsm5-fork">
              <button className="nsm5-btn nsm5-btn--primary" data-copy="fork.topup" onClick={() => setFork(null)}>{copy('fork.topup')}</button>
              <span className="nsm5-sec nsm5-sm">
                {fork.switch.length ? `or switch to ${fork.switch[0].offeringId}, ${fork.switch[0].pctLeft}% left` : ''}
              </span>
            </div>
          </div>
        )}
      </div>
      <div className="nsm5-inputrow">
        <input value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder="Message — or paste SPARQL for a knowledge query" />
        <button className="nsm5-btn nsm5-btn--primary" disabled={busy} onClick={send}>{busy ? '…' : 'Send'}</button>
      </div>
    </div>
  );
}

// ── catalog + model page ────────────────────────────────────────────────────

export function MarketplaceV5View(): React.ReactElement {
  const [tab, setTab] = useState<'models' | 'playground'>('models');
  const [cat, setCat] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => req<Catalog>('/marketplace/subs/catalog')
      .then((r) => { if (live) setCat(r.body); }).catch(() => undefined);
    load();
    const iv = setInterval(load, 8_000);
    return () => { live = false; clearInterval(iv); };
  }, []);

  const byModel = useMemo(() => {
    const out = new Map<string, Array<{ seller: string; offer: Offer }>>();
    for (const sh of cat?.shelves ?? []) {
      for (const o of sh.offers ?? []) {
        const key = o.offeringId;
        if (!out.has(key)) out.set(key, []);
        out.get(key)!.push({ seller: sh.seller, offer: o });
      }
    }
    return out;
  }, [cat]);

  if (!cat) return <div className="nsm5-frame"><div className="nsm5-card nsm5-muted">…</div></div>;

  const meterFor = (offeringId: string) => cat.meters.find((m) => m.offeringId === offeringId);

  if (selected) {
    const rows = byModel.get(selected) ?? [];
    const m = meterFor(selected);
    const chosen = m?.seller;
    return (
      <div className="nsm5-frame">
        <div className="nsm5-card">
          <p className="nsm5-muted nsm5-xs"><a onClick={() => setSelected(null)} style={{ cursor: 'pointer' }}>← Marketplace</a></p>
          <h1 style={{ margin: 0 }}>{rows[0]?.offer.modelId ?? selected}{' '}
            {m && <span className="nsm5-chipleft" data-copy="chip.left">{pctLeft(m)}% left</span>}</h1>
          {rows[0]?.offer.weightsDigest && (
            <p className="nsm5-muted nsm5-xs nsm-mono">weights {rows[0].offer.weightsDigest.slice(0, 22)}…</p>
          )}
          {rows.map(({ seller, offer }) => (
            <div key={seller} className="nsm5-mhead" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 'var(--sp-3)' }}>
              <span><strong>{seller.slice(0, 10)}…</strong>{' '}
                {offer.ask && <span className="nsm-mono nsm5-sec">{usdPer1M(offer.ask.askMicroPerUnit)}</span>}
                {offer.queuedAsk && <span className="nsm5-muted nsm5-xs"> · next cycle: {usdPer1M(offer.queuedAsk.askMicroPerUnit)}</span>}
              </span>
              {chosen?.toLowerCase() === seller.toLowerCase()
                ? <span className="nsm5-yours" data-copy="model.provider.yours">{copy('model.provider.yours')}</span>
                : <span className="nsm5-chipadd" data-copy="model.provider.switch">{copy('model.provider.switch')}</span>}
            </div>
          ))}
          <p className="nsm5-muted nsm5-xs" data-copy="model.provider.note">{copy('model.provider.note')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="nsm5-frame">
      <div className="nsm5-fchips" style={{ paddingLeft: 'var(--sp-1)' }}>
        <button className={tab === 'models' ? 'on' : ''} onClick={() => setTab('models')}>Models</button>
        <button className={tab === 'playground' ? 'on' : ''} onClick={() => setTab('playground')}>Playground</button>
      </div>
      {tab === 'playground' ? <Playground meters={cat.meters} /> : (
        <div className="nsm5-grid">
          {[...byModel.entries()].map(([offeringId, rows]) => {
            const m = meterFor(offeringId);
            const left = pctLeft(m);
            const isQuery = rows[0].offer.ask?.unit === 'query-units';
            return (
              <div key={offeringId} className="nsm5-card nsm5-mcard" onClick={() => setSelected(offeringId)} style={{ cursor: 'pointer' }}>
                <h3 style={{ margin: 0 }}>{rows[0].offer.modelId}</h3>
                <div className="nsm5-mhead">
                  <span className="nsm5-sec nsm5-sm">
                    {isQuery ? 'query' : 'text'} · via {rows.map((r) => r.seller.slice(0, 8) + '…').join(' · ')}
                  </span>
                  <span className="nsm5-sm" style={{ color: 'var(--prov-pinned)' }}>
                    {rows[0].offer.provenanceClass === 'weights-pinned' ? `⛓ ${copy('prov.pinned')}` :
                     isQuery ? copy('catalog.query.plain') : `☁ ${copy('prov.claimed')}`}
                  </span>
                </div>
                <div className="nsm5-mhead">
                  <span className="nsm-mono nsm5-sec">
                    {rows[0].offer.ask ? (isQuery ? `${usdPer1M(rows[0].offer.ask.askMicroPerUnit)} units` : `${usdPer1M(rows[0].offer.ask.askMicroPerUnit)} tokens`) : '—'}
                  </span>
                  {left != null
                    ? <span className="nsm5-chipleft" data-copy="chip.left">{left}% left</span>
                    : <span className="nsm5-chipadd" data-copy="catalog.add">{copy('catalog.add')}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
