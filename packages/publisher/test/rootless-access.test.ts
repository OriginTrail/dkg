import { describe, expect, it } from 'vitest';
import {
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  decodeAccessResponse,
  encodeAccessRequest,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  GraphManager,
  OxigraphStore,
  PrivateContentStore,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { AccessClient, type AccessSendSurface } from '../src/access-client.js';
import { AccessHandler } from '../src/access-handler.js';
import { generateGraphKnowledgeAssetMetadata } from '../src/metadata.js';
import { computePrivateRootV10 } from '../src/merkle.js';

const CONTEXT_GRAPH = 'rootless-access';
const CONTEXT_GRAPH_URI = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META_GRAPH = `${CONTEXT_GRAPH_URI}/_meta`;
const UAL = 'did:dkg:base:8453/0x70997970c51812dc3a010c7d01b50e0d17dc79c8/41';
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const DKG_CONTEXT_GRAPH = 'https://dkg.network/ontology#ContextGraph';

function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

function rootContextGraphRegistration(): Quad {
  return {
    subject: CONTEXT_GRAPH_URI,
    predicate: RDF_TYPE,
    object: DKG_CONTEXT_GRAPH,
    graph: META_GRAPH,
  };
}

function request(handler: AccessHandler, kaUal = UAL, peerId = 'requester-peer') {
  const payload = encodeAccessRequest({
    kaUal,
    requesterPeerId: peerId,
    paymentProof: new Uint8Array(0),
    requesterSignature: new Uint8Array(0),
  });
  return handler.handler(payload, peerId as never).then(decodeAccessResponse);
}

function loopback(handler: AccessHandler): AccessSendSurface {
  return {
    async sendReliable(_peerId, _protocolId, payload) {
      return {
        delivered: true,
        response: await handler.handler(payload, 'requester-peer' as never),
        attempts: 1,
        messageId: 'rootless-access-test',
      };
    },
  };
}

async function seedRootlessPrivateKA(options: {
  assertionVersion?: string;
  payload?: Quad[];
  metadataPrivateTripleCount?: number;
  metadataPrivateRoot?: Uint8Array;
  metadataAssertionGraph?: string;
  subGraphName?: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  publisherPeerId?: string;
  allowedPeers?: string[];
} = {}) {
  const assertionVersion = options.assertionVersion ?? '1';
  const payload = options.payload ?? [
    quad('urn:secret:alpha', 'urn:predicate:value', '"alpha"'),
    quad('urn:disconnected:beta', 'urn:predicate:value', '"beta"'),
  ];
  const store = new OxigraphStore();
  const graphManager = new GraphManager(store);
  await graphManager.ensureContextGraph(CONTEXT_GRAPH);
  const privateStore = new PrivateContentStore(store, graphManager);
  const scope = createGraphKnowledgeAssetScope(UAL, assertionVersion);
  await privateStore.replaceKnowledgeAssetPrivateTriples(
    CONTEXT_GRAPH,
    scope,
    payload,
    options.subGraphName,
  );
  const privateRoot = options.metadataPrivateRoot
    ?? computePrivateRootV10(payload)!;
  const assertionGraph = options.metadataAssertionGraph
    ?? knowledgeAssetLayerGraphUri(
      CONTEXT_GRAPH,
      MemoryLayer.VerifiableMemory,
      scope,
      options.subGraphName,
    );
  await store.insert(generateGraphKnowledgeAssetMetadata(
    {
      ual: UAL,
      contextGraphId: CONTEXT_GRAPH,
      merkleRoot: new Uint8Array(32).fill(7),
      publisherPeerId: options.publisherPeerId ?? 'publisher-peer',
      accessPolicy: options.accessPolicy ?? 'public',
      allowedPeers: options.allowedPeers,
      timestamp: new Date(0),
      assertionVersion,
      publicTripleCount: 0,
      privateTripleCount: options.metadataPrivateTripleCount ?? payload.length,
      privateMerkleRoot: privateRoot,
      assertionGraph,
      subGraphName: options.subGraphName,
    },
    'tentative',
  ));
  await store.insert([rootContextGraphRegistration()]);
  return { store, privateStore, scope, payload, privateRoot };
}

describe('rootless graph-scoped private access', () => {
  it('serves the complete exact private graph by bare UAL and verifies end to end', async () => {
    const { store, payload, privateRoot } = await seedRootlessPrivateKA();
    const handler = new AccessHandler(store, new TypedEventBus());
    const keypair = await generateEd25519Keypair();
    const client = new AccessClient(loopback(handler), keypair, 'requester-peer');

    const result = await client.requestAccess('publisher-peer', UAL);

    expect(result.granted).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.quads).toHaveLength(payload.length);
    expect(new Set(result.quads.map((entry) => entry.subject))).toEqual(
      new Set(payload.map((entry) => entry.subject)),
    );
    expect(result.quads.every((entry) => entry.graph === '')).toBe(true);
    expect(Array.from(result.privateMerkleRoot ?? [])).toEqual(Array.from(privateRoot));
  });

  it('denies private access when the metadata partition is also a registered legacy root', async () => {
    const { store } = await seedRootlessPrivateKA();
    await store.insert([{
      subject: META_GRAPH,
      predicate: RDF_TYPE,
      object: DKG_CONTEXT_GRAPH,
      graph: `${META_GRAPH}/_meta`,
    }]);

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('KA not found');
  });

  it('selects the metadata assertion version and never leaks an older private graph', async () => {
    const currentPayload = [quad('urn:secret:current', 'urn:p', '"version-two"')];
    const { store, privateStore } = await seedRootlessPrivateKA({
      assertionVersion: '2',
      payload: currentPayload,
    });
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      createGraphKnowledgeAssetScope(UAL, '1'),
      [quad('urn:secret:stale', 'urn:p', '"version-one"')],
    );

    const response = await request(new AccessHandler(store, new TypedEventBus()));
    const body = new TextDecoder().decode(response.nquads);

    expect(response.granted).toBe(true);
    expect(body).toContain('version-two');
    expect(body).not.toContain('version-one');
  });

  it('routes a named subgraph to its exact private graph without leaking the root graph', async () => {
    const namedPayload = [quad('urn:secret:named', 'urn:p', 'urn:object:named')];
    const { store, privateStore, scope } = await seedRootlessPrivateKA({
      subGraphName: 'updates',
      payload: namedPayload,
    });
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      [quad('urn:secret:root-decoy', 'urn:p', '"must-not-leak"')],
    );

    const response = await request(new AccessHandler(store, new TypedEventBus()));
    const body = new TextDecoder().decode(response.nquads);

    expect(response.granted).toBe(true);
    expect(body).toContain('<urn:object:named>');
    expect(body).not.toContain('root-decoy');
    expect(body).not.toContain('must-not-leak');
  });

  it('enforces graph-scoped allow lists for both authorized and unauthorized peers', async () => {
    const { store } = await seedRootlessPrivateKA({
      accessPolicy: 'allowList',
      allowedPeers: ['requester-peer'],
    });
    const handler = new AccessHandler(store, new TypedEventBus());
    const keypair = await generateEd25519Keypair();
    const client = new AccessClient(loopback(handler), keypair, 'requester-peer');

    const allowed = await client.requestAccess('publisher-peer', UAL);
    const denied = await request(handler, UAL, 'outsider-peer');

    expect(allowed.granted).toBe(true);
    expect(allowed.verified).toBe(true);
    expect(denied.granted).toBe(false);
    expect(denied.rejectionReason).toContain('not on allow list');
  });

  it('reads a large exact private graph in bounded ordered pages', async () => {
    const payload = Array.from({ length: 257 }, (_, index) =>
      quad(`urn:secret:${index.toString().padStart(3, '0')}`, 'urn:p', `"${index}"`));
    const { store } = await seedRootlessPrivateKA({ payload });
    const queries: string[] = [];
    const originalQuery = store.query.bind(store);
    store.query = async (...args) => {
      queries.push(args[0]);
      return originalQuery(...args);
    };

    const response = await request(new AccessHandler(store, new TypedEventBus()));
    const pageQueries = queries.filter((sparql) => sparql.includes('ORDER BY ?s ?p ?o'));

    expect(response.granted).toBe(true);
    expect(pageQueries).toHaveLength(2);
    expect(pageQueries[0]).toMatch(/LIMIT 256\s+OFFSET 0/);
    expect(pageQueries[1]).toMatch(/LIMIT 2\s+OFFSET 256/);
  });

  it('rejects an oversized declared private graph before materializing payload rows', async () => {
    const { store } = await seedRootlessPrivateKA({ metadataPrivateTripleCount: 100_001 });

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('exceeds quad limit');
  });

  it('ignores a victim scope marker stored in another KA payload graph', async () => {
    const { store } = await seedRootlessPrivateKA();
    await store.insert([{
      subject: UAL,
      predicate: `${DKG}contentScopeVersion`,
      object: `"2"^^<${XSD_INTEGER}>`,
      graph: 'urn:attacker:other-ka-payload',
    }]);

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(true);
    expect(new TextDecoder().decode(response.nquads)).toContain('urn:secret:alpha');
  });

  it('fails closed when the exact private graph count differs from metadata', async () => {
    const { store } = await seedRootlessPrivateKA({ metadataPrivateTripleCount: 1 });

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('integrity check failed');
    expect(response.rejectionReason).toContain('declares 1 triples, found 2');
  });

  it('fails closed when the private payload does not match its committed Merkle root', async () => {
    const { store } = await seedRootlessPrivateKA({
      metadataPrivateRoot: new Uint8Array(32).fill(9),
    });

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('Merkle root mismatch');
  });

  it('rejects metadata that points away from the UAL-derived VM graph', async () => {
    const { store } = await seedRootlessPrivateKA({
      metadataAssertionGraph: `${CONTEXT_GRAPH_URI}/_verifiable_memory/attacker/41`,
    });

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('assertionGraph mismatch');
  });

  it('treats persisted content-scope version zero as a legacy private read', async () => {
    const store = new OxigraphStore();
    const legacyRoot = 'urn:legacy:version-zero';
    await store.insert([
      rootContextGraphRegistration(),
      {
        subject: UAL,
        predicate: `${DKG}contentScopeVersion`,
        object: `"0"^^<${XSD_INTEGER}>`,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}rootEntity`,
        object: legacyRoot,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}contextGraph`,
        object: CONTEXT_GRAPH_URI,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}accessPolicy`,
        object: '"public"',
        graph: META_GRAPH,
      },
      {
        subject: legacyRoot,
        predicate: 'urn:p',
        object: '"legacy-zero"',
        graph: `${CONTEXT_GRAPH_URI}/_private`,
      },
    ]);

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(true);
    expect(new TextDecoder().decode(response.nquads)).toContain('legacy-zero');
  });

  it('never falls back to a legacy root bag after seeing an incomplete V2 marker', async () => {
    const store = new OxigraphStore();
    const legacyRoot = 'urn:legacy:poison';
    await store.insert([
      rootContextGraphRegistration(),
      {
        subject: UAL,
        predicate: `${DKG}contentScopeVersion`,
        object: `"2"^^<${XSD_INTEGER}>`,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}contextGraph`,
        object: CONTEXT_GRAPH_URI,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}rootEntity`,
        object: legacyRoot,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}accessPolicy`,
        object: '"public"',
        graph: META_GRAPH,
      },
      {
        subject: legacyRoot,
        predicate: 'urn:p',
        object: '"must-not-leak"',
        graph: `${CONTEXT_GRAPH_URI}/_private`,
      },
    ]);

    const response = await request(new AccessHandler(store, new TypedEventBus()));

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('missing kaUal metadata');
    expect(new TextDecoder().decode(response.nquads)).not.toContain('must-not-leak');
  });

  it('canonicalizes and rechecks a legacy token alias before serving stale private data', async () => {
    const store = new OxigraphStore();
    const legacyRoot = 'urn:legacy:alias-poison';
    const aliasedUal = UAL.replace(
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
      '0x70997970C51812DC3A010C7D01B50E0D17DC79C8',
    );
    await store.insert([
      rootContextGraphRegistration(),
      {
        subject: UAL,
        predicate: `${DKG}contentScopeVersion`,
        object: `"2"^^<${XSD_INTEGER}>`,
        graph: META_GRAPH,
      },
      {
        subject: UAL,
        predicate: `${DKG}contextGraph`,
        object: CONTEXT_GRAPH_URI,
        graph: META_GRAPH,
      },
      {
        subject: `${aliasedUal}/1`,
        predicate: `${DKG}rootEntity`,
        object: legacyRoot,
        graph: META_GRAPH,
      },
      {
        subject: `${aliasedUal}/1`,
        predicate: `${DKG}partOf`,
        object: aliasedUal,
        graph: META_GRAPH,
      },
      {
        subject: aliasedUal,
        predicate: `${DKG}contextGraph`,
        object: CONTEXT_GRAPH_URI,
        graph: META_GRAPH,
      },
      {
        subject: aliasedUal,
        predicate: `${DKG}accessPolicy`,
        object: '"public"',
        graph: META_GRAPH,
      },
      {
        subject: legacyRoot,
        predicate: 'urn:p',
        object: '"must-not-leak-through-alias"',
        graph: `${CONTEXT_GRAPH_URI}/_private`,
      },
    ]);

    const response = await request(
      new AccessHandler(store, new TypedEventBus()),
      `${aliasedUal}/1`,
    );

    expect(response.granted).toBe(false);
    expect(response.rejectionReason).toContain('missing kaUal metadata');
    expect(new TextDecoder().decode(response.nquads)).not.toContain('must-not-leak-through-alias');
  });
});
