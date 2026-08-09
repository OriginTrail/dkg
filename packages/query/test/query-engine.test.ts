import { describe, it, expect, beforeEach, expectTypeOf } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  type Quad,
  type QueryOptions as StoreQueryOptions,
} from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type {
  LegacyResolveKAResult,
  QueryEngine,
} from '../src/query-engine.js';
import { validateReadOnlySparql } from '../src/sparql-guard.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

const CONTEXT_GRAPH = 'agent-registry';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META = `${GRAPH}/_meta`;
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const ENTITY = 'did:dkg:agent:QmImageBot';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG_SUB_GRAPH = 'http://dkg.io/ontology/SubGraph';
const DKG_ASSERTION_GRAPH = 'http://dkg.io/ontology/assertionGraph';
const DKG_CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';
const DKG_REGISTRATION_STATUS = 'https://dkg.network/ontology#registrationStatus';
const SCHEMA_NAME = 'http://schema.org/name';
const COUNT_NAME = 'http://example.com/countName';
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function subGraphRegistration(name: string): Quad[] {
  const subGraphUri = `${GRAPH}/${name}`;
  return [
    q(subGraphUri, RDF_TYPE, DKG_SUB_GRAPH, META),
    q(subGraphUri, `${DKG}parentContextGraph`, GRAPH, META),
    q(subGraphUri, SCHEMA_NAME, `"${name}"`, META),
    q(subGraphUri, 'http://dkg.io/ontology/createdBy', 'did:dkg:agent:test', META),
  ];
}

function assertionGraphRegistration(graph: string, name: string): Quad {
  return q(`urn:dkg:assertion:${name}`, DKG_ASSERTION_GRAPH, graph, META);
}

function graphScopedMetadata(
  ual: string,
  assertionVersion: string,
  assertionGraph: string,
  publicTripleCount: number,
  subGraphName?: string,
  metadataGraph = META,
  privateTripleCount = 0,
  privateMerkleRoot?: string,
): Quad[] {
  return [
    q(
      ual,
      `${DKG}contentScopeVersion`,
      `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
      metadataGraph,
    ),
    q(ual, `${DKG}kaUal`, ual, metadataGraph),
    q(ual, `${DKG}assertionVersion`, `"${assertionVersion}"^^<${XSD_INTEGER}>`, metadataGraph),
    q(ual, `${DKG}publicTripleCount`, `"${publicTripleCount}"^^<${XSD_INTEGER}>`, metadataGraph),
    q(ual, `${DKG}privateTripleCount`, `"${privateTripleCount}"^^<${XSD_INTEGER}>`, metadataGraph),
    q(ual, `${DKG}assertionGraph`, assertionGraph, metadataGraph),
    q(ual, `${DKG}contextGraph`, GRAPH, metadataGraph),
    ...(privateMerkleRoot
      ? [q(ual, `${DKG}privateMerkleRoot`, JSON.stringify(privateMerkleRoot), metadataGraph)]
      : []),
    ...(subGraphName
      ? [q(ual, `${DKG}subGraphName`, JSON.stringify(subGraphName), metadataGraph)]
      : []),
  ];
}

describe('DKGQueryEngine', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    // Seed data
    await store.insert([
      q(GRAPH, RDF_TYPE, DKG_CONTEXT_GRAPH, ONTOLOGY_GRAPH),
      q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
      q(ENTITY, 'http://schema.org/description', '"Analyzes images"'),
      q(
        `${ENTITY}/.well-known/genid/o1`,
        'http://ex.org/type',
        '"ImageAnalysis"',
      ),
    ]);
  });

  it('queries context-graph-scoped data', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('keeps caller cancellation on execution reads but out of shareable graph discovery', async () => {
    class OptionsRecordingStore extends OxigraphStore {
      queryOptions: Array<Parameters<OxigraphStore['query']>[1]> = [];
      discoveryOptions: StoreQueryOptions[] = [];
      async query(sparql: string, options?: Parameters<OxigraphStore['query']>[1]) {
        this.queryOptions.push(options);
        return super.query(sparql, options);
      }
      async listGraphsByPrefix(
        prefix: string,
        options?: StoreQueryOptions,
      ) {
        this.discoveryOptions.push(options ?? {});
        return (await super.listGraphs(options)).filter((graph) => graph.startsWith(prefix));
      }
    }

    const recordingStore = new OptionsRecordingStore();
    const recordingEngine = new DKGQueryEngine(recordingStore);
    await recordingStore.insert([
      q('urn:options:s', 'http://schema.org/name', '"Options"', GRAPH),
    ]);
    const controller = new AbortController();

    await recordingEngine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      {
        contextGraphId: CONTEXT_GRAPH,
        includeSharedMemory: true,
        signal: controller.signal,
        priority: 'background',
        source: 'api.query',
      },
    );

    expect(recordingStore.queryOptions).not.toHaveLength(0);
    expect(recordingStore.queryOptions).toContainEqual(expect.objectContaining({
      signal: controller.signal,
      priority: 'background',
      source: 'api.query',
    }));
    expect(recordingStore.discoveryOptions).not.toHaveLength(0);
    for (const options of recordingStore.discoveryOptions) {
      expect(options).toMatchObject({
        priority: 'background',
        source: 'api.query',
      });
      expect(options.signal).toBeUndefined();
    }
  });

  it('keeps caller cancellation out of shared graph-discovery flights', async () => {
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      discoveryStarted = resolve;
    });

    class SharedFlightRecordingStore extends OxigraphStore {
      sharedOptions: Array<Parameters<OxigraphStore['query']>[1]> = [];
      private held = false;

      async query(sparql: string, options?: Parameters<OxigraphStore['query']>[1]) {
        if (sparql.includes('ontology/SubGraph')) {
          this.sharedOptions.push(options);
          if (!this.held) {
            this.held = true;
            discoveryStarted();
            await discoveryGate;
          }
        }
        return super.query(sparql, options);
      }
    }

    const sharedStore = new SharedFlightRecordingStore();
    const sharedEngine = new DKGQueryEngine(sharedStore);
    await sharedStore.insert([
      q('urn:shared:s', 'http://schema.org/name', '"Shared"', GRAPH),
    ]);
    const firstController = new AbortController();
    const secondController = new AbortController();
    const scopedQuery =
      'SELECT ?sourceGraph ?name WHERE { GRAPH ?sourceGraph { ?s <http://schema.org/name> ?name } }';
    const common = {
      contextGraphId: CONTEXT_GRAPH,
      includeContextGraphPartitions: true,
      priority: 'background' as const,
      source: 'api.query',
    };

    const first = sharedEngine.query(scopedQuery, {
      ...common,
      signal: firstController.signal,
    });
    const firstRejected = expect(first).rejects.toThrow('first caller disconnected');
    await started;
    const second = sharedEngine.query(scopedQuery, {
      ...common,
      signal: secondController.signal,
    });
    await Promise.resolve();

    firstController.abort(new Error('first caller disconnected'));
    await firstRejected;
    releaseDiscovery();

    await expect(second).resolves.toBeDefined();
    expect(sharedStore.sharedOptions).toHaveLength(1);
    expect(sharedStore.sharedOptions[0]).toMatchObject({
      priority: 'background',
      source: 'api.query',
    });
    expect(sharedStore.sharedOptions[0]?.signal).toBeUndefined();
    expect(secondController.signal.aborted).toBe(false);
  });

  it('keeps caller cancellation out of GraphSetIndexStore refresh flights', async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });

    class AbortAwareGraphListStore extends OxigraphStore {
      readonly listGraphOptions: StoreQueryOptions[] = [];
      private held = false;

      override async listGraphs(options?: StoreQueryOptions): Promise<string[]> {
        this.listGraphOptions.push(options ?? {});
        if (!this.held) {
          this.held = true;
          refreshStarted();
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(options?.signal?.reason);
            options?.signal?.addEventListener('abort', onAbort, { once: true });
            void refreshGate.then(() => {
              options?.signal?.removeEventListener('abort', onAbort);
              resolve();
            }, reject);
          });
        }
        return super.listGraphs(options);
      }
    }

    const inner = new AbortAwareGraphListStore();
    await inner.insert([
      q('urn:indexed:s', 'http://schema.org/name', '"Indexed"', GRAPH),
    ]);
    const indexedEngine = new DKGQueryEngine(new GraphSetIndexStore(inner));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const common = {
      contextGraphId: CONTEXT_GRAPH,
      includeSharedMemory: true,
      priority: 'background' as const,
      source: 'api.query',
    };

    const first = indexedEngine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { ...common, signal: firstController.signal },
    );
    const firstRejected = expect(first).rejects.toThrow('first caller disconnected');
    await started;
    const second = indexedEngine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { ...common, signal: secondController.signal },
    );

    firstController.abort(new Error('first caller disconnected'));
    await firstRejected;
    releaseRefresh();

    await expect(second).resolves.toBeDefined();
    expect(inner.listGraphOptions).toHaveLength(1);
    expect(inner.listGraphOptions[0]).toMatchObject({
      priority: 'background',
      source: 'api.query',
    });
    expect(inner.listGraphOptions[0].signal).toBeUndefined();
    expect(secondController.signal.aborted).toBe(false);
  });

  it('returns all triples for entity', async () => {
    const result = await engine.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(3);
  });

  it('resolveKA returns entity data', async () => {
    const ual = 'did:dkg:mock:31337/1';
    // Need metadata in meta graph
    await store.insert([
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: ENTITY,
        graph: META,
      },
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/partOf',
        object: ual,
        graph: META,
      },
      {
        subject: ual,
        predicate: 'http://dkg.io/ontology/contextGraph',
        object: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
        graph: META,
      },
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.contentScopeVersion).toBe(1);
    expect(result.ual).toBe(ual);
    expect(result.rootEntity).toBe(ENTITY);
    expect(result.rootEntities).toEqual([ENTITY]);
    expect(result.contextGraphId).toBe(CONTEXT_GRAPH);
    expect(result.quads.length).toBeGreaterThanOrEqual(2);
  });

  it('resolveKA aggregates every member root of a multi-entity KA (Design B, PR #968)', async () => {
    const ual = 'did:dkg:mock:31337/42';
    const ENTITY_2 = 'did:dkg:agent:QmTextBot';
    await store.insert([
      // ENTITY data is seeded in beforeEach; add ENTITY_2 to the same data graph.
      q(ENTITY_2, 'http://schema.org/name', '"TextBot"'),
      q(`${ENTITY_2}/.well-known/genid/o1`, 'http://ex.org/type', '"TextAnalysis"'),
      // Two member rows under one UAL (Design B: one KA, many entities).
      q(`${ual}/1`, 'http://dkg.io/ontology/rootEntity', ENTITY, META),
      q(`${ual}/1`, 'http://dkg.io/ontology/partOf', ual, META),
      q(`${ual}/2`, 'http://dkg.io/ontology/rootEntity', ENTITY_2, META),
      q(`${ual}/2`, 'http://dkg.io/ontology/partOf', ual, META),
      q(ual, 'http://dkg.io/ontology/contextGraph', `did:dkg:context-graph:${CONTEXT_GRAPH}`, META),
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.contentScopeVersion).toBe(1);
    // Pre-#968 this returned only bindings[0]; now every member root is read.
    expect(result.rootEntities).toEqual([ENTITY, ENTITY_2]);
    expect(result.rootEntity).toBe(ENTITY); // backward-compat: first member root
    const subjects = new Set(result.quads.map((quad) => quad.subject));
    expect(subjects).toContain(ENTITY);
    expect(subjects).toContain(ENTITY_2);
    expect(subjects).toContain(`${ENTITY_2}/.well-known/genid/o1`);
  });

  it('treats persisted content-scope version zero as a legacy read', async () => {
    const ual = 'did:dkg:mock:31337/43';
    await store.insert([
      q(ual, `${DKG}contentScopeVersion`, `"0"^^<${XSD_INTEGER}>`, META),
      q(ual, `${DKG}rootEntity`, ENTITY, META),
      q(ual, `${DKG}contextGraph`, GRAPH, META),
    ]);

    const result = await engine.resolveKA(ual);

    expect(result.rootEntity).toBe(ENTITY);
    expect(result.rootEntities).toEqual([ENTITY]);
  });

  it('ignores legacy control rows stored in an RDF payload graph', async () => {
    const ual = 'did:dkg:mock:31337/44';
    const attackerRoot = 'urn:attacker:root';
    const payloadGraph = 'urn:attacker:payload';
    await store.insert([
      q(ual, `${DKG}rootEntity`, ENTITY, META),
      q(ual, `${DKG}contextGraph`, GRAPH, META),
      q(ual, `${DKG}rootEntity`, attackerRoot, payloadGraph),
      q(ual, `${DKG}contextGraph`, GRAPH, payloadGraph),
    ]);

    const result = await engine.resolveKA(ual);

    expect(result.rootEntities).toEqual([ENTITY]);
  });

  it('keeps the published resolveKA result root-compatible for legacy consumers', () => {
    expectTypeOf<QueryEngine['resolveKA']>()
      .returns.resolves.toEqualTypeOf<LegacyResolveKAResult>();
  });

  describe('graph-scoped resolveKnowledgeAsset', () => {
    const UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';

    it('loads the complete exact VM graph without root metadata or subject-prefix filtering', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const payload = [
        q('urn:asset:alpha', 'urn:predicate:name', '"Alpha"', vmGraph),
        q('urn:unconnected:beta', 'urn:predicate:name', '"Beta"', vmGraph),
        q('urn:unconnected:gamma', 'urn:predicate:value', '"disconnected payload"', vmGraph),
      ];
      await store.insert([
        ...payload,
        ...graphScopedMetadata(UAL, '1', vmGraph, payload.length),
        q('urn:asset:alpha', 'urn:predicate:decoy', '"outside exact graph"', GRAPH),
      ]);

      await expect(engine.resolveKA(UAL)).rejects.toThrow(/resolveKnowledgeAsset/);
      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
      if (result.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
        throw new Error('Expected graph-scoped KA');
      }
      expect(result.ual).toBe(UAL);
      expect(result.assertionVersion).toBe('1');
      expect(result.assertionGraph).toBe(vmGraph);
      expect(result.rootEntities).toEqual([]);
      expect(result.quads).toHaveLength(payload.length);
      expect(new Set(result.quads.map((quad) => quad.subject))).toEqual(
        new Set(payload.map((quad) => quad.subject)),
      );
      expect(result.quads.every((quad) => quad.graph === vmGraph)).toBe(true);
      expect(result.quads.some((quad) => quad.predicate === 'urn:predicate:decoy')).toBe(false);
    });

    it('ignores scope markers stored in another KA payload graph', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert([
        q('urn:asset:trusted', 'urn:p', '"trusted"', vmGraph),
        ...graphScopedMetadata(UAL, '1', vmGraph, 1),
        q(
          UAL,
          `${DKG}contentScopeVersion`,
          `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
          'urn:attacker:other-ka-payload',
        ),
      ]);

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.quads).toEqual([
        q('urn:asset:trusted', 'urn:p', '"trusted"', vmGraph),
      ]);
    });

    it.each([
      ['current', 'https://dkg.network/ontology#'],
      ['legacy', 'http://dkg.io/ontology/'],
    ])('rejects a %s named-subgraph meta graph impersonating a registered root', async (_label, namespace) => {
      const nestedContextGraphId = `${CONTEXT_GRAPH}/updates`;
      const nestedContextGraphUri = `did:dkg:context-graph:${nestedContextGraphId}`;
      const poisonedMetaGraph = `${nestedContextGraphUri}/_meta`;
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        nestedContextGraphId,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const poisonedMetadata = graphScopedMetadata(
        UAL,
        '1',
        vmGraph,
        1,
        undefined,
        poisonedMetaGraph,
      ).map((entry) => entry.predicate === `${DKG}contextGraph`
        ? { ...entry, object: nestedContextGraphUri }
        : entry);
      await store.insert([
        q(nestedContextGraphUri, RDF_TYPE, `${namespace}SubGraph`, META),
        q(nestedContextGraphUri, `${namespace}parentContextGraph`, GRAPH, META),
        q(nestedContextGraphUri, RDF_TYPE, DKG_CONTEXT_GRAPH, poisonedMetaGraph),
        q('urn:poisoned:asset', 'urn:p', '"must-not-resolve"', vmGraph),
        ...poisonedMetadata,
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/KA not found/);
    });

    it('accepts the genesis agents root registration from the agents data graph', async () => {
      const agentsContextGraphId = 'agents';
      const agentsContextGraphUri = 'did:dkg:context-graph:agents';
      const agentsMetaGraph = `${agentsContextGraphUri}/_meta`;
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        agentsContextGraphId,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const metadata = graphScopedMetadata(
        UAL,
        '1',
        vmGraph,
        1,
        undefined,
        agentsMetaGraph,
      ).map((entry) => entry.predicate === `${DKG}contextGraph`
        ? { ...entry, object: agentsContextGraphUri }
        : entry);
      await store.insert([
        q(agentsContextGraphUri, RDF_TYPE, DKG_CONTEXT_GRAPH, agentsContextGraphUri),
        q('urn:agents-root:asset', 'urn:p', '"trusted"', vmGraph),
        ...metadata,
      ]);

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.contextGraphId).toBe(agentsContextGraphId);
      expect(result.quads).toEqual([
        q('urn:agents-root:asset', 'urn:p', '"trusted"', vmGraph),
      ]);
    });

    it('accepts an independently registered slash-shaped wallet root', async () => {
      const walletContextGraphId = '0x2222222222222222222222222222222222222222/project';
      const walletContextGraphUri = `did:dkg:context-graph:${walletContextGraphId}`;
      const walletMetaGraph = `${walletContextGraphUri}/_meta`;
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        walletContextGraphId,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const metadata = graphScopedMetadata(
        UAL,
        '1',
        vmGraph,
        1,
        undefined,
        walletMetaGraph,
      ).map((entry) => entry.predicate === `${DKG}contextGraph`
        ? { ...entry, object: walletContextGraphUri }
        : entry);
      await store.insert([
        q(walletContextGraphUri, RDF_TYPE, DKG_CONTEXT_GRAPH, walletMetaGraph),
        q('urn:wallet-root:asset', 'urn:p', '"trusted"', vmGraph),
        ...metadata,
      ]);

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.contextGraphId).toBe(walletContextGraphId);
      expect(result.quads).toEqual([
        q('urn:wallet-root:asset', 'urn:p', '"trusted"', vmGraph),
      ]);
    });

    it('rejects metadata when its partition is also a registered legacy root payload graph', async () => {
      const aliasMetaGraph = `${META}/_meta`;
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert([
        q(META, RDF_TYPE, DKG_CONTEXT_GRAPH, aliasMetaGraph),
        q('urn:poisoned:legacy-asset', 'urn:p', '"must-not-resolve"', vmGraph),
        ...graphScopedMetadata(UAL, '1', vmGraph, 1),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/KA not found/);
    });

    it('pages exact-graph reads before materializing the resolved payload', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const payload = Array.from({ length: 257 }, (_, index) =>
        q(`urn:paged:${index.toString().padStart(3, '0')}`, 'urn:p', `"${index}"`, vmGraph));
      await store.insert([
        ...payload,
        ...graphScopedMetadata(UAL, '1', vmGraph, payload.length),
      ]);
      const trackedQuery = recorder(store.query.bind(store));
      store.query = trackedQuery;

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.quads).toHaveLength(payload.length);
      const exactReads = trackedQuery.calls
        .map(([sparql]) => sparql)
        .filter((sparql) =>
          sparql.includes(`GRAPH <${vmGraph}>`) && sparql.includes('ORDER BY ?s ?p ?o'));
      const exactCounts = trackedQuery.calls
        .map(([sparql]) => sparql)
        .filter((sparql) =>
          sparql.includes(`GRAPH <${vmGraph}>`) && sparql.includes('COUNT(*)'));
      expect(exactReads).toHaveLength(2);
      expect(exactCounts).toHaveLength(2);
      expect(exactReads[0]).toMatch(/LIMIT 256\s+OFFSET 0/);
      expect(exactReads[1]).toMatch(/LIMIT 2\s+OFFSET 256/);
    });

    it('rejects a declared exact graph that exceeds the cumulative quad budget', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert(graphScopedMetadata(UAL, '1', vmGraph, 100_001));

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/exceeds quad limit/);
    });

    it('derives the versioned VM graph inside the registered subgraph', async () => {
      const assertionVersion = '2';
      const subGraphName = 'updates';
      const scope = createGraphKnowledgeAssetScope(UAL, assertionVersion);
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
        subGraphName,
      );
      await store.insert([
        q('urn:update:subject', 'urn:update:predicate', '"v2"', vmGraph),
        ...graphScopedMetadata(UAL, assertionVersion, vmGraph, 1, subGraphName),
      ]);

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.contentScopeVersion).toBe(GRAPH_KA_CONTENT_SCOPE_VERSION);
      if (result.contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
        throw new Error('Expected graph-scoped KA');
      }
      expect(result.assertionVersion).toBe(assertionVersion);
      expect(result.assertionGraph).toBe(vmGraph);
      expect(result.quads).toEqual([
        q('urn:update:subject', 'urn:update:predicate', '"v2"', vmGraph),
      ]);
    });

    it('fails closed when metadata points away from the UAL-derived exact graph', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const attackerGraph = `${GRAPH}/_verifiable_memory/attacker/7`;
      await store.insert([
        q('urn:expected', 'urn:p', '"expected"', vmGraph),
        q('urn:attacker', 'urn:p', '"attacker"', attackerGraph),
        ...graphScopedMetadata(UAL, '1', attackerGraph, 1),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/assertionGraph mismatch/);
    });

    it('fails closed when the exact graph count differs from committed metadata', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert([
        q('urn:only', 'urn:p', '"one"', vmGraph),
        ...graphScopedMetadata(UAL, '1', vmGraph, 2),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/graph integrity mismatch/);
    });

    it('does not fall back to legacy resolution when a V2 marker has incomplete metadata', async () => {
      await store.insert([
        q(
          UAL,
          `${DKG}contentScopeVersion`,
          `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`,
          META,
        ),
        q(UAL, `${DKG}contextGraph`, GRAPH, META),
        q(UAL, `${DKG}rootEntity`, ENTITY, META),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/missing kaUal metadata/);
    });

    it('rejects V2 metadata that omits the private triple count', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const metadata = graphScopedMetadata(UAL, '1', vmGraph, 1)
        .filter((entry) => entry.predicate !== `${DKG}privateTripleCount`);
      await store.insert([
        q('urn:asset', 'urn:p', '"value"', vmGraph),
        ...metadata,
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(
        /missing privateTripleCount metadata/,
      );
    });

    it('rejects an empty V2 count envelope', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert(graphScopedMetadata(UAL, '1', vmGraph, 0));

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/empty asset/);
    });

    it('requires a private commitment exactly when the V2 private count is positive', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert(graphScopedMetadata(UAL, '1', vmGraph, 0, undefined, META, 1));

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(
        /requires exactly one privateMerkleRoot/,
      );
    });

    it('rejects a V2 private commitment when the private count is zero', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert(
        graphScopedMetadata(UAL, '1', vmGraph, 1, undefined, META, 0, 'ab'.repeat(32)),
      );
      await store.insert([q('urn:asset', 'urn:p', '"value"', vmGraph)]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(
        /privateMerkleRoot without private content/,
      );
    });

    it('accepts a legitimate private-only V2 envelope without materializing public quads', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      await store.insert(
        graphScopedMetadata(UAL, '1', vmGraph, 0, undefined, META, 1, 'cd'.repeat(32)),
      );

      const result = await engine.resolveKnowledgeAsset(UAL);

      expect(result.quads).toEqual([]);
    });

    it('does not treat graph-scoped metadata outside a trusted meta partition as control data', async () => {
      const scope = createGraphKnowledgeAssetScope(UAL, '1');
      const vmGraph = knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      );
      const poisonedMetaGraph = 'urn:attacker:metadata';
      await store.insert([
        q('urn:asset', 'urn:p', '"value"', vmGraph),
        ...graphScopedMetadata(UAL, '1', vmGraph, 1, undefined, poisonedMetaGraph),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/KA not found/);
    });

    it('does not hide a malformed scope marker behind the legacy fallback', async () => {
      await store.insert([
        q(UAL, `${DKG}contentScopeVersion`, '"not-an-integer"', META),
        q(UAL, `${DKG}contextGraph`, GRAPH, META),
        q(UAL, `${DKG}rootEntity`, ENTITY, META),
      ]);

      await expect(engine.resolveKnowledgeAsset(UAL)).rejects.toThrow(/invalid contentScopeVersion/);
    });
  });

  it('throws on unknown UAL', async () => {
    await expect(engine.resolveKA('did:dkg:mock:9999/99')).rejects.toThrow(
      'KA not found',
    );
  });

  // ───────────────────────────────────────────────────────────────────
  // #789 Codex review: when a user query carries an inner UNION over a
  // multi-graph view, `wrapWithGraphUnion` returns null (a nested
  // UnionNode would crash Blazegraph) and `queryMultipleGraphs` falls
  // back to per-graph execution. The fallback MUST merge results in a
  // FORM-AWARE way — flattening every form into `bindings` silently
  // corrupts CONSTRUCT/DESCRIBE (drops quads), ASK (drops the boolean),
  // and SELECT with solution-set modifiers (LIMIT/ORDER BY/DISTINCT/
  // aggregates can't be reconstructed from per-graph slices).
  //
  // The `verifiable-memory` view resolves to TWO graphs — the root
  // `<cg>` graph plus every `<cg>/_verifiable_memory/*` sub-graph — so
  // seeding one VM sub-graph reaches the multi-graph fallback path.
  describe('#789 multi-graph inner-UNION fallback is form-aware', () => {
    const VM_SUB = `${GRAPH}/_verifiable_memory/vm1`;
    const E1 = 'urn:vm:e1';
    const E2 = 'urn:vm:e2';

    beforeEach(async () => {
      // E1 lives in the root graph (already a VM candidate), E2 only in
      // the VM sub-graph, so a correct cross-graph merge must surface both.
      await store.insert([
        q(E1, 'http://ex.org/p1', '"root-val"', GRAPH),
        q(E2, 'http://ex.org/p2', '"vm-val"', VM_SUB),
      ]);
    });

    it('CONSTRUCT merges quads across graphs (does not drop the quad shape)', async () => {
      const result = await engine.query(
        `CONSTRUCT { ?s <urn:out> ?v } WHERE {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
      );
      expect(result.quads).toBeDefined();
      const subjects = (result.quads ?? []).map((qd) => qd.subject).sort();
      expect(subjects).toEqual([E1, E2]);
    });

    it('ASK returns true when the pattern matches in ANY graph', async () => {
      const result = await engine.query(
        `ASK {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
      );
      expect(result.bindings).toEqual([{ result: 'true' }]);
    });

    it('ASK returns false when the pattern matches in NO graph', async () => {
      const result = await engine.query(
        `ASK {
           { ?s <http://ex.org/nope1> ?v } UNION { ?s <http://ex.org/nope2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
      );
      expect(result.bindings).toEqual([{ result: 'false' }]);
    });

    it('SELECT without modifiers concatenates bindings across graphs', async () => {
      const result = await engine.query(
        `SELECT ?s ?v WHERE {
           { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
         }`,
        { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
      );
      const subjects = result.bindings.map((b) => b['s']).sort();
      expect(subjects).toEqual([E1, E2]);
    });

    it('SELECT with a solution-set modifier (ORDER BY) is rejected, not silently corrupted', async () => {
      await expect(
        engine.query(
          `SELECT ?s ?v WHERE {
             { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
           } ORDER BY ?v`,
          { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
        ),
      ).rejects.toThrow(/cannot be evaluated across graphs/i);
    });

    it('SELECT with LIMIT is rejected too (per-graph slices would over-count)', async () => {
      await expect(
        engine.query(
          `SELECT ?s ?v WHERE {
             { ?s <http://ex.org/p1> ?v } UNION { ?s <http://ex.org/p2> ?v }
           } LIMIT 1`,
          { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
        ),
      ).rejects.toThrow(/cannot be evaluated across graphs/i);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // #1596: the strict `shared-working-memory` view over a large public CG
  // fans out to ~1,424 named graphs. The previous multi-graph wrapper emitted
  // one `{ GRAPH <g> { … } } UNION …` branch per graph — a ~1,424-branch union
  // tree that makes the oxigraph-server planner blow up and drop the socket
  // ("fetch failed"). The read must now be a SINGLE `VALUES ?g { … } GRAPH ?g
  // { … }` query, with the injected graph variable hidden behind a sub-SELECT
  // so `SELECT *` and cross-graph DISTINCT keep their UNION-form semantics.
  describe('#1596 multi-graph SWM view uses one VALUES block, not per-graph UNION', () => {
    const SWM_CG = 'swm-1596';
    const swmGraph = (addr: string, n: number) =>
      `did:dkg:context-graph:${SWM_CG}/_shared_memory/${addr}/${n}`;

    // A store that records every SPARQL string the engine sends, then delegates.
    class RecordingStore extends OxigraphStore {
      queries: string[] = [];
      async query(sparql: string, options?: Parameters<OxigraphStore['query']>[1]) {
        this.queries.push(sparql);
        return super.query(sparql, options);
      }
    }

    let recStore: RecordingStore;
    let recEngine: DKGQueryEngine;

    beforeEach(() => {
      recStore = new RecordingStore();
      recEngine = new DKGQueryEngine(recStore);
    });

    const swmQuery = (sparql: string) =>
      recEngine.query(sparql, { contextGraphId: SWM_CG, view: 'shared-working-memory' });

    const multiGraphQuery = () =>
      recStore.queries.find((s) => s.includes('VALUES ?__dkgViewGraph'));

    it('collapses N SWM graphs into one VALUES/GRAPH query and reads every triple', async () => {
      const quads: Quad[] = [];
      for (let i = 0; i < 6; i++) {
        const g = swmGraph('0xowner', i);
        quads.push(q(`urn:swm:s${i}`, 'http://ex.org/p', `"v${i}"`, g));
        quads.push(q(`urn:swm:s${i}`, 'http://ex.org/o', `"w${i}"`, g));
      }
      await recStore.insert(quads);
      recStore.queries.length = 0; // ignore any graph-discovery from insert

      const result = await swmQuery('SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
      expect(result.bindings).toHaveLength(12); // all rows, across all 6 graphs

      // The multi-graph read is ONE VALUES-scoped query, never a per-graph UNION.
      const multi = multiGraphQuery();
      expect(multi).toBeDefined();
      expect(multi).toContain('GRAPH ?__dkgViewGraph {');
      expect(multi).toContain(swmGraph('0xowner', 0));
      expect(
        recStore.queries.some((s) => /}\s*UNION\s*{\s*GRAPH\s*</i.test(s)),
      ).toBe(false);
    });

    it('preserves COUNT(*) aggregate semantics over the graph set', async () => {
      const quads: Quad[] = [];
      for (let i = 0; i < 5; i++) {
        quads.push(q(`urn:c:s${i}`, 'http://ex.org/p', `"v${i}"`, swmGraph('0xc', i)));
      }
      await recStore.insert(quads);

      const result = await swmQuery('SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }');
      const count = Number(String(result.bindings[0]['count']).match(/^"?(\d+)"?/)?.[1]);
      expect(count).toBe(5);
      expect(multiGraphQuery()).toBeDefined(); // still the VALUES form
    });

    it('cross-graph DISTINCT dedupes an identical triple present in two graphs', async () => {
      await recStore.insert([
        q('urn:dup:s', 'http://ex.org/p', '"same"', swmGraph('0xd', 1)),
        q('urn:dup:s', 'http://ex.org/p', '"same"', swmGraph('0xd', 2)),
      ]);

      const all = await swmQuery('SELECT ?s ?p ?o WHERE { ?s ?p ?o }');
      expect(all.bindings).toHaveLength(2); // once per graph, like the UNION form

      const distinct = await swmQuery('SELECT DISTINCT ?s ?p ?o WHERE { ?s ?p ?o }');
      expect(distinct.bindings).toHaveLength(1); // deduped across graphs
    });

    it('SELECT * does not leak the injected graph variable', async () => {
      await recStore.insert([
        q('urn:star:s', 'http://ex.org/p', '"v"', swmGraph('0xe', 1)),
        q('urn:star:s', 'http://ex.org/o', '"w"', swmGraph('0xe', 2)),
      ]);

      const star = await swmQuery('SELECT * WHERE { ?s ?p ?o }');
      expect(star.bindings.length).toBeGreaterThanOrEqual(2);
      for (const b of star.bindings) {
        expect(Object.keys(b).sort()).toEqual(['o', 'p', 's']);
        expect(Object.keys(b)).not.toContain('__dkgViewGraph');
      }
    });

    it('SELECT * over a var-less (all-constant) body never leaks the sentinel', async () => {
      // A var-less WHERE body offers nowhere to hide the injected graph
      // variable, so `wrapWithGraphValues` declines and the read falls back to
      // the union/per-graph form (which binds no graph variable). The sentinel
      // must not appear as a result column.
      await recStore.insert([
        q('urn:cx', 'urn:cp', 'urn:co', swmGraph('0xf', 1)),
        q('urn:cx', 'urn:cp', 'urn:co', swmGraph('0xf', 2)),
      ]);

      const star = await swmQuery('SELECT * WHERE { <urn:cx> <urn:cp> <urn:co> }');
      for (const b of star.bindings) {
        expect(Object.keys(b)).not.toContain('__dkgViewGraph');
      }
      // The var-less body must NOT have been emitted as the bare VALUES form
      // that would project the sentinel.
      expect(multiGraphQuery()).toBeUndefined();
    });

    // #1599 review: the VALUES fast path changed execution for EVERY multi-graph
    // query form with a locatable WHERE block, but only SELECT was covered above.
    // CONSTRUCT and ASK are part of the engine contract and have had shape
    // regressions before (#789), so pin them through the new VALUES path too —
    // without an inner UNION (which would divert to the per-graph fallback).
    it('CONSTRUCT over the SWM view uses the VALUES path and keeps the quad shape', async () => {
      const quads: Quad[] = [];
      for (let i = 0; i < 4; i++) {
        quads.push(q(`urn:cq:s${i}`, 'http://ex.org/p', `"v${i}"`, swmGraph('0xcq', i)));
      }
      await recStore.insert(quads);
      recStore.queries.length = 0;

      const result = await swmQuery('CONSTRUCT { ?s <urn:out> ?o } WHERE { ?s <http://ex.org/p> ?o }');
      // Graph-shaped result preserved (not silently flattened to bindings).
      expect(result.quads).toBeDefined();
      expect((result.quads ?? []).map((qd) => qd.subject).sort())
        .toEqual(['urn:cq:s0', 'urn:cq:s1', 'urn:cq:s2', 'urn:cq:s3']);
      expect((result.quads ?? []).every((qd) => qd.predicate === 'urn:out')).toBe(true);
      // ...and it went through the ONE VALUES query, never a per-graph UNION.
      expect(multiGraphQuery()).toBeDefined();
      expect(recStore.queries.some((s) => /}\s*UNION\s*{\s*GRAPH\s*</i.test(s))).toBe(false);
    });

    it('ASK over the SWM view uses the VALUES path and returns the boolean', async () => {
      await recStore.insert([
        q('urn:aq:s', 'http://ex.org/p', '"present"', swmGraph('0xaq', 2)),
      ]);
      recStore.queries.length = 0;

      const hit = await swmQuery('ASK WHERE { ?s <http://ex.org/p> "present" }');
      expect(hit.bindings).toEqual([{ result: 'true' }]);
      expect(multiGraphQuery()).toBeDefined();

      const miss = await swmQuery('ASK WHERE { ?s <http://ex.org/p> "absent" }');
      expect(miss.bindings).toEqual([{ result: 'false' }]);
    });
  });

  it('queries across all contextGraphs', async () => {
    // Add data to another context graph
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:context-graph:text-tools'),
    ]);

    const result = await engine.queryAllContextGraphs(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );
    expect(result.bindings.length).toBe(2);
  });

  it('queries shared memory graph when graphSuffix is _shared_memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['name']).toBe('"Workspace Only"');
  });

  it('queries union of data and shared memory when includeSharedMemory is true', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:union', 'http://schema.org/name', '"In Workspace"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );
    const names = result.bindings.map((r) => String(r['name']));
    expect(names.some((n) => n.includes('ImageBot'))).toBe(true);
    expect(names.some((n) => n.includes('In Workspace'))).toBe(true);
    expect(result.bindings.length).toBe(2);
  });

  it('dedupes duplicate rows when includeSharedMemory returns same binding from data and shared memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', GRAPH),
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const duplicates = result.bindings.filter((row) =>
      row['s'] === 'urn:dup:entity:1' && String(row['name']).includes('Duplicate'),
    );
    expect(duplicates.length).toBe(1);
  });

  it('dedupes duplicate quads for includeSharedMemory CONSTRUCT queries', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', GRAPH),
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'CONSTRUCT { ?s <http://schema.org/name> ?name } WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const matches = (result.quads ?? []).filter((row) =>
      row.subject === 'urn:dup:quad:1'
        && row.predicate === 'http://schema.org/name'
        && String(row.object).includes('QuadDup'),
    );
    expect(matches.length).toBe(1);
  });

  it('rejects INSERT queries', async () => {
    await expect(
      engine.query('INSERT DATA { <s> <p> <o> }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DELETE queries', async () => {
    await expect(
      engine.query('DELETE WHERE { ?s ?p ?o }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DROP queries', async () => {
    await expect(
      engine.query('DROP GRAPH <http://example.org>'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('view=verifiable-memory includes the root content graph (RC11 / PR-A: Codex #671)', async () => {
    // RC11 / PR-A (Codex review fix on #671, comment 3302058969):
    // re-includes the root context-graph alongside `_verifiable_memory/*`
    // so a successful lifecycle VM publish is immediately
    // observable via `view: 'verifiable-memory'` (the pre-PR2 behaviour
    // existing callers, including memory-search, rely on). The
    // tentative-VM leak that PR2 was meant to plug is now fixed at the
    // publisher (root-graph insert deferred to the chain-success
    // branch); see the comment in `dkg-query-engine.ts` for the full
    // rationale.
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).toContain('"ImageBot"');
  });

  it('view=verifiable-memory unions root content graph + _verifiable_memory/ sub-graphs (RC11 / PR-A)', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    // Both the publisher's confirmed root-graph data AND post-`verify`
    // `_verifiable_memory/*` data must surface — VM is the union of both
    // (Codex #671 review fix).
    expect(names).toContain('"ImageBot"');
    expect(names).toContain('"Quorum Verified"');
  });

  it('view=verifiable-memory constrains compact GRAPH variables without duplicating multi-graph rows', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"' },
      { g: vmGraph, name: '"Quorum Verified"' },
    ]);
  });

  it('view=verifiable-memory honors compact explicit GRAPH IRIs without duplicating multi-graph rows', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
    ]);

    const result = await engine.query(
      `SELECT ?name WHERE { GRAPH<${vmGraph}> { ?s <http://schema.org/name> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
    );

    expect(result.bindings).toEqual([
      { name: '"Quorum Verified"' },
    ]);
  });

  it('view=verifiable-memory with verifiedGraph scopes to that graph only', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/team-a`;
    await store.insert([
      q('urn:vm:scoped:1', 'http://schema.org/name', '"Scoped Data"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory', verifiedGraph: 'team-a' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"Scoped Data"');
  });

  it('view=verifiable-memory excludes _meta and staging graphs', async () => {
    await store.insert([
      q('urn:vm:meta', 'http://schema.org/name', '"Meta Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/q1/_meta`),
      q('urn:vm:staging', 'http://schema.org/name', '"Staging Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verifiable_memory/staging/draft`),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verifiable-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).not.toContain('"Meta Only"');
    expect(names).not.toContain('"Staging Only"');
  });

  it('view=shared-working-memory does NOT include root content graph', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'shared-working-memory' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  it('view requires contextGraphId', async () => {
    await expect(
      engine.query('SELECT ?s WHERE { ?s ?p ?o }', { view: 'verifiable-memory' }),
    ).rejects.toThrow('requires a contextGraphId');
  });

  it('rejects FROM clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM <${GRAPH}> WHERE { ?s <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('rejects compact FROM clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM<${GRAPH}> WHERE { ?s <http://schema.org/name> ?name }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('rejects compact FROM NAMED clauses on context-graph-scoped local queries', async () => {
    await expect(
      engine.query(
        `SELECT ?name FROM NAMED<${GRAPH}> WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: FROM clauses are not allowed/i);
  });

  it('allows scoped queries with prefixed names that contain FROM', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/from', '"FromPredicate"'),
    ]);

    await expect(engine.query(
      `SELECT ?from WHERE { ?s <http://example.com/from> ?from }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({
      bindings: [{ from: '"FromPredicate"' }],
    });

    await expect(engine.query(
      `PREFIX ex: <http://example.com/>
       SELECT ?name WHERE { ?s ex:from ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({
      bindings: [{ name: '"FromPredicate"' }],
    });
  });

  it('allows scoped queries with a prefix label named from', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"FromPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX from: <http://example.com/>
       SELECT ?name WHERE { ?s from:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('allows scoped queries with a prefix label named graph', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"GraphPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX graph: <http://example.com/>
       SELECT ?name WHERE { ?s graph:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('allows scoped queries with hyphenated graph/from prefix labels', async () => {
    await store.insert([
      q(ENTITY, 'http://example.com/name', '"HyphenatedPrefixPredicate"'),
    ]);

    await expect(engine.query(
      `PREFIX graph-viz: <http://example.com/>
       SELECT ?name WHERE { ?s graph-viz:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });

    await expect(engine.query(
      `PREFIX from-schema: <http://example.com/>
       SELECT ?name WHERE { ?s from-schema:name ?name }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).resolves.toMatchObject({ bindings: expect.any(Array) });
  });

  it('rejects explicit GRAPH IRIs outside the scoped context graph', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH <${otherGraph}> { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('allows explicit GRAPH IRI against the same CG\'s _meta graph', async () => {
    // Regression guard for #774 finding #4 (mis-attributed as a
    // `createContextGraph` regression in the issue body; root cause is
    // here in the query engine). `devnet-test-invite-flow.sh` step 1b
    // queries `GRAPH <…/_meta> { <cg> <dkg:curator> ?owner }` to
    // assert the curator was stamped at create time. Authenticated
    // callers that supplied a `contextGraphId` already have read access
    // to that CG — refusing them visibility into the same CG's `_meta`
    // graph (where curator / allowedAgent / registrationStatus live)
    // broke the invite flow, the CG Overview UI, and downstream sync
    // code. `_meta` is only in the EXPLICIT-IRI allow set, not the
    // graph-variable set, so a `GRAPH ?g` rewrite still cannot iterate
    // into `_meta` and leak the allowedAgent list.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xabc',
        graph: META,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${META}> { <${GRAPH}> <https://dkg.network/ontology#curator> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('did:dkg:agent:0xabc');
  });

  it('allows explicit GRAPH IRI against the same CG\'s _shared_memory_meta graph', async () => {
    // Regression guard for #774 finding #3 (also mis-attributed in the
    // issue body — diagnosed as "owner-peer not replicated to node 2";
    // the workspaceOwner triple IS in fact replicated, but the scoped
    // query couldn't see it). `devnet-test-swm-ownership-restart.sh`
    // `wait_for_owner_meta` probe queries
    //
    //   GRAPH <…/_shared_memory_meta> {
    //     <root> <http://dkg.io/ontology/workspaceOwner> ?owner
    //   }
    //
    // …with `contextGraphId` scope. Same reasoning as the `_meta`
    // allow: authenticated callers already have read access to the CG;
    // refusing them visibility into the SWM ownership metadata breaks
    // both replica ACL probes and downstream sync code. Add to the
    // EXPLICIT-IRI allow set only; graph-variable expansion stays
    // constrained to data + SWM data so `GRAPH ?g` cannot iterate into
    // `_shared_memory_meta`.
    const swmMetaGraph = `${GRAPH}/_shared_memory_meta`;
    await store.insert([
      {
        subject: 'urn:swm-root:test',
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: '"12D3KooWowner"',
        graph: swmMetaGraph,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${swmMetaGraph}> { <urn:swm-root:test> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('"12D3KooWowner"');
  });

  it('rejects explicit GRAPH IRI against CG _meta when caller narrowed to graphSuffix=_shared_memory (privacy fence)', async () => {
    // Bot review on #776: the `_meta` widening MUST NOT apply when the
    // caller explicitly narrowed routing to SWM-only via
    // `graphSuffix: '_shared_memory'`. `_meta` lives on the CG-data
    // path, not the SWM path, so a SWM-narrowed caller has no business
    // reading it. We pair each meta URI with the corresponding data
    // graph and ONLY widen the explicit-IRI allow set when the
    // matching data graph is in `allowedGraphs`.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#allowedAgent',
        object: '"0xsecret"',
        graph: META,
      },
    ]);
    await expect(
      engine.query(
        `SELECT ?o WHERE { GRAPH <${META}> { <${GRAPH}> <https://dkg.network/ontology#allowedAgent> ?o } }`,
        { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
      ),
    ).rejects.toThrow(/Scoped query violation/i);
  });

  it('allows explicit GRAPH IRI against _shared_memory_meta even on graphSuffix=_shared_memory route', async () => {
    // SWM-only narrowed callers should still see SWM metadata
    // (workspaceOwner / promote-time ACL). The privacy fence drops
    // CG-level `_meta` for SWM-narrowed routes (covered in the next
    // test) but keeps the SWM analogue accessible.
    const swmMetaGraph = `${GRAPH}/_shared_memory_meta`;
    await store.insert([
      {
        subject: 'urn:swm-root:test',
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: '"12D3KooWowner"',
        graph: swmMetaGraph,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${swmMetaGraph}> { <urn:swm-root:test> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('"12D3KooWowner"');
  });

  it('allows explicit GRAPH IRI against the actual sub-graph _meta location (\u003ccg\u003e/\u003csub\u003e/_meta)', async () => {
    // Bot review on #776: sub-graph metadata is written by
    // `graph-manager.ts` to `did:dkg:context-graph:<cg>/<sub>/_meta`
    // (via `contextGraphSubGraphMetaUri`), NOT to
    // `did:dkg:context-graph:<cg>/context/<sub>/_meta` (which is what
    // `contextGraphMetaUri(cg, sub)` produces). The earlier draft of
    // this fix used the wrong helper and would have left scoped
    // sub-graph metadata reads still rejected; this test pins the
    // correct path.
    const subGraphName = 'code';
    const subGraphMeta = `${GRAPH}/${subGraphName}/_meta`;
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xsubgraph',
        graph: subGraphMeta,
      },
    ]);
    const result = await engine.query(
      `SELECT ?owner WHERE { GRAPH <${subGraphMeta}> { <${GRAPH}> <https://dkg.network/ontology#curator> ?owner } }`,
      { contextGraphId: CONTEXT_GRAPH, subGraphName },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['owner']).toBe('did:dkg:agent:0xsubgraph');
  });

  it('GRAPH ?g binds to same-CG _meta on default-routed scoped queries (UI hook regression coverage)', async () => {
    // Codex r2 on #776: `useSwmAttributions`, `useVerifiableMemoryAnchors`
    // and `useVerifiedEntityIdentity` all bind `GRAPH ?g` over
    // CG-scoped metadata. Widening `constrainGraphVariablesToAllowedSet`
    // to the same set as the explicit-IRI allow set restores the
    // CG-level case. Cross-CG `?g` bindings are still rejected by
    // the surrounding scope-rejection tests.
    await store.insert([
      {
        subject: GRAPH,
        predicate: 'https://dkg.network/ontology#curator',
        object: 'did:dkg:agent:0xowner',
        graph: META,
      },
    ]);
    const result = await engine.query(
      `SELECT ?g ?o WHERE { GRAPH ?g { <${GRAPH}> <https://dkg.network/ontology#curator> ?o } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['g']).toBe(META);
    expect(result.bindings[0]['o']).toBe('did:dkg:agent:0xowner');
  });

  it('GRAPH ?g over sub-graph SWM meta does NOT bind without a CG-registry-aware allow set (#774 follow-up)', async () => {
    // Codex r5 RED on #776: dynamic sub-graph metadata enumeration
    // is fundamentally unsafe without a CG-registry interface
    // because the URI `<cg>/<seg>/_meta` cannot be disambiguated
    // structurally from the root `_meta` of a separate registered
    // CG `<cg>/<seg>`. We therefore restrict the variable allow set
    // to the static `metaAllowList` (root metas only), which is
    // exactly what #774 F4 + F3 need. UI hooks that enumerate
    // sub-graph SWM metadata via
    // `GRAPH ?g + CONTAINS("_shared_memory_meta")` are a tracked
    // follow-up that requires the CG-registry plumbing to land
    // safely.
    //
    // This test pins the limitation: same-CG sub-graph
    // `_shared_memory_meta` partitions are NOT bound by `GRAPH ?g`
    // under `contextGraphId` scope. Removing this fence in a
    // future PR must come with an authoritative cross-CG
    // disambiguation mechanism, otherwise this test catches the
    // regression.
    const cgRootSwmMeta = `${GRAPH}/_shared_memory_meta`;
    const cgCodeSwmMeta = `${GRAPH}/code/_shared_memory_meta`;
    await store.insert([
      { subject: 'urn:op:root', predicate: 'http://schema.org/agent', object: '"agentRoot"', graph: cgRootSwmMeta },
      { subject: 'urn:op:code', predicate: 'http://schema.org/agent', object: '"agentCode"', graph: cgCodeSwmMeta },
    ]);
    const result = await engine.query(
      `SELECT ?g ?agent WHERE {
        GRAPH ?g {
          ?op <http://schema.org/agent> ?agent .
        }
        FILTER(CONTAINS(STR(?g), "_shared_memory_meta"))
      }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    const agents = result.bindings.map((b) => b['agent']).sort();
    expect(agents).toEqual(['"agentRoot"']);
    expect(result.bindings.some((b) => b['g'] === cgCodeSwmMeta)).toBe(false);
  });

  it('GRAPH ?g with subGraphName=code DOES bind that exact sub-graph meta (explicit route)', async () => {
    // The static `metaAllowList` for `subGraphName: 'code'` already
    // contains `<cg>/code/_meta` and `<cg>/code/_shared_memory_meta`,
    // so a `GRAPH ?g` query under that scope binds the exact
    // sub-graph the caller asked for. Sibling sub-graphs are not
    // visible (the metaAllowList is exact, not prefixed).
    const codeSwmMeta = `${GRAPH}/code/_shared_memory_meta`;
    const decisionsSwmMeta = `${GRAPH}/decisions/_shared_memory_meta`;
    await store.insert([
      { subject: 'urn:op:in-scope', predicate: 'http://schema.org/agent', object: '"agentCode"', graph: codeSwmMeta },
      { subject: 'urn:op:sibling', predicate: 'http://schema.org/agent', object: '"agentDecisions"', graph: decisionsSwmMeta },
    ]);
    const result = await engine.query(
      `SELECT ?agent WHERE { GRAPH ?g { ?op <http://schema.org/agent> ?agent } }`,
      { contextGraphId: CONTEXT_GRAPH, subGraphName: 'code' },
    );
    const agents = result.bindings.map((b) => b['agent']).sort();
    expect(agents).toEqual(['"agentCode"']);
  });

  it('rejects compact explicit GRAPH IRIs outside the scoped context graph', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH<${otherGraph}> { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('allows prefixed explicit GRAPH targets that resolve to the scoped graph', async () => {
    const result = await engine.query(
      `PREFIX cg: <did:dkg:context-graph:>
       SELECT ?name WHERE { GRAPH cg:${CONTEXT_GRAPH} { ?s <http://schema.org/name> ?name } }`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { name: '"ImageBot"' },
    ]);
  });

  it('rejects prefixed explicit GRAPH targets outside the scoped graph set', async () => {
    const otherGraph = 'did:dkg:context-graph:other-agent-registry';
    await store.insert([
      q('urn:secret:entity', 'http://schema.org/name', '"Secret"', otherGraph),
    ]);

    await expect(
      engine.query(
        `PREFIX other: <${otherGraph}>
         SELECT ?name WHERE { GRAPH other: { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH <did:dkg:context-graph:other-agent-registry> is outside the allowed graph set/i);
  });

  it('rejects unresolved prefixed GRAPH targets fail-closed', async () => {
    await expect(
      engine.query(
        `SELECT ?name WHERE { GRAPH missing:allowed { ?s <http://schema.org/name> ?name } }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH prefixed target missing:allowed cannot be resolved/i);
  });

  it('allows prefixed explicit GRAPH targets alongside constrained GRAPH variables', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      `PREFIX cg: <did:dkg:context-graph:>
       SELECT ?g ?name ?sameName WHERE {
         GRAPH ?g { ?s <http://schema.org/name> ?name }
         GRAPH cg:${CONTEXT_GRAPH} { ?s <http://schema.org/name> ?sameName }
       }`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"', sameName: '"ImageBot"' },
    ]);
  });

  it('constrains GRAPH variables to the scoped context graph data graph', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['g']).toBe(GRAPH);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('does not re-inject the full graph allow-list when top-level VALUES already narrows GRAPH ?g', async () => {
    class RecordingStore extends OxigraphStore {
      queries: string[] = [];
      async query(sparql: string, options?: Parameters<OxigraphStore['query']>[1]) {
        this.queries.push(sparql);
        return super.query(sparql, options);
      }
    }

    const recordingStore = new RecordingStore();
    const recordingEngine = new DKGQueryEngine(recordingStore);
    // Mirror issue #1989's cardinality: the Blackbox metadata query returned
    // 249 rows, of which 125 confirmed VM graphs were materialized locally.
    // The caller selected only five of those graphs.
    const vmGraphs = Array.from(
      { length: 125 },
      (_, index) => `${GRAPH}/_verifiable_memory/0xagent/${index + 128}`,
    );
    await recordingStore.insert(vmGraphs.map((graph, index) => (
      q(`urn:vm:${index}`, 'http://schema.org/name', `"${index}"`, graph)
    )));
    recordingStore.queries.length = 0;

    const sparql = `SELECT ?sourceGraph ?name WHERE {
      VALUES ?sourceGraph { ${vmGraphs.slice(0, 5).map((graph) => `<${graph}>`).join(' ')} }
      GRAPH ?sourceGraph { ?s <http://schema.org/name> ?name }
    } ORDER BY ?sourceGraph`;
    const result = await recordingEngine.query(
      sparql,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings.map((row) => row['name'])).toEqual([
      '"0"',
      '"1"',
      '"2"',
      '"3"',
      '"4"',
    ]);
    const executed = recordingStore.queries.at(-1) ?? '';
    expect(executed.match(/VALUES\s+\?sourceGraph/gi)).toHaveLength(1);
    expect(executed).toBe(sparql);
    expect(executed).not.toContain(vmGraphs[5]);
  });

  it('retains the allow-list intersection when caller VALUES contains an out-of-scope graph', async () => {
    class RecordingStore extends OxigraphStore {
      queries: string[] = [];
      async query(sparql: string, options?: Parameters<OxigraphStore['query']>[1]) {
        this.queries.push(sparql);
        return super.query(sparql, options);
      }
    }

    const recordingStore = new RecordingStore();
    const recordingEngine = new DKGQueryEngine(recordingStore);
    const vm = `${GRAPH}/_verifiable_memory/0xagent/1`;
    const foreign = 'did:dkg:context-graph:foreign/_verifiable_memory/0xagent/1';
    await recordingStore.insert([
      q('urn:vm:allowed', 'http://schema.org/name', '"allowed"', vm),
      q('urn:vm:foreign', 'http://schema.org/name', '"foreign"', foreign),
    ]);
    recordingStore.queries.length = 0;

    const result = await recordingEngine.query(
      `SELECT ?sourceGraph ?name WHERE {
        VALUES ?sourceGraph { <${vm}> <${foreign}> }
        GRAPH ?sourceGraph { ?s <http://schema.org/name> ?name }
      }`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([{ sourceGraph: vm, name: '"allowed"' }]);
    const executed = recordingStore.queries.at(-1) ?? '';
    expect(executed.match(/VALUES\s+\?sourceGraph/gi)).toHaveLength(2);
  });

  it('rejects a default-graph pattern even when authorized VALUES makes graph injection redundant', async () => {
    const vm = `${GRAPH}/_verifiable_memory/0xagent/guard-order-default`;
    await store.insert([
      q('urn:guard:default', 'http://schema.org/name', '"guard"', vm),
    ]);

    await expect(engine.query(
      `SELECT ?sourceGraph ?name ?description WHERE {
        VALUES ?sourceGraph { <${vm}> }
        GRAPH ?sourceGraph { ?s <http://schema.org/name> ?name }
        ?s <http://schema.org/description> ?description
      }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).rejects.toThrow(
      /Scoped query violation: GRAPH variables cannot be mixed with default-graph triple patterns/i,
    );
  });

  it('rejects nested GRAPH use even when authorized VALUES makes graph injection redundant', async () => {
    const vm = `${GRAPH}/_verifiable_memory/0xagent/guard-order-optional`;
    await store.insert([
      q('urn:guard:optional', 'http://schema.org/name', '"guard"', vm),
    ]);

    await expect(engine.query(
      `SELECT ?sourceGraph ?name ?description WHERE {
        VALUES ?sourceGraph { <${vm}> }
        GRAPH ?sourceGraph { ?s <http://schema.org/name> ?name }
        OPTIONAL {
          GRAPH ?sourceGraph { ?s <http://schema.org/description> ?description }
        }
      }`,
      { contextGraphId: CONTEXT_GRAPH },
    )).rejects.toThrow(
      /Scoped query violation: GRAPH variables must appear at the top level/i,
    );
  });

  it('rejects mixed GRAPH-variable and default-graph triple patterns', async () => {
    await expect(
      engine.query(
        `SELECT ?g ?name ?description WHERE {
          GRAPH ?g { ?s <http://schema.org/name> ?name }
          ?s <http://schema.org/description> ?description
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables cannot be mixed with default-graph triple patterns/i);
  });

  it('constrains GRAPH variables with non-ASCII names to the scoped context graph data graph', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { GRAPH ?é { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { name: '"ImageBot"' },
    ]);
  });

  it('constrains GRAPH variables to data and shared memory for includeSharedMemory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
      q('urn:other:ws', 'http://schema.org/name', '"OtherWorkspace"', 'did:dkg:context-graph:other-agent-registry/_shared_memory'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    expect(result.bindings.map((row) => row['name'])).toEqual(['"ImageBot"', '"Workspace Only"']);
    expect(result.bindings.map((row) => row['g']).sort()).toEqual([GRAPH, sharedMemoryGraph].sort());
  });

  it('keeps legacy GRAPH-variable scans on the selected data graph without partition opt-in', async () => {
    const rootAssertionGraph = `${GRAPH}/assertion/0xAgent/root-draft`;
    const rootVerifiedGraph = `${GRAPH}/_verifiable_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory/0xAgent/2`;

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      q('urn:root:data', COUNT_NAME, '"RootData"', GRAPH),
      q('urn:root:wm', COUNT_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:vm', COUNT_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', COUNT_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', COUNT_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    // rc.17 uniform layout: published data now lives in per-KA
    // `…/_verifiable_memory/{author}/{number}` graphs, and the default
    // data-graph read read-boths them alongside the legacy root graph.
    // So a GRAPH-variable scan on the data route binds the root graph AND
    // the per-KA verifiable-memory partitions — but still NOT the working-
    // memory assertion graph, sub-graph data, or sub-graph SWM (those
    // require the explicit partition opt-in).
    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"RootData"' },
      { g: rootVerifiedGraph, name: '"RootVM"' },
    ]);
  });

  it('keeps includeSharedMemory GRAPH-variable scans on data plus SWM without partition opt-in', async () => {
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory/0xAgent/1`;
    const rootAssertionGraph = `${GRAPH}/assertion/0xAgent/root-draft`;
    const rootVerifiedGraph = `${GRAPH}/_verifiable_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory/0xAgent/2`;

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      q('urn:root:data', COUNT_NAME, '"RootData"', GRAPH),
      q('urn:root:swm', COUNT_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:wm', COUNT_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:vm', COUNT_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', COUNT_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', COUNT_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    // rc.17 uniform layout: the data route read-boths the per-KA
    // `…/_verifiable_memory/{author}/{number}` partitions, so the
    // includeSharedMemory scan now binds root data + root SWM + the
    // per-KA verifiable-memory partition — but still NOT the root working-
    // memory assertion graph, sub-graph data, or sub-graph SWM (those
    // require the explicit partition opt-in).
    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"RootData"' },
      { g: rootSharedMemoryGraph, name: '"RootSWM"' },
      { g: rootVerifiedGraph, name: '"RootVM"' },
    ]);
  });

  it('allows scoped GRAPH variable count scans across registered same-CG content partitions', async () => {
    const rootAssertionGraph = `${GRAPH}/_working_memory/0xAgent/1`;
    const rootAssertionNamedGraph = `${rootAssertionGraph}/_named_graph/ZGlkOmRrZzpjb250ZXh0LWdyYXBoOmFnZW50LXJlZ2lzdHJ5`;
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory/0xAgent/1`;
    const rootVerifiedGraph = `${GRAPH}/_verifiable_memory/vm-1`;
    const rootVerifiedStagingGraph = `${GRAPH}/_verifiable_memory/staging/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphAssertionGraph = `${GRAPH}/code/_working_memory/0xAgent/2`;
    const subGraphAssertionNamedGraph = `${subGraphAssertionGraph}/_named_graph/ZGlkOmRrZzpjb250ZXh0LWdyYXBoOmFnZW50LXJlZ2lzdHJ5L2NvZGU`;
    const unregisteredAssertionNamedGraph = `${GRAPH}/_working_memory/0xAgent/999/_named_graph/ZGlkOmRrZzpjb250ZXh0LWdyYXBoOmFnZW50LXJlZ2lzdHJ5`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory/0xAgent/2`;
    const subGraphVerifiedGraph = `${GRAPH}/code/_verifiable_memory/vm-1`;
    const subGraphVerifiedStagingGraph = `${GRAPH}/code/_verifiable_memory/staging/vm-1`;
    const subGraphMeta = `${GRAPH}/code/_meta`;
    const subGraphPrivate = `${GRAPH}/code/_private`;
    const otherGraph = 'did:dkg:context-graph:other-agent-registry/code/_shared_memory/0xOther/1';

    await store.insert([
      ...subGraphRegistration('code'),
      assertionGraphRegistration(rootAssertionGraph, 'root-draft'),
      assertionGraphRegistration(subGraphAssertionGraph, 'code-draft'),
      q('urn:root:wm', SCHEMA_NAME, '"RootWM"', rootAssertionGraph),
      q('urn:root:wm:named', SCHEMA_NAME, '"RootWMNamedGraph"', rootAssertionNamedGraph),
      q('urn:root:swm', SCHEMA_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:vm', SCHEMA_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:root:staging', SCHEMA_NAME, '"RootStaging"', rootVerifiedStagingGraph),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', subGraph),
      q('urn:code:wm', SCHEMA_NAME, '"CodeWM"', subGraphAssertionGraph),
      q('urn:code:wm:named', SCHEMA_NAME, '"CodeWMNamedGraph"', subGraphAssertionNamedGraph),
      q('urn:code:swm', SCHEMA_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
      q('urn:code:vm', SCHEMA_NAME, '"CodeVM"', subGraphVerifiedGraph),
      q('urn:code:staging', SCHEMA_NAME, '"CodeStaging"', subGraphVerifiedStagingGraph),
      q('urn:code:meta', SCHEMA_NAME, '"CodeMeta"', subGraphMeta),
      q('urn:code:private', SCHEMA_NAME, '"CodePrivate"', subGraphPrivate),
      q('urn:unregistered:wm:named', SCHEMA_NAME, '"UnregisteredWMNamedGraph"', unregisteredAssertionNamedGraph),
      q('urn:other:swm', SCHEMA_NAME, '"OtherSWM"', otherGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g (COUNT(DISTINCT ?s) AS ?entities) (COUNT(*) AS ?triples)
       WHERE { GRAPH ?g { ?s ?p ?o } }
       GROUP BY ?g`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    const graphs = new Set(result.bindings.map((row) => row['g']));

    for (const expected of [
      GRAPH,
      META,
      rootAssertionGraph,
      rootAssertionNamedGraph,
      rootSharedMemoryGraph,
      rootVerifiedGraph,
      subGraph,
      subGraphAssertionGraph,
      subGraphAssertionNamedGraph,
      subGraphSharedMemoryGraph,
      subGraphVerifiedGraph,
    ]) {
      expect(graphs.has(expected)).toBe(true);
    }
    expect(graphs.has(rootVerifiedStagingGraph)).toBe(false);
    expect(graphs.has(subGraphVerifiedStagingGraph)).toBe(false);
    expect(graphs.has(subGraphMeta)).toBe(false);
    expect(graphs.has(subGraphPrivate)).toBe(false);
    expect(graphs.has(unregisteredAssertionNamedGraph)).toBe(false);
    expect(graphs.has(otherGraph)).toBe(false);
  });

  it('memoizes same-CG partition discovery across concurrent count scans', async () => {
    const rootSharedMemoryGraph = `${GRAPH}/_shared_memory/0xAgent/1`;
    const rootVerifiedGraph = `${GRAPH}/_verifiable_memory/vm-1`;
    const subGraph = `${GRAPH}/code`;
    const subGraphSharedMemoryGraph = `${GRAPH}/code/_shared_memory/0xAgent/2`;

    await store.insert([
      ...subGraphRegistration('code'),
      q('urn:root:swm', SCHEMA_NAME, '"RootSWM"', rootSharedMemoryGraph),
      q('urn:root:vm', SCHEMA_NAME, '"RootVM"', rootVerifiedGraph),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', subGraph),
      q('urn:code:swm', SCHEMA_NAME, '"CodeSWM"', subGraphSharedMemoryGraph),
    ]);

    // rc.17 uniform layout adds unmemoized per-KA prefix discoveries
    // (`…/_verifiable_memory/…` read-both) that also hit `store.listGraphs`,
    // so a raw `listGraphs` recorder no longer isolates partition discovery.
    // Wrap the memoized partition-discovery routine directly — that is
    // what the in-flight cache de-dupes across concurrent scans.
    const discoveryTarget = engine as unknown as {
      discoverScopedContentGraphAllowList: (...args: unknown[]) => Promise<string[]>;
    };
    const origDiscovery = discoveryTarget.discoverScopedContentGraphAllowList.bind(engine);
    const partitionDiscoverySpy = recorder((...a: unknown[]) => origDiscovery(...a));
    discoveryTarget.discoverScopedContentGraphAllowList = partitionDiscoverySpy;
    const sparql = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`;

    const results = await Promise.all([
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
      engine.query(sparql, { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true }),
    ]);

    expect(partitionDiscoverySpy.calls).toHaveLength(1);
    for (const result of results) {
      const graphs = new Set(result.bindings.map((row) => row['g']));
      expect(graphs.has(rootSharedMemoryGraph)).toBe(true);
      expect(graphs.has(rootVerifiedGraph)).toBe(true);
      expect(graphs.has(subGraph)).toBe(true);
      expect(graphs.has(subGraphSharedMemoryGraph)).toBe(true);
    }
  });

  it('does not reuse partition discovery after an in-flight count scan completes', async () => {
    const codeSubGraph = `${GRAPH}/code`;
    const docsSubGraph = `${GRAPH}/docs`;

    await store.insert([
      ...subGraphRegistration('code'),
      q('urn:code:data', SCHEMA_NAME, '"CodeData"', codeSubGraph),
    ]);

    // rc.17 uniform layout adds unmemoized per-KA prefix discoveries that
    // also call `store.listGraphs`, so spy on the memoized partition-
    // discovery routine directly to pin "discovered once per completed
    // scan, re-discovered after the in-flight promise settles".
    const discoveryTarget = engine as unknown as {
      discoverScopedContentGraphAllowList: (...args: unknown[]) => Promise<string[]>;
    };
    const origDiscovery = discoveryTarget.discoverScopedContentGraphAllowList.bind(engine);
    const partitionDiscoverySpy = recorder((...a: unknown[]) => origDiscovery(...a));
    discoveryTarget.discoverScopedContentGraphAllowList = partitionDiscoverySpy;
    const sparql = `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`;
    const first = await engine.query(
      sparql,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    expect(first.bindings.some((row) => row['g'] === codeSubGraph)).toBe(true);
    expect(partitionDiscoverySpy.calls).toHaveLength(1);

    await store.insert([
      ...subGraphRegistration('docs'),
      q('urn:docs:data', SCHEMA_NAME, '"DocsData"', docsSubGraph),
    ]);

    const second = await engine.query(
      sparql,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    expect(partitionDiscoverySpy.calls).toHaveLength(2);
    expect(second.bindings.some((row) => row['g'] === docsSubGraph)).toBe(true);
  });

  it('does not bind same-prefix child context graphs as parent content partitions', async () => {
    const collidingSubGraph = `${GRAPH}/code`;
    const collidingSubGraphSharedMemory = `${collidingSubGraph}/_shared_memory`;
    const collidingSubGraphVerified = `${collidingSubGraph}/_verifiable_memory/vm-1`;
    const collidingSubGraphMeta = `${collidingSubGraph}/_meta`;
    const collidingRootSharedMemory = `${GRAPH}/_shared_memory`;
    const collidingRootSharedMemoryMeta = `${collidingRootSharedMemory}/_meta`;
    const collidingRootVerified = `${GRAPH}/_verifiable_memory/vm-1`;
    const collidingRootVerifiedMeta = `${collidingRootVerified}/_meta`;

    await store.insert([
      ...subGraphRegistration('code'),
      q(collidingSubGraph, RDF_TYPE, DKG_CONTEXT_GRAPH, collidingSubGraphMeta),
      q(collidingRootSharedMemory, DKG_REGISTRATION_STATUS, '"unregistered"', collidingRootSharedMemoryMeta),
      q(collidingRootVerified, DKG_REGISTRATION_STATUS, '"unregistered"', collidingRootVerifiedMeta),
      q('urn:child:code', SCHEMA_NAME, '"ChildCodeRoot"', collidingSubGraph),
      q('urn:child:code-swm', SCHEMA_NAME, '"ChildCodeSharedMemory"', collidingSubGraphSharedMemory),
      q('urn:child:code-vm', SCHEMA_NAME, '"ChildCodeVerified"', collidingSubGraphVerified),
      q('urn:child:swm', SCHEMA_NAME, '"ChildSharedMemoryRoot"', collidingRootSharedMemory),
      q('urn:child:vm', SCHEMA_NAME, '"ChildVerifiedRoot"', collidingRootVerified),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );
    const names = new Set(result.bindings.map((row) => row['name']));

    // Same-prefix CHILD context graphs and sub-graph-shaped partitions of a
    // sibling/child CG must NOT be bound as the parent's content partitions.
    expect(names.has('"ChildCodeRoot"')).toBe(false);
    expect(names.has('"ChildCodeSharedMemory"')).toBe(false);
    expect(names.has('"ChildCodeVerified"')).toBe(false);
    expect(names.has('"ChildSharedMemoryRoot"')).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraph)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraphSharedMemory)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingSubGraphVerified)).toBe(false);
    expect(result.bindings.some((row) => row['g'] === collidingRootSharedMemory)).toBe(false);

    // rc.17 uniform layout: `<cg>/_verifiable_memory/{…}` is, by definition,
    // the parent CG's own per-KA verifiable-memory partition — the default
    // data-graph read read-boths it regardless of any `registrationStatus`
    // marker in its `_meta`. It is therefore legitimately bound here (it is
    // NOT a colliding child CG), so it is expected to surface.
    expect(names.has('"ChildVerifiedRoot"')).toBe(true);
    expect(result.bindings.some((row) => row['g'] === collidingRootVerified)).toBe(true);
  });

  it('does not let non-canonical child-CG type triples hide registered parent partitions', async () => {
    const subGraph = `${GRAPH}/code`;

    await store.insert([
      ...subGraphRegistration('code'),
      // User data can mention `dkg:ContextGraph`; only the candidate's own
      // `/_meta` graph may prove a child context graph during count scans.
      q(subGraph, RDF_TYPE, DKG_CONTEXT_GRAPH, GRAPH),
      q('urn:code:data', COUNT_NAME, '"ParentCode"', subGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${COUNT_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );

    expect(result.bindings).toEqual([
      { g: subGraph, name: '"ParentCode"' },
    ]);
  });

  it('does not treat unregistered same-prefix child graphs as same-CG sub-graph content', async () => {
    const unregisteredSubGraph = `${GRAPH}/code`;
    await store.insert([
      q('urn:child:entity', SCHEMA_NAME, '"UnregisteredPrefixChild"', unregisteredSubGraph),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name WHERE { GRAPH ?g { ?s <${SCHEMA_NAME}> ?name } } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH, includeContextGraphPartitions: true },
    );

    expect(result.bindings.some((row) => row['g'] === unregisteredSubGraph)).toBe(false);
    expect(result.bindings.some((row) => row['name'] === '"UnregisteredPrefixChild"')).toBe(false);
  });

  it('constrains GRAPH variables to shared memory when graphSuffix is _shared_memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
      q('urn:other:ws', 'http://schema.org/name', '"OtherWorkspace"', 'did:dkg:context-graph:other-agent-registry/_shared_memory'),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );

    expect(result.bindings).toEqual([
      { g: sharedMemoryGraph, name: '"Workspace Only"' },
    ]);
  });

  it('constrains GRAPH variables to the requested legacy sub-graph and shared memory graph', async () => {
    const subGraphName = 'team-a';
    const subGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}`;
    const subGraphSharedMemory = `did:dkg:context-graph:${CONTEXT_GRAPH}/${subGraphName}/_shared_memory`;
    await store.insert([
      q('urn:team:entity', 'http://schema.org/name', '"Team Data"', subGraph),
      q('urn:team:ws', 'http://schema.org/name', '"Team Workspace"', subGraphSharedMemory),
      q('urn:other-team:entity', 'http://schema.org/name', '"Other Team"', `did:dkg:context-graph:${CONTEXT_GRAPH}/team-b`),
      q('urn:other-team:ws', 'http://schema.org/name', '"Other Team Workspace"', `did:dkg:context-graph:${CONTEXT_GRAPH}/team-b/_shared_memory`),
    ]);

    const result = await engine.query(
      'SELECT ?g ?name WHERE { GRAPH ?g { ?s <http://schema.org/name> ?name } } ORDER BY ?name',
      { contextGraphId: CONTEXT_GRAPH, subGraphName, includeSharedMemory: true },
    );

    expect(result.bindings.map((row) => row['name'])).toEqual(['"Team Data"', '"Team Workspace"']);
    expect(result.bindings.map((row) => row['g']).sort()).toEqual([subGraph, subGraphSharedMemory].sort());
  });

  it('constrains outer shorthand GRAPH variables after a nested SELECT WHERE', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    const result = await engine.query(
      `SELECT ?g ?name {
        {
          SELECT ?x WHERE {
            BIND("keep" AS ?x)
          }
        }
        GRAPH ?g { ?s <http://schema.org/name> ?name }
      } ORDER BY ?name`,
      { contextGraphId: CONTEXT_GRAPH },
    );

    expect(result.bindings).toEqual([
      { g: GRAPH, name: '"ImageBot"' },
    ]);
  });

  it('rejects nested subqueries that would keep GRAPH variables outside the scoped binding', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE {
          {
            SELECT ?name WHERE {
              GRAPH ?g { ?s <http://schema.org/name> ?name }
            }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables inside nested SELECT subqueries/i);
  });

  it('rejects nested GRAPH-variable subqueries even when comparison syntax appears before GRAPH', async () => {
    await store.insert([
      q('urn:other:entity', 'http://schema.org/name', '"OtherGraph"', 'did:dkg:context-graph:other-agent-registry'),
    ]);

    await expect(
      engine.query(
        `SELECT ?name WHERE {
          {
            SELECT ?name WHERE {
              BIND(1 AS ?score)
              FILTER(?score < 10)
              GRAPH ?g { ?s <http://schema.org/name> ?name }
            }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables inside nested SELECT subqueries/i);
  });

  it('rejects optional GRAPH-variable patterns instead of changing OPTIONAL semantics', async () => {
    await expect(
      engine.query(
        `SELECT ?name ?g ?nickname WHERE {
          ?s <http://schema.org/name> ?name
          OPTIONAL {
            GRAPH ?g { ?s <http://schema.org/alternateName> ?nickname }
          }
        }`,
        { contextGraphId: CONTEXT_GRAPH },
      ),
    ).rejects.toThrow(/Scoped query violation: GRAPH variables must appear at the top level/i);
  });
});

describe('validateReadOnlySparql', () => {
  it('allows SELECT', () => {
    expect(validateReadOnlySparql('SELECT ?s WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows CONSTRUCT', () => {
    expect(validateReadOnlySparql('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows ASK', () => {
    expect(validateReadOnlySparql('ASK { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows DESCRIBE', () => {
    expect(validateReadOnlySparql('DESCRIBE <http://example.org/x>').safe).toBe(true);
  });

  it('rejects INSERT DATA', () => {
    const result = validateReadOnlySparql('INSERT DATA { <s> <p> <o> }');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('SELECT, CONSTRUCT, ASK, or DESCRIBE');
  });

  it('rejects DELETE WHERE', () => {
    const result = validateReadOnlySparql('DELETE WHERE { ?s ?p ?o }');
    expect(result.safe).toBe(false);
  });

  it('rejects CLEAR GRAPH', () => {
    const result = validateReadOnlySparql('CLEAR GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects DROP GRAPH', () => {
    const result = validateReadOnlySparql('DROP GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects LOAD', () => {
    const result = validateReadOnlySparql('LOAD <http://example.org/data>');
    expect(result.safe).toBe(false);
  });

  it('allows comments containing mutating keywords', () => {
    const result = validateReadOnlySparql(
      '# This query does not INSERT anything\nSELECT ?s WHERE { ?s ?p ?o }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(`
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?name WHERE { ?s <http://schema.org/name> ?name }
    `);
    expect(result.safe).toBe(true);
  });

  it('allows inline PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(
      'PREFIX schema: <http://schema.org/> SELECT ?s WHERE { ?s schema:name ?name }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows inline default PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(
      'PREFIX : <http://schema.org/> SELECT ?s WHERE { ?s :name ?name }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows multiple PREFIX declarations', () => {
    const result = validateReadOnlySparql(`
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX schema: <http://schema.org/>
      SELECT ?s WHERE { ?s rdf:type schema:Person }
    `);
    expect(result.safe).toBe(true);
  });

  it.each([
    ['variable', 'SELECT ?delete WHERE { ?s ?p ?delete }'],
    ['prefix label', 'PREFIX insert: <urn:x:> SELECT ?s WHERE { ?s insert:p ?o }'],
    ['prefixed local name', 'PREFIX ex: <urn:x:> SELECT ?s WHERE { ?s ex:drop ?o }'],
    ['language tag', 'SELECT ?s WHERE { ?s <urn:p> "value"@add }'],
  ])('allows update words used as a legal %s', (_name, sparql) => {
    expect(validateReadOnlySparql(sparql).safe).toBe(true);
  });

  it('allows BASE declaration before SELECT', () => {
    const result = validateReadOnlySparql(`
      BASE <http://example.org/>
      SELECT ?s WHERE { ?s ?p ?o }
    `);
    expect(result.safe).toBe(true);
  });

  // #764 follow-up: the previous `[A-Za-z][A-Za-z0-9_-]*` label charset was
  // stricter than SPARQL's PN_PREFIX grammar and rejected valid read-only
  // queries whose PREFIX label contained a dot or non-ASCII characters.
  it('allows PREFIX labels containing dots (PN_PREFIX)', () => {
    const result = validateReadOnlySparql(
      'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> SELECT ?s WHERE { ?s foaf.core:name ?n }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows PREFIX labels containing non-ASCII characters', () => {
    const result = validateReadOnlySparql(
      'PREFIX naïve: <http://example.org/> SELECT ?s WHERE { ?s naïve:p ?o }',
    );
    expect(result.safe).toBe(true);
  });

  it('still rejects mutations even with an exotic PREFIX label', () => {
    const result = validateReadOnlySparql(
      'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> INSERT DATA { <s> <p> <o> }',
    );
    expect(result.safe).toBe(false);
  });
});
