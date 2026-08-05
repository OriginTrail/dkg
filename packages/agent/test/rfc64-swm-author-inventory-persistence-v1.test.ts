import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
  canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1,
  computeSwmAuthorInventoryHeadObjectDigestV1,
  computeSwmAuthorInventoryRowsDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  type SignedSwmAuthorInventoryHeadEnvelopeV1,
  type SwmAuthorInventoryHeadV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type UnsignedSwmAuthorInventoryHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';
import {
  INVENTORY_V1_DIRECTORY_MODE,
  INVENTORY_V1_DDL,
  INVENTORY_V1_FILE_MODE,
  INVENTORY_V1_LEGACY_USER_VERSION,
  INVENTORY_V1_RELATIVE_PATH,
  INVENTORY_V1_USER_VERSION,
  INVENTORY_V1_V2_USER_VERSION,
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
} from '../src/rfc64/inventory-v1/index.js';
import { CandidateInventoryV1 } from '../src/rfc64/inventory-v1/candidate.js';
import { INVENTORY_V1_STATEMENT_SQL } from '../src/rfc64/inventory-v1/statements.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const SIGNATURE = `0x${'77'.repeat(65)}`;
const SCOPE = Object.freeze({
  networkId: 'otp:20430',
  contextGraphId: 'public-swm-persistence-fixture',
  governanceChainId: '20430',
  governanceContractAddress: '0x2222222222222222222222222222222222222222',
  ownershipTransitionDigest: null,
  subGraphName: null,
  authorAddress: AUTHOR,
  era: '0',
}) as SwmAuthorInventoryScopeV1;
const SCOPE_DIGEST = computeSwmAuthorInventoryScopeDigestV1(SCOPE);

const ROW_A = row('7', 'draft-a', 'share-a', '11', '22');
const ROW_B = row('8', 'draft-b', 'share-b', '33', '44');
const ROW_2 = row('2', 'draft-2', 'share-2', '12', '23');
const ROW_10 = row('10', 'draft-10', 'share-10', '13', '24');
const MIGRATION_HEAD = `0x${'55'.repeat(32)}` as const;
const MIGRATION_ROWS = `0x${'66'.repeat(32)}` as const;
const directories: string[] = [];
const foundations: Rfc64InventoryV1Foundation[] = [];

afterEach(() => {
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 restart-safe SWM author inventory persistence', () => {
  it('atomically initializes, advances, removes, rejects stale writers, and survives restart', async () => {
    const directory = temporaryDirectory();
    let inventory = await openInventoryV1(directory);
    foundations.push(inventory);

    const genesis = snapshot([ROW_A]);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    })).toEqual({ status: 'applied', snapshot: genesis });
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    }).status).toBe('existing');

    const successor = snapshot([ROW_A, ROW_B], genesis);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_B },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    }).status).toBe('applied');
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_B },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    }).status).toBe('existing');
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: snapshot([ROW_A], genesis),
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-cas-conflict' }));

    const afterRemoval = snapshot([ROW_A], successor);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: afterRemoval,
      mutation: { kind: 'remove', kaUal: ROW_B.kaUal },
      expectedCurrentHeadDigest: successor.head.objectDigest as `0x${string}`,
    }).status).toBe('applied');
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: afterRemoval,
      mutation: { kind: 'remove', kaUal: ROW_B.kaUal },
      expectedCurrentHeadDigest: successor.head.objectDigest as `0x${string}`,
    }).status).toBe('existing');

    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(
      afterRemoval,
    );
  });

  it('persists and restarts numeric KA order rather than lexical UAL order', async () => {
    const directory = temporaryDirectory();
    let inventory = await openInventoryV1(directory);
    foundations.push(inventory);

    const genesis = snapshot([ROW_2]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_2 },
      expectedCurrentHeadDigest: null,
    });
    const successor = snapshot([ROW_2, ROW_10], genesis);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_10 },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    })).toEqual({ status: 'applied', snapshot: successor });

    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(
      successor,
    );
  });

  for (const commitLanded of [false, true]) {
    it(`resolves an SWM CAS when the failed COMMIT ${commitLanded ? 'landed' : 'rolled back'}`, () => {
      const path = join(temporaryDirectory(), `swm-commit-${commitLanded}.sqlite3`);
      let database = new DatabaseSync(path);
      database.exec(`PRAGMA foreign_keys = ON; ${INVENTORY_V1_DDL}`);
      let failNextCommit = true;
      let commitAttempts = 0;
      const makeFacade = (): DatabaseSync => commitFaultFacade(database, (sql, exec) => {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          commitAttempts += 1;
          if (failNextCommit) {
            failNextCommit = false;
            if (commitLanded) exec(sql);
            throw new Error(`injected ${commitLanded ? 'post' : 'pre'}-COMMIT failure`);
          }
        }
        exec(sql);
      });
      let facade = makeFacade();
      const reopen = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
        expect(abandoned).toBe(facade);
        database.close();
        database = new DatabaseSync(path);
        database.exec('PRAGMA foreign_keys = ON');
        facade = makeFacade();
        return facade;
      });
      const inventory = new CandidateInventoryV1(facade, reopen);
      try {
        const genesis = snapshot([ROW_A]);
        expect(inventory.compareAndSwapSwmAuthorInventoryV1({
          snapshot: genesis,
          mutation: { kind: 'upsert', row: ROW_A },
          expectedCurrentHeadDigest: null,
        })).toEqual({ status: 'applied', snapshot: genesis });
        expect(reopen).toHaveBeenCalledOnce();
        expect(commitAttempts).toBe(commitLanded ? 1 : 2);
        expect(inventory.compareAndSwapSwmAuthorInventoryV1({
          snapshot: genesis,
          mutation: { kind: 'upsert', row: ROW_A },
          expectedCurrentHeadDigest: null,
        })).toEqual({ status: 'existing', snapshot: genesis });
        expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(
          genesis,
        );
        expect(database.prepare(
          'SELECT count(*) AS count FROM rfc64_swm_author_inventory_heads_v1',
        ).get()?.count).toBe(1);
        expect(database.prepare(
          'SELECT count(*) AS count FROM rfc64_swm_author_inventory_rows_v1',
        ).get()?.count).toBe(1);
      } finally {
        inventory.close();
        try { database.close(); } catch { /* inventory owns the current handle */ }
      }
    });
  }

  it('fails closed when an indeterminate SWM CAS resolves to a competing valid head', () => {
    const path = join(temporaryDirectory(), 'swm-commit-conflict.sqlite3');
    let database = new DatabaseSync(path);
    database.exec(`PRAGMA foreign_keys = ON; ${INVENTORY_V1_DDL}`);
    let facade = database;
    let injectConflict = false;
    let genesisForConflict: SwmAuthorInventorySnapshotV1 | null = null;
    const reopen = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
      expect(abandoned).toBe(facade);
      database.close();
      if (injectConflict) {
        injectConflict = false;
        const competitorDatabase = new DatabaseSync(path);
        competitorDatabase.exec('PRAGMA foreign_keys = ON');
        const competitor = new CandidateInventoryV1(
          competitorDatabase,
          () => { throw new Error('competitor must not reopen'); },
        );
        try {
          if (genesisForConflict === null) throw new Error('missing conflict predecessor');
          competitor.compareAndSwapSwmAuthorInventoryV1({
            snapshot: snapshot([ROW_A, ROW_10], genesisForConflict),
            mutation: { kind: 'upsert', row: ROW_10 },
            expectedCurrentHeadDigest:
              genesisForConflict.head.objectDigest as `0x${string}`,
          });
        } finally {
          competitor.close();
        }
      }
      database = new DatabaseSync(path);
      database.exec('PRAGMA foreign_keys = ON');
      facade = commitFaultFacade(database, (sql, exec) => exec(sql));
      return facade;
    });
    facade = commitFaultFacade(database, (sql, exec) => {
      if (injectConflict && sql.trim().toUpperCase() === 'COMMIT') {
        throw new Error('injected pre-COMMIT conflict window');
      }
      exec(sql);
    });
    const inventory = new CandidateInventoryV1(facade, reopen);
    try {
      const genesis = snapshot([ROW_A]);
      genesisForConflict = genesis;
      inventory.compareAndSwapSwmAuthorInventoryV1({
        snapshot: genesis,
        mutation: { kind: 'upsert', row: ROW_A },
        expectedCurrentHeadDigest: null,
      });
      const requested = snapshot([ROW_A, ROW_B], genesis);
      injectConflict = true;
      expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
        snapshot: requested,
        mutation: { kind: 'upsert', row: ROW_B },
        expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
      })).toThrowError(expect.objectContaining({ code: 'swm-inventory-cas-conflict' }));
      expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)?.rows)
        .toEqual([ROW_A, ROW_10]);
    } finally {
      inventory.close();
      try { database.close(); } catch { /* inventory owns the current handle */ }
    }
  });

  it('rejects a signed head whose exact rows are not the requested one-row mutation', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const wrong = snapshot([ROW_A, ROW_B]);
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: wrong,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('rejects a row from another DKG network before writing either head or rows', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const foreignRow = Object.freeze({
      ...ROW_A,
      kaUal: `did:dkg:base:84532/${AUTHOR}/7`,
    }) as SwmAuthorInventoryRowV1;
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: snapshot([foreignRow]),
      mutation: { kind: 'upsert', row: foreignRow },
      expectedCurrentHeadDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('rejects non-genesis initialization and malformed successor transitions', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const nonGenesis = snapshot([ROW_A], undefined, {
      version: '1',
      previousHeadDigest: `0x${'99'.repeat(32)}`,
    });
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: nonGenesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));

    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    for (const malformed of [
      snapshot([ROW_A, ROW_B], genesis, { version: '2' }),
      snapshot([ROW_A, ROW_B], genesis, { previousHeadDigest: `0x${'88'.repeat(32)}` }),
    ]) {
      expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
        snapshot: malformed,
        mutation: { kind: 'upsert', row: ROW_B },
        expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
      })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    }
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(genesis);
  });

  it('does not accept an invalid mutation merely because the signed head already exists', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'remove', kaUal: ROW_B.kaUal },
      expectedCurrentHeadDigest: null,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
  });

  it('requires exact durable mutation evidence for a non-genesis replay', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    const successor = snapshot([ROW_A, ROW_B], genesis);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_B },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    });
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    })).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
  });

  it('replaces an existing row by KA UAL and durably reads the replacement after restart', async () => {
    const directory = temporaryDirectory();
    let inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    const replacement = Object.freeze({
      ...ROW_A,
      assertionVersion: '2',
      shareOperationId: 'share-a-replaced',
      projectionDigest: `0x${'55'.repeat(32)}`,
    }) as SwmAuthorInventoryRowV1;
    const successor = snapshot([replacement], genesis);
    expect(inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: successor,
      mutation: { kind: 'upsert', row: replacement },
      expectedCurrentHeadDigest: genesis.head.objectDigest as `0x${string}`,
    })).toEqual({ status: 'applied', snapshot: successor });

    inventory.close();
    foundations.splice(foundations.indexOf(inventory), 1);
    inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toEqual(successor);
  });

  it.each([
    {
      label: 'v1',
      version: INVENTORY_V1_LEGACY_USER_VERSION,
      dropAppliedHead: true,
    },
    {
      label: 'v2',
      version: INVENTORY_V1_V2_USER_VERSION,
      dropAppliedHead: false,
    },
  ])('migrates an exact $label inventory through v3 before committing SWM shadow state', async ({
    version,
    dropAppliedHead,
  }) => {
    const directory = temporaryDirectory();
    const initialized = await openInventoryV1(directory);
    initialized.close();
    const path = join(directory, INVENTORY_V1_RELATIVE_PATH);
    const v2 = new DatabaseSync(path);
    const session = new Uint8Array(32).fill(1);
    const targetHead = new Uint8Array(32).fill(2);
    v2.prepare(`
      INSERT INTO rfc64_candidate_bucket_loads_v1 (
        session_id, catalog_scope_digest, author_address,
        target_catalog_head_digest, subgraph_name, catalog_era_u64be,
        bucket_count_u64be, bucket_id_u64be, bucket_object_digest,
        row_count_u64be, payload_byte_length_u64be
      ) VALUES (
        :session, :scope, :author, :head, NULL, zeroblob(8),
        x'0000000000000001', zeroblob(8), zeroblob(32), zeroblob(8), zeroblob(8)
      )
    `).run({
      session,
      scope: hexBytes(SCOPE_DIGEST),
      author: hexBytes(AUTHOR),
      head: targetHead,
    });
    if (!dropAppliedHead) {
      v2.prepare(`
        INSERT INTO rfc64_applied_catalog_heads_v1 (
          catalog_scope_digest, author_address, current_catalog_head_digest,
          applied_inventory_digest, catalog_version_u64be, inventory_row_count_u64be
        ) VALUES (:scope, :author, :head, :rows, zeroblob(8), x'0000000000000001')
      `).run({
        scope: hexBytes(SCOPE_DIGEST),
        author: hexBytes(AUTHOR),
        head: hexBytes(MIGRATION_HEAD),
        rows: hexBytes(MIGRATION_ROWS),
      });
    }
    v2.exec(`
      PRAGMA journal_mode = DELETE;
      DROP TABLE rfc64_swm_author_inventory_rows_v1;
      DROP TABLE rfc64_swm_author_inventory_heads_v1;
      ${dropAppliedHead ? 'DROP TABLE rfc64_applied_catalog_heads_v1;' : ''}
      PRAGMA user_version = ${version};
    `);
    v2.close();
    chmodSync(dirname(path), INVENTORY_V1_DIRECTORY_MODE);
    chmodSync(path, INVENTORY_V1_FILE_MODE);

    const migrated = await openInventoryV1(directory);
    foundations.push(migrated);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA user_version').get()?.user_version)
        .toBe(INVENTORY_V1_USER_VERSION);
      expect(database.prepare(
        "SELECT count(*) AS count FROM sqlite_schema WHERE name LIKE 'rfc64_swm_author_inventory_%_v1'",
      ).get()?.count).toBe(2);
      expect(database.prepare(`
        SELECT hex(session_id) AS session, hex(catalog_scope_digest) AS scope,
               hex(author_address) AS author, hex(target_catalog_head_digest) AS head
        FROM rfc64_candidate_bucket_loads_v1
      `).get()).toEqual({
        session: '01'.repeat(32).toUpperCase(),
        scope: SCOPE_DIGEST.slice(2).toUpperCase(),
        author: AUTHOR.slice(2).toUpperCase(),
        head: '02'.repeat(32).toUpperCase(),
      });
    } finally {
      database.close();
    }
    if (!dropAppliedHead) {
      expect(migrated.readAppliedCatalogHeadV1(SCOPE_DIGEST, AUTHOR)).toEqual({
        catalogScopeDigest: SCOPE_DIGEST,
        authorAddress: AUTHOR,
        currentCatalogHeadDigest: MIGRATION_HEAD,
        appliedInventoryDigest: MIGRATION_ROWS,
        catalogVersion: '0',
        inventoryRowCount: '1',
      });
    }
    const genesis = snapshot([ROW_A]);
    expect(migrated.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    }).status).toBe('applied');
  });

  it('stores the exact canonical signed head bytes rather than a mutable caller object', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    const expectedBytes = canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(genesis.head);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });
    const read = inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)!;
    expect(canonicalizeSignedSwmAuthorInventoryHeadEnvelopeBytesV1(read.head))
      .toEqual(expectedBytes);
    expect(Object.isFrozen(read.rows)).toBe(true);
  });

  it('rejects accessor-backed CAS fields without invoking them', async () => {
    const inventory = await openInventoryV1(temporaryDirectory());
    foundations.push(inventory);
    let reads = 0;
    const hostile = {
      get snapshot() {
        reads += 1;
        return snapshot([ROW_A]);
      },
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    };
    expect(() => inventory.compareAndSwapSwmAuthorInventoryV1(
      hostile as unknown as Parameters<
        typeof inventory.compareAndSwapSwmAuthorInventoryV1
      >[0],
    )).toThrowError(expect.objectContaining({ code: 'swm-inventory-input' }));
    expect(reads).toBe(0);
    expect(inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR)).toBeNull();
  });

  it('fails closed when durable rows no longer match the signed head', async () => {
    const directory = temporaryDirectory();
    const inventory = await openInventoryV1(directory);
    foundations.push(inventory);
    const genesis = snapshot([ROW_A]);
    inventory.compareAndSwapSwmAuthorInventoryV1({
      snapshot: genesis,
      mutation: { kind: 'upsert', row: ROW_A },
      expectedCurrentHeadDigest: null,
    });

    const database = new DatabaseSync(join(directory, INVENTORY_V1_RELATIVE_PATH));
    try {
      database.exec(`
        UPDATE rfc64_swm_author_inventory_rows_v1
        SET projection_digest = zeroblob(32);
      `);
    } finally {
      database.close();
    }

    expect(() => inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR))
      .toThrowError(expect.objectContaining({ code: 'swm-inventory-database-corrupt' }));
  });

  it('preserves the latency failure and performs a verified reopen when row reads overrun', () => {
    const path = join(temporaryDirectory(), 'latency-fault.sqlite3');
    let database = new DatabaseSync(path);
    database.exec(`PRAGMA foreign_keys = ON; ${INVENTORY_V1_DDL}`);
    let now = 0;
    let injectRowLatency = false;
    let facade = latencyFaultFacade(database, () => {
      if (injectRowLatency) now += 10_001;
    });
    const reopen = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
      expect(abandoned).toBe(facade);
      database.close();
      database = new DatabaseSync(path);
      database.exec('PRAGMA foreign_keys = ON');
      facade = latencyFaultFacade(database, () => {
        if (injectRowLatency) now += 10_001;
      });
      return facade;
    });
    const inventory = new CandidateInventoryV1(facade, reopen, () => now);
    try {
      const genesis = snapshot([ROW_A]);
      inventory.compareAndSwapSwmAuthorInventoryV1({
        snapshot: genesis,
        mutation: { kind: 'upsert', row: ROW_A },
        expectedCurrentHeadDigest: null,
      });
      injectRowLatency = true;
      const abandoned = facade;
      expect(() => inventory.readSwmAuthorInventorySnapshotV1(SCOPE_DIGEST, AUTHOR))
        .toThrowError(expect.objectContaining({ code: 'latency-budget-exceeded' }));
      expect(reopen).toHaveBeenCalledOnce();
      expect(reopen.mock.calls[0]?.[0] === abandoned).toBe(true);
      expect(reopen.mock.results[0]?.value === abandoned).toBe(false);
    } finally {
      inventory.close();
      try { database.close(); } catch { /* inventory owns the current handle */ }
    }
  });
});

function row(
  kaNumber: string,
  assertionCoordinate: string,
  shareOperationId: string,
  projectionByte: string,
  sealByte: string,
): SwmAuthorInventoryRowV1 {
  return Object.freeze({
    assertionCoordinate,
    assertionVersion: '1',
    kaUal: `did:dkg:otp:20430/${AUTHOR}/${kaNumber}`,
    shareOperationId,
    projectionDigest: `0x${projectionByte.repeat(32)}`,
    publicTripleCount: '17',
    privateTripleCount: '0',
    sealDigest: `0x${sealByte.repeat(32)}`,
    sharedAt: '1700000000000',
    expiresAt: null,
  }) as SwmAuthorInventoryRowV1;
}

function snapshot(
  rows: readonly SwmAuthorInventoryRowV1[],
  previous?: SwmAuthorInventorySnapshotV1,
  overrides: Partial<SwmAuthorInventoryHeadV1> = {},
): SwmAuthorInventorySnapshotV1 {
  const version = previous === undefined ? '0' : (BigInt(previous.head.payload.version) + 1n).toString();
  const payload = Object.freeze({
    ...SCOPE,
    version,
    previousHeadDigest: previous?.head.objectDigest ?? null,
    totalRows: rows.length.toString(),
    rowsDigest: computeSwmAuthorInventoryRowsDigestV1(rows),
    issuedAt: '1700000000200',
    ...overrides,
  }) as SwmAuthorInventoryHeadV1;
  const unsigned = Object.freeze({
    issuer: AUTHOR,
    objectType: SWM_AUTHOR_INVENTORY_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: Object.freeze({ kind: 'none' }),
    signatureSuite: 'eip191-personal-sign-digest-v1',
  }) as UnsignedSwmAuthorInventoryHeadEnvelopeV1;
  const head = Object.freeze({
    ...unsigned,
    objectDigest: computeSwmAuthorInventoryHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  }) as SignedSwmAuthorInventoryHeadEnvelopeV1;
  return Object.freeze({ head, rows: Object.freeze([...rows]) });
}

function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-swm-inventory-')));
  directories.push(directory);
  return directory;
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function latencyFaultFacade(
  database: DatabaseSync,
  afterRowsRead: () => void,
): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepare') {
        const prepare = target.prepare.bind(target);
        return (sql: string): StatementSync => {
          const statement = prepare(sql);
          if (sql !== INVENTORY_V1_STATEMENT_SQL.getSwmAuthorRows) return statement;
          return {
            all: (parameters: Record<string, unknown>) => {
              const rows = statement.all(parameters as never);
              afterRowsRead();
              return rows;
            },
          } as unknown as StatementSync;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

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
