/**
 * Regression test: DKGPublisher must NOT auto-mint a random publisher wallet
 * when no `publisherPrivateKey` is supplied, and must not use the zero
 * address as a placeholder publisher.
 *
 * Background
 * ----------
 * Pre-fix behaviour generated `ethers.Wallet.createRandom()` whenever
 * `chain.chainId !== 'none'` and no key was supplied. The resulting wallet
 * was used to sign on-chain publish digests, ACK self-signatures, and
 * authorship proofs — all attributed (by `publisherAddress`) to whatever
 * address the caller had passed in separately. So signatures looked
 * authoritative but were verifiably-junk: signed by a throw-away key the
 * caller had never seen.
 *
 * This is the same anti-pattern that destroyed nine testnet admin keys via
 * `ensureProfile` (see `scripts/audit-create-random.mjs` header). Fix and
 * test both land in the same PR. The constructor now leaves
 * `publisherWallet` undefined; publish now requires either an explicit local
 * signing key or a configured adapter signer bound to a non-zero publisher
 * address before it can create ACKs, publisher signatures, or authorship
 * proofs. Local tentative/no-chain publishes never use the zero address; when
 * no EVM publisher address exists, they use a deterministic non-zero address
 * derived from the agent keypair solely for tentative metadata/UAL scoping.
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { generateConfirmedFullMetadata } from '../src/metadata.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  type ChainAdapter,
  type OnChainPublishResult,
  type TxResult,
  type V10PublishDirectParams,
  type V10UpdateKCParams,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { wrapPublisherForTest, mockSealCtx } from './_helpers/seal.js';

// Phase C (commit `d353c6a5`) made `DKGPublisher.publish` reject on-chain
// publishes that arrive without a `precomputedAttestation`. The mock-chain
// tests in this file pre-date that requirement; wrap each publisher so the
// proxy mints a seal automatically. The seal is signed by the same wallet
// that mocks the adapter signer, which lets the publisher's seal-integrity
// preflight (`recoverAddress` vs `authorAddress`) round-trip cleanly.
//
// `kav10Address` and `chainId` are read from the actual chain adapter
// being tested — different mocks return different sentinel addresses
// (e.g. `MockChainAdapter` uses `0x...c10a`,
// `AsyncAddressSigningChain` uses `0x...00A1`). If we hardcoded one
// the publisher's typed-data rebuild would diverge from the seal we
// signed and recovery would mismatch.
async function sealForWallet(
  publisher: DKGPublisher,
  wallet: ethers.Wallet,
  chain: { getEvmChainId: () => Promise<bigint>; getKnowledgeAssetsV10Address: () => Promise<string> },
): Promise<DKGPublisher> {
  const chainId = await chain.getEvmChainId();
  const kav10Address = await chain.getKnowledgeAssetsV10Address();
  return wrapPublisherForTest(publisher, {
    author: wallet,
    ctx: mockSealCtx({ chainId, kav10Address }),
  });
}

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_KEY_ALT = '0x5de4111a56f4c24611d9ed4d5318a7e03f9b9a9d73f3a5f3f6324a2a0e6fbb36';

// Minimal stub — DKGPublisher's constructor only reads `chain.chainId`.
// All other ChainAdapter methods are unused in this test.
function makeStubChain(chainId: string): ChainAdapter {
  return { chainId } as unknown as ChainAdapter;
}

class AdapterSigningChain extends MockChainAdapter {
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }
}

class AsyncAddressSigningChain implements ChainAdapter {
  readonly chainId = 'mock:31337';
  capturedPublisherAddress?: string;

  constructor(private readonly wallet: ethers.Wallet) {}

  isV10Ready(): boolean {
    return true;
  }

  async getEvmChainId(): Promise<bigint> {
    return 31337n;
  }

  async getKnowledgeAssetsV10Address(): Promise<string> {
    return '0x00000000000000000000000000000000000000A1';
  }

  async getSignerAddress(): Promise<string> {
    return this.wallet.address;
  }

  async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }

  async createKnowledgeAssetsV10(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress?.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new Error('publisher did not await async signer address');
    }
    return {
      batchId: 1n,
      startKAId: 101n,
      endKAId: 101n,
      txHash: `0x${'78'.repeat(32)}`,
      blockNumber: 1,
      blockTimestamp: Math.floor(Date.now() / 1000),
      publisherAddress: this.wallet.address,
    };
  }
}

class ReservingPublishChain extends AsyncAddressSigningChain {
  reservations = 0;
  private readonly authorizedAddress: string;

  constructor(wallet: ethers.Wallet) {
    super(wallet);
    this.authorizedAddress = wallet.address;
  }

  async getAuthorizedPublisherAddress(): Promise<string> {
    this.reservations += 1;
    return this.authorizedAddress;
  }
}

class LazyReadySigningChain extends AsyncAddressSigningChain {
  private ready = false;
  capturedTokenAmount?: bigint;

  override isV10Ready(): boolean {
    return this.ready;
  }

  override async getEvmChainId(): Promise<bigint> {
    this.ready = true;
    return super.getEvmChainId();
  }

  async getRequiredPublishTokenAmount(): Promise<bigint> {
    return 123n;
  }

  override async createKnowledgeAssetsV10(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedTokenAmount = params.tokenAmount;
    return super.createKnowledgeAssetsV10(params);
  }
}

class InitGatedSigningChain extends AsyncAddressSigningChain {
  private ready = false;

  override isV10Ready(): boolean {
    return this.ready;
  }

  override async getEvmChainId(): Promise<bigint> {
    this.ready = true;
    return super.getEvmChainId();
  }

  override async getSignerAddress(): Promise<string> {
    if (!this.ready) throw new Error('signer unavailable before V10 init');
    return super.getSignerAddress();
  }
}

class RejectingAdapterSignerChain extends AsyncAddressSigningChain {
  async signMessageAs(): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    throw new Error('remote signer unavailable');
  }
}

class ContextAwareAdapterSigningChain extends MockChainAdapter {
  capturedPublisherAddress?: string;

  constructor(
    private readonly primaryWallet: ethers.Wallet,
    private readonly authorizedWallet: ethers.Wallet,
  ) {
    super('mock:31337', primaryWallet.address);
    this.seedIdentity(authorizedWallet.address, 7n);
    this.minimumRequiredSignatures = 1;
  }

  async getAuthorizedPublisherAddress(contextGraphId: bigint): Promise<string> {
    expect(contextGraphId).toBe(42n);
    return this.authorizedWallet.address;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.primaryWallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const normalized = ethers.getAddress(address);
    if (normalized.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error(`unexpected signer ${address}`);
    }
    const sig = ethers.Signature.from(await this.authorizedWallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedDataAs(
    address: string,
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const normalized = ethers.getAddress(address);
    if (normalized.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error(`unexpected typed-data signer ${address}`);
    }
    return this.authorizedWallet.signTypedData(domain, types, value);
  }

  override async createKnowledgeAssetsV10(params: Parameters<MockChainAdapter['createKnowledgeAssetsV10']>[0]) {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress?.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error('publish tx signer did not match resolved publisher address');
    }
    return super.createKnowledgeAssetsV10(params);
  }
}

class AdapterManagedUpdateChain implements ChainAdapter {
  readonly chainId = 'mock:31337';
  capturedPublisherAddress?: string;

  constructor(
    private readonly publisherAddress?: string,
    private readonly latestPublisherAddress?: string,
    private readonly success = true,
  ) {}

  async updateKnowledgeCollectionV10(params: V10UpdateKCParams): Promise<TxResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    return {
      success: this.success,
      hash: `0x${'12'.repeat(32)}`,
      blockNumber: 1,
      ...(this.publisherAddress ? { publisherAddress: this.publisherAddress } : {}),
    };
  }

  async getLatestMerkleRootPublisher(): Promise<string> {
    if (!this.latestPublisherAddress) throw new Error('publisher unavailable');
    return this.latestPublisherAddress;
  }
}

class ReservingUpdateChain extends AdapterManagedUpdateChain {
  reservations = 0;

  async getAuthorizedPublisherAddress(): Promise<string> {
    this.reservations += 1;
    return new ethers.Wallet(TEST_KEY).address;
  }
}

describe('DKGPublisher: no random publisher wallet without explicit key', () => {
  it('leaves publisherWallet and publisherAddress undefined when no key or address is supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
    });

    // Cast to any so we can assert on the private field — the regression we
    // are guarding against is exactly that this field used to be a freshly
    // generated random wallet, which is observable here.
    expect((publisher as any).publisherWallet).toBeUndefined();
    expect((publisher as any).publisherAddress).toBeUndefined();
  });

  it('publishes tentatively with a deterministic non-zero local address on no-chain publishes', async () => {
    const keypair = await generateEd25519Keypair();
    const chain = {
      ...makeStubChain('none'),
      getRequiredPublishTokenAmount: async () => {
        throw new Error('RPC unavailable');
      },
    } as ChainAdapter;
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-address',
        predicate: 'http://schema.org/name',
        object: '"NoAddress"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    const match = result.ual.match(/^did:dkg:none\/(0x[0-9a-fA-F]{40})\/t/);
    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(match?.[1]).toBeDefined();
    expect(match![1]).not.toBe(ethers.ZeroAddress);
  });

  it('updates no-chain tentative publishes with the same deterministic local address', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('none'),
      eventBus: new TypedEventBus(),
      keypair,
    });

    const created = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-chain-update',
        predicate: 'http://schema.org/name',
        object: '"Before"',
        graph: 'did:dkg:context-graph:1',
      }],
    });
    const createdAddress = created.ual.match(/^did:dkg:none\/(0x[0-9a-fA-F]{40})\/t/)?.[1];

    const updated = await publisher.update(created.kcId, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-chain-update',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(updated.status).toBe('tentative');
    expect(updated.onChainResult).toBeUndefined();
    expect(createdAddress).toBeDefined();
    expect(updated.ual.toLowerCase()).toContain(createdAddress!.toLowerCase());
    expect(updated.publicQuads[0]?.object).toBe('"After"');
  });

  it('publishes tentatively with an explicit non-zero publisherAddress on no-chain publishes', async () => {
    const keypair = await generateEd25519Keypair();
    const publisherAddress = '0x000000000000000000000000000000000000dEaD';
    const chain = {
      ...makeStubChain('none'),
      getRequiredPublishTokenAmount: async () => {
        throw new Error('RPC unavailable');
      },
    } as ChainAdapter;
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress,
    });

    expect((publisher as any).publisherWallet).toBeUndefined();
    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:no-key',
        predicate: 'http://schema.org/name',
        object: '"NoKey"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual.toLowerCase()).toContain(publisherAddress.toLowerCase());
  });

  it('keeps chain-backed identity-less publishes tentative without a publisher signer', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('evm:31337'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 0n,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:evm-no-identity-no-signer',
        predicate: 'http://schema.org/name',
        object: '"EvmNoIdentityNoSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual).toMatch(/^did:dkg:evm:31337\/0x[0-9a-fA-F]{40}\/t/);
  });

  it('reserves adapter publisher signers for identity-less publishes (OT-RFC-38 §1.1 — no-attribution path)', async () => {
    // Pre-RFC-38: identity=0 short-circuited to tentative and skipped the
    // adapter reservation. Post-RFC-38: edge agents without an on-chain
    // Profile MUST be able to publish in no-attribution mode (the contract
    // accepts attributionId=0n), so the publisher resolves and reserves a
    // chain signer just like any other on-chain publish. The downstream
    // result depends on the chain adapter — here `ReservingPublishChain`
    // accepts any publisher and returns a confirmed result.
    const keypair = await generateEd25519Keypair();
    const chain = new ReservingPublishChain(new ethers.Wallet(TEST_KEY));
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 0n,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:evm-identityless-reserves',
        predicate: 'http://schema.org/name',
        object: '"EvmIdentitylessReserves"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    // The reservation is the load-bearing assertion — it proves the gate
    // dropped and the publisher resolved a signer. The on-chain TX itself
    // may still fall back to tentative in single-node mode (no v10ACKProvider
    // + no self-ACK without identity → no ACKs → tx skipped), which is fine
    // for this test: the gate change is what we're pinning.
    expect(['confirmed', 'tentative']).toContain(result.status);
    expect(chain.reservations).toBeGreaterThanOrEqual(1);
  });

  it('keeps descriptive-CG chain-backed publishes tentative without a publisher signer', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('evm:31337'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: 'draft-cg',
      quads: [{
        subject: 'urn:test:evm-descriptive-cg-no-signer',
        predicate: 'http://schema.org/name',
        object: '"EvmDescriptiveCgNoSigner"',
        graph: 'did:dkg:context-graph:draft-cg',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual).toMatch(/^did:dkg:evm:31337\/0x[0-9a-fA-F]{40}\/t/);
  });

  it('keeps non-V10 chain-backed publishes tentative without a publisher signer', async () => {
    const keypair = await generateEd25519Keypair();
    const store = new OxigraphStore();
    const publisher = new DKGPublisher({
      store,
      chain: makeStubChain('evm:31337'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:evm-no-signer',
        predicate: 'http://schema.org/name',
        object: '"EvmNoSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual).toMatch(/^did:dkg:evm:31337\/0x[0-9a-fA-F]{40}\/t/);

    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <did:dkg:context-graph:1> {
          <urn:test:evm-no-signer> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings.length).toBeGreaterThan(0);
  });

  it('keeps method-present but non-ready V10 adapters tentative without a publisher signer', async () => {
    const keypair = await generateEd25519Keypair();
    const store = new OxigraphStore();
    const chain = {
      chainId: 'evm:31337',
      isV10Ready: () => false,
      createKnowledgeAssetsV10: async () => {
        throw new Error('non-ready V10 adapter should not be called');
      },
    } as unknown as ChainAdapter;
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:evm-method-present-not-ready-no-signer',
        predicate: 'http://schema.org/name',
        object: '"EvmMethodPresentNotReadyNoSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(result.onChainResult).toBeUndefined();
    expect(result.ual).toMatch(/^did:dkg:evm:31337\/0x[0-9a-fA-F]{40}\/t/);
  });

  it('rejects unrecoverable mock signMessage adapters before local storage', async () => {
    const keypair = await generateEd25519Keypair();
    const store = new OxigraphStore();
    const chain = new MockChainAdapter('mock:31337', '0x0000000000000000000000000000000000001111');
    chain.seedIdentity('0x0000000000000000000000000000000000001111', 1n);
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    });

    await expect(publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:mock-unrecoverable-signer',
        predicate: 'http://schema.org/name',
        object: '"MockUnrecoverableSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    })).rejects.toThrow(/publisherPrivateKey/);

    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <did:dkg:context-graph:1> {
          <urn:test:mock-unrecoverable-signer> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings).toHaveLength(0);
  });

  it('rejects a zero publisherAddress instead of treating it as a sentinel', async () => {
    const keypair = await generateEd25519Keypair();
    expect(() => new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: '0x0000000000000000000000000000000000000000',
    })).toThrow(/zero address/i);
  });

  it('still constructs publisherWallet when an explicit key is supplied', async () => {
    const keypair = await generateEd25519Keypair();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_KEY,
    });
    const wallet = (publisher as any).publisherWallet;
    expect(wallet).toBeDefined();
    expect(wallet.address.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect((publisher as any).publisherAddress.toLowerCase()).toBe('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
  });

  it('rejects publisherAddress values that do not match the supplied private key', async () => {
    const keypair = await generateEd25519Keypair();

    expect(() => new DKGPublisher({
      store: new OxigraphStore(),
      chain: makeStubChain('test-evm-chain'),
      eventBus: new TypedEventBus(),
      keypair,
      publisherPrivateKey: TEST_KEY,
      publisherAddress: '0x000000000000000000000000000000000000dEaD',
    })).toThrow(/does not match publisherPrivateKey signer/i);
  });

  it('publishes with an adapter-backed signer when a non-zero publisherAddress is configured', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const rawPublisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
      publisherNodeIdentityId: 1n,
    });

    expect((rawPublisher as any).publisherWallet).toBeUndefined();
    const publisher = await sealForWallet(rawPublisher, wallet, chain);
    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-signer',
        predicate: 'http://schema.org/name',
        object: '"AdapterSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('infers adapter-backed signer address for direct DKGPublisher consumers', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    }), wallet, chain);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-inferred-signer',
        predicate: 'http://schema.org/name',
        object: '"AdapterInferredSigner"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('awaits async adapter signer address probes', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AsyncAddressSigningChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    }), wallet, chain);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-async-address',
        predicate: 'http://schema.org/name',
        object: '"AdapterAsyncAddress"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('precomputes token amount for adapters that become V10-ready during initialization', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new LazyReadySigningChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    }), wallet, chain);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:lazy-v10-ready',
        predicate: 'http://schema.org/name',
        object: '"LazyV10Ready"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(chain.capturedTokenAmount).toBe(123n);
  });

  it('initializes V10 readiness before resolving adapter-backed signer addresses', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new InitGatedSigningChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    }), wallet, chain);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:init-before-signer-resolution',
        predicate: 'http://schema.org/name',
        object: '"InitBeforeSignerResolution"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('continues tentatively when adapter signer fails during self-ACK', async () => {
    const keypair = await generateEd25519Keypair();
    const store = new OxigraphStore();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new RejectingAdapterSignerChain(wallet);
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    });

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-self-ack-failure',
        predicate: 'http://schema.org/name',
        object: '"AdapterSelfAckFailure"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(result.status).toBe('tentative');
    expect(chain.capturedPublisherAddress).toBeUndefined();

    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <did:dkg:context-graph:1> {
          <urn:test:adapter-self-ack-failure> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings).toHaveLength(1);
  });

  it('binds context-graph-aware adapter signer resolution to the V10 tx publisher address', async () => {
    const keypair = await generateEd25519Keypair();
    const primaryWallet = new ethers.Wallet(TEST_KEY);
    const authorizedWallet = new ethers.Wallet(TEST_KEY_ALT);
    const chain = new ContextAwareAdapterSigningChain(primaryWallet, authorizedWallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddressResolver: (contextGraphId?: bigint) =>
        contextGraphId === undefined ? Promise.resolve(undefined) : chain.getAuthorizedPublisherAddress(contextGraphId),
      publisherNodeIdentityId: 7n,
    }), authorizedWallet, chain);

    const result = await publisher.publish({
      contextGraphId: '42',
      quads: [{
        subject: 'urn:test:adapter-context-aware-signer',
        predicate: 'http://schema.org/name',
        object: '"AdapterContextAwareSigner"',
        graph: 'did:dkg:context-graph:42',
      }],
    });

    expect(result.status).toBe('confirmed');
    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(authorizedWallet.address.toLowerCase());
    expect(result.onChainResult?.publisherAddress.toLowerCase()).toBe(authorizedWallet.address.toLowerCase());
  });

  it('updates with an adapter-backed signer and configured publisherAddress', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterSigningChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
      publisherNodeIdentityId: 1n,
    }), wallet, chain);

    const created = await publisher.publish({
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-update',
        predicate: 'http://schema.org/name',
        object: '"Before"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    const updated = await publisher.update(created.kcId, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-update',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(updated.status).toBe('confirmed');
    expect(updated.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('uses configured publisherAddress as update fallback when chain state and metadata miss', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterManagedUpdateChain(wallet.address);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
    });

    const updated = await publisher.update(99n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:update-configured-publisher-fallback',
        predicate: 'http://schema.org/name',
        object: '"ConfiguredPublisherFallback"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(updated.status).toBe('confirmed');
    expect(updated.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('lets adapter-managed updates select their signer without local address discovery', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterManagedUpdateChain(wallet.address);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(11n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-update',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress).toBeUndefined();
    expect(updated.status).toBe('confirmed');
    expect(updated.ual.toLowerCase()).toContain(wallet.address.toLowerCase());
    expect(updated.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('does not reserve a new publish signer for adapter-managed updates', async () => {
    const keypair = await generateEd25519Keypair();
    const chain = new ReservingUpdateChain();
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(14n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-update-without-reservation',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.reservations).toBe(0);
    expect(chain.capturedPublisherAddress).toBeUndefined();
    expect(updated.status).toBe('tentative');
    expect(updated.onChainResult).toBeUndefined();
  });

  it('resolves adapter-managed update attribution from chain state when tx result omits publisherAddress', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterManagedUpdateChain(undefined, wallet.address);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(11n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-update-chain-attribution',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(updated.status).toBe('confirmed');
    expect(updated.ual.toLowerCase()).toContain(wallet.address.toLowerCase());
    expect(updated.onChainResult?.publisherAddress.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('resolves failed adapter-managed update attribution from chain state', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterManagedUpdateChain(undefined, wallet.address, false);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(12n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-failed-update-chain-attribution',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(updated.status).toBe('failed');
    expect(updated.ual.toLowerCase()).toContain(wallet.address.toLowerCase());
  });

  it('preserves failed adapter-managed updates when publisher attribution is unavailable', async () => {
    const keypair = await generateEd25519Keypair();
    const chain = new AdapterManagedUpdateChain(undefined, undefined, false);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(12n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-failed-update-without-address',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress).toBeUndefined();
    expect(updated.status).toBe('failed');
    expect(updated.ual).toMatch(/^did:dkg:mock:31337\/0x[0-9a-fA-F]{40}\/12$/);
  });

  it('does not confirm adapter-managed updates from local metadata alone', async () => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const store = new OxigraphStore();
    const chain = new AdapterManagedUpdateChain();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });
    const ual = `did:dkg:mock:31337/${wallet.address}/13`;
    await store.insert(generateConfirmedFullMetadata(
      {
        ual,
        contextGraphId: '1',
        merkleRoot: new Uint8Array(32),
        kaCount: 1,
        publisherPeerId: 'peer',
        timestamp: new Date(0),
      },
      [{
        rootEntity: 'urn:test:adapter-managed-update-local-attribution',
        kcUal: ual,
        tokenId: 1n,
        publicTripleCount: 1,
        privateTripleCount: 0,
      }],
      {
        txHash: `0x${'34'.repeat(32)}`,
        blockNumber: 1,
        blockTimestamp: 1,
        publisherAddress: wallet.address,
        batchId: 13n,
        chainId: 'mock:31337',
      },
    ));

    const updated = await publisher.update(13n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-update-local-attribution',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(updated.status).toBe('tentative');
    expect(updated.onChainResult).toBeUndefined();
    expect(updated.ual).toMatch(/^did:dkg:mock:31337\/0x[0-9a-fA-F]{40}\/13$/);

    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <did:dkg:context-graph:1> {
          <urn:test:adapter-managed-update-local-attribution> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings.length).toBeGreaterThan(0);
  });

  it('keeps adapter-managed updates tentative when publisher attribution is unavailable', async () => {
    const keypair = await generateEd25519Keypair();
    const store = new OxigraphStore();
    const chain = new AdapterManagedUpdateChain();
    const publisher = new DKGPublisher({
      store,
      chain,
      eventBus: new TypedEventBus(),
      keypair,
    });

    const updated = await publisher.update(12n, {
      contextGraphId: '1',
      quads: [{
        subject: 'urn:test:adapter-managed-update-without-address',
        predicate: 'http://schema.org/name',
        object: '"After"',
        graph: 'did:dkg:context-graph:1',
      }],
    });

    expect(chain.capturedPublisherAddress).toBeUndefined();
    expect(updated.status).toBe('tentative');
    expect(updated.onChainResult).toBeUndefined();
    expect(updated.ual).toMatch(/^did:dkg:mock:31337\/0x[0-9a-fA-F]{40}\/12$/);

    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <did:dkg:context-graph:1> {
          <urn:test:adapter-managed-update-without-address> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings.length).toBeGreaterThan(0);
  });
});
