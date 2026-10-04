import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import {
  ExactGraphReadError,
  GraphManager,
  OxigraphStore,
  PrivateContentStore,
  type Quad,
} from '../src/index.js';

const CONTEXT_GRAPH = 'rootless-private';
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/41';

function quad(subject: string, object: string): Quad {
  return {
    subject,
    predicate: 'urn:test:secret',
    object,
    graph: '',
  };
}

describe('graph-scoped private content', () => {
  let store: OxigraphStore;
  let privateStore: PrivateContentStore;

  beforeEach(() => {
    store = new OxigraphStore();
    privateStore = new PrivateContentStore(store, new GraphManager(store));
  });
  afterEach(async () => { vi.restoreAllMocks(); await store.close(); });

  it('keys exact private payloads by both UAL and assertion version', async () => {
    const first = createGraphKnowledgeAssetScope(UAL, 1);
    const second = createGraphKnowledgeAssetScope(UAL, 2);
    const firstPayload = [quad('urn:private:first', '"version-one"')];
    const secondPayload = [quad('urn:private:second', '"version-two"')];

    const firstGraph = await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      first,
      firstPayload,
    );
    const secondGraph = await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      second,
      secondPayload,
    );

    expect(firstGraph).not.toBe(secondGraph);
    expect(firstGraph).toContain('/assertions/1');
    expect(secondGraph).toContain('/assertions/2');
    await expect(
      privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, first),
    ).resolves.toEqual(firstPayload);
    await expect(
      privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, second),
    ).resolves.toEqual(secondPayload);

    await privateStore.deleteKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, second);
    await expect(
      privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, first),
    ).resolves.toEqual(firstPayload);
    await expect(
      privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, second),
    ).resolves.toEqual([]);
  });

  it('keeps both private commitments when an unpublished version number is reused', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const first = [quad('urn:first', '"private B"')];
    const second = [quad('urn:second', '"private C"')];
    const b = `0x${'ab'.repeat(32)}`;
    const c = `0x${'cd'.repeat(32)}`;
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, first, undefined, b);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, second, undefined, c);
    // A recreated reader proves archive identity is durable, rather than cached.
    const restarted = new PrivateContentStore(store, new GraphManager(store));
    await expect(restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope,
      { privateTripleCount: first.length, privateMerkleRoot: b })).resolves.toEqual(first);
    await expect(restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope,
      { privateTripleCount: second.length, privateMerkleRoot: c })).resolves.toEqual(second);
    await expect(restarted.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope)).resolves.toEqual(second);
  });

  it.each([undefined, 'detail'])('explicitly deletes every selected-version commitment but retains sibling versions and namespaces (%s)', async subGraphName => {
    const selected = createGraphKnowledgeAssetScope(UAL, 1), sibling = createGraphKnowledgeAssetScope(UAL, 2);
    const b = [quad('urn:first', '"private B"')], c = [quad('urn:second', '"private C"')];
    const rootB = 'ab'.repeat(32), rootC = 'cd'.repeat(32);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, b, subGraphName, rootB);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, c, subGraphName, rootC);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, sibling, b, subGraphName, rootB);
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, b, 'sibling-namespace', rootB);
    const sealB = { privateTripleCount: b.length, privateMerkleRoot: rootB };
    const sealC = { privateTripleCount: c.length, privateMerkleRoot: rootC };
    // Ordinary same-number replacement preserves both authenticated payloads.
    expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, sealB, subGraphName)).toEqual(b);
    expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, sealC, subGraphName)).toEqual(c);
    await privateStore.deleteKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, subGraphName);
    const restarted = new PrivateContentStore(store, new GraphManager(store));
    expect(await restarted.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, subGraphName)).toEqual([]);
    await expect(restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, sealB, subGraphName)).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH' });
    await expect(restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, sealC, subGraphName)).rejects.toMatchObject({ code: 'QUAD_COUNT_MISMATCH' });
    expect(await restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, sibling, sealB, subGraphName)).toEqual(b);
    expect(await restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, selected, sealB, 'sibling-namespace')).toEqual(b);
  });

  it('backfills a sealed archive without replacing the latest same-number payload', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const oldPayload = [quad('urn:old', '"private B"')];
    const latest = [quad('urn:latest', '"private C"')];
    const oldRoot = `0x${'ab'.repeat(32)}`;
    const latestRoot = `0x${'cd'.repeat(32)}`;
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, latest, undefined, latestRoot);
    await privateStore.archiveKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, oldPayload, oldRoot);
    const restarted = new PrivateContentStore(store, new GraphManager(store));
    await expect(restarted.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope)).resolves.toEqual(latest);
    await expect(restarted.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope,
      { privateTripleCount: oldPayload.length, privateMerkleRoot: oldRoot })).resolves.toEqual(oldPayload);
  });

  it('deletes commitment archives beyond one bounded discovery page', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 3), payload = [quad('urn:private', '"secret"')];
    for (let i = 1; i <= 33; i++) {
      await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, payload, undefined, i.toString(16).padStart(64, '0'));
    }
    const query = vi.spyOn(store, 'query');
    await privateStore.deleteKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope);
    const discoveries = query.mock.calls.filter(([, options]) => options?.source === 'storage.private.deleteVersionArchives');
    expect(discoveries).toHaveLength(3);
    expect(discoveries.every(([text]) => /LIMIT 32/.test(text))).toBe(true);
    expect((await store.listGraphs()).filter(graph => graph.startsWith(privateStore.knowledgeAssetPrivateGraphUri(CONTEXT_GRAPH, scope)))).toEqual([]);
  });

  it('rejects unavailable archive discovery without reporting a successful explicit deletion', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 3), payload = [quad('urn:private', '"secret"')];
    await privateStore.replaceKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope, payload, undefined, 'ab'.repeat(32));
    const query = store.query.bind(store), drop = vi.spyOn(store, 'dropGraph');
    vi.spyOn(store, 'query').mockImplementation((text, options) => options?.source === 'storage.private.deleteVersionArchives'
      ? Promise.resolve({ type: 'boolean', value: false }) : query(text, options));
    await expect(privateStore.deleteKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope)).rejects.toThrow('archive discovery is unavailable');
    expect(drop).not.toHaveBeenCalled();
    expect(await privateStore.getSealedKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope,
      { privateTripleCount: payload.length, privateMerkleRoot: 'ab'.repeat(32) })).toEqual(payload);
  });

  it('fails closed when the store cannot atomically replace private graphs', async () => {
    // The private graph is the Merkle commitment boundary: without atomic
    // whole-graph replacement the writer must reject rather than fall back to
    // a non-atomic write or silently no-op.
    const nonAtomic = new Proxy(store, {
      get(target, prop) {
        if (prop === 'replaceGraph') return undefined;
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as OxigraphStore;
    const guarded = new PrivateContentStore(nonAtomic, new GraphManager(nonAtomic));
    const scope = createGraphKnowledgeAssetScope(UAL, 9);

    await expect(
      guarded.replaceKnowledgeAssetPrivateTriples(
        CONTEXT_GRAPH,
        scope,
        [quad('urn:private:rejected', '"never-stored"')],
      ),
    ).rejects.toMatchObject({ code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED' });

    await expect(
      guarded.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope),
    ).resolves.toEqual([]); // nothing materialized behind the rejection
  });

  it('atomically replaces one assertion without leaking stale triples', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 3);
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      [quad('urn:private:old', '"old"')],
    );

    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      [quad('urn:private:new', '"new"')],
    );

    await expect(
      privateStore.getKnowledgeAssetPrivateTriples(CONTEXT_GRAPH, scope),
    ).resolves.toEqual([quad('urn:private:new', '"new"')]);
  });

  it('fails closed when an optional exact-read count does not match', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 4);
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      [quad('urn:private:only', '"only"')],
    );

    const error = await privateStore.getKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      undefined,
      { expectedQuadCount: 2, pageSize: 1 },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExactGraphReadError);
    expect(error).toMatchObject({
      kind: 'integrity',
      code: 'QUAD_COUNT_MISMATCH',
      expected: 2,
      actual: 1,
    });
  });

  it('discovers the count without materializing the private graph', async () => {
    const scope = createGraphKnowledgeAssetScope(UAL, 5);
    const payload = [quad('urn:private:bounded', '"bounded"')];
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      payload,
    );
    store.countQuads = async () => {
      throw new Error('materializing countQuads must not run');
    };

    await expect(privateStore.getKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
    )).resolves.toEqual(payload);
  });
});
