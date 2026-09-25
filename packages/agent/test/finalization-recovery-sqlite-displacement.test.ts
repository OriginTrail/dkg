import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  openSqliteFinalizationRecoveryStore,
  type FinalizationRecoveryDisplacement,
  type SqliteFinalizationRecoveryStoreOptions,
} from '../src/finalization-recovery-sqlite-store.js';
import type { FinalizationRecoveryFailureCode } from '../src/finalization-recovery-store.js';
import { received, temporaryDirectory } from './finalization-recovery-sqlite-test-helpers.js';

const MINUTE = 60_000;

function entry(index: number, sourcePeerId = '12D3KooWPublisher') {
  return received({
    key: `entry-${index}`,
    sourcePeerId,
    txHash: `0x${index.toString(16).padStart(2, '0').repeat(32)}`,
    ual: `did:dkg:base:84532/0x1111111111111111111111111111111111111111/${index}`,
  });
}

async function withStore(
  options: SqliteFinalizationRecoveryStoreOptions,
  run: (
    store: Awaited<ReturnType<typeof openSqliteFinalizationRecoveryStore>>,
    displaced: FinalizationRecoveryDisplacement[],
  ) => Promise<void>,
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
  store: Awaited<ReturnType<typeof openSqliteFinalizationRecoveryStore>>,
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
  it('displaces an entry that keeps failing to admit the same publisher\'s next finalization', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 2, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await store.receive(entry(2));
      await fail(store, 'entry-1', 3);
      now += 5 * MINUTE;

      await expect(store.receive(entry(3))).resolves.toMatchObject({ status: 'inserted' });

      await expect(store.get('entry-1')).resolves.toMatchObject({
        state: 'REJECTED',
        lastError: expect.stringContaining('displaced to admit'),
      });
      await expect(store.get('entry-2')).resolves.toMatchObject({ state: 'RECEIVED' });
      expect(displaced).toEqual([expect.objectContaining({
        key: 'entry-1',
        failureSignature: 'workspace-unavailable',
        failureStreak: 3,
        admittedKey: 'entry-3',
      })]);
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
    });
  });

  it.each([
    { name: 'is still retrying', failures: 2, code: 'workspace-unavailable', ageMs: 5 * MINUTE },
    { name: 'is younger than the minimum age', failures: 3, code: 'workspace-unavailable', ageMs: 4 * MINUTE },
    { name: 'failed another way', failures: 3, code: 'receipt-pending', ageMs: 5 * MINUTE },
  ] as const)('parks the next finalization instead of displacing an entry that $name', async ({
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

  it('leaves the inbox unchanged when displacing would not make room', async () => {
    let now = 1_000_000;
    await withStore({ maxEntries: 2, maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1, '12D3KooWPublisher'));
      await store.receive(entry(2, '12D3KooWOtherPublisher'));
      await fail(store, 'entry-2', 3);
      now += 5 * MINUTE;

      // Displacing entry-2 frees the total limit, but the publisher's own
      // limit still holds entry-1, which is healthy.
      await expect(store.receive(entry(3, '12D3KooWPublisher')))
        .resolves.toEqual({ status: 'pending' });

      await expect(store.get('entry-2')).resolves.toMatchObject({
        state: 'RECEIVED',
        failureStreak: 3,
      });
      expect(displaced).toEqual([]);
    });
  });

  it('admits a parked finalization by displacing an entry that keeps failing', async () => {
    let now = 1_000_000;
    await withStore({ maxPerPeer: 1, now: () => now }, async (store, displaced) => {
      await store.receive(entry(1));
      await fail(store, 'entry-1', 3);
      await expect(store.receive(entry(2))).resolves.toEqual({ status: 'pending' });
      now += 5 * MINUTE;

      await expect(store.promotePending(1)).resolves.toBe(1);

      await expect(store.get('entry-2')).resolves.toMatchObject({ state: 'RECEIVED' });
      await expect(store.get('entry-1')).resolves.toMatchObject({ state: 'REJECTED' });
      expect(displaced).toEqual([expect.objectContaining({
        key: 'entry-1',
        admittedKey: 'entry-2',
      })]);
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
    });
  });
});
