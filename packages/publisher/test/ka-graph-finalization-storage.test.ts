import { beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  TypedEventBus,
  contextGraphAssertionUri,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, assertionScopedGraphUri } from '../src/index.js';

const CONTEXT_GRAPH = 'rootless-finalize';
const NAME = 'canonical-asset';
const AGENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const UAL = `did:dkg:base:8453/${AGENT}/7`;

function quad(subject: string, value: string, graph: string): Quad {
  return {
    subject,
    predicate: 'urn:predicate:value',
    object: `"${value}"`,
    graph,
  };
}

describe('graph-scoped KA finalization storage transition', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = new DKGPublisher({
      store,
      chain: { chainId: 'base:8453' } as never,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
  });

  it('atomically materializes one exact canonical WM graph, then removes obsolete sources', async () => {
    const source = contextGraphAssertionUri(CONTEXT_GRAPH, AGENT, NAME);
    const sourceNamed = assertionScopedGraphUri(source, 'urn:source:named-graph');
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const target = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.WorkingMemory,
      scope,
    );
    await store.insert([
      quad('urn:source:default', 'source-default', source),
      quad('urn:source:named', 'source-named', sourceNamed),
      quad('urn:stale:target', 'stale', target),
    ]);

    const canonical = [
      quad('urn:canonical:1', 'one', ''),
      quad('urn:canonical:2', 'two', 'urn:input:graph-is-flattened'),
    ];
    const materialized = await publisher.materializeCanonicalWorkingMemory(
      CONTEXT_GRAPH,
      UAL,
      1,
      canonical,
    );
    expect(materialized).toBe(target);

    const beforeCleanup = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${target}> { ?s <urn:predicate:value> ?o } } ORDER BY ?s`,
    );
    expect(beforeCleanup.type).toBe('bindings');
    if (beforeCleanup.type !== 'bindings') throw new Error('expected bindings');
    expect(beforeCleanup.bindings).toEqual([
      { s: 'urn:canonical:1', o: '"one"' },
      { s: 'urn:canonical:2', o: '"two"' },
    ]);
    expect(await store.hasGraph(source)).toBe(true);
    expect(await store.hasGraph(sourceNamed)).toBe(true);

    await publisher.cleanupCanonicalWorkingMemorySources(
      CONTEXT_GRAPH,
      NAME,
      AGENT,
      target,
      [source],
    );

    expect(await store.hasGraph(target)).toBe(true);
    expect(await store.hasGraph(source)).toBe(false);
    expect(await store.hasGraph(sourceNamed)).toBe(false);
  });

  it('preserves both the prior target and source when the atomic replacement fails', async () => {
    const source = contextGraphAssertionUri(CONTEXT_GRAPH, AGENT, NAME);
    const target = knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.WorkingMemory,
      createGraphKnowledgeAssetScope(UAL, 1),
    );
    await store.insert([
      quad('urn:source:still-safe', 'source', source),
      quad('urn:target:prior', 'prior', target),
    ]);
    const realReplace = store.replaceGraph?.bind(store);
    store.replaceGraph = async () => {
      throw new Error('injected atomic replacement failure');
    };

    await expect(
      publisher.materializeCanonicalWorkingMemory(
        CONTEXT_GRAPH,
        UAL,
        1,
        [quad('urn:target:new', 'new', '')],
      ),
    ).rejects.toThrow('injected atomic replacement failure');

    expect(await store.countQuads(source)).toBe(1);
    expect(await store.countQuads(target)).toBe(1);
    const targetRows = await store.query(
      `SELECT ?s WHERE { GRAPH <${target}> { ?s <urn:predicate:value> ?o } }`,
    );
    expect(targetRows.type).toBe('bindings');
    if (targetRows.type !== 'bindings') throw new Error('expected bindings');
    expect(targetRows.bindings).toEqual([{ s: 'urn:target:prior' }]);

    store.replaceGraph = realReplace;
  });

  it('is retry-safe when source cleanup stops after the canonical graph is durable', async () => {
    const source = contextGraphAssertionUri(CONTEXT_GRAPH, AGENT, NAME);
    const sourceNamed = assertionScopedGraphUri(source, 'urn:source:named-graph');
    const target = await publisher.materializeCanonicalWorkingMemory(
      CONTEXT_GRAPH,
      UAL,
      1,
      [quad('urn:canonical:retry', 'canonical', '')],
    );
    await store.insert([
      quad('urn:source:retry', 'source', source),
      quad('urn:source:named-retry', 'named', sourceNamed),
    ]);

    const realDrop = store.dropGraph.bind(store);
    let injected = false;
    store.dropGraph = async (graphUri, options) => {
      if (!injected && graphUri === source) {
        injected = true;
        throw new Error('injected cleanup interruption');
      }
      return realDrop(graphUri, options);
    };
    await expect(
      publisher.cleanupCanonicalWorkingMemorySources(
        CONTEXT_GRAPH,
        NAME,
        AGENT,
        target,
        [source],
      ),
    ).rejects.toThrow('injected cleanup interruption');
    expect(await store.countQuads(target)).toBe(1);
    expect(await store.hasGraph(source)).toBe(true);

    store.dropGraph = realDrop;
    await publisher.cleanupCanonicalWorkingMemorySources(
      CONTEXT_GRAPH,
      NAME,
      AGENT,
      target,
      [source],
    );
    expect(await store.countQuads(target)).toBe(1);
    expect(await store.hasGraph(source)).toBe(false);
    expect(await store.hasGraph(sourceNamed)).toBe(false);
  });
});
