/**
 * DKGPublisher over an EVM adapter that holds no private key: the paying
 * (operational) accounts and the author key both live in an external signer.
 * The author is the owner of every published asset and signs the RFC-001
 * attestations; the payers sign approvals and publish/update transactions and
 * are used in parallel. Runs against the shared Hardhat node.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers, Wallet } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter, connectRemoteSigners, type RemoteSigners } from '@origintrail-official/dkg-chain';
import { TypedEventBus, buildAuthorAttestationTypedData, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { DKGPublisher } from '../src/dkg-publisher.js';
import {
  createEVMAdapter,
  createProvider,
  createTestContextGraph,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';
import { buildSeal, buildUpdateSeal } from './_helpers/seal.js';
import { hardhatACKProvider, makeHardhatUpdateACKProvider } from './_helpers/acks.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';

const PAYER_TOKEN = 'payer-credential-31a2b3c4d5e6f708';
const AUTHOR_TOKEN = 'author-credential-8f7e6d5c4b3a2918';

const payers = [Wallet.createRandom(), Wallet.createRandom()];
const authorKey = Wallet.createRandom();

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners;
let chain: EVMChainAdapter;
let core: ReturnType<typeof createEVMAdapter>;
let contextGraphId: string;
let kav10Address: string;

function q(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: `did:dkg:context-graph:${contextGraphId}` };
}

async function newPublisher(authorSigner: ConstructorParameters<typeof DKGPublisher>[0]['authorSigner']) {
  return new DKGPublisher({
    store: new OxigraphStore(),
    chain,
    eventBus: new TypedEventBus(),
    keypair: await generateEd25519Keypair(),
    publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    authorSigner,
    kaAllocator: makeTestKaAllocator(),
  });
}

/** A seal author whose attestations are produced by the publisher's configured author signer. */
function authorThroughPublisher(publisher: DKGPublisher, address: string): Wallet {
  return {
    address,
    signTypedData: async (
      domain: ethers.TypedDataDomain,
      types: Record<string, Array<{ name: string; type: string }>>,
      message: Record<string, unknown>,
    ) => {
      const { r, vs } = await publisher.signAuthorAttestationAsPublisher({
        domain: domain as { name: string; version: string; chainId: bigint; verifyingContract: string },
        types,
        message,
      });
      return ethers.Signature.from({ r: ethers.hexlify(r), yParityAndS: ethers.hexlify(vs) }).serialized;
    },
  } as unknown as Wallet;
}

describe('DKGPublisher with an external signer', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();
    const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    for (const payer of payers) {
      await (await deployer.sendTransaction({ to: payer.address, value: ethers.parseEther('10') })).wait();
      await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, payer.address, ethers.parseEther('100000'));
    }
    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [authorKey.privateKey] },
      ],
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    chain = new EVMChainAdapter({
      rpcUrl,
      hubAddress,
      chainId: 'evm:31337',
      signers: remote.operational,
      allowNoAdminSigner: true,
    });
    core = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, core.getSignerAddress(), ethers.parseEther('500000'));
    contextGraphId = String(await createTestContextGraph(core, undefined, 0));
    kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  }, 180_000);

  afterAll(async () => {
    chain?.destroy();
    core?.destroy();
    await fake?.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('publishes in parallel from two payers and updates, with ownership staying with the author', async () => {
    const author = remote.authors!.defaultAuthor!;
    const publisher = await newPublisher(author);
    expect(await publisher.publisherFallbackAuthorAddress()).toBe(authorKey.address);
    const sealAuthor = authorThroughPublisher(publisher, author.address);
    const ctx = { provider: createProvider(), kav10Address };

    const results = await Promise.all(['one', 'two'].map(async (label) => {
      const quads = [q(`urn:external-signer:${label}`, 'http://schema.org/name', `"${label}"`)];
      return publisher.publish({
        contextGraphId,
        quads,
        precomputedAttestation: await buildSeal({ quads, author: sealAuthor, contextGraphId, ctx }),
        v10ACKProvider: hardhatACKProvider(kav10Address),
      });
    }));

    expect(results.map((result) => result.status)).toEqual(['confirmed', 'confirmed']);
    const paidBy = results.map((result) => ethers.getAddress(result.onChainResult!.publisherAddress));
    expect(new Set(paidBy)).toEqual(new Set(payers.map((payer) => payer.address)));
    for (const result of results) {
      expect(ethers.getAddress(await chain.getKnowledgeAssetOwner(result.onChainResult!.batchId))).toBe(authorKey.address);
    }
    const typedDataRequests = fake.calls('eth_signTypedData_v4');
    expect(typedDataRequests.length).toBeGreaterThanOrEqual(2);
    expect(typedDataRequests.every((request) => (
      request.authorization === `Bearer ${AUTHOR_TOKEN}`
      && ethers.getAddress(String(request.params[0])) === authorKey.address
    ))).toBe(true);
    expect(fake.calls('eth_signTransaction').every((request) => (
      request.authorization === `Bearer ${PAYER_TOKEN}`
    ))).toBe(true);

    const kaId = results[0].onChainResult!.batchId;
    const updateQuads = [q('urn:external-signer:one', 'http://schema.org/name', '"one, revised"')];
    const updated = await publisher.update(kaId, {
      contextGraphId,
      quads: updateQuads,
      precomputedUpdateAttestation: await buildUpdateSeal({ kaId, quads: updateQuads, author: sealAuthor, ctx }),
      v10UpdateACKProvider: makeHardhatUpdateACKProvider(
        getSharedContext(),
        chain,
        [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
      ),
    });
    expect(updated.status).toBe('confirmed');
    expect(ethers.hexlify(await chain.getLatestMerkleRoot(kaId))).toBe(ethers.hexlify(updated.merkleRoot));
    expect(ethers.getAddress(await chain.getKnowledgeAssetOwner(kaId))).toBe(authorKey.address);
  }, 180_000);

  it('never falls back to a paying account as the author', async () => {
    const typed = buildAuthorAttestationTypedData({
      chainId: 31337n,
      kav10Address,
      merkleRoot: ethers.getBytes(ethers.id('no-author')),
      authorAddress: payers[0].address,
      reservedKaId: (BigInt(payers[0].address) << 96n) | 1n,
    });
    // Explicitly without an author, and with the author left out over a chain whose wallets sign externally.
    for (const authorSigner of [null, undefined]) {
      const publisher = await newPublisher(authorSigner);
      expect(await publisher.publisherFallbackAuthorAddress()).toBeUndefined();
      const typedBefore = fake.calls('eth_signTypedData_v4').length;
      await expect(publisher.signAuthorAttestationAsPublisher(typed)).rejects.toThrow(/no author signer is configured/);
      expect(fake.calls('eth_signTypedData_v4')).toHaveLength(typedBefore);
    }
    // A chain whose wallet signs locally keeps that wallet as the fallback author.
    const local = new DKGPublisher({
      store: new OxigraphStore(),
      chain: core,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
    });
    expect(await local.publisherFallbackAuthorAddress()).toBe(core.getSignerAddress());
  });
});
