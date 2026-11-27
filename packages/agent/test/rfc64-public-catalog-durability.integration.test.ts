import { join } from 'node:path';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNativeGate1FixtureOwner } from './helpers/native-gate1-fixture.js';
import { AUTHOR, setTransactionTestVmGeneration, readTransactionTestVmGeneration } from './helpers/native-gate1-fixture-values.js';
import { runCatalogDurabilityScenario } from './helpers/catalog-durability-scenario.js';
import type { Rfc64PersistenceV1 } from '../src/rfc64/persistence-v1.js';

const snapshotBarrier = vi.hoisted(() => ({
  path: null as string | null,
  captured: null as (() => void) | null,
  release: null as Promise<void> | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (snapshotBarrier.path === String(args[0]) && args[1] === 'w') {
      snapshotBarrier.path = null;
      snapshotBarrier.captured?.();
      await snapshotBarrier.release;
    }
    return actual.open(...args);
  } };
});

const fixtureOwner = createNativeGate1FixtureOwner();
const { setupLiveReceiver } = fixtureOwner;
afterEach(() => fixtureOwner.dispose());

describe('native catalog applied-head durability', () => {
  it('persists exact SWM and VM before applied-head CAS through a store decorator', async () => {
    await runCatalogDurabilityScenario(await setupLiveReceiver());
  }, 30_000);

  it('waits out an older in-flight snapshot and durably captures the activated generation', async () => {
    const fixture = await setupLiveReceiver();
    const snapshot = join(fixture.receiverDirectory, 'inflight.nq');
    const store = new OxigraphStore(snapshot);
    const scheduled = vi.spyOn(store as unknown as { scheduleFlush(): void }, 'scheduleFlush')
      .mockImplementation(() => {});
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let oldFlush: Promise<void> | undefined;
    let transition: Promise<unknown> | undefined;
    try {
      const initial = fixture.createReceiver(fixture.receiverPersistence.inventory,
        undefined, undefined, store);
      await fixture.bootstrap(fixture.genesisAnnouncement, initial);
      await setTransactionTestVmGeneration(store, 'predecessor');
      await store.flush();
      const captured = new Promise<void>((resolve) => { snapshotBarrier.captured = resolve; });
      snapshotBarrier.path = `${snapshot}.tmp`;
      snapshotBarrier.release = held;
      oldFlush = store.flush();
      await captured; // Actual old N-Quads serialization has already happened.
      let activated!: () => void;
      const activatedPromise = new Promise<void>((resolve) => { activated = resolve; });
      let atCas: OxigraphStore | undefined;
      const cas = vi.fn((...args: Parameters<
        Rfc64PersistenceV1['inventory']['compareAndSwapAppliedCatalogHeadV1']
      >) => {
        atCas = new OxigraphStore(snapshot);
        return fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1(...args);
      });
      const receiver = fixture.createReceiver({
        readAppliedCatalogHeadV1: fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1
          .bind(fixture.receiverPersistence.inventory),
        compareAndSwapAppliedCatalogHeadV1: cas,
      }, undefined, undefined, store, async () => {
        await setTransactionTestVmGeneration(store, 'target');
        activated();
      });
      transition = fixture.synchronize(fixture.announcement, receiver);
      await activatedPromise;
      await new Promise((resolve) => setImmediate(resolve));
      expect(cas).not.toHaveBeenCalled();
      release();
      await oldFlush;
      await transition;
      expect(cas).toHaveBeenCalledOnce();
      await expect(atCas!.countQuads()).resolves.toBe(17);
      await expect(readTransactionTestVmGeneration(atCas!)).resolves.toBe('target');
    } finally {
      release();
      await Promise.allSettled([oldFlush, transition]);
      snapshotBarrier.path = null;
      snapshotBarrier.captured = null;
      snapshotBarrier.release = null;
      scheduled.mockRestore();
      await store.close();
    }
  }, 30_000);

  it('rejects a failed durability barrier without advancing the applied head', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    const failure = new Error('injected durable RDF flush failure');
    const flush = vi.spyOn(fixture.receiverStore, 'flush').mockRejectedValue(failure);
    const rollback = vi.fn(async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'predecessor');
    });
    const commit = vi.fn();
    const cas = vi.fn(fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1
      .bind(fixture.receiverPersistence.inventory));
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1: fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1
        .bind(fixture.receiverPersistence.inventory),
      compareAndSwapAppliedCatalogHeadV1: cas,
    }, undefined, undefined, fixture.receiverStore, async () => {
      await setTransactionTestVmGeneration(fixture.receiverStore, 'target');
      return { commit, rollback };
    });
    try {
      await expect(fixture.synchronize(fixture.announcement, receiver)).rejects.toMatchObject({
        code: 'catalog-native-receiver-activation', cause: failure,
      });
      expect(flush).toHaveBeenCalledOnce();
      expect(cas).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledWith(failure);
      expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
        fixture.scopeDigest, AUTHOR,
      )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
      await expect(fixture.receiverStore.countQuads()).resolves.toBe(1);
      await expect(readTransactionTestVmGeneration(fixture.receiverStore))
        .resolves.toBe('predecessor');
    } finally {
      flush.mockRestore();
    }
  }, 30_000);

  it('does not commit even an empty genesis when its durability barrier fails', async () => {
    const fixture = await setupLiveReceiver();
    const failure = new Error('genesis flush unavailable');
    const flush = vi.spyOn(fixture.receiverStore, 'flush').mockRejectedValue(failure);
    const cas = vi.fn(fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1
      .bind(fixture.receiverPersistence.inventory));
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1: fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1
        .bind(fixture.receiverPersistence.inventory),
      compareAndSwapAppliedCatalogHeadV1: cas,
    });
    try {
      await expect(fixture.bootstrap(fixture.genesisAnnouncement, receiver)).rejects.toMatchObject({
        code: 'catalog-native-receiver-activation', cause: failure,
      });
      expect(flush).toHaveBeenCalledOnce();
      expect(cas).not.toHaveBeenCalled();
      expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
        fixture.scopeDigest, AUTHOR,
      )).toBeNull();
    } finally { flush.mockRestore(); }
  }, 30_000);

  it('rechecks cancellation after a pending durability barrier before committing', async () => {
    const fixture = await setupLiveReceiver();
    await fixture.bootstrap();
    const controller = new AbortController();
    const reason = new Error('authority cancelled while durable flush was pending');
    const flush = vi.spyOn(fixture.receiverStore, 'flush').mockImplementation(async () => {
      controller.abort(reason);
    });
    const cas = vi.fn(fixture.receiverPersistence.inventory.compareAndSwapAppliedCatalogHeadV1
      .bind(fixture.receiverPersistence.inventory));
    const receiver = fixture.createReceiver({
      readAppliedCatalogHeadV1: fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1
        .bind(fixture.receiverPersistence.inventory),
      compareAndSwapAppliedCatalogHeadV1: cas,
    });
    try {
      await expect(fixture.synchronize(fixture.announcement, receiver, controller.signal))
        .rejects.toBe(reason);
      expect(cas).not.toHaveBeenCalled();
      await expect(fixture.receiverStore.countQuads()).resolves.toBe(0);
      expect(fixture.receiverPersistence.inventory.readAppliedCatalogHeadV1(
        fixture.scopeDigest, AUTHOR,
      )?.currentCatalogHeadDigest).toBe(fixture.genesis.head.objectDigest);
    } finally { flush.mockRestore(); }
  }, 30_000);

});
