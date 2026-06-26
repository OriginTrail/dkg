// daemon/drag-retriever.ts
//
// Vector-store-backed semantic entry-point retriever for dRAG (OT-RFC-55 Phase 1).
// Lives in the daemon because it owns the embedder + the SQLite vector store; the
// agent holds it behind the dependency-free `EntityRetriever` interface.
//
// retrieve(question) = ensure the CG's verifiable-memory entities are indexed
// (lazy, build-then-search, refreshed when new entities appear), embed the
// question, and ANN-search for the top anchors. The agent then graph-expands +
// builds verifiable citations.

import type { EntityRetriever, RetrievedAnchor } from '@origintrail-official/dkg-agent';
import type { VectorStore, EmbeddingProvider } from '../vector-store.js';

/** Minimal triple-store surface the indexer needs (the agent's store satisfies it). */
export interface QueryableStore {
  query(sparql: string): Promise<{ type: string; bindings?: Array<Record<string, string>> }>;
}

export class VectorEntityRetriever implements EntityRetriever {
  readonly model: string;
  /** Set true when the embedder could not run (e.g. local model not installed) — lets the answer distinguish "no model" from "no matches". */
  degraded = false;
  private readonly warming = new Set<string>();

  constructor(
    private readonly vectorStore: VectorStore,
    private readonly embedder: EmbeddingProvider,
    private readonly store: QueryableStore,
  ) {
    this.model = embedder.model;
  }

  async retrieve(question: string, cgName: string, limit: number): Promise<RetrievedAnchor[]> {
    this.degraded = false;
    await this.ensureIndexed(cgName);
    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(question);
    } catch {
      this.degraded = true; // embedder unavailable — surface it rather than a silent empty
      return [];
    }
    const results = await this.vectorStore.search(queryVec, {
      contextGraphId: cgName,
      memoryLayers: ['vm'],
      model: this.model, // score only this embedding space, never another model's vectors
      limit,
      // Conservative absolute floor only (drop near-orthogonal noise). NOT a
      // tuned precision cutoff — top-K + the consumer's reasoning handle ranking;
      // see the dRAG guide's "retrieval precision is a known limitation" note.
      minSimilarity: 0.05,
    });
    return results.map((r) => ({ sourceGraph: r.sourceUri, entityUri: r.entityUri, score: r.similarity }));
  }

  /**
   * Fire-and-forget index warm-up — e.g. right after a publish, so the first
   * query against fresh facts is not the one that pays for embedding. Never
   * throws; indexing is incremental so this is cheap when nothing is new.
   */
  async warm(cgName: string): Promise<void> {
    if (this.warming.has(cgName)) return; // coalesce concurrent warms (write bursts)
    this.warming.add(cgName);
    try {
      await this.ensureIndexed(cgName);
    } catch {
      /* best effort */
    } finally {
      this.warming.delete(cgName);
    }
  }

  /**
   * Synchronously (build-then-search) ensure this CG's VM entities are indexed
   * under the current embedding model. Re-scans when new entities have appeared
   * since the last index and only embeds the delta (incremental — see buildIndex).
   * Inserts are idempotent (deterministic ids), so re-indexing is safe.
   *
   * The freshness check counts distinct (graph, subject) PAIRS — the SAME
   * granularity buildIndex inserts at and vectorStore.count() reports — because
   * one entity URI is legitimately a subject across multiple VM graphs (shared
   * / schema entities recur across KAs). Counting distinct SUBJECTS instead would
   * undercount once any subject recurs, leaving the gate satisfied and silently
   * skipping the embedding of freshly-published entities.
   */
  private async ensureIndexed(cgName: string): Promise<void> {
    const vmPrefix = `did:dkg:context-graph:${cgName}/_verifiable_memory/`;
    const currentCount = await this.countIndexableRecords(vmPrefix);
    if (currentCount === 0) return;
    const indexedCount = await this.vectorStore.count(cgName, this.model);
    if (indexedCount >= currentCount) return; // up to date for this model
    await this.buildIndex(cgName, vmPrefix);
  }

  /** Distinct (graph, subject) pairs under the VM prefix — matches buildIndex's one-row-per-pair insert granularity. */
  private async countIndexableRecords(vmPrefix: string): Promise<number> {
    const r = await this.store
      .query(
        `SELECT (COUNT(*) AS ?n) WHERE { SELECT DISTINCT ?g ?s WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${vmPrefix}")) } }`,
      )
      .catch(() => null);
    const v = r && r.type === 'bindings' && r.bindings?.[0] ? r.bindings[0]['n'] : '0';
    const m = String(v ?? '0').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  private async buildIndex(cgName: string, vmPrefix: string): Promise<void> {
    // Incremental: skip entities already embedded under this model so a re-scan
    // only embeds newly-published entities (embedding is the expensive step).
    const existing = await this.vectorStore.listIds(cgName, this.model);
    const r = await this.store
      .query(`SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${vmPrefix}")) }`)
      .catch(() => null);
    if (!r || r.type !== 'bindings' || !r.bindings) return;

    // Group all triples by (graph, subject) → one embedded record per entity.
    const byEntity = new Map<string, { g: string; s: string; props: Array<[string, string]> }>();
    for (const b of r.bindings) {
      const g = strip(b['g']);
      const s = strip(b['s']);
      if (!g || !s) continue;
      const key = `${g}|${s}`;
      let e = byEntity.get(key);
      if (!e) {
        e = { g, s, props: [] };
        byEntity.set(key, e);
      }
      e.props.push([strip(b['p']), b['o'] ?? '']);
    }

    for (const { g, s, props } of byEntity.values()) {
      const id = `${this.model}:${g}:${s}`;
      if (existing.has(id)) continue; // already embedded — incremental skip
      const text = renderEntityText(s, props);
      let embedding: number[];
      try {
        embedding = await this.embedder.embed(text);
      } catch {
        continue; // embedder unavailable (e.g. local model not installed) — skip
      }
      await this.vectorStore.insert({
        id,
        embedding,
        sourceUri: g,
        entityUri: s,
        contextGraphId: cgName,
        memoryLayer: 'vm',
        model: this.model,
        label: localName(s),
        snippet: text.length > 400 ? text.slice(0, 400) : text,
      });
    }
  }
}

function strip(v: string | undefined): string {
  return (v ?? '').replace(/^<|>$/g, '');
}

function localName(uri: string): string {
  const m = uri.match(/[/#:]([^/#:]+)$/);
  return m ? m[1] : uri;
}

/** Literal value (unquoted) or the IRI local name — the human-meaningful text. */
function litValue(o: string): string {
  const m = o.match(/^"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1].replace(/\\"/g, '"');
  return localName(o.replace(/^<|>$/g, ''));
}

/** Render an entity as a short text signature for embedding (label + its properties). */
function renderEntityText(subject: string, props: Array<[string, string]>): string {
  const parts = [localName(subject)];
  for (const [p, o] of props) parts.push(`${localName(p)}: ${litValue(o)}`);
  return parts.join('. ');
}
