import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter, NoChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AUTHOR_SCHEME_VERSION_V1,
  TRUST_LEVEL_PREDICATE,
  TrustLevel,
  TypedEventBus,
  buildAuthorAttestationTypedData,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, canonicalPublishPayload } from '../src/index.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

function quad(subject: string, predicate = 'http://schema.org/name', object = '"Root"'): Quad {
  return { subject, predicate, object, graph: '' };
}

async function makePublisher(chain = new NoChainAdapter(), wallet?: ethers.Wallet) {
  const keypair = await generateEd25519Keypair();
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair,
    publisherPrivateKey: wallet?.privateKey,
    publisherNodeIdentityId: wallet ? 1n : 0n,
  });
  return { publisher, store };
}

async function buildSeal(
  chain: MockChainAdapter,
  contextGraphId: bigint,
  quads: Quad[],
  author: ethers.Wallet,
) {
  const canonical = canonicalPublishPayload(quads, []);
  // §F2 — the digest binds the packed reservedKaId and the mock mints exactly
  // it; the test unpacks {author,number} from the returned kaId. A fresh
  // random `author` per test means number=1 never collides.
  const reservedKaId = (BigInt(ethers.getAddress(author.address)) << 96n) | 1n;
  const typed = buildAuthorAttestationTypedData({
    chainId: await chain.getEvmChainId(),
    kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    merkleRoot: canonical.kcMerkleRoot,
    authorAddress: author.address,
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    reservedKaId,
  });
  const sig = ethers.Signature.from(await author.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  ));
  return {
    expectedMerkleRoot: canonical.kcMerkleRoot,
    authorAddress: author.address,
    signature: {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    reservedKaId,
  };
}

describe('publisher trust metadata', () => {
  it.each([
    ['bare', TRUST_LEVEL_PREDICATE],
    ['in angle brackets', `<${TRUST_LEVEL_PREDICATE}>`],
  ])('rejects a user-authored trustLevel predicate %s on every write entry point, writing nothing', async (_form, predicate) => {
    const { publisher, store } = await makePublisher();
    const trustQuad = quad('urn:trust:user', predicate, `"${TrustLevel.ConsensusVerified}"`);
    const refused = /User-authored dkg:trustLevel metadata is not allowed/;
    const before = await store.countQuads();

    await expect(publisher.publish({ contextGraphId: 'trust-cg', quads: [trustQuad] })).rejects.toThrow(refused);
    await expect(publisher.share('trust-cg', [trustQuad], { publisherPeerId: 'peer-a' })).rejects.toThrow(refused);
    await expect(publisher.conditionalShare('trust-cg', [trustQuad], { publisherPeerId: 'peer-a', conditions: [] }))
      .rejects.toThrow(refused);
    await expect(publisher.assertionWrite('trust-cg', 'draft', '0xabc', [trustQuad])).rejects.toThrow(refused);
    await expect(publisher.assertionWritePrivate('trust-cg', 'draft', '0xabc', [trustQuad])).rejects.toThrow(refused);
    expect(await store.countQuads()).toBe(before);
  });

  it.each([
    ['bare', 'urn:dkg:file:user'],
    ['in angle brackets', '<urn:dkg:file:user>'],
  ])('rejects a subject in a reserved namespace %s on every write entry point, writing nothing', async (_form, subject) => {
    const { publisher, store } = await makePublisher();
    const reserved = quad(subject);
    const before = await store.countQuads();

    await expect(publisher.publish({ contextGraphId: 'trust-cg', quads: [reserved] })).rejects.toThrow(/reserved namespace/);
    await expect(publisher.share('trust-cg', [reserved], { publisherPeerId: 'peer-a' })).rejects.toThrow(/reserved namespace/);
    await expect(publisher.assertionWrite('trust-cg', 'draft', '0xabc', [reserved])).rejects.toThrow(/reserved namespace/);
    await expect(publisher.assertionWritePrivate('trust-cg', 'draft', '0xabc', [reserved])).rejects.toThrow(/reserved namespace/);
    expect(await store.countQuads()).toBe(before);
  });

  it('rejects user-authored trustLevel quads in publish and SWM inputs', async () => {
    const { publisher } = await makePublisher();
    const trustQuad = quad('urn:trust:user', TRUST_LEVEL_PREDICATE, `"${TrustLevel.ConsensusVerified}"`);

    await expect(
      publisher.publish({
        contextGraphId: 'trust-cg',
        quads: [trustQuad],
      }),
    ).rejects.toThrow(/User-authored dkg:trustLevel metadata is not allowed/);

    await expect(
      publisher.share('trust-cg', [trustQuad], { publisherPeerId: 'peer-a' }),
    ).rejects.toThrow(/User-authored dkg:trustLevel metadata is not allowed/);

    await expect(
      publisher.assertionWrite('trust-cg', 'draft', '0xabc', [trustQuad]),
    ).rejects.toThrow(/User-authored dkg:trustLevel metadata is not allowed/);
  });

  it('stamps confirmed publish subjects as SelfAttested', async () => {
    const wallet = ethers.Wallet.createRandom();
    const chain = new MockChainAdapter('mock:31337', wallet.address);
    chain.seedIdentity(wallet.address, 1n);
    const created = await chain.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      metadataBatchId: 0n,
    });
    const contextGraphId = created.contextGraphId;
    const { publisher, store } = await makePublisher(chain, wallet);
    const quads = [
      quad('urn:trust:published-root'),
      quad('urn:trust:published-root/.well-known/genid/child', 'http://schema.org/value', '"Child"'),
    ];

    const result = await publisher.publish({
      contextGraphId: String(contextGraphId),
      quads,
      precomputedAttestation: await buildSeal(chain, contextGraphId, quads, wallet),
      v10ACKProvider: mockChainStubACKProvider({ identityId: 1n }),
    });

    expect(result.status).toBe('confirmed');
    // rc.17 uniform per-KA layout: a confirmed publish stamps TrustLevel on the
    // per-KA verifiable-memory graph …/_verifiable_memory/{author}/{number}, NOT the
    // legacy monolithic root data graph. author+number are unpacked from the
    // minted kaId returned in the publish result.
    const vmNumber = result.kaId & ((1n << 96n) - 1n);
    const vmAuthor = `0x${(result.kaId >> 96n).toString(16).padStart(40, '0')}`;
    const vmGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${vmAuthor}/${vmNumber}`;
    const trust = await store.query(
      `SELECT ?subject ?level WHERE {
        GRAPH <${vmGraph}> {
          VALUES ?subject {
            <urn:trust:published-root>
            <urn:trust:published-root/.well-known/genid/child>
          }
          ?subject <${TRUST_LEVEL_PREDICATE}> ?level .
        }
      }`,
    );
    expect(trust.type).toBe('bindings');
    expect(trust.type === 'bindings' ? trust.bindings.map((row) => row.level).sort() : [])
      .toEqual([
        `"${TrustLevel.SelfAttested}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        `"${TrustLevel.SelfAttested}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
      ]);
  });
});
