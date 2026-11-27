import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore, STORE_OPERATION_OUTCOME_TAG, UnsupportedTripleStoreCapabilityError,
  type Quad, type QueryOptions, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { createListContextGraphsCacheInvalidatingStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import type { StoreMutation } from '../src/internal/store-mutation.js';

const graph = 'urn:test:compound-control';
const subject = 'urn:test:job';
const replacement: Quad[] = [{ graph, subject, predicate: 'urn:test:status', object: '"accepted"' }];
const inserts: Quad[] = [{ graph, subject: 'urn:test:request', predicate: 'urn:test:payload', object: '"request"' }];
const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

function fixture(perform?: () => Promise<void>, absent = false) {
  const raw = new OxigraphStore();
  stores.push(raw);
  let inner!: TripleStore;
  const compound = vi.fn(async function (
    this: TripleStore, target: string, job: string, rows: Quad[], extra: Quad[], options?: QueryOptions,
  ) {
    expect(this).toBe(inner);
    if (perform) await perform();
    else {
      await raw.insert(extra, options);
      await raw.replaceSubject(target, job, rows);
    }
  });
  inner = new Proxy(raw, {
    get(target, property) {
      if (property === 'replaceSubjectAndInsert') return absent ? undefined : compound;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const invalidate = vi.fn();
  const settle = vi.fn();
  const begin = vi.fn((_mutation: StoreMutation) => settle);
  const wrapper = createListContextGraphsCacheInvalidatingStore(inner, invalidate, { begin });
  return { raw, inner, wrapper, compound, invalidate, begin, settle };
}

describe('compound primary persistence through the agent cache wrapper', () => {
  it('forwards receiver/options and observes exactly the job removal and both insertion groups', async () => {
    const { wrapper, compound, invalidate, begin, settle } = fixture();
    const controller = new AbortController();
    const options: QueryOptions = { source: 'publisher.asyncLift.writeJob', priority: 'ack', signal: controller.signal };
    expect(wrapper.replaceSubjectAndInsert).toBeTypeOf('function');
    await wrapper.replaceSubjectAndInsert!(graph, subject, replacement, inserts, options);
    expect(compound).toHaveBeenCalledExactlyOnceWith(graph, subject, replacement, inserts, options);
    expect(compound.mock.calls[0]![4]).toBe(options);
    expect(begin).toHaveBeenCalledExactlyOnceWith({
      removals: [{ graph, subject }], quads: [...replacement, ...inserts],
    });
    expect(begin.mock.invocationCallOrder[0]).toBeLessThan(compound.mock.invocationCallOrder[0]!);
    expect(settle).toHaveBeenCalledExactlyOnceWith('changed');
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('fences a deletion even when both insertion groups are empty', async () => {
    const { raw, wrapper, begin, settle, invalidate } = fixture();
    await raw.insert(replacement);
    await wrapper.replaceSubjectAndInsert!(graph, subject, [], []);
    expect(await raw.countQuads(graph)).toBe(0);
    expect(begin).toHaveBeenCalledExactlyOnceWith({ removals: [{ graph, subject }], quads: [] });
    expect(settle).toHaveBeenCalledExactlyOnceWith('changed');
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it('does not advertise a capability absent from the inner store', () => {
    const { wrapper, compound, begin, invalidate } = fixture(undefined, true);
    expect(wrapper.replaceSubjectAndInsert).toBeUndefined();
    expect(compound).not.toHaveBeenCalled();
    expect(begin).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('preserves a typed pre-dispatch refusal as unchanged', async () => {
    const refusal = new UnsupportedTripleStoreCapabilityError('replaceSubjectAndInsert', 'test');
    const { wrapper, compound, settle, invalidate } = fixture(async () => { throw refusal; });
    await expect(wrapper.replaceSubjectAndInsert!(graph, subject, replacement, inserts)).rejects.toBe(refusal);
    expect(compound).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith('unchanged');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates on a postcommit nested-query refusal without replaying the mutation', async () => {
    const failure = Object.assign(new Error('postcommit index query refused'), {
      storeOperationOutcomeTag: STORE_OPERATION_OUTCOME_TAG,
      storeOperation: 'query', outcome: 'not_started',
    });
    const f = fixture(async () => {
      await f.raw.insert([...replacement, ...inserts]);
      throw failure;
    });
    await expect(f.wrapper.replaceSubjectAndInsert!(graph, subject, replacement, inserts)).rejects.toBe(failure);
    expect(await f.raw.countQuads(graph)).toBe(2);
    expect(f.compound).toHaveBeenCalledOnce();
    expect(f.settle).toHaveBeenCalledExactlyOnceWith('indeterminate');
    expect(f.invalidate).toHaveBeenCalledOnce();
  });

  it('keeps caches unchanged until a held mutation settles', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(async () => { entered(); await held; });
    const pending = f.wrapper.replaceSubjectAndInsert!(graph, subject, replacement, inserts);
    try {
      await reached;
      expect(f.begin).toHaveBeenCalledOnce();
      expect(f.settle).not.toHaveBeenCalled();
      expect(f.invalidate).not.toHaveBeenCalled();
      release();
      await pending;
      expect(f.settle).toHaveBeenCalledExactlyOnceWith('changed');
      expect(f.invalidate).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  });
});
