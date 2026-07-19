import {
  mkdtempSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  ZERO_DIGEST32_V1,
  assertAuthorCatalogRowV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
  catalogKeyToBucketIdV1,
  computeAuthorCatalogBucketObjectDigestV1,
  computeAuthorCatalogDirectoryNodeObjectDigestV1,
  computeAuthorCatalogHeadObjectDigestV1,
  computeAuthorCatalogScopeDigestV1,
  deriveAuthorCatalogScopeFromHeadV1,
  verifyAuthorCatalogDirectoryPathV1,
  type AuthorCatalogBucketDescriptorV1,
  type AuthorCatalogBucketV1,
  type AuthorCatalogDirectoryNodeV1,
  type AuthorCatalogHeadV1,
  type AuthorCatalogRowV1,
  type ByteLengthV1,
  type CountV1,
  type DecimalU64V1,
  type Digest32V1,
  type KaIdV1,
  type SignedAuthorCatalogBucketEnvelopeV1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
  type VerifiedAuthorCatalogDirectoryPathV1,
} from '@origintrail-official/dkg-core';

import {
  INVENTORY_V1_DDL,
  InventoryV1CandidateError,
  openInventoryV1,
  type CandidateSessionV1,
  type Rfc64InventoryV1Foundation,
  type VerifiedCandidateBucketLoadV1,
} from '../src/rfc64/inventory-v1/index.js';
import { CandidateInventoryV1 } from '../src/rfc64/inventory-v1/candidate.js';

const AUTHOR = '0x3333333333333333333333333333333333333333';
const ISSUER = '0x5555555555555555555555555555555555555555';
const SIGNATURE = `0x${'77'.repeat(65)}`;
const temporaryDirectories: string[] = [];
const foundations: Rfc64InventoryV1Foundation[] = [];

afterEach(() => {
  for (const foundation of foundations.splice(0)) foundation.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('RFC-64 SQL-1 verified candidate buckets', () => {
  it('round-trips the positive author-bound vector, exact retry, and terminal paging', async () => {
    const inventory = await openFixtureInventory();
    expect(() => inventory.createCandidateSession()).toThrowError(
      expect.objectContaining({ code: 'candidate-startup-purge-required' }),
    );
    expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
      deletedLoads: 0,
      done: true,
    });
    const session = inventory.createCandidateSession();
    const head = makeHead('1', '1');
    const row = makeRow(1n, 'fixture');
    const load = makeNonEmptyLoad(session, head, [row]);
    expect(load.bucket?.objectDigest).toBe(
      '0xddedcd25a1fd2afb797f146b04fec735fd3b341d2f10293a1db9fd915e701866',
    );

    const inserted = inventory.putVerifiedCandidateBucket(load);
    expect(inserted.status).toBe('inserted');
    expect(inserted.header).toMatchObject({
      bucketId: '0',
      bucketCount: '1',
      rowCount: '1',
      payloadByteLength: '868',
    });
    expect(Object.keys(inventory.getCandidateBucket(inserted.loadKey))).not.toContain('rows');

    const retried = inventory.putVerifiedCandidateBucket(load);
    expect(retried.status).toBe('existing');
    expect(retried.header).toEqual(inserted.header);

    const traversal = inventory.beginCandidateBucketRows(inserted.loadKey);
    const first = inventory.pageCandidateBucketRows(traversal, null, 1);
    expect(first.rows.map((entry) => entry.row.kaId)).toEqual([row.kaId]);
    expect(first.rows[0]).toMatchObject({
      catalogKeyDigest: '0x5f49f03c5a2480a80ee4b7dadff8b7c8e18a69358bfdf64a1420dddf513de2e5',
      expectedCatalogRowDigest: '0x893392ecdfbf47fac3eb3290bc6f69b9472952439b9233555c523ed8e28f3179',
    });
    expect(first.resumeAfter).toBe(row.kaId);
    expect(inventory.pageCandidateBucketRows(traversal, first.resumeAfter, 1)).toEqual({
      rows: [],
      resumeAfter: null,
    });
    expect(() => inventory.pageCandidateBucketRows(traversal, first.resumeAfter, 1))
      .toThrowError(expect.objectContaining({ code: 'candidate-traversal-closed' }));
  });

  it('mints unforgeable row capabilities only for live pinned traversals', async () => {
    const inventory = await readyInventory();
    const otherInventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const sourceRow = makeRow(1n, 'verified-row-capability');
    const head = makeHead('1', '60');
    const loaded = inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(session, head, [sourceRow]),
    );

    const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    const page = inventory.pageCandidateBucketRows(traversal, null, 1);
    const candidate = page.rows[0];
    expect(candidate).toBeDefined();
    expect(Object.getPrototypeOf(candidate.verifiedRow)).toBeNull();
    expect(Object.isFrozen(candidate.verifiedRow)).toBe(true);
    expect(Object.keys(candidate.verifiedRow)).toEqual([]);
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.row)).toBe(true);
    expect(Object.isFrozen(candidate.row.transfer)).toBe(true);
    expect(Object.isFrozen(candidate.catalogScope)).toBe(true);
    expect(candidate.catalogScope).toEqual(deriveAuthorCatalogScopeFromHeadV1(head.payload));
    expect(computeAuthorCatalogScopeDigestV1(candidate.catalogScope))
      .toBe(candidate.header.catalogScopeDigest);

    const snapshot = inventory.readVerifiedCandidateCatalogRow(candidate.verifiedRow);
    expect(snapshot).toEqual({
      catalogScope: candidate.catalogScope,
      header: candidate.header,
      disposition: 'present',
      row: candidate.row,
      catalogKeyDigest: candidate.catalogKeyDigest,
      expectedCatalogRowDigest: candidate.expectedCatalogRowDigest,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);

    const forged = Object.freeze(Object.create(null)) as typeof candidate.verifiedRow;
    const serializedClone = JSON.parse(
      JSON.stringify(candidate.verifiedRow),
    ) as typeof candidate.verifiedRow;
    expect(() => inventory.readVerifiedCandidateCatalogRow(forged)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-row-proof' }),
    );
    expect(() => inventory.readVerifiedCandidateCatalogRow(serializedClone)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-row-proof' }),
    );
    expect(() => inventory.readVerifiedCandidateCatalogRow(
      candidate.row as unknown as typeof candidate.verifiedRow,
    )).toThrowError(expect.objectContaining({ code: 'candidate-invalid-row-proof' }));
    expect(() => otherInventory.readVerifiedCandidateCatalogRow(candidate.verifiedRow))
      .toThrowError(expect.objectContaining({ code: 'candidate-invalid-row-proof' }));

    expect(inventory.pageCandidateBucketRows(traversal, page.resumeAfter, 1)).toEqual({
      rows: [],
      resumeAfter: null,
    });
    expect(() => inventory.readVerifiedCandidateCatalogRow(candidate.verifiedRow)).toThrowError(
      expect.objectContaining({ code: 'candidate-stale-row-proof' }),
    );

    const explicitlyClosed = inventory.beginCandidateBucketRows(loaded.loadKey);
    const explicitlyClosedPage = inventory.pageCandidateBucketRows(explicitlyClosed, null, 1);
    inventory.closeCandidateTraversal(explicitlyClosed);
    expect(() => inventory.readVerifiedCandidateCatalogRow(
      explicitlyClosedPage.rows[0].verifiedRow,
    )).toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
  });

  it('reopens the low-level database, retains the opaque session, and exact-key retries', () => {
    const directory = temporaryDataDirectory();
    const path = join(directory, 'commit-retry.sqlite3');
    let database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    database.exec(INVENTORY_V1_DDL);
    let failAfterCommittedOnce = false;
    const makeFacade = (): DatabaseSync => proxyDatabase(database, {
      exec(sql, exec) {
        exec(sql);
        if (failAfterCommittedOnce && sql.trim().toUpperCase() === 'COMMIT') {
          failAfterCommittedOnce = false;
          throw new Error('injected post-COMMIT transport failure');
        }
      },
    });
    let facade = makeFacade();
    const reopen = vi.fn((abandoned: DatabaseSync) => {
      expect(abandoned).toBe(facade);
      database.close();
      database = new DatabaseSync(path);
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      facade = makeFacade();
      return facade;
    });
    const inventory = new CandidateInventoryV1(facade, reopen);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      const session = inventory.createCandidateSession();
      const firstLoad = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '1'), [makeRow(1n, 'fixture')]),
      );
      const invalidatedTraversal = inventory.beginCandidateBucketRows(firstLoad.loadKey);
      const invalidatedPage = inventory.pageCandidateBucketRows(
        invalidatedTraversal,
        null,
        1,
      );

      failAfterCommittedOnce = true;
      const retried = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '2'), [makeRow(1n, 'fixture')]),
      );
      expect(retried.status).toBe('existing');
      expect(reopen).toHaveBeenCalledOnce();
      expect(inventory.getCandidateBucket(retried.loadKey).targetCatalogHeadDigest)
        .toBe(retried.header.targetCatalogHeadDigest);
      expect(() => inventory.pageCandidateBucketRows(invalidatedTraversal, null, 1))
        .toThrowError(expect.objectContaining({ code: 'candidate-traversal-closed' }));
      expect(() => inventory.readVerifiedCandidateCatalogRow(
        invalidatedPage.rows[0].verifiedRow,
      )).toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
      expect(inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '1'), [makeRow(1n, 'fixture')]),
      ).status).toBe('existing');
    } finally {
      inventory.close();
      database.close();
    }
  });

  it('retries the exact candidate put when the failed COMMIT provably rolled back', () => {
    let failNextCommit = false;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          // Throw before COMMIT. Closing the abandoned file-backed connection
          // during verified reopen performs SQLite's rollback.
          throw new Error('injected pre-COMMIT transport failure');
        }
        exec(sql);
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      const session = inventory.createCandidateSession();
      failNextCommit = true;
      const loaded = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '30'), [makeRow(1n, 'retry')]),
      );
      expect(loaded.status).toBe('inserted');
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(fixture.database().prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
      ).get()?.count).toBe(1);
      expect(fixture.database().prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
      ).get()?.count).toBe(1);
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  for (const landed of [false, true]) {
    it(`resolves an indeterminate exact bucket delete when COMMIT ${landed ? 'landed' : 'rolled back'}`, () => {
      let failNextCommit = false;
      const fixture = createReopenableCandidateDatabase({
        exec(sql, exec) {
          if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
            failNextCommit = false;
            if (landed) exec(sql);
            throw new Error(`injected ${landed ? 'post' : 'pre'}-COMMIT failure`);
          }
          exec(sql);
        },
      });
      const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
      try {
        inventory.purgeNextStartupStaleCandidateBatch();
        const session = inventory.createCandidateSession();
        const loaded = inventory.putVerifiedCandidateBucket(
          makeNonEmptyLoad(session, makeHead('1', landed ? '31' : '32'), [makeRow(1n, 'delete')]),
        );
        failNextCommit = true;
        expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).not.toThrow();
        expect(fixture.reopen).toHaveBeenCalledOnce();
        expect(fixture.database().prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
        ).get()?.count).toBe(0);
        expect(fixture.database().prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
        ).get()?.count).toBe(0);
      } finally {
        inventory.close();
        fixture.close();
      }
    });
  }

  it('retries only the original startup purge keys after an indeterminate COMMIT', () => {
    let failNextCommit = true;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          throw new Error('injected purge COMMIT failure');
        }
        exec(sql);
      },
      afterReopen(database) {
        insertRawEmptyHeader(database, 0x01);
      },
    });
    for (let sessionByte = 0x10; sessionByte <= 0x19; sessionByte += 1) {
      insertRawEmptyHeader(fixture.database(), sessionByte);
    }
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 8,
        done: false,
      });
      expect(fixture.reopen).toHaveBeenCalledOnce();
      const remaining = fixture.database().prepare(`
        SELECT hex(session_id) AS session_hex
        FROM rfc64_candidate_bucket_loads_v1
        ORDER BY session_id
      `).all().map((row) => row.session_hex);
      expect(remaining).toEqual([
        rawSessionHex(0x01),
        rawSessionHex(0x18),
        rawSessionHex(0x19),
      ]);
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('fails closed when an indeterminate purge resolves to a mixed original key set', () => {
    let failNextCommit = true;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        exec(sql);
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          throw new Error('injected post-COMMIT purge failure');
        }
      },
      afterReopen(database) {
        insertRawEmptyHeader(database, 0x10);
      },
    });
    insertRawEmptyHeader(fixture.database(), 0x10);
    insertRawEmptyHeader(fixture.database(), 0x11);
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'candidate-database-corrupt' }),
      );
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(() => inventory.createCandidateSession()).toThrowError(
        expect.objectContaining({ code: 'candidate-startup-purge-required' }),
      );
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('forces verified reopen whenever rollback itself reports failure', () => {
    let failPrepare = true;
    let abandonedRollbackAttempted = false;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        if (sql.trim().toUpperCase() === 'ROLLBACK') {
          abandonedRollbackAttempted = true;
          // Throw before executing ROLLBACK. Verified reopen must close this
          // transaction and return a genuinely new file-backed handle.
          throw new Error('injected rollback failure before execution');
        }
        exec(sql);
      },
      prepare(sql, prepare) {
        if (failPrepare && sql.includes('FROM rfc64_candidate_bucket_loads_v1')) {
          failPrepare = false;
          throw new Error('injected operation failure');
        }
        return prepare(sql);
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'candidate-database-error' }),
      );
      expect(abandonedRollbackAttempted).toBe(true);
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(fixture.didReturnDistinctHandle()).toBe(true);
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('resolves poisoned-session discard against the original exact keys before invalidation', () => {
    let failNextCommit = false;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          throw new Error('injected discard COMMIT failure');
        }
        exec(sql);
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      inventory.purgeNextStartupStaleCandidateBatch();
      const session = inventory.createCandidateSession();
      const head = makeHead('2', '34', '2');
      const [original, conflict] = makeBoundNonEmptyLoads(session, head, [
        {
          bucketId: '0',
          rows: [rowForBucket('0', '2', 1n, 'same-coordinate')],
        },
        {
          bucketId: '1',
          rows: [rowForBucket('1', '2', 2n, 'same-coordinate')],
        },
      ]);
      inventory.putVerifiedCandidateBucket(original);
      expect(() => inventory.putVerifiedCandidateBucket(conflict)).toThrowError(
        expect.objectContaining({ code: 'candidate-conflict' }),
      );

      failNextCommit = true;
      expect(inventory.discardCandidateSessionBatch(session)).toEqual({
        deletedLoads: 1,
        done: false,
      });
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(inventory.discardCandidateSessionBatch(session)).toEqual({
        deletedLoads: 0,
        done: true,
      });
      expect(() => inventory.discardCandidateSessionBatch(session)).toThrowError(
        expect.objectContaining({ code: 'candidate-invalid-session' }),
      );
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('returns a known committed put even when its mandatory post-overrun reopen fails', () => {
    let now = 0;
    let overrunNextCommit = false;
    let failReopen = false;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        exec(sql);
        if (overrunNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          overrunNextCommit = false;
          now += 10_001;
        }
      },
      failReopen() {
        return failReopen;
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, () => now);
    try {
      inventory.purgeNextStartupStaleCandidateBatch();
      const session = inventory.createCandidateSession();
      overrunNextCommit = true;
      failReopen = true;
      const result = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '35'), [makeRow(1n, 'known-commit')]),
      );
      expect(result.status).toBe('inserted');
      expect(inventory.committedOverruns).toBe(1);
      expect(fixture.reopen).toHaveBeenCalledOnce();
      const inspector = openFileDatabase(fixture.path, false);
      try {
        expect(inspector.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
        ).get()?.count).toBe(1);
      } finally {
        inspector.close();
      }
      expect(() => inventory.getCandidateBucket(result.loadKey)).toThrowError(
        /unavailable after failed verified reopen/,
      );
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('discards a read on COMMIT failure and reopens before accepting its retry', () => {
    let failNextCommit = false;
    const fixture = createReopenableCandidateDatabase({
      exec(sql, exec) {
        if (failNextCommit && sql.trim().toUpperCase() === 'COMMIT') {
          failNextCommit = false;
          throw new Error('injected read COMMIT failure');
        }
        exec(sql);
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      const session = inventory.createCandidateSession();
      const inserted = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '1'), [makeRow(1n, 'fixture')]),
      );
      const invalidatedTraversal = inventory.beginCandidateBucketRows(inserted.loadKey);

      failNextCommit = true;
      expect(() => inventory.getCandidateBucket(inserted.loadKey)).toThrowError(
        /read COMMIT failed after verified reopen/,
      );
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(() => inventory.pageCandidateBucketRows(invalidatedTraversal, null, 1))
        .toThrowError(expect.objectContaining({ code: 'candidate-traversal-closed' }));
      expect(inventory.getCandidateBucket(inserted.loadKey)).toEqual(inserted.header);
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  for (const failAfterInsert of [1, 2, 3]) {
    it(`rolls back atomically after injected candidate insert ${failAfterInsert}`, () => {
      const database = new DatabaseSync(':memory:');
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      database.exec(INVENTORY_V1_DDL);
      let insertions = 0;
      let armed = false;
      const facade = {
        exec: database.exec.bind(database),
        prepare(sql: string): StatementSync {
          const statement = database.prepare(sql);
          if (!/^\s*INSERT INTO rfc64_candidate_bucket_(?:loads|rows)_v1/i.test(sql)) {
            return statement;
          }
          return new Proxy(statement, {
            get(target, property) {
              if (property === 'run') {
                return (...args: unknown[]) => {
                  const result = Reflect.apply(target.run, target, args);
                  insertions += 1;
                  if (armed && insertions === failAfterInsert) {
                    throw new Error(`injected death after insert ${failAfterInsert}`);
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      } as unknown as DatabaseSync;
      const inventory = new CandidateInventoryV1(facade, unexpectedReopen);
      try {
        expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
          deletedLoads: 0,
          done: true,
        });
        const session = inventory.createCandidateSession();
        const load = makeNonEmptyLoad(
          session,
          makeHead('2', String(failAfterInsert + 2)),
          [makeRow(1n, 'fixture-1'), makeRow(2n, 'fixture-2')],
        );
        armed = true;
        expect(() => inventory.putVerifiedCandidateBucket(load)).toThrowError(
          expect.objectContaining({ code: 'candidate-database-error' }),
        );
        expect(database.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
        ).get()?.count).toBe(0);
        expect(database.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
        ).get()?.count).toBe(0);

        armed = false;
        insertions = 0;
        expect(inventory.putVerifiedCandidateBucket(load).status).toBe('inserted');
        expect(database.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
        ).get()?.count).toBe(2);
      } finally {
        inventory.close();
        database.close();
      }
    });
  }

  for (const constraint of [
    { label: 'CHECK', errcode: 275, code: 'SQLITE_CONSTRAINT_CHECK' },
    { label: 'FOREIGN KEY', errcode: 787, code: 'SQLITE_CONSTRAINT_FOREIGNKEY' },
  ] as const) {
    it(`does not poison a session for a ${constraint.label} constraint failure`, () => {
      const database = new DatabaseSync(':memory:');
      database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      database.exec(INVENTORY_V1_DDL);
      let injectConstraint = false;
      const facade = proxyDatabase(database, {
        prepare(sql, prepare) {
          const statement = prepare(sql);
          if (!/^\s*INSERT INTO rfc64_candidate_bucket_loads_v1/i.test(sql)) return statement;
          return new Proxy(statement, {
            get(target, property) {
              if (property !== 'run') return Reflect.get(target, property, target);
              const run = target.run.bind(target);
              return (...parameters: Parameters<StatementSync['run']>) => {
                if (injectConstraint) {
                  injectConstraint = false;
                  const error = new Error(`${constraint.label} constraint failed: injected`) as Error & {
                    code: string;
                    errcode: number;
                  };
                  error.code = constraint.code;
                  error.errcode = constraint.errcode;
                  throw error;
                }
                return run(...parameters);
              };
            },
          });
        },
      });
      const inventory = new CandidateInventoryV1(facade, unexpectedReopen);
      try {
        inventory.purgeNextStartupStaleCandidateBatch();
        const session = inventory.createCandidateSession();
        const load = makeNonEmptyLoad(
          session,
          makeHead('1', constraint.errcode === 275 ? '42' : '43'),
          [makeRow(1n, constraint.label)],
        );
        injectConstraint = true;
        expect(() => inventory.putVerifiedCandidateBucket(load)).toThrowError(
          expect.objectContaining({ code: 'candidate-database-error' }),
        );
        expect(inventory.putVerifiedCandidateBucket(load).status).toBe('inserted');
      } finally {
        inventory.close();
        database.close();
      }
    });
  }

  it('refuses a cascade when stored children exceed the committed header count', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    database.exec(INVENTORY_V1_DDL);
    const inventory = new CandidateInventoryV1(database, unexpectedReopen);
    try {
      inventory.purgeNextStartupStaleCandidateBatch();
      const session = inventory.createCandidateSession();
      const loaded = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '20'), [makeRow(1n, 'fixture')]),
      );
      database.exec(`
        INSERT INTO rfc64_candidate_bucket_rows_v1
        SELECT
          session_id,
          catalog_scope_digest,
          author_address,
          target_catalog_head_digest,
          bucket_id_u64be,
          x'${AUTHOR.slice(2)}000000000000000000000002',
          x'${'cc'.repeat(32)}',
          'tampered-extra-child',
          assertion_version_u64be,
          projection_id,
          projection_digest,
          seal_digest,
          transfer_codec,
          transfer_byte_length_u64be,
          transfer_chunk_size_u64be,
          transfer_chunk_count_u64be,
          transfer_blob_digest,
          transfer_chunk_tree_root,
          x'${'dd'.repeat(32)}'
        FROM rfc64_candidate_bucket_rows_v1;
      `);
      expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).toThrowError(
        expect.objectContaining({ code: 'candidate-database-corrupt' }),
      );
      expect(database.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
      ).get()?.count).toBe(1);
      expect(database.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
      ).get()?.count).toBe(2);
    } finally {
      inventory.close();
      database.close();
    }
  });

  it('rejects a traversal before pinning when actual children exceed the verified header count', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    database.exec(INVENTORY_V1_DDL);
    const inventory = new CandidateInventoryV1(database, unexpectedReopen);
    try {
      inventory.purgeNextStartupStaleCandidateBatch();
      const session = inventory.createCandidateSession();
      const loaded = inventory.putVerifiedCandidateBucket(
        makeNonEmptyLoad(session, makeHead('1', '33'), [makeRow(1n, 'fixture')]),
      );
      insertTamperedExtraChild(database);
      expect(() => inventory.beginCandidateBucketRows(loaded.loadKey)).toThrowError(
        expect.objectContaining({ code: 'candidate-database-corrupt' }),
      );
      // No traversal was registered or pinned before the exact count check.
      expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).toThrowError(
        expect.objectContaining({ code: 'candidate-database-corrupt' }),
      );
    } finally {
      inventory.close();
      database.close();
    }
  });

  it('distinguishes a canonical empty bucket from an absent header and cascades deletion', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const head = makeHead('0', '2');
    const loaded = inventory.putVerifiedCandidateBucket(makeEmptyLoad(session, head, '0'));
    expect(loaded.header).toMatchObject({
      bucketObjectDigest: ZERO_DIGEST32_V1,
      rowCount: '0',
      payloadByteLength: '0',
    });
    const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    expect(inventory.pageCandidateBucketRows(traversal, undefined, 256)).toEqual({
      rows: [],
      resumeAfter: null,
    });
    inventory.deleteCandidateBucket(loaded.loadKey);
    expect(() => inventory.getCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-not-loaded' }),
    );
    expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-not-loaded' }),
    );
  });

  it('poisons a conflicting session and permits only bounded discard until terminal empty', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const head = makeHead('2', '3', '2');
    const [original, mutation] = makeBoundNonEmptyLoads(session, head, [
      {
        bucketId: '0',
        rows: [rowForBucket('0', '2', 1n, 'same-coordinate')],
      },
      {
        bucketId: '1',
        rows: [rowForBucket('1', '2', 2n, 'same-coordinate')],
      },
    ]);
    const loaded = inventory.putVerifiedCandidateBucket(original);
    const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    const verifiedPage = inventory.pageCandidateBucketRows(traversal, null, 1);

    expect(() => inventory.putVerifiedCandidateBucket(mutation)).toThrowError(
      expect.objectContaining({ code: 'candidate-conflict' }),
    );
    expect(() => inventory.readVerifiedCandidateCatalogRow(
      verifiedPage.rows[0].verifiedRow,
    )).toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
    expect(() => inventory.getCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
    expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
    expect(inventory.discardCandidateSessionBatch(session)).toEqual({
      deletedLoads: 1,
      done: false,
    });
    expect(inventory.discardCandidateSessionBatch(session)).toEqual({
      deletedLoads: 0,
      done: true,
    });
    expect(() => inventory.discardCandidateSessionBatch(session)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-session' }),
    );
  });

  it('poisons cross-bucket assertion-coordinate uniqueness conflicts atomically', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const head = makeHead('2', '4', '2');
    const bucket0Row = rowForBucket('0', '2', 1n, 'same-coordinate');
    const bucket1Row = rowForBucket('1', '2', 2n, 'same-coordinate');
    const [bucket0, bucket1] = makeBoundNonEmptyLoads(session, head, [
      { bucketId: '0', rows: [bucket0Row] },
      { bucketId: '1', rows: [bucket1Row] },
    ]);
    const first = inventory.putVerifiedCandidateBucket(bucket0);
    expect(() => inventory.putVerifiedCandidateBucket(bucket1)).toThrowError(
      expect.objectContaining({ code: 'candidate-conflict' }),
    );
    expect(() => inventory.getCandidateBucket(first.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
  });

  it('reports poison before malformed puts and before closed rows or either diff stream', async () => {
    const inventory = await readyInventory();
    const oldSession = inventory.createCandidateSession();
    const poisonedSession = inventory.createCandidateSession();
    const oldHead = makeHead('1', '40', '2');
    const newHead = makeHead('2', '41', '2');
    const oldLoad = inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(
        oldSession,
        oldHead,
        [rowForBucket('0', '2', 1n, 'old')],
        '0',
      ),
    );
    const [newLoadInput, conflictingLoadInput] = makeBoundNonEmptyLoads(
      poisonedSession,
      newHead,
      [
        {
          bucketId: '0',
          rows: [rowForBucket('0', '2', 2n, 'same-coordinate')],
        },
        {
          bucketId: '1',
          rows: [rowForBucket('1', '2', 3n, 'same-coordinate')],
        },
      ],
    );
    const newLoad = inventory.putVerifiedCandidateBucket(newLoadInput);
    const rows = inventory.beginCandidateBucketRows(newLoad.loadKey);
    const diff = inventory.beginCandidateBucketDiff(oldLoad.loadKey, newLoad.loadKey);

    expect(() => inventory.putVerifiedCandidateBucket(conflictingLoadInput)).toThrowError(
      expect.objectContaining({ code: 'candidate-conflict' }),
    );

    expect(() => inventory.putVerifiedCandidateBucket({
      session: poisonedSession,
      head: null,
      directoryPath: null,
      bucket: null,
    } as unknown as VerifiedCandidateBucketLoadV1)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
    expect(() => inventory.pageCandidateBucketRows(rows, null, 1)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
    expect(() => inventory.pageCandidateBucketAddedOrChanged(diff, null, 1)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
    expect(() => inventory.pageCandidateBucketRemoved(diff, null, 1)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-poisoned' }),
    );
  });

  it('pages added/changed and removed streams independently to terminal empty pages', async () => {
    const inventory = await readyInventory();
    const oldSession = inventory.createCandidateSession();
    const newSession = inventory.createCandidateSession();
    const oldHead = makeHead('3', '5');
    const newHead = makeHead('3', '6');
    const one = makeRow(1n, 'one');
    const two = makeRow(2n, 'two');
    const three = makeRow(3n, 'three');
    const changedTwo = makeRow(2n, 'two', '99');
    const four = makeRow(4n, 'four');
    const oldLoad = inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(oldSession, oldHead, [one, two, three]),
    );
    const newLoad = inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(newSession, newHead, [one, changedTwo, four]),
    );
    const traversal = inventory.beginCandidateBucketDiff(oldLoad.loadKey, newLoad.loadKey);

    const added1 = inventory.pageCandidateBucketAddedOrChanged(traversal, null, 1);
    expect(added1.rows.map((entry) => entry.row.kaId)).toEqual([two.kaId]);
    const added2 = inventory.pageCandidateBucketAddedOrChanged(
      traversal,
      added1.resumeAfter,
      1,
    );
    expect(added2.rows.map((entry) => entry.row.kaId)).toEqual([four.kaId]);
    expect(inventory.pageCandidateBucketAddedOrChanged(
      traversal,
      added2.resumeAfter,
      1,
    )).toEqual({ rows: [], resumeAfter: null });
    expect(inventory.readVerifiedCandidateCatalogRow(added1.rows[0].verifiedRow))
      .toMatchObject({
        disposition: 'present',
        header: { targetCatalogHeadDigest: newLoad.header.targetCatalogHeadDigest },
      });

    const removed = inventory.pageCandidateBucketRemoved(traversal, null, 1);
    expect(removed.rows.map((entry) => entry.row.kaId)).toEqual([three.kaId]);
    expect(removed.rows[0]).toMatchObject({
      disposition: 'removed',
      header: { targetCatalogHeadDigest: oldLoad.header.targetCatalogHeadDigest },
    });
    expect(added1.rows[0]).toMatchObject({
      disposition: 'present',
      header: { targetCatalogHeadDigest: newLoad.header.targetCatalogHeadDigest },
    });
    expect(inventory.pageCandidateBucketRemoved(traversal, removed.resumeAfter, 1)).toEqual({
      rows: [],
      resumeAfter: null,
    });
    expect(() => inventory.readVerifiedCandidateCatalogRow(added1.rows[0].verifiedRow))
      .toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
    expect(() => inventory.readVerifiedCandidateCatalogRow(removed.rows[0].verifiedRow))
      .toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
  });

  it('pins loads, rejects cursor skipping, and releases pins on explicit early close', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const head = makeHead('2', '7');
    const loaded = inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(session, head, [makeRow(1n, 'one'), makeRow(2n, 'two')]),
    );
    const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    const first = inventory.pageCandidateBucketRows(traversal, null, 1);
    expect(() => inventory.deleteCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-in-use' }),
    );
    expect(() => inventory.pageCandidateBucketRows(traversal, makeRow(2n, 'x').kaId, 1))
      .toThrowError(expect.objectContaining({ code: 'candidate-cursor-mismatch' }));
    expect(() => inventory.readVerifiedCandidateCatalogRow(first.rows[0].verifiedRow))
      .toThrowError(expect.objectContaining({ code: 'candidate-stale-row-proof' }));
    expect(() => inventory.pageCandidateBucketRows(traversal, first.resumeAfter, 1))
      .toThrowError(expect.objectContaining({ code: 'candidate-traversal-closed' }));

    const secondTraversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    inventory.closeCandidateTraversal(secondTraversal);
    inventory.closeCandidateTraversal(secondTraversal);
    inventory.deleteCandidateBucket(loaded.loadKey);
  });

  it('purges startup-stale loads in fixed batches of eight plus a terminal empty call', async () => {
    const dataDirectory = temporaryDataDirectory();
    const first = await openInventoryV1(dataDirectory);
    expect(first.purgeNextStartupStaleCandidateBatch()).toEqual({ deletedLoads: 0, done: true });
    const session = first.createCandidateSession();
    const head = makeHead('0', '8', '16');
    for (let bucket = 0; bucket < 9; bucket += 1) {
      first.putVerifiedCandidateBucket(makeEmptyLoad(session, head, String(bucket)));
    }
    first.close();

    const reopened = await openInventoryV1(dataDirectory);
    foundations.push(reopened);
    expect(() => reopened.createCandidateSession()).toThrowError(
      expect.objectContaining({ code: 'candidate-startup-purge-required' }),
    );
    expect(reopened.purgeNextStartupStaleCandidateBatch()).toEqual({
      deletedLoads: 8,
      done: false,
    });
    expect(reopened.purgeNextStartupStaleCandidateBatch()).toEqual({
      deletedLoads: 1,
      done: false,
    });
    expect(reopened.purgeNextStartupStaleCandidateBatch()).toEqual({
      deletedLoads: 0,
      done: true,
    });
    expect(() => reopened.createCandidateSession()).not.toThrow();
  });

  it('rebuilds after database deletion and rejects every old process-local capability', async () => {
    const dataDirectory = temporaryDataDirectory();
    const first = await readyInventoryAt(dataDirectory);
    const oldSession = first.createCandidateSession();
    const loaded = first.putVerifiedCandidateBucket(
      makeNonEmptyLoad(oldSession, makeHead('1', '41'), [makeRow(41n, 'deleted-db')]),
    );
    const oldTraversal = first.beginCandidateBucketRows(loaded.loadKey);
    const databasePath = first.databasePath;
    first.close();
    rmSync(databasePath, { force: true });
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });

    const rebuilt = await openFixtureInventory(dataDirectory);
    expect(rebuilt.purgeNextStartupStaleCandidateBatch()).toEqual({
      deletedLoads: 0,
      done: true,
    });
    expect(() => rebuilt.getCandidateBucket(loaded.loadKey)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-load-key' }),
    );
    expect(() => rebuilt.pageCandidateBucketRows(oldTraversal, null, 1)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-traversal' }),
    );
    expect(() => rebuilt.putVerifiedCandidateBucket(
      makeNonEmptyLoad(oldSession, makeHead('1', '42'), [makeRow(42n, 'old-session')]),
    )).toThrowError(expect.objectContaining({ code: 'candidate-invalid-session' }));
    expect(() => first.purgeNextStartupStaleCandidateBatch()).toThrowError(
      expect.objectContaining({ code: 'database-closed' }),
    );

    const freshSession = rebuilt.createCandidateSession();
    expect(rebuilt.putVerifiedCandidateBucket(
      makeNonEmptyLoad(freshSession, makeHead('1', '43'), [makeRow(43n, 'fresh-session')]),
    ).status).toBe('inserted');
  });

  it('rejects duplicate KA/key input and a row mapped to the wrong bucket', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    const duplicate = rowForBucket('0', '2', 1n, 'duplicate-ka');
    expect(() => inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(session, makeHead('2', '44', '2'), [duplicate, duplicate], '0', false),
    )).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));

    const wrongBucket = rowForBucket('0', '2', 10_000n, 'wrong-bucket');
    expect(() => inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(session, makeHead('1', '45', '2'), [wrongBucket], '1', false),
    )).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));
  });

  for (const malformed of [
    { label: 'type', sql: "UPDATE rfc64_candidate_bucket_rows_v1 SET ka_id_u256be = 'text'" },
    { label: 'width', sql: 'UPDATE rfc64_candidate_bucket_rows_v1 SET ka_id_u256be = zeroblob(31)' },
    { label: 'null', sql: 'UPDATE rfc64_candidate_bucket_rows_v1 SET ka_id_u256be = NULL' },
  ] as const) {
    it(`fails closed on a malformed stored ${malformed.label}`, () => {
      const database = createLaxCandidateDatabase();
      const inventory = new CandidateInventoryV1(database, unexpectedReopen);
      try {
        expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
          deletedLoads: 0,
          done: true,
        });
        const session = inventory.createCandidateSession();
        const loaded = inventory.putVerifiedCandidateBucket(
          makeNonEmptyLoad(session, makeHead('1', '46'), [makeRow(46n, 'malformed')]),
        );
        database.exec(malformed.sql);
        const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
        expect(() => inventory.pageCandidateBucketRows(traversal, null, 1)).toThrowError(
          expect.objectContaining({ code: 'candidate-database-corrupt' }),
        );
      } finally {
        inventory.close();
        database.close();
      }
    });
  }

  it('rejects forged, cloned, serialized, wrong-head, and wrong-bucket directory proofs', async () => {
    const inventory = await readyInventory();
    const session = inventory.createCandidateSession();
    expect(() => inventory.discardCandidateSessionBatch(session)).toThrowError(
      expect.objectContaining({ code: 'candidate-session-not-poisoned' }),
    );
    expect(() => inventory.putVerifiedCandidateBucket({
      ...makeEmptyLoad(session, makeHead('0', '9'), '0'),
      session: Object.freeze({}) as CandidateSessionV1,
    })).toThrowError(expect.objectContaining({ code: 'candidate-invalid-session' }));

    const head = makeHead('2', '10', '2');
    const [bucket0, bucket1] = makeBoundNonEmptyLoads(session, head, [
      { bucketId: '0', rows: [rowForBucket('0', '2', 1n, 'bucket-zero')] },
      { bucketId: '1', rows: [rowForBucket('1', '2', 2n, 'bucket-one')] },
    ]);
    const invalidDirectoryProofs: readonly [string, unknown][] = [
      ['forged/cast object', Object.freeze(Object.create(null))],
      ['spread clone', { ...bucket0.directoryPath }],
      ['JSON roundtrip', JSON.parse(JSON.stringify(bucket0.directoryPath))],
      ['serialized token', JSON.stringify(bucket0.directoryPath)],
    ];
    for (const [label, directoryPath] of invalidDirectoryProofs) {
      expect(
        () => inventory.putVerifiedCandidateBucket({
          ...bucket0,
          directoryPath,
        } as VerifiedCandidateBucketLoadV1),
        label,
      ).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));
    }

    const otherHeadLoad = makeNonEmptyLoad(
      session,
      makeHead('1', '11'),
      [makeRow(3n, 'other-head')],
    );
    expect(() => inventory.putVerifiedCandidateBucket({
      ...bucket0,
      head: otherHeadLoad.head,
    })).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));
    expect(() => inventory.putVerifiedCandidateBucket({
      ...bucket0,
      directoryPath: bucket1.directoryPath,
    })).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));

    const unboundRow = {
      ...makeRow(1n, 'fixture'),
      kaId: '1',
    } as AuthorCatalogRowV1;
    expect(() => inventory.putVerifiedCandidateBucket(
      makeNonEmptyLoad(session, makeHead('1', '12'), [unboundRow]),
    )).toThrowError(expect.objectContaining({ code: 'candidate-invalid-load' }));
    const loaded = inventory.putVerifiedCandidateBucket(bucket0);
    const traversal = inventory.beginCandidateBucketRows(loaded.loadKey);
    expect(() => inventory.pageCandidateBucketRows(traversal, null, 0)).toThrowError(
      expect.objectContaining({ code: 'candidate-invalid-load' }),
    );
  });
});

async function openFixtureInventory(dataDirectory = temporaryDataDirectory()) {
  const inventory = await openInventoryV1(dataDirectory);
  foundations.push(inventory);
  return inventory;
}

async function readyInventory() {
  return readyInventoryAt(temporaryDataDirectory());
}

async function readyInventoryAt(dataDirectory: string) {
  const inventory = await openFixtureInventory(dataDirectory);
  expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
    deletedLoads: 0,
    done: true,
  });
  return inventory;
}

function temporaryDataDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-candidate-')));
  temporaryDirectories.push(directory);
  return directory;
}

function makeHead(
  totalRows: CountV1 | string,
  version: DecimalU64V1 | string,
  bucketCount: CountV1 | string = '1',
): SignedAuthorCatalogHeadEnvelopeV1 {
  const payload: AuthorCatalogHeadV1 = {
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/catalog-fixture',
    governanceChainId: '20430',
    governanceContractAddress: '0x2222222222222222222222222222222222222222',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: AUTHOR,
    catalogIssuerDelegationDigest: `0x${'66'.repeat(32)}`,
    era: '0',
    version,
    previousHeadDigest: null,
    bucketCount,
    totalRows,
    directoryHeight: '0',
    directoryRootDigest: `0x${String(version).padStart(2, '0').slice(-2).repeat(32)}`,
    issuedAt: String(1_700_000_000_000n + BigInt(version)),
  } as AuthorCatalogHeadV1;
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const signed = {
    ...unsigned,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsigned),
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(signed);
  return signed;
}

function makeRow(
  number: bigint,
  assertionCoordinate: string,
  projectionByte = '00',
): AuthorCatalogRowV1 {
  const row = {
    kaId: ((BigInt(AUTHOR) << 96n) | number).toString(),
    assertionCoordinate,
    assertionVersion: '1',
    projectionId: KA_TRANSFER_PROJECTION_V1,
    projectionDigest: `0x${projectionByte.repeat(32)}`,
    sealDigest: `0x${'44'.repeat(32)}`,
    transfer: {
      codec: KA_TRANSFER_CODEC_V1,
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: `0x${projectionByte.repeat(32)}`,
      byteLength: '16',
      chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
      chunkCount: '1',
      blobDigest: `0x${'11'.repeat(32)}`,
      chunkTreeRoot: `0x${'22'.repeat(32)}`,
    },
  } as unknown as AuthorCatalogRowV1;
  assertAuthorCatalogRowV1(row);
  return row;
}

function rowForBucket(
  bucketId: string,
  bucketCount: string,
  start: bigint,
  coordinate: string,
): AuthorCatalogRowV1 {
  for (let number = start; number < start + 100_000n; number += 1n) {
    const row = makeRow(number, coordinate);
    if (catalogKeyToBucketIdV1(row.kaId, bucketCount as CountV1) === bucketId) return row;
  }
  throw new Error(`unable to find fixture row for bucket ${bucketId}`);
}

function makeNonEmptyLoad(
  session: CandidateSessionV1,
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  rows: readonly AuthorCatalogRowV1[],
  bucketId = '0',
  validate = true,
): VerifiedCandidateBucketLoadV1 {
  const fixture = makeSignedBucketFixture(headTemplate, rows, bucketId, validate);
  const { head, directoryPath } = bindHeadToSelectedDescriptor(
    headTemplate,
    fixture.descriptor,
  );
  return {
    session,
    head,
    directoryPath,
    bucket: fixture.bucket,
  };
}

function makeBoundNonEmptyLoads(
  session: CandidateSessionV1,
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  specifications: readonly {
    readonly bucketId: string;
    readonly rows: readonly AuthorCatalogRowV1[];
    readonly validate?: boolean;
  }[],
): readonly VerifiedCandidateBucketLoadV1[] {
  const bucketCount = Number(BigInt(headTemplate.payload.bucketCount));
  const descriptors = Array.from(
    { length: bucketCount },
    (_, bucketId) => emptyDescriptor(bucketId),
  );
  const fixtures = specifications.map((specification) => makeSignedBucketFixture(
    headTemplate,
    specification.rows,
    specification.bucketId,
    specification.validate ?? true,
  ));
  const occupied = new Set<number>();
  let totalRows = 0n;
  for (const fixture of fixtures) {
    const bucketId = Number(BigInt(fixture.descriptor.bucketId));
    if (bucketId < 0 || bucketId >= bucketCount || occupied.has(bucketId)) {
      throw new Error('invalid or duplicate bound bucket fixture');
    }
    occupied.add(bucketId);
    descriptors[bucketId] = fixture.descriptor;
    totalRows += BigInt(fixture.descriptor.rowCount);
  }
  if (totalRows !== BigInt(headTemplate.payload.totalRows)) {
    throw new Error('bound bucket fixture rows do not equal head totalRows');
  }
  const bindings = fixtures.map((fixture) => bindHeadToDirectory(
    headTemplate,
    descriptors,
    fixture.descriptor.bucketId,
  ));
  return fixtures.map((fixture, index) => ({
    session,
    head: bindings[0].head,
    directoryPath: bindings[index].directoryPath,
    bucket: fixture.bucket,
  }));
}

function makeSignedBucketFixture(
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  rows: readonly AuthorCatalogRowV1[],
  bucketId: string,
  validate: boolean,
): {
  readonly bucket: SignedAuthorCatalogBucketEnvelopeV1;
  readonly descriptor: AuthorCatalogBucketDescriptorV1;
} {
  const scope = deriveAuthorCatalogScopeFromHeadV1(headTemplate.payload);
  const payload: AuthorCatalogBucketV1 = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    era: scope.era,
    bucketCount: scope.bucketCount,
    bucketId,
    rows,
  } as AuthorCatalogBucketV1;
  const unsigned = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const bucket = {
    ...unsigned,
    objectDigest: validate
      ? computeAuthorCatalogBucketObjectDigestV1(unsigned)
      : `0x${'ab'.repeat(32)}`,
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  if (validate) assertSignedAuthorCatalogBucketEnvelopeV1(bucket);
  const descriptor = {
    bucketId: bucketId as DecimalU64V1,
    rowCount: String(rows.length) as CountV1,
    byteLength: (validate
      ? String(canonicalizeAuthorCatalogBucketPayloadBytesV1(payload).byteLength)
      : '1') as ByteLengthV1,
    bucketDigest: bucket.objectDigest as Digest32V1,
  } satisfies AuthorCatalogBucketDescriptorV1;
  return {
    bucket: bucket as SignedAuthorCatalogBucketEnvelopeV1,
    descriptor,
  };
}

function makeEmptyLoad(
  session: CandidateSessionV1,
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  bucketId: string,
): VerifiedCandidateBucketLoadV1 {
  const { head, directoryPath } = bindHeadToSelectedDescriptor(headTemplate, {
    bucketId: bucketId as DecimalU64V1,
    rowCount: '0' as CountV1,
    byteLength: '0' as ByteLengthV1,
    bucketDigest: ZERO_DIGEST32_V1,
  });
  return {
    session,
    head,
    directoryPath,
    bucket: null,
  };
}

function bindHeadToSelectedDescriptor(
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  selected: AuthorCatalogBucketDescriptorV1,
): {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly directoryPath: VerifiedAuthorCatalogDirectoryPathV1;
} {
  const bucketCount = Number(BigInt(headTemplate.payload.bucketCount));
  const selectedBucket = Number(BigInt(selected.bucketId));
  const totalRows = BigInt(headTemplate.payload.totalRows);
  const selectedRows = BigInt(selected.rowCount);
  if (selectedBucket < 0 || selectedBucket >= bucketCount || selectedRows > totalRows) {
    throw new Error('invalid selected descriptor fixture');
  }
  let remainingRows = totalRows - selectedRows;
  const descriptors = Array.from({ length: bucketCount }, (_, index) => {
    if (index === selectedBucket) return selected;
    if (remainingRows > 0n) {
      const rowCount = remainingRows;
      remainingRows = 0n;
      return placeholderDescriptor(index, rowCount);
    }
    return emptyDescriptor(index);
  });
  if (remainingRows !== 0n) throw new Error('unable to allocate fixture directory rows');
  return bindHeadToDirectory(headTemplate, descriptors, selected.bucketId);
}

function bindHeadToDirectory(
  headTemplate: SignedAuthorCatalogHeadEnvelopeV1,
  descriptors: readonly AuthorCatalogBucketDescriptorV1[],
  selectedBucketId: DecimalU64V1,
): {
  readonly head: SignedAuthorCatalogHeadEnvelopeV1;
  readonly directoryPath: VerifiedAuthorCatalogDirectoryPathV1;
} {
  const scope = deriveAuthorCatalogScopeFromHeadV1(headTemplate.payload);
  const node: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    entries: descriptors,
    era: scope.era,
    firstBucketId: '0',
    level: '0',
  };
  const unsignedDirectory = {
    issuer: ISSUER,
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: node,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as UnsignedControlEnvelopeV1;
  const signedDirectory = {
    ...unsignedDirectory,
    objectDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(
      unsignedDirectory,
      scope.bucketCount,
    ),
    signature: SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(signedDirectory, scope.bucketCount);
  const directory = signedDirectory as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const unsignedHead = {
    issuer: headTemplate.issuer,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: {
      ...headTemplate.payload,
      directoryRootDigest: directory.objectDigest,
    },
    signatureEvidence: headTemplate.signatureEvidence,
    signatureSuite: headTemplate.signatureSuite,
  } as UnsignedControlEnvelopeV1;
  const signedHead = {
    ...unsignedHead,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsignedHead),
    signature: headTemplate.signature,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(signedHead);
  const head = signedHead as SignedAuthorCatalogHeadEnvelopeV1;
  return {
    head,
    directoryPath: verifyAuthorCatalogDirectoryPathV1(
      head,
      [directory],
      selectedBucketId,
    ),
  };
}

function emptyDescriptor(bucketId: number): AuthorCatalogBucketDescriptorV1 {
  return {
    bucketDigest: ZERO_DIGEST32_V1,
    bucketId: String(bucketId) as DecimalU64V1,
    byteLength: '0',
    rowCount: '0',
  };
}

function placeholderDescriptor(
  bucketId: number,
  rowCount: bigint,
): AuthorCatalogBucketDescriptorV1 {
  if (rowCount < 1n || rowCount > 1024n) throw new Error('invalid placeholder row count');
  const byte = (0x80 + bucketId).toString(16).padStart(2, '0');
  return {
    bucketDigest: `0x${byte.repeat(32)}` as Digest32V1,
    bucketId: String(bucketId) as DecimalU64V1,
    byteLength: '1',
    rowCount: rowCount.toString() as CountV1,
  };
}

function rawSessionHex(sessionByte: number): string {
  return sessionByte.toString(16).padStart(2, '0').repeat(32).toUpperCase();
}

function insertRawEmptyHeader(database: DatabaseSync, sessionByte: number): void {
  database.exec(`
    INSERT INTO rfc64_candidate_bucket_loads_v1 (
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      subgraph_name,
      catalog_era_u64be,
      bucket_count_u64be,
      bucket_id_u64be,
      bucket_object_digest,
      row_count_u64be,
      payload_byte_length_u64be
    ) VALUES (
      x'${rawSessionHex(sessionByte)}',
      x'${'22'.repeat(32)}',
      x'${'33'.repeat(20)}',
      x'${sessionByte.toString(16).padStart(2, '0').repeat(32)}',
      NULL,
      zeroblob(8),
      x'0000000000000001',
      zeroblob(8),
      zeroblob(32),
      zeroblob(8),
      zeroblob(8)
    );
  `);
}

function insertTamperedExtraChild(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO rfc64_candidate_bucket_rows_v1
    SELECT
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      bucket_id_u64be,
      x'${AUTHOR.slice(2)}000000000000000000000002',
      x'${'cc'.repeat(32)}',
      'tampered-extra-child',
      assertion_version_u64be,
      projection_id,
      projection_digest,
      seal_digest,
      transfer_codec,
      transfer_byte_length_u64be,
      transfer_chunk_size_u64be,
      transfer_chunk_count_u64be,
      transfer_blob_digest,
      transfer_chunk_tree_root,
      x'${'dd'.repeat(32)}'
    FROM rfc64_candidate_bucket_rows_v1
    LIMIT 1;
  `);
}

interface CandidateDatabaseHooks {
  readonly exec?: (sql: string, exec: (sql: string) => void) => void;
  readonly prepare?: (sql: string, prepare: (sql: string) => StatementSync) => StatementSync;
  readonly afterReopen?: (database: DatabaseSync) => void;
  readonly failReopen?: () => boolean;
}

function proxyDatabase(database: DatabaseSync, hooks: CandidateDatabaseHooks): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'exec') {
        const exec = target.exec.bind(target);
        return (sql: string): void => {
          if (hooks.exec !== undefined) hooks.exec(sql, exec);
          else exec(sql);
        };
      }
      if (property === 'prepare') {
        const prepare = target.prepare.bind(target);
        return (sql: string): StatementSync => hooks.prepare?.(sql, prepare) ?? prepare(sql);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createReopenableCandidateDatabase(hooks: CandidateDatabaseHooks = {}): {
  readonly facade: DatabaseSync;
  readonly reopen: ReturnType<typeof vi.fn<(abandoned: DatabaseSync) => DatabaseSync>>;
  readonly database: () => DatabaseSync;
  readonly currentFacade: () => DatabaseSync;
  readonly didReturnDistinctHandle: () => boolean;
  readonly path: string;
  readonly close: () => void;
} {
  const path = join(temporaryDataDirectory(), 'candidate-reopen.sqlite3');
  let database = openFileDatabase(path, true);
  let facade = proxyDatabase(database, hooks);
  let returnedDistinctHandle = false;
  const reopen = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
    if (abandoned !== facade) throw new Error('reopen received a non-current low-level handle');
    database.close();
    if (hooks.failReopen?.() === true) {
      throw new Error('injected verified-reopen failure');
    }
    database = openFileDatabase(path, false);
    hooks.afterReopen?.(database);
    facade = proxyDatabase(database, hooks);
    returnedDistinctHandle = facade !== abandoned;
    return facade;
  });
  return {
    facade,
    reopen,
    database: () => database,
    currentFacade: () => facade,
    didReturnDistinctHandle: () => returnedDistinctHandle,
    path,
    close: () => {
      try { database.close(); } catch { /* a failed reopen already closed it */ }
    },
  };
}

function openFileDatabase(path: string, initialize: boolean): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (initialize) database.exec(INVENTORY_V1_DDL);
  return database;
}

/** Fault-only schema: lets the reader codec observe bytes SQLite v1 DDL forbids. */
function createLaxCandidateDatabase(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE rfc64_candidate_bucket_loads_v1 (
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      subgraph_name,
      catalog_era_u64be,
      bucket_count_u64be,
      bucket_id_u64be,
      bucket_object_digest,
      row_count_u64be,
      payload_byte_length_u64be
    );
    CREATE TABLE rfc64_candidate_bucket_rows_v1 (
      session_id,
      catalog_scope_digest,
      author_address,
      target_catalog_head_digest,
      bucket_id_u64be,
      ka_id_u256be,
      catalog_key_digest,
      assertion_coordinate,
      assertion_version_u64be,
      projection_id,
      projection_digest,
      seal_digest,
      transfer_codec,
      transfer_byte_length_u64be,
      transfer_chunk_size_u64be,
      transfer_chunk_count_u64be,
      transfer_blob_digest,
      transfer_chunk_tree_root,
      expected_catalog_row_digest
    );
  `);
  return database;
}

function unexpectedReopen(): never {
  throw new Error('test did not expect a verified low-level reopen');
}
