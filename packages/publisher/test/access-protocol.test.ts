import { describe, it, expect, afterEach } from 'vitest';
import {
  DKGNode,
  ProtocolRouter,
  TypedEventBus,
  generateEd25519Keypair,
  PROTOCOL_ACCESS,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { AccessHandler } from '../src/access-handler.js';
import { AccessClient } from '../src/access-client.js';
import { multiaddr } from '@multiformats/multiaddr';
import { ethers } from 'ethers';

const PARANET = 'test-access';
const GRAPH = `did:dkg:context-graph:${PARANET}`;
const ENTITY = 'did:dkg:agent:TestBot';
const TEST_WALLET = ethers.Wallet.createRandom();

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('Access Protocol', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  async function setupTwoNodes() {
    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const nodeB = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();
    await nodeB.libp2p.dial(multiaddr(nodeA.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 500));
    return { nodeA, nodeB };
  }

  async function publishWithPrivate(
    store: OxigraphStore,
    options?: {
      publisherPeerId?: string;
      accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
      allowedPeers?: string[];
    },
  ) {
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();

    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: bus,
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"TestBot"'),
        q(ENTITY, 'http://schema.org/description', '"A test agent"'),
      ],
      privateQuads: [
        q(ENTITY, 'http://ex.org/apiKey', '"secret-key-123"'),
        q(ENTITY, 'http://ex.org/credentials', '"password:hunter2"'),
      ],
      publisherPeerId: options?.publisherPeerId,
      accessPolicy: options?.accessPolicy,
      allowedPeers: options?.allowedPeers,
    });

    return { result, bus, keypair };
  }

  it('denies non-owner access to private triples', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, { publisherPeerId: nodeA.peerId });

    expect(result.status).toBe('tentative');
    expect(result.kaManifest[0].privateTripleCount).toBe(2);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const kaUal = `${result.ual}/1`;
    // accessClient is bound to nodeB (requester); nodeA.peerId is the remote provider target.
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(false);
    expect(accessResult.quads.length).toBe(0);
    expect(accessResult.rejectionReason).toContain('owner-only');
  }, 20000);

  it('publishes private data without leaking it to public storage and still serves it to the owner', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, { publisherPeerId: nodeB.peerId });

    expect(result.status).toBe('tentative');
    expect(result.kaManifest[0].privateTripleCount).toBe(2);

    const publicResult = await storeA.query(`
      SELECT ?s ?p ?o WHERE {
        GRAPH <${GRAPH}> {
          ?s ?p ?o .
          FILTER(?p IN (<http://ex.org/apiKey>, <http://ex.org/credentials>))
        }
      }
    `);
    expect(publicResult.type).toBe('bindings');
    expect(publicResult.type === 'bindings' ? publicResult.bindings : []).toHaveLength(0);

    const kcUal = result.ual;
    const kaUal = `${result.ual}/1`;
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    const metaResult = await storeA.query(`
      SELECT ?policy ?publisher WHERE {
        GRAPH <${metaGraph}> {
          OPTIONAL { <${kcUal}> <http://dkg.io/ontology/accessPolicy> ?policy }
          OPTIONAL { <${kcUal}> <http://dkg.io/ontology/publisherPeerId> ?publisher }
        }
      }
    `);
    expect(metaResult.type).toBe('bindings');
    expect(metaResult.type === 'bindings' ? metaResult.bindings : []).toEqual([
      {
        policy: '"ownerOnly"',
        publisher: `"${nodeB.peerId}"`,
      },
    ]);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(true);
    expect(accessResult.rejectionReason).toBeUndefined();
    expect(accessResult.quads).toHaveLength(2);
    expect(accessResult.quads.map((quad) => quad.predicate).sort()).toEqual([
      'http://ex.org/apiKey',
      'http://ex.org/credentials',
    ]);
  }, 20000);

  it('denies access when KA does not exist', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const bus = new TypedEventBus();
    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const accessResult = await accessClient.requestAccess(
      nodeA.peerId,
      'did:dkg:mock:31337/0x0000000000000000000000000000000000000000/999/1',
    );

    expect(accessResult.granted).toBe(false);
    expect(accessResult.rejectionReason).toContain('not found');
  }, 20000);

  it('denies non-owner by default for private KA access', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, { publisherPeerId: nodeA.peerId });

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const kaUal = `${result.ual}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(false);
    expect(accessResult.rejectionReason).toContain('owner-only');
  }, 20000);

  it('AccessClient sends requesterPublicKey for ownerOnly access', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, { publisherPeerId: nodeA.peerId });

    const kaUal = `${result.ual}/1`;
    const kcUal = result.ual;
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;

    await storeA.insert([
      { subject: kcUal, predicate: 'http://dkg.io/ontology/accessPolicy', object: '"ownerOnly"', graph: metaGraph },
      { subject: kcUal, predicate: 'http://dkg.io/ontology/publisherPeerId', object: `"${nodeB.peerId}"`, graph: metaGraph },
    ]);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(true);
    expect(accessResult.quads.length).toBe(2);
  }, 20000);

  it('denies private access when policy and owner metadata are missing', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, { publisherPeerId: nodeA.peerId });

    const kcUal = result.ual;
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    await storeA.delete([
      { subject: kcUal, predicate: 'http://dkg.io/ontology/accessPolicy', object: '"ownerOnly"', graph: metaGraph },
      { subject: kcUal, predicate: 'http://dkg.io/ontology/publisherPeerId', object: `"${nodeA.peerId}"`, graph: metaGraph },
      { subject: kcUal, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `"${nodeA.peerId}"`, graph: metaGraph },
    ]);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const kaUal = `${result.ual}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(false);
    expect(accessResult.rejectionReason).toContain('owner identity missing');
  }, 20000);

  it('denies ownerOnly access when owner identity is missing', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA, {
      publisherPeerId: nodeA.peerId,
      accessPolicy: 'ownerOnly',
    });

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const kcUal = result.ual;
    const metaGraph = `did:dkg:context-graph:${PARANET}/_meta`;
    await storeA.delete([
      { subject: kcUal, predicate: 'http://dkg.io/ontology/publisherPeerId', object: `"${nodeA.peerId}"`, graph: metaGraph },
      { subject: kcUal, predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `"${nodeA.peerId}"`, graph: metaGraph },
    ]);

    const kaUal = `${result.ual}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(false);
    expect(accessResult.rejectionReason).toContain('owner identity missing');
  }, 20000);

  it('rejects publish when allowList policy is set without allowed peers', async () => {
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', TEST_WALLET.address);
    const bus = new TypedEventBus();
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: bus,
      keypair,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    await expect(
      publisher.publish({
        contextGraphId: PARANET,
        quads: [q(ENTITY, 'http://schema.org/name', '"TestBot"')],
        privateQuads: [q(ENTITY, 'http://ex.org/apiKey', '"secret-key-123"')],
        publisherPeerId: '12D3KooWTestPublisher',
        accessPolicy: 'allowList',
      }),
    ).rejects.toThrow('accessPolicy "allowList" requires non-empty "allowedPeers"');
  });
});
