import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStudioRepository } from './studio-repository.mjs';

test('migrates legacy executor metadata without changing native grants, revisions or event reservations', () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-migration-'));
  const db = new DatabaseSync(join(state, 'studio.sqlite'));
  db.exec(`CREATE TABLE workflows (ka_ref TEXT PRIMARY KEY,name TEXT NOT NULL,provider_id TEXT,creating INTEGER DEFAULT 0,
    grant_json TEXT,activation_json TEXT,event_key TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE events (provider_id TEXT NOT NULL,execution_id TEXT NOT NULL,ka_ref TEXT NOT NULL,invocation_id TEXT NOT NULL,
    receipt_json TEXT,PRIMARY KEY(provider_id,execution_id));`);
  const native = JSON.stringify({ toolIri: 'urn:dkg:tool:n8n', workflowId: 'native', workflowSha256: 'a'.repeat(64) });
  db.prepare('INSERT INTO workflows (ka_ref,name,grant_json,created_at) VALUES (?,?,?,?)')
    .run('program', 'Program', JSON.stringify({ kind: 'program-workflow-v1', requiresExportAuthorization: true }), 1);
  db.prepare('INSERT INTO workflows (ka_ref,name,provider_id,grant_json,activation_json,event_key,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('native', 'Native', 'native-id', native, '{"active":true,"count":5}', 'retained-key', 2);
  db.prepare('INSERT INTO events (provider_id,execution_id,ka_ref,invocation_id) VALUES (?,?,?,?)').run('native-id', '5', 'native', 'same-invocation');
  db.close();
  try {
    for (let i = 0; i < 2; i++) {
      const repository = createStudioRepository(state);
      try {
        assert.equal(repository.workflow('program').completed, true);
        assert.equal(repository.workflow('program').executor, 'dkg-program');
        assert.equal(repository.workflow('program').requiresExportAuthorization, true);
        assert.equal(repository.nativeRevision('program').grant, null);
        assert.equal(repository.workflow('native').executor, 'native-n8n');
        // Migration preserves the exact stored grant bytes as well as decoded state.
        assert.equal(repository.db.prepare('SELECT grant_json FROM workflows WHERE ka_ref=?').get('native').grant_json, native);
        assert.deepEqual(repository.lifecycle('native').activation, { active: true, count: 5 });
        assert.equal(repository.lifecycle('native').eventKey, 'retained-key');
        assert.equal(repository.lifecycle('native').revision, 0);
        assert.equal(repository.db.prepare('SELECT invocation_id FROM events').get().invocation_id, 'same-invocation');
        assert.equal(repository.list().length, 2);
        assert.throws(() => repository.saved('native', 'dkg-program', false), /executor changed/);
      } finally { repository.close(); }
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('decoded saved state owns completion and sticky export policy while lookups retain historical references', () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-saved-state-'));
  let repository = createStudioRepository(state);
  try {
    assert.equal(repository.workflow('missing'), undefined);
    const compiled = { kaRef: 'native', workflowName: 'Native schedule', mode: 'schedule' };
    const incomplete = repository.ensure(compiled);
    assert.equal(incomplete.completed, false);
    assert.equal(incomplete.requiresExportAuthorization, false);
    repository.nativeCreated(compiled.kaRef, 'provider');
    repository.nativeGranted(compiled.kaRef, { workflowId: 'provider', workflowSha256: 'a'.repeat(64) });
    assert.deepEqual(repository.list(), []);
    repository.completeSave(compiled, 'native-n8n', true, undefined, 'b'.repeat(64));
    const completed = repository.workflow(compiled.kaRef);
    repository.completeSave(compiled, 'native-n8n', false, undefined, 'b'.repeat(64));
    assert.deepEqual(repository.workflow(compiled.kaRef), completed, 'a later save cannot lower persisted export policy');
    assert.equal(incomplete.completed, false, 'previous decoded snapshots must not change');
    assert.equal(completed.completed, true);
    assert.equal(completed.requiresExportAuthorization, true);
    assert.equal(completed.executor, 'native-n8n');
    assert.equal(completed.sourceHash, 'b'.repeat(64));
    assert.throws(() => repository.completeSave({ ...compiled, mode: 'webhook' }, 'native-n8n', false, undefined, 'b'.repeat(64)), /revision changed/);
    assert.throws(() => repository.completeSave(compiled, 'native-n8n', false, undefined, 'c'.repeat(64)), /revision changed/);
    repository.ensure({ kaRef: 'historical', workflowName: 'Earlier Program' });
    repository.saved('historical', 'dkg-program', false);
    repository.close(); repository = createStudioRepository(state);
    assert.deepEqual(repository.workflow(compiled.kaRef), completed);
    assert.equal(repository.nativeWorkflow('provider'), compiled.kaRef);
    assert.equal(repository.nativeWorkflow('unknown'), undefined);
    assert.deepEqual(repository.list().sort(), ['historical', 'native']);
    assert.throws(() => repository.saved(compiled.kaRef, 'dkg-program', false), /executor changed/);
  } finally { repository.close(); rmSync(state, { recursive: true, force: true }); }
});

test('event reservations share one quota across connections and retain identity, inputs and completed receipts', () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-events-'));
  const first = createStudioRepository(state), second = createStudioRepository(state);
  try {
    first.ensure({ kaRef: 'flow', workflowName: 'Event workflow' });
    first.db.prepare('UPDATE workflows SET provider_id=? WHERE ka_ref=?').run('native', 'flow');
    first.setActivation('flow', { active: true, count: 0, expiresAt: Date.now() + 60000 }, 'secret-event-key');
    const request = i => ({ kaRef: 'flow', providerId: 'native', executionId: String(i), invocationId: 'invocation-' + i, inputJson: '[{}]' });
    assert.throws(() => first.reserveEvent(request(0), () => { throw new Error('authority revoked'); }), /revoked/);
    assert.equal(second.pendingEvents('flow').length, 0);
    assert.equal(second.activation('flow').count, 0);
    for (let i = 1; i <= 5; i++) (i % 2 ? first : second).reserveEvent(request(i), () => {});
    assert.equal(first.activation('flow').count, 5);
    assert.throws(() => second.reserveEvent(request(6), () => {}), /limit/);
    assert.equal(first.pendingEvents('flow').length, 5);
    const fifth = second.reserveEvent({ ...request(5), invocationId: 'must-not-replace' }, () => {});
    assert.equal(fifth.invocationId, 'invocation-5');
    assert.throws(() => first.reserveEvent({ ...request(5), inputJson: '[{"changed":true}]' }, () => {}), /different input/);
    assert.throws(() => first.completeEvent({ ...fifth, invocationId: 'foreign' }, { verified: true }), /identity/);
    first.completeEvent(fifth, { verified: true });
    const replay = second.reserveEvent(request(5), () => {});
    assert.deepEqual(replay.receipt, { verified: true });
    assert.throws(() => second.completeEvent(replay, { verified: false }), /receipt changed/);
    assert.throws(() => second.reserveEvent(request(5), () => { throw new Error('authority revoked'); }), /revoked/);
    assert.equal(first.activation('flow').count, 5);
    assert.equal(first.pendingEvents('flow').length, 4);
    assert.equal(second.eventHistory('flow').length, 5);
  } finally { first.close(); second.close(); rmSync(state, { recursive: true, force: true }); }
});


test('activation revisions fence stale commits across connections and survive reopen without changing event quotas', () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-activation-'));
  const first = createStudioRepository(state); let second = createStudioRepository(state);
  try {
    first.ensure({ kaRef: 'flow', workflowName: 'Event workflow' });
    first.db.prepare('UPDATE workflows SET provider_id=? WHERE ka_ref=?').run('native', 'flow');
    assert.equal(first.lifecycle('unknown'), undefined);
    assert.deepEqual(first.lifecycle('flow'), { kaRef: 'flow', providerId: 'native', activation: { active: false },
      executor: null, mode: null, sourceHash: null,
      revision: 0, eventKey: null, pendingUnpublication: null });
    const initial = first.lifecycle('flow').revision;
    first.setActivation('flow', { active: true, activationId: 'first', count: 0, expiresAt: Date.now() + 60000 }, 'first-key', initial);
    const active = first.lifecycle('flow'), revision = active.revision;
    first.reserveEvent({ kaRef: 'flow', providerId: 'native', executionId: '1', invocationId: 'event-1' }, () => {});
    const admitted = { ...active, activation: { ...active.activation, count: 1 } };
    assert.deepEqual(second.lifecycle('flow'), admitted);
    assert.deepEqual(second.eventWorkflow('first-key'), admitted);
    assert.deepEqual(second.activatedWorkflows(), [admitted]);
    assert.equal(active.activation.count, 0);
    second.deactivate('flow', 'revoked', true);
    const revoked = { ...admitted, activation: { active: false, activationId: 'revoked' },
      revision: revision + 1, eventKey: null, pendingUnpublication: 'revoked' };
    assert.deepEqual(first.lifecycle('flow'), revoked);
    assert.equal(first.eventWorkflow('first-key'), undefined);
    assert.equal(first.hasActiveWorkflows(), false);
    assert.throws(() => first.setActivation('flow', { active: true, activationId: 'stale', count: 0 }, 'stale-key', revision), /activation changed/);
    assert.equal(first.deactivate('flow', 'stale-poll', true, revision), false);
    assert.deepEqual(first.lifecycle('flow'), revoked);
    assert.equal(first.pendingEvents('flow').length, 1);
    second.close(); second = createStudioRepository(state);
    assert.deepEqual(second.lifecycle('flow'), revoked);
    assert.deepEqual(second.pendingUnpublications(), [revoked]);
    second.completeUnpublication('flow', 'stale-poll');
    assert.deepEqual(second.pendingUnpublications(), [revoked]);
    second.completeUnpublication('flow', 'revoked');
    assert.deepEqual(first.lifecycle('flow'), { ...revoked, pendingUnpublication: null });
    assert.deepEqual(first.pendingUnpublications(), []);
    second.setActivation('flow', { active: true, activationId: 'new', count: 0 }, 'new-key', revoked.revision);
    assert.equal(first.lifecycle('flow').revision, revoked.revision + 1);
    assert.equal(first.hasActiveWorkflows(), true);
  } finally { first.close(); second.close(); rmSync(state, { recursive: true, force: true }); }
});

test('native provisioning survives reopen and never replaces a create, identity or granted revision', () => {
  const state = mkdtempSync(join(tmpdir(), 'studio-provisioning-'));
  let repository = createStudioRepository(state);
  try {
    repository.ensure({ kaRef: 'flow', workflowName: 'Native workflow' });
    repository.beginNativeCreate('flow');
    repository.close(); repository = createStudioRepository(state);
    assert.equal(repository.nativeRevision('flow').creating, true);
    assert.throws(() => repository.beginNativeCreate('flow'), /unconfirmed/);
    repository.nativeCreated('flow', 'native');
    assert.throws(() => repository.nativeCreated('flow', 'other'), /identity changed/);
    const grant = { workflowId: 'native', workflowSha256: 'a'.repeat(64) };
    repository.nativeGranted('flow', grant);
    repository.saved('flow', 'native-n8n', false);
    repository.close(); repository = createStudioRepository(state);
    assert.deepEqual(repository.nativeRevision('flow'), { providerId: 'native', creating: false, grant });
    repository.nativeGranted('flow', grant);
    assert.throws(() => repository.nativeGranted('flow', { ...grant, workflowSha256: 'b'.repeat(64) }), /grant changed/);
    assert.throws(() => repository.saved('flow', 'dkg-program', false), /executor changed/);
    assert.deepEqual(repository.nativeRevision('flow').grant, grant);
  } finally { repository.close(); rmSync(state, { recursive: true, force: true }); }
});
