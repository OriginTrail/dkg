// SPDX-License-Identifier: Apache-2.0

import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssertionCoordinateV1,
  CanonicalDeterministicUalV1,
  ContextGraphIdV1,
  Digest32V1,
  EvmAddressV1,
  PositiveDecimalU64V1,
  SwmAuthorInventoryScopeV1,
} from '@origintrail-official/dkg-core';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_MIGRATE_V4_TO_V5_SQL,
  INVENTORY_V1_MIGRATE_V5_TO_V6_SQL,
  INVENTORY_V1_USER_OBJECTS,
  INVENTORY_V1_USER_VERSION,
  INVENTORY_V1_V4_USER_OBJECTS,
  INVENTORY_V1_V5_USER_OBJECTS,
  InventoryV1OpenError,
  normalizeInventoryV1SchemaSql,
  openInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';
import {
  digestRfc64FinalizedPrivatePlacementRepairV1,
  encodeRfc64FinalizedPrivatePlacementRepairV1,
} from '../src/rfc64/finalized-private-placement-repair-store-v1.js';
import {
  INVENTORY_SCHEMA_DOWNGRADES_V1,
  INVENTORY_SCHEMA_FIRST_RELEASES_V1,
} from '../src/rfc64/inventory-v1/schema-migrations.js';
import {
  INVENTORY_V1_PRE_MIGRATION_COPY_RESERVE_BYTES,
  listInventoryV1PreMigrationCopies,
} from '../src/rfc64/inventory-v1/pre-migration-copy.js';
import {
  planRfc64InventoryRollbackV1,
  prepareRfc64InventoryForRollbackV1,
  RFC64_INVENTORY_ROLLBACK_FLOOR_USER_VERSION_V1,
  Rfc64InventoryRollbackRefusedErrorV1,
} from '../src/rfc64/inventory-v1/rollback.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    linkSync: vi.fn(actual.linkSync),
    renameSync: vi.fn(actual.renameSync),
    statfsSync: vi.fn(actual.statfsSync),
  };
});

const roots: string[] = [];
const holders: DatabaseSync[] = [];
const foundations: Array<Awaited<ReturnType<typeof openInventoryV1>>> = [];

afterEach(() => {
  for (const mocked of [fs.copyFileSync, fs.linkSync, fs.renameSync, fs.statfsSync]) vi.mocked(mocked).mockClear();
  for (const holder of holders.splice(0)) holder.close();
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const repair = Object.freeze({
  version: 1 as const,
  contextGraphId: 'inventory-rollback' as ContextGraphIdV1,
  authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
  inventoryScope: Object.freeze({
    networkId: 'testnet' as const,
    contextGraphId: 'inventory-rollback' as ContextGraphIdV1,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    authorAddress: `0x${'11'.repeat(20)}` as EvmAddressV1,
    subGraphName: null,
    era: '1' as const,
  }) satisfies SwmAuthorInventoryScopeV1,
  assertionCoordinate: 'asset-1' as AssertionCoordinateV1,
  assertionVersion: '1' as PositiveDecimalU64V1,
  kaUal: `did:dkg:otp:20430/0x${'11'.repeat(20)}/1` as CanonicalDeterministicUalV1,
  sealDigest: `0x${'22'.repeat(32)}` as Digest32V1,
});
const laterRepair = Object.freeze({
  ...repair,
  assertionCoordinate: 'asset-2' as AssertionCoordinateV1,
});
const failure = Object.freeze({
  kind: 'signer_mismatch' as const,
  consecutiveFailures: 3,
  sameKindFailures: 3,
  firstFailedAtMs: 1000,
  lastFailedAtMs: 16000,
  nextAttemptAtMs: null,
  parked: true,
});

function dataDirectory(): string {
  const root = fs.mkdtempSync(join(tmpdir(), 'rfc64-inventory-rollback-'));
  roots.push(root);
  return root;
}

function databasePath(dataDir: string): string {
  return join(dataDir, 'rfc64-sync', 'inventory-v1.sqlite3');
}

function copyPath(dataDir: string, fromVersion: number, toVersion = INVENTORY_V1_USER_VERSION, pending = false): string {
  return join(
    dataDir,
    'rfc64-sync',
    `inventory-v1.schema-v${fromVersion}-to-v${toVersion}.pre-migration${pending ? '.pending' : ''}.sqlite3`,
  );
}

function inventoryEntries(dataDir: string): string[] {
  return fs.readdirSync(join(dataDir, 'rfc64-sync')).sort();
}

function headerUserVersion(path: string): number {
  return fs.readFileSync(path).readUInt32BE(60);
}

function sha256(path: string): string {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

async function open(dataDir: string) {
  const foundation = await openInventoryV1(dataDir);
  foundations.push(foundation);
  return foundation;
}

function close(foundation: Awaited<ReturnType<typeof openInventoryV1>>): void {
  foundations.splice(foundations.indexOf(foundation), 1);
  foundation.close();
}

/** A v6 database holding an owed repair and its failure diagnostic, as 10.0.26 writes it. */
async function writeV6(dataDir: string): Promise<void> {
  const foundation = await open(dataDir);
  foundation.putFinalizedPrivatePlacementRepair(repair);
  foundation.writeFinalizedPrivatePlacementFailures([{ repair, state: failure }]);
  close(foundation);
}

/** Return a database to the v5 schema the way 10.0.25 left it, by hand. */
function lowerByHand(dataDir: string): void {
  const database = new DatabaseSync(databasePath(dataDir));
  database.exec('DROP TABLE rfc64_private_placement_failures_v1; PRAGMA user_version = 5');
  database.close();
}

/** A database 10.0.25 wrote: the exact v5 schema with one owed repair. */
async function writeV5(dataDir: string, repairs = [repair]): Promise<void> {
  const foundation = await open(dataDir);
  for (const owed of repairs) foundation.putFinalizedPrivatePlacementRepair(owed);
  close(foundation);
  lowerByHand(dataDir);
  for (const name of inventoryEntries(dataDir)) {
    if (name.includes('.pre-migration.')) fs.rmSync(join(dataDir, 'rfc64-sync', name));
  }
}

function createRawDatabase(path: string, statements: readonly string[]): void {
  fs.mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec(statements.join(';\n'));
  database.close();
  fs.chmodSync(path, 0o600);
}

/** Make a v6 database whose objects are no longer exactly the v6 schema. */
function addForeignIndex(path: string): void {
  const database = new DatabaseSync(path);
  database.exec('CREATE INDEX rollback_test_extra ON rfc64_private_placement_failures_v1 (state_json)');
  database.close();
}

/** What 10.0.25 checks before it uses an existing inventory: header, exact v5 objects, foreign keys. */
function expectOpensAsV5(path: string): void {
  expect(headerUserVersion(path)).toBe(5);
  expect(fs.readFileSync(path).readUInt32BE(68)).toBe(INVENTORY_V1_APPLICATION_ID);
  expect(fs.existsSync(`${path}-journal`) && fs.existsSync(`${path}-wal`)).toBe(false);
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    expect(database.prepare('PRAGMA application_id').get()).toEqual({ application_id: INVENTORY_V1_APPLICATION_ID });
    expect(database.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    const objects = database.prepare(
      `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>;
    expect(Object.fromEntries(objects.map((object) => [object.name, normalizeInventoryV1SchemaSql(object.sql)])))
      .toEqual(INVENTORY_V1_V5_USER_OBJECTS);
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    database.close();
  }
}

function repairCount(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(database.prepare(
      'SELECT count(*) AS count FROM rfc64_finalized_private_placement_repairs_v1',
    ).get()?.count);
  } finally {
    database.close();
  }
}

const confirmedUal = `did:dkg:otp:20430/0x${'11'.repeat(20)}/7`;
const laterConfirmedUal = `did:dkg:otp:20430/0x${'11'.repeat(20)}/8`;

/**
 * A confirmed catalog placement and its failure diagnostic, as 10.0.27 keeps
 * them: a version 2 repair row, which releases before 10.0.27 refuse to read.
 */
function addConfirmedPlacement(path: string, kaUal = confirmedUal): void {
  const database = new DatabaseSync(path);
  try {
    const digest = createHash('sha256').update(kaUal).digest();
    database.prepare(
      'INSERT INTO rfc64_finalized_private_placement_repairs_v1 (repair_digest, repair_json) VALUES (?, ?)',
    ).run(digest, JSON.stringify({ ...repair, version: 2, inventoryScope: null, kaUal, seal: {} }));
    database.prepare(
      'INSERT INTO rfc64_private_placement_failures_v1 (repair_digest, state_json) VALUES (?, ?)',
    ).run(digest, JSON.stringify(failure));
  } finally {
    database.close();
  }
}

/** The versions of the repair rows and how many failure diagnostics remain. */
function repairVersionsAndFailures(path: string): { versions: number[]; failures: number } {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare(
      'SELECT repair_json FROM rfc64_finalized_private_placement_repairs_v1',
    ).all() as Array<{ repair_json: string }>;
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE name = 'rfc64_private_placement_failures_v1'",
    ).all();
    const failures = tables.length === 0 ? 0 : Number(database.prepare(
      'SELECT count(*) AS count FROM rfc64_private_placement_failures_v1',
    ).get()?.count);
    const versions = rows.map((row) => (JSON.parse(row.repair_json) as { version: number }).version).sort();
    return { versions, failures };
  } finally {
    database.close();
  }
}

/** Commit `sql` and one more owed repair into the log, then kill the writer before it checkpoints. */
async function crashAfterCommitting(path: string, sql: string, owed: typeof repair): Promise<void> {
  const bytes = encodeRfc64FinalizedPrivatePlacementRepairV1(owed);
  const script = String.raw`
const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(process.env.DKG_ROLLBACK_TEST_PATH);
database.exec('PRAGMA wal_autocheckpoint = 0; BEGIN');
database.exec(process.env.DKG_ROLLBACK_TEST_SQL);
database.prepare('INSERT INTO rfc64_finalized_private_placement_repairs_v1 (repair_digest, repair_json) VALUES (?, ?)')
  .run(Buffer.from(process.env.DKG_ROLLBACK_TEST_DIGEST, 'hex'), process.env.DKG_ROLLBACK_TEST_JSON);
database.exec('COMMIT');
process.stdout.write('READY\n');
setInterval(() => {}, 60_000);
`;
  const child = spawn(process.execPath, ['--experimental-sqlite', '-e', script], {
    env: {
      ...process.env,
      DKG_ROLLBACK_TEST_PATH: path,
      DKG_ROLLBACK_TEST_SQL: sql,
      DKG_ROLLBACK_TEST_DIGEST: Buffer.from(digestRfc64FinalizedPrivatePlacementRepairV1(bytes)).toString('hex'),
      DKG_ROLLBACK_TEST_JSON: new TextDecoder().decode(bytes),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const exit = new Promise<NodeJS.Signals | null>((resolveExit) => child.once('exit', (_code, signal) => resolveExit(signal)));
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`writer did not commit: ${stderr}`)), 10_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (!chunk.includes('READY')) return;
      clearTimeout(timeout);
      resolveReady();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`writer exited before committing: code=${code} ${stderr}`));
    });
  });
  child.kill('SIGKILL');
  expect(await exit).toBe('SIGKILL');
}

async function refusalOf(operation: Promise<unknown> | (() => unknown)): Promise<Rfc64InventoryRollbackRefusedErrorV1> {
  try {
    await (typeof operation === 'function' ? operation() : operation);
  } catch (error) {
    expect(error).toBeInstanceOf(Rfc64InventoryRollbackRefusedErrorV1);
    return error as Rfc64InventoryRollbackRefusedErrorV1;
  }
  throw new Error('expected a rollback refusal');
}

describe('RFC-64 inventory pre-migration copy', () => {
  it('keeps one copy of the v5 database before migrating it to v6, and only once', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);

    close(await open(dataDir));

    const copy = copyPath(dataDir, 5);
    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([
      'inventory-v1.schema-v5-to-v6.pre-migration.sqlite3',
    ]);
    expect(headerUserVersion(copy)).toBe(5);
    // A rollback-journal database, which a read-only check leaves as it is.
    expect([...fs.readFileSync(copy).subarray(18, 20)]).toEqual([1, 1]);
    expectOpensAsV5(copy);
    expect(repairCount(copy)).toBe(1);
    if (process.platform !== 'win32') expect(fs.statSync(copy).mode & 0o777).toBe(0o600);
    expect(headerUserVersion(databasePath(dataDir))).toBe(INVENTORY_V1_USER_VERSION);

    const kept = { inode: fs.statSync(copy).ino, digest: sha256(copy) };
    close(await open(dataDir));
    expect({ inode: fs.statSync(copy).ino, digest: sha256(copy) }).toEqual(kept);
  });

  it('replaces the copies of earlier migrations, so each store keeps one', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    close(await open(dataDir));
    const directory = join(dataDir, 'rfc64-sync');
    // A copy from an earlier, finished migration and a torn temporary file.
    fs.writeFileSync(join(directory, 'inventory-v1.schema-v4-to-v5.pre-migration.sqlite3'), 'older copy');
    fs.writeFileSync(join(directory, 'inventory-v1.schema-v5-to-v6.pre-migration.pending.sqlite3.tmp-0123456789abcdef'), 'torn');

    const foundation = await open(dataDir);
    foundation.putFinalizedPrivatePlacementRepair(laterRepair);
    close(foundation);
    lowerByHand(dataDir);
    close(await open(dataDir));

    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([
      'inventory-v1.schema-v5-to-v6.pre-migration.sqlite3',
    ]);
    expect(repairCount(copyPath(dataDir, 5))).toBe(2);
  });

  it('keeps the copy of the release that ran before a migration interrupted between its steps', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), [
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      'PRAGMA journal_mode = WAL',
      ...Object.values(INVENTORY_V1_V4_USER_OBJECTS),
      'PRAGMA user_version = 4',
    ]);
    // An earlier start kept the v4 copy and committed v4 to v5, then stopped.
    const interrupted = new DatabaseSync(databasePath(dataDir));
    interrupted.exec(`VACUUM INTO '${copyPath(dataDir, 4, INVENTORY_V1_USER_VERSION, true).replaceAll("'", "''")}'`);
    interrupted.exec(INVENTORY_V1_MIGRATE_V4_TO_V5_SQL);
    interrupted.close();

    close(await open(dataDir));

    // The migration completed, so its first copy is kept and no longer pending.
    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([
      'inventory-v1.schema-v4-to-v6.pre-migration.sqlite3',
    ]);
    expect(headerUserVersion(copyPath(dataDir, 4))).toBe(4);
    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 4);
    prepared.release();
    expect(prepared).toMatchObject({ outcome: 'restored', fromVersion: INVENTORY_V1_USER_VERSION, toVersion: 4 });
    expect(headerUserVersion(databasePath(dataDir))).toBe(4);
  });

  it('keeps in the copy the rows a crashed writer committed only to the log', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    await crashAfterCommitting(databasePath(dataDir), 'SELECT 1', laterRepair);
    expect(fs.statSync(`${databasePath(dataDir)}-wal`).size).toBeGreaterThan(0);

    close(await open(dataDir));

    expect(repairCount(copyPath(dataDir, 5))).toBe(2);
  });

  it('keeps no copy of a database whose objects are not its version\'s schema', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), [
      'CREATE TABLE wrong_v5 (value TEXT)',
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      'PRAGMA user_version = 5',
    ]);

    await expect(open(dataDir)).rejects.toBeInstanceOf(InventoryV1OpenError);

    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([]);
  });

  it('keeps no copy of a fresh or current database', async () => {
    const dataDir = dataDirectory();
    close(await open(dataDir));
    close(await open(dataDir));

    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([]);
  });

  it('refuses to migrate, leaving the v5 database as it was, when the volume lacks room for the copy', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    const before = inventoryEntries(dataDir);
    const actual = fs.statfsSync(dataDir);
    vi.mocked(fs.statfsSync).mockReturnValueOnce({ ...actual, bavail: 1, bsize: 4096 });

    await expect(open(dataDir)).rejects.toSatisfy((error: unknown) =>
      error instanceof InventoryV1OpenError
      && error.code === 'database-io'
      && /not enough free disk space to keep inventory-v1\.schema-v5-to-v6\.pre-migration\.pending\.sqlite3/.test(error.message));

    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([]);
    expect(inventoryEntries(dataDir).filter((name) => !before.includes(name))).toEqual([]);
  });

  it('drops the copy of an attempt that stopped before its first step before checking room for a new one', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    // An earlier start published its pending copy and stopped before migrating.
    const earlier = new DatabaseSync(databasePath(dataDir));
    earlier.exec(`VACUUM INTO '${copyPath(dataDir, 5, INVENTORY_V1_USER_VERSION, true).replaceAll("'", "''")}'`);
    earlier.close();
    const volume = fs.statfsSync(dataDir);
    let copiesAtCheck: string[] | undefined;
    vi.mocked(fs.statfsSync).mockImplementationOnce(() => {
      copiesAtCheck = inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'));
      return volume;
    });

    close(await open(dataDir));

    expect(copiesAtCheck).toEqual([]);
    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([
      'inventory-v1.schema-v5-to-v6.pre-migration.sqlite3',
    ]);
  });

  it('counts the write-ahead log in the room a copy needs', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    await crashAfterCommitting(databasePath(dataDir), 'SELECT 1', laterRepair);
    const walBytes = fs.statSync(`${databasePath(dataDir)}-wal`).size;
    const volume = fs.statfsSync(dataDir);
    // Room for the main file, the log once and the reserve, but not for the log a second time.
    const freeBytes = fs.statSync(databasePath(dataDir)).size + walBytes + INVENTORY_V1_PRE_MIGRATION_COPY_RESERVE_BYTES;
    vi.mocked(fs.statfsSync).mockReturnValueOnce({ ...volume, bavail: Math.floor(freeBytes / volume.bsize) });

    await expect(open(dataDir)).rejects.toSatisfy((error: unknown) =>
      error instanceof InventoryV1OpenError && /not enough free disk space/.test(error.message));
    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
  });

  it('removes a torn copy and keeps the database at v5 when writing the copy fails', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (String(source).includes('.tmp-')) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      renameSync(source, destination);
    });

    await expect(open(dataDir)).rejects.toSatisfy((error: unknown) =>
      error instanceof InventoryV1OpenError
      && /failed to keep inventory-v1\.schema-v5-to-v6\.pre-migration\.pending\.sqlite3/.test(error.message));
    vi.mocked(fs.renameSync).mockImplementation(renameSync);

    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([]);
  });

  it('keeps a fresh copy for an upgrade after a rollback, with the rows written in between', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), [
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      'PRAGMA journal_mode = WAL',
      ...Object.values(INVENTORY_V1_V4_USER_OBJECTS),
      'PRAGMA user_version = 4',
    ]);
    close(await open(dataDir));
    (await prepareRfc64InventoryForRollbackV1(dataDir, 5)).release();
    // The older release writes a row while the database is at v5.
    const bytes = encodeRfc64FinalizedPrivatePlacementRepairV1(repair);
    const older = new DatabaseSync(databasePath(dataDir));
    older.prepare('INSERT INTO rfc64_finalized_private_placement_repairs_v1 (repair_digest, repair_json) VALUES (?, ?)')
      .run(digestRfc64FinalizedPrivatePlacementRepairV1(bytes), new TextDecoder().decode(bytes));
    older.close();

    close(await open(dataDir));

    expect(inventoryEntries(dataDir).filter((name) => name.includes('.pre-migration.'))).toEqual([
      'inventory-v1.schema-v5-to-v6.pre-migration.sqlite3',
    ]);
    expect(repairCount(copyPath(dataDir, 5))).toBe(1);
  });

  it('lists only the copies of the database it names, whatever characters its file name holds', () => {
    const store = join(dataDirectory(), 'rfc64-sync');
    fs.mkdirSync(store, { recursive: true });
    // As a pattern, `inventory+v1` would match `inventoryyv1` and not itself.
    fs.writeFileSync(join(store, 'inventory+v1.schema-v5-to-v6.pre-migration.sqlite3'), '');
    fs.writeFileSync(join(store, 'inventoryyv1.schema-v5-to-v6.pre-migration.sqlite3'), '');

    expect(listInventoryV1PreMigrationCopies(join(store, 'inventory+v1.sqlite3'))).toEqual([{
      path: join(store, 'inventory+v1.schema-v5-to-v6.pre-migration.sqlite3'),
      fromVersion: 5,
      toVersion: 6,
      pending: false,
    }]);
  });
});

describe('RFC-64 inventory rollback', () => {
  it('lowers an exact v6 database to v5, keeping every row the older release reads', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    expect(planRfc64InventoryRollbackV1(dataDir, 5)).toMatchObject({ action: 'downgrade', userVersion: 6 });

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'downgraded', fromVersion: 6, toVersion: 5, keptPath: null });
    // The log was folded into the main file and removed; the read-only checks below recreate it.
    expect(inventoryEntries(dataDir)).toEqual(['inventory-v1.lease.sqlite3', 'inventory-v1.sqlite3']);
    expectOpensAsV5(databasePath(dataDir));
    expect(repairCount(databasePath(dataDir))).toBe(1);

    // Going forward again migrates the lowered database and keeps the repair.
    const upgraded = await open(dataDir);
    expect(upgraded.listFinalizedPrivatePlacementRepairs()).toEqual([repair]);
    expect(upgraded.readFinalizedPrivatePlacementFailure(repair)).toBeNull();
    close(upgraded);
    expect(fs.existsSync(copyPath(dataDir, 5))).toBe(true);
  });

  it('removes the confirmed catalog placements a release before 10.0.27 cannot read, keeping every other row', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addConfirmedPlacement(databasePath(dataDir));
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1, 2], failures: 2 });

    const prepared = await prepareRfc64InventoryForRollbackV1(
      dataDir, INVENTORY_V1_USER_VERSION, { removeConfirmedCatalogPlacements: true },
    );
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'compatible', removedConfirmedCatalogPlacements: [confirmedUal] });
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1], failures: 1 });
    expect(headerUserVersion(databasePath(dataDir))).toBe(INVENTORY_V1_USER_VERSION);
    const reopened = await open(dataDir);
    expect(reopened.listFinalizedPrivatePlacementRepairs()).toEqual([repair]);
    close(reopened);
  });

  it('removes them after lowering the schema for a release that opens v5', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addConfirmedPlacement(databasePath(dataDir));

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5, { removeConfirmedCatalogPlacements: true });
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'downgraded', toVersion: 5, removedConfirmedCatalogPlacements: [confirmedUal] });
    expectOpensAsV5(databasePath(dataDir));
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1], failures: 0 });
  });

  it('keeps the confirmed catalog placements for a release that reads them', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addConfirmedPlacement(databasePath(dataDir));

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, INVENTORY_V1_USER_VERSION);
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'compatible', removedConfirmedCatalogPlacements: [] });
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1, 2], failures: 2 });
  });

  it('removes no placement when a later deletion fails, and removes them all on the next attempt', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addConfirmedPlacement(databasePath(dataDir));
    addConfirmedPlacement(databasePath(dataDir), laterConfirmedUal);
    // The second of the two deletions fails, as an I/O error there would stop it.
    const injector = new DatabaseSync(databasePath(dataDir));
    injector.exec(`CREATE TRIGGER rollback_test_second_deletion
      BEFORE DELETE ON rfc64_finalized_private_placement_repairs_v1
      WHEN (SELECT count(*) FROM rfc64_finalized_private_placement_repairs_v1) < 3
      BEGIN SELECT RAISE(ABORT, 'the second deletion failed'); END`);
    injector.close();
    const prepareFor10026 = () => prepareRfc64InventoryForRollbackV1(
      dataDir, INVENTORY_V1_USER_VERSION, { removeConfirmedCatalogPlacements: true },
    );

    await expect(prepareFor10026()).rejects.toSatisfy((error: unknown) =>
      error instanceof Error && !(error instanceof Rfc64InventoryRollbackRefusedErrorV1)
      && error.message.includes('the second deletion failed'));
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1, 2, 2], failures: 3 });

    const repaired = new DatabaseSync(databasePath(dataDir));
    repaired.exec('DROP TRIGGER rollback_test_second_deletion');
    repaired.close();
    // The lease was released, so the next attempt runs.
    const prepared = await prepareFor10026();
    prepared.release();
    expect([...prepared.removedConfirmedCatalogPlacements].sort()).toEqual([confirmedUal, laterConfirmedUal]);
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1], failures: 1 });
  });

  it('keeps the placements and the v6 schema when lowering fails after their removal', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addConfirmedPlacement(databasePath(dataDir));
    const downMigration = INVENTORY_SCHEMA_DOWNGRADES_V1[0]!.sql;
    const { exec } = DatabaseSync.prototype;
    const failing = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) {
      if (sql === downMigration) throw new Error('disk I/O error');
      return exec.call(this, sql);
    });

    try {
      await expect(prepareRfc64InventoryForRollbackV1(dataDir, 5, { removeConfirmedCatalogPlacements: true }))
        .rejects.toThrow('disk I/O error');
    } finally {
      failing.mockRestore();
    }

    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
    expect(repairVersionsAndFailures(databasePath(dataDir))).toEqual({ versions: [1, 2], failures: 2 });
  });

  it('leaves a repair row it cannot parse as it is', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    const database = new DatabaseSync(databasePath(dataDir));
    database.prepare(
      'INSERT INTO rfc64_finalized_private_placement_repairs_v1 (repair_digest, repair_json) VALUES (?, ?)',
    ).run(new Uint8Array(32).fill(0x55), 'not a repair');
    database.close();

    const prepared = await prepareRfc64InventoryForRollbackV1(
      dataDir, INVENTORY_V1_USER_VERSION, { removeConfirmedCatalogPlacements: true },
    );
    prepared.release();

    expect(prepared.removedConfirmedCatalogPlacements).toEqual([]);
    expect(repairCount(databasePath(dataDir))).toBe(2);
  });

  it('holds the inventory lease until it is released, so no node can migrate the database forward', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    await expect(openInventoryV1(dataDir)).rejects.toSatisfy((error: unknown) =>
      error instanceof InventoryV1OpenError && error.code === 'database-busy');
    expect(headerUserVersion(databasePath(dataDir))).toBe(5);

    prepared.release();
    prepared.release();
    close(await open(dataDir));
  });

  it('refuses, changing nothing, while a running node holds the inventory', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    await open(dataDir);

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal).toMatchObject({ reason: 'in-use', databasePath: databasePath(dataDir), maxUserVersion: 5 });
    expect(refusal.message).toContain('is in use by another process');
    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
  });

  it('refuses, changing nothing, while another process writes the database', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    const writer = new DatabaseSync(databasePath(dataDir));
    holders.push(writer);
    writer.exec('BEGIN IMMEDIATE');

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal.reason).toBe('in-use');
    writer.exec('ROLLBACK');
    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
    expect(repairCount(databasePath(dataDir))).toBe(1);
  });

  it('restores the pre-migration copy when the v6 schema is not exact, keeping the replaced file', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    const foundation = await open(dataDir);
    foundation.putFinalizedPrivatePlacementRepair(laterRepair);
    close(foundation);
    addForeignIndex(databasePath(dataDir));
    expect(planRfc64InventoryRollbackV1(dataDir, 5).action).toBe('downgrade');

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();

    const kept = join(dataDir, 'rfc64-sync', 'inventory-v1.schema-v6.before-rollback.sqlite3');
    expect(prepared).toMatchObject({ outcome: 'restored', fromVersion: 6, toVersion: 5, keptPath: kept });
    expectOpensAsV5(databasePath(dataDir));
    // Rows written after the migration live only in the kept file.
    expect(repairCount(databasePath(dataDir))).toBe(1);
    expect(repairCount(kept)).toBe(2);
    expect(fs.existsSync(copyPath(dataDir, 5))).toBe(false);
  });

  it('keeps the live database in place when a restore stops part-way, and finishes on the next attempt', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    close(await open(dataDir));
    addForeignIndex(databasePath(dataDir));
    const before = sha256(databasePath(dataDir));
    const { renameSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
    // The step that puts the copy in place fails, as a crash there would stop it.
    vi.mocked(fs.renameSync).mockImplementation((source, destination) => {
      if (source === copyPath(dataDir, 5)) throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      renameSync(source, destination);
    });

    await expect(prepareRfc64InventoryForRollbackV1(dataDir, 5)).rejects.toSatisfy((error: unknown) =>
      error instanceof Error && !(error instanceof Rfc64InventoryRollbackRefusedErrorV1)
      && error.message === 'EIO: i/o error, rename');
    vi.mocked(fs.renameSync).mockImplementation(renameSync);

    expect(sha256(databasePath(dataDir))).toBe(before);
    expect(headerUserVersion(copyPath(dataDir, 5))).toBe(5);
    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();
    expect(prepared.outcome).toBe('restored');
    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
    expect(sha256(prepared.keptPath!)).toBe(before);
  });

  it('keeps a full copy of the replaced database on a volume without hard links', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    close(await open(dataDir));
    addForeignIndex(databasePath(dataDir));
    const before = sha256(databasePath(dataDir));
    vi.mocked(fs.linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' });
    });
    vi.mocked(fs.copyFileSync).mockClear();

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();

    expect(prepared.outcome).toBe('restored');
    expect(fs.copyFileSync).toHaveBeenCalledTimes(1);
    expect(sha256(prepared.keptPath!)).toBe(before);
    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
  });

  it('lowers a schema change that a crashed writer left in the log, keeping the rows it committed', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    await crashAfterCommitting(databasePath(dataDir), INVENTORY_V1_MIGRATE_V5_TO_V6_SQL, laterRepair);
    // The file header still reads v5; only the log holds v6 and the second repair.
    expect(headerUserVersion(databasePath(dataDir))).toBe(5);
    expect(fs.statSync(`${databasePath(dataDir)}-wal`).size).toBeGreaterThan(0);

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'downgraded', fromVersion: 6, toVersion: 5 });
    expectOpensAsV5(databasePath(dataDir));
    expect(repairCount(databasePath(dataDir))).toBe(2);
  });

  it('refuses a damaged copy whose header is intact, leaving the database and the copy in place', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    close(await open(dataDir));
    addForeignIndex(databasePath(dataDir));
    fs.truncateSync(copyPath(dataDir, 5), 100);
    const before = sha256(databasePath(dataDir));
    expect(planRfc64InventoryRollbackV1(dataDir, 5).action).toBe('downgrade');

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal.reason).toBe('unrecognized-schema');
    expect(sha256(databasePath(dataDir))).toBe(before);
    expect(fs.statSync(copyPath(dataDir, 5)).size).toBe(100);
  });

  it('refuses a retry while another connection keeps the lowered log out of the database file', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    const reader = new DatabaseSync(databasePath(dataDir));
    holders.push(reader);
    reader.prepare('SELECT count(*) AS count FROM sqlite_schema').get();

    // The down-migration commits, but its log cannot reach the file while the reader stays open.
    await expect(prepareRfc64InventoryForRollbackV1(dataDir, 5)).rejects.toThrow(
      'was lowered to schema v5, but finishing that failed: its file header was not updated');
    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
    expect((await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5))).reason).toBe('in-use');
    holders.splice(holders.indexOf(reader), 1);
    reader.close();

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 5);
    prepared.release();
    expect(prepared).toMatchObject({ outcome: 'compatible', fromVersion: 5 });
    expectOpensAsV5(databasePath(dataDir));
  });

  it('restores a copy for a target older than the down-migrations reach', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), [
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      'PRAGMA journal_mode = WAL',
      ...Object.values(INVENTORY_V1_V4_USER_OBJECTS),
      'PRAGMA user_version = 4',
    ]);
    close(await open(dataDir));
    expect(planRfc64InventoryRollbackV1(dataDir, 4).action).toBe('restore');

    const prepared = await prepareRfc64InventoryForRollbackV1(dataDir, 4);
    prepared.release();

    expect(prepared).toMatchObject({ outcome: 'restored', fromVersion: 6, toVersion: 4 });
    expect(headerUserVersion(databasePath(dataDir))).toBe(4);
  });

  it('refuses, naming the store, its schema and the target, when neither a down-migration nor a copy fits', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    addForeignIndex(databasePath(dataDir));
    const before = sha256(databasePath(dataDir));

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal).toMatchObject({ reason: 'unrecognized-schema', userVersion: 6, maxUserVersion: 5 });
    expect(refusal.message).toBe(
      `RFC-64 inventory database ${databasePath(dataDir)} has schema v6; no exact down-migration and no `
        + 'restorable pre-migration copy brings it to schema v5 or older',
    );
    expect(sha256(databasePath(dataDir))).toBe(before);
    // The lease was released: a second attempt reaches the same answer.
    expect((await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5))).reason).toBe('unrecognized-schema');
  });

  it('refuses a schema this build does not know before anything stops', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), [
      'CREATE TABLE future_schema (value TEXT)',
      `PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}`,
      `PRAGMA user_version = ${INVENTORY_V1_USER_VERSION + 1}`,
    ]);

    const planned = await refusalOf(() => planRfc64InventoryRollbackV1(dataDir, 5));
    const prepared = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    for (const refusal of [planned, prepared]) {
      expect(refusal).toMatchObject({ reason: 'unrecognized-schema', userVersion: INVENTORY_V1_USER_VERSION + 1 });
    }
  });

  it('refuses a file without a readable inventory identity', async () => {
    const dataDir = dataDirectory();
    createRawDatabase(databasePath(dataDir), ['CREATE TABLE foreign_table (value TEXT)', 'PRAGMA application_id = 7']);

    const planned = await refusalOf(() => planRfc64InventoryRollbackV1(dataDir, 5));
    const prepared = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    for (const refusal of [planned, prepared]) {
      expect(refusal).toMatchObject({ reason: 'unrecognized-schema', userVersion: null });
      expect(refusal.message).toContain('has no readable inventory schema');
    }
  });

  it('refuses a restore while another process keeps the database log open', async () => {
    const dataDir = dataDirectory();
    await writeV5(dataDir);
    close(await open(dataDir));
    addForeignIndex(databasePath(dataDir));
    const reader = new DatabaseSync(databasePath(dataDir));
    holders.push(reader);
    reader.prepare('SELECT count(*) AS count FROM sqlite_schema').get();

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal.reason).toBe('unsafe-database');
    expect(refusal.message).toContain('still has SQLite sidecar files');
    expect(fs.existsSync(copyPath(dataDir, 5))).toBe(true);
    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
  });

  it('refuses while an interrupted rebuild is pending', async () => {
    const dataDir = dataDirectory();
    await writeV6(dataDir);
    fs.writeFileSync(`${databasePath(dataDir)}.rebuild-required`, '{}');

    const refusal = await refusalOf(prepareRfc64InventoryForRollbackV1(dataDir, 5));

    expect(refusal.reason).toBe('pending-rebuild');
    expect(headerUserVersion(databasePath(dataDir))).toBe(6);
  });

  it('leaves a database the target opens, or a node without one, as it is', async () => {
    const empty = dataDirectory();
    expect(planRfc64InventoryRollbackV1(empty, 5).action).toBe('none');
    expect((await prepareRfc64InventoryForRollbackV1(empty, 5)).outcome).toBe('absent');
    fs.mkdirSync(join(empty, 'rfc64-sync'), { mode: 0o700 });
    const leased = await prepareRfc64InventoryForRollbackV1(empty, 5);
    expect(leased.outcome).toBe('absent');
    leased.release();

    const current = dataDirectory();
    await writeV6(current);
    for (const maxUserVersion of [0, INVENTORY_V1_USER_VERSION]) {
      expect(planRfc64InventoryRollbackV1(current, maxUserVersion).action).toBe('none');
      const prepared = await prepareRfc64InventoryForRollbackV1(current, maxUserVersion);
      prepared.release();
      expect(prepared.outcome).toBe('compatible');
    }

    const older = dataDirectory();
    await writeV5(older);
    const prepared = await prepareRfc64InventoryForRollbackV1(older, 5);
    prepared.release();
    expect(prepared).toMatchObject({ outcome: 'compatible', fromVersion: 5, toVersion: 5 });
    expect(headerUserVersion(databasePath(current))).toBe(INVENTORY_V1_USER_VERSION);
  });

  it('lowers to v5 at most without losing a row', () => {
    expect(RFC64_INVENTORY_ROLLBACK_FLOOR_USER_VERSION_V1).toBe(5);
  });

  it('lists a release for the current schema and drops only additions in each down-migration', () => {
    expect(INVENTORY_SCHEMA_FIRST_RELEASES_V1.at(-1)?.userVersion).toBe(INVENTORY_V1_USER_VERSION);
    expect(INVENTORY_SCHEMA_DOWNGRADES_V1[0]?.fromObjects).toBe(INVENTORY_V1_USER_OBJECTS);
    for (const step of INVENTORY_SCHEMA_DOWNGRADES_V1) {
      const dropped = Object.keys(step.fromObjects).filter((name) => !(name in step.toObjects));
      expect(dropped.length).toBeGreaterThan(0);
      for (const [name, sql] of Object.entries(step.toObjects)) expect(step.fromObjects[name]).toBe(sql);
    }
  });
});
