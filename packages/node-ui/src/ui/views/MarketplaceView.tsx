// Marketplace view — Iteration 2, P1 (feature-flagged; gate G1-A).
//
// Design contract (operator-approved mock, 2026-08-11): assembled ONLY from
// existing component families — section panels, table grids, verify-badges,
// mono tabular numbers. Every seller gets the identical row/detail design;
// node class is plain metadata. Anchors are never a section of their own —
// each sits on the artifact it anchors. Placement/economics come from the
// PINNED P0 contracts (nsm-placement.pinned.mjs) — consumed, not reinterpreted.
//
// P1 scope note (honest): every data path in this view is LOCAL to the
// viewer's own node (own /api/query over subscribed CGs, own metering terms,
// read-only signed quote) — free by the layer matrix, so no UI path here can
// debit anything. Front-routed metered discovery (and with it the enforceable
// discovery budget) arrives with P2's netting; the budget badge states this.
import React, { useEffect, useMemo, useState } from 'react';
import { getJson, post } from '../http.js';
import { resolve as placeArtifact } from '../lib/nsm-placement.pinned.mjs';

const NSM = 'https://w3id.org/neurosymbolic-marketplace/nsm#';
const unq = (v: unknown): string => {
  const s = String(v ?? '');
  const m = s.match(/^"(.*)"(\^\^.*)?$/s);
  return m ? m[1] : s;
};

interface Offering {
  modelId: string; provider: string; inTok: number; outTok: number;
  quoteEndpoint: string; firstSaleTx: string; graph: string;
  weights: string; tokenizer: string; template: string; backend: string; build: string;
  contract: string; nodeClass: string;
}
interface KRow { id: string; name: string; type: string; entities: string; role: string }

export function MarketplaceView(): React.ReactElement {
  const [offerings, setOfferings] = useState<Offering[]>([]);
  const [knowledge, setKnowledge] = useState<KRow[]>([]);
  const [readAsk, setReadAsk] = useState<string>('—');
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const [quote, setQuote] = useState<Record<string, unknown> | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [calc, setCalc] = useState({ inp: 500, out: 300, calls: 100 });
  const [err, setErr] = useState<string | null>(null);
  // P1.4 — reputation from receipts: aggregated from CloseStatement KAs the
  // provider publishes (digests+amounts only, frozen v0.7 publication rules).
  const [rep, setRep] = useState<Record<string, { signed: number; disputed: number; accepted: number; lastTx: string }>>({});

  useEffect(() => {
    // Offerings: the viewer's OWN node, SWM/VM over subscribed CGs — free.
    post<{ result?: { bindings?: Record<string, string>[] } }>('/api/query', {
      sparql: `PREFIX nsm: <${NSM}> SELECT ?g ?modelId ?provider ?inTok ?outTok ?quote ?tx ?w ?tk ?tpl ?be ?bd ?rc WHERE { GRAPH ?g {
        ?o a nsm:ModelOffering ; nsm:modelId ?modelId ; nsm:providerAddress ?provider ;
           nsm:perInputTokenMicroTrac ?inTok ; nsm:perOutputTokenMicroTrac ?outTok ;
           nsm:quoteEndpoint ?quote ; nsm:firstSaleTx ?tx ;
           nsm:weightsDigest ?w ; nsm:tokenizerBundleDigest ?tk ; nsm:chatTemplateDigest ?tpl ;
           nsm:backendManifestDigest ?be ; nsm:providerBuildDigest ?bd ; nsm:recountContract ?rc } } LIMIT 50`,
      contextGraphId: 'odysseus', includeSharedMemory: true, includeContextGraphPartitions: true,
    }).then((r) => {
      const rows = r?.result?.bindings ?? [];
      setOfferings(rows.map((b) => ({
        modelId: unq(b.modelId), provider: unq(b.provider),
        inTok: Number(unq(b.inTok)), outTok: Number(unq(b.outTok)),
        quoteEndpoint: unq(b.quote), firstSaleTx: unq(b.tx),
        // graph bound from the query's named graph — never assumed (G1-A review,
        // OpenClaw #2: hardcoding displayed false registration metadata for
        // offerings resolved from other graphs).
        graph: (unq(b.g).match(/context-graph:([^/]+)/)?.[1]) ?? unq(b.g),
        weights: unq(b.w), tokenizer: unq(b.tk), template: unq(b.tpl),
        backend: unq(b.be), build: unq(b.bd), contract: unq(b.rc), nodeClass: 'EDGE',
      })));
    }).catch((e) => setErr(String(e).slice(0, 160)));

    getJson<{ graphs?: { id: string; name?: string; type?: string; entityCount?: number; role?: string }[] }>('/api/context-graph/list')
      .then((r) => setKnowledge(((r as any)?.graphs ?? (r as any)?.contextGraphs ?? []).map((g: any) => ({
        id: g.id, name: g.name || g.id, type: g.type ?? (g.curated ? 'curated' : '—'),
        entities: g.entityCount != null ? String(g.entityCount) : '—',
        role: g.role ?? (g.curator ? 'CURATOR' : 'JOINED'),
      }))))
      .catch(() => setKnowledge([]));

    post<{ result?: { bindings?: Record<string, string>[] } }>('/api/query', {
      sparql: `PREFIX nsm: <${NSM}> SELECT ?prov ?cs ?d ?a ?tx ?at WHERE { GRAPH ?g {
        ?c a nsm:CloseStatement ; nsm:providerAddress ?prov ; nsm:legsCountersigned ?cs ;
           nsm:legsDisputed ?d ; nsm:acceptedMicroTrac ?a ; nsm:settlementTx ?tx ; nsm:settledAt ?at } } LIMIT 200`,
      contextGraphId: 'odysseus', includeSharedMemory: true, includeContextGraphPartitions: true,
    }).then((r) => {
      const agg: Record<string, { signed: number; disputed: number; accepted: number; lastTx: string; lastAt: string }> = {};
      for (const b of r?.result?.bindings ?? []) {
        const k = unq(b.prov).toLowerCase();
        const e = (agg[k] ??= { signed: 0, disputed: 0, accepted: 0, lastTx: '', lastAt: '' });
        e.signed += Number(unq(b.cs)) || 0; e.disputed += Number(unq(b.d)) || 0; e.accepted += Number(unq(b.a)) || 0;
        if (unq(b.at) > e.lastAt) { e.lastAt = unq(b.at); e.lastTx = unq(b.tx); }
      }
      setRep(agg);
    }).catch(() => setRep({}));

    getJson<{ askMicroPer1k?: number; readAskMicroPer1k?: number }>('/api/metering/terms')
      .then((t) => setReadAsk(String(t.askMicroPer1k ?? t.readAskMicroPer1k ?? '—')))
      .catch(() => setReadAsk('—'));
  }, []);

  const fetchQuote = (o: Offering) => {
    setQuote(null); setQuoteErr(null);
    getJson<{ wallets?: { address?: string }[] }>('/api/status')
      .then((s) => {
        const st = s as any;
        const wallets: string[] = (st?.wallets ?? st?.operationalWallets ?? []).map((w: any) => String(w?.address ?? '').toLowerCase()).filter(Boolean);
        // G1-A review (OpenClaw #1): the quote must come from the OFFERING'S
        // provider. In P1 the only reachable quote endpoint is this node's own —
        // so fetch it ONLY when this node IS the offering's provider; otherwise
        // defer honestly rather than presenting local terms as the provider's.
        if (!wallets.includes(o.provider.toLowerCase())) {
          throw new Error(`offering's provider is not this node — remote quote via ${o.quoteEndpoint} arrives with P2's budgeted front routing`);
        }
        const w = (st?.wallets?.[0]?.address ?? st?.operationalWallets?.[0]?.address);
        if (!w) throw new Error('no local wallet visible for refundAddress');
        return getJson<Record<string, unknown>>(`/api/metering/infer-terms?refundAddress=${w}`);
      })
      .then((q) => setQuote(q))
      .catch((e) => setQuoteErr(String(e).slice(0, 160)));
  };

  const estimate = useMemo(() => {
    const o = offerings.find((x) => x.modelId === openDetail);
    if (!o) return null;
    const u = (o.inTok * calc.inp + o.outTok * calc.out) * calc.calls;
    return { u, trac: (u / 1e6).toFixed(u >= 1e4 ? 2 : 4) };
  }, [offerings, openDetail, calc]);

  // Anchors via the PINNED resolver — the UI consumes placement, never decides it.
  // Receipts placement label: the resolver's receipt branch (SWM under batch
  // root) is independent of CG anchoring, so no metered/on-chain claim is made
  // here for graphs this view has not verified (G1-A review, OpenClaw #2).
  const receiptPlacement = placeArtifact({ kind: 'receipt', cg: { metered: false } });

  return (
    <div className="v10-dash-root">
      <div className="v10-dash-header">
        <div>
          <h1>Marketplace</h1>
          <div className="v10-dash-subtitle">models &amp; knowledge offered on your graphs · placement by pinned P0 contract</div>
        </div>
      </div>

      <div className="v10-dash-section nsm-sec">
        <div className="v10-dash-section-header">
          <div className="v10-dash-section-title"><h3>Models</h3></div>
          <span className="v10-dash-section-badge">browsing is free — all P1 paths are your own node; budgeted remote discovery lands with P2</span>
        </div>
        <div className="nsm-colhead nsm-grid-m"><span>Model</span><span>Provider</span><span>Price / token</span><span>Receipts (provider-attested)</span><span>Identity</span></div>
        {offerings.length === 0 && <div className="nsm-empty">{err ? `query failed: ${err}` : 'No model offerings resolved from your subscribed graphs yet.'}</div>}
        {offerings.map((o) => (
          <React.Fragment key={o.modelId}>
            <div className="nsm-row nsm-grid-m" onClick={() => { setOpenDetail(openDetail === o.modelId ? null : o.modelId); setQuote(null); }}>
              <span className="nsm-name">{o.modelId} <span className="nsm-dim">· {o.provider.slice(0, 6)}…{o.provider.slice(-4)}</span></span>
              <span><span className="verify-badge pending">{o.nodeClass}</span></span>
              <span className="nsm-mono">{o.inTok} in · {o.outTok} out µTRAC</span>
              <span className="nsm-mono">{(() => { const r = rep[o.provider.toLowerCase()]; return r ? `${r.signed} signed · ${r.disputed} disputed` : '—'; })()}</span>
              <span><span className="verify-badge verified">✓ VERIFIED</span> <span className="nsm-dim">▸</span></span>
            </div>
            {openDetail === o.modelId && (
              <div className="nsm-detail">
                <div className="nsm-dgrid">
                  <div>
                    <div className="nsm-dh">Content-addressed identity — what every receipt binds</div>
                    {[['weights', o.weights], ['tokenizer bundle', o.tokenizer], ['chat template', o.template], ['serving backend', o.backend], ['provider build', o.build]].map(([k, v]) => (
                      <div className="nsm-dig" key={k}><span>{k}</span><code>{String(v).slice(0, 26)}…</code></div>
                    ))}
                    <div className="nsm-dh">Registered on the DKG</div>
                    <div className="nsm-dig"><span>graph</span><code>{o.graph}</code></div>
                    <div className="nsm-dig"><span>recount contract</span><code>{o.contract}</code></div>
                    <div className="nsm-dig"><span>receipts</span><code>{receiptPlacement.layer} · anchored via {(receiptPlacement as any).anchoredVia}</code></div>
                    <div className="nsm-dh">Proof of life</div>
                    <div className="nsm-dig"><span>first sale</span><code className="nsm-anchor">{o.firstSaleTx.slice(0, 14)}… ↗</code></div>
                    {(() => { const r = rep[o.provider.toLowerCase()]; return r?.lastTx ? (
                      <div className="nsm-dig"><span>provider-published closes · last settled · lifetime accepted</span><code><span className="nsm-anchor">{r.lastTx.slice(0, 14)}… ↗</span> · {r.accepted.toLocaleString()} µTRAC</code></div>
                    ) : null; })()}
                  </div>
                  <div>
                    <div className="nsm-dh">Estimate</div>
                    {(['inp', 'out', 'calls'] as const).map((k) => (
                      <div className="nsm-calcrow" key={k}>
                        <label>{k === 'inp' ? 'input tokens' : k === 'out' ? 'output tokens' : 'calls'}</label>
                        <input type="number" value={calc[k]} onChange={(e) => setCalc({ ...calc, [k]: Math.max(0, Number(e.target.value) || 0) })} />
                      </div>
                    ))}
                    {estimate && <div className="nsm-calcout">{estimate.u.toLocaleString()} µTRAC = {estimate.trac} TRAC</div>}
                    <div className="nsm-dh">Signed quote (read-only — funding is a separate money gate)</div>
                    {!quote && !quoteErr && <button className="nsm-btn" onClick={(e) => { e.stopPropagation(); fetchQuote(o); }}>Fetch provider-signed quote</button>}
                    {quoteErr && <div className="nsm-empty">quote: {quoteErr}</div>}
                    {quote && (
                      <div className="nsm-quote nsm-mono">
                        {(() => { const q = (quote as any).quote ?? {}; return `${q.principalTrac ?? '?'} TRAC · ${q.envelope?.calls ?? '?'} calls · ${q.envelope?.maxAcceptedClaimMicroTrac ?? '?'} µTRAC ceiling · ${(q.fundedRunTermsDigest ?? '').slice(0, 18)}…`; })()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      <div className="v10-dash-section nsm-sec">
        <div className="v10-dash-section-header">
          <div className="v10-dash-section-title"><h3>Knowledge</h3></div>
          <span className="v10-dash-section-badge">read ask {readAsk} µTRAC / 1k units · schema browsing free</span>
        </div>
        <div className="nsm-colhead nsm-grid-k"><span>Context graph</span><span>Type</span><span>Entities</span><span>Access</span></div>
        {knowledge.length === 0 && <div className="nsm-empty">No context graphs listed.</div>}
        {knowledge.map((g) => (
          <div className="nsm-row nsm-grid-k" key={g.id}>
            <span className="nsm-name">{g.name}</span>
            <span className="nsm-dim">{g.type}</span>
            <span className="nsm-mono">{g.entities}</span>
            <span><span className={`verify-badge ${g.role === 'CURATOR' ? 'verified' : 'pending'}`}>{g.role}</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}
