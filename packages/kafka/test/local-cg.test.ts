import { describe, expect, it } from 'vitest';
import {
  KAFKA_LOCAL_CG_BARE_ID,
  KAFKA_LOCAL_CG_ID_PREFIX,
  createKafkaLocalCgEnsurer,
  kafkaLocalCgIdFor,
} from '../src/local-cg.js';

const TEST_PEER_ID = '12D3KooWAbcDEFghiJKLmnoPQRstuVWxyZ';
const EXPECTED_ID = `${KAFKA_LOCAL_CG_ID_PREFIX}${TEST_PEER_ID}`;

interface FakeCgStore {
  exists: Set<string>;
  createCalls: Array<{ id: string; name: string }>;
}

function makeFakeCg(initial: { withId?: string } = {}) {
  const store: FakeCgStore = {
    exists: new Set(initial.withId ? [initial.withId] : []),
    createCalls: [],
  };

  // The dependency injected into createKafkaLocalCgEnsurer models the V10
  // free-CG primitive. The method is `createPrivateContextGraph` — the
  // privacy guarantee is encoded in the method name so the kafka package
  // never sees the boolean. Both calls await — close enough to the real V10
  // surface that idempotency proofs translate.
  const cg = {
    contextGraphExists: async (id: string): Promise<boolean> => {
      // microtask hop so two parallel calls actually interleave their checks
      await Promise.resolve();
      return store.exists.has(id);
    },
    createPrivateContextGraph: async (opts: { id: string; name: string }): Promise<void> => {
      // microtask hop, then atomic check-and-set so a real backing store
      // cannot double-create. Mirrors `agent.createContextGraph`'s own
      // "already exists" guard.
      await Promise.resolve();
      if (store.exists.has(opts.id)) {
        throw new Error(`Context graph "${opts.id}" already exists`);
      }
      store.exists.add(opts.id);
      store.createCalls.push({ id: opts.id, name: opts.name });
    },
  };

  return { store, cg };
}

describe('kafkaLocalCgIdFor', () => {
  it('builds a per-node id by prefixing the peer-id', () => {
    expect(kafkaLocalCgIdFor(TEST_PEER_ID)).toBe(EXPECTED_ID);
  });

  it('exposes the prefix and bare id as separate constants', () => {
    expect(KAFKA_LOCAL_CG_ID_PREFIX).toBe('kafka-local-');
    expect(KAFKA_LOCAL_CG_BARE_ID).toBe('kafka-local');
  });
});

describe('createKafkaLocalCgEnsurer', () => {
  it('creates the per-node kafka-local CG on first call and returns its id', async () => {
    const { store, cg } = makeFakeCg();
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    const id = await ensure();

    expect(id).toBe(EXPECTED_ID);
    expect(store.exists.has(EXPECTED_ID)).toBe(true);
    expect(store.createCalls).toEqual([
      { id: EXPECTED_ID, name: expect.any(String) },
    ]);
  });

  it('skips creation when the per-node CG already exists (idempotent on subsequent calls)', async () => {
    const { store, cg } = makeFakeCg({ withId: EXPECTED_ID });
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    const id = await ensure();

    expect(id).toBe(EXPECTED_ID);
    expect(store.createCalls).toEqual([]);
  });

  it('serializes parallel callers (same ensurer) so the per-node CG is created exactly once', async () => {
    const { store, cg } = makeFakeCg();
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    const ids = await Promise.all([
      ensure(),
      ensure(),
      ensure(),
      ensure(),
      ensure(),
    ]);

    expect(ids).toEqual([
      EXPECTED_ID,
      EXPECTED_ID,
      EXPECTED_ID,
      EXPECTED_ID,
      EXPECTED_ID,
    ]);
    expect(store.createCalls).toHaveLength(1);
    expect(store.createCalls[0]?.id).toBe(EXPECTED_ID);
  });

  // The agent's `createPrivateContextGraph` adapter hardcodes `private: true`
  // at the route boundary; the kafka package depends on that name. Asserting
  // that the ensurer calls THIS method (not a generic create) locks the
  // privacy guarantee at the type-system level — a future refactor that
  // renames the method back to a generic create would break this test before
  // it could leak data.
  it('invokes createPrivateContextGraph (not a generic create) on the injected primitive', async () => {
    let createPrivateCalls = 0;
    const cg = {
      contextGraphExists: async (_id: string): Promise<boolean> => false,
      createPrivateContextGraph: async (_opts: {
        id: string;
        name: string;
      }): Promise<void> => {
        createPrivateCalls += 1;
      },
    };
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    await ensure();

    expect(createPrivateCalls).toBe(1);
  });

  // Defence-in-depth path: the in-flight gate already serializes concurrent
  // callers in-process, but if an external creator wins the race between our
  // exists-check and our create-call, the underlying store will throw
  // "already exists". The ensurer must swallow that specific error and
  // return the id anyway, while non-"already exists" errors must still
  // bubble up.
  it('treats a concurrent "already exists" create error as success', async () => {
    const cg = {
      contextGraphExists: async (_id: string): Promise<boolean> => false,
      createPrivateContextGraph: async (_opts: { id: string; name: string }): Promise<void> => {
        throw new Error(`Context graph "${EXPECTED_ID}" already exists`);
      },
    };
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    const id = await ensure();

    expect(id).toBe(EXPECTED_ID);
  });

  it('rethrows non-"already exists" create errors', async () => {
    const cg = {
      contextGraphExists: async (_id: string): Promise<boolean> => false,
      createPrivateContextGraph: async (_opts: { id: string; name: string }): Promise<void> => {
        throw new Error('storage offline');
      },
    };
    const ensure = createKafkaLocalCgEnsurer(cg, TEST_PEER_ID);

    await expect(ensure()).rejects.toThrow(/storage offline/);
  });

  // Hidden-coupling regression test: two ensurers built from two different
  // primitive instances AND different peer-ids must NOT share their gate. If
  // they did, a parallel burst across both would only create the CG in one
  // store, silently ignoring the other primitive — see the factory docstring.
  // Different peer-ids also exercises the per-node uniqueness guarantee:
  // each ensurer resolves to its own `kafka-local-{peerId}`.
  it('two ensurers with different primitives and peer-ids each create their own CG independently', async () => {
    const peerA = '12D3KooWPeerAAAAAAAAAAAAAAAAAAAAAAAAA';
    const peerB = '12D3KooWPeerBBBBBBBBBBBBBBBBBBBBBBBBB';
    const a = makeFakeCg();
    const b = makeFakeCg();
    const ensureA = createKafkaLocalCgEnsurer(a.cg, peerA);
    const ensureB = createKafkaLocalCgEnsurer(b.cg, peerB);

    const [idA, idB] = await Promise.all([ensureA(), ensureB()]);

    expect(idA).toBe(kafkaLocalCgIdFor(peerA));
    expect(idB).toBe(kafkaLocalCgIdFor(peerB));
    expect(idA).not.toBe(idB);
    // Each store saw exactly one create — neither piggy-backed on the other.
    expect(a.store.createCalls).toHaveLength(1);
    expect(b.store.createCalls).toHaveLength(1);
    expect(a.store.exists.has(idA)).toBe(true);
    expect(b.store.exists.has(idB)).toBe(true);
    // Cross-isolation: peer-A's id never lands in peer-B's store, and vice versa.
    expect(a.store.exists.has(idB)).toBe(false);
    expect(b.store.exists.has(idA)).toBe(false);
  });
});
