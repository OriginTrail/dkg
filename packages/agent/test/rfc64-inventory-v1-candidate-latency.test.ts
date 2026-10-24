import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it, vi } from 'vitest';

import {
  AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
  AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
  KA_TRANSFER_CHUNK_SIZE_V1,
  KA_TRANSFER_CODEC_V1,
  KA_TRANSFER_PROJECTION_V1,
  assertAuthorCatalogRowV1,
  assertSignedAuthorCatalogBucketEnvelopeV1,
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  canonicalizeAuthorCatalogBucketPayloadBytesV1,
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
  type Digest32V1,
  type SignedAuthorCatalogDirectoryNodeEnvelopeV1,
  type SignedAuthorCatalogHeadEnvelopeV1,
  type SignedControlEnvelopeV1,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';

import {
  INVENTORY_V1_DDL,
  openInventoryV1,
  type CandidateSessionV1,
  type VerifiedCandidateBucketLoadV1,
} from '../src/rfc64/inventory-v1/index.js';
import { CandidateInventoryV1 } from '../src/rfc64/inventory-v1/candidate.js';

describe('RFC-64 SQL-1 candidate latency and indeterminate-commit boundaries', () => {
  it('performs the real verified low-level reopen inside one live foundation', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-reopen-')));
    const foundation = await openInventoryV1(directory);
    let clockCalls = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      clockCalls += 1;
      return clockCalls >= 13 ? 10_001 : 0;
    });
    try {
      expect(foundation.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      expect(foundation.closed).toBe(false);
      clock.mockRestore();
      expect(() => foundation.createCandidateSession()).not.toThrow();
    } finally {
      clock.mockRestore();
      foundation.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('atomically detaches a foundation replacement rejected by the candidate probe', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-reject-reopen-')));
    const foundation = await openInventoryV1(directory);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let time = 0;
    let rejectProbe = false;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ): StatementSync {
      if (rejectProbe && sql.includes('rfc64_verified_reopen_probe')) {
        throw new Error('injected reopened-handle probe rejection');
      }
      const statement = originalPrepare.call(this, sql);
      if (!sql.includes('FROM rfc64_candidate_bucket_loads_v1')) return statement;
      return new Proxy(statement, {
        get(target, property) {
          if (property !== 'all') return Reflect.get(target, property, target);
          const all = target.all.bind(target);
          return (...parameters: Parameters<StatementSync['all']>) => {
            const result = all(...parameters);
            time = 10_001;
            rejectProbe = true;
            return result;
          };
        },
      });
    });
    try {
      expect(() => foundation.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'latency-budget-exceeded' }),
      );
      expect(foundation.closed).toBe(true);
      expect(() => foundation.createCandidateSession()).toThrowError(
        expect.objectContaining({ code: 'database-closed' }),
      );
    } finally {
      prepare.mockRestore();
      clock.mockRestore();
      foundation.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fails closed and rolls back an over-budget statement', () => {
    const clock = manualClock();
    let overrunOnce = true;
    const fixture = createReopenableLatencyDatabase({
      prepare(sql, prepare) {
        const statement = prepare(sql);
        if (overrunOnce && sql.includes('FROM rfc64_candidate_bucket_loads_v1')) {
          overrunOnce = false;
          clock.advance(10_001);
        }
        return statement;
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, clock.now);
    try {
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'latency-budget-exceeded' }),
      );
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      expect(() => inventory.createCandidateSession()).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('rolls back and closes before COMMIT when the write transaction exceeds 30 seconds', () => {
    const fixture = createReopenableLatencyDatabase();
    insertEmptyHeader(fixture.database());
    // Every individual statement is measured at 4 seconds, but the complete
    // select+delete transaction crosses 30 seconds before COMMIT.
    let time = 0;
    let advanceTime = true;
    const now = (): number => {
      const value = time;
      if (advanceTime) time += 4_000;
      return value;
    };
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, now);
    try {
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'latency-budget-exceeded' }),
      );
      expect(fixture.reopen).toHaveBeenCalledOnce();
      advanceTime = false;
      const inspector = new DatabaseSync(fixture.path);
      expect(inspector.prepare(
        'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
      ).get()?.count).toBe(1);
      inspector.close();
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 1,
        done: false,
      });
    } finally {
      fixture.close();
    }
  });

  it('stops a multi-row stage at the absolute deadline and executes no later insert', () => {
    let time = 0;
    let rowInsertCalls = 0;
    const fixture = createReopenableLatencyDatabase({
      prepare(sql, prepare) {
        const statement = prepare(sql);
        if (!/^\s*INSERT INTO rfc64_candidate_bucket_rows_v1/i.test(sql)) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== 'run') return Reflect.get(target, property, target);
            const run = target.run.bind(target);
            return (...parameters: Parameters<StatementSync['run']>) => {
              rowInsertCalls += 1;
              const result = run(...parameters);
              time += 6_000;
              return result;
            };
          },
        });
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, () => time);
    try {
      inventory.purgeNextStartupStaleCandidateBatch();
      const session = inventory.createCandidateSession();
      expect(() => inventory.putVerifiedCandidateBucket(
        latencyCandidateLoad(session, 10),
      )).toThrowError(expect.objectContaining({ code: 'latency-budget-exceeded' }));
      expect(rowInsertCalls).toBe(5);
      const inspector = new DatabaseSync(fixture.path);
      try {
        expect(inspector.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1',
        ).get()?.count).toBe(0);
        expect(inspector.prepare(
          'SELECT count(*) AS count FROM rfc64_candidate_bucket_rows_v1',
        ).get()?.count).toBe(0);
      } finally {
        inspector.close();
      }
    } finally {
      inventory.close();
      fixture.close();
    }
  });

  it('returns a successfully committed result, records the overrun, then requires reopen', () => {
    const clock = manualClock();
    const fixture = createReopenableLatencyDatabase({
      exec(sql, exec) {
        exec(sql);
        if (sql.trim().toUpperCase() === 'COMMIT') clock.advance(10_001);
      },
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, clock.now);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      expect(inventory.committedOverruns).toBe(1);
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(() => inventory.createCandidateSession()).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('resolves an empty-batch COMMIT failure to the identical committed outcome', () => {
    let failOnce = true;
    const fixture = createReopenableLatencyDatabase({
      exec(sql, exec) {
        if (failOnce && sql.trim().toUpperCase() === 'COMMIT') {
          failOnce = false;
          // Throw before COMMIT. Closing the abandoned file-backed handle is
          // the rollback boundary used by the verified reopen provider.
          throw new Error('injected COMMIT failure');
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
      expect(inventory.committedOverruns).toBe(0);
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(() => inventory.createCandidateSession()).not.toThrow();
    } finally {
      fixture.close();
    }
  });

  it('preserves a known committed result while making a failed-reopen foundation unavailable', () => {
    const clock = manualClock();
    const fixture = createReopenableLatencyDatabase({
      exec(sql, exec) {
        exec(sql);
        if (sql.trim().toUpperCase() === 'COMMIT') clock.advance(10_001);
      },
      failReopen: true,
    });
    const inventory = new CandidateInventoryV1(fixture.facade, fixture.reopen, clock.now);
    try {
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
        deletedLoads: 0,
        done: true,
      });
      expect(inventory.committedOverruns).toBe(1);
      expect(fixture.reopen).toHaveBeenCalledOnce();
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        /unavailable after failed verified reopen/,
      );
    } finally {
      fixture.close();
    }
  });

  for (const invalidReopen of [
    {
      label: 'identity',
      result: (abandoned: DatabaseSync): DatabaseSync => abandoned,
    },
    {
      label: 'malformed',
      result: (_abandoned: DatabaseSync): DatabaseSync => ({}) as DatabaseSync,
    },
    {
      label: 'closed',
      result: (_abandoned: DatabaseSync): DatabaseSync => {
        const closed = new DatabaseSync(':memory:');
        closed.close();
        return closed;
      },
    },
  ] as const) {
    it(`rejects an ${invalidReopen.label} reopen result and remains unavailable`, () => {
      let failCommit = true;
      const fixture = createReopenableLatencyDatabase({
        exec(sql, exec) {
          if (failCommit && sql.trim().toUpperCase() === 'COMMIT') {
            failCommit = false;
            throw new Error('injected indeterminate COMMIT');
          }
          exec(sql);
        },
      });
      const provider = vi.fn(invalidReopen.result);
      const inventory = new CandidateInventoryV1(fixture.facade, provider);
      try {
        expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
          expect.objectContaining({ code: 'candidate-database-error' }),
        );
        expect(provider).toHaveBeenCalledOnce();
        expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
          /unavailable after failed verified reopen/,
        );
      } finally {
        inventory.close();
        fixture.close();
      }
    });
  }

  for (const reopenBudget of [
    {
      label: '10-second SQL-probe budget',
      providerAdvance: 0,
      probeAdvance: 10_001,
    },
    {
      label: '30-second repair deadline',
      providerAdvance: 25_000,
      probeAdvance: 6_000,
    },
  ] as const) {
    it(`detaches and closes a replacement that crosses the ${reopenBudget.label}`, () => {
      let time = 0;
      let failCommit = true;
      const fixture = createReopenableLatencyDatabase({
        exec(sql, exec) {
          if (failCommit && sql.trim().toUpperCase() === 'COMMIT') {
            failCommit = false;
            throw new Error('injected indeterminate COMMIT');
          }
          exec(sql);
        },
        prepare(sql, prepare) {
          const statement = prepare(sql);
          if (!sql.includes('rfc64_verified_reopen_probe')) return statement;
          return new Proxy(statement, {
            get(target, property) {
              if (property !== 'get') return Reflect.get(target, property, target);
              const get = target.get.bind(target);
              return (...parameters: Parameters<StatementSync['get']>) => {
                const result = get(...parameters);
                time += reopenBudget.probeAdvance;
                return result;
              };
            },
          });
        },
      });
      let attached: DatabaseSync | null = null;
      const provider = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
        const replacement = fixture.reopen(abandoned);
        time += reopenBudget.providerAdvance;
        attached = replacement;
        return replacement;
      });
      const reject = vi.fn((replacement: DatabaseSync): void => {
        if (attached === replacement) attached = null;
        replacement.close();
      });
      const inventory = new CandidateInventoryV1(
        fixture.facade,
        provider,
        () => time,
        reject,
      );
      try {
        expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
          expect.objectContaining({ code: 'latency-budget-exceeded' }),
        );
        expect(provider).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(attached).toBeNull();
        expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
          /unavailable after failed verified reopen/,
        );
      } finally {
        inventory.close();
        fixture.close();
      }
    });
  }
});


// Prospective regression: resource repair has a separate bounded lifetime;
// the failed/committed business operation retains its original deadline/outcome.
describe('RFC-64 SQL-1 repair after the original write deadline', () => {
  it.each(['committed', 'begin', 'statement', 'rollback'] as const)(
    'keeps a real Foundation usable after %s crosses the original deadline', async (mode) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-repair-budget-')));
      const foundation = await openInventoryV1(directory);
      const seed = new DatabaseSync(foundation.databasePath);
      try { insertEmptyHeader(seed); } finally { seed.close(); }
      const execOriginal = DatabaseSync.prototype.exec;
      const prepareOriginal = DatabaseSync.prototype.prepare;
      const closeOriginal = DatabaseSync.prototype.close;
      let time = 0;
      let injected = false;
      let initial = true;
      let commits = 0;
      let rollbacks = 0;
      let abandoned: DatabaseSync | undefined;
      let replacement: DatabaseSync | undefined;
      const closed: DatabaseSync[] = [];
      const rememberAbandoned = (database: DatabaseSync): void => { abandoned = database; };
      const rememberReplacement = (database: DatabaseSync): void => { replacement = database; };
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => time);
      const close = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementation(function (this: DatabaseSync) {
        closed.push(this);
        return closeOriginal.call(this);
      });
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
        const command = sql.trim().toUpperCase();
        if (initial && command === 'COMMIT') commits += 1;
        if (initial && command === 'ROLLBACK') rollbacks += 1;
        execOriginal.call(this, sql);
        if (!injected && ((mode === 'committed' && command === 'COMMIT')
          || (mode === 'begin' && command === 'BEGIN IMMEDIATE')
          || (mode === 'rollback' && command === 'ROLLBACK'))) {
          injected = true;
          rememberAbandoned(this);
          time = 30_001;
        }
      });
      const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string): StatementSync {
        if (sql.includes('rfc64_verified_reopen_probe')) rememberReplacement(this);
        const statement = prepareOriginal.call(this, sql);
        if (!initial || injected || !sql.includes('FROM rfc64_candidate_bucket_loads_v1')
          || (mode !== 'statement' && mode !== 'rollback')) return statement;
        return new Proxy(statement, {
          get: (target, property) => {
            if (property !== 'all') return Reflect.get(target, property, target);
            const all = target.all.bind(target);
            return (...parameters: Parameters<StatementSync['all']>) => {
              const result = all(...parameters);
              if (mode === 'rollback') throw new Error('injected operation failure before rollback');
              injected = true;
              rememberAbandoned(this);
              time = 30_001;
              return result;
            };
          },
        });
      });
      try {
        if (mode === 'committed') {
          expect(foundation.purgeNextStartupStaleCandidateBatch()).toEqual({ deletedLoads: 1, done: false });
        } else {
          expect(() => foundation.purgeNextStartupStaleCandidateBatch()).toThrowError(
            expect.objectContaining({ code: 'latency-budget-exceeded' }),
          );
        }
        initial = false;
        expect(injected).toBe(true);
        expect(commits).toBe(mode === 'committed' ? 1 : 0);
        expect(rollbacks).toBe(mode === 'committed' ? 0 : 1);
        const inspector = new DatabaseSync(foundation.databasePath);
        try {
          expect(inspector.prepare('SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1').get()?.count)
            .toBe(mode === 'committed' ? 0 : 1);
        } finally { inspector.close(); }
        // Old code returns/throws the correct operation outcome but closes the
        // healthy replacement solely because the previous deadline expired.
        expect(foundation.closed).toBe(false);
        expect(replacement).toBeDefined();
        expect(replacement !== abandoned).toBe(true);
        expect(closed.filter(handle => handle === abandoned).length).toBe(1);
        expect(closed.some(handle => handle === replacement)).toBe(false);
        expect(foundation.purgeNextStartupStaleCandidateBatch()).toEqual({
          deletedLoads: mode === 'committed' ? 0 : 1, done: mode === 'committed',
        });
        expect(foundation.purgeNextStartupStaleCandidateBatch()).toEqual({ deletedLoads: 0, done: true });
        expect(() => foundation.createCandidateSession()).not.toThrow();
        let unexpectedOwner: Awaited<ReturnType<typeof openInventoryV1>> | undefined;
        try {
          await expect(openInventoryV1(directory).then(owner => {
            unexpectedOwner = owner;
            return owner;
          })).rejects.toMatchObject({ code: 'database-busy' });
        } finally { unexpectedOwner?.close(); }
        foundation.close();
        expect(closed.filter(handle => handle === replacement).length).toBe(1);
        const nextOwner = await openInventoryV1(directory);
        try { expect(nextOwner.closed).toBe(false); } finally { nextOwner.close(); }
      } finally {
        prepare.mockRestore(); exec.mockRestore(); close.mockRestore(); clock.mockRestore();
        foundation.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([false, true])(
    'does not resolve or replay an expired indeterminate COMMIT (actually committed=%s)', (actuallyCommitted) => {
      let time = 0;
      let firstCommit = true;
      let commitAttempts = 0;
      let afterReopen = false;
      const readsAfterReopen: string[] = [];
      const fixture = createReopenableLatencyDatabase({
        exec(sql, exec) {
          if (sql.trim().toUpperCase() === 'COMMIT') {
            commitAttempts += 1;
            if (firstCommit) {
              firstCommit = false;
              if (actuallyCommitted) exec(sql);
              time = 30_001;
              throw new Error('injected unknown COMMIT outcome after expired deadline');
            }
          }
          exec(sql);
        },
        prepare(sql, prepare) {
          if (afterReopen && !sql.includes('rfc64_verified_reopen_probe')) readsAfterReopen.push(sql);
          return prepare(sql);
        },
      });
      insertEmptyHeader(fixture.database());
      const provider = vi.fn((previous: DatabaseSync): DatabaseSync => {
        const replacement = fixture.reopen(previous);
        afterReopen = true;
        return replacement;
      });
      const inventory = new CandidateInventoryV1(fixture.facade, provider, () => time);
      try {
        expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
          expect.objectContaining({ code: 'latency-budget-exceeded' }),
        );
        // A newly verified handle does not extend the failed operation's budget.
        expect(provider).toHaveBeenCalledOnce();
        expect(commitAttempts).toBe(1);
        expect(readsAfterReopen).toEqual([]);
        const inspector = new DatabaseSync(fixture.path);
        try {
          expect(inspector.prepare('SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1').get()?.count)
            .toBe(actuallyCommitted ? 0 : 1);
        } finally { inspector.close(); }
        // A new independent operation may proceed; no claimed outcome was
        // fabricated for the expired ambiguous attempt above.
        expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({
          deletedLoads: actuallyCommitted ? 0 : 1, done: actuallyCommitted,
        });
      } finally { inventory.close(); fixture.close(); }
    },
  );


  it('repairs again when an actual exact-key resolution read overruns, without replay', () => {
    let time = 0;
    let firstCommit = true;
    let commitAttempts = 0;
    let reopened = false;
    let resolutionReads = 0;
    const fixture = createReopenableLatencyDatabase({
      exec(sql, exec) {
        if (sql.trim().toUpperCase() === 'COMMIT') {
          commitAttempts += 1;
          if (firstCommit) {
            firstCommit = false;
            throw new Error('injected indeterminate COMMIT before execution');
          }
        }
        exec(sql);
      },
      prepare(sql, prepare) {
        const statement = prepare(sql);
        if (!reopened || resolutionReads !== 0 || !sql.includes('FROM rfc64_candidate_bucket_loads_v1')) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property !== 'get') return Reflect.get(target, property, target);
            const get = target.get.bind(target);
            return (...parameters: Parameters<StatementSync['get']>) => {
              const result = get(...parameters);
              resolutionReads += 1;
              time = 30_001;
              return result;
            };
          },
        });
      },
    });
    insertEmptyHeader(fixture.database());
    const provider = vi.fn((previous: DatabaseSync): DatabaseSync => {
      const replacement = fixture.reopen(previous);
      reopened = true;
      return replacement;
    });
    const inventory = new CandidateInventoryV1(fixture.facade, provider, () => time);
    try {
      expect(() => inventory.purgeNextStartupStaleCandidateBatch()).toThrowError(
        expect.objectContaining({ code: 'latency-budget-exceeded' }),
      );
      expect(resolutionReads).toBe(1);
      expect(provider).toHaveBeenCalledTimes(2);
      expect(commitAttempts).toBe(1);
      expect(fixture.database().prepare('SELECT count(*) AS count FROM rfc64_candidate_bucket_loads_v1').get()?.count).toBe(1);
      expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({ deletedLoads: 1, done: false });
    } finally { inventory.close(); fixture.close(); }
  });

  it.each(['slow-provider', 'slow-probe', 'invalid-probe'] as const)(
    'rejects a %s replacement after a known committed overrun', (mode) => {
      let time = 0;
      let firstCommit = true;
      let commits = 0;
      let probeCalls = 0;
      const fixture = createReopenableLatencyDatabase({
        exec(sql, exec) {
          exec(sql);
          if (sql.trim().toUpperCase() === 'COMMIT') {
            commits += 1;
            if (firstCommit) { firstCommit = false; time = 30_001; }
          }
        },
        prepare(sql, prepare) {
          const statement = prepare(sql);
          if (!sql.includes('rfc64_verified_reopen_probe')) return statement;
          return new Proxy(statement, {
            get(target, property) {
              if (property !== 'get') return Reflect.get(target, property, target);
              const get = target.get.bind(target);
              return (...parameters: Parameters<StatementSync['get']>) => {
                const row = get(...parameters);
                probeCalls += 1;
                if (mode === 'slow-probe') time += 10_001;
                return mode === 'invalid-probe' ? { rfc64_verified_reopen_probe: 0 } : row;
              };
            },
          });
        },
      });
      let attached: DatabaseSync | null = null;
      const provider = vi.fn((previous: DatabaseSync): DatabaseSync => {
        attached = fixture.reopen(previous);
        if (mode === 'slow-provider') time += 30_001;
        return attached;
      });
      const reject = vi.fn((replacement: DatabaseSync): void => {
        if (attached === replacement) attached = null;
        replacement.close();
      });
      const inventory = new CandidateInventoryV1(fixture.facade, provider, () => time, reject);
      try {
        expect(inventory.purgeNextStartupStaleCandidateBatch()).toEqual({ deletedLoads: 0, done: true });
        expect(inventory.committedOverruns).toBe(1);
        expect(commits).toBe(1);
        expect(provider).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(attached).toBeNull();
        expect(probeCalls).toBe(mode === 'slow-provider' ? 0 : 1);
        expect(() => inventory.createCandidateSession()).toThrowError(/unavailable after failed verified reopen/);
      } finally { inventory.close(); fixture.close(); }
    },
  );
});

interface DatabaseHooks {
  readonly exec?: (sql: string, exec: (sql: string) => void) => void;
  readonly prepare?: (sql: string, prepare: (sql: string) => StatementSync) => StatementSync;
  readonly failReopen?: boolean;
}

function proxyDatabase(database: DatabaseSync, hooks: DatabaseHooks): DatabaseSync {
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

function createReopenableLatencyDatabase(hooks: DatabaseHooks = {}): {
  readonly facade: DatabaseSync;
  readonly reopen: ReturnType<typeof vi.fn<(abandoned: DatabaseSync) => DatabaseSync>>;
  readonly database: () => DatabaseSync;
  readonly path: string;
  readonly close: () => void;
} {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dkg-rfc64-latency-db-')));
  const path = join(directory, 'inventory.sqlite3');
  let database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(INVENTORY_V1_DDL);
  let facade = proxyDatabase(database, hooks);
  const reopen = vi.fn((abandoned: DatabaseSync): DatabaseSync => {
    if (abandoned !== facade) throw new Error('reopen received a non-current low-level handle');
    database.close();
    if (hooks.failReopen === true) throw new Error('injected reopen verification failure');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    facade = proxyDatabase(database, hooks);
    return facade;
  });
  return {
    facade,
    reopen,
    database: () => database,
    path,
    close: () => {
      try { database.close(); } catch { /* a failed reopen already closed it */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function manualClock(): {
  readonly now: () => number;
  readonly advance: (milliseconds: number) => void;
} {
  let value = 0;
  return {
    now: () => value,
    advance: (milliseconds) => { value += milliseconds; },
  };
}

function insertEmptyHeader(database: DatabaseSync): void {
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
      x'${'11'.repeat(32)}',
      x'${'22'.repeat(32)}',
      x'${'33'.repeat(20)}',
      x'${'44'.repeat(32)}',
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

const LATENCY_AUTHOR = '0x3333333333333333333333333333333333333333';
const LATENCY_ISSUER = '0x5555555555555555555555555555555555555555';
const LATENCY_SIGNATURE = `0x${'77'.repeat(65)}`;

function latencyCandidateLoad(
  session: CandidateSessionV1,
  rowCount: number,
): VerifiedCandidateBucketLoadV1 {
  const headPayload = {
    networkId: 'otp:20430',
    contextGraphId: '0x1111111111111111111111111111111111111111/latency-fixture',
    governanceChainId: '20430',
    governanceContractAddress: '0x2222222222222222222222222222222222222222',
    ownershipTransitionDigest: null,
    subGraphName: null,
    authorAddress: LATENCY_AUTHOR,
    catalogIssuerDelegationDigest: `0x${'66'.repeat(32)}`,
    era: '0',
    version: '50',
    previousHeadDigest: null,
    bucketCount: '1',
    totalRows: String(rowCount),
    directoryHeight: '0',
    directoryRootDigest: `0x${'50'.repeat(32)}`,
    issuedAt: '1700000000050',
  } as AuthorCatalogHeadV1;
  const unsignedHead = {
    issuer: LATENCY_ISSUER,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: headPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const head = {
    ...unsignedHead,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsignedHead),
    signature: LATENCY_SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(head);
  const headTemplate = head as SignedAuthorCatalogHeadEnvelopeV1;
  const scope = deriveAuthorCatalogScopeFromHeadV1(headTemplate.payload);
  const rows = Array.from({ length: rowCount }, (_, index): AuthorCatalogRowV1 => {
    const row = {
      kaId: ((BigInt(LATENCY_AUTHOR) << 96n) | BigInt(index + 1)).toString(),
      assertionCoordinate: `latency-row-${index + 1}`,
      assertionVersion: '1',
      projectionId: KA_TRANSFER_PROJECTION_V1,
      projectionDigest: `0x${String(index + 1).padStart(2, '0').slice(-2).repeat(32)}`,
      sealDigest: `0x${'44'.repeat(32)}`,
      transfer: {
        codec: KA_TRANSFER_CODEC_V1,
        projectionId: KA_TRANSFER_PROJECTION_V1,
        projectionDigest: `0x${String(index + 1).padStart(2, '0').slice(-2).repeat(32)}`,
        byteLength: '16',
        chunkSize: KA_TRANSFER_CHUNK_SIZE_V1,
        chunkCount: '1',
        blobDigest: `0x${'11'.repeat(32)}`,
        chunkTreeRoot: `0x${'22'.repeat(32)}`,
      },
    } as unknown as AuthorCatalogRowV1;
    assertAuthorCatalogRowV1(row);
    return row;
  });
  const bucketPayload = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    era: scope.era,
    bucketCount: scope.bucketCount,
    bucketId: '0',
    rows,
  } as AuthorCatalogBucketV1;
  const unsignedBucket = {
    issuer: LATENCY_ISSUER,
    objectType: AUTHOR_CATALOG_BUCKET_OBJECT_TYPE_V1,
    payload: bucketPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const bucket = {
    ...unsignedBucket,
    objectDigest: computeAuthorCatalogBucketObjectDigestV1(unsignedBucket),
    signature: LATENCY_SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogBucketEnvelopeV1(bucket);
  const descriptor = {
    bucketId: '0',
    rowCount: String(rowCount) as CountV1,
    byteLength: String(
      canonicalizeAuthorCatalogBucketPayloadBytesV1(bucketPayload).byteLength,
    ) as ByteLengthV1,
    bucketDigest: bucket.objectDigest as Digest32V1,
  } satisfies AuthorCatalogBucketDescriptorV1;
  const directoryPayload: AuthorCatalogDirectoryNodeV1 = {
    catalogScopeDigest: computeAuthorCatalogScopeDigestV1(scope),
    entries: [descriptor],
    era: scope.era,
    firstBucketId: '0',
    level: '0',
  };
  const unsignedDirectory = {
    issuer: LATENCY_ISSUER,
    objectType: AUTHOR_CATALOG_DIRECTORY_NODE_OBJECT_TYPE_V1,
    payload: directoryPayload,
    signatureEvidence: { kind: 'none' },
    signatureSuite: 'eip191-personal-sign-digest-v1',
  } as unknown as UnsignedControlEnvelopeV1;
  const signedDirectory = {
    ...unsignedDirectory,
    objectDigest: computeAuthorCatalogDirectoryNodeObjectDigestV1(unsignedDirectory, '1'),
    signature: LATENCY_SIGNATURE,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogDirectoryNodeEnvelopeV1(signedDirectory, '1');
  const directory = signedDirectory as SignedAuthorCatalogDirectoryNodeEnvelopeV1;
  const unsignedBoundHead = {
    issuer: headTemplate.issuer,
    objectType: AUTHOR_CATALOG_HEAD_OBJECT_TYPE_V1,
    payload: {
      ...headTemplate.payload,
      directoryRootDigest: directory.objectDigest,
    },
    signatureEvidence: headTemplate.signatureEvidence,
    signatureSuite: headTemplate.signatureSuite,
  } as UnsignedControlEnvelopeV1;
  const boundHead = {
    ...unsignedBoundHead,
    objectDigest: computeAuthorCatalogHeadObjectDigestV1(unsignedBoundHead),
    signature: headTemplate.signature,
  } as SignedControlEnvelopeV1;
  assertSignedAuthorCatalogHeadEnvelopeV1(boundHead);
  const signedHead = boundHead as SignedAuthorCatalogHeadEnvelopeV1;
  return {
    session,
    head: signedHead,
    directoryPath: verifyAuthorCatalogDirectoryPathV1(signedHead, [directory], '0'),
    bucket,
  };
}
