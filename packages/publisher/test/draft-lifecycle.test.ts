import { describe, it, expect, beforeEach } from 'vitest';
import { GraphManager, OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_GOSSIP_MAX_MESSAGE_BYTES,
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphAssertionUri,
  contextGraphDataUri,
  contextGraphMetaUri,
  contextGraphLayerUri,
  contextGraphPrivateUri,
  MemoryLayer,
  ASSERTION_SEAL_PREDICATES,
  assertionLifecycleUri,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  decodeWorkspacePublishRequest,
} from '@origintrail-official/dkg-core';
import {
  DKGPublisher,
  assertionScopedGraphUri,
  generatedPrivateCatalogFloorQuads,
  generatedPrivateCatalogTripleKeys,
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
} from '../src/index.js';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { finalizeRootlessAssertionForTest } from './_helpers/rootless-lifecycle.js';

const CG_ID = 'test-assertion-cg';
const SWM_GRAPH = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
const SWM_META_GRAPH = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
const ON_CHAIN_ID_PREDICATE = 'https://dkg.network/ontology#ContextGraphOnChainId';
const ACCESS_POLICY_PREDICATE = 'https://dkg.network/ontology#accessPolicy';
const ALLOWED_AGENT_PREDICATE = 'https://dkg.network/ontology#allowedAgent';
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const PEER = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PEER_B = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const PROMOTE_RECIPIENT_PEER = '12D3KooWDCuLesNUYHGEUY5ksEsfJGbShbZ9ep2Pu7uqCNGvgwnb';
const PROMOTE_CHANGED_PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';
const ASSERTION_NAME = 'my-assertion';
const SHARE_OPERATION_ID_PREDICATE = 'http://dkg.io/ontology/shareOperationId';
const PROMOTE_OPERATION_INTENT_PREDICATE = 'http://dkg.io/ontology/promoteOperationIntent';

const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/age', object: '"30"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

function largePayloadQuads(prefix: string, bytes: number): Quad[] {
  const chunkBytes = 16 * 1024;
  const quads: Quad[] = [];
  let remaining = bytes;
  let index = 0;
  while (remaining > 0) {
    const size = Math.min(chunkBytes, remaining);
    quads.push({
      subject: `urn:test:entity:${prefix}:${index}`,
      predicate: 'http://schema.org/description',
      object: `"${'x'.repeat(size)}"`,
      graph: '',
    });
    remaining -= size;
    index += 1;
  }
  return quads;
}

function onChainIdQuad(id = '1'): Quad {
  return {
    subject: contextGraphDataUri(CG_ID),
    predicate: ON_CHAIN_ID_PREDICATE,
    object: `"${id}"`,
    graph: ONTOLOGY_GRAPH,
  };
}

function localPrivateContextGraphQuad(): Quad {
  return {
    subject: contextGraphDataUri(CG_ID),
    predicate: ACCESS_POLICY_PREDICATE,
    object: '"private"',
    graph: contextGraphMetaUri(CG_ID),
  };
}

function agentsPublicContextGraphQuad(): Quad {
  return {
    subject: contextGraphDataUri(CG_ID),
    predicate: ACCESS_POLICY_PREDICATE,
    object: '"public"',
    graph: AGENTS_GRAPH,
  };
}

function localAllowedAgentQuad(): Quad {
  return {
    subject: contextGraphDataUri(CG_ID),
    predicate: ALLOWED_AGENT_PREDICATE,
    object: `"${AGENT}"`,
    graph: contextGraphMetaUri(CG_ID),
  };
}

describe('Working Memory Assertion Lifecycle', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  const createPublisher = async (
    writeLocks?: Map<string, Promise<void>>,
    publisherStore: OxigraphStore = store,
  ): Promise<DKGPublisher> => {
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    return new DKGPublisher({
      store: publisherStore,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      ...(writeLocks ? { writeLocks } : {}),
    });
  };

  const finalizeAssertion = (
    name = ASSERTION_NAME,
    agentAddress = AGENT,
    options: {
      contextGraphId?: string;
      subGraphName?: string;
      publisher?: DKGPublisher;
    } = {},
  ) => finalizeRootlessAssertionForTest({
    publisher: options.publisher ?? publisher,
    store,
    contextGraphId: options.contextGraphId ?? CG_ID,
    name,
    agentAddress,
    subGraphName: options.subGraphName,
  });

  const readShareOperationId = async (
    name = ASSERTION_NAME,
    agentAddress = AGENT,
  ): Promise<string | undefined> => {
    const lifecycle = assertionLifecycleUri(CG_ID, agentAddress, name);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const result = await store.query(
      `SELECT ?id WHERE { GRAPH <${metaGraph}> { ` +
        `<${lifecycle}> <${SHARE_OPERATION_ID_PREDICATE}> ?id } } LIMIT 1`,
    );
    const object = result.type === 'bindings' ? result.bindings[0]?.['id'] : undefined;
    return object?.match(/^"(.*)"$/)?.[1] ?? object;
  };

  const hasPromoteOperationIntent = async (): Promise<boolean> => {
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const result = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${lifecycle}> <${PROMOTE_OPERATION_INTENT_PREDICATE}> ?intent } }`,
    );
    return result.type === 'boolean' && result.value;
  };

  const withInjectedOperationSnapshotFailure = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const insert = store.insert.bind(store);
    let injected = false;
    store.insert = async (quads) => {
      if (
        !injected
        && quads.some((quad) =>
          quad.graph.includes('/_shared_memory_snapshots/') && quad.graph.endsWith('/ka'))
      ) {
        injected = true;
        throw new Error('injected operation snapshot failure');
      }
      return insert(quads);
    };
    try {
      return await operation();
    } finally {
      store.insert = insert;
      if (!injected) throw new Error('operation snapshot failure injection was not reached');
    }
  };

  beforeEach(async () => {
    store = new OxigraphStore();
    publisher = await createPublisher();
  });

  it('uses one canonical write-lock domain per store', async () => {
    const isolatedStore = new OxigraphStore();
    const suppliedLocks = new Map<string, Promise<void>>();
    const configuredPublisher = await createPublisher(suppliedLocks, isolatedStore);
    const defaultPublisher = await createPublisher(undefined, isolatedStore);

    expect(configuredPublisher.writeLocks).toBe(suppliedLocks);
    expect(defaultPublisher.writeLocks).toBe(suppliedLocks);
    await expect(
      createPublisher(new Map<string, Promise<void>>(), isolatedStore),
    ).rejects.toThrow('must share the same writeLocks map');
  });

  it('create returns the correct assertion graph URI', async () => {
    const uri = await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    expect(uri).toBe(contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME));
  });

  it('D1: create stamps kaId + reservedUal on the URN when given an allocate callback', async () => {
    const name = 'd1-mint';
    const ual = `did:dkg:31337/${AGENT.toLowerCase()}/42`;
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: async () => ({ number: 42n, reservedUal: ual }),
    });
    const metaGraph = contextGraphMetaUri(CG_ID);
    const urn = assertionLifecycleUri(CG_ID, AGENT, name);
    const kaId = await store.query(`SELECT ?n WHERE { GRAPH <${metaGraph}> { <${urn}> <http://dkg.io/ontology/kaId> ?n } }`);
    expect(kaId.type).toBe('bindings');
    if (kaId.type === 'bindings') {
      expect(kaId.bindings.map((r) => r['n'])).toEqual(['"42"^^<http://www.w3.org/2001/XMLSchema#integer>']);
    }
    const ru = await store.query(`SELECT ?u WHERE { GRAPH <${metaGraph}> { <${urn}> <http://dkg.io/ontology/reservedUal> ?u } }`);
    if (ru.type === 'bindings') {
      expect(ru.bindings.map((r) => r['u'])).toEqual([`"${ual}"`]);
    }
  });

  it('D1: re-create does NOT re-allocate — the preserved kaId is reused (re-open guard)', async () => {
    const name = 'd1-reopen';
    const ual42 = `did:dkg:31337/${AGENT.toLowerCase()}/42`;
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: async () => ({ number: 42n, reservedUal: ual42 }),
    });
    // Re-create with a callback that WOULD allocate a different number — it must NOT be invoked,
    // because the draft already carries a preserved kaId (the re-open guard lives in assertionCreate).
    let called = false;
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: async () => {
        called = true;
        return { number: 99n, reservedUal: `did:dkg:31337/${AGENT.toLowerCase()}/99` };
      },
    });
    expect(called).toBe(false);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const urn = assertionLifecycleUri(CG_ID, AGENT, name);
    const kaId = await store.query(`SELECT ?n WHERE { GRAPH <${metaGraph}> { <${urn}> <http://dkg.io/ontology/kaId> ?n } }`);
    if (kaId.type === 'bindings') {
      expect(kaId.bindings.map((r) => r['n'])).toEqual(['"42"^^<http://www.w3.org/2001/XMLSchema#integer>']);
    }
  });

  it('WM flip: a numbered KA stores + reads WM data in the per-KA _working_memory graph', async () => {
    const name = 'wm-numbered';
    await publisher.assertionCreate(CG_ID, name, AGENT, undefined, {
      allocateKaNumber: async () => ({ number: 42n, reservedUal: `did:dkg:31337/${AGENT.toLowerCase()}/42` }),
    });
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:x', predicate: 'http://schema.org/name', object: '"X"' },
    ]);
    // data must live in the per-KA WM graph keyed by {number}, NOT the legacy name-keyed graph
    const wmGraph = contextGraphLayerUri(CG_ID, MemoryLayer.WorkingMemory, AGENT, 42n);
    const res = await store.query(`SELECT ?o WHERE { GRAPH <${wmGraph}> { <urn:test:entity:x> <http://schema.org/name> ?o } }`);
    expect(res.type).toBe('bindings');
    if (res.type === 'bindings') expect(res.bindings.map((r) => r['o'])).toEqual(['"X"']);
    // the legacy name-keyed graph must be empty (no data leaked to the old layout)
    const legacy = contextGraphAssertionUri(CG_ID, AGENT, name);
    const legacyRes = await store.query(`SELECT ?o WHERE { GRAPH <${legacy}> { <urn:test:entity:x> ?p ?o } }`);
    if (legacyRes.type === 'bindings') expect(legacyRes.bindings).toHaveLength(0);
    // assertionQuery (which resolves the number internally) returns the data
    const q = await publisher.assertionQuery(CG_ID, name, AGENT);
    expect(q.length).toBeGreaterThan(0);
  });

  it('write inserts triples into the assertion graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:alice')).toBe(true);
    expect(subjects.has('urn:test:entity:bob')).toBe(true);
  });

  it('preserves named graph metadata for mixed default/named graph writes', async () => {
    const name = 'mixed-graph-draft';
    const namedGraph = 'urn:test:graph:named';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      {
        subject: 'urn:test:entity:default',
        predicate: 'http://schema.org/name',
        object: '"Default Graph"',
        graph: '',
      },
      {
        subject: 'urn:test:entity:named',
        predicate: 'http://schema.org/name',
        object: '"Named Graph"',
        graph: namedGraph,
      },
    ]);

    const quads = await publisher.assertionQuery(CG_ID, name, AGENT);
    expect(quads).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'urn:test:entity:default',
        object: '"Default Graph"',
        graph: '',
      }),
      expect.objectContaining({
        subject: 'urn:test:entity:named',
        object: '"Named Graph"',
        graph: namedGraph,
      }),
    ]));

    const scopedNamedGraphs = (await store.listGraphs())
      .filter((graph) => graph.includes('/_named_graph/'));
    expect(scopedNamedGraphs.length).toBeGreaterThan(0);
  });

  it('rejects named-graph shares before duplicate SPOs can be flattened', async () => {
    const name = 'named-graph-share-unsupported';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      {
        subject: 'urn:test:entity:duplicate-spo',
        predicate: 'http://schema.org/name',
        object: '"Same"',
        graph: 'urn:test:graph:one',
      },
      {
        subject: 'urn:test:entity:duplicate-spo',
        predicate: 'http://schema.org/name',
        object: '"Same"',
        graph: 'urn:test:graph:two',
      },
    ]);

    const beforeShare = await publisher.assertionQuery(CG_ID, name, AGENT);
    expect(beforeShare).toEqual(expect.arrayContaining([
      expect.objectContaining({ graph: 'urn:test:graph:one' }),
      expect.objectContaining({ graph: 'urn:test:graph:two' }),
    ]));
    await expect(finalizeAssertion(name)).rejects.toMatchObject({
      code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
      namedGraphs: ['urn:test:graph:one', 'urn:test:graph:two'],
    });

    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toHaveLength(2);
    const swmResult = await store.query(
      `ASK { GRAPH <${SWM_GRAPH}> { <urn:test:entity:duplicate-spo> <http://schema.org/name> "Same" } }`,
    );
    expect(swmResult.type === 'boolean' ? swmResult.value : true).toBe(false);
  });

  it('treats DKG physical graph input as default-graph assertion content', async () => {
    const name = 'physical-graph-default';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      {
        subject: 'urn:test:entity:physical-default',
        predicate: 'http://schema.org/name',
        object: '"Physical Default"',
        graph: `did:dkg:context-graph:${CG_ID}`,
      },
    ]);

    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({
        subject: 'urn:test:entity:physical-default',
        graph: '',
      }),
    ]);
    await finalizeAssertion(name);
    const promoted = await publisher.assertionPromote(CG_ID, name, AGENT);
    expect(promoted.promotedCount).toBe(1);
  });

  it('preserves non-physical DKG context graph DIDs as named graph identity', async () => {
    const name = 'dkg-did-named-graph';
    const namedGraph = 'did:dkg:context-graph:partner-catalog';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      {
        subject: 'urn:test:entity:dkg-did-named',
        predicate: 'http://schema.org/name',
        object: '"DKG DID Named Graph"',
        graph: namedGraph,
      },
    ]);

    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({
        subject: 'urn:test:entity:dkg-did-named',
        graph: namedGraph,
      }),
    ]);
    await expect(finalizeAssertion(name)).rejects.toMatchObject({
      code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
      namedGraphs: [namedGraph],
    });
  });

  it('rejects private named-graph writes before leaving draft residue', async () => {
    const name = 'private-named-graph';
    await publisher.assertionCreate(CG_ID, name, AGENT);

    await expect(
      publisher.assertionWritePrivate(CG_ID, name, AGENT, [{
        subject: 'urn:test:entity:private',
        predicate: 'http://schema.org/name',
        object: '"Private"',
        graph: 'urn:test:graph:private',
      }]),
    ).rejects.toMatchObject({
      code: 'KA_NAMED_GRAPH_SHARE_UNSUPPORTED',
      namedGraphs: ['urn:test:graph:private'],
    });
    expect(await publisher.assertionQueryPrivate(CG_ID, name, AGENT)).toEqual([]);

    await publisher.assertionWritePrivate(CG_ID, name, AGENT, [{
      subject: 'urn:test:entity:private',
      predicate: 'http://schema.org/name',
      object: '"Private"',
      graph: '',
    }]);
    expect(await publisher.assertionQueryPrivate(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:entity:private', graph: '' }),
    ]);
  });

  it('discard removes KA-scoped named graph draft content', async () => {
    const name = 'named-graph-discard';
    const namedGraph = 'urn:test:graph:discard-only';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      {
        subject: 'urn:test:entity:named-discard',
        predicate: 'http://schema.org/name',
        object: '"Discard Me"',
        graph: namedGraph,
      },
    ]);

    const wmGraph = await publisher.wmGraphUri(CG_ID, AGENT, name);
    const scopedNamedGraph = assertionScopedGraphUri(wmGraph, namedGraph);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual([
      expect.objectContaining({
        subject: 'urn:test:entity:named-discard',
        graph: namedGraph,
      }),
    ]);
    expect(await store.listGraphs()).toContain(scopedNamedGraph);

    await publisher.assertionDiscard(CG_ID, name, AGENT);

    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toHaveLength(0);
    expect(await store.listGraphs()).not.toContain(scopedNamedGraph);
  });

  it('query returns triples from the assertion only', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    // Write something to a different assertion — should not appear
    await publisher.assertionCreate(CG_ID, 'other-assertion', AGENT);
    await publisher.assertionWrite(CG_ID, 'other-assertion', AGENT, [
      { subject: 'urn:test:entity:charlie', predicate: 'http://schema.org/name', object: '"Charlie"' },
    ]);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:charlie')).toBe(false);
  });

  it('promote moves all triples to SWM and empties assertion', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const finalized = await finalizeAssertion();
    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('full promote drops a fully consumed blank-node WM graph instead of shape-deleting it', async () => {
    const name = 'full-blank-node-promote';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:root', predicate: 'urn:test:contains', object: '_:item' },
      { subject: '_:item', predicate: 'http://schema.org/name', object: '"Item"' },
      { subject: '_:item', predicate: 'urn:test:child', object: '_:child' },
      { subject: '_:child', predicate: 'http://schema.org/name', object: '"Child"' },
    ]);

    const finalized = await finalizeAssertion(name);
    const wmGraph = finalized.graphUri;
    const dropped: string[] = [];
    const wmShapeDeletes: Quad[][] = [];
    const realDropGraph = store.dropGraph.bind(store);
    const realDelete = store.delete.bind(store);
    store.dropGraph = async (graph) => {
      dropped.push(graph);
      return realDropGraph(graph);
    };
    store.delete = async (quads) => {
      if (quads.some((quad) => quad.graph === wmGraph)) wmShapeDeletes.push(quads);
      return realDelete(quads);
    };

    const result = await publisher.assertionPromote(CG_ID, name, AGENT);

    expect(result.promotedCount).toBe(4);
    expect(dropped).toContain(wmGraph);
    expect(wmShapeDeletes).toHaveLength(0);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toHaveLength(0);
  });

  it('finalize excludes reserved WM bookkeeping so full promote drops the exact KA graph', async () => {
    const name = 'reserved-row-promote';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:root', predicate: 'http://schema.org/name', object: '"Root"' },
    ]);

    const sourceWmGraph = contextGraphAssertionUri(CG_ID, AGENT, name);
    // The import-file handler writes `urn:dkg:file:` / `urn:dkg:extraction:`
    // descriptor + provenance rows straight into the mutable WM assertion
    // graph. Rootless finalization filters them before sealing and relocates
    // only the exact user RDF set into the canonical UAL-derived WM graph.
    await store.insert([{
      subject: 'urn:dkg:file:report-descriptor',
      predicate: 'http://schema.org/name',
      object: '"report.pdf"',
      graph: sourceWmGraph,
    }]);

    const finalized = await finalizeAssertion(name);
    const wmGraph = finalized.graphUri;
    expect(finalized.publicQuads.map((quad) => quad.subject))
      .not.toContain('urn:dkg:file:report-descriptor');
    expect(await store.hasGraph(sourceWmGraph)).toBe(false);

    const dropped: string[] = [];
    const wmShapeDeletes: Quad[][] = [];
    const realDropGraph = store.dropGraph.bind(store);
    const realDelete = store.delete.bind(store);
    store.dropGraph = async (graph) => {
      dropped.push(graph);
      return realDropGraph(graph);
    };
    store.delete = async (quads) => {
      if (quads.some((quad) => quad.graph === wmGraph)) wmShapeDeletes.push(quads);
      return realDelete(quads);
    };

    await publisher.assertionPromote(CG_ID, name, AGENT);

    expect(dropped).toContain(wmGraph);
    expect(wmShapeDeletes).toHaveLength(0);
    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toHaveLength(0);
  });

  it('promote retains trusted generated private-CG catalog floor in the exact sealed SWM graph', async () => {
    const name = 'private-catalog-promote';
    const cgDid = contextGraphDataUri(CG_ID);
    const catalogFloor = generatedPrivateCatalogFloorQuads(CG_ID);
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...catalogFloor,
    ]);
    await store.insert([onChainIdQuad('1')]);
    (publisher as any).chain.getContextGraphAccessPolicy = async () => 1;
    (publisher as any).chain.getContextGraphNameHash = async () => ethers.keccak256(ethers.toUtf8Bytes(CG_ID));

    const finalized = await finalizeAssertion(name);
    const result = await publisher.assertionPromote(CG_ID, name, AGENT, {
      publisherPeerId: PEER,
      trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
      onChainContextGraphId: '1',
    });

    expect(result.promotedCount).toBe(1 + catalogFloor.length);
    const swmCatalog = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { <${cgDid}> ?p ?o } }`,
    );
    expect(swmCatalog.type).toBe('bindings');
    if (swmCatalog.type === 'bindings') expect(swmCatalog.bindings).toHaveLength(catalogFloor.length);

    const remaining = await publisher.assertionQuery(CG_ID, name, AGENT);
    expect(remaining).toHaveLength(0);
  });

  it('returns the encryption-time recipient projection for promotion fan-out', async () => {
    const name = 'promotion-recipient-snapshot';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [{
      subject: 'urn:test:promotion-snapshot',
      predicate: 'http://schema.org/name',
      object: '"Snapshot"',
    }]);
    await finalizeAssertion(name);

    let advertisedPeer = PROMOTE_RECIPIENT_PEER;
    let resolverCalls = 0;
    publisher.setWorkspaceAgentRecipientResolver(async () => {
      resolverCalls += 1;
      return {
        requiresEncryption: true,
        recipients: [{ agentAddress: AGENT, peerId: advertisedPeer }] as any,
      };
    });
    publisher.setWorkspaceSenderKeyEncryptor(async (input) => {
      expect(input.resolution.recipients[0]?.peerId).toBe(PROMOTE_RECIPIENT_PEER);
      advertisedPeer = PROMOTE_CHANGED_PEER;
      return input.plaintext;
    });

    const result = await publisher.assertionPromote(CG_ID, name, AGENT, {
      publisherPeerId: PEER,
      senderAgentAddress: AGENT,
    });

    expect(resolverCalls).toBe(1);
    expect(result.gossipPayload).toEqual({
      mode: 'agent-encrypted',
      message: expect.any(Uint8Array),
      fanoutSnapshot: {
      source: 'agent-roster',
      members: [PROMOTE_RECIPIENT_PEER],
      complete: true,
      },
    });
    expect(result.gossipMessage).toBe(result.gossipPayload?.message);
  });

  it('rejects generated private-CG catalog floor stripping without private CG proof', async () => {
    const name = 'private-catalog-promote-reject';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...generatedPrivateCatalogFloorQuads(CG_ID),
    ]);
    await finalizeAssertion(name);

    await expect(
      publisher.assertionPromote(CG_ID, name, AGENT, {
        publisherPeerId: PEER,
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('promote retains finalized private-CG catalog floor for local private CGs before first registration', async () => {
    const name = 'private-catalog-promote-local-private';
    const cgDid = contextGraphDataUri(CG_ID);
    const catalogFloor = generatedPrivateCatalogFloorQuads(CG_ID);
    await store.insert([localPrivateContextGraphQuad()]);
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...catalogFloor,
    ]);

    const finalized = await finalizeAssertion(name);
    const result = await publisher.assertionPromote(CG_ID, name, AGENT, {
      publisherPeerId: PEER,
      trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
    });

    expect(result.promotedCount).toBe(1 + catalogFloor.length);
    const swmCatalog = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { <${cgDid}> ?p ?o } }`,
    );
    expect(swmCatalog.type).toBe('bindings');
    if (swmCatalog.type === 'bindings') expect(swmCatalog.bindings).toHaveLength(catalogFloor.length);
  });

  it('rejects generated private-CG catalog floor stripping with a borrowed private on-chain id', async () => {
    const name = 'private-catalog-promote-borrowed-id';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...generatedPrivateCatalogFloorQuads(CG_ID),
    ]);
    await store.insert([onChainIdQuad('2')]);
    (publisher as any).chain.getContextGraphAccessPolicy = async () => 1;
    (publisher as any).chain.getContextGraphNameHash = async () => null;
    await finalizeAssertion(name);

    await expect(
      publisher.assertionPromote(CG_ID, name, AGENT, {
        publisherPeerId: PEER,
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
        onChainContextGraphId: '1',
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects local private-CG catalog floor stripping when a stored on-chain id is public', async () => {
    const name = 'private-catalog-promote-stale-local-policy';
    await store.insert([localPrivateContextGraphQuad(), onChainIdQuad('1')]);
    (publisher as any).chain.getContextGraphAccessPolicy = async () => 0;
    (publisher as any).chain.getContextGraphNameHash = async () => ethers.keccak256(ethers.toUtf8Bytes(CG_ID));
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...generatedPrivateCatalogFloorQuads(CG_ID),
    ]);
    await finalizeAssertion(name);

    await expect(
      publisher.assertionPromote(CG_ID, name, AGENT, {
        publisherPeerId: PEER,
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('rejects local catalog floor stripping when agents graph declares the CG public', async () => {
    const name = 'private-catalog-promote-agents-public';
    await store.insert([agentsPublicContextGraphQuad(), localAllowedAgentQuad()]);
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:catalog-content', predicate: 'http://schema.org/name', object: '"Content"' },
      ...generatedPrivateCatalogFloorQuads(CG_ID),
    ]);
    await finalizeAssertion(name);

    await expect(
      publisher.assertionPromote(CG_ID, name, AGENT, {
        publisherPeerId: PEER,
        trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(CG_ID),
      }),
    ).rejects.toThrow(/trustedNonManifestCatalogTriples is only allowed/);
  });

  it('blocks an unsealed empty draft even when legacy extraction metadata claims content', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);

    // Simulate the post-import-file state: extraction metadata landed in
    // `_meta`, but the structural triples never made it into the data
    // graph (the rc.12 bug reported in #864). The metaQuads mirror what
    // `packages/cli/src/daemon/routes/assertion.ts` writes on a
    // successful import-file with text/markdown content.
    const graphUri = contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await store.insert([
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/extractionStatus',
        object: '"completed"',
        graph: metaGraph,
      },
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/structuralTripleCount',
        object: '"49"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      },
    ]);

    await expect(publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT)).rejects.toMatchObject({
      code: 'UNSEALED_SHARE_BLOCKED',
    });
  });

  it('blocks an unsealed empty draft when no extraction metadata exists', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);

    await expect(publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT)).rejects.toMatchObject({
      code: 'UNSEALED_SHARE_BLOCKED',
    });
  });

  // Codex review on #898 — `assertionPromote` empties the assertion
  // data graph but intentionally leaves daemon-owned `urn:dkg:file:*`
  // / `urn:dkg:extraction:*` quads behind, AND keeps the
  // `extractionStatus="completed"` + positive `structuralTripleCount`
  // markers in `_meta` for audit purposes. Without the lifecycle gate
  // (`dkg:memoryLayer "WM"`), a retry / stale double-click after a
  // successful promote was misclassified as ASSERTION_NOT_PERSISTED.
  // The lifecycle marker is flipped to "SWM" by `assertionPromote`, so
  // the second promote must short-circuit cleanly to a no-op.
  it('promote is idempotent only while the already-shared exact graph still matches its seal', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    // Stamp the post-import-file extraction markers that
    // `assertionPromote` deliberately preserves. After the success run
    // the data graph is empty + lifecycle is "SWM", but these two
    // markers stick around in `_meta`.
    const graphUri = contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await store.insert([
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/extractionStatus',
        object: '"completed"',
        graph: metaGraph,
      },
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/structuralTripleCount',
        object: `"${TRIPLES.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        graph: metaGraph,
      },
    ]);

    const finalized = await finalizeAssertion();
    const first = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER });
    expect(first.promotedCount).toBeGreaterThan(0);

    // Stale second click — must be a harmless no-op, not an error.
    const second = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER });
    expect(second.promotedCount).toBe(0);
    expect(second.shareOperationId).toBe(first.shareOperationId);
    expect(second.gossipPayload?.message).toBeInstanceOf(Uint8Array);
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(true);

    await store.insert([{
      subject: 'urn:test:tampered',
      predicate: 'http://schema.org/name',
      object: '"Tampered"',
      graph: finalized.sharedGraphUri,
    }]);
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).rejects.toThrow(/triple-count mismatch/);
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
  });

  it('validates the exact VM graph before treating a stale promote as a no-op', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER });

    const vmGraph = knowledgeAssetLayerGraphUri(
      CG_ID,
      MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(finalized.kaUal, finalized.assertionVersion),
    );
    await store.insert(finalized.publicQuads.map((quad) => ({ ...quad, graph: vmGraph })));
    await store.dropGraph(finalized.sharedGraphUri);
    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    const memoryLayerPredicate = 'http://dkg.io/ontology/memoryLayer';
    await store.deleteByPattern({ graph: metaGraph, subject: lifecycle, predicate: memoryLayerPredicate });
    await store.insert([{
      subject: lifecycle,
      predicate: memoryLayerPredicate,
      object: `"${MemoryLayer.VerifiableMemory}"`,
      graph: metaGraph,
    }]);

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).resolves.toMatchObject({ promotedCount: 0, promotedAllRoots: false });

    await store.delete([{ ...finalized.publicQuads[0]!, graph: vmGraph }]);
    await store.insert([{
      subject: 'urn:test:tampered-vm',
      predicate: 'http://schema.org/name',
      object: '"Tampered"',
      graph: vmGraph,
    }]);
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).rejects.toThrow(/Merkle mismatch/);
  });

  it('persists the share operation ID before curator confirmation can escape locally', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();

    let confirmedOperationId: string | undefined;
    const replaceGraph = store.replaceGraph.bind(store);
    let crashedAfterConfirmation = false;
    store.replaceGraph = async (graph, quads) => {
      if (!crashedAfterConfirmation && graph === finalized.sharedGraphUri) {
        crashedAfterConfirmation = true;
        throw new Error('injected post-confirmation local crash');
      }
      return replaceGraph(graph, quads);
    };
    try {
      await expect(
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
          publisherPeerId: PEER,
          confirmBeforeCommit: async () => {
            confirmedOperationId = await readShareOperationId();
            return { applied: true };
          },
        }),
      ).rejects.toThrow('injected post-confirmation local crash');
    } finally {
      store.replaceGraph = replaceGraph;
    }

    expect(crashedAfterConfirmation).toBe(true);
    expect(confirmedOperationId).toBeTruthy();
    expect(await readShareOperationId()).toBe(confirmedOperationId);
    const repaired = await publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => ({ applied: true }),
      },
    );
    expect(repaired.shareOperationId).toBe(confirmedOperationId);
  });

  it('serializes concurrent promotes onto one durable share operation ID', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let confirmationCalls = 0;
    let activeConfirmations = 0;
    let maxActiveConfirmations = 0;
    let releaseFirstConfirmation!: () => void;
    const firstConfirmationReleased = new Promise<void>((resolve) => {
      releaseFirstConfirmation = resolve;
    });
    let signalFirstConfirmation!: () => void;
    const firstConfirmationStarted = new Promise<void>((resolve) => {
      signalFirstConfirmation = resolve;
    });
    const confirmBeforeCommit = async (): Promise<{ applied: boolean }> => {
      confirmationCalls += 1;
      const call = confirmationCalls;
      activeConfirmations += 1;
      maxActiveConfirmations = Math.max(maxActiveConfirmations, activeConfirmations);
      if (call === 1) {
        signalFirstConfirmation();
        await firstConfirmationReleased;
      }
      activeConfirmations -= 1;
      return { applied: true };
    };

    const firstPromote = publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER,
      confirmBeforeCommit,
    });
    await firstConfirmationStarted;
    const secondOptions: NonNullable<Parameters<DKGPublisher['assertionPromote']>[3]> = {
      publisherPeerId: PEER,
      confirmBeforeCommit,
    };
    const secondPromote = publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      secondOptions,
    );
    secondOptions.subGraphName = 'mutated-after-lock-selection';
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(confirmationCalls).toBe(1);
    releaseFirstConfirmation();
    const [first, second] = await Promise.all([firstPromote, secondPromote]);

    expect(maxActiveConfirmations).toBe(1);
    expect(confirmationCalls).toBe(2);
    expect(first.shareOperationId).toBeTruthy();
    expect(second.shareOperationId).toBe(first.shareOperationId);
    expect(await readShareOperationId()).toBe(first.shareOperationId);
  });

  it('rejects a draft write queued behind a completed promote', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let releaseConfirmation!: () => void;
    const confirmationReleased = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    let signalConfirmationStarted!: () => void;
    const confirmationStarted = new Promise<void>((resolve) => {
      signalConfirmationStarted = resolve;
    });
    const promote = publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER,
      confirmBeforeCommit: async () => {
        signalConfirmationStarted();
        await confirmationReleased;
        return { applied: true };
      },
    });
    await confirmationStarted;

    const lateQuad = {
      subject: 'urn:test:entity:late-draft',
      predicate: 'http://schema.org/name',
      object: '"Late draft"',
    };
    const write = publisher.assertionWrite(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      [lateQuad],
    );

    releaseConfirmation();
    await expect(promote).resolves.toMatchObject({ promotedCount: TRIPLES.length });
    await expect(write).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_REQUIRED' });
    expect(await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).toEqual([]);
  });

  it('serializes lifecycle mutations across publishers sharing one store', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    const otherPublisher = await createPublisher();

    let releaseConfirmation!: () => void;
    const confirmationReleased = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    let signalConfirmationStarted!: () => void;
    const confirmationStarted = new Promise<void>((resolve) => {
      signalConfirmationStarted = resolve;
    });
    const promote = publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER,
      confirmBeforeCommit: async () => {
        signalConfirmationStarted();
        await confirmationReleased;
        return { applied: true };
      },
    });
    await confirmationStarted;

    const write = otherPublisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, [{
      subject: 'urn:test:entity:cross-instance-late-write',
      predicate: 'http://schema.org/name',
      object: '"Cross-instance late write"',
    }]);
    releaseConfirmation();

    await expect(promote).resolves.toMatchObject({ promotedCount: TRIPLES.length });
    await expect(write).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_REQUIRED' });
    expect(await otherPublisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).toEqual([]);
  });

  it('freezes every destructive draft mutation while promote recovery is ambiguous', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => {
          expect(await publisher.hasSwmShareComplete(
            CG_ID,
            ASSERTION_NAME,
            AGENT,
          )).toBe(false);
          return { applied: false };
        },
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });
    const operationId = await readShareOperationId();
    expect(operationId).toBeTruthy();
    const sealSubject = contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME);
    const sealBefore = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${sealSubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root } }`,
    );
    expect(sealBefore).toEqual({ type: 'boolean', value: true });

    const expectedRecoveryError = { code: 'KA_PROMOTE_RECOVERY_REQUIRED' };
    await expect(
      publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, [TRIPLES[0]!]),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.assertionWritePrivate(CG_ID, ASSERTION_NAME, AGENT, [{ ...TRIPLES[0]!, graph: '' }]),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.assertionPullFrom(CG_ID, ASSERTION_NAME, AGENT, 'swm'),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.clearAssertionSeal(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject(expectedRecoveryError);
    await expect(
      publisher.clearWmDraftDataGraph(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject(expectedRecoveryError);

    expect(await readShareOperationId()).toBe(operationId);
    expect(await hasPromoteOperationIntent()).toBe(true);
    const remainingPublic = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(remainingPublic).toHaveLength(finalized.publicQuads.length);
    expect(remainingPublic).toEqual(
      expect.arrayContaining(finalized.publicQuads.map((quad) => expect.objectContaining(quad))),
    );
    expect(await publisher.assertionQueryPrivate(CG_ID, ASSERTION_NAME, AGENT)).toEqual([]);
    expect(await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${sealSubject}> <${ASSERTION_SEAL_PREDICATES.ASSERTION_MERKLE_ROOT}> ?root } }`,
    )).toEqual(sealBefore);
  });

  it('snapshots caller-owned private quads before waiting for the lifecycle lock', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let releaseConfirmation!: () => void;
    const confirmationReleased = new Promise<void>((resolve) => {
      releaseConfirmation = resolve;
    });
    let signalConfirmationStarted!: () => void;
    const confirmationStarted = new Promise<void>((resolve) => {
      signalConfirmationStarted = resolve;
    });
    const promote = publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER,
      confirmBeforeCommit: async () => {
        signalConfirmationStarted();
        await confirmationReleased;
        return { applied: false, rejected: true };
      },
    });
    await confirmationStarted;

    const input: Quad[] = [{
      subject: 'urn:test:private:stable',
      predicate: 'http://schema.org/name',
      object: '"Stable"',
      graph: '',
    }];
    const write = publisher.assertionWritePrivate(CG_ID, ASSERTION_NAME, AGENT, input);
    input[0]!.subject = 'urn:dkg:file:mutated-after-validation';
    input[0]!.graph = 'urn:test:named-after-validation';
    releaseConfirmation();

    await expect(promote).rejects.toMatchObject({ name: 'CuratorRejectedError' });
    await expect(write).resolves.toBeUndefined();
    expect(await publisher.assertionQueryPrivate(CG_ID, ASSERTION_NAME, AGENT)).toEqual([
      expect.objectContaining({ subject: 'urn:test:private:stable', graph: '' }),
    ]);
  });

  it('rejects curator confirmation without a publisher peer before claiming an ID', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let confirmationCalls = 0;
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        confirmBeforeCommit: async () => {
          confirmationCalls += 1;
          return { applied: true };
        },
      }),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_PUBLISHER_PEER_REQUIRED' });

    expect(confirmationCalls).toBe(0);
    expect(await readShareOperationId()).toBeUndefined();
    expect(await hasPromoteOperationIntent()).toBe(false);
    expect(await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).not.toHaveLength(0);
  });

  it('retires the prior completion marker before confirming a reopened draft', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER });
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(true);

    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, [{
      subject: 'urn:test:entity:new-version',
      predicate: 'http://schema.org/name',
      object: '"New version"',
    }]);
    await finalizeAssertion();
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => {
          expect(await publisher.hasSwmShareComplete(
            CG_ID,
            ASSERTION_NAME,
            AGENT,
          )).toBe(false);
          return { applied: false };
        },
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });

    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
    expect(await readShareOperationId()).toBeTruthy();
  });

  it('allows at most one cross-instance promote claim to reach confirmation', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    // Distinct store object identities model independent processes while both
    // proxies still delegate to the same backend. Same-store publisher objects
    // cannot silently split their lock domain (tested above).
    const independentStoreView = (): OxigraphStore => new Proxy(store, {
      get(target, property) {
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const firstClaimPublisher = await createPublisher(undefined, independentStoreView());
    const otherPublisher = await createPublisher(undefined, independentStoreView());

    const insert = store.insert.bind(store);
    const query = store.query.bind(store);
    let initialClaimReads = 0;
    let releaseInitialReads!: () => void;
    const bothInitialReadsFinished = new Promise<void>((resolve) => {
      releaseInitialReads = resolve;
    });
    let claimInsertions = 0;
    let releaseClaims!: () => void;
    const bothClaimsInserted = new Promise<void>((resolve) => {
      releaseClaims = resolve;
    });
    const shareOperationIdPredicateToken = `<${SHARE_OPERATION_ID_PREDICATE}>`;
    store.query = async (sparql) => {
      const result = await query(sparql);
      if (
        sparql.includes('SELECT ?shareOperationId')
        && sparql.split(/\s+/u).some((token) => token === shareOperationIdPredicateToken)
      ) {
        initialClaimReads += 1;
        if (initialClaimReads === 2) releaseInitialReads();
        await bothInitialReadsFinished;
      }
      return result;
    };
    store.insert = async (quads) => {
      const isPromoteClaim = quads.some((quad) => quad.predicate === SHARE_OPERATION_ID_PREDICATE)
        && quads.some((quad) => quad.predicate === PROMOTE_OPERATION_INTENT_PREDICATE);
      await insert(quads);
      if (isPromoteClaim) {
        claimInsertions += 1;
        if (claimInsertions === 2) releaseClaims();
        await bothClaimsInserted;
      }
    };
    let confirmationCalls = 0;
    try {
      const settled = await Promise.allSettled([
        firstClaimPublisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
          publisherPeerId: PEER,
          confirmBeforeCommit: async () => {
            confirmationCalls += 1;
            return { applied: true };
          },
        }),
        otherPublisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
          publisherPeerId: PEER_B,
          confirmBeforeCommit: async () => {
            confirmationCalls += 1;
            return { applied: true };
          },
        }),
      ]);
      expect(settled.filter((result) => result.status === 'fulfilled').length).toBeLessThanOrEqual(1);
      expect(settled.filter((result) => result.status === 'rejected').length).toBeGreaterThanOrEqual(1);
      for (const rejected of settled.filter((result) => result.status === 'rejected')) {
        expect(rejected).toMatchObject({ reason: { code: 'KA_SHARE_OPERATION_ID_CONFLICT' } });
      }
    } finally {
      store.insert = insert;
      store.query = query;
    }
    expect(confirmationCalls).toBeLessThanOrEqual(1);
    const ids = await store.query(
      `SELECT ?id WHERE { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME)}> ` +
        `<${SHARE_OPERATION_ID_PREDICATE}> ?id } } LIMIT 2`,
    );
    expect(ids.type === 'bindings' ? ids.bindings : []).toHaveLength(confirmationCalls);
    const intents = await store.query(
      `SELECT ?intent WHERE { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME)}> ` +
        `<${PROMOTE_OPERATION_INTENT_PREDICATE}> ?intent } } LIMIT 2`,
    );
    expect(intents.type === 'bindings' ? intents.bindings : []).toHaveLength(confirmationCalls);
  });

  it('keeps a completed legacy promotion readable without replaying it', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    const promoted = await publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    );
    expect(promoted.shareOperationId).toBeTruthy();
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(true);

    await store.deleteByPattern({
      graph: contextGraphMetaUri(CG_ID),
      subject: assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME),
      predicate: PROMOTE_OPERATION_INTENT_PREDICATE,
    });
    let confirmationCalls = 0;
    const retried = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER_B,
      confirmBeforeCommit: async () => {
        confirmationCalls += 1;
        return { applied: true };
      },
    });

    expect(retried).toMatchObject({
      promotedCount: 0,
      promotedAllRoots: false,
      shareOperationId: promoted.shareOperationId,
    });
    expect(retried.gossipPayload).toBeUndefined();
    expect(confirmationCalls).toBe(0);
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(true);
  });

  it('fails closed when a legacy durable operation ID has no immutable intent', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await expect(withInjectedOperationSnapshotFailure(() => publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    ))).rejects.toThrow('injected operation snapshot failure');

    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    await store.deleteByPattern({
      graph: contextGraphMetaUri(CG_ID),
      subject: lifecycle,
      predicate: PROMOTE_OPERATION_INTENT_PREDICATE,
    });
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_OPERATION_INTENT_MISSING' });
    expect(await readShareOperationId()).toBeTruthy();
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
  });

  it('clears a stale completion marker before rejecting corrupt recovery intent', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await expect(withInjectedOperationSnapshotFailure(() => publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    ))).rejects.toThrow('injected operation snapshot failure');

    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await publisher.markSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT);
    await store.deleteByPattern({
      graph: metaGraph,
      subject: lifecycle,
      predicate: PROMOTE_OPERATION_INTENT_PREDICATE,
    });
    await store.insert([{
      graph: metaGraph,
      subject: lifecycle,
      predicate: PROMOTE_OPERATION_INTENT_PREDICATE,
      object: '"not-json"',
    }]);

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_OPERATION_INTENT_CORRUPT' });
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
  });

  it('releases a provisional share operation ID after definitive curator rejection', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let rejectedOperationId: string | undefined;
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => {
          rejectedOperationId = await readShareOperationId();
          return { applied: false, rejected: true };
        },
      }),
    ).rejects.toMatchObject({ name: 'CuratorRejectedError' });

    expect(rejectedOperationId).toBeTruthy();
    expect(await readShareOperationId()).toBeUndefined();
    expect(await hasPromoteOperationIntent()).toBe(false);
    const retried = await publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    );
    expect(retried.shareOperationId).toBeTruthy();
    expect(retried.shareOperationId).not.toBe(rejectedOperationId);
  });

  it('retains a durable share operation ID when a later retry is rejected', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => ({ applied: false }),
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });
    const durableOperationId = await readShareOperationId();
    expect(durableOperationId).toBeTruthy();

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => ({ applied: false, rejected: true }),
      }),
    ).rejects.toMatchObject({ name: 'CuratorRejectedError' });
    expect(await readShareOperationId()).toBe(durableOperationId);

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_CONFIRMATION_REQUIRED' });
    const repaired = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      publisherPeerId: PEER,
      confirmBeforeCommit: async () => ({ applied: true }),
    });
    expect(repaired.shareOperationId).toBe(durableOperationId);
  });

  it('reuses the immutable promote envelope across ambiguous retries', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    let firstMessage: Uint8Array | undefined;
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        accessPolicy: 'allowList',
        allowedPeers: [PEER_B, PEER],
        confirmBeforeCommit: async (message) => {
          firstMessage = message;
          return { applied: false };
        },
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });

    let retryMessage: Uint8Array | undefined;
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER_B,
        accessPolicy: 'public',
        confirmBeforeCommit: async (message) => {
          retryMessage = message;
          return { applied: false };
        },
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });

    expect(firstMessage).toBeDefined();
    expect(retryMessage).toBeDefined();
    const first = decodeWorkspacePublishRequest(firstMessage!);
    const retry = decodeWorkspacePublishRequest(retryMessage!);
    expect(retry.shareOperationId).toBe(first.shareOperationId);
    expect(retry.operationId).toBe(first.operationId);
    expect(String(retry.timestampMs)).toBe(String(first.timestampMs));
    expect(retry.publisherPeerId).toBe(PEER);
    expect(retry.accessPolicy).toBe('allowList');
    expect(retry.allowedPeers).toEqual([PEER, PEER_B].sort());
  });

  it('fails closed when a lifecycle contains conflicting share operation IDs', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();

    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => ({ applied: false }),
      }),
    ).rejects.toMatchObject({ name: 'CuratorUnconfirmedError' });
    const firstOperationId = await readShareOperationId();
    expect(firstOperationId).toBeTruthy();

    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    await store.insert([{
      subject: lifecycle,
      predicate: SHARE_OPERATION_ID_PREDICATE,
      object: '"conflicting-operation-id"',
      graph: contextGraphMetaUri(CG_ID),
    }]);

    let confirmationCalled = false;
    await expect(
      publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
        publisherPeerId: PEER,
        confirmBeforeCommit: async () => {
          confirmationCalled = true;
          return { applied: true };
        },
      }),
    ).rejects.toMatchObject({ code: 'KA_SHARE_OPERATION_ID_CONFLICT' });
    expect(confirmationCalled).toBe(false);
    expect(await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).toHaveLength(TRIPLES.length);
    const swmExists = await store.query(
      `ASK { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`,
    );
    expect(swmExists).toEqual({ type: 'boolean', value: false });
    const ids = await store.query(
      `SELECT ?id WHERE { GRAPH <${contextGraphMetaUri(CG_ID)}> { ` +
        `<${lifecycle}> <${SHARE_OPERATION_ID_PREDICATE}> ?id } }`,
    );
    expect(ids.type === 'bindings' ? ids.bindings : []).toHaveLength(2);
  });

  it('clears an inherited completion marker before fallible SWM repair work', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    await expect(
      withInjectedOperationSnapshotFailure(() =>
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ),
    ).rejects.toThrow('injected operation snapshot failure');
    await publisher.markSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT);

    await expect(
      withInjectedOperationSnapshotFailure(() =>
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ),
    ).rejects.toThrow('injected operation snapshot failure');
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
  });

  it('preserves the durable share operation ID across an interrupted SWM repair', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();

    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const insert = store.insert.bind(store);
    await expect(
      withInjectedOperationSnapshotFailure(() =>
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ),
    ).rejects.toThrow('injected operation snapshot failure');
    const durableOperationId = await readShareOperationId();
    expect(durableOperationId).toBeTruthy();

    store.insert = async (quads) => {
      if (quads.some((quad) =>
        quad.subject === lifecycle && quad.predicate === SHARE_OPERATION_ID_PREDICATE)) {
        throw new Error('injected lifecycle repair failure');
      }
      return insert(quads);
    };
    try {
      await expect(
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ).rejects.toThrow('injected lifecycle repair failure');
    } finally {
      store.insert = insert;
    }
    expect(await readShareOperationId()).toBe(durableOperationId);

    const repaired = await publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    );
    expect(repaired.shareOperationId).toBe(durableOperationId);
  });

  it('repairs an interrupted exact-SWM commit before exposing the completion marker', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();

    await expect(
      withInjectedOperationSnapshotFailure(() =>
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ),
    ).rejects.toThrow('injected operation snapshot failure');

    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(false);
    expect(await store.hasGraph(finalized.sharedGraphUri)).toBe(true);

    // A marker written before the immutable snapshot/head tail is not proof of
    // completion. Destructive mutation must still force promote recovery.
    await publisher.markSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT);
    await expect(
      publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });

    const repaired = await publisher.assertionPromote(
      CG_ID,
      ASSERTION_NAME,
      AGENT,
      { publisherPeerId: PEER },
    );
    expect(repaired.promotedCount).toBe(0);
    expect(repaired.shareOperationId).toBeTruthy();
    expect(repaired.gossipPayload?.message).toBeInstanceOf(Uint8Array);
    expect(await publisher.hasSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT)).toBe(true);

    const graphManager = new GraphManager(store);
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CG_ID,
      shareOperationId: repaired.shareOperationId!,
      kaUal: finalized.kaUal,
      assertionVersion: finalized.assertionVersion,
    });
    expect(snapshot.quads).toHaveLength(finalized.publicQuads.length);
    const head = await resolveKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CG_ID,
      kaUal: finalized.kaUal,
    });
    expect(head?.shareOperationId).toBe(repaired.shareOperationId);
  });

  it('does not borrow another KA tail to release a corrupt recovery claim', async () => {
    const completedName = 'completed-tail-owner';
    await publisher.assertionCreate(CG_ID, completedName, AGENT);
    await publisher.assertionWrite(CG_ID, completedName, AGENT, [{
      subject: 'urn:test:entity:completed-tail-owner',
      predicate: 'http://schema.org/name',
      object: '"Completed tail owner"',
    }]);
    await finalizeAssertion(completedName);
    await publisher.assertionPromote(CG_ID, completedName, AGENT, { publisherPeerId: PEER });
    const completedOperationId = await readShareOperationId(completedName);
    expect(completedOperationId).toBeTruthy();

    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await expect(
      withInjectedOperationSnapshotFailure(() =>
        publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, { publisherPeerId: PEER }),
      ),
    ).rejects.toThrow('injected operation snapshot failure');

    const lifecycle = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await store.deleteByPattern({
      graph: metaGraph,
      subject: lifecycle,
      predicate: SHARE_OPERATION_ID_PREDICATE,
    });
    await store.insert([{
      graph: metaGraph,
      subject: lifecycle,
      predicate: SHARE_OPERATION_ID_PREDICATE,
      object: JSON.stringify(completedOperationId),
    }]);
    await publisher.markSwmShareComplete(CG_ID, ASSERTION_NAME, AGENT);

    await expect(
      publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject({ code: 'KA_PROMOTE_RECOVERY_REQUIRED' });
    expect(await readShareOperationId()).toBe(completedOperationId);
  });

  it('blocks an unsealed empty draft when legacy structuralTripleCount is zero', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const graphUri = contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME);
    const metaGraph = contextGraphMetaUri(CG_ID);
    await store.insert([
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/extractionStatus',
        object: '"completed"',
        graph: metaGraph,
      },
      {
        subject: graphUri,
        predicate: 'http://dkg.io/ontology/structuralTripleCount',
        object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>',
        graph: metaGraph,
      },
    ]);

    await expect(publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT)).rejects.toMatchObject({
      code: 'UNSEALED_SHARE_BLOCKED',
    });
  });

  it('keeps cross-author KAs with the same RDF subject isolated after publisher restart', async () => {
    const root = 'urn:test:entity:restart-owned';
    const firstAssertion = 'restart-owner-a';
    const secondAssertion = 'restart-owner-b';

    await publisher.assertionCreate(CG_ID, firstAssertion, AGENT);
    await publisher.assertionWrite(CG_ID, firstAssertion, AGENT, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Original"' },
    ]);
    const firstFinalized = await finalizeAssertion(firstAssertion);
    await publisher.assertionPromote(CG_ID, firstAssertion, AGENT, { publisherPeerId: PEER });

    const ownerBefore = await store.query(
      `SELECT ?creator WHERE { GRAPH <${SWM_META_GRAPH}> { <${root}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(ownerBefore.type).toBe('bindings');
    if (ownerBefore.type === 'bindings') {
      expect(ownerBefore.bindings).toHaveLength(0);
    }

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const restartedPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: new Map(),
    });

    await restartedPublisher.assertionCreate(CG_ID, secondAssertion, AGENT_B);
    await restartedPublisher.assertionWrite(CG_ID, secondAssertion, AGENT_B, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Overwritten"' },
    ]);
    const secondFinalized = await finalizeAssertion(secondAssertion, AGENT_B, {
      publisher: restartedPublisher,
    });
    const promoteResult = await restartedPublisher.assertionPromote(
      CG_ID,
      secondAssertion,
      AGENT_B,
      { publisherPeerId: PEER_B },
    );
    expect(promoteResult.promotedCount).toBe(1);

    const remaining = await restartedPublisher.assertionQuery(CG_ID, secondAssertion, AGENT_B);
    expect(remaining).toHaveLength(0);

    const firstSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${firstFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(firstSwm.type).toBe('bindings');
    if (firstSwm.type === 'bindings') {
      expect(firstSwm.bindings.map((row) => row['o'])).toEqual(['"Original"']);
    }
    const secondSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${secondFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(secondSwm.type).toBe('bindings');
    if (secondSwm.type === 'bindings') {
      expect(secondSwm.bindings.map((row) => row['o'])).toEqual(['"Overwritten"']);
    }

    const ownerAfter = await store.query(
      `SELECT ?creator WHERE { GRAPH <${SWM_META_GRAPH}> { <${root}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(ownerAfter.type).toBe('bindings');
    if (ownerAfter.type === 'bindings') {
      expect(ownerAfter.bindings).toHaveLength(0);
    }
  });

  it('does not use publisherPeerId as ownership for distinct graph-scoped KAs', async () => {
    const root = 'urn:test:entity:restart-owned-upsert';
    const firstAssertion = 'restart-owner-upsert-a';
    const secondAssertion = 'restart-owner-upsert-b';

    await publisher.assertionCreate(CG_ID, firstAssertion, AGENT);
    await publisher.assertionWrite(CG_ID, firstAssertion, AGENT, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Original"' },
    ]);
    const firstFinalized = await finalizeAssertion(firstAssertion);
    await publisher.assertionPromote(CG_ID, firstAssertion, AGENT, { publisherPeerId: PEER });

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const restartedPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: new Map(),
    });

    await restartedPublisher.assertionCreate(CG_ID, secondAssertion, AGENT_B);
    await restartedPublisher.assertionWrite(CG_ID, secondAssertion, AGENT_B, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Updated"' },
    ]);
    const secondFinalized = await finalizeAssertion(secondAssertion, AGENT_B, {
      publisher: restartedPublisher,
    });

    const result = await restartedPublisher.assertionPromote(CG_ID, secondAssertion, AGENT_B, {
      publisherPeerId: PEER,
    });
    expect(result.promotedCount).toBe(1);

    const remaining = await restartedPublisher.assertionQuery(CG_ID, secondAssertion, AGENT_B);
    expect(remaining).toHaveLength(0);

    const firstSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${firstFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(firstSwm.type).toBe('bindings');
    if (firstSwm.type === 'bindings') {
      expect(firstSwm.bindings.map((row) => row['o'])).toEqual(['"Original"']);
    }
    const secondSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${secondFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(secondSwm.type).toBe('bindings');
    if (secondSwm.type === 'bindings') {
      expect(secondSwm.bindings.map((row) => row['o'])).toEqual(['"Updated"']);
    }

    const ownerAfter = await store.query(
      `SELECT ?creator WHERE { GRAPH <${SWM_META_GRAPH}> { <${root}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(ownerAfter.type).toBe('bindings');
    if (ownerAfter.type === 'bindings') {
      expect(ownerAfter.bindings).toHaveLength(0);
    }
  });

  it('ignores legacy per-root ownership conflicts during graph-scoped promote', async () => {
    const root = 'urn:test:entity:restart-owned-conflict';
    const firstAssertion = 'restart-owner-conflict-a';
    const secondAssertion = 'restart-owner-conflict-b';
    const conflictOperation = 'urn:dkg:share:test-assertion-cg:restart-owner-conflict';

    await publisher.assertionCreate(CG_ID, firstAssertion, AGENT);
    await publisher.assertionWrite(CG_ID, firstAssertion, AGENT, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Original"' },
    ]);
    const firstFinalized = await finalizeAssertion(firstAssertion);
    await publisher.assertionPromote(CG_ID, firstAssertion, AGENT, { publisherPeerId: PEER });

    await store.insert([
      {
        subject: root,
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: `"${PEER}"`,
        graph: SWM_META_GRAPH,
      },
      {
        subject: root,
        predicate: 'http://dkg.io/ontology/workspaceOwner',
        object: `"${PEER_B}"`,
        graph: SWM_META_GRAPH,
      },
      {
        subject: conflictOperation,
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: root,
        graph: SWM_META_GRAPH,
      },
      {
        subject: conflictOperation,
        predicate: 'http://www.w3.org/ns/prov#wasAttributedTo',
        object: `"${PEER_B}"`,
        graph: SWM_META_GRAPH,
      },
    ]);

    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    const restartedPublisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
      sharedMemoryOwnedEntities: new Map(),
    });

    await restartedPublisher.assertionCreate(CG_ID, secondAssertion, AGENT_B);
    await restartedPublisher.assertionWrite(CG_ID, secondAssertion, AGENT_B, [
      { subject: root, predicate: 'http://schema.org/name', object: '"Effective owner update"' },
    ]);
    const secondFinalized = await finalizeAssertion(secondAssertion, AGENT_B, {
      publisher: restartedPublisher,
    });

    const result = await restartedPublisher.assertionPromote(CG_ID, secondAssertion, AGENT_B, {
      publisherPeerId: PEER,
    });
    expect(result.promotedCount).toBe(1);

    const firstSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${firstFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(firstSwm.type).toBe('bindings');
    if (firstSwm.type === 'bindings') {
      expect(firstSwm.bindings.map((row) => row['o'])).toEqual(['"Original"']);
    }
    const secondSwm = await store.query(
      `SELECT ?o WHERE { GRAPH <${secondFinalized.sharedGraphUri}> { <${root}> <http://schema.org/name> ?o } }`,
    );
    expect(secondSwm.type).toBe('bindings');
    if (secondSwm.type === 'bindings') {
      expect(secondSwm.bindings.map((row) => row['o'])).toEqual(['"Effective owner update"']);
    }
    const legacyOwners = await store.query(
      `SELECT ?creator WHERE { GRAPH <${SWM_META_GRAPH}> { <${root}> <http://dkg.io/ontology/workspaceOwner> ?creator } }`,
    );
    expect(legacyOwners.type).toBe('bindings');
    if (legacyOwners.type === 'bindings') {
      expect(new Set(legacyOwners.bindings.map((row) => row['creator'])))
        .toEqual(new Set([`"${PEER}"`, `"${PEER_B}"`]));
    }
  });

  it('promote accepts a payload above the old 512 KB cap and below 4 MiB', async () => {
    await publisher.assertionCreate(CG_ID, 'large-promote', AGENT);
    const quads = largePayloadQuads('large-promote', 2 * 1024 * 1024);
    await publisher.assertionWrite(CG_ID, 'large-promote', AGENT, quads);
    await finalizeAssertion('large-promote');

    const result = await publisher.assertionPromote(CG_ID, 'large-promote', AGENT, {
      publisherPeerId: PEER,
    });

    expect(result.promotedCount).toBe(quads.length);
    expect(result.gossipPayload?.message).toBeInstanceOf(Uint8Array);
    expect(result.gossipPayload!.message.length).toBeGreaterThan(512 * 1024);
    expect(result.gossipPayload!.message.length).toBeLessThan(DKG_GOSSIP_MAX_MESSAGE_BYTES);
  });

  it('promote rejects payloads above 4 MiB before mutating WM or SWM', async () => {
    await publisher.assertionCreate(CG_ID, 'too-large-promote', AGENT);
    const quads = largePayloadQuads('too-large-promote', DKG_GOSSIP_MAX_MESSAGE_BYTES + 1024 * 1024);
    await publisher.assertionWrite(CG_ID, 'too-large-promote', AGENT, quads);
    const finalized = await finalizeAssertion('too-large-promote');

    await expect(
      publisher.assertionPromote(CG_ID, 'too-large-promote', AGENT, { publisherPeerId: PEER }),
    ).rejects.toThrow(/Promoted assertion too large for gossip.*4\s*MB/i);

    const assertionQuads = await publisher.assertionQuery(CG_ID, 'too-large-promote', AGENT);
    expect(assertionQuads.length).toBe(quads.length);

    const swmResult = await store.query(
      `SELECT ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { <urn:test:entity:too-large-promote:0> <http://schema.org/description> ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(0);
    }
  });

  it('rejects entity-filtered sharing because a graph-scoped KA is atomic', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    await expect(publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      entities: ['urn:test:entity:alice'],
    })).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    const remaining = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(remaining).toHaveLength(TRIPLES.length);

    const swmResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const swmSubjects = new Set(swmResult.bindings.map((b) => b['s']));
      expect(swmSubjects.has('urn:test:entity:alice')).toBe(false);
      expect(swmSubjects.has('urn:test:entity:bob')).toBe(false);
    }
  });

  it('rejects entity-filtered sharing before touching mixed default/named-graph drafts', async () => {
    const name = 'subset-default-with-local-named-graph';
    const localNamedGraph = 'urn:test:graph:local-only';
    await publisher.assertionCreate(CG_ID, name, AGENT);
    await publisher.assertionWrite(CG_ID, name, AGENT, [
      { subject: 'urn:test:entity:selected', predicate: 'http://schema.org/name', object: '"Selected"' },
      {
        subject: 'urn:test:entity:local-only',
        predicate: 'http://schema.org/name',
        object: '"Local Only"',
        graph: localNamedGraph,
      },
    ]);

    await expect(publisher.assertionPromote(CG_ID, name, AGENT, {
      entities: ['urn:test:entity:selected'],
    })).rejects.toMatchObject({ code: 'KA_ATOMIC_SHARE_REQUIRED' });

    expect(await publisher.assertionQuery(CG_ID, name, AGENT)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subject: 'urn:test:entity:selected',
        graph: '',
      }),
      expect.objectContaining({
        subject: 'urn:test:entity:local-only',
        graph: localNamedGraph,
      }),
    ]));

    const swmResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const swmSubjects = new Set(swmResult.bindings.map((b) => b['s']));
      expect(swmSubjects.has('urn:test:entity:selected')).toBe(false);
      expect(swmSubjects.has('urn:test:entity:local-only')).toBe(false);
    }
  });

  it('discard drops the assertion graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(0);
  });

  it('different agents have isolated assertion graphs', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT_B);

    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, [
      { subject: 'urn:test:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
    ]);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT_B, [
      { subject: 'urn:test:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    ]);

    const agentAQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(agentAQuads.length).toBe(1);
    expect(agentAQuads[0].subject).toBe('urn:test:alice');

    const agentBQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT_B);
    expect(agentBQuads.length).toBe(1);
    expect(agentBQuads[0].subject).toBe('urn:test:bob');
  });

  it('blocks promote on an unsealed empty assertion', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await expect(publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT)).rejects.toMatchObject({
      code: 'UNSEALED_SHARE_BLOCKED',
    });
  });

  it('RFC ka-metadata-trim P3.4: promote writes NO ShareTransition record', async () => {
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const result = await store.query(
      `SELECT ?s ?type WHERE {
        GRAPH <${SWM_META}> {
          ?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ?type .
        }
      }`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      const shareTransitions = result.bindings.filter(
        (b) => b['type'] === 'http://dkg.io/ontology/ShareTransition',
      );
      // Dropped (RFC ka-metadata-trim P3.4): the node-ui receipt hook now
      // reads the seal-subject receipt rows directly; ShareTransition rows
      // only exist on stores written by older nodes (read-both fallback).
      expect(shareTransitions.length).toBe(0);
    }
  });

  it('GH #748 migration: rewrites peer-ID literal wasAttributedTo → agent DID URI when AGENTS lookup hits, leaves miss as-is, backfills dkg:publisherPeerId on legacy per-root snapshots, skips marked CGs on re-run', async () => {
    // Canonical AGENTS graph URI — `did:dkg:context-graph:agents` (no /_data
    // suffix) per `contextGraphDataGraphUri('agents')` in @origintrail-official/dkg-core.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    // GH #748 Codex round 3: AGENTS registry uses the spec-aligned
    // `https://dkg.network/ontology#` namespace (same as `buildAgentProfile`
    // in agent/profile.ts), not the internal `http://dkg.io/ontology/` one
    // used by SWM meta predicates.
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';

    // Seed AGENTS registry: one peer with a known agent address, one without.
    const PEER_KNOWN = '12D3KooWKnownPeer';
    const PEER_UNKNOWN = '12D3KooWUnknownPeer';
    // Lowercased per `canonicalAgentDidSubject` — matches what
    // `buildAgentProfile` writes when registering an agent.
    const ADDR_KNOWN = '0xaf7e932f79263f1a303790bd6c01b096f5334bbb';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR_KNOWN}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_KNOWN}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_KNOWN}"`, graph: AGENTS_GRAPH },
    ]);

    // Seed SWM meta with three legacy rows that mirror real shapes:
    //   - WorkspaceOperation (resolvable peer) — already has both
    //     `dkg:publisherPeerId` and `prov:wasAttributedTo` (the new field
    //     should NOT be re-inserted by the backfill).
    //   - WorkspaceOperation (unresolved peer) — same two fields.
    //   - Per-root snapshot (resolvable peer) — only `prov:wasAttributedTo`
    //     literal, NO `dkg:publisherPeerId`. The migration must materialise
    //     the peer-ID field from the literal before rewriting.
    const OP_KNOWN = `urn:dkg:share:${CG_ID}:op-known`;
    const OP_UNKNOWN = `urn:dkg:share:${CG_ID}:op-unknown`;
    const SNAPSHOT_LEGACY = `urn:dkg:share:${CG_ID}:op-known:snapshot/urn:test:root`;
    await store.insert([
      { subject: OP_KNOWN, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP_KNOWN, predicate: `${DKG}publisherPeerId`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
      { subject: OP_KNOWN, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: `${DKG}publisherPeerId`, object: `"${PEER_UNKNOWN}"`, graph: SWM_META },
      { subject: OP_UNKNOWN, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_UNKNOWN}"`, graph: SWM_META },
      // Legacy per-root snapshot row — wasAttributedTo only, no dkg:publisherPeerId
      { subject: SNAPSHOT_LEGACY, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_KNOWN}"`, graph: SWM_META },
    ]);
    // Ensure the CG itself appears in `listContextGraphs` so the migration
    // visits its meta graph (the bare `_meta` graph plus any data is enough).
    await store.insert([
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    // First pass: rewrite resolvable rows (OP_KNOWN + SNAPSHOT_LEGACY = 2),
    // leave the unresolved one, drop a marker.
    const r1 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r1.rewritten).toBe(2);
    expect(r1.skipped).toBe(1);

    const rowsAfter = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_META}> { ?s <${PROV}wasAttributedTo> ?o } }`,
    );
    expect(rowsAfter.type).toBe('bindings');
    if (rowsAfter.type === 'bindings') {
      const known = rowsAfter.bindings.find((b) => b['s'] === OP_KNOWN);
      const unknown = rowsAfter.bindings.find((b) => b['s'] === OP_UNKNOWN);
      const snapshot = rowsAfter.bindings.find((b) => b['s'] === SNAPSHOT_LEGACY);
      // Resolvable rows → URI form (no surrounding quotes).
      expect(known!['o']).toBe(`did:dkg:agent:${ADDR_KNOWN}`);
      expect(snapshot!['o']).toBe(`did:dkg:agent:${ADDR_KNOWN}`);
      // Unresolved peer → still a literal.
      expect(unknown!['o']).toBe(`"${PEER_UNKNOWN}"`);
    }

    // Backward-compat backfill: SNAPSHOT_LEGACY had no `dkg:publisherPeerId`
    // before the migration. After migration, it MUST carry the peer-ID
    // literal materialised from the old `wasAttributedTo` value, so the
    // post-fix readers (which now query `dkg:publisherPeerId`) still find it.
    const peerIdAfter = await store.query(
      `SELECT ?s ?o WHERE { GRAPH <${SWM_META}> { ?s <${DKG}publisherPeerId> ?o } }`,
    );
    expect(peerIdAfter.type).toBe('bindings');
    if (peerIdAfter.type === 'bindings') {
      const snapshotPid = peerIdAfter.bindings.find((b) => b['s'] === SNAPSHOT_LEGACY);
      expect(snapshotPid).toBeDefined();
      expect(snapshotPid!['o']).toBe(`"${PEER_KNOWN}"`);
      // OP_KNOWN already had a dkg:publisherPeerId — the migration must NOT
      // have duplicated it.
      const opKnownPids = peerIdAfter.bindings.filter((b) => b['s'] === OP_KNOWN);
      expect(opKnownPids.length).toBe(1);
    }

    // Codex round 2 Finding 6: marker is NOT written when cgSkipped > 0 (one
    // unresolved row remained). Future boots must retry as AGENTS data syncs.
    const markerAfter = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    expect(markerAfter.type).toBe('bindings');
    if (markerAfter.type === 'bindings') expect(markerAfter.bindings.length).toBe(0);

    // Second pass with no AGENTS changes: nothing new to resolve, marker
    // still not written, no churn — the literal-only filter eliminates the
    // already-rewritten URI rows so we only retry the genuine unresolved one.
    const r2 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r2.rewritten).toBe(0);
    expect(r2.skipped).toBe(1);

    // Add the previously-missing AGENTS record for the unresolved peer.
    const ADDR_LATE = '0xba7e932f79263f1a303790bd6c01b096f5334bba';
    await store.insert([
      { subject: `did:dkg:agent:${ADDR_LATE}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_LATE}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_UNKNOWN}"`, graph: AGENTS_GRAPH },
    ]);
    // Third pass: the previously-unresolved row now resolves, and since
    // cgSkipped reaches 0 the marker finally gets written.
    const r3 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r3.rewritten).toBe(1);
    expect(r3.skipped).toBe(0);
    const markerFinal = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    if (markerFinal.type === 'bindings') expect(markerFinal.bindings.length).toBe(1);

    // Fourth pass: marker present → fast-path skip; no SPARQL work.
    const r4 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r4.rewritten).toBe(0);
    expect(r4.skipped).toBe(0);
  });

  it('GH #748 user-reported: stale literal duplicates from a broken previous pass are cleaned up despite marker present', async () => {
    // Regression: round-1 → round-6 `store.delete([{ object: literalString }])`
    // silently no-op'd against `xsd:string`-typed literals on a persistent
    // store. The URI insert succeeded, leaving BOTH forms behind. The
    // user's daemon ended up with 52 literals + 52 URIs after a single
    // migration pass, with the marker set so subsequent boots wouldn't
    // self-heal.
    //
    // This test seeds that exact end state — marker present + both literal
    // AND URI form `wasAttributedTo` on the same subject — and asserts the
    // next migration pass overrides the marker, deletes the literal via
    // `deleteByPattern`, and writes a fresh marker.
    const CG_META_LOCAL = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META_LOCAL = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';
    const PEER = '12D3KooWStaleLiteralPeer';
    const ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER}"`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}agentAddress`, object: `"${ADDR}"`, graph: AGENTS_GRAPH },
    ]);

    // Seed inconsistent state: WorkspaceOperation with BOTH literal and URI
    // form `wasAttributedTo`, marker present from the broken previous pass.
    const OP = `urn:dkg:share:${CG_ID}:op-stale-dup`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META_LOCAL },
      { subject: OP, predicate: `${DKG}publisherPeerId`, object: `"${PEER}"`, graph: SWM_META_LOCAL },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `"${PEER}"`, graph: SWM_META_LOCAL },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `did:dkg:agent:${ADDR}`, graph: SWM_META_LOCAL },
      { subject: 'urn:dkg:migration:swm-attr-agent-did', predicate: `${DKG}appliedAt`, object: `"2026-05-26T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>`, graph: CG_META_LOCAL },
    ]);

    const r = await publisher.migrateSwmAttributionToAgentDid();
    expect(r.rewritten).toBeGreaterThanOrEqual(1);

    // After cleanup, exactly ONE wasAttributedTo (the URI form) remains.
    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_META_LOCAL}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe(`did:dkg:agent:${ADDR}`);
    }

    // Marker still present, refreshed with a new timestamp (we deleted the
    // stale one before re-running). Just assert presence.
    const marker = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META_LOCAL}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    if (marker.type === 'bindings') expect(marker.bindings.length).toBe(1);
  });

  it('GH #748 Codex round 6: curated CG (<addr>/<slug> form) is migrated, not silently skipped', async () => {
    // Regression for a user-reported bug: the previous version iterated
    // `graphManager.listContextGraphs()`, which filters out IDs containing
    // a slash — silently skipping every curated `<addr>/<slug>` CG (the
    // ones a user is NOT the curator of). The migration now enumerates
    // `_shared_memory_meta` graphs directly so both bare-slug and curated
    // CGs are processed.
    const CURATOR = '0xE5B88968Ed464F4e3f5354C54DFAB9e39dfEAfBd';
    const CURATED_CG = `${CURATOR}/tuesday-cg-curated`;
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CURATED_META = `did:dkg:context-graph:${CURATED_CG}/_meta`;
    const CURATED_SWM_META = `did:dkg:context-graph:${CURATED_CG}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';
    const PEER = '12D3KooWCuratedAgent';
    const ADDR = '0xc7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER}"`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}agentAddress`, object: `"${ADDR}"`, graph: AGENTS_GRAPH },
    ]);

    // Seed a SWM op in the curated CG with the legacy literal shape.
    const OP = `urn:dkg:share:${CURATED_CG}:op-curated`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: CURATED_SWM_META },
      { subject: OP, predicate: `${DKG}publisherPeerId`, object: `"${PEER}"`, graph: CURATED_SWM_META },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `"${PEER}"`, graph: CURATED_SWM_META },
      // No CG existence triple — the migration must find the SWM-meta
      // graph by direct enumeration, not via `listContextGraphs()`.
    ]);

    const r = await publisher.migrateSwmAttributionToAgentDid();
    expect(r.rewritten).toBeGreaterThanOrEqual(1);

    // Curated CG's SWM-meta row was rewritten to URI form.
    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${CURATED_SWM_META}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe(`did:dkg:agent:${ADDR}`);
    }

    // Marker landed in the adjacent CG `_meta` for the curated form (note
    // the `<addr>/<slug>` segment is preserved verbatim in the marker path).
    const marker = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CURATED_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    if (marker.type === 'bindings') expect(marker.bindings.length).toBe(1);
  });

  it('GH #748 Codex round 4: permanent "unknown" sentinel does not block the marker', async () => {
    // Legacy `generateKCMetadata` wrote `prov:wasAttributedTo "unknown"`
    // when no peer ID was supplied. That value can never resolve to an
    // agent address — it's permanent, not retriable. The migration must
    // still write the per-CG marker so subsequent boots fast-path skip
    // instead of re-scanning every time.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';

    const OP = `urn:dkg:share:${CG_ID}:op-unknown-sentinel`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: '"unknown"', graph: SWM_META },
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    const r1 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r1.rewritten).toBe(0);
    expect(r1.skipped).toBe(1); // counted as permanent skip

    // Marker IS written even though one row was skipped (permanent).
    const marker = await store.query(
      `SELECT ?ts WHERE { GRAPH <${CG_META}> { <urn:dkg:migration:swm-attr-agent-did> <${DKG}appliedAt> ?ts } }`,
    );
    if (marker.type === 'bindings') expect(marker.bindings.length).toBe(1);

    // The "unknown" literal is left in place — there's no real attribution
    // to migrate to.
    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_META}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe('"unknown"');
    }

    // Second pass: marker present → fast-path skip, no work.
    const r2 = await publisher.migrateSwmAttributionToAgentDid();
    expect(r2.rewritten).toBe(0);
    expect(r2.skipped).toBe(0);
  });

  it('GH #748 Codex round 5: legacy + canonical AGENTS records for the same agent resolve unambiguously', async () => {
    // Upgraded stores can carry two profile records for the same wallet:
    // - the legacy `did:dkg:agent:<peerId>` subject (profile.ts fallback)
    // - the canonical `did:dkg:agent:<address>` subject
    // The resolver must dedupe by normalised address (preferring the
    // explicit `dkg:agentAddress` literal) and treat them as one agent
    // rather than rejecting as ambiguous.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const DKG_REGISTRY = 'https://dkg.network/ontology#';
    const PROV = 'http://www.w3.org/ns/prov#';
    const PEER = '12D3KooWUpgradedNode';
    const ADDR = '0xaf7e932f79263f1a303790bd6c01b096f5334bbb';

    await store.insert([
      // Legacy profile: subject is the peer ID, no explicit agentAddress.
      { subject: `did:dkg:agent:${PEER}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${PEER}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER}"`, graph: AGENTS_GRAPH },
      // Canonical profile: subject is the wallet DID, explicit agentAddress literal.
      { subject: `did:dkg:agent:${ADDR}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER}"`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR}`, predicate: `${DKG_REGISTRY}agentAddress`, object: `"${ADDR}"`, graph: AGENTS_GRAPH },
    ]);

    const OP = `urn:dkg:share:${CG_ID}:op-legacy-canonical`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP, predicate: `${DKG}publisherPeerId`, object: `"${PEER}"`, graph: SWM_META },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `"${PEER}"`, graph: SWM_META },
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    const r = await publisher.migrateSwmAttributionToAgentDid();
    expect(r.rewritten).toBe(1);
    expect(r.skipped).toBe(0);

    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_META}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe(`did:dkg:agent:${ADDR}`);
    }
  });

  it('GH #748 Codex round 2: ambiguous peer→agent mapping (multi-agent-per-node) leaves literal in place', async () => {
    // Two agents share the same libp2p peer ID (multi-agent-per-node, e.g.
    // via `DKGAgent.registerAgent`). The resolver must NOT pick one
    // arbitrarily — the migration leaves the legacy literal alone.
    const AGENTS_GRAPH = 'did:dkg:context-graph:agents';
    const CG_META = `did:dkg:context-graph:${CG_ID}/_meta`;
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const DKG = 'http://dkg.io/ontology/';
    const PROV = 'http://www.w3.org/ns/prov#';
    const PEER_SHARED = '12D3KooWMultiAgentNode';
    const ADDR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const ADDR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    // GH #748 Codex round 3: registry namespace is `https://dkg.network/ontology#`.
    const DKG_REGISTRY = 'https://dkg.network/ontology#';

    await store.insert([
      { subject: `did:dkg:agent:${ADDR_A}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_A}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_SHARED}"`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_B}`, predicate: RDF_TYPE, object: `${DKG_REGISTRY}Agent`, graph: AGENTS_GRAPH },
      { subject: `did:dkg:agent:${ADDR_B}`, predicate: `${DKG_REGISTRY}peerId`, object: `"${PEER_SHARED}"`, graph: AGENTS_GRAPH },
    ]);

    const OP = `urn:dkg:share:${CG_ID}:op-ambiguous`;
    await store.insert([
      { subject: OP, predicate: RDF_TYPE, object: `${DKG}WorkspaceOperation`, graph: SWM_META },
      { subject: OP, predicate: `${DKG}publisherPeerId`, object: `"${PEER_SHARED}"`, graph: SWM_META },
      { subject: OP, predicate: `${PROV}wasAttributedTo`, object: `"${PEER_SHARED}"`, graph: SWM_META },
      { subject: `did:dkg:context-graph:${CG_ID}`, predicate: RDF_TYPE, object: `${DKG}ContextGraph`, graph: CG_META },
    ]);

    const r = await publisher.migrateSwmAttributionToAgentDid();
    expect(r.rewritten).toBe(0);
    expect(r.skipped).toBe(1);

    // The row stays as a literal — no arbitrary attribution.
    const after = await store.query(
      `SELECT ?o WHERE { GRAPH <${SWM_META}> { <${OP}> <${PROV}wasAttributedTo> ?o } }`,
    );
    if (after.type === 'bindings') {
      expect(after.bindings.length).toBe(1);
      expect(after.bindings[0]['o']).toBe(`"${PEER_SHARED}"`);
    }
  });

  it('full lifecycle preserves promoted SWM and rejects post-promote discard', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    let quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);

    const finalized = await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const count = Number(String(swmResult.bindings[0]?.['c'] ?? '0').replace(/^"|"$/g, '').replace(/"?\^\^.*/, ''));
      expect(count).toBe(3);
    }

    await expect(
      publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT),
    ).rejects.toMatchObject({ code: 'KA_WM_LIFECYCLE_REQUIRED' });
    const preservedSwm = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`,
    );
    expect(preservedSwm.type).toBe('bindings');
    if (preservedSwm.type === 'bindings') {
      const count = Number(String(preservedSwm.bindings[0]?.['c'] ?? '0').match(/\d+/)?.[0] ?? 0);
      expect(count).toBe(3);
    }
  });

  it('discard proceeds and archives the recovery seal when the SWM head is corrupt (GH#2273)', async () => {
    // GH#2273 — the resolver fails closed on a corrupt SWM head, and the discard path
    // resolves the head only to decide the advisory keep-the-recovery-seal boolean.
    // Discard is a plausible operator remedy for a KA whose head is exactly in that
    // corrupt state, so the throw must not abort it (pre-fix it did: the resolve had no
    // catch, so this discard rejected with KA_WORKSPACE_HEAD_CORRUPT and the operator
    // had no API-level way to clear the assertion). On corruption we cannot prove the
    // seal does NOT match live SWM content, so the decision fails toward RETENTION: the
    // seal is archived to the recovery subject rather than dropped.
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    const finalized = await finalizeAssertion();

    // One dangling shareOperationId row with none of the other required head rows is
    // the resolver's pre-existing "incomplete head or operation metadata" corrupt case
    // — the cheapest corrupt-head shape to fabricate, and the catch under test treats
    // every KnowledgeAssetWorkspaceHeadCorruptError alike.
    await store.insert([{
      subject: `${finalized.kaUal}#dkg-swm-head`,
      predicate: SHARE_OPERATION_ID_PREDICATE,
      object: '"phantom-op"',
      graph: SWM_META_GRAPH,
    }]);

    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    expect(await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT)).toHaveLength(0);
    const recoverySubject = `${contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME)}/_recovery_seal`;
    const archived = await store.query(
      `ASK { GRAPH <${contextGraphPrivateUri(CG_ID)}> { <${recoverySubject}> ?p ?o } }`,
    );
    expect(archived).toEqual({ type: 'boolean', value: true });
  });
});

describe('Working Memory Assertion sub-graph registration check', () => {
  const SG_CG_ID = 'sg-check-cg';
  const SG_NAME = 'code';
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  const finalizeSubGraphAssertion = () => finalizeRootlessAssertionForTest({
    publisher,
    store,
    contextGraphId: SG_CG_ID,
    name: ASSERTION_NAME,
    agentAddress: AGENT,
    subGraphName: SG_NAME,
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  async function registerSubGraph(): Promise<void> {
    const metaGraph = `did:dkg:context-graph:${SG_CG_ID}/_meta`;
    const sgUri = `did:dkg:context-graph:${SG_CG_ID}/${SG_NAME}`;
    await store.createGraph(metaGraph);
    await store.insert([
      {
        subject: sgUri,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/SubGraph',
        graph: metaGraph,
      },
      {
        subject: sgUri,
        predicate: 'http://schema.org/name',
        object: `"${SG_NAME}"`,
        graph: metaGraph,
      },
      {
        subject: sgUri,
        predicate: 'http://dkg.io/ontology/createdBy',
        object: 'did:dkg:agent:test-agent',
        graph: metaGraph,
      },
    ]);
  }

  it('assertionCreate throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertionWrite throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertionPromote throws when sub-graph is not registered', async () => {
    await expect(
      publisher.assertionPromote(SG_CG_ID, ASSERTION_NAME, AGENT, { subGraphName: SG_NAME }),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('assertion mutation guard requires full registration metadata, not just the SubGraph type marker', async () => {
    const metaGraph = `did:dkg:context-graph:${SG_CG_ID}/_meta`;
    const sgUri = `did:dkg:context-graph:${SG_CG_ID}/${SG_NAME}`;
    await store.createGraph(metaGraph);
    await store.insert([
      {
        subject: sgUri,
        predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        object: 'http://dkg.io/ontology/SubGraph',
        graph: metaGraph,
      },
    ]);

    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME),
    ).rejects.toThrow(/Sub-graph "code" has not been registered/);
  });

  it('keeps legacy unregistered sub-graph graphs readable but rejects discard mutation', async () => {
    const graphUri = contextGraphAssertionUri(SG_CG_ID, AGENT, ASSERTION_NAME, SG_NAME);
    await store.createGraph(graphUri);
    await store.insert(TRIPLES.map((triple) => ({ ...triple, graph: graphUri })));

    const quads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(quads.length).toBe(3);

    await expect(
      publisher.assertionDiscard(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME),
    ).rejects.toMatchObject({ code: 'LEGACY_KA_READ_ONLY' });
    const afterDiscard = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(afterDiscard.length).toBe(3);
  });

  it('assertion ops succeed after the sub-graph is registered', async () => {
    await registerSubGraph();

    const uri = await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(uri).toContain(`/${SG_NAME}/`);

    await publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME);
    const quads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(quads.length).toBe(3);

    await publisher.assertionDiscard(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    const afterDiscard = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(afterDiscard.length).toBe(0);
  });

  it('assertionPromote routes promoted triples into the registered sub-graph shared memory', async () => {
    await registerSubGraph();
    await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    await publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME);

    const finalized = await finalizeSubGraphAssertion();
    const result = await publisher.assertionPromote(SG_CG_ID, ASSERTION_NAME, AGENT, { subGraphName: SG_NAME });
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${finalized.sharedGraphUri}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('assertion ops without a sub-graph name still work (guard is opt-in)', async () => {
    const uri = await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT);
    expect(uri).toBe(contextGraphAssertionUri(SG_CG_ID, AGENT, ASSERTION_NAME));
  });

  it('invalid sub-graph name is rejected before the registration check', async () => {
    await expect(
      publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, 'Invalid Name With Spaces'),
    ).rejects.toThrow(/Invalid sub-graph name/);
  });
});

describe('Assertion Lifecycle Provenance (Event-Sourced, PROV-O)', () => {
  const META_GRAPH = `did:dkg:context-graph:${CG_ID}/_meta`;
  const DKG = 'http://dkg.io/ontology/';
  const PROV = 'http://www.w3.org/ns/prov#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  const finalizeAssertion = () => finalizeRootlessAssertionForTest({
    publisher,
    store,
    contextGraphId: CG_ID,
    name: ASSERTION_NAME,
    agentAddress: AGENT,
  });

  beforeEach(async () => {
    store = new OxigraphStore();
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
  });

  async function queryLifecycleState(name: string = ASSERTION_NAME): Promise<string | undefined> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?state WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}state> ?state } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return result.bindings[0]['state']?.replace(/^"|"$/g, '');
  }

  async function queryMemoryLayer(name: string = ASSERTION_NAME): Promise<string | undefined> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?layer WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}memoryLayer> ?layer } } LIMIT 1`,
    );
    if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
    return result.bindings[0]['layer']?.replace(/^"|"$/g, '');
  }

  // Read-both event shape (RFC ka-metadata-trim Phase 2): the writers no
  // longer persist `dkg:fromLayer`/`dkg:toLayer` — they are 100% determined
  // by the event class. Mirror the production history reader: OPTIONAL
  // patterns for old-store rows, derived-by-class otherwise. The layer
  // assertions in the tests below now pin the DERIVATION contract.
  const LAYER_BY_EVENT_TYPE: Record<string, { from: string; to: string }> = {
    AssertionCreated: { from: 'none', to: 'WM' },
    AssertionPromoted: { from: 'WM', to: 'SWM' },
    AssertionUpdated: { from: 'VM', to: 'VM' },
    AssertionDiscarded: { from: 'WM', to: 'none' },
  };

  async function queryEvents(name: string = ASSERTION_NAME): Promise<Array<{ type: string; fromLayer: string; toLayer: string }>> {
    const uri = assertionLifecycleUri(CG_ID, AGENT, name);
    const result = await store.query(
      `SELECT ?event ?type ?from ?to WHERE {
        GRAPH <${META_GRAPH}> {
          { ?event <${PROV}generated> <${uri}> }
          UNION
          { ?event <${PROV}used> <${uri}> }
          ?event a <${PROV}Activity> .
          ?event <${RDF_TYPE}> ?type .
          FILTER(STRSTARTS(STR(?type), "${DKG}"))
          OPTIONAL { ?event <${DKG}fromLayer> ?from }
          OPTIONAL { ?event <${DKG}toLayer> ?to }
        }
      } ORDER BY ?event`,
    );
    if (result.type !== 'bindings') return [];
    return result.bindings.map(b => {
      const type = (b['type'] ?? '').replace(DKG, '');
      const derived = LAYER_BY_EVENT_TYPE[type];
      return {
        type,
        fromLayer: b['from'] ? b['from'].replace(/^"|"$/g, '') : derived?.from ?? '',
        toLayer: b['to'] ? b['to'].replace(/^"|"$/g, '') : derived?.to ?? '',
      };
    });
  }

  it('assertionCreate writes state "created" and memoryLayer "WM"', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    expect(await queryLifecycleState()).toBe('created');
    expect(await queryMemoryLayer()).toBe('WM');
  });

  it('assertionCreate includes assertionGraph link', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const uri = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const result = await store.query(
      `SELECT ?g WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}assertionGraph> ?g } } LIMIT 1`,
    );
    expect(result.type).toBe('bindings');
    if (result.type === 'bindings') {
      expect(result.bindings[0]['g']).toContain('/assertion/');
    }
  });

  it('assertionCreate produces an AssertionCreated event entity', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const events = await queryEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('AssertionCreated');
    expect(events[0].fromLayer).toBe('none');
    expect(events[0].toLayer).toBe('WM');
  });

  it('promote updates state to "promoted" and memoryLayer to "SWM"', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('promoted');
    expect(await queryMemoryLayer()).toBe('SWM');
  });

  it('promote appends an AssertionPromoted event (WM → SWM)', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('AssertionPromoted');
    expect(events[1].fromLayer).toBe('WM');
    expect(events[1].toLayer).toBe('SWM');
  });

  it('promote records shareOperationId without root-entity member metadata', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const uri = assertionLifecycleUri(CG_ID, AGENT, ASSERTION_NAME);
    const evResult = await store.query(
      `SELECT ?event WHERE { GRAPH <${META_GRAPH}> { ?event <${PROV}used> <${uri}> . ?event a <${DKG}AssertionPromoted> } } LIMIT 1`,
    );
    expect(evResult.type).toBe('bindings');
    if (evResult.type === 'bindings') {
      const eventUri = evResult.bindings[0]['event'];
      const opResult = await store.query(
        `SELECT ?opId WHERE { GRAPH <${META_GRAPH}> { <${eventUri}> <${DKG}shareOperationId> ?opId } } LIMIT 1`,
      );
      expect(opResult.type === 'bindings' && opResult.bindings.length).toBeGreaterThan(0);
      // Rootless V2 keeps neither event-level nor lifecycle-level root member
      // rows; the UAL-derived exact graph is the complete membership boundary.
      const eventEntityResult = await store.query(
        `SELECT ?entity WHERE { GRAPH <${META_GRAPH}> { <${eventUri}> <${DKG}rootEntity> ?entity } }`,
      );
      if (eventEntityResult.type === 'bindings') {
        expect(eventEntityResult.bindings.length).toBe(0);
      }
      const subjectEntityResult = await store.query(
        `SELECT ?entity WHERE { GRAPH <${META_GRAPH}> { <${uri}> <${DKG}rootEntity> ?entity } }`,
      );
      expect(subjectEntityResult.type).toBe('bindings');
      if (subjectEntityResult.type === 'bindings') {
        expect(subjectEntityResult.bindings).toHaveLength(0);
      }
    }
  });

  it('discard updates state to "discarded" and removes memoryLayer', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('discarded');
    expect(await queryMemoryLayer()).toBeUndefined();
  });

  it('discard appends an AssertionDiscarded event (WM → none)', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('AssertionDiscarded');
    expect(events[1].fromLayer).toBe('WM');
    expect(events[1].toLayer).toBe('none');
  });

  it('lifecycle record persists in _meta even after assertion graph is emptied', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    const assertionQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(assertionQuads.length).toBe(0);

    expect(await queryLifecycleState()).toBe('promoted');
    expect(await queryMemoryLayer()).toBe('SWM');
  });

  it('lifecycle record and events persist after discard drops the data graph', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);

    const events = await queryEvents();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('AssertionCreated');
    expect(events[1].type).toBe('AssertionDiscarded');
  });

  it('different agents have separate lifecycle records', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT_B);

    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
    await finalizeAssertion();
    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    expect(await queryLifecycleState()).toBe('promoted');

    const uriBResult = await store.query(
      `SELECT ?state WHERE { GRAPH <${META_GRAPH}> { <${assertionLifecycleUri(CG_ID, AGENT_B, ASSERTION_NAME)}> <${DKG}state> ?state } } LIMIT 1`,
    );
    expect(uriBResult.type).toBe('bindings');
    if (uriBResult.type === 'bindings') {
      expect(uriBResult.bindings[0]['state']?.replace(/^"|"$/g, '')).toBe('created');
    }
  });
});
