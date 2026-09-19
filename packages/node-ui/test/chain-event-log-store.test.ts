import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DashboardDB } from '../src/db.js';
import {
  SqliteChainEventLogStore,
  type SqliteChainEventLogCommit,
  type SqliteChainEventLogRow,
} from '../src/chain-event-log-store.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const ADDRESS = `0x${'cd'.repeat(20)}`;
const TOPIC = `0x${'01'.repeat(32)}`;
const hash = (seed: number): string => `0x${seed.toString(16).padStart(2, '0').repeat(32)}`;

function row(
  blockNumber: number,
  logIndex: number,
  settled: boolean,
  data = '0x00',
): SqliteChainEventLogRow {
  return {
    blockNumber,
    logIndex,
    blockHash: hash(blockNumber),
    transactionHash: hash(0xaa),
    address: ADDRESS,
    topics: [TOPIC],
    data,
    settled,
  };
}

function commit(
  settledBlockNumber: number,
  headBlockNumber: number,
  rows: readonly SqliteChainEventLogRow[],
  coveredFromBlock = 1,
): SqliteChainEventLogCommit {
  return {
    // A pass that fetched from just above the settled cursor up to its head —
    // the only tail this commit may replace.
    replacedRange: {
      fromBlockNumber: settledBlockNumber + 1,
      throughBlockNumber: headBlockNumber,
    },
    cursor: {
      lineage: hash(0x01),
      deploymentBlockNumber: 1,
      settledBlockNumber,
      settledBlockHash: hash(settledBlockNumber),
      head: {
        number: headBlockNumber,
        hash: hash(headBlockNumber),
        timestampSeconds: 1_700_000_000,
        fetchedAtMs: 1_700_000_000_000,
      },
      topicSetVersion: 'v1',
    },
    rows,
    coverage: [{
      family: 'context-graph-authority',
      address: ADDRESS,
      coveredFromBlock,
      coveredThroughBlock: headBlockNumber,
      floorBlock: 1,
    }],
  };
}

describe('SqliteChainEventLogStore', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createStore(): { db: DashboardDB; store: SqliteChainEventLogStore; dataDir: string } {
    const dataDir = mkdtempSync(join(tmpdir(), 'dkg-chain-log-'));
    directories.push(dataDir);
    const db = new DashboardDB({ dataDir });
    return { db, store: new SqliteChainEventLogStore(db), dataDir };
  }

  it('round-trips the cursor and the coverage record', async () => {
    const { store } = createStore();

    expect(await store.commit(SCOPE, undefined, commit(10, 12, [row(11, 0, false)]))).toBe(1);

    const state = await store.load(SCOPE);
    expect(state?.cursor.revision).toBe(1);
    expect(state?.cursor.settledBlockNumber).toBe(10);
    expect(state?.coverage).toEqual([{
      family: 'context-graph-authority',
      address: ADDRESS,
      coveredFromBlock: 1,
      coveredThroughBlock: 12,
      floorBlock: 1,
    }]);
  });

  it('replaces the whole tail but writes a settled row exactly once', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [
      row(10, 0, true, '0xsettled'),
      row(11, 0, false, '0xorphan'),
    ]));

    // The orphan is simply absent from the next pass, and the settled row is
    // offered again with different bytes: the first write must win.
    expect(await store.commit(SCOPE, 1, commit(10, 13, [
      row(10, 0, true, '0xrewritten'),
      row(13, 0, false),
    ]))).toBe(2);

    const held = await store.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 20 });
    expect(held.map((entry) => entry.blockNumber)).toEqual([10, 13]);
    expect(held[0]!.data).toBe('0xsettled');
  });

  it('loses the CAS when another writer advanced the cursor first', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, []));
    expect(await store.commit(SCOPE, 1, commit(11, 13, []))).toBe(2);

    expect(await store.commit(SCOPE, 1, commit(11, 13, []))).toBeUndefined();
  });

  it('refuses to re-initialize a live cursor as if the scope were cold', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, []));

    expect(await store.commit(SCOPE, undefined, commit(0, 1, []))).toBeUndefined();
    expect((await store.load(SCOPE))?.cursor.settledBlockNumber).toBe(10);
  });

  it('a tombstone wipes every derived row and its token never repeats', async () => {
    const { store, db } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [row(10, 0, true)]));
    db.db.prepare(`
      INSERT INTO cg_state (
        scope, context_graph_id, owner, active, access_policy, publish_policy,
        publish_authority, publish_authority_account_id, name_hash, ownership_era,
        policy_version, roster_version, source_block_number, source_block_hash
      ) VALUES (?, '7', ?, 1, 1, 0, ?, '7', ?, 1, 1, 1, 10, ?)
    `).run(SCOPE, ADDRESS, ADDRESS, hash(0x22), hash(10));

    // Assert the scope IS loadable first, so the checks below cannot pass
    // simply because nothing was ever there.
    expect(await store.load(SCOPE)).toBeDefined();

    expect(await store.tombstone(SCOPE, 1)).toBe(2);

    expect(await store.load(SCOPE)).toBeUndefined();
    expect(await store.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 99 }))
      .toEqual([]);
    expect(db.db.prepare(`SELECT COUNT(*) AS n FROM cg_state WHERE scope = ?`)
      .get(SCOPE)).toEqual({ n: 0 });

    // A cold start after the tombstone must not reuse the dead token.
    expect(await store.commit(SCOPE, undefined, commit(20, 22, []))).toBe(3);
  });

  it('survives a restart of the daemon', async () => {
    const { store, dataDir } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [row(10, 0, true)]));

    const reopened = new SqliteChainEventLogStore(new DashboardDB({ dataDir }));
    expect((await reopened.load(SCOPE))?.cursor.settledBlockNumber).toBe(10);
    expect(await reopened.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 20 }))
      .toHaveLength(1);
  });

  it('answers a block hash from the cursor and from the rows', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [row(11, 0, false)]));

    expect(await store.blockHashAt(SCOPE, 10)).toBe(hash(10));
    expect(await store.blockHashAt(SCOPE, 11)).toBe(hash(11));
    expect(await store.blockHashAt(SCOPE, 9)).toBeUndefined();
  });

  /**
   * THE invariant: coverage claims a range ⇒ the rows that range held are still
   * in the table.
   *
   * Every "is this absent?" answer in the node bottoms out in a coverage check
   * followed by a read. If a commit can drop rows inside a range coverage still
   * claims, that pair reports "indexed, and nothing there" for a block that
   * really held an event — a missed `AgentParticipantRemoved` leaves a revoked
   * member on a roster, a missed `ContextGraphCreated` reads as absent.
   */
  it('keeps every row inside a range coverage still claims, whatever the commit does',
    async () => {
      const { store } = createStore();
      await store.commit(SCOPE, undefined, commit(10, 12, [
        row(10, 0, true),
        row(12, 0, false),
      ]));

      // Three commits that between them cover every shape the tick emits: a
      // settled-history append, a note that carries no rows at all, and a pass
      // that re-fetched a NARROWER range than the one already claimed.
      let revision = 1;
      for (const next of [
        { ...commit(10, 12, [row(4, 0, true)], 4), replacedRange: undefined },
        { ...commit(10, 12, []), replacedRange: undefined },
        { ...commit(10, 12, []), replacedRange: { fromBlockNumber: 11, throughBlockNumber: 11 } },
      ]) {
        const applied = await store.commit(SCOPE, revision, next);
        expect(applied).toBe(revision + 1);
        revision = applied!;

        const state = await store.load(SCOPE);
        const coverage = state!.coverage[0]!;
        const held = await store.readEvents(SCOPE, {
          fromBlockNumber: coverage.coveredFromBlock,
          throughBlockNumber: coverage.coveredThroughBlock,
        });
        // Block 12 is inside [coveredFrom, coveredThrough] and held a row.
        expect(coverage.coveredThroughBlock).toBeGreaterThanOrEqual(12);
        expect(held.map((entry) => entry.blockNumber)).toContain(12);
      }
    });

  it('refuses a tail row the commit has not claimed the right to replace', async () => {
    const { store } = createStore();
    // Without a `replacedRange` covering it, this row could never be replaced
    // by a later pass and would outlive the chain it came from.
    await expect(store.commit(SCOPE, undefined, {
      ...commit(10, 12, [row(12, 0, false)]),
      replacedRange: undefined,
    })).rejects.toThrow(/outside the replaced range/);
  });

  it('keeps a fork suspicion across a commit that says nothing about forks', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, []));
    expect(await store.commit(SCOPE, 1, {
      ...commit(10, 12, []),
      suspectedForkBlockNumber: 10,
    })).toBe(2);
    expect((await store.load(SCOPE))?.suspectedForkBlockNumber).toBe(10);

    // A backfill page between two mismatching passes. Erasing the suspicion
    // here is what made the two-pass tombstone unreachable.
    expect(await store.commit(SCOPE, 2, {
      ...commit(10, 12, []),
      replacedRange: undefined,
    })).toBe(3);

    expect((await store.load(SCOPE))?.suspectedForkBlockNumber).toBe(10);
  });

  it('clears a fork suspicion only when a pass explicitly withdraws it', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, []));
    await store.commit(SCOPE, 1, { ...commit(10, 12, []), suspectedForkBlockNumber: 10 });

    expect(await store.commit(SCOPE, 2, {
      ...commit(10, 12, []),
      clearsForkSuspicion: true,
    })).toBe(3);

    expect((await store.load(SCOPE))?.suspectedForkBlockNumber).toBeUndefined();
  });

  it('round-trips a fork suspicion through a restart', async () => {
    const { store, dataDir } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, []));
    await store.commit(SCOPE, 1, { ...commit(10, 12, []), suspectedForkBlockNumber: 10 });

    const reopened = new SqliteChainEventLogStore(new DashboardDB({ dataDir }));
    expect((await reopened.load(SCOPE))?.suspectedForkBlockNumber).toBe(10);
  });
});
