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
import { DEFAULT_PUBLISH_EPOCHS, type V10ACKProvider } from '../src/publisher.js';
import { generateConfirmedFullMetadata } from '../src/metadata.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  type ChainAdapter,
  type OnChainPublishResult,
  type TxResult,
  type V10PublishDirectParams,
  type V10UpdateKAParams,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { wrapPublisherForTest, mockSealCtx, updateSealed } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

// Greenfield (PR #815): the confirmed UAL embeds the DKGKnowledgeAssets
// storage address resolved via `getDKGKnowledgeAssetsAddress()`, not the
// publisher address. Asserting only the UAL shape (40-hex) would still pass
// if the publisher embedded the zero address, the legacy storage contract,
// or any other 40-hex value. Compare the embedded address against the
// adapter's resolved storage address so the specific result stays covered.
async function expectUalEmbedsStorageAddress(
  ual: string | undefined,
  chain: { getDKGKnowledgeAssetsAddress(): Promise<string> },
  tokenId: number,
): Promise<void> {
  expect(ual).toMatch(/^did:dkg:mock:31337\/0x[0-9a-fA-F]{40}\/\d+$/);
  const [, embeddedAddr, embeddedTokenId] = (ual ?? '').split('/');
  expect(embeddedAddr.toLowerCase()).toBe(
    (await chain.getDKGKnowledgeAssetsAddress()).toLowerCase(),
  );
  expect(embeddedTokenId).toBe(String(tokenId));
}

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
  chain: { getEvmChainId: () => Promise<bigint>; getKnowledgeAssetsLifecycleAddress: () => Promise<string> },
): Promise<DKGPublisher> {
  const chainId = await chain.getEvmChainId();
  const kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  return wrapPublisherForTest(publisher, {
    author: wallet,
    ctx: mockSealCtx({ chainId, kav10Address }),
    v10ACKProvider: mockChainStubACKProvider(),
  });
}

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const TEST_KEY_ALT = '0x5de4111a56f4c24611d9ed4d5318a7e03f9b9a9d73f3a5f3f6324a2a0e6fbb36';

// rc.17 uniform per-KA layout: a confirmed publish (and any later update)
// stores the KA's public quads in the PER-KA verifiable-memory graph
// `…/_verifiable_memory/{author}/{number}`, where `author` + `number` are
// unpacked from the KA's on-chain id by the same bit math the publisher uses
// (`dkg-publisher.ts`). The update's batchId === the original kaId, so the
// graph an update targets is derived from the kaId passed to `update()`.
function perKaVerifiableMemoryGraph(contextGraphId: string, kaId: bigint): string {
  const number = kaId & ((1n << 96n) - 1n);
  const author = '0x' + (kaId >> 96n).toString(16).padStart(40, '0');
  return `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${author}/${number}`;
}

// Greenfield (PR #815): on-chain updates require an owner seal
// (`precomputedUpdateAttestation`). The adapter-managed update tests below
// assert publisher *attribution* resolution, not seal ceremony, so this
// helper mints a self-consistent seal (author == recovered signer) over
// the mock chain's `mockSealCtx()` domain and forwards to `update()`.
const _SEAL_WALLET = new ethers.Wallet(TEST_KEY);
function updS(
  publisher: DKGPublisher,
  kaId: bigint,
  args: Parameters<DKGPublisher['update']>[1],
) {
  return updateSealed(publisher, kaId, args, _SEAL_WALLET, mockSealCtx());
}

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

class EpochCapturingChain extends AdapterSigningChain {
  capturedCreateParams?: V10PublishDirectParams;
  pcaLockDurationEpochs?: number;

  override async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedCreateParams = params;
    return super.createKnowledgeAssets(params);
  }

  override async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    return this.pcaLockDurationEpochs ?? super.getConvictionAccountLockDurationEpochs(accountId);
  }
}

interface AckEpochCapture {
  epochs?: number;
  tokenAmount?: bigint;
}

function captureACKInputs(capture: AckEpochCapture): V10ACKProvider {
  const provider = mockChainStubACKProvider();
  return async (...args: Parameters<V10ACKProvider>) => {
    capture.epochs = args[6];
    capture.tokenAmount = args[7];
    return provider(...args);
  };
}

async function makeEpochPublisher(chain: EpochCapturingChain, wallet: ethers.Wallet): Promise<DKGPublisher> {
  const keypair = await generateEd25519Keypair();
  return sealForWallet(new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair,
    publisherNodeIdentityId: 1n,
  }), wallet, chain);
}

function epochTestQuads(label: string) {
  return [{
    subject: `urn:test:${label}`,
    predicate: 'http://schema.org/name',
    object: `"${label}"`,
    graph: 'did:dkg:context-graph:1',
  }];
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

  async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return '0x00000000000000000000000000000000000000A1';
  }

  // Greenfield (PR #815): the publisher resolves the asset-storage
  // address via `getDKGKnowledgeAssetsAddress()` (Hub name changed from
  // KnowledgeCollectionStorage → DKGKnowledgeAssets) when assigning the
  // confirmed UAL. Mirror MockChainAdapter and reuse the V10 address.
  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return this.getKnowledgeAssetsLifecycleAddress();
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

  async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress?.toLowerCase() !== this.wallet.address.toLowerCase()) {
      throw new Error('publisher did not await async signer address');
    }
    // §F2 — echo the packed reservedKaId the publisher signed over so the
    // mint matches the reservation (the real contract _safeMints exactly it);
    // returning a fixed `1n` would trip the publisher's UAL/chain-split guard.
    const kaId = params.reservedKaId ?? 1n;
    return {
      batchId: kaId,
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

  override async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    this.capturedTokenAmount = params.tokenAmount;
    return super.createKnowledgeAssets(params);
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

  override async createKnowledgeAssets(params: Parameters<MockChainAdapter['createKnowledgeAssets']>[0]) {
    this.capturedPublisherAddress = params.publisherAddress;
    if (params.publisherAddress?.toLowerCase() !== this.authorizedWallet.address.toLowerCase()) {
      throw new Error('publish tx signer did not match resolved publisher address');
    }
    return super.createKnowledgeAssets(params);
  }
}

class AdapterManagedUpdateChain implements ChainAdapter {
  readonly chainId = 'mock:31337';
  capturedPublisherAddress?: string;
  capturedPublisherNodeIdentityId?: bigint;

  constructor(
    private readonly publisherAddress?: string,
    private readonly latestPublisherAddress?: string,
    private readonly success = true,
  ) {}

  // Greenfield (PR #815): the owner-sealed update path rebuilds the
  // UpdateAuthorAttestation typed data from `getEvmChainId()` +
  // `getKnowledgeAssetsLifecycleAddress()` to verify the seal before
  // submitting. These values must match the `mockSealCtx()` defaults the
  // seal is signed against (chainId 31337, kav10 `0x…c10a`).
  async getEvmChainId(): Promise<bigint> {
    return 31337n;
  }

  async getKnowledgeAssetsLifecycleAddress(): Promise<string> {
    return '0x000000000000000000000000000000000000c10a';
  }

  // Greenfield (PR #815): `resolveKaUal()` reads the asset-storage
  // address via `getDKGKnowledgeAssetsAddress()` when building the UAL.
  async getDKGKnowledgeAssetsAddress(): Promise<string> {
    return '0x000000000000000000000000000000000000c10a';
  }

  async updateKnowledgeCollectionV10(params: V10UpdateKAParams): Promise<TxResult> {
    this.capturedPublisherAddress = params.publisherAddress;
    this.capturedPublisherNodeIdentityId = params.publisherNodeIdentityId;
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

    const updated = await publisher.update(created.kaId, {
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
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new ReservingPublishChain(wallet);
    const publisher = await sealForWallet(new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 0n,
    }), wallet, chain);

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
    // dropped and the publisher resolved a signer. RC11 / PR3: pass a
    // mock-chain stub V10ACKProvider so the publisher's
    // "V10 ACKs required for on-chain publish" guard (which used to
    // be silenced by the deleted self-ACK fallback) is satisfied
    // structurally; the mock chain still doesn't verify ACK
    // cryptography. The chain returns confirmed in either case.
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
      createKnowledgeAssets: async () => {
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

  it('uses the default publish lifetime for direct publishes and keeps random sampling eligible after epoch rollover', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('default-publish-epochs'),
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    expect(ack.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(ack.tokenAmount).toBe(BigInt(DEFAULT_PUBLISH_EPOCHS));
    expect(chain.capturedCreateParams?.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(chain.capturedCreateParams?.tokenAmount).toBe(BigInt(DEFAULT_PUBLISH_EPOCHS));

    chain.__advanceEpoch();
    chain.__advanceProofPeriod();
    const challenge = await chain.createChallenge();
    expect(challenge.contextGraphId).toBe(1n);
    expect(challenge.challenge.knowledgeAssetId).toBe(result.kaId);
  });

  it('respects an explicit publishEpochs override in ACK intent and createKnowledgeAssets params', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('explicit-publish-epochs'),
      publishEpochs: 5,
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    expect(ack.epochs).toBe(5);
    expect(ack.tokenAmount).toBe(5n);
    expect(chain.capturedCreateParams?.epochs).toBe(5);
    expect(chain.capturedCreateParams?.tokenAmount).toBe(5n);
  });

  it('coerces omitted PCA-funded publish lifetime to the PCA lock duration', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('pca-default-publish-epochs'),
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    expect(ack.epochs).toBe(24);
    expect(ack.tokenAmount).toBe(24n);
    expect(chain.capturedCreateParams?.epochs).toBe(24);
    expect(chain.capturedCreateParams?.tokenAmount).toBe(24n);
  });

  it('keeps explicit publishEpochs when the publisher is also a PCA agent', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('pca-explicit-publish-epochs'),
      publishEpochs: 5,
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    expect(ack.epochs).toBe(5);
    expect(ack.tokenAmount).toBe(5n);
    expect(chain.capturedCreateParams?.epochs).toBe(5);
    expect(chain.capturedCreateParams?.tokenAmount).toBe(5n);
  });

  it('does NOT coerce the lifetime when the signer is registered against an unfundable PCA (consent-free squat)', async () => {
    // Audit regression: agent registration is consent-free (RFC-001 §3.6),
    // so a third party can register this signer against a 1-wei PCA. Since
    // the contract's conviction branch now falls through to direct spend
    // (instead of reverting), an unconditional coercion would publish at the
    // PCA-lock lifetime AND full price. The SDK must instead detect the
    // account can't cover this publish's discounted cost and keep the
    // caller's requested/default lifetime.
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    chain.pcaLockDurationEpochs = 24; // would be the coerced lifetime if it fired
    // 1-wei commit → baseEpochAllowance = 1 / lockDurationEpochs = 0 → unfundable.
    const { accountId } = await chain.createPublishingConvictionAccount(1n);
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    expect(await chain.convictionAccountCanCover(accountId, 1n)).toBe(false);

    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('pca-squat-no-coercion'),
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    // Lifetime stays at the default — NOT snapped to the PCA lock (24).
    expect(ack.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(ack.tokenAmount).toBe(BigInt(DEFAULT_PUBLISH_EPOCHS));
    expect(chain.capturedCreateParams?.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(chain.capturedCreateParams?.tokenAmount).toBe(BigInt(DEFAULT_PUBLISH_EPOCHS));
  });

  it('does NOT coerce when a nonzero-but-insufficient PCA cannot cover this publish (Codex follow-up)', async () => {
    // The earlier `spendable > 0` gate let a partially-funded (or few-wei
    // squat) account slip through: it would coerce to the lock lifetime and
    // then fall through to full-price direct spend anyway. The cost-aware
    // gate must reject an account whose remaining allowance is > 0 but
    // smaller than THIS publish's discounted cost.
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    // committedTRAC = 24 wei → baseEpochAllowance = 24/24 = 1 wei (nonzero!),
    // discountBps = 0 (below the lowest tier) → can cover a 1-wei cost but
    // nothing larger. The real publish costs far more than 1 wei.
    const { accountId } = await chain.createPublishingConvictionAccount(24n);
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    // Nonzero floor, but cannot cover a realistic publish cost.
    expect(await chain.convictionAccountCanCover(accountId, 1n)).toBe(true);
    expect(await chain.convictionAccountCanCover(accountId, ethers.parseEther('1'))).toBe(false);

    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('pca-underfunded-no-coercion'),
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    // Cost at lock lifetime (24) exceeds the 1-wei allowance → no coercion.
    expect(ack.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(chain.capturedCreateParams?.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
  });

  it('does NOT coerce when the publish cannot be priced (unverifiable funding)', async () => {
    // Codex follow-up: if the prospective publish cost cannot be quoted, the
    // coverage probe has no real price to check against. Falling back to the
    // protocol minimum (lockEpochs wei) would let an underfunded/squatted PCA
    // pass against that lower bound and coerce, then fall through to
    // full-price direct spend. An unpriceable publish must be treated as
    // "funding unverifiable" → keep the caller's requested lifetime.
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new EpochCapturingChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    // Fully funded — coercion WOULD fire if the gate fell back to the minimum.
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    // Pricing oracle is down for this publish.
    (chain as unknown as { getRequiredPublishTokenAmount: () => Promise<bigint> }).getRequiredPublishTokenAmount =
      async () => {
        throw new Error('pricing oracle unavailable');
      };

    const publisher = await makeEpochPublisher(chain, wallet);
    const ack: AckEpochCapture = {};

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: epochTestQuads('pca-unpriceable-no-coercion'),
      v10ACKProvider: captureACKInputs(ack),
    });

    expect(result.status).toBe('confirmed');
    // Funded, but unpriceable → no coercion; caller's default lifetime stands.
    expect(ack.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
    expect(chain.capturedCreateParams?.epochs).toBe(DEFAULT_PUBLISH_EPOCHS);
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

  // RC11 / PR1 deleted the self-signed ACK fallback; "self-ACK" no
  // longer exists as a publisher codepath, and the
  // `RejectingAdapterSignerChain` regression it pinned (an adapter
  // that fails to sign during self-ACK) is therefore unreachable.
  // The honest replacement is the throw-on-no-ACKs assertion in
  // `signature-collection.test.ts` ("publish() throws when no
  // v10ACKProvider is wired"), so deleting this test does not lose
  // coverage. Skipped (not removed) to preserve the historical
  // context for anyone bisecting this file.
  it.skip('continues tentatively when adapter signer fails during self-ACK', async () => {});

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

    const updated = await publisher.update(created.kaId, {
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

  it.each([
    ['no attribution', 0n],
    ['explicit publisher identity', 7n],
  ])('threads publisherNodeIdentityIdOverride=%s through V10 update params', async (_label, override) => {
    const keypair = await generateEd25519Keypair();
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterManagedUpdateChain(wallet.address);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherAddress: wallet.address,
      publisherNodeIdentityId: 99n,
    });

    const updated = await updS(publisher, 99n, {
      contextGraphId: '1',
      quads: [{
        subject: `urn:test:update-publisher-override:${override.toString()}`,
        predicate: 'http://schema.org/name',
        object: `"Override ${override.toString()}"`,
        graph: 'did:dkg:context-graph:1',
      }],
      publisherNodeIdentityIdOverride: override,
    });

    expect(updated.status).toBe('confirmed');
    expect(chain.capturedPublisherNodeIdentityId).toBe(override);
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

    const updated = await updS(publisher, 99n, {
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

    const updated = await updS(publisher, 11n, {
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
    // Greenfield (PR #815): the UAL embeds the DKGKnowledgeAssets storage
    // address, not the publisher address — attribution lives in
    // `onChainResult.publisherAddress` below.
    await expectUalEmbedsStorageAddress(updated.ual, chain, 11);
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

    const updated = await updS(publisher, 14n, {
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

    const updated = await updS(publisher, 11n, {
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
    // Greenfield (PR #815): UAL embeds the DKGKnowledgeAssets storage
    // address; attribution is asserted via onChainResult below.
    await expectUalEmbedsStorageAddress(updated.ual, chain, 11);
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

    const updated = await updS(publisher, 12n, {
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
    // Greenfield (PR #815): UAL embeds the DKGKnowledgeAssets storage
    // address; attribution is asserted via capturedPublisherAddress above.
    await expectUalEmbedsStorageAddress(updated.ual, chain, 12);
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

    const updated = await updS(publisher, 12n, {
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
    await expectUalEmbedsStorageAddress(updated.ual, chain, 12);
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

    const updated = await updS(publisher, 13n, {
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
    await expectUalEmbedsStorageAddress(updated.ual, chain, 13);

    // rc.17 uniform per-KA layout: the update rewrites the KA's data into the
    // per-KA verifiable-memory graph (…/_verifiable_memory/{author}/{number}, keyed
    // by kaId), not the monolithic root data graph. Assert the post-update data
    // in that per-KA graph (author/number unpacked from kaId 13n).
    const vmGraph = perKaVerifiableMemoryGraph('1', 13n);
    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <${vmGraph}> {
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

    const updated = await updS(publisher, 12n, {
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
    await expectUalEmbedsStorageAddress(updated.ual, chain, 12);

    // rc.17 uniform per-KA layout: the update rewrites the KA's data into the
    // per-KA verifiable-memory graph (…/_verifiable_memory/{author}/{number}, keyed
    // by kaId), not the monolithic root data graph. Assert the post-update data
    // in that per-KA graph (author/number unpacked from kaId 12n).
    const vmGraph = perKaVerifiableMemoryGraph('1', 12n);
    const stored = await store.query(`
      SELECT ?p ?o WHERE {
        GRAPH <${vmGraph}> {
          <urn:test:adapter-managed-update-without-address> ?p ?o .
        }
      }
    `);
    expect(stored.type).toBe('bindings');
    expect(stored.bindings.length).toBeGreaterThan(0);
  });
});
