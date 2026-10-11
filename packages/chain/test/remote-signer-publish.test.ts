// SPDX-License-Identifier: Apache-2.0
/**
 * V10 publish and update against the shared Hardhat node with every node-side
 * signature produced by an external signer: TRAC approvals and publish/update
 * transactions by the payer accounts, EIP-712 author attestations by a
 * separate author key that owns the minted assets and never pays. The adapter
 * holds no private key. Covers parallel publishing over two payers, the
 * write-ahead checkpoint, and a payer with no TRAC covered by a Publishing
 * Conviction Account.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers, Wallet } from 'ethers';
import {
  AUTHOR_SCHEME_VERSION_V1,
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
  computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { connectRemoteSigners, type RemoteSigners } from '../src/remote-signer-connect.js';
import { OperationalKeyUnavailableError } from '../src/evm-signer.js';
import type { PreBroadcastSignal } from '../src/chain-adapter.js';
import {
  createEVMAdapter,
  createProvider,
  createTestContextGraph,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from './helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'payer-credential-7c0d1e2f3a4b5c6d';
const AUTHOR_TOKEN = 'author-credential-0a9b8c7d6e5f4a3b';
const PCA_TOKEN = 'conviction-payer-credential-2d3e4f5a';

const payers = [Wallet.createRandom(), Wallet.createRandom()];
const author = Wallet.createRandom();
const unfundedPayer = Wallet.createRandom();
const pcaPayer = Wallet.createRandom();

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners;
let adapter: EVMChainAdapter;
let core: EVMChainAdapter;
let contextGraphId: bigint;
let kaNumber = 0n;

function addressesOf(wallets: Wallet[]): string[] {
  return wallets.map((wallet) => wallet.address);
}

async function sendEth(to: string, ether: string): Promise<void> {
  const deployer = new Wallet(HARDHAT_KEYS.DEPLOYER, createProvider());
  await (await deployer.sendTransaction({ to, value: ethers.parseEther(ether) })).wait();
}

/** Publish one KA through `chain`: author attestation from the external author key, ACK from the core node. */
async function publishThroughSigner(
  chain: EVMChainAdapter,
  label: string,
  epochs = 2,
): Promise<{ kaId: bigint; txHash: string; publisherAddress: string; authorAddress?: string; broadcasts: PreBroadcastSignal[] }> {
  const { coreProfileId } = getSharedContext();
  const byteSize = 256n;
  const tokenAmount = await chain.getRequiredPublishTokenAmount(byteSize, epochs);
  const merkleRoot = ethers.getBytes(ethers.id(`external-signer-publish-${label}`));
  const kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  const evmChainId = await chain.getEvmChainId();
  kaNumber += 1n;
  const reservedKaId = (BigInt(author.address) << 96n) | kaNumber;
  const typed = buildAuthorAttestationTypedData({
    chainId: evmChainId,
    kav10Address,
    merkleRoot,
    authorAddress: author.address,
    reservedKaId,
  });
  const authorSignature = ethers.Signature.from(
    await remote.authors!.defaultAuthor!.signTypedData(typed.domain, typed.types, typed.message),
  );
  const ackDigest = computePublishACKDigest(
    evmChainId, kav10Address, contextGraphId, merkleRoot, 1n, byteSize, BigInt(epochs),
    BigInt(tokenAmount), 1n, new Uint8Array(32), 0n, false,
  );
  const ack = ethers.Signature.from(await new Wallet(HARDHAT_KEYS.CORE_OP).signMessage(ackDigest));
  const broadcasts: PreBroadcastSignal[] = [];
  const result = await chain.createKnowledgeAssets({
    publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
    contextGraphId,
    merkleRoot,
    knowledgeAssetsAmount: 1,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable: false,
    merkleLeafCount: 1,
    reservedKaId,
    publisherNodeIdentityId: BigInt(coreProfileId),
    author: {
      address: author.address,
      signature: { r: ethers.getBytes(authorSignature.r), vs: ethers.getBytes(authorSignature.yParityAndS) },
      schemeVersion: AUTHOR_SCHEME_VERSION_V1,
    },
    ackSignatures: [{
      identityId: BigInt(coreProfileId),
      r: ethers.getBytes(ack.r),
      vs: ethers.getBytes(ack.yParityAndS),
    }],
    onBroadcast: (signal) => { broadcasts.push(signal); },
  });
  return {
    kaId: result.batchId,
    txHash: result.txHash,
    publisherAddress: ethers.getAddress(result.publisherAddress),
    ...(result.authorAddress ? { authorAddress: ethers.getAddress(result.authorAddress) } : {}),
    broadcasts,
  };
}

function signedTransactionsFrom(): string[] {
  return fake.calls('eth_signTransaction').map((request) => (
    ethers.getAddress(String((request.params[0] as { from: string }).from))
  ));
}

describe('V10 publishing through an external signer', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();
    for (const payer of payers) {
      await sendEth(payer.address, '10');
      await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, payer.address, ethers.parseEther('100000'));
    }
    await sendEth(unfundedPayer.address, '20');
    await sendEth(pcaPayer.address, '10');

    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
        { token: PCA_TOKEN, keys: [unfundedPayer.privateKey, pcaPayer.privateKey] },
      ],
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    adapter = new EVMChainAdapter({
      rpcUrl,
      hubAddress,
      chainId: 'evm:31337',
      signers: remote.operational,
      allowNoAdminSigner: true,
    });

    core = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, core.getSignerAddress(), ethers.parseEther('500000'));
    contextGraphId = await createTestContextGraph(core, undefined, 0);
  }, 180_000);

  afterAll(async () => {
    adapter?.destroy();
    core?.destroy();
    await fake?.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('holds no private key and learns its payer accounts from the signer', () => {
    expect(adapter.getSignerAddresses()).toEqual(addressesOf(payers));
    expect(remote.authors!.defaultAuthor!.address).toBe(author.address);
    expect(() => adapter.getOperationalPrivateKey()).toThrow(OperationalKeyUnavailableError);
    expect(adapter.getACKSignerKey()).toBeUndefined();
  });

  it('publishes in parallel from both payers, minting to the separate author', async () => {
    const before = fake.requests.length;
    const [first, second] = await Promise.all([
      publishThroughSigner(adapter, 'parallel-1'),
      publishThroughSigner(adapter, 'parallel-2'),
    ]);

    expect(new Set([first.publisherAddress, second.publisherAddress])).toEqual(new Set(addressesOf(payers)));
    for (const published of [first, second]) {
      expect(published.authorAddress).toBe(author.address);
      expect(ethers.getAddress(await adapter.getKnowledgeAssetOwner(published.kaId))).toBe(author.address);
      // The write-ahead checkpoint saw the exact transaction that was mined, with its nonce.
      expect(published.broadcasts).toHaveLength(1);
      expect(published.broadcasts[0].txHash).toBe(published.txHash);
      const mined = await createProvider().getTransaction(published.txHash);
      expect(published.broadcasts[0].nonce).toBe(mined!.nonce);
      expect(ethers.getAddress(mined!.from)).toBe(published.publisherAddress);
    }

    // Only payers signed transactions; the author only signed typed data, over its own credential.
    const senders = signedTransactionsFrom();
    expect(new Set(senders)).toEqual(new Set(addressesOf(payers)));
    const typedData = fake.calls('eth_signTypedData_v4').slice(-2);
    expect(typedData.map((request) => request.authorization)).toEqual([`Bearer ${AUTHOR_TOKEN}`, `Bearer ${AUTHOR_TOKEN}`]);
    expect(typedData.map((request) => ethers.getAddress(String(request.params[0])))).toEqual([author.address, author.address]);
    expect(fake.requests.slice(before).every((request) => (
      request.method !== 'eth_signTransaction' || request.authorization === `Bearer ${PAYER_TOKEN}`
    ))).toBe(true);
  }, 120_000);

  it('updates an asset with the author\'s attestation while a payer pays', async () => {
    const { coreProfileId } = getSharedContext();
    const published = await publishThroughSigner(adapter, 'update-me');
    const newMerkleRoot = ethers.getBytes(ethers.id('external-signer-update-me-v2'));
    const kav10Address = await adapter.getKnowledgeAssetsLifecycleAddress();
    const evmChainId = await adapter.getEvmChainId();
    const typed = buildUpdateAuthorAttestationTypedData({
      chainId: evmChainId,
      kav10Address,
      kaId: published.kaId,
      newMerkleRoot,
      authorAddress: author.address,
    });
    const authorSignature = ethers.Signature.from(
      await remote.authors!.defaultAuthor!.signTypedData(typed.domain, typed.types, typed.message),
    );
    const tokenAmount = await adapter.getRequiredPublishTokenAmount(256n, 2);
    const ackDigest = await adapter.computeV10UpdateAckDigest({
      kaId: published.kaId,
      newMerkleRoot,
      newByteSize: 256n,
      newMerkleLeafCount: 1,
      boundNewTokenAmount: tokenAmount,
    });
    const ack = ethers.Signature.from(await new Wallet(HARDHAT_KEYS.CORE_OP).signMessage(ackDigest));
    const broadcasts: PreBroadcastSignal[] = [];
    const updated = await adapter.updateKnowledgeCollectionV10({
      kaId: published.kaId,
      newMerkleRoot,
      newByteSize: 256n,
      newTokenAmount: tokenAmount,
      boundNewTokenAmount: tokenAmount,
      newMerkleLeafCount: 1,
      publisherNodeIdentityId: BigInt(coreProfileId),
      ackSignatures: [{ identityId: BigInt(coreProfileId), r: ethers.getBytes(ack.r), vs: ethers.getBytes(ack.yParityAndS) }],
      authorAddress: author.address,
      authorR: ethers.getBytes(authorSignature.r),
      authorVS: ethers.getBytes(authorSignature.yParityAndS),
      authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
      onBroadcast: (signal) => { broadcasts.push(signal); },
    });

    expect(updated.success).toBe(true);
    expect(addressesOf(payers)).toContain(ethers.getAddress(updated.publisherAddress!));
    expect(broadcasts).toEqual([{ txHash: updated.hash, nonce: (await createProvider().getTransaction(updated.hash))!.nonce }]);
    expect(ethers.hexlify(await adapter.getLatestMerkleRoot(published.kaId))).toBe(ethers.hexlify(newMerkleRoot));
    expect(ethers.getAddress(await adapter.getKnowledgeAssetOwner(published.kaId))).toBe(author.address);
  }, 120_000);

  it('selects and publishes from a payer without TRAC that a Publishing Conviction Account covers', async () => {
    const { rpcUrl, hubAddress } = getSharedContext();
    const provider = createProvider();
    const owner = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    let conviction: EVMChainAdapter | undefined;
    try {
      await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, owner.getSignerAddress(), ethers.parseEther('200000'));
      const { accountId } = await owner.createPublishingConvictionAccount(ethers.parseEther('100000'));
      await owner.registerPublishingConvictionAgent(accountId, pcaPayer.address);

      const pcaRemote = await connectRemoteSigners({ url: fake.url, authToken: PCA_TOKEN });
      // The uncovered payer is first in pool order and holds more gas: a
      // selection that ignored conviction coverage would pick it and revert.
      expect(pcaRemote.operational.map((signer) => signer.address)).toEqual([unfundedPayer.address, pcaPayer.address]);
      conviction = new EVMChainAdapter({
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
        signers: pcaRemote.operational,
        allowNoAdminSigner: true,
      });
      const hub = new ethers.Contract(hubAddress, ['function getContractAddress(string) view returns (address)'], provider);
      const token = new ethers.Contract(
        await hub.getContractAddress('Token'),
        ['function balanceOf(address) view returns (uint256)'],
        provider,
      );
      expect(await token.balanceOf(pcaPayer.address)).toBe(0n);

      // A conviction account covers publishes whose lifetime equals its lock duration.
      const lockEpochs = await owner.getConvictionAccountLockDurationEpochs(accountId);
      const published = await publishThroughSigner(conviction, 'conviction-covered', lockEpochs);
      expect(published.publisherAddress).toBe(pcaPayer.address);
      expect(ethers.getAddress(await conviction.getKnowledgeAssetOwner(published.kaId))).toBe(author.address);
      expect(await token.balanceOf(pcaPayer.address)).toBe(0n);
      expect(signedTransactionsFrom()).not.toContain(unfundedPayer.address);
    } finally {
      conviction?.destroy();
      owner.destroy();
    }
  }, 120_000);
});
