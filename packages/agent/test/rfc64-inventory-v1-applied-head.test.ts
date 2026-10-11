import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DDL,
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_LEGACY_USER_VERSION,
  INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_VERSION,
  openInventoryV1,
  type CompareAndSwapAppliedCatalogHeadInputV1,
  type Rfc64InventoryV1Foundation,
} from '../src/rfc64/inventory-v1/index.js';
import {
  CandidateInventoryV1,
  createAppliedCatalogHeadsSnapshotV1,
} from '../src/rfc64/inventory-v1/candidate.js';

const SCOPE = `0x${'11'.repeat(32)}` as const;
const AUTHOR = `0x${'22'.repeat(20)}` as const;
const GENESIS = `0x${'33'.repeat(32)}` as const;
const GENESIS_INVENTORY = `0x${'44'.repeat(32)}` as const;
const SUCCESSOR = `0x${'55'.repeat(32)}` as const;
const SUCCESSOR_INVENTORY = `0x${'66'.repeat(32)}` as const;
const LOSING_HEAD = `0x${'77'.repeat(32)}` as const;
const directories: string[] = [];
const foundations: Rfc64InventoryV1Foundation[] = [];

afterEach(() => {
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 SQL-1 durable applied-head CAS', () => {
  it('initializes, advances exactly once, rejects a stale writer, and survives restart', async () => {
    const directory = temporaryDirectory();
    let inventory = await openInventoryV1(directory);
    foundations.push(inventory);

    expect(inventory.readAppliedCatalogHeadV1(SCOPE, AUTHOR)).toBeNull();
    const genesis = input(null, GENESIS, GENESIS_INVENTORY, '0', '0');
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(genesis)).toEqual({
      status: 'applied',
      snapshot: expectedSnapshot(GENESIS, GENESIS_INVENTORY, '0', '0'),
    });
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(genesis).status).toBe('existing');

    const successor = input(GENESIS, SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1');
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(successor).status).toBe('applied');
    expect(() => inventory.compareAndSwapAppliedCatalogHeadV1(
      input(GENESIS, LOSING_HEAD, `0x${'88'.repeat(32)}`, '1', '1'),
    )).toThrowError(expect.objectContaining({ code: 'applied-head-cas-conflict' }));
    expect(inventory.readAppliedCatalogHeadV1(SCOPE, AUTHOR)).toEqual(
      expectedSnapshot(SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1'),
    );

    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readAppliedCatalogHeadV1(SCOPE, AUTHOR)).toEqual(
      expectedSnapshot(SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1'),
    );
    expect(inventory.listAppliedCatalogHeadsV1()).toEqual([
      expectedSnapshot(SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1'),
    ]);
    expect(() => inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: LOSING_HEAD,
    })).toThrowError(expect.objectContaining({ code: 'applied-head-cas-conflict' }));
    inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: SUCCESSOR,
    });
    expect(inventory.listAppliedCatalogHeadsV1()).toEqual([]);
    inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: SUCCESSOR,
    });
    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readAppliedCatalogHeadV1(SCOPE, AUTHOR)).toBeNull();
  });

  it('migrates the exact prior v1 schema before accepting applied-head state', async () => {
    const directory = temporaryDirectory();
    const initialized = await openInventoryV1(directory);
    initialized.close();
    const path = join(directory, INVENTORY_V1_RELATIVE_PATH);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA journal_mode = DELETE;
      DROP TABLE rfc64_unregistered_authority_seeds_v1;
      DROP TABLE rfc64_staged_catalog_heads_v1;
      DROP TABLE rfc64_finalized_private_placement_repairs_v1;
      DROP TABLE rfc64_swm_author_inventory_rows_v1;
      DROP TABLE rfc64_swm_author_inventory_heads_v1;
      DROP TABLE rfc64_applied_catalog_heads_v1;
      PRAGMA user_version = ${INVENTORY_V1_LEGACY_USER_VERSION};
    `);
    legacy.close();
    chmodSync(dirname(path), INVENTORY_V1_DIRECTORY_MODE);
    chmodSync(path, INVENTORY_V1_FILE_MODE);

    const migrated = await openInventoryV1(directory, {
      quarantineCapability: INVENTORY_V1_POSIX_QUARANTINE_CAPABILITY,
    });
    foundations.push(migrated);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA application_id').get()?.application_id)
        .toBe(INVENTORY_V1_APPLICATION_ID);
      expect(database.prepare('PRAGMA user_version').get()?.user_version)
        .toBe(INVENTORY_V1_USER_VERSION);
      expect(database.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'rfc64_applied_catalog_heads_v1'",
      ).get()?.count).toBe(1);
    } finally {
      database.close();
    }
    expect(migrated.compareAndSwapAppliedCatalogHeadV1(
      input(null, GENESIS, GENESIS_INVENTORY, '0', '0'),
    ).status).toBe('applied');
  });
});

describe('RFC-64 applied-head inventory snapshot', () => {
  it('lists again after every applied-head write attempt and never after a read', async () => {
    const directory = temporaryDirectory();
    const inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    let snapshot = inventory.readAppliedCatalogHeadsSnapshotV1();
    expect(snapshot.heads).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.heads)).toBe(true);
    // A fresh listing, and its token names exactly the rows now in the table.
    const expectRelisted = (heads: readonly ReturnType<typeof expectedSnapshot>[]) => {
      const next = inventory.readAppliedCatalogHeadsSnapshotV1();
      expect(next).not.toBe(snapshot);
      expect(next.heads).toEqual(heads);
      expect(next.heads).toEqual(inventory.listAppliedCatalogHeadsV1());
      expect(next.token === snapshot.token).toBe(
        JSON.stringify(next.heads) === JSON.stringify(snapshot.heads),
      );
      snapshot = next;
    };
    const expectUnchanged = () => {
      expect(inventory.readAppliedCatalogHeadsSnapshotV1()).toBe(snapshot);
    };
    const genesisRow = expectedSnapshot(GENESIS, GENESIS_INVENTORY, '0', '0');
    const successorRow = expectedSnapshot(SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1');

    inventory.readAppliedCatalogHeadV1(SCOPE, AUTHOR);
    inventory.listAppliedCatalogHeadsV1();
    inventory.isStagedCatalogHeadV1(SCOPE, AUTHOR, GENESIS);
    // Writes to other tables leave it alone too.
    expect(inventory.purgeNextStartupStaleCandidateBatch().done).toBe(true);
    inventory.createCandidateSession();
    expectUnchanged();

    const genesis = input(null, GENESIS, GENESIS_INVENTORY, '0', '0');
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(genesis).status).toBe('applied');
    expectRelisted([genesisRow]);
    expectUnchanged();
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(genesis).status).toBe('existing');
    expectRelisted([genesisRow]);
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(
      input(GENESIS, SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1'),
    ).status).toBe('applied');
    expectRelisted([successorRow]);
    expect(() => inventory.compareAndSwapAppliedCatalogHeadV1(
      input(GENESIS, LOSING_HEAD, `0x${'88'.repeat(32)}`, '1', '1'),
    )).toThrowError(expect.objectContaining({ code: 'applied-head-cas-conflict' }));
    expectRelisted([successorRow]);
    expect(() => inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: LOSING_HEAD,
    })).toThrowError(expect.objectContaining({ code: 'applied-head-cas-conflict' }));
    expectRelisted([successorRow]);
    inventory.deleteAppliedCatalogHeadsV1([{
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: SUCCESSOR,
    }]);
    expectRelisted([]);
    inventory.deleteAppliedCatalogHeadV1({
      catalogScopeDigest: SCOPE,
      authorAddress: AUTHOR,
      expectedCurrentCatalogHeadDigest: SUCCESSOR,
    });
    expectRelisted([]);
    expectUnchanged();

    // A reopened inventory lists afresh; the closed one refuses.
    expect(inventory.compareAndSwapAppliedCatalogHeadV1(genesis).status).toBe('applied');
    expectRelisted([genesisRow]);
    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    const reopened = await openInventoryV1(directory);
    foundations.push(reopened);
    const afterRestart = reopened.readAppliedCatalogHeadsSnapshotV1();
    expect(afterRestart).not.toBe(snapshot);
    expect(afterRestart.heads).toEqual([genesisRow]);
    expect(afterRestart.token).toBe(snapshot.token);
    expect(() => inventory.readAppliedCatalogHeadsSnapshotV1()).toThrow();
  });

  it('keys the token on every field of every row, in listing order', () => {
    const tokenOf = (rows: readonly object[]) =>
      createAppliedCatalogHeadsSnapshotV1(rows as never).token;
    const row = expectedSnapshot(GENESIS, GENESIS_INVENTORY, '0', '0');
    const other = {
      ...expectedSnapshot(SUCCESSOR, SUCCESSOR_INVENTORY, '1', '1'),
      authorAddress: `0x${'99'.repeat(20)}`,
    };
    const token = tokenOf([row, other]);
    expect(tokenOf([{ ...row }, { ...other }])).toBe(token);
    expect(tokenOf([other, row])).not.toBe(token);
    expect(tokenOf([row])).not.toBe(token);
    expect(tokenOf([])).not.toBe(tokenOf([row]));
    const variants: Array<Partial<typeof row>> = [
      { catalogScopeDigest: `0x${'aa'.repeat(32)}` },
      { authorAddress: `0x${'bb'.repeat(20)}` },
      { currentCatalogHeadDigest: LOSING_HEAD },
      { appliedInventoryDigest: SUCCESSOR_INVENTORY },
      { catalogVersion: '7' },
      { inventoryRowCount: '7' },
    ];
    for (const variant of variants) {
      expect(tokenOf([{ ...row, ...variant }, other])).not.toBe(token);
    }
  });

  for (const commitLanded of [false, true]) {
    it(`lists again when an applied-head write's COMMIT fails and ${commitLanded ? 'landed' : 'rolled back'}`, () => {
      const path = join(temporaryDirectory(), `applied-commit-${commitLanded}.sqlite3`);
      let database = new DatabaseSync(path);
      database.exec(`PRAGMA foreign_keys = ON; ${INVENTORY_V1_DDL}`);
      let failNextCommit = false;
      const makeFacade = (): DatabaseSync => commitFaultFacade(database, (sql, exec) => {
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          if (commitLanded) exec(sql);
          throw new Error(`injected ${commitLanded ? 'post' : 'pre'}-COMMIT failure`);
        }
        exec(sql);
      });
      let facade = makeFacade();
      const reopen = vi.fn((): DatabaseSync => {
        database.close();
        database = new DatabaseSync(path);
        database.exec('PRAGMA foreign_keys = ON');
        facade = makeFacade();
        return facade;
      });
      const inventory = new CandidateInventoryV1(facade, reopen);
      try {
        const before = inventory.readAppliedCatalogHeadsSnapshotV1();
        expect(before.heads).toEqual([]);
        failNextCommit = true;
        expect(inventory.compareAndSwapAppliedCatalogHeadV1(
          input(null, GENESIS, GENESIS_INVENTORY, '0', '0'),
        ).status).toBe('applied');
        expect(reopen).toHaveBeenCalledTimes(1);
        const afterCas = inventory.readAppliedCatalogHeadsSnapshotV1();
        expect(afterCas.token).not.toBe(before.token);
        expect(afterCas.heads).toEqual([
          expectedSnapshot(GENESIS, GENESIS_INVENTORY, '0', '0'),
        ]);
        expect(inventory.readAppliedCatalogHeadsSnapshotV1()).toBe(afterCas);

        failNextCommit = true;
        inventory.deleteAppliedCatalogHeadV1({
          catalogScopeDigest: SCOPE,
          authorAddress: AUTHOR,
          expectedCurrentCatalogHeadDigest: GENESIS,
        });
        expect(reopen).toHaveBeenCalledTimes(2);
        const afterDelete = inventory.readAppliedCatalogHeadsSnapshotV1();
        expect(afterDelete.token).toBe(before.token);
        expect(afterDelete.heads).toEqual([]);
      } finally {
        inventory.close();
        try { database.close(); } catch { /* inventory owns the current handle */ }
      }
    });
  }

  it('lists again after a low-level reopen outside any applied-head write', () => {
    const path = join(temporaryDirectory(), 'applied-read-reopen.sqlite3');
    let database = new DatabaseSync(path);
    database.exec(`PRAGMA foreign_keys = ON; ${INVENTORY_V1_DDL}`);
    let failNextCommit = false;
    const makeFacade = (): DatabaseSync => commitFaultFacade(database, (sql, exec) => {
      if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
        failNextCommit = false;
        throw new Error('injected read COMMIT failure');
      }
      exec(sql);
    });
    const reopen = vi.fn((): DatabaseSync => {
      database.close();
      database = new DatabaseSync(path);
      database.exec('PRAGMA foreign_keys = ON');
      return makeFacade();
    });
    const inventory = new CandidateInventoryV1(makeFacade(), reopen);
    try {
      const before = inventory.readAppliedCatalogHeadsSnapshotV1();
      failNextCommit = true;
      expect(() => inventory.listAppliedCatalogHeadsV1()).toThrow(/read COMMIT failed/u);
      expect(reopen).toHaveBeenCalledOnce();
      const after = inventory.readAppliedCatalogHeadsSnapshotV1();
      expect(after).not.toBe(before);
      expect(after.token).toBe(before.token);
      // A snapshot read that fails leaves nothing behind to reuse.
      failNextCommit = true;
      expect(() => inventory.listAppliedCatalogHeadsV1()).toThrow(/read COMMIT failed/u);
      failNextCommit = true;
      expect(() => inventory.readAppliedCatalogHeadsSnapshotV1()).toThrow(/read COMMIT failed/u);
      expect(reopen).toHaveBeenCalledTimes(3);
      expect(inventory.readAppliedCatalogHeadsSnapshotV1().heads).toEqual([]);
    } finally {
      inventory.close();
      try { database.close(); } catch { /* inventory owns the current handle */ }
    }
  });
});

function commitFaultFacade(
  database: DatabaseSync,
  execOverride: (sql: string, exec: (sql: string) => void) => void,
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        const exec = target.exec.bind(target);
        return (sql: string): void => execOverride(sql, exec);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-applied-head-')));
  directories.push(directory);
  return directory;
}

function input(
  expectedCurrentCatalogHeadDigest: CompareAndSwapAppliedCatalogHeadInputV1[
    'expectedCurrentCatalogHeadDigest'
  ],
  currentCatalogHeadDigest: CompareAndSwapAppliedCatalogHeadInputV1[
    'currentCatalogHeadDigest'
  ],
  appliedInventoryDigest: CompareAndSwapAppliedCatalogHeadInputV1[
    'appliedInventoryDigest'
  ],
  catalogVersion: string,
  inventoryRowCount: string,
): CompareAndSwapAppliedCatalogHeadInputV1 {
  return {
    catalogScopeDigest: SCOPE,
    authorAddress: AUTHOR,
    expectedCurrentCatalogHeadDigest,
    currentCatalogHeadDigest,
    appliedInventoryDigest,
    catalogVersion: catalogVersion as never,
    inventoryRowCount: inventoryRowCount as never,
  };
}

function expectedSnapshot(
  currentCatalogHeadDigest: string,
  appliedInventoryDigest: string,
  catalogVersion: string,
  inventoryRowCount: string,
) {
  return {
    catalogScopeDigest: SCOPE,
    authorAddress: AUTHOR,
    currentCatalogHeadDigest,
    appliedInventoryDigest,
    catalogVersion,
    inventoryRowCount,
  };
}
