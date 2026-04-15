/**
 * V1 Vector Store — SQLite-backed embedding storage and similarity search.
 *
 * Uses better-sqlite3 with embeddings stored as float32 BLOBs. Similarity
 * search is brute-force cosine similarity computed in JS — sufficient for
 * <100K embeddings (single-node agent memory). The interface is designed
 * for a drop-in upgrade to sqlite-vec or pgvector when needed.
 *
 * Spec: 21_TRI_MODAL_MEMORY.md §6
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export interface EmbeddingRecord {
  id?: string;
  embedding: number[];
  sourceUri: string;
  entityUri: string;
  contextGraphId: string;
  memoryLayer: 'wm' | 'swm' | 'vm';
  model: string;
  snippet?: string;
  label?: string;
  createdAt?: string;
}

export interface VectorSearchOpts {
  contextGraphId: string;
  memoryLayers: Array<'wm' | 'swm' | 'vm'>;
  limit: number;
  minSimilarity?: number;
}

export interface VectorSearchResult {
  id: string;
  entityUri: string;
  sourceUri: string;
  similarity: number;
  label: string | null;
  snippet: string | null;
  memoryLayer: string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  readonly model: string;
  readonly dimensions: number;
}

export class VectorStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    const dbPath = join(dataDir, 'vector-store.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= 1) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        dimensions INTEGER NOT NULL,
        source_uri TEXT NOT NULL,
        entity_uri TEXT NOT NULL,
        context_graph_id TEXT NOT NULL,
        memory_layer TEXT NOT NULL CHECK(memory_layer IN ('wm','swm','vm')),
        model TEXT NOT NULL,
        label TEXT,
        snippet TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_cg ON embeddings(context_graph_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_entity ON embeddings(entity_uri);
      CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_uri);
      CREATE INDEX IF NOT EXISTS idx_embeddings_layer ON embeddings(memory_layer);
    `);
    this.db.pragma(`user_version = 1`);
  }

  async insert(record: EmbeddingRecord): Promise<string> {
    const id = record.id ?? randomUUID();
    const blob = float32ToBlob(record.embedding);
    this.db.prepare(`
      INSERT OR REPLACE INTO embeddings
        (id, embedding, dimensions, source_uri, entity_uri, context_graph_id, memory_layer, model, label, snippet, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      blob,
      record.embedding.length,
      record.sourceUri,
      record.entityUri,
      record.contextGraphId,
      record.memoryLayer,
      record.model,
      record.label ?? null,
      record.snippet ?? null,
      record.createdAt ?? new Date().toISOString(),
    );
    return id;
  }

  /**
   * Brute-force cosine similarity search. Loads all embeddings for the given
   * CG + layers, computes similarity in JS, returns top-K. Sufficient for
   * <100K embeddings; upgrade to sqlite-vec or pgvector for scale.
   */
  async search(queryEmbedding: number[], opts: VectorSearchOpts): Promise<VectorSearchResult[]> {
    const layerPlaceholders = opts.memoryLayers.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT id, embedding, dimensions, entity_uri, source_uri, label, snippet, memory_layer
      FROM embeddings
      WHERE context_graph_id = ? AND memory_layer IN (${layerPlaceholders})
    `).all(opts.contextGraphId, ...opts.memoryLayers) as Array<{
      id: string;
      embedding: Buffer;
      dimensions: number;
      entity_uri: string;
      source_uri: string;
      label: string | null;
      snippet: string | null;
      memory_layer: string;
    }>;

    const minSim = opts.minSimilarity ?? 0.0;
    const queryDim = queryEmbedding.length;
    const scored: VectorSearchResult[] = [];

    for (const row of rows) {
      if (row.dimensions !== queryDim) continue;
      const stored = blobToFloat32(row.embedding, row.dimensions);
      const sim = cosineSimilarity(queryEmbedding, stored);
      if (sim >= minSim) {
        scored.push({
          id: row.id,
          entityUri: row.entity_uri,
          sourceUri: row.source_uri,
          similarity: sim,
          label: row.label,
          snippet: row.snippet,
          memoryLayer: row.memory_layer,
        });
      }
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, opts.limit);
  }

  async delete(opts: { sourceUri?: string; entityUri?: string }): Promise<number> {
    if (opts.sourceUri) {
      const info = this.db.prepare('DELETE FROM embeddings WHERE source_uri = ?').run(opts.sourceUri);
      return info.changes;
    }
    if (opts.entityUri) {
      const info = this.db.prepare('DELETE FROM embeddings WHERE entity_uri = ?').run(opts.entityUri);
      return info.changes;
    }
    return 0;
  }

  async count(contextGraphId?: string): Promise<number> {
    if (contextGraphId) {
      const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embeddings WHERE context_graph_id = ?').get(contextGraphId) as { cnt: number };
      return row.cnt;
    }
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM embeddings').get() as { cnt: number };
    return row.cnt;
  }

  close(): void {
    this.db.close();
  }
}

function float32ToBlob(arr: number[]): Buffer {
  const buf = Buffer.alloc(arr.length * 4);
  for (let i = 0; i < arr.length; i++) {
    buf.writeFloatLE(arr[i], i * 4);
  }
  return buf;
}

function blobToFloat32(buf: Buffer, dimensions: number): number[] {
  const arr = new Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    arr[i] = buf.readFloatLE(i * 4);
  }
  return arr;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * OpenAI-compatible embedding provider.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;
  private readonly baseURL: string;

  constructor(opts: { apiKey: string; model?: string; dimensions?: number; baseURL?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'text-embedding-3-small';
    this.dimensions = opts.dimensions ?? 1536;
    this.baseURL = (opts.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async embed(text: string): Promise<number[]> {
    const truncated = text.length > 8000 ? text.slice(0, 8000) : text;
    const resp = await fetch(`${this.baseURL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: truncated,
        dimensions: this.dimensions,
      }),
    });
    if (!resp.ok) {
      throw new Error(`Embedding API error: ${resp.status} ${resp.statusText}`);
    }
    const json = await resp.json() as { data: Array<{ embedding: number[] }> };
    return json.data[0].embedding;
  }
}
