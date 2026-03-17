import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  normalizeEmbedding,
  rowToSearchResult,
  type VectorEntry,
  type VectorSearchResult,
  type VectorStore,
  type VectorStoreConfig,
  type VectorStoreCountOptions,
  type VectorStoreDeleteRootOptions,
  type VectorStoreSearchOptions,
} from './vector-store.js';

const SCHEMA_VERSION = 1;
const DEFAULT_TOP_K = 10;

type MetadataRow = {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  graph: string;
  paranet_id: string;
  text: string;
  embedding: Buffer;
  created_at: number;
};

export class SqliteVecStore implements VectorStore {
  private readonly db: Database;
  private readonly dimensions: number;

  constructor(config: VectorStoreConfig) {
    this.dimensions = config.dimensions;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(join(config.dataDir, 'vector-store.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    loadSqliteVecExtension(this.db);
    this.migrate();
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const selectStmt = this.db.prepare(`
      SELECT id
      FROM triple_meta
      WHERE subject = ? AND predicate = ? AND object = ? AND graph = ?
    `);
    const insertMetaStmt = this.db.prepare(`
      INSERT INTO triple_meta (
        subject, predicate, object, graph, paranet_id, text, embedding, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateMetaStmt = this.db.prepare(`
      UPDATE triple_meta
      SET paranet_id = ?, text = ?, embedding = ?, created_at = ?
      WHERE id = ?
    `);
    const deleteVecStmt = this.db.prepare('DELETE FROM vec_triples WHERE rowid = ?');
    const insertVecStmt = this.db.prepare('INSERT INTO vec_triples(rowid, embedding) VALUES (?, ?)');

    const upsertTx = this.db.transaction((batch: VectorEntry[]) => {
      for (const entry of batch) {
        const normalizedEmbedding = normalizeEmbedding(entry.embedding, this.dimensions);
        const encoded = encodeEmbedding(normalizedEmbedding);
        const existing = selectStmt.get(
          entry.subject,
          entry.predicate,
          entry.object,
          entry.graph,
        ) as { id: number } | undefined;

        if (existing) {
          updateMetaStmt.run(
            entry.paranetId,
            entry.text,
            encoded,
            entry.createdAt,
            existing.id,
          );
          deleteVecStmt.run(existing.id);
          insertVecStmt.run(toVecRowId(existing.id), JSON.stringify(normalizedEmbedding));
        } else {
          const result = insertMetaStmt.run(
            entry.subject,
            entry.predicate,
            entry.object,
            entry.graph,
            entry.paranetId,
            entry.text,
            encoded,
            entry.createdAt,
          );
          insertVecStmt.run(toVecRowId(result.lastInsertRowid), JSON.stringify(normalizedEmbedding));
        }
      }
    });

    upsertTx(entries);
  }

  async search(embedding: number[], opts: VectorStoreSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);
    const minScore = opts.minScore ?? 0;
    const queryEmbedding = normalizeEmbedding(embedding, this.dimensions);
    const candidateLimit = Math.max(topK * 4, topK);
    const { clause, params } = buildWhereClause(opts);
    const rows = this.db
      .prepare(`
        SELECT
          m.id,
          m.subject,
          m.predicate,
          m.object,
          m.graph,
          m.paranet_id,
          m.text,
          m.embedding,
          m.created_at
        FROM vec_triples v
        JOIN triple_meta m ON m.id = v.rowid
        ${clause}
        AND v.embedding MATCH ?
        AND k = ?
      `)
      .all(...params, JSON.stringify(queryEmbedding), candidateLimit) as MetadataRow[];

    return rows
      .map((row) => ({
        row,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(row.embedding)),
      }))
      .filter((item) => item.score >= minScore)
      .sort((left, right) => right.score - left.score || left.row.id - right.row.id)
      .slice(0, topK)
      .map(({ row, score }) => rowToSearchResult(row, score));
  }

  async delete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const deleteMetaStmt = this.db.prepare('DELETE FROM triple_meta WHERE id = ?');
    const deleteVecStmt = this.db.prepare('DELETE FROM vec_triples WHERE rowid = ?');
    const deleteTx = this.db.transaction((rowIds: number[]) => {
      for (const id of rowIds) {
        deleteVecStmt.run(id);
        deleteMetaStmt.run(id);
      }
    });
    deleteTx(ids);
  }

  async deleteByGraph(graph: string): Promise<number> {
    const ids = this.collectIds('graph = ?', [graph]);
    await this.delete(ids);
    return ids.length;
  }

  async deleteByParanet(paranetId: string): Promise<number> {
    const ids = this.collectIds('paranet_id = ?', [paranetId]);
    await this.delete(ids);
    return ids.length;
  }

  async deleteByRootEntity(rootEntity: string, opts: VectorStoreDeleteRootOptions = {}): Promise<number> {
    const clauses = ['(subject = ? OR subject LIKE ?)'];
    const params: Array<string> = [rootEntity, `${rootEntity}/.well-known/genid/%`];
    if (opts.paranetId) {
      clauses.push('paranet_id = ?');
      params.push(opts.paranetId);
    }
    if (opts.graph) {
      clauses.push('graph = ?');
      params.push(opts.graph);
    }
    const ids = this.collectIds(clauses.join(' AND '), params);
    await this.delete(ids);
    return ids.length;
  }

  async count(opts: VectorStoreCountOptions = {}): Promise<number> {
    const { countClause, params } = buildCountClause(opts);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM triple_meta ${countClause}`)
      .get(...params) as { count: number };
    return row.count;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version >= SCHEMA_VERSION) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS triple_meta (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        graph TEXT NOT NULL,
        paranet_id TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(subject, predicate, object, graph)
      );
      CREATE INDEX IF NOT EXISTS idx_triple_meta_paranet ON triple_meta(paranet_id);
      CREATE INDEX IF NOT EXISTS idx_triple_meta_graph ON triple_meta(graph);
      CREATE INDEX IF NOT EXISTS idx_triple_meta_subject ON triple_meta(subject);
    `);
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_triples USING vec0(
        embedding float[${this.dimensions}]
      );
    `);

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  private collectIds(whereClause: string, params: Array<string>): number[] {
    const rows = this.db
      .prepare(`SELECT id FROM triple_meta WHERE ${whereClause}`)
      .all(...params) as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }
}

function toVecRowId(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

export function canLoadSqliteVec(): boolean {
  try {
    const db = new Database(':memory:');
    try {
      loadSqliteVecExtension(db);
      db.exec('CREATE VIRTUAL TABLE probe_vec USING vec0(embedding float[4]);');
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

function loadSqliteVecExtension(db: Database): void {
  const require = createRequire(import.meta.url);
  let moduleValue: unknown;
  try {
    moduleValue = require('sqlite-vec');
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message : 'sqlite-vec is not installed',
    );
  }

  if (typeof moduleValue === 'function') {
    (moduleValue as (db: Database) => void)(db);
    return;
  }

  const maybeDefault = typeof moduleValue === 'object' && moduleValue !== null
    ? (moduleValue as { default?: unknown }).default
    : undefined;

  const loaders = [
    moduleValue,
    maybeDefault,
    typeof moduleValue === 'object' && moduleValue !== null ? (moduleValue as { load?: unknown }).load : undefined,
    typeof maybeDefault === 'object' && maybeDefault !== null ? (maybeDefault as { load?: unknown }).load : undefined,
  ];

  for (const loader of loaders) {
    if (typeof loader === 'function') {
      (loader as (db: Database) => void)(db);
      return;
    }
  }

  const candidates = [
    extractPath(moduleValue),
    extractPath(maybeDefault),
  ];
  for (const candidate of candidates) {
    if (candidate) {
      db.loadExtension(candidate);
      return;
    }
  }

  throw new Error('Unsupported sqlite-vec module shape');
}

function extractPath(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.path === 'string') return record.path;
    if (typeof record.loadablePath === 'string') return record.loadablePath;
    if (typeof record.loadablePath === 'function') return String(record.loadablePath());
    if (typeof record.getLoadablePath === 'function') return String(record.getLoadablePath());
  }
  return null;
}

function buildWhereClause(
  opts: VectorStoreSearchOptions,
): { clause: string; params: Array<string> } {
  const clauses = ['WHERE 1 = 1'];
  const params: Array<string> = [];
  if (opts.paranetId) {
    clauses.push('AND m.paranet_id = ?');
    params.push(opts.paranetId);
  }
  if (opts.graph) {
    clauses.push('AND m.graph = ?');
    params.push(opts.graph);
  }
  return {
    clause: clauses.join('\n'),
    params,
  };
}

function buildCountClause(
  opts: VectorStoreCountOptions,
): { countClause: string; params: Array<string> } {
  const clauses: string[] = [];
  const params: Array<string> = [];
  if (opts.paranetId) {
    clauses.push('paranet_id = ?');
    params.push(opts.paranetId);
  }
  if (opts.graph) {
    clauses.push('graph = ?');
    params.push(opts.graph);
  }
  return {
    countClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}
