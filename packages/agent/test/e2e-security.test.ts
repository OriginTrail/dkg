/**
 * E2E security and privacy tests.
 *
 * Each test boots fully isolated agents with in-memory stores and separate
 * libp2p nodes on random ports.  Tests verify:
 *
 * 1. Private triples never leak via GossipSub broadcast
 * 2. Private triples never appear in remote SPARQL queries
 * 3. Access protocol correctly denies unknown KAs
 * 4. ContextGraph isolation: data in one contextGraph is invisible to another
 * 5. Publish with private triples + access protocol round-trip
 * 6. Persistent-store isolation with temp directories
 */
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DKGAgent } from '../src/index.js';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import {
  DKGNode,
  ProtocolRouter,
  TypedEventBus,
  generateEd25519Keypair,
  PROTOCOL_ACCESS,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AccessClient, AccessHandler, DKGPublisher } from '@origintrail-official/dkg-publisher';
import { wrapPublisherForTest } from '../../publisher/test/_helpers/seal.js';
import { ethers } from 'ethers';

const agents: DKGAgent[] = [];
const nodes: DKGNode[] = [];
const tempDirs: string[] = [];

let _fileSnapshot: string;
beforeAll(async () => {
  _fileSnapshot = await takeSnapshot();
  const { hubAddress } = getSharedContext();
  const provider = createProvider();
  const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
});
afterAll(async () => {
  await revertSnapshot(_fileSnapshot);
});

// Phase C requires `precomputedAttestation` for on-chain publishes; wrap each
// raw `DKGPublisher` in this file so the proxy mints a seal automatically.
async function wrapPub(p: DKGPublisher, chain: ReturnType<typeof createEVMAdapter>): Promise<DKGPublisher> {
  return wrapPublisherForTest(p, {
    author: new ethers.Wallet(HARDHAT_KEYS.CORE_OP),
    ctx: {
      provider: createProvider(),
      kav10Address: await chain.getKnowledgeAssetsV10Address(),
    },
  });
}

afterEach(async () => {
  for (const a of agents) {
    try { await a.stop(); } catch (err) { console.warn('Teardown: agent.stop() failed', err); }
  }
  agents.length = 0;
  for (const n of nodes) {
    try { await n.stop(); } catch (err) { console.warn('Teardown: node.stop() failed', err); }
  }
  nodes.length = 0;
  for (const d of tempDirs) {
    try { await rm(d, { recursive: true }); } catch { /* best effort */ }
  }
  tempDirs.length = 0;
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 1. Private triples must NOT leak via GossipSub broadcast
// ---------------------------------------------------------------------------
describe('Private triple confidentiality via GossipSub', () => {
  it('private triples published on A are NOT received by B through GossipSub', async () => {
    const agentA = await DKGAgent.create({
      name: 'PrivacyPublisher',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const agentB = await DKGAgent.create({
      name: 'PrivacyReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    agents.push(agentA, agentB);
    await agentA.start();
    await agentB.start();

    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    const CONTEXT_GRAPH = 'privacy-test';
    await agentA.createContextGraph({ id: CONTEXT_GRAPH, name: 'Privacy', description: '' });
    agentA.subscribeToContextGraph(CONTEXT_GRAPH);
    agentB.subscribeToContextGraph(CONTEXT_GRAPH);
    await sleep(500);

    const PUBLIC_NAME = '"PublicAgent"';
    const PRIVATE_KEY = '"sk-secret-api-key-12345"';
    const PRIVATE_WEIGHTS = '"s3://private-bucket/model.bin"';

    await agentA.publish(
      CONTEXT_GRAPH,
      [
        { subject: 'did:dkg:test:SecretAgent', predicate: 'http://schema.org/name', object: PUBLIC_NAME, graph: '' },
        { subject: 'did:dkg:test:SecretAgent', predicate: 'http://schema.org/description', object: '"A public agent"', graph: '' },
      ],
      [
        { subject: 'did:dkg:test:SecretAgent', predicate: 'http://ex.org/apiKey', object: PRIVATE_KEY, graph: '' },
        { subject: 'did:dkg:test:SecretAgent', predicate: 'http://ex.org/modelWeights', object: PRIVATE_WEIGHTS, graph: '' },
      ],
    );

    await sleep(3000);

    // Agent B should have the PUBLIC triples
    const publicResult = await agentB.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      CONTEXT_GRAPH,
    );
    expect(publicResult.bindings.length).toBeGreaterThanOrEqual(1);
    expect(publicResult.bindings[0]['name']).toBe('"PublicAgent"');

    // Agent B should NOT have the private triples
    const apiKeyResult = await agentB.query(
      'SELECT ?key WHERE { ?s <http://ex.org/apiKey> ?key }',
      CONTEXT_GRAPH,
    );
    expect(apiKeyResult.bindings).toHaveLength(0);

    const weightsResult = await agentB.query(
      'SELECT ?w WHERE { ?s <http://ex.org/modelWeights> ?w }',
      CONTEXT_GRAPH,
    );
    expect(weightsResult.bindings).toHaveLength(0);
  }, 25000);

  // "publisher A retains private triples locally while B only sees public"
  // removed: the test ran a RAW
  // `agentA.store.query(SELECT ?val WHERE { GRAPH <…/_private> { … } })`
  // and asserted `bindings[0].val === '"top-secret-value"'` — it expected
  // the on-disk private graph to contain plaintext. After the ST-2 fix
  // (AES-GCM-SIV at rest) the private graph holds ciphertext
  // (`"enc:gcm:v1:…"`) by design; authorised access is via the access
  // protocol, not raw store reads. Coverage for the intended behaviour
  // (cross-agent privacy + protocol-mediated access) is retained by
  // sibling tests "private triples published on A are NOT received by B
  // through GossipSub", "cross-agent SPARQL query does not return
  // private triples", and "publisher grants access and returns correct
  // private triples".
});

// ---------------------------------------------------------------------------
// 2. Remote SPARQL queries must not return private triples
// ---------------------------------------------------------------------------
describe('Remote query privacy', () => {
  it('cross-agent SPARQL query does not return private triples', async () => {
    const agentA = await DKGAgent.create({
      name: 'QueryPrivPublisher',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      queryAccess: { defaultPolicy: 'public' },
    });
    const agentB = await DKGAgent.create({
      name: 'QueryPrivRequester',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    agents.push(agentA, agentB);
    await agentA.start();
    await agentB.start();
    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    const CONTEXT_GRAPH = 'remote-query-priv';
    await agentA.createContextGraph({ id: CONTEXT_GRAPH, name: 'RQP', description: '' });

    await agentA.publish(
      CONTEXT_GRAPH,
      [{ subject: 'did:dkg:test:RQEntity', predicate: 'http://schema.org/name', object: '"QueryableEntity"', graph: '' }],
      [{ subject: 'did:dkg:test:RQEntity', predicate: 'http://ex.org/secret', object: '"hidden-value"', graph: '' }],
    );

    // B queries A's contextGraph remotely — should see public, not private
    const response = await agentB.queryRemote(agentA.peerId, {
      lookupType: 'SPARQL_QUERY',
      contextGraphId: CONTEXT_GRAPH,
      sparql: 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
    });
    expect(response.status).toBe('OK');

    const allPredicates = (response.ntriples ?? '')
      .split('\n')
      .filter(Boolean)
      .map(line => line.match(/<([^>]+)>/g)?.[1] ?? '');

    // The secret predicate must not appear in remote results
    const hasSecret = allPredicates.some(p => p.includes('ex.org/secret'));
    expect(hasSecret).toBe(false);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 3. Access protocol: denial for unknown KA
// ---------------------------------------------------------------------------
describe('Access protocol denial', () => {
  it('denies access for non-existent KA', async () => {
    const nodeA = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const nodeB = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();

    const { multiaddr } = await import('@multiformats/multiaddr');
    await nodeB.libp2p.dial(multiaddr(nodeA.multiaddrs[0]));
    await sleep(500);

    const storeA = new OxigraphStore();
    const busA = new TypedEventBus();
    const accessHandler = new AccessHandler(storeA, busA);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const routerB = new ProtocolRouter(nodeB);
    const keypairB = await generateEd25519Keypair();
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const result = await accessClient.requestAccess(
      nodeA.peerId,
      'did:dkg:evm:31337/0xNonExistent/999/1',
    );

    expect(result.granted).toBe(false);
    expect(result.rejectionReason).toBeTruthy();
  }, 15000);

  it('denies access when KA exists but has no private triples', async () => {
    const nodeA = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const nodeB = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();

    const { multiaddr } = await import('@multiformats/multiaddr');
    await nodeB.libp2p.dial(multiaddr(nodeA.multiaddrs[0]));
    await sleep(500);

    const storeA = new OxigraphStore();
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const busA = new TypedEventBus();
    const keypairA = await generateEd25519Keypair();

    const publisherA = await wrapPub(new DKGPublisher({
      store: storeA,
      chain: chainA,
      eventBus: busA,
      keypair: keypairA,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    }), chainA);

    const cgResult = await chainA.createOnChainContextGraph({
      participantIdentityIds: [BigInt(getSharedContext().coreProfileId)],
      requiredSignatures: 1,
      publishPolicy: 1,
    });

    await publisherA.publish({
      contextGraphId: 'no-priv-test',
      publishContextGraphId: cgResult.contextGraphId.toString(),
      quads: [
        { subject: 'did:dkg:test:PubOnly', predicate: 'http://schema.org/name', object: '"PubOnly"', graph: 'did:dkg:context-graph:no-priv-test' },
      ],
    });

    const accessHandler = new AccessHandler(storeA, busA);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const routerB = new ProtocolRouter(nodeB);
    const keypairB = await generateEd25519Keypair();
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const result = await accessClient.requestAccess(
      nodeA.peerId,
      'did:dkg:evm:31337/0xFake/1/1',
    );

    expect(result.granted).toBe(false);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 4. ContextGraph isolation
// ---------------------------------------------------------------------------
describe('ContextGraph isolation', () => {
  it('data in one contextGraph is invisible to queries in another', async () => {
    const agent = await DKGAgent.create({
      name: 'IsolationBot',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'isolated-a', name: 'A', description: '' });
    await agent.createContextGraph({ id: 'isolated-b', name: 'B', description: '' });

    await agent.publish('isolated-a', [
      { subject: 'did:dkg:test:SecretInA', predicate: 'http://ex.org/classification', object: '"TOP SECRET"', graph: '' },
    ]);
    await agent.publish('isolated-b', [
      { subject: 'did:dkg:test:PublicInB', predicate: 'http://schema.org/name', object: '"PublicB"', graph: '' },
    ]);

    // Query contextGraph B should NOT return data from contextGraph A
    const crossResult = await agent.query(
      'SELECT ?val WHERE { ?s <http://ex.org/classification> ?val }',
      'isolated-b',
    );
    expect(crossResult.bindings).toHaveLength(0);

    // Query contextGraph A should find its own data
    const ownResult = await agent.query(
      'SELECT ?val WHERE { ?s <http://ex.org/classification> ?val }',
      'isolated-a',
    );
    expect(ownResult.bindings).toHaveLength(1);
    expect(ownResult.bindings[0]['val']).toBe('"TOP SECRET"');
  }, 15000);

  it('private triples in contextGraph A are not visible in contextGraph B queries', async () => {
    const agent = await DKGAgent.create({
      name: 'ParaPrivBot',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(agent);
    await agent.start();

    await agent.createContextGraph({ id: 'para-priv-a', name: 'PrivA', description: '' });
    await agent.createContextGraph({ id: 'para-priv-b', name: 'PrivB', description: '' });

    await agent.publish(
      'para-priv-a',
      [{ subject: 'did:dkg:test:PrivEntA', predicate: 'http://schema.org/name', object: '"EntityA"', graph: '' }],
      [{ subject: 'did:dkg:test:PrivEntA', predicate: 'http://ex.org/secret', object: '"a-secret"', graph: '' }],
    );
    await agent.publish('para-priv-b', [
      { subject: 'did:dkg:test:PubEntB', predicate: 'http://schema.org/name', object: '"EntityB"', graph: '' },
    ]);

    // ContextGraph B must not see contextGraph A's secrets
    const crossSecret = await agent.query(
      'SELECT ?s WHERE { ?s <http://ex.org/secret> ?val }',
      'para-priv-b',
    );
    expect(crossSecret.bindings).toHaveLength(0);
  }, 15000);
});

// ---------------------------------------------------------------------------
// 5. Access protocol round-trip with private triples
// ---------------------------------------------------------------------------
describe('Access protocol round-trip', () => {
  it('publisher grants access and returns correct private triples', async () => {
    const nodeA = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const nodeB = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();

    const { multiaddr } = await import('@multiformats/multiaddr');
    await nodeB.libp2p.dial(multiaddr(nodeA.multiaddrs[0]));
    await sleep(500);

    const storeA = new OxigraphStore();
    const chainA = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const busA = new TypedEventBus();
    const keypairA = await generateEd25519Keypair();

    const CONTEXT_GRAPH = 'access-roundtrip';
    const ENTITY = 'did:dkg:test:AccessEntity';

    const publisherA = await wrapPub(new DKGPublisher({
      store: storeA,
      chain: chainA,
      eventBus: busA,
      keypair: keypairA,
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    }), chainA);

    const cgResult = await chainA.createOnChainContextGraph({
      participantIdentityIds: [BigInt(getSharedContext().coreProfileId)],
      requiredSignatures: 1,
      publishPolicy: 1,
    });
    const onChainCgId = cgResult.contextGraphId.toString();

    const result = await publisherA.publish({
      contextGraphId: CONTEXT_GRAPH,
      publisherPeerId: nodeA.peerId.toString(),
      publishContextGraphId: onChainCgId,
      quads: [
        { subject: ENTITY, predicate: 'http://schema.org/name', object: '"AccessBot"', graph: `did:dkg:context-graph:${CONTEXT_GRAPH}` },
      ],
      privateQuads: [
        { subject: ENTITY, predicate: 'http://ex.org/apiKey', object: '"secret-api-key"', graph: `did:dkg:context-graph:${CONTEXT_GRAPH}` },
        { subject: ENTITY, predicate: 'http://ex.org/modelPath', object: '"s3://priv/model.bin"', graph: `did:dkg:context-graph:${CONTEXT_GRAPH}` },
      ],
    });

    expect(result.kaManifest[0].privateTripleCount).toBe(2);

    // Stabilize policy for this round-trip test: ensure KC access policy is explicitly public.
    // Without this, concurrent test suites that mutate mock-chain/contextGraph state can make this
    // check flaky (ownerOnly would deny requests from nodeB).
    const metaGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
    await storeA.deleteByPattern({
      graph: metaGraph,
      subject: result.ual,
      predicate: 'http://dkg.io/ontology/accessPolicy',
    });
    await storeA.insert([
      {
        subject: result.ual,
        predicate: 'http://dkg.io/ontology/accessPolicy',
        object: '"public"',
        graph: metaGraph,
      },
    ]);

    // Register access handler on A
    const accessHandler = new AccessHandler(storeA, busA);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    // B requests access
    const routerB = new ProtocolRouter(nodeB);
    const keypairB = await generateEd25519Keypair();
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const onChain = result.onChainResult!;
    const ual = `did:dkg:evm:31337/${onChain.publisherAddress}/${onChain.startKAId}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, ual);

    expect(accessResult.granted).toBe(true);
    expect(accessResult.quads.length).toBeGreaterThanOrEqual(2);

    const predicates = accessResult.quads.map(q => q.predicate);
    expect(predicates).toContain('http://ex.org/apiKey');
    expect(predicates).toContain('http://ex.org/modelPath');

    const apiKeyQuad = accessResult.quads.find(q => q.predicate === 'http://ex.org/apiKey');
    expect(apiKeyQuad!.object).toBe('"secret-api-key"');
  }, 20000);
});

// ---------------------------------------------------------------------------
// 6. Persistent store isolation
// ---------------------------------------------------------------------------
describe('Persistent store isolation', () => {
  it('agents with separate dataDirs have fully isolated stores', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'dkg-e2e-secA-'));
    const dirB = await mkdtemp(join(tmpdir(), 'dkg-e2e-secB-'));
    tempDirs.push(dirA, dirB);

    const agentA = await DKGAgent.create({
      name: 'PersistA',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      dataDir: dirA,
    });
    const agentB = await DKGAgent.create({
      name: 'PersistB',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
      dataDir: dirB,
    });
    agents.push(agentA, agentB);
    await agentA.start();
    await agentB.start();

    await agentA.createContextGraph({ id: 'persist-test', name: 'Persist', description: '' });
    await agentA.publish('persist-test', [
      { subject: 'did:dkg:test:PersistEntity', predicate: 'http://schema.org/name', object: '"OnlyOnA"', graph: '' },
    ]);

    // Agent A should have the data
    const aResult = await agentA.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name FILTER(?name = "OnlyOnA") }',
      'persist-test',
    );
    expect(aResult.bindings.length).toBe(1);

    // Agent B should NOT have agent A's data (isolated store)
    await agentB.createContextGraph({ id: 'persist-test', name: 'Persist', description: '' });
    const bResult = await agentB.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name FILTER(?name = "OnlyOnA") }',
      'persist-test',
    );
    expect(bResult.bindings.length).toBe(0);
  }, 20000);
});

// ---------------------------------------------------------------------------
// 7. Private triples not leaked via sync protocol
// ---------------------------------------------------------------------------
describe('Private triple confidentiality via sync protocol', () => {
  it('syncFromPeer does not transfer private triples', async () => {
    const agentA = await DKGAgent.create({
      name: 'SyncPublisher',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    const agentB = await DKGAgent.create({
      name: 'SyncReceiver',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.REC1_OP),
    });
    agents.push(agentA, agentB);
    await agentA.start();
    await agentB.start();

    await agentB.connectTo(agentA.multiaddrs[0]);
    await sleep(1000);

    const CONTEXT_GRAPH = 'sync-privacy-test';
    await agentA.createContextGraph({ id: CONTEXT_GRAPH, name: 'SyncPrivacy', description: '' });
    agentA.subscribeToContextGraph(CONTEXT_GRAPH);
    agentB.subscribeToContextGraph(CONTEXT_GRAPH);
    await sleep(500);

    await agentA.publish(
      CONTEXT_GRAPH,
      [
        { subject: 'did:dkg:test:SyncEntity', predicate: 'http://schema.org/name', object: '"PublicViaSync"', graph: '' },
      ],
      [
        { subject: 'did:dkg:test:SyncEntity', predicate: 'http://ex.org/secret', object: '"should-not-sync"', graph: '' },
      ],
    );

    await sleep(1000);

    // Now B explicitly syncs from A (the sync protocol path, not GossipSub)
    await agentB.syncFromPeer(agentA.node.peerId, [CONTEXT_GRAPH]);
    await sleep(500);

    // B should have the public triple
    const publicResult = await agentB.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      CONTEXT_GRAPH,
    );
    const publicNames = publicResult.bindings.map((b: any) => b['name']);
    expect(publicNames).toContain('"PublicViaSync"');

    // B should NOT have the private triple in either the data or private graph
    const secretResult = await agentB.query(
      'SELECT ?s WHERE { ?s <http://ex.org/secret> ?o }',
      CONTEXT_GRAPH,
    );
    expect(secretResult.bindings).toHaveLength(0);

    const bPrivateGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_private`;
    const bPrivateResult = await agentB.store.query(
      `SELECT ?val WHERE { GRAPH <${bPrivateGraph}> { ?s <http://ex.org/secret> ?val } }`,
    );
    expect(bPrivateResult.type).toBe('bindings');
    if (bPrivateResult.type === 'bindings') {
      expect(bPrivateResult.bindings).toHaveLength(0);
    }

    // A should still have the private triple in its private graph
    const aPrivateGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_private`;
    const aPrivateResult = await agentA.store.query(
      `SELECT ?val WHERE { GRAPH <${aPrivateGraph}> { ?s <http://ex.org/secret> ?val } }`,
    );
    expect(aPrivateResult.type).toBe('bindings');
    if (aPrivateResult.type === 'bindings') {
      expect(aPrivateResult.bindings.length).toBeGreaterThanOrEqual(1);
    }
  }, 25000);
});

// ---------------------------------------------------------------------------
// 8. SPARQL injection prevention
// ---------------------------------------------------------------------------
describe('SPARQL injection prevention', () => {
  it('rejects SPARQL update disguised in various forms', async () => {
    const agent = await DKGAgent.create({
      name: 'InjectionBot',
      listenPort: 0,
      skills: [],
      chainAdapter: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
    });
    agents.push(agent);

    const maliciousQueries = [
      'INSERT DATA { <x> <y> <z> }',
      'DELETE WHERE { ?s ?p ?o }',
      'DROP ALL',
      'CLEAR GRAPH <did:dkg:context-graph:test>',
      'COPY GRAPH <a> TO GRAPH <b>',
      'MOVE GRAPH <a> TO GRAPH <b>',
    ];

    for (const q of maliciousQueries) {
      await expect(agent.query(q)).rejects.toThrow(/SPARQL rejected/);
    }
  }, 10000);
});
