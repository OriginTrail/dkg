import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { STORAGE_ACK_LEDGER_GRAPH, STORAGE_ACK_LEDGER_PREDICATES } from '@origintrail-official/dkg-publisher';
import { createAgentStoreComposition } from '../src/internal/agent-store-composition.js';
import { expect, it, vi } from 'vitest';
import { OxigraphStore, createManagedOxigraphSparqlStoreV1 } from '@origintrail-official/dkg-storage';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { StoreContentFence } from '../src/internal/store-content-fence.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';

const scope = { graphs: ['urn:assertion'], metadataGraph: 'urn:meta', subjects: ['urn:asset'] };
const quad = { subject: 'urn:s', predicate: 'urn:p', object: '"value"', graph: 'urn:assertion' };
function fixture() {
  const raw = new OxigraphStore();
  const fence = new StoreContentFence();
  const execute = createObservedStoreMutation(() => {}, fence);
  const store = createMutationObservedStore(raw, execute.bind(undefined));
  return { raw, store, execute, fence };
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

it.each(['lifecycle', 'ledger'] as const)('composes the production %s writer with pre-dispatch content fencing', async kind => {
  const raw = new OxigraphStore();
  const outcomes: string[] = [];
  const composed = createAgentStoreComposition(raw, () => {}, { begin: () => outcome => { outcomes.push(outcome); } });
  const input = { contextGraphId: 'typed-fence', agentAddress: '0x1111111111111111111111111111111111111111',
    name: 'asset', publishedUal: 'urn:published', merkleRoot: 'ab'.repeat(32) };
  const subject = kind === 'ledger' ? 'urn:ledger' : assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name);
  const metadataGraph = kind === 'ledger' ? STORAGE_ACK_LEDGER_GRAPH : contextGraphMetaUri(input.contextGraphId);
  try {
    await composed.heldContent.withScope({ graphs: [], metadataGraph, subjects: [subject] }, async assertCurrent => {
      const update = raw.update.bind(raw);
      vi.spyOn(raw, 'update').mockImplementation(async (...args) => {
        expect(assertCurrent).toThrow('Held assertion content changed');
        return update(...args);
      });
      assertCurrent();
      if (kind === 'ledger') await composed.ledgerTimestampWriter(subject, STORAGE_ACK_LEDGER_PREDICATES.seenAt, new Date(0), {});
      else await composed.publishedLifecycleWriter(input);
      expect(assertCurrent).toThrow('Held assertion content changed');
    });
    expect(outcomes).toEqual(['changed']);
  } finally { await composed.store.close(); }
});

it('isolates indeterminate graph and metadata-subject writes from unrelated proofs', async () => {
  const f = fixture();
  try {
    await f.fence.withScope(scope, async assertCurrent => {
      for (const mutation of [
        { removals: [{ graph: 'urn:unrelated' }] },
        { quads: [{ ...quad, graph: 'urn:meta', subject: 'urn:other-asset' }] },
      ]) {
        await expect(f.execute(async () => { throw new Error('lost response'); }, () => true, mutation, 'update'))
          .rejects.toThrow('lost response');
        assertCurrent();
      }
    });
    expect(await f.fence.withScope(scope, async check => { check(); return true; })).toBe(true);
    expect(f.fence.openScope({ ...scope, graphs: ['urn:unrelated'] })).toBeUndefined();
    expect(f.fence.openScope({ ...scope, subjects: ['urn:other-asset'] })).toBeUndefined();
  } finally { await f.store.close(); }
});

it.each([{ everything: true }, { removals: [{}] }, { quads: [{ ...quad, graph: 'unsafe graph' }] }])(
  'keeps unknown indeterminate scopes fail closed: %j', mutation => {
    const fence = new StoreContentFence();
    const proof = fence.openScope(scope)!;
    fence.begin(mutation)('indeterminate');
    expect(proof.assertCurrent).toThrow('Held assertion content changed');
    proof.close();
    expect(fence.openScope(scope)).toBeUndefined();
  });


it('reopens uncertain scopes only after confirmed backend replacement and invalidates old proofs', () => {
  let generation: number | undefined = 0;
  const fence = new StoreContentFence(() => generation === undefined ? undefined : { generation, ready: true });
  const before = fence.openScope(scope)!;
  fence.begin({ everything: true })('indeterminate');
  expect(before.assertCurrent).toThrow();
  expect(fence.openScope(scope)).toBeUndefined();
  fence.begin({ quads: [quad] })('changed');
  expect(fence.openScope(scope)).toBeUndefined(); // A rewrite is not quiescence.
  generation = undefined;
  expect(fence.openScope(scope)).toBeUndefined(); // Signalled but not confirmed dead.
  generation = 1;
  const after = fence.openScope(scope)!;
  expect(after).toBeDefined();
  expect(after.assertCurrent).not.toThrow();
  generation = 2;
  expect(after.assertCurrent).toThrow(); // Replacement itself invalidates a live proof.
  before.close(); after.close();
});

it('retains a delayed indeterminate outcome until a replacement after settlement', () => {
  let generation = 0;
  const fence = new StoreContentFence(() => generation === undefined ? undefined : { generation, ready: true });
  const old = fence.begin({ everything: true });
  generation = 1;
  expect(fence.openScope(scope)).toBeUndefined(); // An old client operation could still dispatch more work.
  old('indeterminate');
  // Without dispatch evidence this could have executed on generation 1.
  expect(fence.openScope(scope)).toBeUndefined();
  fence.begin({ quads: [quad] })('indeterminate');
  expect(fence.openScope(scope)).toBeUndefined();
  generation = 2;
  const replaced = fence.openScope(scope)!;
  expect(replaced).toBeDefined(); replaced.close();
});


it('wires supervised replacement through the production store composition', async () => {
  let state = { generation: 0, recovering: false };
  const raw = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:9/query',
    updateEndpoint: 'http://127.0.0.1:9/update' }, { getRecoveryState: () => state });
  const composed = createAgentStoreComposition(raw, () => {}, { begin: () => () => {} });
  vi.spyOn(raw, 'update').mockRejectedValueOnce(new Error('response lost'));
  try {
    await expect(composed.store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')).rejects.toThrow('response lost');
    expect(composed.heldContent.openScope(scope)).toBeUndefined();
    state = { generation: 1, recovering: true };
    expect(composed.heldContent.openScope(scope)).toBeUndefined();
    state = { generation: 1, recovering: false };
    const proof = composed.heldContent.openScope(scope)!;
    expect(proof).toBeDefined(); proof.close();
  } finally { await raw.close(); }
});

it('fences a queued write dispatched on the replacement backend after its response is lost', async () => {
  let generation = 0, dispatchedOn: number | undefined;
  let admit!: () => void;
  const queue = new Promise<void>(resolve => { admit = resolve; });
  const raw = new OxigraphStore();
  const fence = new StoreContentFence(() => generation === undefined ? undefined : { generation, ready: true });
  const store = createMutationObservedStore(raw, createObservedStoreMutation(() => {}, fence));
  vi.spyOn(raw, 'insert').mockImplementationOnce(async () => {
    await queue; dispatchedOn = generation; throw new Error('response lost after dispatch');
  });
  try {
    const write = store.insert([quad]);
    const rejected = expect(write).rejects.toThrow('response lost');
    generation = 1; // Queue admission was on 0, actual dispatch will be on 1.
    expect(fence.openScope(scope)).toBeUndefined();
    admit(); await rejected;
    expect(dispatchedOn).toBe(1);
    expect(fence.openScope(scope)).toBeUndefined(); // The generation-1 backend may still commit.
    generation = 2; // Confirmed termination of that backend is required.
    const proof = fence.openScope(scope)!;
    expect(proof).toBeDefined(); proof.assertCurrent(); proof.close();
  } finally { admit(); await store.close(); }
});

it('retires writes that fail during supervised replacement only after a later stable epoch', async () => {
  let state = { generation: 0, recovering: false };
  const raw = createManagedOxigraphSparqlStoreV1({ queryEndpoint: 'http://127.0.0.1:9/query',
    updateEndpoint: 'http://127.0.0.1:9/update' }, { getRecoveryState: () => state });
  const composed = createAgentStoreComposition(raw, () => {}, { begin: () => () => {} });
  vi.spyOn(raw, 'update').mockImplementationOnce(async () => {
    state = { generation: 1, recovering: true };
    throw new Error('worker exited during replacement');
  });
  try {
    await expect(composed.store.update('DELETE WHERE { GRAPH ?g { ?s ?p ?o } }')).rejects.toThrow('worker exited');
    expect(composed.heldContent.openScope(scope)).toBeUndefined();
    state = { generation: 1, recovering: false };
    expect(composed.heldContent.openScope(scope)).toBeUndefined();
    state = { generation: 2, recovering: false };
    const proof = composed.heldContent.openScope(scope)!;
    expect(proof).toBeDefined(); proof.assertCurrent(); proof.close();
  } finally { await raw.close(); }
});


it('revokes a live proof when readiness closes within the same supervised epoch', () => {
  let ready = true;
  const read = vi.fn(() => ({ generation: 7, ready }));
  const fence = new StoreContentFence(read);
  const proof = fence.openScope(scope)!;
  expect(read).toHaveBeenCalledTimes(1);
  proof.assertCurrent();
  expect(read).toHaveBeenCalledTimes(2);
  ready = false;
  expect(proof.assertCurrent).toThrow('Held assertion content changed');
  expect(fence.openScope(scope)).toBeUndefined();
  proof.close();
});
