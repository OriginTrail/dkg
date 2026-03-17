import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  type EventBus,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import {
  OpenAIEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderConfig,
} from './embedding-provider.js';
import { VectorJobQueue } from './job-queue.js';
import { SqliteVecStore } from './sqlite-vec-store.js';
import { StreamingScanStore } from './streaming-scan-store.js';
import { buildLabelMap, tripleToText } from './triple-text.js';
import type { VectorSearchResult, VectorStore } from './vector-store.js';

const DEFAULT_MIN_TEXT_LENGTH = 5;
const DEFAULT_WORKER_INTERVAL_MS = 100;
const SEARCH_CANDIDATE_MULTIPLIER = 4;
const MAX_SEARCH_CANDIDATES = 100;
const REINDEX_BATCH_SIZE = 1000;
const TRIPLES_STORED_EVENT = 'triples:stored';
const TRIPLES_REMOVED_EVENT = 'triples:removed';

interface TriplesStoredEvent {
  quads: Quad[];
  paranetId: string;
  graph: string;
  rootEntities: string[];
}

interface TriplesRemovedEvent {
  rootEntities: string[];
  paranetId: string;
  graph: string;
}

export interface VectorSidecarConfig {
  embedding: EmbeddingProviderConfig;
  dataDir: string;
  minTextLength?: number;
  indexWorkspace?: boolean;
  retryMaxAttempts?: number;
  retryIntervalMs?: number;
  workerIntervalMs?: number;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
}

export interface SemanticSearchResult {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
  paranetId: string;
  score: number;
  text: string;
}

export interface VectorStats {
  healthy: boolean;
  indexed: number;
  queue: { pending: number; processing: number; failed: number };
  modelName: string;
  dimensions: number;
}

export class VectorIndexUnhealthyError extends Error {
  constructor(message = 'vector index unhealthy') {
    super(message);
    this.name = 'VectorIndexUnhealthyError';
  }
}

export class VectorSidecar {
  private readonly minTextLength: number;
  private readonly indexWorkspace: boolean;
  private readonly workerIntervalMs: number;
  private readonly providedEmbeddingProvider?: EmbeddingProvider;
  private readonly providedVectorStore?: VectorStore;

  private queueDb: Database | null = null;
  private embeddingProvider!: EmbeddingProvider;
  private vectorStore!: VectorStore;
  private jobQueue!: VectorJobQueue;
  private started = false;
  private healthy = true;
  private onStored?: (data: unknown) => void;
  private onRemoved?: (data: unknown) => void;

  constructor(
    private readonly store: TripleStore,
    private readonly eventBus: EventBus,
    private readonly config: VectorSidecarConfig,
  ) {
    this.minTextLength = config.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH;
    this.indexWorkspace = config.indexWorkspace ?? true;
    this.workerIntervalMs = config.workerIntervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
    this.providedEmbeddingProvider = config.embeddingProvider;
    this.providedVectorStore = config.vectorStore;
  }

  async start(): Promise<void> {
    if (this.started) return;

    mkdirSync(this.config.dataDir, { recursive: true });
    this.queueDb = new Database(join(this.config.dataDir, 'vector-queue.sqlite'));
    this.queueDb.pragma('journal_mode = WAL');
    this.queueDb.pragma('synchronous = NORMAL');
    this.queueDb.exec(`
      CREATE TABLE IF NOT EXISTS vector_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    this.embeddingProvider = this.providedEmbeddingProvider ?? new OpenAIEmbeddingProvider(this.config.embedding);
    this.vectorStore = this.providedVectorStore ?? createVectorStore({
      dataDir: this.config.dataDir,
      dimensions: this.embeddingProvider.dimensions(),
    });
    this.jobQueue = new VectorJobQueue(
      this.queueDb,
      this.embeddingProvider,
      this.vectorStore,
      this.store,
      {
        minTextLength: this.minTextLength,
        retryMaxAttempts: this.config.retryMaxAttempts,
        retryIntervalMs: this.config.retryIntervalMs,
        indexWorkspace: this.indexWorkspace,
      },
    );

    await this.recordModelInfo();

    this.onStored = (data: unknown) => {
      const event = data as TriplesStoredEvent;
      try {
        if (!this.indexWorkspace && isWorkspaceGraph(event.graph)) return;
        this.jobQueue.enqueueStore(event.quads, event.paranetId, event.graph);
      } catch (error) {
        this.markUnhealthy(error);
      }
    };
    this.onRemoved = (data: unknown) => {
      const event = data as TriplesRemovedEvent;
      try {
        if (!this.indexWorkspace && isWorkspaceGraph(event.graph)) return;
        this.jobQueue.enqueueRemove(event.rootEntities, event.paranetId, event.graph);
      } catch (error) {
        this.markUnhealthy(error);
      }
    };

    this.eventBus.on(TRIPLES_STORED_EVENT, this.onStored);
    this.eventBus.on(TRIPLES_REMOVED_EVENT, this.onRemoved);
    this.jobQueue.start(this.workerIntervalMs);
    this.started = true;

    if (this.readMeta('healthy') === 'false') {
      console.warn('[VectorSidecar] Previous shutdown marked the index unhealthy, running full reindex');
      await this.reindexAllKnownGraphs();
      this.setHealthy(true);
    } else {
      this.setHealthy(true);
    }
  }

  async indexQuads(quads: Quad[], paranetId: string, graph: string): Promise<number> {
    this.assertStarted();
    if (!this.indexWorkspace && isWorkspaceGraph(graph)) return 0;

    const labelMap = buildLabelMap(quads);
    const candidates = quads
      .map((quad) => ({
        quad,
        text: tripleToText(quad, labelMap).trim(),
      }))
      .filter((item) => item.text.length >= this.minTextLength);
    if (candidates.length === 0) return 0;

    const embeddings = await this.embeddingProvider.embed(candidates.map((item) => item.text));
    await this.vectorStore.upsert(candidates.map((item, index) => ({
      subject: item.quad.subject,
      predicate: item.quad.predicate,
      object: item.quad.object,
      graph,
      paranetId,
      text: item.text,
      embedding: embeddings[index]?.embedding ?? [],
      createdAt: Date.now(),
    })));
    return candidates.length;
  }

  async removeByRootEntity(rootEntity: string, opts?: { paranetId?: string; graph?: string }): Promise<number> {
    this.assertStarted();
    return this.vectorStore.deleteByRootEntity(rootEntity, opts);
  }

  async removeByParanet(paranetId: string): Promise<number> {
    this.assertStarted();
    return this.vectorStore.deleteByParanet(paranetId);
  }

  async search(
    query: string,
    opts: {
      paranetId?: string;
      graph?: string;
      topK?: number;
      minScore?: number;
    } = {},
  ): Promise<SemanticSearchResult[]> {
    this.assertStarted();
    if (!this.healthy) throw new VectorIndexUnhealthyError();
    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    const requestedTopK = Math.max(1, opts.topK ?? 10);
    const candidates = await this.vectorStore.search(queryEmbedding.embedding, {
      ...opts,
      topK: Math.min(Math.max(requestedTopK * SEARCH_CANDIDATE_MULTIPLIER, requestedTopK), MAX_SEARCH_CANDIDATES),
    });
    const verified = await this.verifySearchCandidates(candidates, requestedTopK);
    return verified.map((result) => ({
      subject: result.entry.subject,
      predicate: result.entry.predicate,
      object: result.entry.object,
      graph: result.entry.graph,
      paranetId: result.entry.paranetId,
      score: result.score,
      text: result.entry.text,
    }));
  }

  async reindex(paranetId: string, opts?: { graph?: string }): Promise<{ count: number }> {
    this.assertStarted();
    this.jobQueue.stop();
    try {
      const graphs = await this.resolveGraphsForReindex(paranetId, opts?.graph);
      let count = 0;
      if (opts?.graph) {
        await this.vectorStore.deleteByGraph(opts.graph);
      } else {
        await this.vectorStore.deleteByParanet(paranetId);
      }

      for (const graph of graphs) {
        let offset = 0;
        while (true) {
          const safeGraph = assertSafeIri(graph);
          const query = `
            CONSTRUCT { ?s ?p ?o }
            WHERE { GRAPH <${safeGraph}> { ?s ?p ?o } }
            LIMIT ${REINDEX_BATCH_SIZE}
            OFFSET ${offset}
          `;
          const result = await this.store.query(query);
          if (result.type !== 'quads' || result.quads.length === 0) break;
          const batch = result.quads.map((quad) => ({ ...quad, graph: graph }));
          count += await this.indexQuads(batch, paranetId, graph);
          offset += result.quads.length;
          if (result.quads.length < REINDEX_BATCH_SIZE) break;
        }
      }

      this.setHealthy(true);
      return { count };
    } finally {
      this.jobQueue.start(this.workerIntervalMs);
    }
  }

  async stats(opts?: { paranetId?: string }): Promise<VectorStats> {
    this.assertStarted();
    return {
      healthy: this.healthy,
      indexed: await this.vectorStore.count({ paranetId: opts?.paranetId }),
      queue: this.jobQueue.stats(),
      modelName: this.embeddingProvider.modelName(),
      dimensions: this.embeddingProvider.dimensions(),
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.jobQueue.stop();
    if (this.onStored) this.eventBus.off(TRIPLES_STORED_EVENT, this.onStored);
    if (this.onRemoved) this.eventBus.off(TRIPLES_REMOVED_EVENT, this.onRemoved);
    await this.vectorStore.close();
    this.queueDb?.close();
    this.queueDb = null;
    this.started = false;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('VectorSidecar has not been started');
    }
  }

  private async recordModelInfo(): Promise<void> {
    const previousModel = this.readMeta('model_name');
    const previousDimensions = this.readMeta('dimensions');
    if (
      previousModel &&
      previousDimensions &&
      (previousModel !== this.embeddingProvider.modelName()
        || previousDimensions !== String(this.embeddingProvider.dimensions()))
    ) {
      console.warn('[VectorSidecar] Embedding model changed. Run reindex to update vectors.');
    }
    this.writeMeta('model_name', this.embeddingProvider.modelName());
    this.writeMeta('dimensions', String(this.embeddingProvider.dimensions()));
  }

  private async resolveGraphsForReindex(paranetId: string, graph?: string): Promise<string[]> {
    if (graph) {
      return isIndexableGraph(graph, this.indexWorkspace) ? [graph] : [];
    }
    const prefix = `did:dkg:paranet:${paranetId}`;
    const graphs = await this.store.listGraphs();
    return graphs.filter((candidate) =>
      candidate.startsWith(prefix) && isIndexableGraph(candidate, this.indexWorkspace),
    );
  }

  private async reindexAllKnownGraphs(): Promise<void> {
    const graphs = (await this.store.listGraphs()).filter((graph) => isIndexableGraph(graph, this.indexWorkspace));
    for (const graph of graphs) {
      const paranetId = parseParanetIdFromGraph(graph);
      if (!paranetId) continue;
      await this.reindex(paranetId, { graph });
    }
  }

  private markUnhealthy(error: unknown): void {
    this.setHealthy(false);
    console.error('[VectorSidecar] Failed to enqueue vector job:', error);
  }

  private setHealthy(value: boolean): void {
    this.healthy = value;
    this.writeMeta('healthy', value ? 'true' : 'false');
  }

  private readMeta(key: string): string | undefined {
    if (!this.queueDb) return undefined;
    const row = this.queueDb
      .prepare('SELECT value FROM vector_meta WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  private writeMeta(key: string, value: string): void {
    if (!this.queueDb) return;
    this.queueDb
      .prepare(`
        INSERT INTO vector_meta(key, value)
        VALUES(?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  private async verifySearchCandidates(
    candidates: VectorSearchResult[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const verified: VectorSearchResult[] = [];
    const staleIds: number[] = [];

    for (const candidate of candidates) {
      if (await this.tripleExists(candidate)) {
        verified.push(candidate);
        if (verified.length >= limit) break;
      } else if (typeof candidate.entry.id === 'number') {
        staleIds.push(candidate.entry.id);
      }
    }

    if (staleIds.length > 0) {
      try {
        await this.vectorStore.delete(staleIds);
      } catch (error) {
        console.warn('[VectorSidecar] Failed to delete stale vector rows:', error);
      }
    }

    return verified;
  }

  private async tripleExists(candidate: VectorSearchResult): Promise<boolean> {
    const result = await this.store.query(`
      ASK {
        GRAPH <${assertSafeIri(candidate.entry.graph)}> {
          <${assertSafeIri(candidate.entry.subject)}>
            <${assertSafeIri(candidate.entry.predicate)}>
            ${rdfTermToSparql(candidate.entry.object)}
        }
      }
    `);
    return result.type === 'boolean' && result.value;
  }
}

function createVectorStore(config: { dataDir: string; dimensions: number }): VectorStore {
  try {
    return new SqliteVecStore(config);
  } catch (error) {
    console.warn(
      `[VectorSidecar] sqlite-vec unavailable, falling back to streaming scan: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return new StreamingScanStore(config);
  }
}

function isWorkspaceGraph(graph: string): boolean {
  return graph.endsWith('/_workspace');
}

function isIndexableGraph(graph: string, indexWorkspace: boolean): boolean {
  if (!graph.startsWith('did:dkg:paranet:')) return false;
  if (graph.endsWith('/_meta')) return false;
  if (graph.endsWith('/_private')) return false;
  if (graph.endsWith('/_workspace_meta')) return false;
  if (!indexWorkspace && isWorkspaceGraph(graph)) return false;
  return true;
}

function parseParanetIdFromGraph(graph: string): string | null {
  const prefix = 'did:dkg:paranet:';
  if (!graph.startsWith(prefix)) return null;
  const rest = graph.slice(prefix.length);
  const candidates = [
    rest.indexOf('/context/'),
    rest.indexOf('/_workspace'),
    rest.indexOf('/_meta'),
    rest.indexOf('/_private'),
  ].filter((index) => index >= 0);
  if (candidates.length === 0) return rest;
  return rest.slice(0, Math.min(...candidates));
}

function rdfTermToSparql(value: string): string {
  if (value.startsWith('"') || value.startsWith('<')) {
    assertSafeRdfTerm(value);
    return value;
  }
  return `<${assertSafeIri(value)}>`;
}
