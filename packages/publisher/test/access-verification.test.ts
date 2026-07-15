/**
 * Tests for I-005: Access protocol signature verification.
 *
 * Verifies that:
 * - ed25519 signature verification is actually performed (not a no-op)
 * - Non-public policies require a signature + public key
 * - Empty signatures are rejected for non-public policies
 * - Valid signatures pass verification
 * - Invalid signatures are rejected
 * - Public access works without signature
 */
import { describe, it, expect } from 'vitest';
import {
  TypedEventBus,
  generateEd25519Keypair,
  ed25519Sign,
  encodeAccessRequest,
  decodeAccessRequest,
  decodeAccessResponse,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, GraphManager, PrivateContentStore, type Quad } from '@origintrail-official/dkg-storage';
import { AccessHandler } from '../src/access-handler.js';
import { generateGraphKnowledgeAssetMetadata } from '../src/metadata.js';
import { computePrivateRootV10 } from '../src/merkle.js';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from '../src/workspace-resolution.js';

const CONTEXT_GRAPH = 'test-access-verify';
const META_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_meta`;
const PRIVATE_GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}/_private`;
const DKG = 'http://dkg.io/ontology/';
const ENTITY = 'did:dkg:agent:TestEntity';
const KC_UAL = 'did:dkg:mock:31337/0x1/1';
const KA_UAL = `${KC_UAL}/${ENTITY}`;

function mq(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

function lit(s: string): string {
  return `"${s}"`;
}

async function setupStoreWithPolicy(
  policy: string,
  publisherPeerId?: string,
  allowedPeers?: string[],
): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  const gm = new GraphManager(store);
  await gm.ensureContextGraph(CONTEXT_GRAPH);

  // KA metadata in meta graph
  await store.insert([
    mq(KA_UAL, `${DKG}rootEntity`, ENTITY, META_GRAPH),
    mq(KA_UAL, `${DKG}partOf`, KC_UAL, META_GRAPH),
    mq(KC_UAL, `${DKG}contextGraph`, `did:dkg:context-graph:${CONTEXT_GRAPH}`, META_GRAPH),
    mq(KC_UAL, `${DKG}accessPolicy`, lit(policy), META_GRAPH),
    mq(KC_UAL, `${DKG}status`, lit('confirmed'), META_GRAPH),
  ]);

  if (publisherPeerId) {
    await store.insert([
      mq(KC_UAL, `${DKG}publisherPeerId`, lit(publisherPeerId), META_GRAPH),
    ]);
  }

  if (allowedPeers?.length) {
    await store.insert(
      allowedPeers.map((peerId) => mq(KC_UAL, `${DKG}allowedPeer`, lit(peerId), META_GRAPH)),
    );
  }

  // Private data in the correct private graph
  await store.insert([
    mq(ENTITY, 'http://ex.org/secret', lit('secret-value'), PRIVATE_GRAPH),
  ]);

  return store;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('I-005: Proto round-trip for requesterPublicKey', () => {
  it('encodes and decodes requesterPublicKey correctly', () => {
    const pubKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
      17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]);
    const sig = new Uint8Array([99, 100, 101]);

    const encoded = encodeAccessRequest({
      kaUal: 'test-ual',
      requesterPeerId: 'peer-1',
      paymentProof: new Uint8Array(0),
      requesterSignature: sig,
      requesterPublicKey: pubKey,
    });

    const decoded = decodeAccessRequest(encoded);
    expect(decoded.kaUal).toBe('test-ual');
    expect(decoded.requesterPeerId).toBe('peer-1');

    const decodedPK = decoded.requesterPublicKey;
    expect(decodedPK).toBeDefined();
    expect(decodedPK!.length).toBe(32);
    expect(Array.from(new Uint8Array(decodedPK!))).toEqual(Array.from(pubKey));
  });

  it('omitted requesterPublicKey decodes as empty or undefined', () => {
    const encoded = encodeAccessRequest({
      kaUal: 'test-ual',
      requesterPeerId: 'peer-1',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const decoded = decodeAccessRequest(encoded);
    const pk = decoded.requesterPublicKey;
    const len = pk ? pk.length : 0;
    expect(len).toBe(0);
  });
});

describe('I-005: Access handler signature verification', () => {
  it('rejects empty signature for ownerOnly policy', async () => {
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'owner-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'owner-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('signature required');
  });

  it('rejects missing public key for ownerOnly policy', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const message = new TextEncoder().encode(KA_UAL + toHex(new Uint8Array(0)));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'owner-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: signature,
    });

    const resBytes = await handler.handler(reqBytes, 'owner-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('public key required');
  });

  it('rejects invalid signature for ownerOnly policy', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const wrongMessage = new TextEncoder().encode('wrong-message');
    const invalidSig = await ed25519Sign(wrongMessage, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'owner-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: invalidSig,
      requesterPublicKey: keypair.publicKey,
    });

    const resBytes = await handler.handler(reqBytes, 'owner-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('invalid signature');
  });

  it('accepts valid signature for ownerOnly policy from owner peer', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const paymentProof = new Uint8Array(0);
    const message = new TextEncoder().encode(KA_UAL + toHex(paymentProof));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'owner-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    });

    const resBytes = await handler.handler(reqBytes, 'owner-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(true);
    expect(res.nquads.length).toBeGreaterThan(0);
  });

  it('rejects valid signature but wrong peer for ownerOnly policy', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const paymentProof = new Uint8Array(0);
    const message = new TextEncoder().encode(KA_UAL + toHex(paymentProof));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'wrong-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    });

    // Signature is valid but peer is wrong — should fail on owner-only check
    const resBytes = await handler.handler(reqBytes, 'wrong-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('owner-only');
  });

  it('allows public access without signature', async () => {
    const store = await setupStoreWithPolicy('public');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'any-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'any-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(true);
  });

  it('rejects unknown explicit access policy values', async () => {
    const store = await setupStoreWithPolicy('totallyUnknownPolicy');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'any-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'any-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('invalid access policy metadata');
  });

  it('rejects allowList access when allowed peer list is missing', async () => {
    const store = await setupStoreWithPolicy('allowList', 'publisher-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'some-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'some-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('allow list missing or empty');
  });

  it('allows allowList peer with valid signature', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('allowList', 'publisher-peer', ['allowed-peer']);
    const handler = new AccessHandler(store, new TypedEventBus());

    const paymentProof = new Uint8Array(0);
    const message = new TextEncoder().encode(KA_UAL + toHex(paymentProof));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'allowed-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    });

    const resBytes = await handler.handler(reqBytes, 'allowed-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(true);
    expect(res.nquads.length).toBeGreaterThan(0);
  });

  it('ignores poisoned allowList entries outside _meta graph', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('allowList', 'publisher-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    // Attempt graph poisoning: write allow-list entry into non-meta graph.
    await store.insert([
      mq(KC_UAL, `${DKG}allowedPeer`, lit('attacker-peer'), `did:dkg:context-graph:${CONTEXT_GRAPH}`),
    ]);

    const paymentProof = new Uint8Array(0);
    const message = new TextEncoder().encode(KA_UAL + toHex(paymentProof));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'attacker-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    });

    const resBytes = await handler.handler(reqBytes, 'attacker-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('allow list missing or empty');
  });
});

describe('graph-scoped private access', () => {
  it('serves the exact assertion-version private graph through its durable head', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const privateStore = new PrivateContentStore(store, graphManager);
    const ual = 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/9';
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const privateQuads: Quad[] = [{
      subject: 'urn:rootless:private',
      predicate: 'urn:p:secret',
      object: '"exact-version-secret"',
      graph: '',
    }];
    const privateMerkleRoot = computePrivateRootV10(privateQuads)!;
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      privateQuads,
    );
    await storeKnowledgeAssetOperationPublicQuads({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: 'graph-access-share',
      kaUal: ual,
      assertionVersion: scope.assertionVersion,
      quads: [],
      privateMerkleRoot,
      privateTripleCount: privateQuads.length,
      publisherPeerId: 'owner-peer',
      accessPolicy: 'public',
    });
    await storeKnowledgeAssetWorkspaceHead({
      store,
      graphManager,
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: 'graph-access-share',
      kaUal: ual,
      assertionVersion: scope.assertionVersion,
    });

    const request = encodeAccessRequest({
      kaUal: ual,
      requesterPeerId: 'reader-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });
    const response = decodeAccessResponse(
      await new AccessHandler(store, new TypedEventBus()).handler(request, 'reader-peer' as any),
    );

    expect(response.granted).toBe(true);
    expect(new TextDecoder().decode(response.nquads)).toContain('exact-version-secret');
    expect(toHex(response.privateMerkleRoot)).toBe(toHex(privateMerkleRoot));
  });

  it('serves a direct confirmed allow-list publish without a StorageACK workspace head', async () => {
    const store = new OxigraphStore();
    const graphManager = new GraphManager(store);
    const privateStore = new PrivateContentStore(store, graphManager);
    const ual = 'did:dkg:mock:31337/0x2222222222222222222222222222222222222222/10';
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    const privateQuads: Quad[] = [{
      subject: 'urn:direct:private',
      predicate: 'urn:p:secret',
      object: '"direct-only-secret"',
      graph: '',
    }];
    const privateMerkleRoot = computePrivateRootV10(privateQuads)!;
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      CONTEXT_GRAPH,
      scope,
      privateQuads,
    );
    await store.insert(generateGraphKnowledgeAssetMetadata({
      ual,
      contextGraphId: CONTEXT_GRAPH,
      merkleRoot: privateMerkleRoot,
      publisherPeerId: 'owner-peer',
      accessPolicy: 'allowList',
      allowedPeers: ['reader-peer'],
      timestamp: new Date(0),
      assertionVersion: scope.assertionVersion,
      publicTripleCount: 0,
      privateTripleCount: privateQuads.length,
      privateMerkleRoot,
      assertionGraph: knowledgeAssetLayerGraphUri(
        CONTEXT_GRAPH,
        MemoryLayer.VerifiableMemory,
        scope,
      ),
    }, 'confirmed', {
      txHash: `0x${'11'.repeat(32)}`,
      blockNumber: 1,
      blockTimestamp: 1,
      publisherAddress: '0x2222222222222222222222222222222222222222',
      batchId: 10n,
      chainId: 'mock:31337',
    }));

    const handler = new AccessHandler(store, new TypedEventBus());
    const denied = decodeAccessResponse(await handler.handler(encodeAccessRequest({
      kaUal: ual,
      requesterPeerId: 'intruder-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    }), 'intruder-peer' as any));
    expect(denied.granted).toBe(false);
    expect(denied.rejectionReason).toContain('not on allow list');

    const keypair = await generateEd25519Keypair();
    const paymentProof = new Uint8Array(0);
    const signature = await ed25519Sign(
      new TextEncoder().encode(ual + toHex(paymentProof)),
      keypair.secretKey,
    );
    const granted = decodeAccessResponse(await handler.handler(encodeAccessRequest({
      kaUal: ual,
      requesterPeerId: 'reader-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    }), 'reader-peer' as any));

    expect(granted.granted).toBe(true);
    expect(new TextDecoder().decode(granted.nquads)).toContain('direct-only-secret');
    expect(toHex(granted.privateMerkleRoot)).toBe(toHex(privateMerkleRoot));
  });
});

describe('I-005: Policy checks run before signature verification (perf + clarity)', () => {
  it('ownerOnly: wrong peer rejected with owner-only error, not signature error', async () => {
    const store = await setupStoreWithPolicy('ownerOnly', 'real-owner');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'wrong-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'wrong-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('owner-only');
    expect(res.rejectionReason).not.toContain('signature');
  });

  it('ownerOnly: wrong peer with valid signature still fails on policy, not signature', async () => {
    const keypair = await generateEd25519Keypair();
    const store = await setupStoreWithPolicy('ownerOnly', 'real-owner');
    const handler = new AccessHandler(store, new TypedEventBus());

    const paymentProof = new Uint8Array(0);
    const message = new TextEncoder().encode(KA_UAL + toHex(paymentProof));
    const signature = await ed25519Sign(message, keypair.secretKey);

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'wrong-peer',
      paymentProof,
      requesterSignature: signature,
      requesterPublicKey: keypair.publicKey,
    });

    const resBytes = await handler.handler(reqBytes, 'wrong-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('owner-only');
  });

  it('ownerOnly: correct peer still needs valid signature', async () => {
    const store = await setupStoreWithPolicy('ownerOnly', 'owner-peer');
    const handler = new AccessHandler(store, new TypedEventBus());

    const reqBytes = encodeAccessRequest({
      kaUal: KA_UAL,
      requesterPeerId: 'owner-peer',
      paymentProof: new Uint8Array(0),
      requesterSignature: new Uint8Array(0),
    });

    const resBytes = await handler.handler(reqBytes, 'owner-peer' as any);
    const res = decodeAccessResponse(resBytes);

    expect(res.granted).toBe(false);
    expect(res.rejectionReason).toContain('signature required');
  });
});
