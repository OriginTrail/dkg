import { describe, expect, it } from 'vitest';
import {
  KAFKA_LOCAL_CG_ID,
  ensureKafkaLocalCg,
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

  // The dependency injected into ensureKafkaLocalCg models the V10 free-CG
  // primitive: `contextGraphExists` is a check, `createContextGraph` is the
  // creation. Both await — close enough to the real V10 surface that
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

describe('ensureKafkaLocalCg', () => {
  it('creates the kafka-local CG on first call and returns its id', async () => {
    const { store, cg } = makeFakeCg();

    const id = await ensureKafkaLocalCg(cg);

    expect(id).toBe(KAFKA_LOCAL_CG_ID);
    expect(store.exists.has(KAFKA_LOCAL_CG_ID)).toBe(true);
    expect(store.createCalls).toEqual([
      { id: KAFKA_LOCAL_CG_ID, name: expect.any(String) },
    ]);
  });

  it('skips creation when kafka-local already exists (idempotent on subsequent calls)', async () => {
    const { store, cg } = makeFakeCg({ withKafkaLocal: true });

    const id = await ensureKafkaLocalCg(cg);

    expect(id).toBe(KAFKA_LOCAL_CG_ID);
    expect(store.createCalls).toEqual([]);
  });

  it('serializes parallel callers so kafka-local is created exactly once', async () => {
    const { store, cg } = makeFakeCg();

    const ids = await Promise.all([
      ensureKafkaLocalCg(cg),
      ensureKafkaLocalCg(cg),
      ensureKafkaLocalCg(cg),
      ensureKafkaLocalCg(cg),
      ensureKafkaLocalCg(cg),
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
});
