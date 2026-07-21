#!/usr/bin/env node
// Read-only local receipt verifier for OT-RFC-65 devnet scenarios. This is not
// an operator API: WAL-020 owns that surface. It lets the local harness prove
// that an HTTP receipt names a real packed WalObject/checkpoint without opening
// a second mutable WalControlStore alongside the daemon.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const requireFromWalPackage = createRequire(new URL('../../packages/wal/package.json', import.meta.url));
const Database = requireFromWalPackage('better-sqlite3');

function fail(message) {
  process.stderr.write(`[wal-control-state] ${message}\n`);
  process.exit(2);
}

const [databaseArg, objectIdArg] = process.argv.slice(2);
if (!databaseArg) fail('usage: wal-control-state.mjs <objects.sqlite> [0x<object-id>]');
const databasePath = resolve(databaseArg);
if (!existsSync(databasePath)) {
  process.stdout.write(`${JSON.stringify({ exists: false, databasePath })}\n`);
  process.exit(0);
}
const normalizedObjectId = objectIdArg?.replace(/^0x/i, '').toUpperCase();
if (normalizedObjectId !== undefined && !/^[0-9A-F]{64}$/.test(normalizedObjectId)) {
  fail('object ID must be exactly 32 hexadecimal bytes');
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  database.pragma('query_only = ON');
  database.pragma('busy_timeout = 5000');
  const scalar = (sql) => Number(database.prepare(sql).pluck().get());
  const state = {
    exists: true,
    databasePath,
    quickCheck: String(database.pragma('quick_check', { simple: true })),
    objects: scalar('SELECT count(*) FROM wal_objects'),
    checkpoints: scalar('SELECT count(*) FROM checkpoints'),
    idempotencyRecords: scalar('SELECT count(*) FROM idempotency'),
    localCommitWork: scalar('SELECT count(*) FROM local_commit_work'),
    packedObjects: scalar('SELECT count(*) FROM objects'),
  };
  if (normalizedObjectId !== undefined) {
    const row = database.prepare(`
      SELECT hex(w.object_id) AS objectId,
             w.origin,
             w.canonical_length AS canonicalLength,
             o.object_length AS packedLength,
             hex(i.checkpoint_id) AS checkpointId,
             i.status AS idempotencyStatus,
             l.state AS localCommitState
      FROM wal_objects w
      JOIN objects o ON o.object_id = w.object_id
      LEFT JOIN idempotency i ON i.object_id = w.object_id
      LEFT JOIN local_commit_work l ON l.object_id = w.object_id
      WHERE hex(w.object_id) = ?
    `).get(normalizedObjectId);
    state.object = row === undefined ? null : {
      objectId: `0x${String(row.objectId).toLowerCase()}`,
      origin: row.origin,
      canonicalLength: row.canonicalLength,
      packedLength: row.packedLength,
      checkpointId: row.checkpointId == null ? null : `0x${String(row.checkpointId).toLowerCase()}`,
      idempotencyStatus: row.idempotencyStatus ?? null,
      localCommitState: row.localCommitState ?? null,
    };
  }
  process.stdout.write(`${JSON.stringify(state)}\n`);
} finally {
  database.close();
}
