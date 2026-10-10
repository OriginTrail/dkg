import { EntityGraphReader, documentKey, indexKey, parseSpec, PAGE_SIZE } from './documents.js';
import { EntityIndexStore, type IndexState } from './store.js';
import { EntitySearchError, checkDeadline, unitVector, type EntityEmbedder, type EntityIndexSpec } from './types.js';

/** Lifecycle-owned service. Index pages are explicit operator work; reads never start a rebuild. */
export class EntitySearchService {
  private busy = new Set<string>();
  private searches = 0;
  constructor(readonly store: EntityIndexStore, readonly embedder: EntityEmbedder) {}
  async index(rawSpec: unknown, reader: EntityGraphReader, restart: boolean, signal: AbortSignal, deadline: number) {
    const spec = parseSpec(rawSpec as EntityIndexSpec), id = indexKey(spec, this.embedder.fingerprint);
    if (this.busy.size) throw new EntitySearchError('ENTITY_INDEX_BUSY', 429);
    this.busy.add(id);
    try {
      await reader.authorize(spec, signal, deadline);
      let state = this.store.state(id);
      if (!state && this.store.indexCount() >= 32) throw new EntitySearchError('ENTITY_INDEX_CAPACITY', 422);
      if (!state || restart) {
        state = { id, spec, fingerprint: this.embedder.fingerprint, generation: (state?.generation ?? 0) + 1,
          cursor: null, scanComplete: false, completedAt: null };
        this.store.save(state);
      }
      if (state.scanComplete) return this.status(state);
      const page = await reader.page(spec, state.cursor, signal, deadline);
      for (const entity of page) {
        const doc = await reader.document(spec, entity, signal, deadline);
        if (!doc) continue;
        const cached = this.store.cached(id, documentKey(doc));
        const vector = cached?.document.contentHash === doc.contentHash ? cached.vector : await this.embedder.embed(doc.text, 'document', signal);
        const normalized = unitVector(vector, this.embedder.dimensions);
        checkDeadline(signal, deadline);
        this.store.upsert(state, doc, normalized);
      }
      checkDeadline(signal, deadline);
      if (page.length) state.cursor = documentKey(page[page.length - 1]);
      if (page.length < PAGE_SIZE) {
        state.scanComplete = true; state.completedAt = new Date().toISOString();
        this.store.finish(state);
      } else this.store.save(state);
      return this.status(state);
    } finally { this.busy.delete(id); }
  }
  private status(state: IndexState) {
    return { indexId: state.id, contextGraphId: state.spec.contextGraphId, view: state.spec.view,
      modelFingerprint: state.fingerprint, indexedEntities: this.store.count(state.id), scanComplete: state.scanComplete,
      completedAt: state.completedAt, coverage: 'local-indexed-subset' as const, graphComplete: null };
  }
  async search(id: string, contextGraphId: string, query: string, limit: number, reader: EntityGraphReader,
    signal: AbortSignal, deadline: number) {
    if (!/^[a-f0-9]{64}$/.test(id) || typeof query !== 'string' || !query.trim() || query.length > 6000
      || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new EntitySearchError('ENTITY_INVALID_REQUEST', 400);
    if (this.searches >= 2) throw new EntitySearchError('ENTITY_SEARCH_BUSY', 429);
    this.searches++;
    try {
      const state = this.store.state(id);
      if (!state || state.spec.contextGraphId !== contextGraphId) throw new EntitySearchError('ENTITY_INDEX_NOT_FOUND', 404);
      await reader.authorize(state.spec, signal, deadline);
      if (state.fingerprint !== this.embedder.fingerprint) throw new EntitySearchError('ENTITY_EMBEDDING_MODEL_CHANGED');
      const vector = unitVector(await this.embedder.embed(query, 'query', signal), this.embedder.dimensions);
      const candidates = this.store.rank(id, vector, Math.min(80, limit * 4), signal, deadline);
      const entities = [];
      let staleCandidates = 0;
      for (const candidate of candidates) {
        const current = await reader.document(state.spec, candidate.document, signal, deadline);
        if (!current || current.contentHash !== candidate.document.contentHash) { staleCandidates++; continue; }
        entities.push({ ...current, score: candidate.score });
        if (entities.length === limit) break;
      }
      checkDeadline(signal, deadline);
      return { ...this.status(state), entities, staleCandidates, observedAt: new Date().toISOString(),
        // Content is re-read under current authorization. New entities require a rescan.
        freshness: 'candidates-revalidated', exhaustive: false };
    } finally { this.searches--; }
  }
  close(): void { this.store.close(); }
}
