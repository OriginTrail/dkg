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
} from '@dkg/core';
import { OxigraphStore, GraphManager, type Quad } from '@dkg/storage';
import { AccessHandler } from '../src/access-handler.js';

const PARANET = 'test-access-verify';
const META_GRAPH = `did:dkg:paranet:${PARANET}/_meta`;
const PRIVATE_GRAPH = `did:dkg:paranet:${PARANET}/_private`;
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
  await gm.ensureParanet(PARANET);

  // KA metadata in meta graph
  await store.insert([
    mq(KA_UAL, `${DKG}rootEntity`, ENTITY, META_GRAPH),
    mq(KA_UAL, `${DKG}partOf`, KC_UAL, META_GRAPH),
    mq(KC_UAL, `${DKG}paranet`, `did:dkg:paranet:${PARANET}`, META_GRAPH),
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
      mq(KC_UAL, `${DKG}allowedPeer`, lit('attacker-peer'), `did:dkg:paranet:${PARANET}`),
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
