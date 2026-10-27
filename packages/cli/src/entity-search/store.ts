import Database from 'better-sqlite3';
import { join } from 'node:path';
import { EntitySearchError, checkDeadline, unitVector, type EntityCandidate, type EntityIndexSpec, type EntityIdentity } from './types.js';
import { documentKey } from './identity.js';

export interface IndexState {
  id: string; spec: EntityIndexSpec; fingerprint: string;
  cursor: EntityIdentity | null; scanComplete: boolean; completedAt: string | null;
}
/** Version-1 checkpoints retain their original tuple encoding only on disk. */
function decodeState(raw: string): IndexState {
  const state = JSON.parse(raw) as Omit<IndexState, 'cursor'> & { cursor: unknown };
  if (state.cursor === null) return { ...state, cursor: null };
  const cursor: unknown = typeof state.cursor === 'string' ? JSON.parse(state.cursor) : undefined;
  if (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some(value => typeof value !== 'string'))
    throw new Error('Invalid entity scan checkpoint');
  return { ...state, cursor: { sourceGraph: cursor[0], entityUri: cursor[1] } };
}
export class EntityIndexStore {
  private db: Database.Database;
  constructor(dir: string, private readonly capacity = 100_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100_000) throw new RangeError('Invalid entity index capacity');
    this.db = new Database(join(dir, 'entity-index.db'));
    this.db.pragma('journal_mode = WAL');
    try { this.migrate(); }
    catch (error) { this.db.close(); throw error; }
  }
  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version === 2) return;
    if (version !== 0 && version !== 1) throw new Error(`Unsupported entity index schema version: ${version}`);
    // Version 0 covers the previously unversioned completed-only and split-scan
    // formats. Inspect and upgrade those shapes once, atomically with the marker.
    this.db.transaction(() => {
      const legacy = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entity_documents'").get()
        && !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'entity_scan_documents'").get();
      this.db.exec(`CREATE TABLE IF NOT EXISTS entity_indexes (id TEXT PRIMARY KEY, state TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS entity_documents (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
          source_graph TEXT NOT NULL, entity_uri TEXT NOT NULL, content_hash TEXT NOT NULL,
          vector TEXT NOT NULL, PRIMARY KEY(index_id, entity_key));
        CREATE TABLE IF NOT EXISTS entity_scan_documents (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
          source_graph TEXT NOT NULL, entity_uri TEXT NOT NULL, content_hash TEXT NOT NULL,
          vector TEXT NOT NULL, PRIMARY KEY(index_id, entity_key));`);
      for (const table of ['entity_documents', 'entity_scan_documents']) {
        const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
        if (columns.some(column => column.name === 'document')) {
          this.db.exec(`CREATE TABLE ${table}_compact (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
            source_graph TEXT NOT NULL, entity_uri TEXT NOT NULL, content_hash TEXT NOT NULL,
            vector TEXT NOT NULL, PRIMARY KEY(index_id, entity_key));
            INSERT INTO ${table}_compact SELECT index_id, entity_key,
              json_extract(document, '$.sourceGraph'), json_extract(document, '$.entityUri'),
              json_extract(document, '$.contentHash'), vector FROM ${table};
            DROP TABLE ${table}; ALTER TABLE ${table}_compact RENAME TO ${table};`);
        } else if (columns.some(column => column.name === 'generation')) this.db.exec(`ALTER TABLE ${table} DROP COLUMN generation`);
      }
      for (const row of this.db.prepare('SELECT state FROM entity_indexes').all() as Array<{ state: string }>) {
        const state = decodeState(row.state) as IndexState & { generation?: number };
        delete state.generation;
        // Completed-only legacy scans have no independent checkpoint payload.
        // Retain their visible documents and revisit the unfinished scan from zero.
        if (legacy && !state.scanComplete) state.cursor = null;
        this.save(state);
      }
      this.db.pragma('user_version = 2');
    })();
  }

  state(id: string): IndexState | undefined {
    const row = this.db.prepare('SELECT state FROM entity_indexes WHERE id = ?').get(id) as { state: string } | undefined;
    return row ? decodeState(row.state) : undefined;
  }
  save(state: IndexState): void {
    const cursor = state.cursor ? JSON.stringify([state.cursor.sourceGraph, state.cursor.entityUri]) : null;
    this.db.prepare('INSERT OR REPLACE INTO entity_indexes VALUES (?, ?)').run(state.id, JSON.stringify({ ...state, cursor }));
  }
  /** A restart drops only the unfinished scan; the last completed index survives. */
  begin(state: IndexState): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entity_scan_documents WHERE index_id = ?').run(state.id);
      this.save(state);
    })();
  }
  private candidates = `SELECT * FROM entity_scan_documents WHERE index_id = @id
    UNION ALL SELECT * FROM entity_documents WHERE index_id = @id AND entity_key NOT IN
      (SELECT entity_key FROM entity_scan_documents WHERE index_id = @id)`;
  count(id: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM (${this.candidates})`).get({ id }) as { n: number }).n;
  }
  indexCount(): number { return (this.db.prepare('SELECT count(*) AS n FROM entity_indexes').get() as { n: number }).n; }
  cached(id: string, key: string): EntityCandidate | undefined {
    const row = this.db.prepare(`SELECT source_graph, entity_uri, content_hash, vector FROM (${this.candidates}) WHERE entity_key = @key`)
      .get({ id, key }) as { source_graph: string; entity_uri: string; content_hash: string; vector: string } | undefined;
    return row && { sourceGraph: row.source_graph, entityUri: row.entity_uri, contentHash: row.content_hash, vector: JSON.parse(row.vector) };
  }
  upsert(state: IndexState, candidate: EntityCandidate): void {
    const key = documentKey(candidate);
    const count = (this.db.prepare('SELECT count(*) AS n FROM entity_scan_documents WHERE index_id = ?')
      .get(state.id) as { n: number }).n;
    if (count >= this.capacity && !this.db.prepare('SELECT 1 FROM entity_scan_documents WHERE index_id = ? AND entity_key = ?')
      .get(state.id, key)) throw new EntitySearchError('ENTITY_INDEX_CAPACITY', 422);
    this.db.prepare('INSERT OR REPLACE INTO entity_scan_documents VALUES (?, ?, ?, ?, ?, ?)')
      .run(state.id, key, candidate.sourceGraph, candidate.entityUri, candidate.contentHash, JSON.stringify(candidate.vector));
  }
  finish(state: IndexState): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entity_documents WHERE index_id = ?').run(state.id);
      this.db.prepare('INSERT INTO entity_documents SELECT * FROM entity_scan_documents WHERE index_id = ?').run(state.id);
      this.db.prepare('DELETE FROM entity_scan_documents WHERE index_id = ?').run(state.id);
      this.save(state);
    })();
  }
  rank(id: string, query: number[], limit: number, signal: AbortSignal, deadline: number) {
    const best: Array<Omit<EntityCandidate, 'vector'> & { entityKey: string; score: number }> = [];
    const normalized = unitVector(query, query.length);
    for (const raw of this.db.prepare(this.candidates).iterate({ id })) {
      checkDeadline(signal, deadline);
      const row = raw as { entity_key: string; source_graph: string; entity_uri: string; content_hash: string; vector: string };
      const vector = unitVector(JSON.parse(row.vector), query.length);
      const score = Math.max(-1, Math.min(1, vector.reduce((sum, n, i) => sum + n * normalized[i], 0)));
      best.push({ entityKey: row.entity_key, sourceGraph: row.source_graph, entityUri: row.entity_uri, contentHash: row.content_hash, score });
      best.sort((a, b) => b.score - a.score || a.entityKey.localeCompare(b.entityKey));
      if (best.length > limit) best.pop();
    }
    return best.map(({ entityKey: _entityKey, ...candidate }) => {
      checkDeadline(signal, deadline);
      return candidate;
    });
  }
  close(): void { this.db.close(); }
}
