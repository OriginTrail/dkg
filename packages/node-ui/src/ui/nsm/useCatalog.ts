// Catalog data layer (surfaces 02/03) — discovery over the node's OWN
// subscribed graphs (free), grouping by canonical Model KA, prices from
// VERIFIED live quotes via the node's quote proxy (rule 7: the KA apiBase is
// only ever a bootstrap pointer handed to the node — it is never rendered).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authHeaders, getJson } from '../http.js';
import type { CatalogModel, CatalogProvider, QuoteStatus } from './components.js';

const NSM = 'https://w3id.org/neurosymbolic-marketplace/nsm#';

const unq = (v: unknown): string => {
  const s = String(v ?? '');
  const m = s.match(/^"(.*)"(\^\^.*)?$/s);
  return m ? m[1] : s;
};

interface RawOffering {
  modelId: string; provider: string; inTok: number; outTok: number;
  provenanceClass: string; apiBase: string; modelRef: string; graph: string;
}

interface ModelKaMeta {
  urn: string; displayName: string; family: string; modality: string;
  contextLength: number; quantization?: string; provenanceClass?: string;
}

export interface VerifiedQuoteInfo {
  status: QuoteStatus;
  issuedAt?: string;
  transports?: string[];
  directUrl?: string | null;
  offerings?: Array<Record<string, unknown>>;
  providerAddress?: string;
}

export interface CatalogState {
  loading: boolean;
  error: string | null;
  models: Array<CatalogModel & { groupKey: string; quantization?: string; issuedAt?: string }>;
  quoteByProvider: Record<string, VerifiedQuoteInfo>;
  settledByProvider: Record<string, number>;
  repByProvider: Record<string, { verified: number; disputed: number }>;
  refresh: () => void;
}

const KNOWN_FAMILY: Array<{ test: RegExp; family: string }> = [
  { test: /qwen/i, family: 'qwen' },
  { test: /gpt|codex|o[0-9]/i, family: 'openai' },
  { test: /deepseek/i, family: 'deepseek' },
  { test: /llama/i, family: 'meta' },
  { test: /mistral|mixtral/i, family: 'mistral' },
];

function familyOf(modelId: string): string {
  return KNOWN_FAMILY.find((k) => k.test.test(modelId))?.family ?? 'unknown';
}

function prettyName(modelId: string): string {
  return modelId.replace(/[-_]/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase());
}

// One query against one CG with a hard timeout: a huge graph (okf-mainnet's
// FIFA CG scans in minutes) degrades to "contributed nothing this refresh"
// instead of blocking the whole catalog.
async function queryCg(sparql: string, cg: string): Promise<Record<string, string>[]> {
  try {
    const res = await fetch('/api/query', {
      method: 'POST',
      headers: { ...authHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ sparql, contextGraphId: cg, includeSharedMemory: true, includeContextGraphPartitions: true }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return [];
    const r = (await res.json()) as { result?: { bindings?: Record<string, string>[] } };
    return r?.result?.bindings ?? [];
  } catch { return []; }
}

// Small concurrency pool: the node's SPARQL worker is effectively serial, so
// firing subscriptions × queries all at once starves it and every late job
// times out in the queue. Six in flight keeps small graphs flowing while a
// heavy one (FIFA, defender) burns its own slot.
async function pool<T>(jobs: Array<() => Promise<T>>, width = 6): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

/** Two-stage sweep: offerings across ALL subscribed graphs (the v3 lesson —
 *  never hardcode a market CG), then Model-KA + close statements only on the
 *  graphs that actually carry offerings. Browsers allow ~6 sockets per origin
 *  and the shell holds some — a flat subscriptions×queries fan-out starves. */
async function marketSweep(offeringsSparql: string, followSparqls: string[]): Promise<{
  offerings: Array<Record<string, string>>; follow: Record<string, string>[][];
}> {
  const subs = await getJson<{ subscriptions?: { contextGraphId: string; subscribed: boolean }[] }>(
    '/api/context-graph/subscriptions',
  );
  const cgs = (subs?.subscriptions ?? []).filter((x) => x.subscribed).map((x) => x.contextGraphId).slice(0, 24);
  const perCg = await pool(cgs.map((cg) => () =>
    queryCg(offeringsSparql, cg).then((rows) => ({ cg, rows }))), 3);
  const offerings = perCg.flatMap((r) => r.rows);
  const marketCgs = perCg.filter((r) => r.rows.length > 0).map((r) => r.cg);
  const follow = await Promise.all(followSparqls.map(async (sparql) => {
    const rr = await pool(marketCgs.map((cg) => () => queryCg(sparql, cg)), 3);
    return rr.flat();
  }));
  return { offerings, follow };
}

export function useCatalog(): CatalogState {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offerings, setOfferings] = useState<RawOffering[]>([]);
  const [kaMeta, setKaMeta] = useState<Record<string, ModelKaMeta>>({});
  const [settledByProvider, setSettled] = useState<Record<string, number>>({});
  const [repByProvider, setRep] = useState<Record<string, { verified: number; disputed: number }>>({});
  const [quoteByProvider, setQuotes] = useState<Record<string, VerifiedQuoteInfo>>({});
  const quoteFetched = useRef(new Set<string>());

  const refresh = useCallback(() => {
    setLoading(true); setError(null);
    quoteFetched.current.clear();

    const OFFERINGS = `PREFIX nsm: <${NSM}> SELECT ?g ?modelId ?provider ?inTok ?outTok ?pc ?ab ?mr WHERE { GRAPH ?g {
      ?o a nsm:ModelOffering ; nsm:modelId ?modelId ; nsm:providerAddress ?provider ;
         nsm:perInputTokenMicroTrac ?inTok ; nsm:perOutputTokenMicroTrac ?outTok .
      OPTIONAL { ?o nsm:provenanceClass ?pc } OPTIONAL { ?o nsm:apiBase ?ab }
      OPTIONAL { ?o nsm:modelRef ?mr } } } LIMIT 100`;

    const MODELS = `PREFIX nsm: <${NSM}> SELECT ?s ?name ?fam ?mod ?ctx ?q ?pc WHERE { GRAPH ?g {
      ?s a nsm:Model ; nsm:displayName ?name .
      OPTIONAL { ?s nsm:family ?fam } OPTIONAL { ?s nsm:modality ?mod }
      OPTIONAL { ?s nsm:contextLength ?ctx } OPTIONAL { ?s nsm:quantization ?q }
      OPTIONAL { ?s nsm:provenanceClass ?pc } } } LIMIT 100`;

    const CLOSES = `PREFIX nsm: <${NSM}> SELECT ?prov ?cs ?d ?st WHERE { GRAPH ?g {
      ?c a nsm:CloseStatement ; nsm:providerAddress ?prov ; nsm:legsCountersigned ?cs ; nsm:legsDisputed ?d .
      OPTIONAL { ?c nsm:settledTokens ?st } } } LIMIT 400`;

    marketSweep(OFFERINGS, [MODELS, CLOSES])
      .then(({ offerings: offRows, follow: [modelRows, closeRows] }) => {
        const seen = new Set<string>();
        setOfferings(offRows.map((b) => ({
          modelId: unq(b.modelId), provider: unq(b.provider),
          inTok: Number(unq(b.inTok)), outTok: Number(unq(b.outTok)),
          provenanceClass: unq(b.pc) || 'weights-pinned',
          apiBase: unq(b.ab), modelRef: unq(b.mr),
          graph: unq(b.g),
        })).filter((o) => {
          const k = `${o.modelId}|${o.provider.toLowerCase()}`;
          if (seen.has(k)) return false;
          seen.add(k); return true;
        }));

        const meta: Record<string, ModelKaMeta> = {};
        for (const b of modelRows) {
          const urn = unq(b.s);
          meta[urn] = {
            urn, displayName: unq(b.name),
            family: unq(b.fam) || 'unknown', modality: unq(b.mod) || 'text',
            contextLength: Number(unq(b.ctx)) || 0,
            quantization: unq(b.q) || undefined,
            provenanceClass: unq(b.pc) || undefined,
          };
        }
        setKaMeta(meta);

        const settled: Record<string, number> = {};
        const rep: Record<string, { verified: number; disputed: number }> = {};
        for (const b of closeRows) {
          const p = unq(b.prov).toLowerCase();
          settled[p] = (settled[p] ?? 0) + (Number(unq(b.st)) || 0);
          const r = (rep[p] ??= { verified: 0, disputed: 0 });
          r.verified += Number(unq(b.cs)) || 0;
          r.disputed += Number(unq(b.d)) || 0;
        }
        setSettled(settled); setRep(rep);
        setLoading(false);
      })
      .catch((e) => { setError(String((e as Error).message).slice(0, 160)); setLoading(false); });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // one verified quote per provider apiBase (the node fetches + verifies)
  useEffect(() => {
    for (const o of offerings) {
      const key = o.provider.toLowerCase();
      if (!o.apiBase || quoteFetched.current.has(key)) continue;
      quoteFetched.current.add(key);
      setQuotes((q) => ({ ...q, [key]: { status: 'loading' } }));
      getJson<{ verified?: boolean; quote?: Record<string, unknown> | null; error?: string }>(
        `/marketplace/buyer/quote?apiBase=${encodeURIComponent(o.apiBase)}`,
      ).then((r) => {
        if (r.error) { setQuotes((q) => ({ ...q, [key]: { status: 'unreachable' } })); return; }
        if (!r.verified || !r.quote) { setQuotes((q) => ({ ...q, [key]: { status: 'unverifiable' } })); return; }
        const quote = r.quote as { issuedAt?: string; providerAddress?: string; apiBase?: string | null; offerings?: Array<Record<string, unknown>> };
        setQuotes((q) => ({ ...q, [key]: {
          status: 'live', issuedAt: quote.issuedAt,
          providerAddress: quote.providerAddress,
          directUrl: quote.apiBase ?? null,
          transports: (quote.offerings?.[0] as { transports?: string[] } | undefined)?.transports ?? ['direct'],
          offerings: quote.offerings,
        } }));
      }).catch(() => setQuotes((q) => ({ ...q, [key]: { status: 'unreachable' } })));
    }
  }, [offerings]);

  const models = useMemo(() => {
    const groups = new Map<string, CatalogModel & { groupKey: string; quantization?: string; issuedAt?: string }>();
    for (const o of offerings) {
      const key = o.modelRef || `legacy:${o.modelId}`;
      const ka = o.modelRef ? kaMeta[o.modelRef] : undefined;
      const qi = quoteByProvider[o.provider.toLowerCase()];
      // price ONLY from a live verified quote; offerings without one carry
      // their quote status so the UI can render honestly
      const quoteOff = qi?.status === 'live'
        ? qi.offerings?.find((x) => String(x.modelId) === o.modelId)
        : undefined;
      const p: CatalogProvider & { quoteStatus: QuoteStatus } = {
        addr: o.provider,
        inMicro: Number(quoteOff?.perInputTokenMicroTrac ?? NaN),
        outMicro: Number(quoteOff?.perOutputTokenMicroTrac ?? NaN),
        class: o.provenanceClass,
        via: (qi?.transports ?? []).includes('direct') ? 'direct' : 'lane',
        up: qi?.status === 'live',
        ttftMs: null, tokS: null,
        rep: repByProvider[o.provider.toLowerCase()],
        quoteStatus: qi?.status ?? 'loading',
      };
      const g = groups.get(key);
      if (g) {
        g.providers.push(p);
        g.settledTokens += settledByProvider[o.provider.toLowerCase()] ?? 0;
      } else {
        groups.set(key, {
          groupKey: key,
          modelRef: o.modelRef || '',
          displayName: ka?.displayName ?? prettyName(o.modelId),
          family: ka?.family ?? familyOf(o.modelId),
          modality: ka?.modality ?? 'text',
          contextLength: ka?.contextLength ?? 0,
          quantization: ka?.quantization,
          providers: [p],
          settledTokens: settledByProvider[o.provider.toLowerCase()] ?? 0,
          trend: undefined,
          issuedAt: qi?.issuedAt,
        });
      }
    }
    return [...groups.values()];
  }, [offerings, kaMeta, quoteByProvider, settledByProvider, repByProvider]);

  return { loading, error, models, quoteByProvider, settledByProvider, repByProvider, refresh };
}
