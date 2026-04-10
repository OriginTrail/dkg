import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  TypedEventBus,
  generateEd25519Keypair,
  contextGraphAssertionUri,
  contextGraphSharedMemoryUri,
} from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';

const CG_ID = 'test-assertion-cg';
const SWM_GRAPH = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const ASSERTION_NAME = 'my-assertion';

const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/age', object: '"30"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

describe('Working Memory Assertion Lifecycle', () => {
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
    });
  });

  it('create returns the correct assertion graph URI', async () => {
    const uri = await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    expect(uri).toBe(contextGraphAssertionUri(CG_ID, AGENT, ASSERTION_NAME));
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

    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('promote with entity filter only moves selected entities', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT, {
      entities: ['urn:test:entity:alice'],
    });
    expect(result.promotedCount).toBe(2);

    const remaining = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(remaining.length).toBe(1);
    expect(remaining[0].subject).toBe('urn:test:entity:bob');

    const swmResult = await store.query(
      `SELECT ?s WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const swmSubjects = new Set(swmResult.bindings.map((b) => b['s']));
      expect(swmSubjects.has('urn:test:entity:alice')).toBe(true);
      expect(swmSubjects.has('urn:test:entity:bob')).toBe(false);
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

  it('promote on empty assertion returns 0', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    const result = await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);
    expect(result.promotedCount).toBe(0);
  });

  it('promote records ShareTransition metadata in _shared_memory_meta', async () => {
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);
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
      expect(shareTransitions.length).toBe(1);
      expect(shareTransitions[0]['s']).toMatch(/^urn:dkg:share:/);
    }
  });

  it('full lifecycle: create → write → promote → verify SWM → discard', async () => {
    await publisher.assertionCreate(CG_ID, ASSERTION_NAME, AGENT);
    await publisher.assertionWrite(CG_ID, ASSERTION_NAME, AGENT, TRIPLES);

    let quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(3);

    await publisher.assertionPromote(CG_ID, ASSERTION_NAME, AGENT);

    quads = await publisher.assertionQuery(CG_ID, ASSERTION_NAME, AGENT);
    expect(quads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const count = Number(String(swmResult.bindings[0]?.['c'] ?? '0').replace(/^"|"$/g, '').replace(/"?\^\^.*/, ''));
      expect(count).toBe(3);
    }

    await publisher.assertionDiscard(CG_ID, ASSERTION_NAME, AGENT);
  });
});

describe('Working Memory Assertion sub-graph registration check', () => {
  const SG_CG_ID = 'sg-check-cg';
  const SG_NAME = 'code';
  let store: OxigraphStore;
  let publisher: DKGPublisher;

  beforeEach(async () => {
    store = new OxigraphStore();
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    const keypair = await generateEd25519Keypair();
    publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: wallet.privateKey,
      publisherNodeIdentityId: 1n,
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

  it('assertionQuery and assertionDiscard still work for legacy unregistered sub-graph graphs', async () => {
    const graphUri = contextGraphAssertionUri(SG_CG_ID, AGENT, ASSERTION_NAME, SG_NAME);
    await store.createGraph(graphUri);
    await store.insert(TRIPLES.map((triple) => ({ ...triple, graph: graphUri })));

    const quads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(quads.length).toBe(3);

    await publisher.assertionDiscard(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    const afterDiscard = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(afterDiscard.length).toBe(0);
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
    const swmGraph = contextGraphSharedMemoryUri(SG_CG_ID, SG_NAME);

    await registerSubGraph();
    await publisher.assertionCreate(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    await publisher.assertionWrite(SG_CG_ID, ASSERTION_NAME, AGENT, TRIPLES, SG_NAME);

    const result = await publisher.assertionPromote(SG_CG_ID, ASSERTION_NAME, AGENT, { subGraphName: SG_NAME });
    expect(result.promotedCount).toBe(3);

    const assertionQuads = await publisher.assertionQuery(SG_CG_ID, ASSERTION_NAME, AGENT, SG_NAME);
    expect(assertionQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${swmGraph}> { ?s ?p ?o } }`,
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
