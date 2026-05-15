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
  const typed = buildAuthorAttestationTypedData({
    chainId: await chain.getEvmChainId(),
    kav10Address: await chain.getKnowledgeAssetsV10Address(),
    contextGraphId,
    merkleRoot: canonical.kcMerkleRoot,
    authorAddress: author.address,
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
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
  };
}

describe('publisher trust metadata', () => {
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
      participantIdentityIds: [1n],
      requiredSignatures: 1,
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
    });

    expect(result.status).toBe('confirmed');
    const trust = await store.query(
      `SELECT ?subject ?level WHERE {
        GRAPH <did:dkg:context-graph:${contextGraphId}> {
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
