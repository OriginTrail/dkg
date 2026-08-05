import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  openSqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import {
  FINALIZATION_INBOX_DATABASE_FILENAME,
} from '../src/finalization-recovery-store.js';
import {
  RAW,
  TX_HASH,
  received,
  temporaryDirectory,
} from './finalization-recovery-sqlite-test-helpers.js';

async function killChildAfterReady(script: string, path: string, label: string): Promise<void> {
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: { ...process.env, DKG_FINALIZATION_INBOX_PATH: path },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolveReady, rejectReady) => {
    let stdout = '';
    const timeout = setTimeout(
      () => rejectReady(new Error(`finalization inbox ${label} child timed out: ${stderr}`)),
      10_000,
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (!stdout.includes('READY\n')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `finalization inbox ${label} child exited early: code=${code} signal=${signal} ${stderr}`,
      ));
    });
  });
  const exit = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL');
  await exit;
}

async function leaveCommittedReceivedInCrashedWal(path: string): Promise<void> {
  const script = String.raw`
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const path = process.env.DKG_FINALIZATION_INBOX_PATH;
const raw = Buffer.from([1, 2, 3, 4]);
const digest = createHash('sha256').update(raw).digest('hex');
const database = new DatabaseSync(path);
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
database.prepare(
  "INSERT INTO finalization_inbox_v1 (key,state,chain_id,context_graph_id,ual,tx_hash,"
  + "assertion_version,merkle_root,ka_id,batch_id,envelope_sha256,raw_envelope,created_at,updated_at)"
  + " VALUES (?,'RECEIVED',?,?,?,?,?,?,?,?,?,?,?,?)"
).run(
  'crash-entry', 'base:84532', 'graph',
  'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
  '${TX_HASH}', '1', '0x${'01'.repeat(32)}', '7', '7', digest, raw, 1, 1
);
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  await killChildAfterReady(script, path, 'crash');
}

async function leaveCommittedV2MigrationInCrashedWal(path: string): Promise<void> {
  const script = String.raw`
const { DatabaseSync } = require('node:sqlite');
const path = process.env.DKG_FINALIZATION_INBOX_PATH;
const database = new DatabaseSync(path);
database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0');
database.exec(
  "BEGIN IMMEDIATE;"
  + "CREATE TABLE finalization_pending_v2 ("
  + "key TEXT PRIMARY KEY NOT NULL,chain_id TEXT NOT NULL,context_graph_id TEXT NOT NULL,"
  + "source_peer_id TEXT,trusted_publisher_peer_id TEXT,ual TEXT NOT NULL,"
  + "tx_hash TEXT NOT NULL,assertion_version TEXT NOT NULL,"
  + "merkle_root TEXT NOT NULL,ka_id TEXT NOT NULL,batch_id TEXT NOT NULL,"
  + "target_context_graph_id TEXT,envelope_sha256 TEXT NOT NULL,raw_envelope BLOB NOT NULL,"
  + "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;"
  + "CREATE INDEX finalization_pending_time_v2 ON finalization_pending_v2(created_at,key);"
  + "CREATE INDEX finalization_pending_graph_v2 ON finalization_pending_v2(context_graph_id,created_at);"
  + "CREATE INDEX finalization_pending_peer_v2 ON finalization_pending_v2(source_peer_id,created_at);"
  + "PRAGMA user_version=2;COMMIT;"
);
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  await killChildAfterReady(script, path, 'migration');
}

async function makeDatabaseV1(databasePath: string): Promise<void> {
  const initial = await openSqliteFinalizationRecoveryStore(dirname(databasePath));
  await initial.receive(received());
  await initial.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP INDEX finalization_pending_peer_v2;
    DROP INDEX finalization_pending_graph_v2;
    DROP INDEX finalization_pending_time_v2;
    DROP TABLE finalization_pending_v2;
    PRAGMA user_version = 1;
  `);
  legacy.close();
}

describe('SQLite finalization recovery migration and crash recovery', () => {
  it('migrates a v1 inbox in place without losing accepted entries', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, FINALIZATION_INBOX_DATABASE_FILENAME);
    try {
      await makeDatabaseV1(databasePath);

      const migrated = await openSqliteFinalizationRecoveryStore(directory);
      expect(await migrated.list()).toMatchObject([{ key: 'entry-1', state: 'RECEIVED' }]);
      const schema = new DatabaseSync(databasePath, { readOnly: true });
      expect(schema.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(schema.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'finalization_pending_v2'",
      ).get()?.name).toBe('finalization_pending_v2');
      schema.close();
      await migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a committed v2 migration when the main header still says v1', async () => {
    const directory = await temporaryDirectory();
    const databasePath = join(directory, FINALIZATION_INBOX_DATABASE_FILENAME);
    try {
      await makeDatabaseV1(databasePath);
      await leaveCommittedV2MigrationInCrashedWal(databasePath);
      expect(existsSync(`${databasePath}-wal`)).toBe(true);
      expect((await readFile(databasePath)).readUInt32BE(60)).toBe(1);

      const recovered = await openSqliteFinalizationRecoveryStore(directory);
      expect(await recovered.list()).toMatchObject([{ key: 'entry-1', state: 'RECEIVED' }]);
      const schema = new DatabaseSync(databasePath, { readOnly: true });
      expect(schema.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
      expect(schema.prepare(
        "SELECT name FROM sqlite_schema WHERE name = 'finalization_pending_v2'",
      ).get()?.name).toBe('finalization_pending_v2');
      schema.close();
      await recovered.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a committed RECEIVED row after a process crash with a hot WAL', async () => {
    const directory = await temporaryDirectory();
    try {
      const initial = await openSqliteFinalizationRecoveryStore(directory);
      const path = initial.databasePath;
      await initial.close();

      await leaveCommittedReceivedInCrashedWal(path);
      expect(existsSync(`${path}-wal`)).toBe(true);

      const recovered = await openSqliteFinalizationRecoveryStore(directory);
      expect(await recovered.list()).toMatchObject([{
        key: 'crash-entry',
        state: 'RECEIVED',
        rawMessage: RAW,
      }]);
      await recovered.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
