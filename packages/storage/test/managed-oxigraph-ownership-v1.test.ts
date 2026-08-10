import { describe, expect, it } from 'vitest';

import {
  MANAGED_OXIGRAPH_LEASE_OPTION_KEY,
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
  extractManagedOxigraphLeaseV1,
  isManagedOxigraphOwnershipLeaseV1,
  managedOxigraphOwnershipEndpointsMatchV1,
  readManagedOxigraphOwnershipSnapshotV1,
} from '../src/internal/managed-oxigraph-ownership-v1.js';

const QUERY_ENDPOINT = 'http://127.0.0.1:7878/query';
const UPDATE_ENDPOINT = 'http://127.0.0.1:7878/update';
const createOwnership = () =>
  createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT);

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
      const controller = createOwnership();
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
      const controller = createOwnership();
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
      const controller = createOwnership();
      controller.bindReadyGeneration();

      // The lease exposes no mutator; authority lives only on the controller,
      // which the supervisor never hands out.
      const asRecord = controller.lease as unknown as Record<string, unknown>;
      expect(asRecord.bindReadyGeneration).toBeUndefined();
      expect(asRecord.invalidate).toBeUndefined();
      expect(Object.isFrozen(controller)).toBe(true);
    });
  });

  describe('supervisor-proven endpoint identity', () => {
    it('preserves the B2 zero-argument diagnostic controller without granting B3 endpoint authority', () => {
      const controller = createManagedOxigraphOwnershipControllerV1();
      controller.bindReadyGeneration();
      expect(controller.snapshot()).toEqual({
        childGeneration: '1',
        ready: true,
        terminal: false,
      });
      expect(managedOxigraphOwnershipEndpointsMatchV1(
        controller.snapshot(),
        QUERY_ENDPOINT,
        UPDATE_ENDPOINT,
      )).toBe(false);
    });

    it('captures one immutable canonical loopback identity for every generation', () => {
      const controller = createOwnership();
      const before = controller.snapshot();
      expect(before).toMatchObject({
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
      });
      expect(Object.isFrozen(before)).toBe(true);

      controller.bindReadyGeneration();
      controller.invalidate('child-exit');
      controller.bindReadyGeneration();
      expect(controller.snapshot()).toMatchObject({
        childGeneration: '2',
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
        ready: true,
      });
    });

    it.each([
      ['credentials', 'http://user:pass@127.0.0.1:7878/query', UPDATE_ENDPOINT],
      ['non-loopback host', 'http://192.0.2.1:7878/query', UPDATE_ENDPOINT],
      ['localhost alias', 'http://localhost:7878/query', UPDATE_ENDPOINT],
      ['IPv6 alias', 'http://[::1]:7878/query', UPDATE_ENDPOINT],
      ['query string', `${QUERY_ENDPOINT}?token=x`, UPDATE_ENDPOINT],
      ['fragment', `${QUERY_ENDPOINT}#x`, UPDATE_ENDPOINT],
      ['trailing path', `${QUERY_ENDPOINT}/`, UPDATE_ENDPOINT],
      ['wrong query path', UPDATE_ENDPOINT, UPDATE_ENDPOINT],
      ['wrong update path', QUERY_ENDPOINT, QUERY_ENDPOINT],
      ['different port', QUERY_ENDPOINT, 'http://127.0.0.1:7879/update'],
      ['non-canonical port', 'http://127.0.0.1:07878/query', UPDATE_ENDPOINT],
      ['out-of-range port', 'http://127.0.0.1:65536/query', UPDATE_ENDPOINT],
      ['TLS endpoint', 'https://127.0.0.1:7878/query', UPDATE_ENDPOINT],
    ])('rejects %s before a lease can be minted', (_label, query, update) => {
      expect(() => createManagedOxigraphOwnershipControllerV1(query, update)).toThrow(
        /managed Oxigraph|same listener port/,
      );
    });
  });

  describe('transport through the adapter factory', () => {
    it('survives the options spread that erases managedByDkg', () => {
      const controller = createOwnership();
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
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
        ready: true,
        terminal: false,
      });
    });

    it('does not mutate the caller-supplied config object', () => {
      const controller = createOwnership();
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
      const controller = createOwnership();
      // A spawned-but-unproven child must never satisfy a capability check.
      expect(controller.snapshot()).toEqual({
        childGeneration: '0',
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
        ready: false,
        terminal: false,
      });
    });

    it('increments monotonically on every proven-ready bind', () => {
      const controller = createOwnership();
      expect(controller.bindReadyGeneration()).toBe('1');
      controller.invalidate('child-exit');
      expect(controller.bindReadyGeneration()).toBe('2');
      controller.invalidate('child-revive');
      expect(controller.bindReadyGeneration()).toBe('3');
      expect(controller.snapshot().childGeneration).toBe('3');
    });

    it('drops liveness immediately on every recoverable invalidation', () => {
      for (const reason of ['child-exit', 'child-revive', 'stop', 'listener-ownership-lost'] as const) {
        const controller = createOwnership();
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
        const controller = createOwnership();
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
      const controller = createOwnership();
      controller.bindReadyGeneration();
      controller.invalidate('shutdown');
      controller.invalidate('child-exit');

      expect(controller.snapshot().terminal).toBe(true);
      expect(() => controller.bindReadyGeneration()).toThrow(/terminal/);
    });

    it('shares one live view between the controller and every lease reader', () => {
      const controller = createOwnership();
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
        queryEndpoint: QUERY_ENDPOINT,
        updateEndpoint: UPDATE_ENDPOINT,
        ready: false,
        terminal: false,
        lastInvalidation: 'listener-ownership-lost',
      });
    });

    // Pins the totality invariant that makes window 1 of the proof-discard fix
    // unreachable. The lane reads this before its first refusal check, so a
    // throwing read would strand a verified proof's transient reservation and
    // wedge every later apply in the process. Because the read is total, a
    // hostile lease yields null and the caller reaches its refusal path, which
    // already discards. If this goes red, re-examine the proof-discard window
    // list: window 1 would have become reachable.
    it('never throws for a hostile lease, so a caller always reaches its refusal path', () => {
      const throwOnAnyAccess = new Proxy({}, {
        get() { throw new Error('lease property read must never be reached'); },
        has() { throw new Error('lease property probe must never be reached'); },
        getOwnPropertyDescriptor() { throw new Error('lease descriptor read must never be reached'); },
      });
      const hostile: readonly unknown[] = [
        throwOnAnyAccess,
        Object.create(null),
        { childGeneration: '1', ready: true, terminal: false },
        null,
        undefined,
        'lease',
        42,
      ];
      for (const candidate of hostile) {
        expect(() => readManagedOxigraphOwnershipSnapshotV1(candidate)).not.toThrow();
        expect(readManagedOxigraphOwnershipSnapshotV1(candidate)).toBeNull();
      }
    });

    // Second arm of the same invariant. The hostile-input arm never reaches the
    // snapshot projection at all -- every non-lease is rejected by the
    // membership guard first -- so alone it pins only the cheap half and leaves
    // the field reads that actually build a snapshot unexercised. Drive a
    // registered lease through every state branch instead.
    it('never throws while projecting a registered lease in any state', () => {
      for (const withEndpoints of [true, false]) {
        for (const reason of [
          undefined,
          'child-exit',
          'stop',
          'listener-ownership-lost',
          'shutdown',
          'port-release-unproven',
        ] as const) {
          for (const bindFirst of [true, false]) {
            const controller = withEndpoints
              ? createManagedOxigraphOwnershipControllerV1(QUERY_ENDPOINT, UPDATE_ENDPOINT)
              : createManagedOxigraphOwnershipControllerV1();
            if (bindFirst) controller.bindReadyGeneration();
            if (reason !== undefined) controller.invalidate(reason);

            expect(() => readManagedOxigraphOwnershipSnapshotV1(controller.lease)).not.toThrow();
            const snapshot = readManagedOxigraphOwnershipSnapshotV1(controller.lease);
            expect(snapshot).not.toBeNull();
            // The lane branches on exactly these fields, so a projection that
            // silently dropped one would send a live lease down the refusal path.
            expect(typeof snapshot?.childGeneration).toBe('string');
            expect(snapshot?.ready).toBe(bindFirst && reason === undefined);
            expect(snapshot?.terminal)
              .toBe(reason === 'shutdown' || reason === 'port-release-unproven');
            expect(snapshot?.queryEndpoint).toBe(withEndpoints ? QUERY_ENDPOINT : undefined);
            expect(snapshot?.lastInvalidation).toBe(reason);
          }
        }
      }
    });

    it('isolates leases from different supervisors', () => {
      const a = createOwnership();
      const b = createOwnership();
      a.bindReadyGeneration();

      expect(a.lease).not.toBe(b.lease);
      expect(readManagedOxigraphOwnershipSnapshotV1(a.lease)?.ready).toBe(true);
      expect(readManagedOxigraphOwnershipSnapshotV1(b.lease)?.ready).toBe(false);
    });

    it('returns frozen snapshots that cannot be edited into liveness', () => {
      const controller = createOwnership();
      const snapshot = controller.snapshot();
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(() => {
        (snapshot as { ready: boolean }).ready = true;
      }).toThrow();
      expect(controller.snapshot().ready).toBe(false);
    });
  });
});
