/**
 * OT-RFC-40 PR-4 — verify that `dkg-publisher.ts` honours the chain
 * adapter's `mintingStorageTag` field when constructing UALs.
 *
 * Behaviour pinned:
 *  1. Default-storage adapters (`mintingStorageTag === ""`) produce
 *     the legacy 3-segment UAL form bit-for-bit. This is the test
 *     that all 1046 pre-RFC publisher tests implicitly assert; it's
 *     repeated here as an explicit, documented contract.
 *  2. Storage-tagged adapters (`mintingStorageTag === "v2"`) produce
 *     the 4-segment UAL form. This is the new behaviour PR-4 enables.
 *
 * The shape of the UAL is what routes the resolver in PR-5; everything
 * downstream of the publish path (publish-handler, store.nq subjects,
 * ChainEventPoller's UAL parsing) trusts the form produced by these
 * exact lines in `dkg-publisher.ts`. Pinning both shapes here ensures
 * future refactors (e.g. content-addressed identity in the followup
 * RFC) cannot silently regress either.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import {
  AUTHOR_SCHEME_VERSION_V1,
  TypedEventBus,
  buildAuthorAttestationTypedData,
  generateEd25519Keypair,
  parseUal,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher, canonicalPublishPayload } from '../src/index.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

function quad(subject: string, predicate = 'http://schema.org/name', object = '"Root"'): Quad {
  return { subject, predicate, object, graph: '' };
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

async function publishOnce(opts: { storageTag: string }): Promise<string> {
  const wallet = ethers.Wallet.createRandom();
  const chain = new MockChainAdapter('mock:31337', wallet.address);
  chain.setMintingStorageTag(opts.storageTag);
  chain.seedIdentity(wallet.address, 1n);
  const created = await chain.createOnChainContextGraph({
    accessPolicy: 0,
    publishPolicy: 1,
    metadataBatchId: 0n,
  });
  const contextGraphId = created.contextGraphId;

  const keypair = await generateEd25519Keypair();
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair,
    publisherPrivateKey: wallet.privateKey,
    publisherNodeIdentityId: 1n,
  });

  const quads = [quad('urn:test:rfc40-pr4-root')];
  const result = await publisher.publish({
    contextGraphId: String(contextGraphId),
    quads,
    precomputedAttestation: await buildSeal(chain, contextGraphId, quads, wallet),
    v10ACKProvider: mockChainStubACKProvider({ identityId: 1n }),
  });
  expect(result.status).toBe('confirmed');
  return result.ual;
}

describe('OT-RFC-40 PR-4 — minting UAL respects ChainAdapter.mintingStorageTag', () => {
  it('default-storage adapter produces a 3-segment UAL bit-for-bit equivalent to the pre-RFC output', async () => {
    const ual = await publishOnce({ storageTag: '' });
    // mock:31337/<pub>/<startKAId> shape — segment count check against
    // the parser is the most stable form-assertion we can make here
    // since the publisher address and KA id are runtime-generated.
    expect(ual.startsWith('did:dkg:mock:31337/0x')).toBe(true);
    const parsed = parseUal(ual);
    expect(parsed).not.toBeNull();
    expect(parsed!.storageTag).toBe('');
    expect(parsed!.chainId).toBe('mock:31337');
    // 3-segment form: nothing between the prefix and the chainId.
    const afterPrefix = ual.slice('did:dkg:'.length);
    expect(afterPrefix.split('/')).toHaveLength(3);
  });

  it('tagged-storage adapter produces a 4-segment UAL with the tag in slot 1', async () => {
    const ual = await publishOnce({ storageTag: 'v2' });
    expect(ual.startsWith('did:dkg:v2/mock:31337/0x')).toBe(true);
    const parsed = parseUal(ual);
    expect(parsed).not.toBeNull();
    expect(parsed!.storageTag).toBe('v2');
    expect(parsed!.chainId).toBe('mock:31337');
    const afterPrefix = ual.slice('did:dkg:'.length);
    expect(afterPrefix.split('/')).toHaveLength(4);
  });

  it('tag survives the round-trip and is recoverable via parseUal', async () => {
    // Belt-and-suspenders: for a hypothetical future V11 storage with
    // tag "v11", make sure the resolver-side parser sees exactly the
    // tag the publisher minted under. This is the contract that PR-5's
    // resolution path relies on.
    const ual = await publishOnce({ storageTag: 'v11' });
    expect(parseUal(ual)?.storageTag).toBe('v11');
  });
});
