import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  openSqliteFinalizationRecoveryStore,
  type FinalizationRecoveryDisplacement,
  type SqliteFinalizationRecoveryStoreOptions,
} from '../src/finalization-recovery-sqlite-store.js';
import type { FinalizationRecoveryFailureCode } from '../src/finalization-recovery-store.js';
import { evidence, received, temporaryDirectory } from './finalization-recovery-sqlite-test-helpers.js';

const MINUTE = 60_000;
const PUBLISHER = '12D3KooWPublisher';

type Store = Awaited<ReturnType<typeof openSqliteFinalizationRecoveryStore>>;

function entry(index: number, overrides: { sourcePeerId?: string; contextGraphId?: string } = {}) {
  return received({
    key: `entry-${index}`,
    sourcePeerId: overrides.sourcePeerId ?? PUBLISHER,
    contextGraphId: overrides.contextGraphId ?? 'graph',
    txHash: `0x${index.toString(16).padStart(2, '0').repeat(32)}`,
    ual: `did:dkg:base:84532/0x1111111111111111111111111111111111111111/${index}`,
  });
}

async function withStore(
  options: SqliteFinalizationRecoveryStoreOptions,
  run: (store: Store, displaced: FinalizationRecoveryDisplacement[]) => Promise<void>,
): Promise<void> {
  const directory = await temporaryDirectory();
  const displaced: FinalizationRecoveryDisplacement[] = [];
  const store = await openSqliteFinalizationRecoveryStore(directory, {
    ...options,
    onDisplaced: (displacement) => displaced.push(displacement),
  });
  try {
    await run(store, displaced);
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function fail(
  store: Store,
  key: string,
  times: number,
  failureCode: FinalizationRecoveryFailureCode = 'workspace-unavailable',
): Promise<void> {
  for (let attempt = 0; attempt < times; attempt += 1) {
    await store.recordAttempt(key, 0, 'workspace preparation is unavailable', {
      mode: 'stable-failure',
      retryDelayMs: 1_000,
      failureCode,
      stableFailureThreshold: 3,
      stableFailureRetryMs: 6 * 60 * MINUTE,
      retryDeadlineAt: Number.MAX_SAFE_INTEGER,
    });
  }
}

describe('SQLite finalization recovery displacement', () => {
  it('parks an entry that keeps failing to admit the same publisher\'s next finalization', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 2, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await store.receive(entry(2));
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(3))).resolves.toMatchObject({ status: 'inserted' });

      await expect(store.get('entry-1')).resolves.toBeUndefined();
      await expect(store.get('entry-2')).resolves.toMatchObject({ state: 'RECEIVED' });
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      expect(displaced).toEqual([expect.objectContaining({
        key: 'entry-1',
        failureSignature: 'workspace-unavailable',
        failureStreak: 3,
        admittedKey: 'entry-3',
      })]);

      // Nothing was lost: the parked entry returns, with its receipt time,
      // once the inbox has room.
      await store.transition('entry-3', 0, 'SUPERSEDED');
      await expect(store.promotePending(1)).resolves.toBe(1);
      await expect(store.get('entry-1')).resolves.toMatchObject({
        state: 'RECEIVED',
        createdAt: 1_000_000,
      });
    });
  });

  it.each([
    { name: 'is still retrying', failures: 2, code: 'workspace-unavailable', ageMs: 5 * MINUTE },
    { name: 'is younger than the minimum age', failures: 3, code: 'workspace-unavailable', ageMs: 4 * MINUTE },
    { name: 'failed another way', failures: 3, code: 'receipt-pending', ageMs: 5 * MINUTE },
  ] as const)('parks the new finalization instead of an entry that $name', async ({
    failures,
    code,
    ageMs,
  }) => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await fail(store, 'entry-1', failures, code);
      now += ageMs;

      await expect(store.receive(entry(2))).resolves.toEqual({ status: 'pending' });

      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
      expect(displaced).toEqual([]);
    });
  });

  it('never parks a verified entry', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(received());
      await store.commitVerifiedEvidence('entry-1', 0, { evidence: evidence(), placement: 'original' });
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(2))).resolves.toEqual({ status: 'pending' });

      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'VERIFIED' });
      expect(displaced).toEqual([]);
    });
  });

  it('leaves the inbox unchanged when parking would not make room', async () => {
    let now = 1_000_000;
    await withStore({ maxEntries: 2, maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1, { sourcePeerId: PUBLISHER }));
      await store.receive(entry(2, { sourcePeerId: '12D3KooWOtherPublisher' }));
      await fail(store, 'entry-2', 3);
      now += 5 * MINUTE;

      // Parking entry-2 frees the total limit, but the publisher's own limit
      // still holds entry-1, which is healthy.
      await expect(store.receive(entry(3, { sourcePeerId: PUBLISHER })))
        .resolves.toEqual({ status: 'pending' });

      await expect(store.get('entry-2')).resolves.toMatchObject({
        state: 'RECEIVED',
        failureStreak: 3,
      });
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      expect(displaced).toEqual([]);
    });
  });

  it('frees a Context Graph limit only with an entry from that graph', async () => {
    let now = 1_000_000;
    await withStore({ maxPerContextGraph: 2, now: () => now }, async (store, displaced) => {
      // entry-1 is the arriving publisher's own stable failure, but in another
      // graph: parking it would not free this graph's limit.
      await store.receive(entry(1, { sourcePeerId: 'peer-c', contextGraphId: 'other-graph' }));
      await store.receive(entry(2, { sourcePeerId: 'peer-a', contextGraphId: 'graph' }));
      await store.receive(entry(3, { sourcePeerId: 'peer-b', contextGraphId: 'graph' }));
      await fail(store, 'entry-1', 3);
      await fail(store, 'entry-2', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(4, { sourcePeerId: 'peer-c', contextGraphId: 'graph' })))
        .resolves.toMatchObject({ status: 'inserted' });

      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
      await expect(store.get('entry-2')).resolves.toBeUndefined();
      expect(displaced.map(({ key }) => key)).toEqual(['entry-2']);
    });
  });

  it('parks the arriving publisher\'s own stable failure before another publisher\'s older one', async () => {
    let now = 1_000_000;
    await withStore({ maxEntries: 3, maxPerPeer: 3, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1, { sourcePeerId: 'peer-other' }));
      now += MINUTE;
      await store.receive(entry(2, { sourcePeerId: PUBLISHER }));
      await store.receive(entry(3, { sourcePeerId: PUBLISHER }));
      await fail(store, 'entry-1', 3);
      await fail(store, 'entry-2', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(4, { sourcePeerId: PUBLISHER })))
        .resolves.toMatchObject({ status: 'inserted' });

      expect(displaced.map(({ key }) => key)).toEqual(['entry-2']);
      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
    });
  });

  it('keeps a parked entry recoverable when the arrival that parked it is later rejected', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, now: () => now }, async (store) => {
      await store.receive(entry(1));
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;
      // An arrival that has not been verified yet, for example a forged one.
      await expect(store.receive(entry(2))).resolves.toMatchObject({ status: 'inserted' });

      await store.transition('entry-2', 0, 'REJECTED', 'receipt not found');
      await expect(store.promotePending(1)).resolves.toBe(1);

      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
    });
  });

  it('admits a parked entry only into free capacity, never by displacing another', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;
      await store.receive(entry(2));
      await fail(store, 'entry-2', 3);
      now += 5 * MINUTE;

      await expect(store.promotePending(1)).resolves.toBe(0);
      await expect(store.get('entry-1')).resolves.toBeUndefined();
      await expect(store.get('entry-2')).resolves.toMatchObject({ state: 'RECEIVED' });

      await store.transition('entry-2', 0, 'SUPERSEDED');
      await expect(store.promotePending(1)).resolves.toBe(1);
      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
      expect(displaced.map(({ key }) => key)).toEqual(['entry-1']);
    });
  });

  it('does not park an entry when the deferred spool has no room for it', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, maxDeferredEntries: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await expect(store.receive(entry(2))).resolves.toEqual({ status: 'pending' });
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(3))).resolves.toEqual({ status: 'capacity' });

      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'RECEIVED' });
      expect(displaced).toEqual([]);
    });
  });
});
