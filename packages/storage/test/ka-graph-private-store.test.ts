import { beforeEach, describe, expect, it } from 'vitest';
import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import {
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
});
