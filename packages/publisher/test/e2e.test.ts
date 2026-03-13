import { describe, it, expect, afterEach } from 'vitest';
import {
  DKGNode,
  ProtocolRouter,
  TypedEventBus,
  generateEd25519Keypair,
  PROTOCOL_PUBLISH,
  PROTOCOL_ACCESS,
  encodePublishRequest,
  decodePublishRequest,
  decodePublishAck,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { PublishHandler } from '../src/publish-handler.js';
import { AccessHandler } from '../src/access-handler.js';
import { AccessClient } from '../src/access-client.js';
import { DKGQueryEngine } from '@origintrail-official/dkg-query';
import { multiaddr } from '@multiformats/multiaddr';
import { ethers } from 'ethers';
import { computePublicRoot, computeKARoot, computeKCRoot } from '../src/merkle.js';
import { autoPartition } from '../src/auto-partition.js';
import { parseSimpleNQuads } from '../src/publish-handler.js';

const PARANET = 'agent-skills';
const GRAPH = `did:dkg:paranet:${PARANET}`;
const ENTITY = 'did:dkg:agent:QmImageBot';
const TEST_WALLET = ethers.Wallet.createRandom();
const TEST_PUBLISHER_ADDRESS = TEST_WALLET.address;

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('End-to-end: Publish → Replicate → Query', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  it('publishes on node A, replicates to node B, queries on B', async () => {
    // === Setup Node A (publisher) ===
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

    // Connect
    await nodeA.libp2p.dial(multiaddr(nodeB.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 500));

    // Stores
    const storeA = new OxigraphStore();
    const storeB = new OxigraphStore();
    const chainA = new MockChainAdapter('mock:31337', TEST_PUBLISHER_ADDRESS);
    const busA = new TypedEventBus();
    const busB = new TypedEventBus();
    const keypairA = await generateEd25519Keypair();
    const keypairB = await generateEd25519Keypair();

    // Publisher on A
    const publisherA = new DKGPublisher({
      store: storeA,
      chain: chainA,
      eventBus: busA,
      keypair: keypairA,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    const publishHandlerB = new PublishHandler(storeB, busB);
    const routerB = new ProtocolRouter(nodeB);
    routerB.register(PROTOCOL_PUBLISH, publishHandlerB.handler);

    // Router on A for sending
    const routerA = new ProtocolRouter(nodeA);

    // === Step 1: Publish on Node A ===
    const publishResult = await publisherA.publish({
      paranetId: PARANET,
      quads: [
        q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
        q(ENTITY, 'http://schema.org/description', '"AI image analysis agent"'),
        q(ENTITY, 'http://ex.org/offers', `${ENTITY}/.well-known/genid/o1`),
        q(`${ENTITY}/.well-known/genid/o1`, 'http://ex.org/skill', '"ImageAnalysis"'),
      ],
    });

    expect(publishResult.merkleRoot).toHaveLength(32);
    expect(publishResult.kaManifest).toHaveLength(1);
    expect(publishResult.status).toBe('confirmed');

    // === Step 2: Replicate to Node B via protocol ===
    const nquads = [
      `<${ENTITY}> <http://schema.org/name> "ImageBot" <${GRAPH}> .`,
      `<${ENTITY}> <http://schema.org/description> "AI image analysis agent" <${GRAPH}> .`,
      `<${ENTITY}> <http://ex.org/offers> <${ENTITY}/.well-known/genid/o1> <${GRAPH}> .`,
      `<${ENTITY}/.well-known/genid/o1> <http://ex.org/skill> "ImageAnalysis" <${GRAPH}> .`,
    ].join('\n');

    const onChain = publishResult.onChainResult!;
    const publishRequest = encodePublishRequest({
      ual: `did:dkg:mock:31337/${onChain.publisherAddress}/${onChain.startKAId}`,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: publishResult.kaManifest.map((m) => ({
        tokenId: Number(m.tokenId),
        rootEntity: m.rootEntity,
        privateMerkleRoot: m.privateMerkleRoot ?? new Uint8Array(0),
        privateTripleCount: m.privateTripleCount ?? 0,
      })),
      publisherIdentity: keypairA.publicKey,
      publisherAddress: onChain.publisherAddress,
      startKAId: Number(onChain.startKAId),
      endKAId: Number(onChain.endKAId),
      chainId: chainA.chainId,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const ackData = await routerA.send(
      nodeB.peerId,
      PROTOCOL_PUBLISH,
      publishRequest,
    );
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);

    // === Step 3: Query on Node B ===
    const engineB = new DKGQueryEngine(storeB);
    const queryResult = await engineB.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET },
    );

    expect(queryResult.bindings).toHaveLength(1);
    expect(queryResult.bindings[0]['name']).toContain('ImageBot');

    // Query for skills
    const skillResult = await engineB.query(
      'SELECT ?skill WHERE { ?s <http://ex.org/skill> ?skill }',
      { paranetId: PARANET },
    );
    expect(skillResult.bindings).toHaveLength(1);
    expect(skillResult.bindings[0]['skill']).toContain('ImageAnalysis');
  }, 20000);

  it('publishes with private triples and accesses them', async () => {
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

    const storeA = new OxigraphStore();
    const chainA = new MockChainAdapter('mock:31337', TEST_PUBLISHER_ADDRESS);
    const busA = new TypedEventBus();
    const keypairA = await generateEd25519Keypair();
    const keypairB = await generateEd25519Keypair();

    // Publisher on A (holds private triples)
    const publisherA = new DKGPublisher({
      store: storeA,
      chain: chainA,
      eventBus: busA,
      keypair: keypairA,
      publisherPrivateKey: TEST_WALLET.privateKey,
      publisherNodeIdentityId: 1n,
    });

    // Publish with mixed public/private triples
    const result = await publisherA.publish({
      paranetId: PARANET,
      quads: [q(ENTITY, 'http://schema.org/name', '"ImageBot"')],
      privateQuads: [
        q(ENTITY, 'http://ex.org/apiKey', '"secret-key-xyz"'),
        q(ENTITY, 'http://ex.org/modelWeights', '"s3://bucket/weights.bin"'),
      ],
      publisherPeerId: nodeB.peerId,
    });

    expect(result.kaManifest[0].privateTripleCount).toBe(2);
    expect(result.status).toBe('confirmed');

    // Register access handler on A
    const accessHandler = new AccessHandler(storeA, busA);
    const routerA = new ProtocolRouter(nodeA);
    routerA.register(PROTOCOL_ACCESS, accessHandler.handler);

    // AccessClient on B requests private triples from A
    const routerB = new ProtocolRouter(nodeB);
    const accessClient = new AccessClient(routerB, keypairB, nodeB.peerId);

    const onChain = result.onChainResult!;
    const accessResult = await accessClient.requestAccess(
      nodeA.peerId,
      `did:dkg:mock:31337/${onChain.publisherAddress}/${onChain.startKAId}/1`,
    );

    expect(accessResult.granted).toBe(true);
    expect(accessResult.quads.length).toBeGreaterThanOrEqual(2);

    const apiKeyTriple = accessResult.quads.find(
      (q) => q.predicate === 'http://ex.org/apiKey',
    );
    expect(apiKeyTriple).toBeDefined();
  }, 20000);
});

describe('Publisher wallet signature verification', () => {
  const signerWallet = ethers.Wallet.createRandom();
  const imposterWallet = ethers.Wallet.createRandom();
  const CHAIN_ID = 'mock:31337';

  function buildSignedRequest(
    quads: Quad[],
    wallet: ethers.Wallet,
    claimedAddress: string,
    startKAId: number,
    endKAId: number,
  ) {
    const kaMap = autoPartition(quads);
    const kaRoots: Uint8Array[] = [];
    for (const [, publicQuads] of kaMap) {
      const pubRoot = computePublicRoot(publicQuads);
      kaRoots.push(computeKARoot(pubRoot!, undefined));
    }
    const merkleRoot = computeKCRoot(kaRoots);

    const nquads = quads.map(
      (q) => `<${q.subject}> <${q.predicate}> ${q.object.startsWith('"') ? q.object : `<${q.object}>`} <${q.graph}> .`,
    ).join('\n');

    return { merkleRoot, nquads, wallet, claimedAddress, startKAId, endKAId };
  }

  async function signCommitment(
    merkleRoot: Uint8Array,
    publisherAddress: string,
    startKAId: number,
    endKAId: number,
    chainId: string,
    paranetId: string,
    wallet: ethers.Wallet,
  ) {
    const commitHash = ethers.solidityPackedKeccak256(
      ['bytes32', 'address', 'uint64', 'uint64', 'string', 'string'],
      [ethers.hexlify(merkleRoot), publisherAddress, startKAId, endKAId, chainId, paranetId],
    );
    const rawSig = await wallet.signMessage(ethers.getBytes(commitHash));
    const { r, yParityAndS } = ethers.Signature.from(rawSig);
    return { r: ethers.getBytes(r), vs: ethers.getBytes(yParityAndS) };
  }

  it('accepts publish request with valid publisher wallet signature', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q(ENTITY, 'http://schema.org/name', '"SigBot"')];
    const { merkleRoot, nquads } = buildSignedRequest(
      testQuads, signerWallet, signerWallet.address, 1, 1,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 1, 1, CHAIN_ID, PARANET, signerWallet,
    );

    const reqBytes = encodePublishRequest({
      ual: `did:dkg:${CHAIN_ID}/${signerWallet.address}/1`,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: ENTITY, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 1,
      endKAId: 1,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);
  });

  it('accepts publish request even with mismatched wallet sig (verified on-chain, not P2P)', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q(ENTITY, 'http://schema.org/name', '"SigBot"')];
    const { merkleRoot, nquads } = buildSignedRequest(
      testQuads, imposterWallet, signerWallet.address, 1, 1,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 1, 1, CHAIN_ID, PARANET, imposterWallet,
    );

    const reqBytes = encodePublishRequest({
      ual: `did:dkg:${CHAIN_ID}/${signerWallet.address}/1`,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: ENTITY, privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 1,
      endKAId: 1,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    // Publisher identity is now verified on-chain (msg.sender), not at the P2P layer.
    // The handler accepts the data tentatively; confirmation comes from chain events.
    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);
  });

  it('accepts publish request with no signature (optional for P2P-only mode)', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q('did:dkg:agent:QmNoSig', 'http://schema.org/name', '"NoSigBot"')];
    const { nquads } = buildSignedRequest(
      testQuads, signerWallet, signerWallet.address, 0, 0,
    );

    const reqBytes = encodePublishRequest({
      ual: `did:dkg:${CHAIN_ID}/${signerWallet.address}/0`,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmNoSig', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: '',
      startKAId: 0,
      endKAId: 0,
      chainId: CHAIN_ID,
      publisherSignatureR: new Uint8Array(0),
      publisherSignatureVs: new Uint8Array(0),
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);
  });

  it('confirmPublish verifies on-chain data matches expectations', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q('did:dkg:agent:QmConfirm', 'http://schema.org/name', '"ConfirmBot"')];
    const { merkleRoot, nquads } = buildSignedRequest(
      testQuads, signerWallet, signerWallet.address, 5, 5,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 5, 5, CHAIN_ID, PARANET, signerWallet,
    );

    const ual = `did:dkg:${CHAIN_ID}/${signerWallet.address}/5`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmConfirm', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 5,
      endKAId: 5,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    const ackData = await handler.handler(reqBytes, 'test-peer' as any);
    const ack = decodePublishAck(ackData);
    expect(ack.accepted).toBe(true);

    // Confirm with matching on-chain data
    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress: signerWallet.address,
      merkleRoot,
      startKAId: 5n,
      endKAId: 5n,
    });
    expect(confirmed).toBe(true);
  });

  it('confirmPublish promotes tentative to confirmed in meta graph (no tentative left)', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q('did:dkg:agent:QmPromote', 'http://schema.org/name', '"PromoteBot"')];
    const { merkleRoot, nquads } = buildSignedRequest(
      testQuads, signerWallet, signerWallet.address, 7, 7,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 7, 7, CHAIN_ID, PARANET, signerWallet,
    );

    const ual = `did:dkg:${CHAIN_ID}/${signerWallet.address}/7`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmPromote', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 7,
      endKAId: 7,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    await handler.handler(reqBytes, 'test-peer' as any);

    const metaGraph = `did:dkg:paranet:${PARANET}/_meta`;
    let statusResult = await store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(statusResult.type).toBe('bindings');
    if (statusResult.type === 'bindings') {
      const statuses = statusResult.bindings.map((b) => b['status']);
      expect(statuses).toContainEqual(expect.stringMatching(/tentative/));
    }

    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress: signerWallet.address,
      merkleRoot,
      startKAId: 7n,
      endKAId: 7n,
    });
    expect(confirmed).toBe(true);

    statusResult = await store.query(
      `SELECT ?status WHERE { GRAPH <${metaGraph}> { <${ual}> <http://dkg.io/ontology/status> ?status } }`,
    );
    expect(statusResult.type).toBe('bindings');
    if (statusResult.type === 'bindings') {
      const statuses = statusResult.bindings.map((b) => b['status']);
      expect(statuses).toHaveLength(1);
      expect(statuses[0]).toMatch(/confirmed/);
      expect(statuses.some((s) => s.includes('tentative'))).toBe(false);
    }
  });

  it('receiver recomputes same merkle root from parsed nquads as sender', async () => {
    const quads: Quad[] = [
      q('did:dkg:agent:QmRootMatch', 'http://schema.org/name', '"RootMatch"'),
      q('did:dkg:agent:QmRootMatch', 'http://schema.org/version', '"1"'),
    ];
    const { merkleRoot, nquads } = buildSignedRequest(
      quads, signerWallet, signerWallet.address, 11, 11,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 11, 11, CHAIN_ID, PARANET, signerWallet,
    );

    const reqBytes = encodePublishRequest({
      ual: `did:dkg:${CHAIN_ID}/${signerWallet.address}/11`,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [
        { tokenId: 1, rootEntity: 'did:dkg:agent:QmRootMatch', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 },
      ],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 11,
      endKAId: 11,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    const request = decodePublishRequest(reqBytes);
    const nquadsStr = new TextDecoder().decode(request.nquads);
    const parsedQuads = parseSimpleNQuads(nquadsStr);

    const kaMap = autoPartition(parsedQuads);
    const kaRoots: Uint8Array[] = [];
    for (const entry of request.kas) {
      const publicQuads = kaMap.get(entry.rootEntity) ?? [];
      const pubRoot = computePublicRoot(publicQuads);
      kaRoots.push(computeKARoot(pubRoot!, undefined));
    }
    const recomputedRoot = computeKCRoot(kaRoots);

    expect(recomputedRoot).toEqual(merkleRoot);
  });

  it('confirmPublish rejects when on-chain publisher address mismatches', async () => {
    const store = new OxigraphStore();
    const bus = new TypedEventBus();
    const handler = new PublishHandler(store, bus);

    const testQuads = [q('did:dkg:agent:QmMismatch', 'http://schema.org/name', '"MismatchBot"')];
    const { merkleRoot, nquads } = buildSignedRequest(
      testQuads, signerWallet, signerWallet.address, 10, 10,
    );

    const sig = await signCommitment(
      merkleRoot, signerWallet.address, 10, 10, CHAIN_ID, PARANET, signerWallet,
    );

    const ual = `did:dkg:${CHAIN_ID}/${signerWallet.address}/10`;
    const reqBytes = encodePublishRequest({
      ual,
      nquads: new TextEncoder().encode(nquads),
      paranetId: PARANET,
      kas: [{ tokenId: 1, rootEntity: 'did:dkg:agent:QmMismatch', privateMerkleRoot: new Uint8Array(0), privateTripleCount: 0 }],
      publisherIdentity: new Uint8Array(32),
      publisherAddress: signerWallet.address,
      startKAId: 10,
      endKAId: 10,
      chainId: CHAIN_ID,
      publisherSignatureR: sig.r,
      publisherSignatureVs: sig.vs,
    });

    await handler.handler(reqBytes, 'test-peer' as any);

    // Try to confirm with a different publisher address
    const confirmed = await handler.confirmPublish(ual, {
      publisherAddress: imposterWallet.address,
      merkleRoot,
      startKAId: 10n,
      endKAId: 10n,
    });
    expect(confirmed).toBe(false);
  });
});
