import { describe, expect, it } from 'vitest';

import {
  MANAGED_OXIGRAPH_LEASE_OPTION_KEY,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  extractManagedOxigraphLeaseV1,
  isManagedOxigraphOwnershipLeaseV1,
  readManagedOxigraphOwnershipSnapshotV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';

/**
 * Reproduces `resolveAdapterOptions()` in `triple-store.ts`, which is the exact
 * transform a lease must survive between the daemon and `new SparqlHttpStore()`.
 */
const resolveAdapterOptionsLike = (options: Record<string | symbol, unknown>) => ({
  ...options,
  managedByDkg: false,
  atomicUpdates: true,
});

describe('managed Oxigraph ownership lease V1', () => {
  describe('unforgeability', () => {
    it('cannot be minted from configuration booleans', () => {
      for (const options of [
        { managedByDkg: true },
        { atomicUpdates: true },
        { managedByDkg: true, atomicUpdates: true },
        { queryEndpoint: 'http://127.0.0.1:7878/query', managedByDkg: true },
        {},
      ]) {
        expect(extractManagedOxigraphLeaseV1(options)).toBeNull();
      }
    });

    it('rejects a hand-attached value under the known transport key', () => {
      // The transport key is exported, so an attacker is assumed to know it.
      // Authority must rest on the private table, never on the key.
      for (const forged of [
        {},
        Object.create(null) as object,
        { childGeneration: '1', ready: true },
        { [Symbol.toStringTag]: 'managed-oxigraph-ownership-v1' },
        'lease',
        true,
      ]) {
        expect(
          extractManagedOxigraphLeaseV1({
            managedByDkg: true,
            [MANAGED_OXIGRAPH_LEASE_OPTION_KEY]: forged,
          }),
        ).toBeNull();
      }
    });

    it('cannot survive JSON persistence', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      controller.bindReadyGeneration();
      const options = attachManagedOxigraphLeaseV1(
        { queryEndpoint: 'http://127.0.0.1:7878/query', managedByDkg: true },
        controller.lease,
      );

      expect(extractManagedOxigraphLeaseV1(options)).not.toBeNull();

      // A symbol key is invisible to JSON in both directions.
      const persisted = JSON.parse(JSON.stringify(options)) as Record<string, unknown>;
      expect(Object.keys(persisted)).toEqual(['queryEndpoint', 'managedByDkg']);
      expect(extractManagedOxigraphLeaseV1(persisted)).toBeNull();
    });

    it('cannot be reconstructed by copying, freezing or cloning the handle', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      controller.bindReadyGeneration();
      const { lease } = controller;

      // The handle carries no data at all, so a copy has nothing to copy.
      expect(JSON.stringify(lease)).toBe('{}');
      expect(Object.keys(lease)).toEqual([]);
      expect(Object.getOwnPropertySymbols(lease)).toEqual([]);

      for (const impostor of [
        { ...(lease as object) },
        Object.freeze({ ...(lease as object) }),
        Object.create(null) as object,
        Object.freeze(Object.create(null) as object),
        {},
        structuredClone({}),
        { [MANAGED_OXIGRAPH_LEASE_OPTION_KEY]: 'managed-oxigraph-ownership-v1' },
        'managed-oxigraph-ownership-v1',
        null,
        undefined,
        0,
      ]) {
        expect(isManagedOxigraphOwnershipLeaseV1(impostor)).toBe(false);
        expect(readManagedOxigraphOwnershipSnapshotV1(impostor)).toBeNull();
      }

      // Only the original identity resolves.
      expect(isManagedOxigraphOwnershipLeaseV1(lease)).toBe(true);
    });

    it('does not let a lease holder assert liveness', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      controller.bindReadyGeneration();

      // The lease exposes no mutator; authority lives only on the controller,
      // which the supervisor never hands out.
      const asRecord = controller.lease as unknown as Record<string, unknown>;
      expect(asRecord.bindReadyGeneration).toBeUndefined();
      expect(asRecord.invalidate).toBeUndefined();
      expect(Object.isFrozen(controller)).toBe(true);
    });
  });

  describe('transport through the adapter factory', () => {
    it('survives the options spread that erases managedByDkg', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      const generation = controller.bindReadyGeneration();

      const daemonOptions = attachManagedOxigraphLeaseV1(
        { queryEndpoint: 'http://127.0.0.1:7878/query', managedByDkg: true },
        controller.lease,
      );
      const adapterOptions = resolveAdapterOptionsLike(daemonOptions);

      // The factory clears cache ownership and synthesizes atomicUpdates...
      expect(adapterOptions.managedByDkg).toBe(false);
      expect(adapterOptions.atomicUpdates).toBe(true);
      // ...but namespace ownership is carried by identity and is untouched.
      const recovered = extractManagedOxigraphLeaseV1(adapterOptions);
      expect(recovered).toBe(controller.lease);
      expect(readManagedOxigraphOwnershipSnapshotV1(recovered)).toEqual({
        childGeneration: generation,
        ready: true,
        terminal: false,
      });
    });

    it('does not mutate the caller-supplied config object', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      const original = { queryEndpoint: 'http://127.0.0.1:7878/query' };
      const attached = attachManagedOxigraphLeaseV1(original, controller.lease);

      expect(attached).not.toBe(original);
      expect(extractManagedOxigraphLeaseV1(original)).toBeNull();
      expect(extractManagedOxigraphLeaseV1(attached)).toBe(controller.lease);
    });

    it('returns null rather than throwing for junk input', () => {
      for (const junk of [null, undefined, 0, '', 'lease', [], Symbol('x')]) {
        expect(extractManagedOxigraphLeaseV1(junk)).toBeNull();
      }
    });
  });

  describe('generation lifecycle', () => {
    it('starts not-ready at generation zero', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      // A spawned-but-unproven child must never satisfy a capability check.
      expect(controller.snapshot()).toEqual({
        childGeneration: '0',
        ready: false,
        terminal: false,
      });
    });

    it('increments monotonically on every proven-ready bind', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      expect(controller.bindReadyGeneration()).toBe('1');
      controller.invalidate('child-exit');
      expect(controller.bindReadyGeneration()).toBe('2');
      controller.invalidate('child-revive');
      expect(controller.bindReadyGeneration()).toBe('3');
      expect(controller.snapshot().childGeneration).toBe('3');
    });

    it('drops liveness immediately on every recoverable invalidation', () => {
      for (const reason of ['child-exit', 'child-revive', 'stop', 'listener-ownership-lost'] as const) {
        const controller = createManagedOxigraphOwnershipControllerV1();
        controller.bindReadyGeneration();
        expect(controller.snapshot().ready).toBe(true);

        controller.invalidate(reason);
        const snapshot = controller.snapshot();
        expect(snapshot.ready).toBe(false);
        expect(snapshot.terminal).toBe(false);
        expect(snapshot.lastInvalidation).toBe(reason);
        // The generation is NOT bumped by invalidation — only a proven-ready
        // replacement child may claim a new one.
        expect(snapshot.childGeneration).toBe('1');
      }
    });

    it('latches terminal and refuses to bind a replacement', () => {
      for (const reason of ['shutdown', 'port-release-unproven'] as const) {
        const controller = createManagedOxigraphOwnershipControllerV1();
        controller.bindReadyGeneration();
        controller.invalidate(reason);

        const snapshot = controller.snapshot();
        expect(snapshot.ready).toBe(false);
        expect(snapshot.terminal).toBe(true);
        expect(snapshot.lastInvalidation).toBe(reason);

        expect(() => controller.bindReadyGeneration()).toThrow(/terminal/);
        expect(controller.snapshot().childGeneration).toBe('1');
      }
    });

    it('keeps a terminal latch through a later recoverable invalidation', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      controller.bindReadyGeneration();
      controller.invalidate('shutdown');
      controller.invalidate('child-exit');

      expect(controller.snapshot().terminal).toBe(true);
      expect(() => controller.bindReadyGeneration()).toThrow(/terminal/);
    });

    it('shares one live view between the controller and every lease reader', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      const options = resolveAdapterOptionsLike(
        attachManagedOxigraphLeaseV1({}, controller.lease),
      );
      const held = extractManagedOxigraphLeaseV1(options);

      controller.bindReadyGeneration();
      expect(readManagedOxigraphOwnershipSnapshotV1(held)?.ready).toBe(true);

      // A store holding the lease observes revocation with no notification.
      controller.invalidate('listener-ownership-lost');
      expect(readManagedOxigraphOwnershipSnapshotV1(held)).toEqual({
        childGeneration: '1',
        ready: false,
        terminal: false,
        lastInvalidation: 'listener-ownership-lost',
      });
    });

    it('isolates leases from different supervisors', () => {
      const a = createManagedOxigraphOwnershipControllerV1();
      const b = createManagedOxigraphOwnershipControllerV1();
      a.bindReadyGeneration();

      expect(a.lease).not.toBe(b.lease);
      expect(readManagedOxigraphOwnershipSnapshotV1(a.lease)?.ready).toBe(true);
      expect(readManagedOxigraphOwnershipSnapshotV1(b.lease)?.ready).toBe(false);
    });

    it('returns frozen snapshots that cannot be edited into liveness', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      const snapshot = controller.snapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(() => {
        (snapshot as { ready: boolean }).ready = true;
      }).toThrow();
      expect(controller.snapshot().ready).toBe(false);
    });
  });
});
