import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryLayer, assertionLifecycleUri, contextGraphAssertionUri, contextGraphLayerUri, contextGraphMetaUri, sparqlString } from '@origintrail-official/dkg-core';
import { GraphSetIndexStore, OxigraphStore, UnsupportedTripleStoreCapabilityError, quadToNQuad, type Quad, type TripleStore, type UpdateOptions } from '@origintrail-official/dkg-storage';
import { VM_CURRENT_ASSERTION_PRED } from '@origintrail-official/dkg-publisher';
import { applyPublishedNamedKaVmLifecycle, createPublishedNamedKaVmLifecycleWriter, type PublishedNamedKaVmLifecycleInput } from '../src/named-ka-vm-lifecycle.js';
import { createMutationObservedStore } from '../src/internal/context-graph-cache-invalidating-store.js';
import { createObservedStoreMutation } from '../src/internal/observed-store-mutation.js';
import type { StoreMutationObserver } from '../src/internal/store-mutation.js';
import { ContextGraphMetaProjection } from '../src/context-graph-meta-projection.js';
import { createProjectionMutationObserver } from '../src/internal/projection-mutation-observer.js';

const DKG = 'http://dkg.io/ontology/';
const input: PublishedNamedKaVmLifecycleInput = {
  contextGraphId: 'urn:test:lifecycle-batch', agentAddress: '0x1111111111111111111111111111111111111111',
  name: 'asset', subGraphName: 'scope', publishedUal: 'did:dkg:base:84532/contract/42',
  merkleRoot: `0x${'AB'.repeat(32)}`, packedKaId: (0x1111111111111111111111111111111111111111n << 96n) | 42n,
};
const stores: OxigraphStore[] = [];
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });
function compose(store: TripleStore, invalidate: () => void = () => {}, observer?: StoreMutationObserver) {
  const executeMutation = createObservedStoreMutation(invalidate, observer);
  const wrapper = createMutationObservedStore(store, executeMutation);
  const writer = createPublishedNamedKaVmLifecycleWriter({ updateStore: store, fallbackStore: wrapper, executeMutation });
  return { wrapper, writer };
}
const fast = (store: TripleStore) => compose(store).writer;
function memory() { const store = new OxigraphStore(); stores.push(store); return store; }
function rows(value = input): Quad[] {
  const graph = contextGraphMetaUri(value.contextGraphId);
  const lifecycle = assertionLifecycleUri(value.contextGraphId, value.agentAddress, value.name, value.subGraphName);
  const assertion = contextGraphAssertionUri(value.contextGraphId, value.agentAddress, value.name, value.subGraphName);
  const q = (subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
  const result = [q(lifecycle, VM_CURRENT_ASSERTION_PRED, sparqlString(value.merkleRoot.toLowerCase().replace(/^0x/, ''))),
    q(lifecycle, `${DKG}memoryLayer`, sparqlString(MemoryLayer.VerifiableMemory)),
    q(assertion, `${DKG}memoryLayer`, sparqlString(MemoryLayer.VerifiableMemory)),
    q(lifecycle, `${DKG}state`, '"published"'), q(lifecycle, `${DKG}publishedUal`, sparqlString(value.publishedUal))];
  if (value.packedKaId !== undefined) {
    const author = `0x${(value.packedKaId >> 96n).toString(16).padStart(40, '0')}`;
    const id = value.packedKaId & ((1n << 96n) - 1n);
    result.push(q(lifecycle, `${DKG}assertionGraph`, contextGraphLayerUri(value.contextGraphId, MemoryLayer.VerifiableMemory, author, id, value.subGraphName)),
      q(contextGraphLayerUri(value.contextGraphId, MemoryLayer.WorkingMemory, author, id, value.subGraphName), `${DKG}memoryLayer`, sparqlString(MemoryLayer.VerifiableMemory)));
  }
  return result;
}
const unrelated: Quad[] = [
  { ...rows()[0]!, predicate: `${DKG}assertionVersion`, object: '"19"' },
  { ...rows()[0]!, subject: 'urn:other:asset', object: '"unrelated"' },
  { ...rows()[0]!, graph: 'urn:other:graph', object: '"other-graph"' },
];
async function all(store: TripleStore): Promise<string[]> {
  // Compare each named graph separately, preserving graph identity.
  const quads: Quad[] = [];
  for (const graph of await store.listGraphs()) {
    const found = await store.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
    if (found.type !== 'quads') throw new Error('expected quads');
    quads.push(...found.quads.map(q => ({ ...q, graph })));
  }
  return quads.map(quadToNQuad).sort();
}
function view(raw: OxigraphStore, update: TripleStore['update']): TripleStore {
  return new Proxy(raw, { get(target, key) {
    if (key === 'update') return update;
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

async function stack(options: { inner: (store: OxigraphStore) => TripleStore }) {
  const store = new OxigraphStore();
  const projection = new ContextGraphMetaProjection(store);
  await store.insert([{
    graph: 'urn:test:recipient-key-graph', subject: 'did:dkg:agent:0xabc',
    predicate: 'https://dkg.network/ontology#publicEncryptionKey', object: '"existing-key"',
  }]);
  await projection.recipientKeyRouteFence.ensureReady();
  const { wrapper, writer } = compose(options.inner(store), () => {}, createProjectionMutationObserver(() => projection));
  return { store, wrapper, writer, projection, fence: projection.recipientKeyRouteFence };
}

describe('named KA VM lifecycle batching', () => {
  it.each([true, false])('replaces exact pairs, preserving unrelated metadata and optional pointers (packed=%s)', async packed => {
    const raw = memory(); const value = { ...input, packedKaId: packed ? input.packedKaId : undefined };
    const old = rows().flatMap(q => [{ ...q, object: '"old-a"' }, { ...q, object: '"old-b"' }]);
    await raw.insert([...old, ...unrelated]);
    const update = vi.spyOn(raw, 'update'); const insert = vi.spyOn(raw, 'insert'); const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await fast(raw)(value);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toEqual({ touchedGraphs: [contextGraphMetaUri(input.contextGraphId)], source: 'agent.publish.namedKaVmLifecycle' });
    expect(insert).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    const preserved = packed ? [] : old.slice(10);
    expect(await all(raw)).toEqual([...rows(value), ...unrelated, ...preserved].map(quadToNQuad).sort());
    await fast(raw)(value);
    expect(await all(raw)).toEqual([...rows(value), ...unrelated, ...preserved].map(quadToNQuad).sort());
  });

  it.each([true, false])('preserves verified repair proof on the atomic and compatibility paths (atomic=%s)', async atomic => {
    const raw = memory(); const proof = rows().slice(0, 2);
    proof[0] = { ...proof[0]!, object: `"${input.merkleRoot}"^^<http://www.w3.org/2001/XMLSchema#string>` };
    await raw.insert(proof); const storedProof = await all(raw);
    const update = vi.spyOn(raw, 'update'); const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await (atomic ? fast(raw) : (value: PublishedNamedKaVmLifecycleInput) => applyPublishedNamedKaVmLifecycle(raw, value))(
      { ...input, preserveVerifiedVmProof: true });
    expect(await all(raw)).toEqual([...storedProof, ...rows().slice(2).map(quadToNQuad)].sort());
    expect(remove.mock.calls.some(([pattern]) => proof.some(q => q.subject === pattern.subject && q.predicate === pattern.predicate))).toBe(false);
    if (atomic) expect(update.mock.calls[0]![0]).not.toContain(VM_CURRENT_ASSERTION_PRED);
  });

  it('inserts absent pairs and supersedes the root without deleting assertion version', async () => {
    const raw = memory(); await raw.insert(unrelated);
    await fast(raw)(input);
    const newer = { ...input, merkleRoot: 'cd'.repeat(32) };
    await fast(raw)(newer);
    expect(await all(raw)).toEqual([...rows(newer), ...unrelated].map(quadToNQuad).sort());
  });

  it('round trips literal escaping without changing other graphs', async () => {
    const raw = memory(); const value = { ...input, publishedUal: 'did:test:quote"\\slash\nline\rtab\t' };
    await raw.insert(unrelated); await fast(raw)(value);
    expect(await all(raw)).toEqual([...rows(value), ...unrelated].map(quadToNQuad).sort());
  });

  it.each(['absent', 'unsupported'] as const)('uses the ordered capability-only fallback: %s', async mode => {
    const raw = memory(); const unsupported = vi.fn(async () => { throw new UnsupportedTripleStoreCapabilityError('update', 'test'); });
    const store = view(raw, mode === 'absent' ? undefined : unsupported);
    const calls: string[] = [];
    const remove = raw.deleteByPatternWithoutCount.bind(raw); const insert = raw.insert.bind(raw);
    vi.spyOn(raw, 'deleteByPatternWithoutCount').mockImplementation(async q => { calls.push(`delete:${q.subject}:${q.predicate}`); await remove(q); });
    vi.spyOn(raw, 'insert').mockImplementation(async qs => { calls.push(`insert:${qs[0]!.subject}:${qs[0]!.predicate}`); await insert(qs); });
    await fast(store)(input);
    expect(calls).toEqual(rows().flatMap(q => [`delete:${q.subject}:${q.predicate}`, `insert:${q.subject}:${q.predicate}`]));
    expect(await all(raw)).toEqual(rows().map(quadToNQuad).sort());
    expect(unsupported).toHaveBeenCalledTimes(mode === 'absent' ? 0 : 1);
  });

  it.each([false, true])('propagates update failure without replay (postcommit=%s)', async postcommit => {
    const raw = memory(); const failure = new Error('indeterminate update outcome');
    const store = view(raw, async (query, options) => { if (postcommit) await raw.update(query, options); throw failure; });
    const insert = vi.spyOn(raw, 'insert'); const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await expect(fast(store)(input)).rejects.toBe(failure);
    expect(insert).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(await all(raw)).toEqual(postcommit ? rows().map(quadToNQuad).sort() : []);
  });

  it.each([{ merkleRoot: 'bad' }, { contextGraphId: 'urn:bad> } INSERT DATA {' }])('validates the entire update before any mutation: %j', async change => {
    const raw = memory(); const update = vi.spyOn(raw, 'update'); const insert = vi.spyOn(raw, 'insert'); const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await expect(fast(raw)({ ...input, ...change })).rejects.toThrow();
    expect(update).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });

  it('does not replay after a wrapped postcommit maintenance error', async () => {
    const raw = memory(); const failure = new Error('index maintenance failed after commit');
    const store = view(raw, async (query, options) => { await raw.update(query, options); throw failure; });
    const invalidate = vi.fn(); const settle = vi.fn();
    const { writer } = compose(store, invalidate, { begin: () => settle });
    const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await expect(writer(input)).rejects.toBe(failure);
    expect(remove).not.toHaveBeenCalled(); expect(invalidate).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledExactlyOnceWith('indeterminate', undefined);
    expect(await all(raw)).toEqual(rows().map(quadToNQuad).sort());
  });

  it.each([true, false])('preserves real recipient read-fence isolation (update available=%s)', async supported => {
    const { store: raw, writer, fence, projection } = await stack({
      inner: store => supported ? store : view(store, undefined),
    });
    stores.push(raw);
    const revision = fence.revision;
    const unrelatedAuthority = projection.readContextGraphAuthorityFactsRevision('urn:unrelated:context');
    const update = raw.update.bind(raw);
    vi.spyOn(raw, 'update').mockImplementation(async (query, options) => {
      expect(fence.hasPendingWrites).toBe(false);
      expect(fence.cacheable).toBe(true);
      await update(query, options);
    });
    await writer(input);
    expect(fence.revision).toBe(revision);
    expect(fence.cacheable).toBe(true);
    expect(projection.readContextGraphAuthorityFactsRevision('urn:unrelated:context')).toBe(unrelatedAuthority);
  });

  it.each(['success', 'indeterminate', 'unsupported'] as const)('keeps unrelated authority stable through a held lifecycle update: %s', async outcome => {
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const failure = new Error('response lost after commit');
    const { store: raw, writer, fence, projection } = await stack({ inner: store => view(store, async (query, options) => {
      enter(); await held;
      if (outcome === 'unsupported') throw new UnsupportedTripleStoreCapabilityError('update', 'test');
      await store.update(query, options);
      if (outcome === 'indeterminate') throw failure;
    }) });
    stores.push(raw);
    const revision = fence.revision;
    const authority = projection.readContextGraphAuthorityFactsRevision('urn:unrelated:context');
    const operation = writer(input);
    const settled = operation.then(() => undefined, error => error);
    await entered;
    try {
      expect(fence.hasPendingWrites).toBe(false); expect(fence.cacheable).toBe(true);
      expect(fence.revision).toBe(revision);
    } finally { release(); }
    expect(await settled).toBe(outcome === 'indeterminate' ? failure : undefined);
    expect(fence.revision).toBe(revision); expect(fence.cacheable).toBe(true);
    expect(projection.readContextGraphAuthorityFactsRevision('urn:unrelated:context')).toBe(authority);
  });

  it('keeps explicit writer capability independent of read-facing proxy identity', async () => {
    const raw = memory(); const { wrapper, writer } = compose(raw);
    const unknown = new Proxy(wrapper, {});
    const update = vi.spyOn(raw, 'update'); const remove = vi.spyOn(raw, 'deleteByPatternWithoutCount');
    await writer(input);
    expect(update).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
    update.mockClear();
    await applyPublishedNamedKaVmLifecycle(unknown, input);
    expect(update).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledTimes(7);
    expect(await all(raw)).toEqual(rows().map(quadToNQuad).sort());
  });

  it('keeps the receiver and actual cache/index mutation semantics', async () => {
    const raw = memory(); const indexed = new GraphSetIndexStore(raw);
    expect(await indexed.listGraphs()).toEqual([]);
    const original = indexed.update; const update = vi.spyOn(indexed, 'update').mockImplementation(async function (this: GraphSetIndexStore, query: string, options?: UpdateOptions) {
      expect(this).toBe(indexed); await original.call(this, query, options);
    });
    const invalidate = vi.fn(); const settle = vi.fn();
    const { writer } = compose(indexed, invalidate, { begin: () => settle });
    await writer(input);
    expect(update).toHaveBeenCalledTimes(1); expect(invalidate).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledExactlyOnceWith('changed');
    expect(await indexed.listGraphs()).toEqual([contextGraphMetaUri(input.contextGraphId)]);
    expect(await all(raw)).toEqual(rows().map(quadToNQuad).sort());
  });
});
