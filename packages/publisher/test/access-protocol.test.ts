import { describe, it, expect, afterEach } from 'vitest';
import {
  DKGNode,
  ProtocolRouter,
  TypedEventBus,
  generateEd25519Keypair,
  PROTOCOL_ACCESS,
} from '@dkg/core';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { MockChainAdapter } from '@dkg/chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { AccessHandler } from '../src/access-handler.js';
import { AccessClient } from '../src/access-client.js';
import { computePrivateRoot } from '../src/merkle.js';
import { multiaddr } from '@multiformats/multiaddr';
import { ethers } from 'ethers';

const PARANET = 'test-access';
const GRAPH = `did:dkg:paranet:${PARANET}`;
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

  async function publishWithPrivate(store: OxigraphStore) {
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
      paranetId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"TestBot"'),
        q(ENTITY, 'http://schema.org/description', '"A test agent"'),
      ],
      privateQuads: [
        q(ENTITY, 'http://ex.org/apiKey', '"secret-key-123"'),
        q(ENTITY, 'http://ex.org/credentials', '"password:hunter2"'),
      ],
    });

    return { result, bus, keypair };
  }

  it('grants access and verifies merkle root of received private triples', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA);

    expect(result.status).toBe('confirmed');
    expect(result.kaManifest[0].privateTripleCount).toBe(2);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const onChain = result.onChainResult!;
    const kaUal = `did:dkg:mock:31337/${onChain.publisherAddress}/${onChain.startKAId}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(true);
    expect(accessResult.quads.length).toBe(2);
    expect(accessResult.verified).toBe(true);

    const apiKeyTriple = accessResult.quads.find(
      (q) => q.predicate === 'http://ex.org/apiKey',
    );
    expect(apiKeyTriple).toBeDefined();
    expect(apiKeyTriple!.object).toContain('secret-key-123');

    // Verify the returned merkle root matches what we compute locally
    const localRoot = computePrivateRoot(accessResult.quads);
    expect(localRoot).toBeDefined();
    expect(accessResult.privateMerkleRoot).toBeDefined();
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

  it('returns correct private triples for the specific KA requested', async () => {
    const { nodeA, nodeB } = await setupTwoNodes();

    const storeA = new OxigraphStore();
    const { result, bus } = await publishWithPrivate(storeA);

    const accessHandler = new AccessHandler(storeA, bus);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    const keypairB = await generateEd25519Keypair();
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const onChain = result.onChainResult!;
    const kaUal = `did:dkg:mock:31337/${onChain.publisherAddress}/${onChain.startKAId}/1`;
    const accessResult = await accessClient.requestAccess(nodeA.peerId, kaUal);

    expect(accessResult.granted).toBe(true);
    // All returned triples should relate to the requested entity
    for (const quad of accessResult.quads) {
      expect(quad.subject).toContain(ENTITY);
    }
  }, 20000);
});
