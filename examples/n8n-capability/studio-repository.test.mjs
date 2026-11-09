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
        assert.equal(repository.row('program').executor, 'dkg-program');
        assert.equal(repository.row('program').requires_export, 1);
        assert.equal(repository.row('program').grant_json, null);
        assert.equal(repository.row('native').executor, 'native-n8n');
        assert.equal(repository.row('native').grant_json, native);
        assert.equal(repository.row('native').activation_json, '{"active":true,"count":5}');
        assert.equal(repository.row('native').event_key, 'retained-key');
        assert.equal(repository.db.prepare('SELECT invocation_id FROM events').get().invocation_id, 'same-invocation');
        assert.equal(repository.list().length, 2);
        assert.throws(() => repository.saved('native', 'dkg-program', false), /executor changed/);
      } finally { repository.close(); }
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});
