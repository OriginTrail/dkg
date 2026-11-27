import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { dkgComponentStore } from './test-support/dkg-component-store-fixture.mjs';
import profile, { measurements } from './test-support/measurement-profile.mjs';
import { profileParameters } from './dkg-profile.mjs';

const id = '11223344-1234-4234-8234-123456789abc';
const actor = { id: 'owner', accountId: 'test-account', role: 'owner' };
const input = { itemsJson: '[{}]', paramsJson: '{}', executionId: '' };
const workflow = { kaRef: 'urn:test:legacy', sourceHash: 'a'.repeat(64), definition: { entryId: 'read', edges: [],
  nodes: [{ id: 'read', componentId: 'dkg-read', params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([k, v]) => [k, v.default])) }] } };
const request = { effectId: 'urn:sr:effect:' + id + ':0', workflowId: 'native', executionId: '42', blockId: 'read', items: [{}] };
const cached = { items: measurements };
function legacy(db, { scope = true, owner = true } = {}) {
  db.exec(`CREATE TABLE dkg_component_runs(id TEXT PRIMARY KEY,ka_ref TEXT NOT NULL,source_hash TEXT NOT NULL,input TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE dkg_component_profiles(id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,revision TEXT NOT NULL);
    CREATE TABLE dkg_component_actors(id TEXT PRIMARY KEY,actor TEXT NOT NULL);
    CREATE TABLE dkg_component_calls(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT,response TEXT);
    CREATE TABLE dkg_component_native_executions(id TEXT PRIMARY KEY,effect_id TEXT NOT NULL,workflow_id TEXT NOT NULL,execution_id TEXT NOT NULL);`);
  db.prepare('INSERT INTO dkg_component_runs VALUES (?,?,?,?,?)').run(id, workflow.kaRef, workflow.sourceHash, JSON.stringify(input), Date.now() + 100000);
  if (scope) db.prepare('INSERT INTO dkg_component_profiles VALUES (?,?,?)').run(id, profile.id, profile.revision);
  if (owner) db.prepare('INSERT INTO dkg_component_actors VALUES (?,?)').run(id, JSON.stringify(actor));
  db.prepare('INSERT INTO dkg_component_calls VALUES (?,?,?,?)').run(id + ':read', createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    JSON.stringify({ graph: 'urn:test:measurements', measurements }), JSON.stringify(cached));
  db.prepare('INSERT INTO dkg_component_native_executions VALUES (?,?,?,?)').run(id, request.effectId, 'native', '42');
}
const row = db => ({ ...db.prepare('SELECT * FROM dkg_component_runs WHERE id=?').get(id) });
const noTransport = () => assert.fail('A stored or unscoped invocation must not dispatch again.');

test('migration preserves owner, scope, cached response and expiry renewal across reopen', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-metadata-')), file = join(dir, 'journal.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let db = new DatabaseSync(file); t.after(() => { if (db.isOpen) db.close(); });
  legacy(db); const previous = row(db);
  let authorizations = 0;
  const scoped = { ...profile, requiresNosActor: true, accountId: actor.accountId,
    async authorize(value) { assert.deepEqual(value, actor); authorizations++; } };
  let store = dkgComponentStore(db, noTransport, [], scoped);
  assert.deepEqual(row(db), { ...previous, profile_id: profile.id, profile_revision: profile.revision, actor: JSON.stringify(actor), authority: null });
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('dkg_component_profiles','dkg_component_actors')").all(), []);
  assert.deepEqual(await store.call(request, workflow, 'native'), cached);
  const beforeRenewal = row(db);
  store.grant(workflow, id, input, actor);
  assert.ok(row(db).expires > beforeRenewal.expires);
  assert.deepEqual({ ...row(db), expires: beforeRenewal.expires }, beforeRenewal);
  assert.throws(() => store.grant(workflow, id, input, { ...actor, id: 'another' }), /principal/);
  assert.throws(() => store.grant(workflow, id, { ...input, itemsJson: '[{"changed":true}]' }, actor), /different workflow or inputs/);
  const retained = row(db);
  const other = dkgComponentStore(db, noTransport, [], { ...scoped, id: 'other-profile' });
  assert.throws(() => other.grant(workflow, id, input, actor), /different execution profile/);
  await assert.rejects(other.call(request, workflow, 'native'), /profile mismatch/);
  assert.equal(authorizations, 1, 'profile rejection precedes external owner authorization');
  assert.deepEqual(row(db), retained);
  db.close(); db = new DatabaseSync(file);
  store = dkgComponentStore(db, noTransport, [], scoped);
  assert.deepEqual(row(db), retained);
  assert.deepEqual(await store.call(request, workflow, 'native'), cached);
  assert.equal(authorizations, 2);
});

for (const missing of ['scope', 'owner', 'both']) test(`migration leaves missing ${missing} metadata absent and rejects reuse`, async () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db, { scope: missing === 'owner', owner: missing === 'scope' });
    const store = dkgComponentStore(db, noTransport, [], profile), before = row(db);
    assert.equal(before.profile_id, missing === 'owner' ? profile.id : null);
    assert.equal(before.profile_revision, missing === 'owner' ? profile.revision : null);
    assert.equal(before.actor, missing === 'scope' ? JSON.stringify(actor) : null);
    assert.throws(() => store.grant(workflow, id, input, actor), /legacy/);
    await assert.rejects(store.call(request, workflow, 'native'), /profile mismatch|legacy/);
    dkgComponentStore(db, noTransport, [], profile);
    assert.deepEqual(row(db), before);
  } finally { db.close(); }
});

test('failed metadata migration rolls back its schema and retains the original records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db); const before = row(db);
    db.exec("CREATE TRIGGER prevent_metadata BEFORE UPDATE ON dkg_component_runs BEGIN SELECT RAISE(ABORT,'migration interrupted'); END;");
    assert.throws(() => dkgComponentStore(db, noTransport, [], profile), /migration interrupted/);
    assert.deepEqual(row(db), before);
    assert.equal(db.prepare('SELECT actor FROM dkg_component_actors WHERE id=?').get(id).actor, JSON.stringify(actor));
    assert.equal(db.prepare('SELECT revision FROM dkg_component_profiles WHERE id=?').get(id).revision, profile.revision);
    db.exec('DROP TRIGGER prevent_metadata');
    dkgComponentStore(db, noTransport, [], profile);
    assert.equal(row(db).actor, JSON.stringify(actor));
  } finally { db.close(); }
});

for (const blockId of ['read', 'retired']) test(`legacy ${blockId} calls cannot acquire a replacement native binding`, async () => {
  const db = new DatabaseSync(':memory:');
  try {
    legacy(db);
    db.prepare('UPDATE dkg_component_calls SET id=?,request_hash=?').run(id + ':' + blockId,
      createHash('sha256').update(JSON.stringify({ ...request, blockId })).digest('hex'));
    db.exec('DELETE FROM dkg_component_native_executions');
    for (let reopen = 0; reopen < 2; reopen++) {
      const store = dkgComponentStore(db, noTransport, [], profile);
      const before = db.prepare('SELECT * FROM dkg_component_calls').all();
      await assert.rejects(store.call(request, workflow, 'native'), /lack a verified native execution binding/);
      assert.equal(db.prepare('SELECT 1 FROM dkg_component_native_executions WHERE id=?').get(id), undefined);
      assert.deepEqual(db.prepare('SELECT * FROM dkg_component_calls').all(), before);
    }
  } finally { db.close(); }
});
