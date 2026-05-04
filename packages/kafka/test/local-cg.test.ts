import { describe, expect, it } from 'vitest';
import {
  KAFKA_LOCAL_CG_ID,
  createKafkaLocalCgEnsurer,
} from '../src/local-cg.js';

interface FakeCgStore {
  exists: Set<string>;
  createCalls: Array<{ id: string; name: string }>;
}

function makeFakeCg(initial: { withKafkaLocal?: boolean } = {}) {
  const store: FakeCgStore = {
    exists: new Set(initial.withKafkaLocal ? [KAFKA_LOCAL_CG_ID] : []),
    createCalls: [],
  };

  // The dependency injected into createKafkaLocalCgEnsurer models the V10
  // free-CG primitive: `contextGraphExists` is a check, `createContextGraph`
  // is the creation. Both await — close enough to the real V10 surface that
  // idempotency proofs translate.
  const cg = {
    contextGraphExists: async (id: string): Promise<boolean> => {
      // microtask hop so two parallel calls actually interleave their checks
      await Promise.resolve();
      return store.exists.has(id);
    },
    createContextGraph: async (opts: { id: string; name: string }): Promise<void> => {
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

describe('createKafkaLocalCgEnsurer', () => {
  it('creates the kafka-local CG on first call and returns its id', async () => {
    const { store, cg } = makeFakeCg();
    const ensure = createKafkaLocalCgEnsurer(cg);

    const id = await ensure();

    expect(id).toBe(KAFKA_LOCAL_CG_ID);
    expect(store.exists.has(KAFKA_LOCAL_CG_ID)).toBe(true);
    expect(store.createCalls).toEqual([
      { id: KAFKA_LOCAL_CG_ID, name: expect.any(String) },
    ]);
  });

  it('skips creation when kafka-local already exists (idempotent on subsequent calls)', async () => {
    const { store, cg } = makeFakeCg({ withKafkaLocal: true });
    const ensure = createKafkaLocalCgEnsurer(cg);

    const id = await ensure();

    expect(id).toBe(KAFKA_LOCAL_CG_ID);
    expect(store.createCalls).toEqual([]);
  });

  it('serializes parallel callers (same ensurer) so kafka-local is created exactly once', async () => {
    const { store, cg } = makeFakeCg();
    const ensure = createKafkaLocalCgEnsurer(cg);

    const ids = await Promise.all([
      ensure(),
      ensure(),
      ensure(),
      ensure(),
      ensure(),
    ]);

    expect(ids).toEqual([
      KAFKA_LOCAL_CG_ID,
      KAFKA_LOCAL_CG_ID,
      KAFKA_LOCAL_CG_ID,
      KAFKA_LOCAL_CG_ID,
      KAFKA_LOCAL_CG_ID,
    ]);
    expect(store.createCalls).toHaveLength(1);
  });

  it('reserves the literal id "kafka-local"', () => {
    expect(KAFKA_LOCAL_CG_ID).toBe('kafka-local');
  });

  // Defence-in-depth path: the in-flight gate already serializes concurrent
  // callers in-process, but if an external creator (another route, a CLI in
  // another shell, a peer sync) wins the race between our exists-check and
  // our create-call, the underlying store will throw "already exists". The
  // ensurer must swallow that specific error and return the id anyway, while
  // non-"already exists" errors must still bubble up.
  it('treats a concurrent "already exists" create error as success', async () => {
    const cg = {
      contextGraphExists: async (_id: string): Promise<boolean> => false,
      createContextGraph: async (_opts: { id: string; name: string }): Promise<void> => {
        throw new Error('Context graph "kafka-local" already exists');
      },
    };
    const ensure = createKafkaLocalCgEnsurer(cg);

    const id = await ensure();

    expect(id).toBe(KAFKA_LOCAL_CG_ID);
  });

  it('rethrows non-"already exists" create errors', async () => {
    const cg = {
      contextGraphExists: async (_id: string): Promise<boolean> => false,
      createContextGraph: async (_opts: { id: string; name: string }): Promise<void> => {
        throw new Error('storage offline');
      },
    };
    const ensure = createKafkaLocalCgEnsurer(cg);

    await expect(ensure()).rejects.toThrow(/storage offline/);
  });

  // Hidden-coupling regression test: two ensurers built from two different
  // primitive instances must NOT share their gate. If they did, a parallel
  // burst across both would only create kafka-local in one store, silently
  // ignoring the other primitive — see the factory docstring.
  it('two ensurers built from different primitives each create their own kafka-local independently', async () => {
    const a = makeFakeCg();
    const b = makeFakeCg();
    const ensureA = createKafkaLocalCgEnsurer(a.cg);
    const ensureB = createKafkaLocalCgEnsurer(b.cg);

    const [idA, idB] = await Promise.all([ensureA(), ensureB()]);

    expect(idA).toBe(KAFKA_LOCAL_CG_ID);
    expect(idB).toBe(KAFKA_LOCAL_CG_ID);
    // Each store saw exactly one create — neither piggy-backed on the other.
    expect(a.store.createCalls).toHaveLength(1);
    expect(b.store.createCalls).toHaveLength(1);
    expect(a.store.exists.has(KAFKA_LOCAL_CG_ID)).toBe(true);
    expect(b.store.exists.has(KAFKA_LOCAL_CG_ID)).toBe(true);
  });
});
