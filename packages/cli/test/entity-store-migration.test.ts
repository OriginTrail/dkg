import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EntityIndexStore, type IndexState } from '../src/entity-search/store.js';
import { documentKey } from '../src/entity-search/documents.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const stop of cleanup.splice(0).reverse()) stop(); });
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'entity-migration-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
function open(dir: string) { const store = new EntityIndexStore(dir); cleanup.push(() => store.close()); return store; }
const spec = { contextGraphId: 'catalog', view: 'verifiable-memory' as const, textPredicates: ['urn:text'], types: [] };
const document = { entityUri: 'urn:item', sourceGraph: 'urn:graph', text: 'ocean', contentHash: 'hash' };
const state: IndexState = { id: 'a'.repeat(64), spec, fingerprint: 'model', cursor: documentKey(document), scanComplete: false, completedAt: null };
it('versions fresh creation and preserves a current interrupted scan on reopening', () => {
  const dir = directory(), store = open(dir);
  store.begin(state); store.upsert(state, document, [1, 0]);
  const reopened = open(dir);
  expect(reopened.state(state.id)).toEqual(state);
  expect(reopened.cached(state.id, documentKey(document))).toEqual({ document, vector: [1, 0] });
  const db = new Database(join(dir, 'entity-index.db'));
  try { expect(db.pragma('user_version', { simple: true })).toBe(1); } finally { db.close(); }
});
it.each([true, false])('upgrades the completed-only legacy format once, scanComplete=%s', scanComplete => {
  const dir = directory(), db = new Database(join(dir, 'entity-index.db'));
  const original = { ...state, scanComplete, completedAt: scanComplete ? '2026-10-01T00:00:00Z' : null, generation: 7 };
  try {
    db.exec(`CREATE TABLE entity_indexes (id TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE entity_documents (index_id TEXT NOT NULL, entity_key TEXT NOT NULL,
        document TEXT NOT NULL, vector TEXT NOT NULL, generation INTEGER NOT NULL,
        PRIMARY KEY(index_id, entity_key));`);
    db.prepare('INSERT INTO entity_indexes VALUES (?, ?)').run(state.id, JSON.stringify(original));
    db.prepare('INSERT INTO entity_documents VALUES (?, ?, ?, ?, ?)').run(state.id, documentKey(document), JSON.stringify(document), '[1,0]', 7);
  } finally { db.close(); }
  const upgraded = open(dir);
  const expected = { ...state, scanComplete, completedAt: original.completedAt, cursor: scanComplete ? state.cursor : null };
  expect(upgraded.state(state.id)).toEqual(expected);
  expect(upgraded.cached(state.id, documentKey(document))).toEqual({ document, vector: [1, 0] });
  // A saved version-1 checkpoint is no longer reset by the legacy upgrade.
  upgraded.save({ ...expected, cursor: 'new-checkpoint' });
  expect(open(dir).state(state.id)?.cursor).toBe('new-checkpoint');
});
