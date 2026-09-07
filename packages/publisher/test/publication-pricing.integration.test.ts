// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  MockChainAdapter,
  type OnChainPublishResult,
  type PublisherPublishPlanRequest,
  type V10PublishDirectParams,
} from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  TypedEventBus,
  createGraphKnowledgeAssetScope,
  generateEd25519Keypair,
  knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import { OxigraphStore, quadsToNQuads, type Quad } from '@origintrail-official/dkg-storage';
import { DKGPublisher } from '../src/dkg-publisher.js';
import {
  PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE,
  PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
  resolvePublicationPricing,
} from '../src/publication-pricing.js';
import {
  computePrivateRootV10,
  generatedPrivateCatalogTripleKeys,
} from '../src/index.js';
import type { V10ACKProviderParams } from '../src/publisher.js';
import { buildSeal, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

class PricingCaptureChain extends MockChainAdapter {
  readonly planRequests: PublisherPublishPlanRequest[] = [];
  capturedCreateParams?: V10PublishDirectParams;

  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(
    messageHash: Uint8Array,
  ): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const signature = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(signature.r),
      vs: ethers.getBytes(signature.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  async getContextGraphAccessPolicy(): Promise<number> {
    return 1;
  }

  async resolvePublisherPublishPlan(request: PublisherPublishPlanRequest) {
    this.planRequests.push(request);
    return {
      publisherAddress: this.wallet.address,
      publishEpochs: request.explicitPublishEpochs ?? request.defaultPublishEpochs,
      // Compatibility proof: an adapter written against the previous request
      // name can continue to plan without reading the new field.
      tokenAmount: request.effectiveByteSize,
    };
  }

  override async createKnowledgeAssets(
    params: V10PublishDirectParams,
  ): Promise<OnChainPublishResult> {
    this.capturedCreateParams = params;
    return super.createKnowledgeAssets(params);
  }
}

class LegacyPricingCaptureChain extends PricingCaptureChain {
  readonly quoteRequests: Array<{ byteSize: bigint; epochs: number }> = [];

  constructor(wallet: ethers.Wallet) {
    super(wallet);
    Object.defineProperty(this, 'resolvePublisherPublishPlan', {
      configurable: true,
      value: undefined,
    });
  }

  override async getRequiredPublishTokenAmount(
    byteSize: bigint,
    epochs: number,
  ): Promise<bigint> {
    this.quoteRequests.push({ byteSize, epochs });
    return byteSize;
  }
}

interface PricingFixture {
  publisher: DKGPublisher;
  chain: PricingCaptureChain;
  store: OxigraphStore;
  wallet: ethers.Wallet;
}

async function createPricingFixture(): Promise<PricingFixture> {
  const wallet = new ethers.Wallet(TEST_KEY);
  const chain = new PricingCaptureChain(wallet);
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: 1n,
  });
  return { publisher, chain, store, wallet };
}

async function createLegacyPricingFixture() {
  const wallet = new ethers.Wallet(TEST_KEY);
  const chain = new LegacyPricingCaptureChain(wallet);
  const store = new OxigraphStore();
  const publisher = new DKGPublisher({
    store,
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: 1n,
  });
  return { publisher, chain, store, wallet };
}

async function publishCuratedGraphScoped(input: {
  fixture: PricingFixture;
  publicQuad: Quad;
  privateQuads?: Quad[];
}) {
  const { publisher, chain, store, wallet } = input.fixture;
  const contextGraphId = '1';
  const privateQuads = input.privateQuads ?? [];
  const seal = await buildSeal({
    quads: [input.publicQuad],
    privateQuads,
    author: wallet,
    contextGraphId,
    ctx: mockSealCtx(),
  });
  const kaNumber = seal.reservedKaId! & ((1n << 96n) - 1n);
  const ual = `did:dkg:31337/${wallet.address}/${kaNumber}`;
  const scope = createGraphKnowledgeAssetScope(ual, 1);
  const swmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
  );
  const vmGraph = knowledgeAssetLayerGraphUri(
    contextGraphId,
    MemoryLayer.VerifiableMemory,
    scope,
  );
  await store.insert([{ ...input.publicQuad, graph: swmGraph }]);
  if (privateQuads.length > 0) {
    const privateStore = (publisher as unknown as {
      privateStore: {
        replaceKnowledgeAssetPrivateTriples(
          contextGraphId: string,
          graphScope: typeof scope,
          quads: Quad[],
        ): Promise<void>;
      };
    }).privateStore;
    await privateStore.replaceKnowledgeAssetPrivateTriples(
      contextGraphId,
      scope,
      privateQuads,
    );
  }

  const ackInputs: V10ACKProviderParams[] = [];
  const ackProvider = mockChainStubACKProvider();
  const result = await publisher.publishFromSharedMemory(contextGraphId, 'all', {
    onChainContextGraphId: contextGraphId,
    sharedMemoryScope: {
      kind: 'named-lifecycle',
      identity: { agentAddress: wallet.address, kaNumber },
    },
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: ual,
    assertionVersion: 1,
    publicTripleCount: 1,
    ...(privateQuads.length > 0
      ? { privateMerkleRoot: computePrivateRootV10(privateQuads) }
      : {}),
    privateTripleCount: privateQuads.length,
    trustedNonManifestCatalogTriples: generatedPrivateCatalogTripleKeys(contextGraphId),
    publisherPeerId: 'test-publisher-peer',
    precomputedAttestation: seal,
    encryptInlinePayload: async (plaintext) => plaintext,
    pricingPolicy: 'full-content',
    v10ACKProvider: async (params) => {
      ackInputs.push(params);
      return ackProvider(params);
    },
  });
  const networkVisibleByteSize = ackInputs[0]!.publicByteSize;
  const fullContentByteSize = BigInt(new TextEncoder().encode(quadsToNQuads([
    { ...input.publicQuad, graph: vmGraph },
    ...privateQuads.map((quad) => ({ ...quad, graph: quad.graph || vmGraph })),
  ])).length);
  return {
    result,
    ack: ackInputs[0]!,
    networkVisibleByteSize,
    fullContentByteSize,
    pricing: resolvePublicationPricing({
      policy: 'full-content',
      networkVisibleByteSize,
      fullContentByteSize,
    }),
    chain,
  };
}

describe('publication pricing integration', () => {
  it('bills full canonical content while ACK and transaction retain replica-visible bytes', async () => {
    const fixture = await createPricingFixture();
    const publicQuad: Quad = {
      subject: 'urn:test:full-content-pricing',
      predicate: 'http://schema.org/name',
      object: '"public"',
      graph: '',
    };
    const privateQuad: Quad = {
      subject: publicQuad.subject,
      predicate: 'http://schema.org/description',
      object: `"${'private-payload-'.repeat(32)}"`,
      graph: '',
    };

    const published = await publishCuratedGraphScoped({
      fixture,
      publicQuad,
      privateQuads: [privateQuad],
    });

    expect(published.result.status).toBe('confirmed');
    expect(published.fullContentByteSize).toBeGreaterThan(published.networkVisibleByteSize);
    expect(published.pricing).toEqual({
      policy: 'full-content',
      networkVisibleByteSize: published.networkVisibleByteSize,
      billableByteSize: published.fullContentByteSize,
    });
    expect(published.chain.planRequests).toEqual([
      expect.objectContaining({
        billableByteSize: published.fullContentByteSize,
        effectiveByteSize: published.fullContentByteSize,
      }),
    ]);
    expect(published.ack.tokenAmount).toBe(published.fullContentByteSize);
    expect(published.chain.capturedCreateParams).toMatchObject({
      byteSize: published.networkVisibleByteSize,
      tokenAmount: published.fullContentByteSize,
    });
  });

  it('bills full content through the legacy adapter planning fallback', async () => {
    const fixture = await createLegacyPricingFixture();
    const publicQuad: Quad = {
      subject: 'urn:test:legacy-full-content-pricing',
      predicate: 'http://schema.org/name',
      object: '"public"',
      graph: '',
    };
    const privateQuad: Quad = {
      subject: publicQuad.subject,
      predicate: 'http://schema.org/description',
      object: `"${'legacy-private-payload-'.repeat(32)}"`,
      graph: '',
    };

    const published = await publishCuratedGraphScoped({
      fixture,
      publicQuad,
      privateQuads: [privateQuad],
    });

    expect(published.fullContentByteSize).toBeGreaterThan(published.networkVisibleByteSize);
    expect(fixture.chain.quoteRequests).toEqual([{
      byteSize: published.fullContentByteSize,
      epochs: published.ack.epochs,
    }]);
    expect(published.ack.tokenAmount).toBe(published.fullContentByteSize);
    expect(fixture.chain.capturedCreateParams).toMatchObject({
      byteSize: published.networkVisibleByteSize,
      tokenAmount: published.fullContentByteSize,
    });
  });

  it('floors billable bytes at a larger network-visible catalog payload', async () => {
    const fixture = await createPricingFixture();
    const published = await publishCuratedGraphScoped({
      fixture,
      publicQuad: {
        subject: 'urn:x',
        predicate: 'urn:p',
        object: '"x"',
        graph: '',
      },
    });

    expect(published.fullContentByteSize).toBeLessThan(published.networkVisibleByteSize);
    expect(published.pricing.billableByteSize).toBe(published.networkVisibleByteSize);
    expect(published.chain.planRequests).toEqual([
      expect.objectContaining({
        billableByteSize: published.networkVisibleByteSize,
        effectiveByteSize: published.networkVisibleByteSize,
      }),
    ]);
    expect(published.ack.tokenAmount).toBe(published.networkVisibleByteSize);
    expect(published.chain.capturedCreateParams).toMatchObject({
      byteSize: published.networkVisibleByteSize,
      tokenAmount: published.networkVisibleByteSize,
    });
  });

  it('rejects full-content pricing at the public publish boundary without graph scope', async () => {
    const fixture = await createPricingFixture();
    const ackProvider = vi.fn();

    await expect(fixture.publisher.publish({
      contextGraphId: '1',
      quads: [{ subject: 'urn:x', predicate: 'urn:p', object: '"x"', graph: '' }],
      pricingPolicy: 'full-content',
      v10ACKProvider: ackProvider,
    })).rejects.toMatchObject({
      code: PUBLISH_PRICING_POLICY_GRAPH_SCOPE_REQUIRED_CODE,
    });

    expect(fixture.chain.planRequests).toHaveLength(0);
    expect(fixture.chain.capturedCreateParams).toBeUndefined();
    expect(ackProvider).not.toHaveBeenCalled();
  });

  it('rejects initial-only pricing at the runtime update boundary', async () => {
    const fixture = await createPricingFixture();

    await expect(fixture.publisher.update(1n, {
      contextGraphId: '1',
      quads: [],
      pricingPolicy: 'full-content',
    } as never)).rejects.toMatchObject({
      code: PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE,
    });

    expect(fixture.chain.planRequests).toHaveLength(0);
    expect(fixture.chain.capturedCreateParams).toBeUndefined();
  });
});
