import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  INVENTORY_V1_APPLICATION_ID,
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_LEGACY_USER_VERSION,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_VERSION,
  openInventoryV1,
  type CompareAndSwapAppliedCatalogHeadInputV1,
  type Rfc64InventoryV1Foundation,
} from '../src/rfc64/inventory-v1/index.js';

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
  });

  it('migrates the exact prior v1 schema before accepting applied-head state', async () => {
    const directory = temporaryDirectory();
    const initialized = await openInventoryV1(directory);
    initialized.close();
    const path = join(directory, INVENTORY_V1_RELATIVE_PATH);
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA journal_mode = DELETE;
      DROP TABLE rfc64_swm_author_inventory_rows_v1;
      DROP TABLE rfc64_swm_author_inventory_heads_v1;
      DROP TABLE rfc64_applied_catalog_heads_v1;
      PRAGMA user_version = ${INVENTORY_V1_LEGACY_USER_VERSION};
    `);
    legacy.close();
    chmodSync(dirname(path), INVENTORY_V1_DIRECTORY_MODE);
    chmodSync(path, INVENTORY_V1_FILE_MODE);

    const migrated = await openInventoryV1(directory);
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
