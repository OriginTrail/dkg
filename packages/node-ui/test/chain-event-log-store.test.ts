import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DashboardDB } from '../src/db.js';
import {
  SqliteChainEventLogReader,
  SqliteChainEventLogStore,
  type SqliteChainEventLogCommit,
  type SqliteChainEventLogRow,
} from '../src/chain-event-log-store.js';

const SCOPE = 'evm:31337:0xhub:0xstorage';
const OTHER_SCOPE = 'evm:31337:0xother-hub:0xstorage';
const ADDRESS = `0x${'cd'.repeat(20)}`;
const OTHER_ADDRESS = `0x${'ef'.repeat(20)}`;
const TOPIC = `0x${'01'.repeat(32)}`;
const OTHER_TOPIC = `0x${'02'.repeat(32)}`;
const GRAPH_TOPIC = `0x${'03'.repeat(32)}`;
const OTHER_GRAPH_TOPIC = `0x${'04'.repeat(32)}`;
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

  it('serves the same state, indexed rows and hashes through a separate read-only handle', async () => {
    const { db, store, dataDir } = createStore();
    const kaTopic = hash(0x05);
    const selected = [
      { ...row(10, 0, true), topics: [TOPIC, GRAPH_TOPIC, kaTopic] },
      { ...row(11, 0, false), topics: [TOPIC, GRAPH_TOPIC, kaTopic] },
    ];
    await store.commit(SCOPE, undefined, {
      ...commit(10, 12, [...selected, { ...row(12, 0, false), address: OTHER_ADDRESS }]),
      suspectedForkBlockNumber: 9,
    });
    await store.commit(OTHER_SCOPE, undefined, commit(10, 12, [row(10, 0, true)]));
    const handle = new Database(join(dataDir, 'node-ui.db'), { readonly: true, fileMustExist: true });
    handle.pragma('query_only = ON');
    const reader = new SqliteChainEventLogReader(handle);
    const query = {
      fromBlockNumber: 1, throughBlockNumber: 12,
      addresses: [ADDRESS], topic0: [TOPIC], topic1: [GRAPH_TOPIC], topic2: [kaTopic],
    };
    try {
      expect(handle.readonly).toBe(true);
      expect(reader).not.toHaveProperty('commit');
      expect(reader).not.toHaveProperty('tombstone');
      expect(await reader.load(SCOPE)).toEqual(await store.load(SCOPE));
      await expect(reader.load('unknown-scope')).resolves.toBeUndefined();
      expect(await reader.readEvents(SCOPE, query)).toEqual(await store.readEvents(SCOPE, query));
      await expect(reader.readEventsBounded(SCOPE, query, 2)).resolves.toEqual(selected);
      await expect(reader.readEventsBounded(SCOPE, query, 1)).resolves.toBeUndefined();
      await expect(reader.readEventsBounded(OTHER_SCOPE, query, 2)).resolves.toEqual([]);
      for (const block of [10, 11, 12, 99]) {
        expect(await reader.blockHashAt(SCOPE, block)).toBe(await store.blockHashAt(SCOPE, block));
      }
      // A read-only connection sees later durable invalidation without ever
      // gaining the writer's commit/tombstone capability.
      await store.tombstone(SCOPE, 1);
      await expect(reader.load(SCOPE)).resolves.toBeUndefined();
      await expect(reader.readEventsBounded(SCOPE, query, 2)).resolves.toEqual([]);
      await expect(reader.blockHashAt(SCOPE, 10)).resolves.toBeUndefined();
    } finally {
      handle.close();
      db.close();
    }
  });

  it('holds one caller-owned read snapshot across a concurrent writer commit', async () => {
    const { db, store, dataDir } = createStore();
    const first = row(11, 0, false, '0xfirst');
    const replacement = row(11, 1, false, '0xreplacement');
    await store.commit(SCOPE, undefined, commit(10, 12, [first]));
    const handle = new Database(join(dataDir, 'node-ui.db'), { readonly: true, fileMustExist: true });
    handle.pragma('query_only = ON');
    const reader = new SqliteChainEventLogReader(handle);
    const query = { fromBlockNumber: 1, throughBlockNumber: 12 };
    try {
      handle.exec('BEGIN');
      expect((await reader.load(SCOPE))?.cursor.revision).toBe(1);
      await store.commit(SCOPE, 1, commit(10, 12, [replacement]));
      expect((await reader.load(SCOPE))?.cursor.revision).toBe(1);
      await expect(reader.readEventsBounded(SCOPE, query, 1)).resolves.toEqual([first]);
      handle.exec('ROLLBACK');
      expect((await reader.load(SCOPE))?.cursor.revision).toBe(2);
      await expect(reader.readEventsBounded(SCOPE, query, 1)).resolves.toEqual([replacement]);
    } finally {
      if (handle.inTransaction) handle.exec('ROLLBACK');
      handle.close();
      db.close();
    }
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

  it('filters persisted rows by address, topic0 and topic1 in SQLite', async () => {
    const { store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [
      { ...row(10, 0, true), topics: [TOPIC, GRAPH_TOPIC] },
      { ...row(11, 0, false), address: OTHER_ADDRESS, topics: [TOPIC, GRAPH_TOPIC] },
      { ...row(12, 0, false), topics: [OTHER_TOPIC, OTHER_GRAPH_TOPIC] },
    ]));

    const matchingBlocks = async (query: Parameters<typeof store.readEvents>[1]) => (
      (await store.readEvents(SCOPE, query)).map((entry) => entry.blockNumber)
    );
    const range = { fromBlockNumber: 0, throughBlockNumber: 20 };

    await expect(matchingBlocks({ ...range, addresses: [ADDRESS] })).resolves.toEqual([10, 12]);
    await expect(matchingBlocks({ ...range, topic0: [TOPIC] })).resolves.toEqual([10, 11]);
    await expect(matchingBlocks({ ...range, topic1: [GRAPH_TOPIC] })).resolves.toEqual([10, 11]);
    await expect(matchingBlocks({
      ...range,
      addresses: [ADDRESS],
      topic0: [TOPIC],
      topic1: [GRAPH_TOPIC],
    })).resolves.toEqual([10]);
    await expect(matchingBlocks({ ...range, topic1: [OTHER_TOPIC] })).resolves.toEqual([]);
  });

  it('filters KA topic2 with scope, emitter, event signature and the block window', async () => {
    const { store } = createStore();
    const kaTopic = hash(0x05);
    const target = { ...row(10, 0, true), topics: [TOPIC, GRAPH_TOPIC, kaTopic] };
    await store.commit(SCOPE, undefined, commit(10, 12, [
      target,
      { ...target, logIndex: 1, address: OTHER_ADDRESS },
      { ...target, logIndex: 2, topics: [OTHER_TOPIC, GRAPH_TOPIC, kaTopic] },
      { ...target, logIndex: 3, topics: [TOPIC, GRAPH_TOPIC, hash(0x06)] },
      { ...target, blockNumber: 9, logIndex: 0 },
      { ...row(12, 0, false), topics: target.topics },
    ]));
    await store.commit(OTHER_SCOPE, undefined, commit(10, 12, [target]));

    await expect(store.readEvents(SCOPE, {
      fromBlockNumber: 10,
      throughBlockNumber: 11,
      addresses: [ADDRESS],
      topic0: [TOPIC],
      topic2: [kaTopic],
    })).resolves.toEqual([target]);
    await expect(store.readEvents(SCOPE, {
      fromBlockNumber: 0, throughBlockNumber: 20, topic2: [hash(0x07)],
    })).resolves.toEqual([]);
  });

  it('uses the KA index for the actual point-read SQL instead of scanning the event history', async () => {
    const { db, store } = createStore();
    const topicFor = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      ...row(10, index, true),
      topics: [TOPIC, GRAPH_TOPIC, topicFor(index)],
    }));
    await store.commit(SCOPE, undefined, commit(10, 12, rows));
    const prepare = vi.spyOn(db.db, 'prepare');
    const result = await store.readEvents(SCOPE, {
      fromBlockNumber: 1,
      throughBlockNumber: 12,
      addresses: [ADDRESS],
      topic0: [TOPIC],
      topic2: [topicFor(1_500)],
    });
    const sql = prepare.mock.calls.find(([query]) => query.includes('FROM chain_events'))?.[0];
    prepare.mockRestore();
    expect(result).toEqual([rows[1_500]]);
    expect(sql).toBeDefined();
    const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${sql!}`)
      .all(SCOPE, 1, 12, ADDRESS, TOPIC, topicFor(1_500)) as { detail: string }[];
    const details = plan.map(({ detail }) => detail).join('\n');
    expect(details).toMatch(/SEARCH chain_events USING INDEX idx_chain_events_scope_address_ka/);
    expect(details).toMatch(/topic2=\?/);
    expect(details).not.toMatch(/SCAN chain_events|USE TEMP B-TREE/);
  });

  it('removes replaced and tombstoned registrations from the KA index', async () => {
    const { store } = createStore();
    const kaTopic = hash(0x05);
    const orphan = { ...row(12, 0, false), topics: [TOPIC, GRAPH_TOPIC, kaTopic] };
    const replacement = { ...row(12, 1, false), topics: [TOPIC, OTHER_GRAPH_TOPIC, kaTopic] };
    const query = {
      fromBlockNumber: 1, throughBlockNumber: 12,
      addresses: [ADDRESS], topic0: [TOPIC], topic2: [kaTopic],
    };
    await store.commit(SCOPE, undefined, commit(10, 12, [orphan]));
    await expect(store.readEvents(SCOPE, query)).resolves.toEqual([orphan]);
    await store.commit(SCOPE, 1, commit(10, 12, [replacement]));
    await expect(store.readEvents(SCOPE, query)).resolves.toEqual([replacement]);
    await store.tombstone(SCOPE, 2);
    await expect(store.readEvents(SCOPE, query)).resolves.toEqual([]);
  });

  it('returns a complete bounded result at the exact cap with the same filters and order', async () => {
    const { store } = createStore();
    const target = [
      { ...row(10, 1, true), topics: [TOPIC, GRAPH_TOPIC, hash(0x05)] },
      { ...row(10, 2, true), topics: [TOPIC, GRAPH_TOPIC, hash(0x05)] },
    ];
    await store.commit(SCOPE, undefined, commit(10, 12, [
      target[1]!, target[0]!,
      { ...row(10, 3, true), topics: [TOPIC, GRAPH_TOPIC, hash(0x06)] },
      { ...row(10, 4, true), topics: [TOPIC, GRAPH_TOPIC, hash(0x05)], address: OTHER_ADDRESS },
    ]));
    const query = {
      fromBlockNumber: 10, throughBlockNumber: 11,
      addresses: [ADDRESS], topic0: [TOPIC], topic1: [GRAPH_TOPIC], topic2: [hash(0x05)],
    };
    await expect(store.readEventsBounded(SCOPE, query, 2)).resolves.toEqual(target);
    expect(await store.readEventsBounded(SCOPE, query, 2)).toEqual(await store.readEvents(SCOPE, query));
    await expect(store.readEventsBounded(SCOPE, { ...query, topic2: [hash(0x07)] }, 1))
      .resolves.toEqual([]);
    await expect(store.readEventsBounded(OTHER_SCOPE, query, 1)).resolves.toEqual([]);
  });

  it('limits native row allocation and refuses overflow instead of returning truncated history', async () => {
    const { db, store } = createStore();
    await store.commit(SCOPE, undefined, commit(10, 12, [
      row(10, 0, true), row(10, 1, true), row(10, 2, true),
    ]));
    const prepare = vi.spyOn(db.db, 'prepare');
    await expect(store.readEventsBounded(SCOPE, {
      fromBlockNumber: 0, throughBlockNumber: 20,
    }, 2)).resolves.toBeUndefined();
    const sql = prepare.mock.calls.find(([query]) => query.includes('FROM chain_events'))?.[0];
    prepare.mockRestore();
    expect(sql).toMatch(/ORDER BY block_number, log_index\s+LIMIT \?/);
    await expect(store.readEventsBounded(SCOPE, {
      fromBlockNumber: 0, throughBlockNumber: 20,
    }, 3)).resolves.toHaveLength(3);
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'refuses an invalid bounded row cap %s before reading the database', async (maxRows) => {
      const { db, store } = createStore();
      const prepare = vi.spyOn(db.db, 'prepare');
      await expect(store.readEventsBounded(SCOPE, {
        fromBlockNumber: 0, throughBlockNumber: 20,
      }, maxRows)).rejects.toThrow('maximum row count');
      expect(prepare).not.toHaveBeenCalled();
      prepare.mockRestore();
    },
  );

  it('adds the KA lookup index to an existing current-version database without changing rows', async () => {
    const { db, store, dataDir } = createStore();
    const target = { ...row(10, 0, true), topics: [TOPIC, GRAPH_TOPIC, hash(0x05)] };
    await store.commit(SCOPE, undefined, commit(10, 12, [target]));
    const version = db.db.pragma('user_version', { simple: true });
    db.db.exec('DROP INDEX idx_chain_events_scope_address_ka');
    db.close();

    const reopened = new DashboardDB({ dataDir });
    try {
      const columns = reopened.db.prepare('PRAGMA index_info(idx_chain_events_scope_address_ka)')
        .all() as { name: string }[];
      expect(columns.map(({ name }) => name)).toEqual([
        'scope', 'address', 'topic0', 'topic2', 'block_number', 'log_index',
      ]);
      expect(reopened.db.pragma('user_version', { simple: true })).toBe(version);
      await expect(new SqliteChainEventLogStore(reopened).readEvents(SCOPE, {
        fromBlockNumber: 0, throughBlockNumber: 20, topic2: [hash(0x05)],
      })).resolves.toEqual([target]);
    } finally {
      reopened.close();
    }
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

    // Assert the scope IS loadable first, so the checks below cannot pass
    // simply because nothing was ever there.
    expect(await store.load(SCOPE)).toBeDefined();

    expect(await store.tombstone(SCOPE, 1)).toBe(2);

    expect(await store.load(SCOPE)).toBeUndefined();
    expect(await store.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 99 }))
      .toEqual([]);
    expect(db.db.prepare(`SELECT COUNT(*) AS n FROM chain_index_coverage WHERE scope = ?`)
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

  it('isolates state, rows, hashes, CAS and tombstones between scopes', async () => {
    const { store } = createStore();
    const rowA = row(11, 0, false, '0xaaaa');
    const rowB = { ...row(11, 0, false, '0xbbbb'), blockHash: hash(0xbb) };
    const otherScopeCommit = (headBlockNumber: number): SqliteChainEventLogCommit => {
      const value = commit(10, headBlockNumber, [rowB]);
      return {
        ...value,
        coverage: [{
          ...value.coverage[0]!,
          address: OTHER_ADDRESS,
          coveredFromBlock: 2,
        }],
      };
    };

    expect(await store.commit(SCOPE, undefined, commit(10, 12, [rowA]))).toBe(1);
    expect(await store.commit(OTHER_SCOPE, undefined, otherScopeCommit(12))).toBe(1);

    expect((await store.load(SCOPE))?.cursor.revision).toBe(1);
    expect((await store.load(SCOPE))?.coverage).toEqual([{
      family: 'context-graph-authority',
      address: ADDRESS,
      coveredFromBlock: 1,
      coveredThroughBlock: 12,
      floorBlock: 1,
    }]);
    expect((await store.load(OTHER_SCOPE))?.cursor.revision).toBe(1);
    expect((await store.load(OTHER_SCOPE))?.coverage).toEqual([{
      family: 'context-graph-authority',
      address: OTHER_ADDRESS,
      coveredFromBlock: 2,
      coveredThroughBlock: 12,
      floorBlock: 1,
    }]);
    expect((await store.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 20 }))[0])
      .toMatchObject({ data: '0xaaaa', blockHash: hash(11) });
    expect((await store.readEvents(OTHER_SCOPE, {
      fromBlockNumber: 0,
      throughBlockNumber: 20,
    }))[0]).toMatchObject({ data: '0xbbbb', blockHash: hash(0xbb) });
    expect(await store.blockHashAt(SCOPE, 11)).toBe(hash(11));
    expect(await store.blockHashAt(OTHER_SCOPE, 11)).toBe(hash(0xbb));

    expect(await store.commit(SCOPE, 1, commit(10, 13, [rowA]))).toBe(2);
    expect((await store.load(OTHER_SCOPE))?.cursor.revision).toBe(1);
    expect(await store.commit(OTHER_SCOPE, 1, otherScopeCommit(13))).toBe(2);

    expect(await store.tombstone(SCOPE, 2)).toBe(3);
    expect(await store.load(SCOPE)).toBeUndefined();
    expect((await store.load(OTHER_SCOPE))?.coverage).toEqual([{
      family: 'context-graph-authority',
      address: OTHER_ADDRESS,
      coveredFromBlock: 2,
      coveredThroughBlock: 13,
      floorBlock: 1,
    }]);
    expect(await store.readEvents(SCOPE, { fromBlockNumber: 0, throughBlockNumber: 20 }))
      .toEqual([]);
    expect(await store.readEvents(OTHER_SCOPE, { fromBlockNumber: 0, throughBlockNumber: 20 }))
      .toHaveLength(1);
  });

  it('never serves the zero settled-hash sentinel as a block hash', async () => {
    const { store } = createStore();
    const initial = commit(10, 12, []);
    await store.commit(SCOPE, undefined, {
      ...initial,
      cursor: {
        ...initial.cursor,
        settledBlockHash: `0x${'00'.repeat(32)}`,
      },
    });

    expect(await store.blockHashAt(SCOPE, 10)).toBeUndefined();
    expect(await store.blockHashAt(SCOPE, 12)).toBe(hash(12));
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
