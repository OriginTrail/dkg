import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DDL,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_OBJECTS,
  InventoryV1OpenError,
  normalizeInventoryV1SchemaSql,
  openInventoryV1,
} from '../src/rfc64/inventory-v1/index.js';

const temporaryDirectories: string[] = [];

function temporaryDataDirectory(): string {
  // macOS exposes /var as a symlink to /private/var. Use the canonical test
  // root so the production component-wise no-symlink rule is exercised only
  // by symlinks intentionally created by each test.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-sql1-')));
  temporaryDirectories.push(directory);
  return directory;
}

function databasePath(dataDirectory: string): string {
  return join(dataDirectory, INVENTORY_V1_RELATIVE_PATH);
}

function pragmaInteger(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get();
  if (row === undefined) throw new Error(`missing PRAGMA ${pragma}`);
  const value = Object.values(row)[0];
  if (typeof value !== 'number') throw new Error(`invalid PRAGMA ${pragma}`);
  return value;
}

function expectOpenErrorCode(error: unknown, code: InventoryV1OpenError['code']): boolean {
  expect(error).toBeInstanceOf(InventoryV1OpenError);
  expect((error as InventoryV1OpenError).code).toBe(code);
  return true;
}

function expectNoQuarantine(path: string): void {
  expect(existsSync(`${path}.rebuild-required`)).toBe(false);
  expect(existsSync(join(dirname(path), 'quarantine'))).toBe(false);
}

function quarantineGenerations(path: string): string[] {
  const root = join(dirname(path), 'quarantine');
  if (!existsSync(root)) return [];
  return readdirSync(root).map((name) => join(root, name));
}

function assertInitializedInventory(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    expect(pragmaInteger(database, 'application_id')).toBe(INVENTORY_V1_APPLICATION_ID);
    expect(pragmaInteger(database, 'user_version')).toBe(1);
    const rows = database.prepare(
      `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all();
    expect(rows).toHaveLength(Object.keys(INVENTORY_V1_USER_OBJECTS).length);
    for (const row of rows) {
      expect(typeof row.name).toBe('string');
      expect(typeof row.sql).toBe('string');
      expect(normalizeInventoryV1SchemaSql(String(row.sql))).toBe(
        INVENTORY_V1_USER_OBJECTS[String(row.name)],
      );
    }
    expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 inventory v1 SQLite lifecycle', () => {
  it('initializes the exact owned schema, identity, WAL mode, and private POSIX paths', async () => {
    const dataDirectory = temporaryDataDirectory();
    const foundation = await openInventoryV1(dataDirectory);
    const path = databasePath(dataDirectory);

    expect(foundation.databasePath).toBe(path);
    expect(foundation.closed).toBe(false);
    assertInitializedInventory(path);
    if (process.platform !== 'win32') {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }

    foundation.close();
    foundation.close();
    expect(foundation.closed).toBe(true);
    if (process.platform !== 'win32') chmodSync(path, 0o666);

    const reopened = await openInventoryV1(dataDirectory);
    assertInitializedInventory(path);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    reopened.close();
    try {
      reopened.quarantineAndRebuild();
      expect.unreachable('closed foundation unexpectedly rebuilt');
    } catch (error) {
      expectOpenErrorCode(error, 'database-closed');
    }
  });

  it('initializes beneath a previously nonexistent declared dataDir suffix', async () => {
    const container = temporaryDataDirectory();
    const dataDirectory = join(container, 'new-data', 'nested');
    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(databasePath(dataDirectory));
    } finally {
      foundation.close();
    }
  });

  it('executes the frozen DDL as STRICT tables with the named bucket index', () => {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      database.exec(INVENTORY_V1_DDL);
      const objects = database.prepare(
        `SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all();
      expect(objects).toHaveLength(3);
      for (const object of objects) {
        expect(normalizeInventoryV1SchemaSql(String(object.sql))).toBe(
          INVENTORY_V1_USER_OBJECTS[String(object.name)],
        );
      }
      expect(database.prepare(
        `SELECT strict FROM pragma_table_list WHERE name = 'rfc64_candidate_bucket_loads_v1'`,
      ).get()?.strict).toBe(1);
      expect(database.prepare(
        `SELECT strict FROM pragma_table_list WHERE name = 'rfc64_candidate_bucket_rows_v1'`,
      ).get()?.strict).toBe(1);
    } finally {
      database.close();
    }
  });

  it('refuses a valid foreign application_id without modifying or quarantining it', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE foreign_data (value TEXT); PRAGMA application_id = 305419896;');
    foreign.close();
    if (process.platform !== 'win32') chmodSync(path, 0o640);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'foreign-database'));

    expect(readFileSync(path)).toEqual(before);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640);
    expectNoQuarantine(path);
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare(
      `SELECT count(*) AS count FROM sqlite_schema WHERE name = 'foreign_data'`,
    ).get()?.count).toBe(1);
    check.close();
  });

  it('refuses an application_id=0 database with user objects as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const ambiguous = new DatabaseSync(path);
    ambiguous.exec('CREATE TABLE existing_data (value TEXT)');
    ambiguous.close();
    if (process.platform !== 'win32') chmodSync(path, 0o640);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o640);
    expectNoQuarantine(path);
  });

  it('refuses an uncommitted DK64 user_version=0 database as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const partial = new DatabaseSync(path);
    partial.exec(`
      CREATE TABLE partial_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
    `);
    partial.close();
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a newer owned user_version without quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const newer = new DatabaseSync(path);
    newer.exec(`
      CREATE TABLE future_schema (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 2;
    `);
    newer.close();

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'newer-schema'));
    expectNoQuarantine(path);
  });

  it('quarantines an incompatible owned v1 schema and rebuilds exact v1', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const incompatible = new DatabaseSync(path);
    incompatible.exec(`
      CREATE TABLE wrong_v1 (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    incompatible.close();

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      const generations = quarantineGenerations(path);
      expect(generations).toHaveLength(1);
      const oldPath = join(generations[0]!, 'inventory-v1.sqlite3');
      const old = new DatabaseSync(oldPath, { readOnly: true });
      expect(old.prepare(
        `SELECT count(*) AS count FROM sqlite_schema WHERE name = 'wrong_v1'`,
      ).get()?.count).toBe(1);
      old.close();
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('refuses NOTADB bytes without manufacturing DK64 ownership or quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const corruptBytes = Buffer.from('not-a-sqlite-database\n');
    writeFileSync(path, corruptBytes);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(corruptBytes);
    expectNoQuarantine(path);
  });

  it('refuses a corrupt application_id=0 database with user data as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const ambiguous = new DatabaseSync(path);
    ambiguous.exec('CREATE TABLE existing_data (value TEXT)');
    ambiguous.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a corrupt owned database with a newer header user_version', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const newer = new DatabaseSync(path);
    newer.exec(`
      CREATE TABLE future_schema (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 2;
    `);
    newer.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'newer-schema'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('refuses a corrupt uncommitted DK64 user_version=0 database as ambiguous', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const partial = new DatabaseSync(path);
    partial.exec(`
      CREATE TABLE partial_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
    `);
    partial.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it('does not quarantine a corrupt SQLite file whose readable header has a foreign app id', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const foreign = new DatabaseSync(path);
    foreign.exec('CREATE TABLE foreign_data (value TEXT); PRAGMA application_id = 305419896;');
    foreign.close();
    truncateSync(path, 100);
    const before = readFileSync(path);

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'foreign-database'));
    expect(readFileSync(path)).toEqual(before);
    expectNoQuarantine(path);
  });

  it.runIf(process.platform !== 'win32')(
    'refuses database, sidecar, recovery-marker, and parent symlinks without quarantine',
    async () => {
      const databaseLinkData = temporaryDataDirectory();
      const databaseLinkPath = databasePath(databaseLinkData);
      mkdirSync(dirname(databaseLinkPath), { recursive: true });
      const databaseTarget = join(databaseLinkData, 'target.sqlite3');
      writeFileSync(databaseTarget, 'target');
      symlinkSync(databaseTarget, databaseLinkPath);
      await expect(openInventoryV1(databaseLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readFileSync(databaseTarget, 'utf8')).toBe('target');
      expectNoQuarantine(databaseLinkPath);

      const danglingData = temporaryDataDirectory();
      const danglingPath = databasePath(danglingData);
      mkdirSync(dirname(danglingPath), { recursive: true });
      symlinkSync(join(danglingData, 'missing-target'), danglingPath);
      await expect(openInventoryV1(danglingData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));

      const sidecarData = temporaryDataDirectory();
      const sidecarPath = databasePath(sidecarData);
      mkdirSync(dirname(sidecarPath), { recursive: true });
      const database = new DatabaseSync(sidecarPath);
      database.close();
      const sidecarTarget = join(sidecarData, 'sidecar-target');
      writeFileSync(sidecarTarget, 'sidecar');
      symlinkSync(sidecarTarget, `${sidecarPath}-wal`);
      await expect(openInventoryV1(sidecarData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expectNoQuarantine(sidecarPath);

      const directoryLinkData = temporaryDataDirectory();
      const directoryTarget = join(directoryLinkData, 'target-directory');
      mkdirSync(directoryTarget);
      symlinkSync(directoryTarget, join(directoryLinkData, 'rfc64-sync'));
      await expect(openInventoryV1(directoryLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readdirSync(directoryTarget)).toEqual([]);

      const markerLinkData = temporaryDataDirectory();
      const markerLinkPath = databasePath(markerLinkData);
      mkdirSync(dirname(markerLinkPath), { recursive: true });
      symlinkSync(join(markerLinkData, 'missing-marker'), `${markerLinkPath}.rebuild-required`);
      await expect(openInventoryV1(markerLinkData)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a symlinked dataDir before creating anything through it',
    async () => {
      const realDataDirectory = temporaryDataDirectory();
      const linkContainer = temporaryDataDirectory();
      const linkedDataDirectory = join(linkContainer, 'data-dir-link');
      symlinkSync(realDataDirectory, linkedDataDirectory);

      await expect(openInventoryV1(linkedDataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'unsafe-path'));
      expect(readdirSync(realDataDirectory)).toEqual([]);
      expect(existsSync(databasePath(realDataDirectory))).toBe(false);
      expectNoQuarantine(databasePath(linkedDataDirectory));
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a foreign-owned dataDir before creating its inventory child',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      const originalMode = statSync(dataDirectory).mode & 0o777;
      const actualUid = process.getuid();
      const uid = vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1);
      try {
        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
          expectOpenErrorCode(error, 'database-io'));
      } finally {
        uid.mockRestore();
      }
      expect(existsSync(dirname(path))).toBe(false);
      expect(statSync(dataDirectory).mode & 0o777).toBe(originalMode);
      expectNoQuarantine(path);
    },
  );

  it('refuses orphaned sidecars without deleting them', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}-wal`, 'orphan');
    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'ambiguous-database'));
    expect(readFileSync(`${path}-wal`, 'utf8')).toBe('orphan');
    expectNoQuarantine(path);
  });

  it.runIf(process.platform !== 'win32' && process.getuid?.() !== 0)(
    'fails closed on file-permission errors without quarantine',
    async () => {
      const dataDirectory = temporaryDataDirectory();
      const path = databasePath(dataDirectory);
      mkdirSync(dirname(path), { recursive: true });
      const database = new DatabaseSync(path);
      database.exec(`PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID}; PRAGMA user_version = 1;`);
      database.close();
      chmodSync(path, 0o000);
      try {
        await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
          expectOpenErrorCode(error, 'database-io'));
        expectNoQuarantine(path);
      } finally {
        chmodSync(path, 0o600);
      }
    },
  );

  it('refuses a busy incompatible owned database without quarantine', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const holder = new DatabaseSync(path);
    holder.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE wrong_v1 (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
      BEGIN IMMEDIATE;
    `);
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-busy'));
      expectNoQuarantine(path);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });

  it('does not split a corrupt owned database from a live WAL writer', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    mkdirSync(dirname(path), { recursive: true });
    const seed = new DatabaseSync(path);
    seed.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE owned_data (value TEXT);
      PRAGMA application_id = ${INVENTORY_V1_APPLICATION_ID};
      PRAGMA user_version = 1;
    `);
    seed.close();
    const holder = new DatabaseSync(path);
    holder.exec(`
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      INSERT INTO owned_data VALUES ('live-writer');
    `);
    truncateSync(path, 100);
    const before = readFileSync(path);
    try {
      await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
        expectOpenErrorCode(error, 'database-io'));
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expectNoQuarantine(path);
    } finally {
      try { holder.exec('ROLLBACK'); } catch { /* the main file is intentionally corrupt */ }
      try { holder.close(); } catch { /* the main file is intentionally corrupt */ }
    }
  });

  it('resumes a partial recovery-marker move before rebuilding', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const inventoryDirectory = dirname(path);
    const generation = join(
      inventoryDirectory,
      'quarantine',
      'inventory-v1-1234567890-aaaaaaaaaaaaaaaa',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(join(generation, 'inventory-v1.sqlite3'), 'main-before-crash');
    writeFileSync(`${path}-wal`, 'wal-before-crash');
    writeFileSync(`${path}-shm`, 'shm-before-crash');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({ version: 1, quarantineDirectory: generation }),
    );

    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe('main-before-crash');
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'utf8')).toBe('wal-before-crash');
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-shm'), 'utf8')).toBe('shm-before-crash');
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
    } finally {
      foundation.close();
    }
  });

  it('retains the recovery marker across an interrupted evidence move and resumes', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const inventoryDirectory = dirname(path);
    const generation = join(
      inventoryDirectory,
      'quarantine',
      'inventory-v1-1234567890-bbbbbbbbbbbbbbbb',
    );
    mkdirSync(generation, { recursive: true });
    writeFileSync(path, 'main-before-crash');
    writeFileSync(`${path}-wal`, 'wal-before-crash');
    writeFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'conflicting-target');
    writeFileSync(
      `${path}.rebuild-required`,
      JSON.stringify({ version: 1, quarantineDirectory: generation }),
    );

    await expect(openInventoryV1(dataDirectory)).rejects.toSatisfy((error: unknown) =>
      expectOpenErrorCode(error, 'database-io'));
    expect(existsSync(`${path}.rebuild-required`)).toBe(true);
    expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe('main-before-crash');
    expect(readFileSync(`${path}-wal`, 'utf8')).toBe('wal-before-crash');

    rmSync(join(generation, 'inventory-v1.sqlite3-wal'));
    const foundation = await openInventoryV1(dataDirectory);
    try {
      assertInitializedInventory(path);
      expect(existsSync(`${path}.rebuild-required`)).toBe(false);
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3'), 'utf8')).toBe('main-before-crash');
      expect(readFileSync(join(generation, 'inventory-v1.sqlite3-wal'), 'utf8')).toBe('wal-before-crash');
    } finally {
      foundation.close();
    }
  });

  it('explicitly quarantines and rebuilds an open owned database', async () => {
    const dataDirectory = temporaryDataDirectory();
    const path = databasePath(dataDirectory);
    const foundation = await openInventoryV1(dataDirectory);
    foundation.quarantineAndRebuild();
    try {
      expect(foundation.closed).toBe(false);
      assertInitializedInventory(path);
      expect(quarantineGenerations(path)).toHaveLength(1);
      expect(lstatSync(join(quarantineGenerations(path)[0]!, 'inventory-v1.sqlite3')).isFile()).toBe(true);
    } finally {
      foundation.close();
    }
  });
});
