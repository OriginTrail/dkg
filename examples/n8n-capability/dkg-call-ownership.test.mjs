import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDkgCallJournal } from './dkg-call-journal.mjs';

function legacy(db) {
  db.exec(`CREATE TABLE dkg_component_calls (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, request TEXT, prepared TEXT, result TEXT, response TEXT);
    CREATE TABLE dkg_component_runs (id TEXT PRIMARY KEY,ka_ref TEXT NOT NULL);`);
}
const retained = { id: 'run-one:child:read', request_hash: 'a'.repeat(64), request: '{ "blockId": "read", "items": [{}] }',
  prepared: '{ "query": "original query" }', result: '{ "verified": true }', response: '{ "items": [{"value":2}] }' };
const insert = (db, row = retained) => db.prepare('INSERT INTO dkg_component_calls VALUES (?,?,?,?,?,?)')
  .run(row.id, row.request_hash, row.request, row.prepared, row.result, row.response);
const stored = db => db.prepare('SELECT * FROM dkg_component_calls ORDER BY id').all().map(row => ({ ...row }));

test('ownership migration preserves call bytes across reopen and isolates colon-containing invocations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-call-owner-')), file = join(dir, 'journal.sqlite');
  let db = new DatabaseSync(file);
  try {
    legacy(db); insert(db);
    db.exec("INSERT INTO dkg_component_runs VALUES ('run-one','urn:flow'),('run-one:child','urn:flow')");
    let journal = createDkgCallJournal(db);
    assert.deepEqual(stored(db), [{ ...retained, invocation_id: 'run-one:child', block_id: 'read' }]);
    assert.equal(journal.invocation('run-one').hasCalls(), false);
    assert.equal(journal.invocation('run-one:child').hasCalls(), true);
    assert.deepEqual(journal.invocation('run-one:child').read('read').response, JSON.parse(retained.response));
    assert.equal(journal.invocation('run-one').read('read'), null);
    assert.throws(() => db.prepare('INSERT INTO dkg_component_calls (id,invocation_id,block_id,request_hash) VALUES (?,?,?,?)')
      .run('different-id', 'run-one:child', 'read', retained.request_hash), /UNIQUE constraint/);
    assert.throws(() => journal.invocation('run-one').prepare('child:read', retained.request_hash, {}, () => ({})), /block identity/);
    journal.invocation('run-one').prepare('write', 'b'.repeat(64), { blockId: 'write' }, () => ({ payload: 'exact pending write' }));
    assert.equal(journal.pendingWrite('urn:flow', 'run-one:child', 'write'), 'run-one');
    assert.equal(journal.pendingWrite('urn:flow', 'run-one', 'write'), null);
    const before = stored(db);
    db.close(); db = new DatabaseSync(file); journal = createDkgCallJournal(db);
    assert.deepEqual(stored(db), before);
    const resumed = journal.invocation('run-one').prepare('write', 'b'.repeat(64), { blockId: 'write' }, () => assert.fail('must reuse prepared evidence'));
    assert.equal(resumed.reconcile, true); assert.deepEqual(resumed.call.prepared, { payload: 'exact pending write' });
    journal.invocation('run-one').complete('write', { verified: true }, { items: ['parent result'] });
    assert.equal(journal.pendingWrite('urn:flow', 'run-one:child', 'write'), null);
    assert.deepEqual(journal.invocation('run-one:child').read('read').response, JSON.parse(retained.response));
    assert.deepEqual({ ...db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(retained.id) },
      { ...retained, invocation_id: 'run-one:child', block_id: 'read' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
for (const id of ['unframed', 'run:', 'run:bad block', ':read', null])
  test(`invalid legacy ownership ${JSON.stringify(id)} rolls back migration without guessing an owner`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      legacy(db); insert(db); insert(db, { ...retained, id }); const before = stored(db);
      assert.throws(() => createDkgCallJournal(db), /invalid legacy DKG call ownership/);
      assert.deepEqual(stored(db), before);
      assert.deepEqual(db.prepare('PRAGMA table_info(dkg_component_calls)').all().map(c => c.name), Object.keys(retained));
    } finally { db.close(); }
  });
test('a conflicting partial ownership migration is retained for reconciliation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db); insert(db);
    db.exec('ALTER TABLE dkg_component_calls ADD COLUMN invocation_id TEXT; ALTER TABLE dkg_component_calls ADD COLUMN block_id TEXT');
    db.prepare('UPDATE dkg_component_calls SET invocation_id=?,block_id=?').run('run-one', 'read');
    const before = stored(db);
    assert.throws(() => createDkgCallJournal(db), /Conflicting or invalid legacy DKG call ownership/);
    assert.deepEqual(stored(db), before);
  } finally { db.close(); }
});
