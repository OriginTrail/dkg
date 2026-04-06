import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { TypedEventBus, generateEd25519Keypair, contextGraphDraftUri } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/index.js';
import { ethers } from 'ethers';

const CG_ID = 'test-draft-cg';
const SWM_GRAPH = `did:dkg:context-graph:${CG_ID}/_shared_memory`;
const AGENT = '0x1234567890abcdef1234567890abcdef12345678';
const AGENT_B = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const DRAFT = 'my-draft';

const TRIPLES = [
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
  { subject: 'urn:test:entity:alice', predicate: 'http://schema.org/age', object: '"30"' },
  { subject: 'urn:test:entity:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
];

describe('Working Memory Draft Lifecycle', () => {
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

  it('create returns the correct draft graph URI', async () => {
    const uri = await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    expect(uri).toBe(contextGraphDraftUri(CG_ID, AGENT, DRAFT));
  });

  it('write inserts triples into the draft graph', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);

    const quads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:alice')).toBe(true);
    expect(subjects.has('urn:test:entity:bob')).toBe(true);
  });

  it('query returns triples from the draft only', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);

    // Write something to a different draft — should not appear
    await publisher.draftCreate(CG_ID, 'other-draft', AGENT);
    await publisher.draftWrite(CG_ID, 'other-draft', AGENT, [
      { subject: 'urn:test:entity:charlie', predicate: 'http://schema.org/name', object: '"Charlie"' },
    ]);

    const quads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(quads.length).toBe(3);
    const subjects = new Set(quads.map((q: Quad) => q.subject));
    expect(subjects.has('urn:test:entity:charlie')).toBe(false);
  });

  it('promote moves all triples to SWM and empties draft', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);

    const result = await publisher.draftPromote(CG_ID, DRAFT, AGENT);
    expect(result.promotedCount).toBe(3);

    const draftQuads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(draftQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      expect(swmResult.bindings.length).toBe(3);
    }
  });

  it('promote with entity filter only moves selected entities', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);

    const result = await publisher.draftPromote(CG_ID, DRAFT, AGENT, {
      entities: ['urn:test:entity:alice'],
    });
    expect(result.promotedCount).toBe(2);

    const remaining = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
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

  it('discard drops the draft graph', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);
    await publisher.draftDiscard(CG_ID, DRAFT, AGENT);

    const quads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(quads.length).toBe(0);
  });

  it('different agents have isolated draft graphs', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftCreate(CG_ID, DRAFT, AGENT_B);

    await publisher.draftWrite(CG_ID, DRAFT, AGENT, [
      { subject: 'urn:test:alice', predicate: 'http://schema.org/name', object: '"Alice"' },
    ]);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT_B, [
      { subject: 'urn:test:bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    ]);

    const agentAQuads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(agentAQuads.length).toBe(1);
    expect(agentAQuads[0].subject).toBe('urn:test:alice');

    const agentBQuads = await publisher.draftQuery(CG_ID, DRAFT, AGENT_B);
    expect(agentBQuads.length).toBe(1);
    expect(agentBQuads[0].subject).toBe('urn:test:bob');
  });

  it('promote on empty draft returns 0', async () => {
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    const result = await publisher.draftPromote(CG_ID, DRAFT, AGENT);
    expect(result.promotedCount).toBe(0);
  });

  it('promote records ShareTransition metadata in _shared_memory_meta', async () => {
    const SWM_META = `did:dkg:context-graph:${CG_ID}/_shared_memory_meta`;
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);
    await publisher.draftPromote(CG_ID, DRAFT, AGENT);

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
    await publisher.draftCreate(CG_ID, DRAFT, AGENT);
    await publisher.draftWrite(CG_ID, DRAFT, AGENT, TRIPLES);

    let draftQuads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(draftQuads.length).toBe(3);

    await publisher.draftPromote(CG_ID, DRAFT, AGENT);

    draftQuads = await publisher.draftQuery(CG_ID, DRAFT, AGENT);
    expect(draftQuads.length).toBe(0);

    const swmResult = await store.query(
      `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${SWM_GRAPH}> { ?s ?p ?o } }`,
    );
    expect(swmResult.type).toBe('bindings');
    if (swmResult.type === 'bindings') {
      const count = Number(String(swmResult.bindings[0]?.['c'] ?? '0').replace(/^"|"$/g, '').replace(/"?\^\^.*/, ''));
      expect(count).toBe(3);
    }

    await publisher.draftDiscard(CG_ID, DRAFT, AGENT);
  });
});
