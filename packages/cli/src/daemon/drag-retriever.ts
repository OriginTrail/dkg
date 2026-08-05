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

import type { EntityRetrievalResult, EntityRetriever } from '@origintrail-official/dkg-agent';
import { validateContextGraphId } from '@origintrail-official/dkg-core';
import type { VectorStore, EmbeddingProvider } from '../vector-store.js';

/** Minimal triple-store surface the indexer needs (the agent's store satisfies it). */
export interface QueryableStore {
  query(sparql: string): Promise<{ type: string; bindings?: Array<Record<string, string>> }>;
}

export class VectorEntityRetriever implements EntityRetriever {
  /** Bounded VM-graph discovery cap — mirrors gatherVerifiedFacts's max cap. */
  private static readonly MAX_VM_GRAPHS = 1000;
  /** Graph IRIs per VALUES clause — keeps individual query strings bounded. */
  private static readonly VALUES_CHUNK = 200;
  readonly model: string;
  private readonly warming = new Set<string>();

  constructor(
    private readonly vectorStore: VectorStore,
    private readonly embedder: EmbeddingProvider,
    private readonly store: QueryableStore,
  ) {
    this.model = embedder.model;
  }

  async retrieve(question: string, cgName: string, limit: number): Promise<EntityRetrievalResult> {
    await this.ensureIndexed(cgName);
    let queryVec: number[];
    try {
      queryVec = await this.embedder.embed(question);
    } catch {
      return { anchors: [], degraded: true }; // embedder unavailable — surface it rather than a silent empty
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
    return {
      anchors: results.map((r) => ({ sourceGraph: r.sourceUri, entityUri: r.entityUri, score: r.similarity })),
      degraded: false,
    };
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
   * Both sides of the gate count the SAME rows: distinct (graph, subject) PAIRS
   * in the VM layer. buildIndex inserts one VM row per pair, so the source count
   * (countIndexableRecords) and the indexed count (vectorStore.count scoped to
   * the 'vm' layer) match exactly. Two subtleties this avoids:
   *   - counting distinct SUBJECTS would undercount once a subject recurs across
   *     VM graphs (shared/schema entities), satisfying the gate while fresh
   *     entities go unembedded;
   *   - counting ALL layers on the indexed side would OVERcount when the same CG
   *     also holds WM/SWM agent-memory vectors under this model, again satisfying
   *     the gate while fresh VM entities go unembedded. Hence the 'vm' scope.
   */
  private async ensureIndexed(cgName: string): Promise<void> {
    // cgName is interpolated into SPARQL below. The retrieve() path is already
    // validated upstream, but warm() is invoked from memory-change events whose
    // contextGraphId can originate from an unauthenticated remote publish — so
    // validate HERE, the single chokepoint every indexing caller passes through,
    // before the id ever reaches a SPARQL string.
    if (!validateContextGraphId(cgName).valid) return;
    const vmPrefix = `did:dkg:context-graph:${cgName}/_verifiable_memory/`;
    const graphs = await this.listVmGraphs(vmPrefix);
    if (graphs.length === 0) return;
    const currentCount = await this.countIndexableRecords(graphs);
    if (currentCount === 0) return;
    const indexedCount = await this.vectorStore.count(cgName, this.model, 'vm');
    if (indexedCount >= currentCount) return; // up to date for this model
    await this.buildIndex(cgName, graphs);
  }

  /**
   * Bounded VM-graph discovery: enumerate graph NAMES once (top-level LIMIT, no
   * ORDER BY), so every downstream scan runs with the graph term BOUND via
   * VALUES — never the all-variable `GRAPH ?g { ?s ?p ?o }` store scan
   * (sparql-scale R2, the #1597 listGraphs-storm shape). A CG with more than
   * MAX_VM_GRAPHS per-KA graphs gets a truncated index; the freshness gate
   * stays consistent because countIndexableRecords runs over the SAME bounded
   * list. Mirrors gatherVerifiedFacts's bounded discovery in dkg-agent-drag.
   */
  private async listVmGraphs(vmPrefix: string): Promise<string[]> {
    const r = await this.store
      .query(
        `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "${vmPrefix}")) } LIMIT ${VectorEntityRetriever.MAX_VM_GRAPHS}`,
      )
      .catch(() => null);
    if (!r || r.type !== 'bindings' || !r.bindings) return [];
    return r.bindings
      .map((b) => strip(b['g']))
      .filter((g): g is string => g.length > 0 && !/[<>"\s]/.test(g));
  }

  /** Distinct (graph, subject) pairs across the discovered VM graphs — matches buildIndex's one-row-per-pair insert granularity. */
  private async countIndexableRecords(graphs: string[]): Promise<number> {
    let total = 0;
    for (const chunk of chunked(graphs, VectorEntityRetriever.VALUES_CHUNK)) {
      const values = chunk.map((g) => `<${g}>`).join(' ');
      // sparql-scan-allow: R2 -- ?g is VALUES-bound to ≤VALUES_CHUNK concrete IRIs from the LIMIT-bounded listVmGraphs discovery (interpolated, so the linter cannot see they are concrete)
      const r = await this.store
        .query(
          `SELECT (COUNT(*) AS ?n) WHERE { SELECT DISTINCT ?g ?s WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s ?p ?o } } }`,
        )
        .catch(() => null);
      const v = r && r.type === 'bindings' && r.bindings?.[0] ? r.bindings[0]['n'] : '0';
      const m = String(v ?? '0').match(/\d+/);
      total += m ? parseInt(m[0], 10) : 0;
    }
    return total;
  }

  private async buildIndex(cgName: string, graphs: string[]): Promise<void> {
    // Incremental: skip entities already embedded under this model so a re-scan
    // only embeds newly-published entities (embedding is the expensive step).
    const existing = await this.vectorStore.listIds(cgName, this.model);
    // Group all triples by (graph, subject) → one embedded record per entity.
    // Chunk-local grouping is safe: an entity's triples all live in ONE per-KA
    // graph, and each graph belongs to exactly one VALUES chunk.
    const byEntity = new Map<string, { g: string; s: string; props: Array<[string, string]> }>();
    for (const chunk of chunked(graphs, VectorEntityRetriever.VALUES_CHUNK)) {
      const values = chunk.map((g) => `<${g}>`).join(' ');
      // sparql-scan-allow: R2 -- ?g is VALUES-bound to ≤VALUES_CHUNK concrete IRIs from the LIMIT-bounded listVmGraphs discovery (interpolated, so the linter cannot see they are concrete)
      const r = await this.store
        .query(`SELECT ?g ?s ?p ?o WHERE { VALUES ?g { ${values} } GRAPH ?g { ?s ?p ?o } }`)
        .catch(() => null);
      if (!r || r.type !== 'bindings' || !r.bindings) continue;
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

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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
