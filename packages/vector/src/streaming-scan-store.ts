import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  cosineSimilarity,
  decodeEmbedding,
  encodeEmbedding,
  isSkolemizedDescendant,
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

export class StreamingScanStore implements VectorStore {
  protected readonly db: Database;
  protected readonly dimensions: number;

  constructor(config: VectorStoreConfig) {
    this.dimensions = config.dimensions;
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(join(config.dataDir, 'vector-store.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  async upsert(entries: VectorEntry[]): Promise<void> {
    if (entries.length === 0) return;

    const selectStmt = this.db.prepare(`
      SELECT id
      FROM triple_meta
      WHERE subject = ? AND predicate = ? AND object = ? AND graph = ?
    `);
    const insertStmt = this.db.prepare(`
      INSERT INTO triple_meta (
        subject, predicate, object, graph, paranet_id, text, embedding, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateStmt = this.db.prepare(`
      UPDATE triple_meta
      SET paranet_id = ?, text = ?, embedding = ?, created_at = ?
      WHERE id = ?
    `);

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
          updateStmt.run(
            entry.paranetId,
            entry.text,
            encoded,
            entry.createdAt,
            existing.id,
          );
        } else {
          insertStmt.run(
            entry.subject,
            entry.predicate,
            entry.object,
            entry.graph,
            entry.paranetId,
            entry.text,
            encoded,
            entry.createdAt,
          );
        }
      }
    });

    upsertTx(entries);
  }

  async search(embedding: number[], opts: VectorStoreSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);
    const minScore = opts.minScore ?? 0;
    const queryEmbedding = normalizeEmbedding(embedding, this.dimensions);
    const rows = this.selectRows(opts);
    const matches = rows
      .map((row) => ({
        row,
        score: cosineSimilarity(queryEmbedding, decodeEmbedding(row.embedding)),
      }))
      .filter((item) => item.score >= minScore)
      .sort((left, right) => right.score - left.score || left.row.id - right.row.id)
      .slice(0, topK);

    return matches.map(({ row, score }) => rowToSearchResult(row, score));
  }

  async delete(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    const deleteStmt = this.db.prepare('DELETE FROM triple_meta WHERE id = ?');
    const deleteTx = this.db.transaction((rowIds: number[]) => {
      for (const id of rowIds) {
        deleteStmt.run(id);
      }
    });
    deleteTx(ids);
  }

  async deleteByGraph(graph: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM triple_meta WHERE graph = ?').run(graph);
    return result.changes;
  }

  async deleteByParanet(paranetId: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM triple_meta WHERE paranet_id = ?').run(paranetId);
    return result.changes;
  }

  async deleteByRootEntity(rootEntity: string, opts: VectorStoreDeleteRootOptions = {}): Promise<number> {
    const rows = this.selectRowsForRoot(rootEntity, opts);
    if (rows.length === 0) return 0;
    await this.delete(rows.map((row) => row.id));
    return rows.length;
  }

  async count(opts: VectorStoreCountOptions = {}): Promise<number> {
    const { whereClause, params } = buildCountWhereClause(opts);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM triple_meta ${whereClause}`)
      .get(...params) as { count: number };
    return row.count;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  protected migrate(): void {
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

    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  protected selectRows(opts: VectorStoreSearchOptions = {}): MetadataRow[] {
    const { whereClause, params } = buildCountWhereClause(opts);
    return this.db
      .prepare(`
        SELECT id, subject, predicate, object, graph, paranet_id, text, embedding, created_at
        FROM triple_meta
        ${whereClause}
      `)
      .all(...params) as MetadataRow[];
  }

  protected selectRowsForRoot(
    rootEntity: string,
    opts: VectorStoreDeleteRootOptions = {},
  ): MetadataRow[] {
    const clauses = [
      '(subject = ? OR subject LIKE ?)',
    ];
    const params: Array<string> = [rootEntity, `${rootEntity}/.well-known/genid/%`];
    if (opts.paranetId) {
      clauses.push('paranet_id = ?');
      params.push(opts.paranetId);
    }
    if (opts.graph) {
      clauses.push('graph = ?');
      params.push(opts.graph);
    }
    return this.db
      .prepare(`
        SELECT id, subject, predicate, object, graph, paranet_id, text, embedding, created_at
        FROM triple_meta
        WHERE ${clauses.join(' AND ')}
      `)
      .all(...params) as MetadataRow[];
  }
}

function buildCountWhereClause(
  opts: VectorStoreSearchOptions | VectorStoreCountOptions,
): { whereClause: string; params: Array<string> } {
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
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  };
}
