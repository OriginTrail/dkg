import Database from 'better-sqlite3';
import { join } from 'node:path';
import { EntitySearchError, checkDeadline, unitVector, type EntityDocument, type EntityIndexSpec } from './types.js';
import { documentKey } from './documents.js';

export interface IndexState {
  id: string; spec: EntityIndexSpec; fingerprint: string; generation: number;
  cursor: string | null; scanComplete: boolean; completedAt: string | null;
}
export class EntityIndexStore {
  private db: Database.Database;
  constructor(dir: string) {
    this.db = new Database(join(dir, 'entity-index.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS entity_indexes (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entity_documents (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
        document TEXT NOT NULL, vector TEXT NOT NULL, generation INTEGER NOT NULL,
        PRIMARY KEY(index_id, entity_key));`);
  }
  state(id: string): IndexState | undefined {
    const row = this.db.prepare('SELECT state FROM entity_indexes WHERE id = ?').get(id) as { state: string } | undefined;
    return row ? JSON.parse(row.state) : undefined;
  }
  save(state: IndexState): void {
    this.db.prepare('INSERT OR REPLACE INTO entity_indexes VALUES (?, ?)').run(state.id, JSON.stringify(state));
  }
  count(id: string): number {
    return (this.db.prepare('SELECT count(*) AS n FROM entity_documents WHERE index_id = ?').get(id) as { n: number }).n;
  }
  indexCount(): number { return (this.db.prepare('SELECT count(*) AS n FROM entity_indexes').get() as { n: number }).n; }
  cached(id: string, key: string): { document: EntityDocument; vector: number[] } | undefined {
    const row = this.db.prepare('SELECT document, vector FROM entity_documents WHERE index_id = ? AND entity_key = ?')
      .get(id, key) as { document: string; vector: string } | undefined;
    return row && { document: JSON.parse(row.document), vector: JSON.parse(row.vector) };
  }
  upsert(state: IndexState, doc: EntityDocument, vector: number[]): void {
    if (this.count(state.id) >= 100_000 && !this.cached(state.id, documentKey(doc))) throw new EntitySearchError('ENTITY_INDEX_CAPACITY', 422);
    this.db.prepare('INSERT OR REPLACE INTO entity_documents VALUES (?, ?, ?, ?, ?)')
      .run(state.id, documentKey(doc), JSON.stringify(doc), JSON.stringify(vector), state.generation);
  }
  finish(state: IndexState): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM entity_documents WHERE index_id = ? AND generation != ?').run(state.id, state.generation);
      this.save(state);
    })();
  }
  rank(id: string, query: number[], limit: number, signal: AbortSignal, deadline: number) {
    const best: Array<{ document: EntityDocument; score: number }> = [];
    const normalized = unitVector(query, query.length);
    for (const raw of this.db.prepare('SELECT document, vector FROM entity_documents WHERE index_id = ?').iterate(id)) {
      checkDeadline(signal, deadline);
      const row = raw as { document: string; vector: string };
      const vector = unitVector(JSON.parse(row.vector), query.length);
      const score = Math.max(-1, Math.min(1, vector.reduce((sum, n, i) => sum + n * normalized[i], 0)));
      best.push({ document: JSON.parse(row.document), score });
      best.sort((a, b) => b.score - a.score || documentKey(a.document).localeCompare(documentKey(b.document)));
      if (best.length > limit) best.pop();
    }
    return best;
  }
  close(): void { this.db.close(); }
}
