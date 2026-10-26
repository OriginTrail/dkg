import { expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createStoreMutationOwner } from '../src/internal/observed-store-mutation.js';

const scope = { assertionGraphs: ['urn:assertion'], metadataGraph: 'urn:meta', subjects: ['urn:asset'] };
const quad = { subject: 'urn:s', predicate: 'urn:p', object: '"value"', graph: 'urn:assertion' };
function fixture() {
  const raw = new OxigraphStore();
  const mutationOwner = createStoreMutationOwner(() => {});
  const execute = mutationOwner.execute;
  const store = createMutationObservedStore(raw, { ...mutationOwner, execute: mutationOwner.execute.bind(undefined) });
  return { raw, store, execute, fence: mutationOwner.contentFence };
}

it('observes shared typed writers as well as graph drops and partial row deletes', async () => {
  const f = fixture();
  try {
    for (const mutate of [() => f.store.dropGraph(quad.graph), () => f.store.delete([quad]),
      () => f.execute(() => f.raw.dropGraph(quad.graph), () => true, { removals: [{ graph: quad.graph }] }, 'dropGraph')]) {
      await f.store.insert([quad]);
      await f.fence.withScope(scope, async assertCurrent => {
        assertCurrent(); await mutate(); expect(assertCurrent).toThrow('Held assertion content changed');
      });
    }
  } finally { await f.store.close(); }
});

it('permits unrelated writes and metadata for other subjects while fencing descriptor changes', async () => {
  const f = fixture();
  try {
    await f.fence.withScope(scope, async assertCurrent => {
      await f.store.insert([{ ...quad, graph: 'urn:unrelated' }, { ...quad, graph: 'urn:meta' }]);
      assertCurrent();
      await f.store.deleteByPattern({ graph: 'urn:meta', subject: 'urn:asset' });
      expect(assertCurrent).toThrow('Held assertion content changed');
    });
  } finally { await f.store.close(); }
});

it('cannot establish a held proof while a relevant mutation is still in flight', async () => {
  const f = fixture();
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  try {
    const write = f.execute(() => pending, () => false, { removals: [{ graph: quad.graph }] }, 'dropGraph');
    expect(await f.fence.withScope(scope, async () => true)).toBeUndefined();
    release(); await write;
    expect(await f.fence.withScope(scope, async assertCurrent => { assertCurrent(); return true; })).toBe(true);
  } finally { release(); await f.store.close(); }
});

it.each(['dropGraph', undefined] as const)('disables held shortcuts after an indeterminate write (%s)', async operation => {
  const f = fixture();
  try {
    await expect(f.execute(async () => { throw new Error('lost response'); }, () => true,
      { removals: [{ graph: quad.graph }] }, operation)).rejects.toThrow('lost response');
    expect(await f.fence.withScope(scope, async () => true)).toBeUndefined();
  } finally { await f.store.close(); }
});

it('treats blank-node mutation subjects as potentially affecting any metadata subject', async () => {
  const f = fixture();
  try {
    await f.fence.withScope(scope, async assertCurrent => {
      const settle = f.fence.begin({ quads: [{ ...quad, graph: 'urn:meta', subject: '_:wildcard' }] });
      settle('changed');
      expect(assertCurrent).toThrow('Held assertion content changed');
    });
  } finally { await f.store.close(); }
});
