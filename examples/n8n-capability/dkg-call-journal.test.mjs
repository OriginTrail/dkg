import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createDkgCallJournal } from './dkg-call-journal.mjs';

const request = '{ "blockId": "write", "items": [{"value":2}] }';
const requestHash = createHash('sha256').update(JSON.stringify(JSON.parse(request))).digest('hex');
const evidence = '{ "payload": {"name":"original","quads":"exact bytes\\n"}, "summary": {"value":2} }';
const receipt = '{ "items": [{"historical":"receipt"}] }';
function legacy(db) {
  db.exec(`CREATE TABLE dkg_component_calls (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, result TEXT);
    CREATE TABLE dkg_component_writes (id TEXT PRIMARY KEY, request TEXT NOT NULL, evidence TEXT NOT NULL, receipt TEXT);`);
}
function seed(db, id, result, response) {
  db.prepare('INSERT INTO dkg_component_calls VALUES (?,?,?)').run(id + ':write', requestHash, result);
  db.prepare('INSERT INTO dkg_component_writes VALUES (?,?,?,?)').run(id + ':write', request, evidence, response);
}
test('legacy pending and completed writes migrate exact bytes and replay after database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-call-migration-')), file = join(dir, 'journal.sqlite');
  let db = new DatabaseSync(file);
  try {
    legacy(db);
    seed(db, 'pending', null, receipt); // A receipt alone is not a committed call.
    seed(db, 'complete', '{ "verified": true }', receipt);
    let journal = createDkgCallJournal(db);
    for (const id of ['pending', 'complete']) {
      const row = db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get(id + ':write');
      assert.equal(row.request, request); assert.equal(row.prepared, evidence);
    }
    assert.equal(journal.invocation('pending').read('write').response, null);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='dkg_component_writes'").get(), undefined);
    db.close(); db = new DatabaseSync(file); journal = createDkgCallJournal(db);
    const pending = journal.invocation('pending').prepare('write', requestHash, JSON.parse(request), () => assert.fail('never rebuild saved evidence'));
    assert.equal(pending.reconcile, true);
    assert.deepEqual(pending.call.prepared, JSON.parse(evidence));
    assert.deepEqual(journal.invocation('complete').read('write').response, JSON.parse(receipt));
    assert.equal(db.prepare('SELECT response FROM dkg_component_calls WHERE id=?').get('complete:write').response, receipt);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('an orphan legacy write rolls back all migrated rows and schema changes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db); seed(db, 'valid', null, null);
    db.prepare('INSERT INTO dkg_component_writes VALUES (?,?,?,NULL)').run('orphan', request, evidence);
    assert.throws(() => createDkgCallJournal(db), /Conflicting legacy/);
    assert.deepEqual(db.prepare('PRAGMA table_info(dkg_component_calls)').all().map(c => c.name), ['id', 'request_hash', 'result']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dkg_component_writes').get().n, 2);
    db.prepare('DELETE FROM dkg_component_writes WHERE id=?').run('orphan');
    assert.deepEqual(createDkgCallJournal(db).invocation('valid').read('write').prepared, JSON.parse(evidence));
  } finally { db.close(); }
});
test('a conflicting partial migration preserves both journals for reconciliation', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db); seed(db, 'conflict', null, null);
    db.exec('ALTER TABLE dkg_component_calls ADD COLUMN prepared TEXT');
    db.prepare('UPDATE dkg_component_calls SET prepared=?').run('{"different":true}');
    assert.throws(() => createDkgCallJournal(db), /Conflicting legacy/);
    assert.equal(db.prepare('SELECT prepared FROM dkg_component_calls').get().prepared, '{"different":true}');
    assert.equal(db.prepare('SELECT evidence FROM dkg_component_writes').get().evidence, evidence);
  } finally { db.close(); }
});
test('failed completion leaves result and response pending together without losing prepared evidence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const journal = createDkgCallJournal(db).invocation('run');
    journal.prepare('write', requestHash, JSON.parse(request), () => JSON.parse(evidence));
    db.exec("CREATE TRIGGER reject_response BEFORE UPDATE OF response ON dkg_component_calls BEGIN SELECT RAISE(ABORT, 'storage failure'); END");
    assert.throws(() => journal.complete('write', { verified: true }, JSON.parse(receipt)), /storage failure/);
    assert.equal(journal.read('write').result, null); assert.equal(journal.read('write').response, null);
    assert.deepEqual(journal.read('write').prepared, JSON.parse(evidence));
    db.exec('DROP TRIGGER reject_response');
    journal.complete('write', { verified: true }, JSON.parse(receipt));
    assert.deepEqual(journal.read('write').response, JSON.parse(receipt));
  } finally { db.close(); }
});
