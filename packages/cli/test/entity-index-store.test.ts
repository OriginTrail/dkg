import { afterEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntityIndexStore, type IndexState } from '../src/entity-search/store.js';
import { documentKey } from '../src/entity-search/documents.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'entity-candidates-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const candidate = { sourceGraph: 'urn:graph', entityUri: 'urn:entity:a', contentHash: 'hash-a', vector: [1, 0] };
function state(): IndexState {
  return { id: 'index', spec: { contextGraphId: 'catalog', view: 'verifiable-memory', textPredicates: [], types: [] },
    fingerprint: 'test-v1', cursor: candidate, scanComplete: false, completedAt: null };
}
function assertCompact(db: Database.Database) {
  expect(db.pragma('user_version', { simple: true })).toBe(2);
  for (const table of ['entity_documents', 'entity_scan_documents']) {
    expect((db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(column => column.name))
      .toEqual(['index_id', 'entity_key', 'source_graph', 'entity_uri', 'content_hash', 'vector']);
    expect(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).not.toContain('hydrated text');
  }
}

it('persists only candidate fields even when a caller supplies hydrated text', () => {
  const dir = directory(), store = new EntityIndexStore(dir); cleanup.push(() => store.close());
  const checkpoint = state(), hydrated = { ...candidate, text: 'hydrated text must stay in the graph' };
  store.begin(checkpoint); store.upsert(checkpoint, hydrated);
  expect(store.cached(checkpoint.id, documentKey(candidate))).toEqual(candidate);
  const db = new Database(join(dir, 'entity-index.db')); cleanup.push(() => db.close());
  assertCompact(db);
  checkpoint.scanComplete = true; store.finish(checkpoint);
  assertCompact(db);
  expect(store.rank(checkpoint.id, [1, 0], 1, new AbortController().signal, performance.now() + 1000))
    .toEqual([{ sourceGraph: candidate.sourceGraph, entityUri: candidate.entityUri, contentHash: candidate.contentHash, score: 1 }]);
});

it.each([{ version: 0, split: false }, { version: 0, split: true }, { version: 1, split: true }])
  ('migrates real legacy version $version split=$split without losing candidates or checkpoints', ({ version, split }) => {
    const dir = directory(), path = join(dir, 'entity-index.db'), db = new Database(path);
    const checkpoint = state();
    db.exec('CREATE TABLE entity_indexes (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    db.prepare('INSERT INTO entity_indexes VALUES (?, ?)').run(checkpoint.id,
      JSON.stringify({ ...checkpoint, cursor: JSON.stringify([candidate.sourceGraph, candidate.entityUri]), generation: 7 }));
    for (const table of split ? ['entity_documents', 'entity_scan_documents'] : ['entity_documents']) {
      db.exec(`CREATE TABLE ${table} (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
        document TEXT NOT NULL, vector TEXT NOT NULL, generation INTEGER DEFAULT 7, PRIMARY KEY(index_id, entity_key))`);
      const document = { ...candidate, text: 'hydrated text', contentHash: table === 'entity_scan_documents' ? 'new-hash' : candidate.contentHash };
      db.prepare(`INSERT INTO ${table} (index_id, entity_key, document, vector) VALUES (?, ?, ?, ?)`)
        .run(checkpoint.id, documentKey(candidate), JSON.stringify(document), JSON.stringify(candidate.vector));
    }
    db.pragma(`user_version = ${version}`); db.close();
    const store = new EntityIndexStore(dir); cleanup.push(() => store.close());
    const migrated = store.state(checkpoint.id)!;
    expect(migrated).not.toHaveProperty('generation');
    expect(migrated.cursor).toEqual(split ? { sourceGraph: candidate.sourceGraph, entityUri: candidate.entityUri } : null);
    expect(migrated.scanComplete).toBe(false);
    expect(store.count(checkpoint.id)).toBe(1);
    expect(store.cached(checkpoint.id, documentKey(candidate)))
      .toEqual({ ...candidate, contentHash: split ? 'new-hash' : candidate.contentHash });
    const inspect = new Database(path); cleanup.push(() => inspect.close());
    assertCompact(inspect);
    expect(store.rank(checkpoint.id, [1, 0], 1, new AbortController().signal, performance.now() + 1000)[0].score).toBe(1);
  });
