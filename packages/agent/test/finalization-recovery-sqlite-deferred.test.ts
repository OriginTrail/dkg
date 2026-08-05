import { rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  openSqliteFinalizationRecoveryStore,
} from '../src/finalization-recovery-sqlite-store.js';
import {
  RAW,
  evidence,
  received,
  temporaryDirectory,
} from './finalization-recovery-sqlite-test-helpers.js';

describe('SQLite finalization recovery deferred spool', () => {
  it('durably defers a new envelope when live capacity is full', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, { maxEntries: 1 });
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      expect(await store.list()).toMatchObject([{ key: 'entry-1', state: 'VERIFIED' }]);
      expect(await store.health()).toMatchObject({
        available: true,
        ready: false,
        degradedReason: 'capacity-exhausted',
        deferredEntries: 1,
      });

      await store.transition('entry-1', 0, 'SETTLED');
      await expect(store.promotePending(16)).resolves.toBe(1);
      expect(await store.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'entry-2', state: 'RECEIVED' }),
      ]));
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps pending duplicate admission idempotent and rejects conflicting replacements', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, { maxEntries: 1 });
      await store.receive(received());
      const pending = received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      });
      await expect(store.receive(pending)).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(pending)).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        ...pending,
        rawMessage: Uint8Array.from([9, 9, 9]),
      }))).resolves.toEqual({ status: 'conflict' });
      await expect(store.receive(received({
        ...pending,
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'conflict' });

      await store.transition('entry-1', 0, 'SUPERSEDED');
      await expect(store.promotePending(1)).resolves.toBe(1);
      await expect(store.get('entry-2')).resolves.toMatchObject({
        txHash: `0x${'ef'.repeat(32)}`,
        rawMessage: RAW,
      });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces the global deferred-entry quota independently', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 1,
        maxDeferredPerPeer: 10,
        maxDeferredPerContextGraph: 10,
      });
      await store.receive(received());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'entry-3',
        contextGraphId: 'other-graph',
        sourcePeerId: '12D3KooWOtherPublisher',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'capacity' });
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces the per-peer deferred quota independently', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 10,
        maxDeferredPerPeer: 1,
        maxDeferredPerContextGraph: 10,
      });
      await store.receive(received());
      await expect(store.receive(received({
        key: 'entry-2',
        contextGraphId: 'graph-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'entry-3',
        contextGraphId: 'graph-3',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'capacity' });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces the per-context-graph deferred quota independently', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 10,
        maxDeferredPerPeer: 10,
        maxDeferredPerContextGraph: 1,
      });
      await store.receive(received());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'entry-3',
        sourcePeerId: '12D3KooWOtherPublisher',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'capacity' });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('enforces the deferred-byte quota independently', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 10,
        maxDeferredBytes: 6,
        maxDeferredPerPeer: 10,
        maxDeferredPerContextGraph: 10,
      });
      await store.receive(received());
      await expect(store.receive(received({
        key: 'entry-2',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'entry-3',
        contextGraphId: 'graph-3',
        sourcePeerId: '12D3KooWOtherPublisher',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'capacity' });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not let a quota-blocked oldest graph starve a later eligible graph', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 2,
        maxPerPeer: 8,
        maxPerContextGraph: 1,
      });
      await store.receive(received({
        key: 'live-graph-a',
        contextGraphId: 'graph-a',
        txHash: `0x${'a1'.repeat(32)}`,
      }));
      await store.receive(received({
        key: 'live-graph-x',
        contextGraphId: 'graph-x',
        txHash: `0x${'a2'.repeat(32)}`,
      }));
      await expect(store.receive(received({
        key: 'pending-graph-a',
        contextGraphId: 'graph-a',
        txHash: `0x${'b1'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });
      await expect(store.receive(received({
        key: 'pending-graph-b',
        contextGraphId: 'graph-b',
        txHash: `0x${'b2'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });

      await store.transition('live-graph-x', 0, 'SUPERSEDED');
      await expect(store.promotePending(1)).resolves.toBe(1);
      expect(await store.get('pending-graph-b')).toMatchObject({
        key: 'pending-graph-b',
        state: 'RECEIVED',
      });
      expect(await store.get('pending-graph-a')).toBeUndefined();
      expect(await store.health()).toMatchObject({ deferredEntries: 1 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('accepts the 129th envelope durably and promotes it after the 128-entry backlog drains', async () => {
    const directory = await temporaryDirectory();
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 128,
        maxPerPeer: 128,
        maxPerContextGraph: 128,
      });
      for (let index = 0; index < 128; index += 1) {
        await expect(store.receive(received({
          key: `entry-${index}`,
          txHash: `0x${index.toString(16).padStart(64, '0')}`,
          kaId: String(index),
        }))).resolves.toMatchObject({ status: 'inserted' });
      }
      const overflow = received({
        key: 'entry-128',
        txHash: `0x${'ff'.repeat(32)}`,
        kaId: '128',
      });
      await expect(store.receive(overflow)).resolves.toEqual({ status: 'pending' });
      expect(await store.health()).toMatchObject({
        deferredEntries: 1,
        dueEntries: 128,
      });

      await store.transition('entry-0', 0, 'SUPERSEDED');
      await expect(store.promotePending(16)).resolves.toBe(1);
      expect(await store.get('entry-128')).toMatchObject({
        state: 'RECEIVED',
        kaId: '128',
      });
      expect(await store.health()).toMatchObject({ deferredEntries: 0 });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('expires stale deferred envelopes while preserving VERIFIED live evidence', async () => {
    const directory = await temporaryDirectory();
    let now = 1_000;
    try {
      const store = await openSqliteFinalizationRecoveryStore(directory, {
        maxEntries: 1,
        maxDeferredEntries: 1,
        rawTtlMs: 100,
        now: () => now,
      });
      await store.receive(received());
      await store.markVerified('entry-1', 0, evidence());
      await expect(store.receive(received({
        key: 'stale-pending',
        txHash: `0x${'ef'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });

      now += 101;
      await expect(store.receive(received({
        key: 'fresh-pending',
        contextGraphId: 'fresh-graph',
        sourcePeerId: '12D3KooWFreshPublisher',
        txHash: `0x${'12'.repeat(32)}`,
      }))).resolves.toEqual({ status: 'pending' });

      expect(await store.list()).toMatchObject([{ key: 'entry-1', state: 'VERIFIED' }]);
      expect(await store.health()).toMatchObject({
        deferredEntries: 1,
        deferredPayloadBytes: RAW.byteLength,
      });
      await store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

});
