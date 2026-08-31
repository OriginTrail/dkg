/**
 * W2 (#2435) — the durable re-verification intent store.
 *
 * Four properties are load-bearing and each has a failure-shaped assertion:
 *
 *  1. OWNED IDENTITY. The file has its own `application_id`/`user_version` and
 *     an exact-schema check. A store that opened a foreign file would let the
 *     feature write into someone else's durable state; a store that silently
 *     "upgraded" one would make a binary rollback boot-fatal — the exact review
 *     Major that moved this out of the finalization inbox in the first place.
 *  2. POSITION ORDERING via `compareEventPosition`, not block numbers. Two root
 *     mutations of one asset can share a block; a block-only compare records the
 *     first and discards the second as already-seen.
 *  3. GENERATION CAS. Every write the drain issues is refused if a newer event
 *     redefined the row while the drain was planning against the old one.
 *  4. BUDGET RESET on revive. A revived row that keeps its old `first_attempt_at`
 *     re-parks on its first attempt, which would turn "any newer event revives
 *     an abandoned row" into a no-op that no count would reveal.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isNewerPosition,
  openSqliteVmReverifyIntentStore,
} from '../src/vm-reverify-intent-sqlite-store.js';
import {
  VM_REVERIFY_INTENTS_DATABASE_FILENAME,
  type VmReverifyIntentPosition,
  type VmReverifyIntentUpsertInput,
} from '../src/vm-reverify-intent-store.js';

const UAL = 'did:dkg:evm:31337/0x00000000000000000000000000000000000000aa/1';
const OTHER_UAL = 'did:dkg:evm:31337/0x00000000000000000000000000000000000000aa/2';
const CG = 'cg-local';

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dkg-vm-reverify-intents-'));
}

function at(
  blockNumber: number,
  transactionIndex = 0,
  logIndex = 0,
): VmReverifyIntentPosition {
  return { blockNumber, transactionIndex, logIndex };
}

function intent(
  overrides: Partial<VmReverifyIntentUpsertInput> = {},
): VmReverifyIntentUpsertInput {
  return {
    ual: UAL,
    localCgId: CG,
    kaId: '42',
    kind: 'lifecycle-update',
    position: at(100),
    ...overrides,
  };
}

async function withStore<T>(
  run: (
    store: Awaited<ReturnType<typeof openSqliteVmReverifyIntentStore>>,
    directory: string,
    setNow: (value: number) => void,
  ) => Promise<T>,
): Promise<T> {
  const directory = await temporaryDirectory();
  let now = 1_000;
  const store = await openSqliteVmReverifyIntentStore(directory, { now: () => now });
  try {
    return await run(store, directory, (value) => { now = value; });
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

describe('VM re-verify intent store — owned file identity', () => {
  it('creates its own file with its own identity and an exactly-verified schema', async () => {
    await withStore(async (store, directory) => {
      const path = join(directory, VM_REVERIFY_INTENTS_DATABASE_FILENAME);
      expect(existsSync(path), 'the store must own a file of its own name').toBe(true);
      expect(
        store.databasePath.endsWith(VM_REVERIFY_INTENTS_DATABASE_FILENAME),
        'the intent store must NEVER be pointed at finalization-inbox-v1.sqlite3',
      ).toBe(true);
      expect(existsSync(join(directory, 'finalization-inbox-v1.sqlite3'))).toBe(false);
    });

    // Re-open the closed file directly and read the header identity back.
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteVmReverifyIntentStore(directory);
      await store.close();
      const raw = new DatabaseSync(join(directory, VM_REVERIFY_INTENTS_DATABASE_FILENAME));
      try {
        expect(
          Object.values(raw.prepare('PRAGMA application_id').get()!)[0],
          'own APPLICATION_ID ("DKVR"), never the inbox\'s "DKFI" (0x444b4649)',
        ).toBe(0x444b5652);
        expect(Object.values(raw.prepare('PRAGMA user_version').get()!)[0]).toBe(1);
      } finally {
        raw.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a file whose user_version is not the one this code writes', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteVmReverifyIntentStore(directory);
      await store.close();
      const path = join(directory, VM_REVERIFY_INTENTS_DATABASE_FILENAME);
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA journal_mode = DELETE');
      raw.exec('PRAGMA user_version = 2');
      raw.close();

      // Fail closed. A store that opened this would either be reading a future
      // schema it does not understand, or silently migrating a file the base
      // release still has to be able to ignore.
      await expect(openSqliteVmReverifyIntentStore(directory)).rejects.toThrow(
        /foreign or unsupported/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses a file whose application_id belongs to someone else', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteVmReverifyIntentStore(directory);
      await store.close();
      const path = join(directory, VM_REVERIFY_INTENTS_DATABASE_FILENAME);
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA journal_mode = DELETE');
      raw.exec('PRAGMA application_id = 1145128265'); // 0x444b4649 — the inbox
      raw.close();

      await expect(openSqliteVmReverifyIntentStore(directory)).rejects.toThrow(
        /foreign or unsupported/i,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('VM re-verify intent store — position ordering', () => {
  it('orders on (block, txIndex, logIndex), not on block alone', () => {
    expect(isNewerPosition(at(100, 0, 1), at(100, 0, 0))).toBe(true);
    expect(isNewerPosition(at(100, 1, 0), at(100, 0, 9))).toBe(true);
    expect(isNewerPosition(at(101, 0, 0), at(100, 9, 9))).toBe(true);
    expect(isNewerPosition(at(100, 0, 0), at(100, 0, 0))).toBe(false);
    expect(isNewerPosition(at(99, 9, 9), at(100, 0, 0))).toBe(false);
  });

  it('advances on a LATER LOG INDEX IN THE SAME BLOCK and ignores an earlier one', async () => {
    await withStore(async (store) => {
      await expect(store.upsert(intent({ position: at(100, 2, 5) }))).resolves.toBe('inserted');

      // The second mutation of the same asset in the same block. A store that
      // compared block numbers would call this "already seen" and the node
      // would converge to the FIRST update and stop.
      await expect(store.upsert(intent({ position: at(100, 2, 6) }))).resolves.toBe('advanced');
      await expect(store.upsert(intent({ position: at(100, 3, 0) }))).resolves.toBe('advanced');

      await expect(store.upsert(intent({ position: at(100, 3, 0) }))).resolves.toBe('unchanged');
      await expect(store.upsert(intent({ position: at(100, 2, 9) }))).resolves.toBe('unchanged');
      await expect(store.upsert(intent({ position: at(99, 9, 9) }))).resolves.toBe('unchanged');

      const [row] = await store.listDue(10_000, 10);
      expect(row?.observed).toEqual(at(100, 3, 0));
      expect(row?.generation, 'one generation per accepted advance').toBe(2);
    });
  });

  it('resets the whole attempt budget when a newer event redefines the row', async () => {
    await withStore(async (store, _directory, setNow) => {
      setNow(1_000);
      await store.upsert(intent({ position: at(100) }));
      await store.recordAttempt(UAL, 0, 'unresolved', 30_000, 1_000);
      const [attempted] = await store.listDue(1_000_000, 10);
      expect(attempted?.attemptCount).toBe(1);
      expect(attempted?.firstAttemptAt).toBe(1_000);
      expect(attempted?.nextAttemptAt).toBe(31_000);

      setNow(500_000);
      await expect(store.upsert(intent({ position: at(101) }))).resolves.toBe('advanced');
      const [advanced] = await store.listDue(500_000, 10);
      expect(advanced?.attemptCount, 'attempts restart for the new event').toBe(0);
      expect(
        advanced?.firstAttemptAt,
        'the 24 h park budget must restart too — a carried-over first attempt '
        + 'would park the new event instantly',
      ).toBeUndefined();
      expect(advanced?.nextAttemptAt, 'a new event is due immediately').toBeUndefined();
      expect(advanced?.lastOutcome).toBeUndefined();
    });
  });
});

describe('VM re-verify intent store — due selection', () => {
  it('lists only PENDING rows whose backoff has elapsed, oldest event first', async () => {
    await withStore(async (store, _directory, setNow) => {
      setNow(1_000);
      await store.upsert(intent({ ual: UAL, position: at(200) }));
      await store.upsert(intent({ ual: OTHER_UAL, position: at(100) }));

      expect((await store.listDue(1_000, 10)).map((row) => row.ual)).toEqual([
        OTHER_UAL, // observed_block 100 before 200
        UAL,
      ]);

      // Not due yet.
      await store.recordAttempt(OTHER_UAL, 0, 'unresolved', 30_000, 1_000);
      expect((await store.listDue(1_000, 10)).map((row) => row.ual)).toEqual([UAL]);
      expect((await store.listDue(31_000, 10)).map((row) => row.ual)).toEqual([OTHER_UAL, UAL]);

      // Abandoned rows are not work.
      await store.abandon(UAL, 0, 'version-regression-unsupported');
      expect((await store.listDue(31_000, 10)).map((row) => row.ual)).toEqual([OTHER_UAL]);
      expect(await store.countPending(CG)).toBe(1);

      expect(await store.listDue(31_000, 0), 'a zero limit selects nothing').toEqual([]);
      expect((await store.listDue(31_000, 1)).length, 'the limit is honoured').toBe(1);
    });
  });
});

describe('VM re-verify intent store — generation compare-and-set', () => {
  it('refuses every write that names a stale generation', async () => {
    await withStore(async (store) => {
      await store.upsert(intent({ position: at(100) }));
      await store.upsert(intent({ position: at(101) })); // generation -> 1

      // A drain that planned against generation 0 must not be able to delete,
      // retry, or bury a row that a newer chain event has already redefined.
      await expect(store.resolve(UAL, 0)).resolves.toBe(false);
      await expect(store.recordAttempt(UAL, 0, 'unresolved', 1_000, 1_000)).resolves.toBe(false);
      await expect(store.abandon(UAL, 0, 'no-peer-has-version')).resolves.toBe(false);
      expect(await store.countPending()).toBe(1);

      await expect(store.recordAttempt(UAL, 1, 'unresolved', 1_000, 1_000)).resolves.toBe(true);
      await expect(store.resolve(UAL, 1)).resolves.toBe(true);
      expect(await store.countPending()).toBe(0);
      await expect(store.resolve(UAL, 1), 'a resolved row is gone, not re-resolvable')
        .resolves.toBe(false);
    });
  });

  it('does not advance the generation on an attempt or an abandon', async () => {
    await withStore(async (store) => {
      await store.upsert(intent({ position: at(100) }));
      await store.recordAttempt(UAL, 0, 'unresolved', 1_000, 1_000);
      await store.recordAttempt(UAL, 0, 'unresolved', 1_000, 2_000);
      const [row] = await store.listDue(1_000_000, 10);
      expect(
        row?.generation,
        'generation identifies the EVENT the row is about; retrying the same '
        + 'event must not invalidate a concurrent planner holding it',
      ).toBe(0);
      expect(row?.attemptCount).toBe(2);
      expect(
        row?.firstAttemptAt,
        'the budget clock starts once and does not slide with each retry',
      ).toBe(1_000);
      await expect(store.abandon(UAL, 0, 'no-peer-has-version')).resolves.toBe(true);
    });
  });
});

describe('VM re-verify intent store — revival and garbage collection', () => {
  it('revives an abandoned row for a re-hosted CG, with a fresh budget', async () => {
    await withStore(async (store, _directory, setNow) => {
      setNow(1_000);
      await store.upsert(intent({ position: at(100) }));
      await store.recordAttempt(UAL, 0, 'unresolved', 1_000, 1_000);
      await store.abandon(UAL, 0, 'no-peer-has-version');
      expect(await store.countPending(CG)).toBe(0);
      expect((await store.health()).abandoned).toBe(1);

      setNow(90_000_000);
      expect(
        await store.reviveForContextGraph('some-other-cg'),
        'reviving one CG must not touch another CG\'s rows',
      ).toBe(0);
      expect(await store.reviveForContextGraph(CG)).toBe(1);

      const [revived] = await store.listDue(90_000_000, 10);
      expect(revived?.state).toBe('PENDING');
      expect(revived?.abandonReason).toBeUndefined();
      expect(revived?.generation, 'a revive redefines the work').toBe(1);
      expect(
        revived?.firstAttemptAt,
        'a revived row must get a fresh 24 h budget — otherwise re-hosting a CG '
        + 'parks the row again on its very first attempt',
      ).toBeUndefined();
      expect(revived?.attemptCount).toBe(0);
    });
  });

  it('revives an abandoned row when a strictly newer event arrives', async () => {
    await withStore(async (store) => {
      await store.upsert(intent({ position: at(100) }));
      await store.abandon(UAL, 0, 'version-regression-unsupported');
      expect(await store.countPending()).toBe(0);

      await expect(store.upsert(intent({ position: at(100, 0, 1) }))).resolves.toBe('advanced');
      expect(await store.countPending()).toBe(1);
      const [row] = await store.listDue(1_000_000, 10);
      expect(row?.state).toBe('PENDING');
      expect(row?.abandonReason).toBeUndefined();

      // An older event must NOT resurrect it.
      await store.abandon(UAL, 1, 'version-regression-unsupported');
      await expect(store.upsert(intent({ position: at(99) }))).resolves.toBe('unchanged');
      expect(await store.countPending()).toBe(0);
    });
  });

  it('garbage-collects only abandoned rows past the retention window', async () => {
    await withStore(async (store, _directory, setNow) => {
      setNow(1_000);
      await store.upsert(intent({ ual: UAL, position: at(100) }));
      await store.upsert(intent({ ual: OTHER_UAL, position: at(101) }));
      await store.abandon(UAL, 0, 'chain-identity-conflict');

      setNow(10_000);
      expect(await store.gcAbandoned(50_000), 'inside the window: nothing removed').toBe(0);
      expect(await store.gcAbandoned(1_000)).toBe(1);
      expect(
        await store.countPending(),
        'garbage collection must never remove live work',
      ).toBe(1);
      await expect(store.health()).resolves.toMatchObject({ pending: 1, abandoned: 0 });
    });
  });

  it('reports health including the oldest pending budget start', async () => {
    await withStore(async (store) => {
      await expect(store.health()).resolves.toEqual({ pending: 0, abandoned: 0 });
      await store.upsert(intent({ ual: UAL, position: at(100) }));
      await store.upsert(intent({ ual: OTHER_UAL, position: at(101) }));
      await store.recordAttempt(OTHER_UAL, 0, 'unresolved', 1_000, 7_777);
      await store.recordAttempt(UAL, 0, 'unresolved', 1_000, 9_999);
      await expect(store.health()).resolves.toEqual({
        pending: 2,
        abandoned: 0,
        oldestPendingFirstAttemptAt: 7_777,
      });
    });
  });
});

describe('VM re-verify intent store — durability across a reopen', () => {
  it('keeps pending work, generation and budget across close/open', async () => {
    const directory = await temporaryDirectory();
    try {
      const first = await openSqliteVmReverifyIntentStore(directory, { now: () => 1_000 });
      await first.upsert(intent({ position: at(100) }));
      await first.upsert(intent({ position: at(101) }));
      await first.recordAttempt(UAL, 1, 'unresolved', 5_000, 1_000);
      await first.close();

      // The whole point of a durable intent: the node that went down during a
      // divergence must still know it has work when it comes back.
      const second = await openSqliteVmReverifyIntentStore(directory, { now: () => 20_000 });
      try {
        const [row] = await second.listDue(20_000, 10);
        expect(row).toMatchObject({
          ual: UAL,
          localCgId: CG,
          kaId: '42',
          kind: 'lifecycle-update',
          state: 'PENDING',
          generation: 1,
          attemptCount: 1,
          firstAttemptAt: 1_000,
        });
        expect(row?.observed).toEqual(at(101));
      } finally {
        await second.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
