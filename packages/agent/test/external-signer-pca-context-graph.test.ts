/**
 * A PCA-backed curated context graph registered by a node that signs through
 * an external signer, against the shared Hardhat node. The signer holds two
 * payers, both registered agents of a Publishing Conviction Account, and an
 * author key, which becomes the node's default agent and so curates the graph
 * created and registered with the node-level identity. An author key signs no
 * transaction, so the first payer signs the registration and owns the Context
 * Graph NFT. With
 * the registration deposit active and the account's commitment above the
 * waiver floor, the deposit is waived and the payers need no TRAC. Every
 * registered agent of the account may publish into the graph: both payers
 * publish in parallel, the account covers the cost and the author owns the
 * assets. A registration the signer refuses to sign sends nothing and leaves
 * the graph unregistered, so it can be registered again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { connectRemoteSigners, type EVMChainAdapter, type RemoteSigners } from '@origintrail-official/dkg-chain';
import {
  AUTHOR_SCHEME_VERSION_V1,
  buildAuthorAttestationTypedData,
  computePublishACKDigest,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/index.js';
import {
  createEVMAdapter,
  createProvider,
  getSharedContext,
  HARDHAT_KEYS,
  revertSnapshot,
  takeSnapshot,
} from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { startFakeRemoteSigner, type FakeSigner } from '../../chain/test/helpers/fake-remote-signer.js';

const PAYER_TOKEN = 'pca-payer-credential-6b5a4c3d2e1f0a9b';
const AUTHOR_TOKEN = 'pca-author-credential-9b0a1f2e3d4c5a6b';
const payers = [new ethers.Wallet(HARDHAT_KEYS.PUBLISHER), new ethers.Wallet(HARDHAT_KEYS.PUBLISHER2)];
const author = new ethers.Wallet(HARDHAT_KEYS.EXTRA2);
const CG = 'external-signer-pca-curated';
const DEPOSIT = ethers.parseEther('100');
const COMMITTED = ethers.parseEther('100000');
const CREATE_CONTEXT_GRAPH = ethers.id('createContextGraph(address[],uint256,uint8,uint8,address,uint256,bytes32)').slice(0, 10);

let snapshotId: string;
let fake: FakeSigner;
let remote: RemoteSigners;
let pcaOwner: ReturnType<typeof createEVMAdapter>;
let accountId: bigint;
let agent: DKGAgent;
let onChainId: bigint;
let kaNumber = 0n;
let refuseRegistration = false;

async function hubContract(name: string, abi: string[], assetStorage = false): Promise<ethers.Contract> {
  const provider = createProvider();
  const hub = new ethers.Contract(getSharedContext().hubAddress, [
    'function getContractAddress(string) view returns (address)',
    'function getAssetStorageAddress(string) view returns (address)',
  ], provider);
  const address: string = assetStorage ? await hub.getAssetStorageAddress(name) : await hub.getContractAddress(name);
  return new ethers.Contract(address, abi, provider);
}

async function tracBalances(): Promise<bigint[]> {
  const token = await hubContract('Token', ['function balanceOf(address) view returns (uint256)']);
  return Promise.all(payers.map(async (payer) => BigInt(await token.balanceOf(payer.address))));
}

/** Publish one asset into the graph: attestation by the external author key, ACK by the core node. */
async function publish(chain: EVMChainAdapter, label: string, epochs: number) {
  const { coreProfileId } = getSharedContext();
  const byteSize = 256n;
  const tokenAmount = await chain.getRequiredPublishTokenAmount(byteSize, epochs);
  const merkleRoot = ethers.getBytes(ethers.id(`external-signer-pca-curated-${label}`));
  // A curated graph's assets commit to their public catalog.
  const catalogRoot = ethers.getBytes(ethers.id(`external-signer-pca-curated-catalog-${label}`));
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
    evmChainId, kav10Address, onChainId, merkleRoot, 1n, byteSize, BigInt(epochs),
    BigInt(tokenAmount), 1n, catalogRoot, 1n, false,
  );
  const ack = ethers.Signature.from(await new ethers.Wallet(HARDHAT_KEYS.CORE_OP).signMessage(ackDigest));
  const result = await chain.createKnowledgeAssets({
    publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
    contextGraphId: onChainId,
    merkleRoot,
    knowledgeAssetsAmount: 1,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable: false,
    merkleLeafCount: 1,
    catalogRoot,
    catalogLeafCount: 1,
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
  });
  return { kaId: result.batchId, publisherAddress: ethers.getAddress(result.publisherAddress) };
}

describe('PCA-backed curated context graph with an external signer', () => {
  beforeAll(async () => {
    snapshotId = await takeSnapshot();
    const provider = createProvider();
    const { rpcUrl, hubAddress } = getSharedContext();

    const deployer = new ethers.Wallet(HARDHAT_KEYS.DEPLOYER, provider);
    const parameters = (await hubContract('ParametersStorage', [
      'function setContextGraphRegistrationDeposit(uint96)',
    ])).connect(deployer) as ethers.Contract;
    await (await parameters.setContextGraphRegistrationDeposit(DEPOSIT)).wait();

    // The test accounts are minted TRAC at deployment; the payers keep only native gas.
    const token = await hubContract('Token', [
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address, uint256) returns (bool)',
    ]);
    for (const payer of payers) {
      const holder = token.connect(payer.connect(provider)) as ethers.Contract;
      await (await holder.transfer(deployer.address, await token.balanceOf(payer.address))).wait();
    }

    pcaOwner = createEVMAdapter(HARDHAT_KEYS.EXTRA1);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, pcaOwner.getSignerAddress(), COMMITTED);
    ({ accountId } = await pcaOwner.createPublishingConvictionAccount(COMMITTED));
    for (const payer of payers) await pcaOwner.registerPublishingConvictionAgent(accountId, payer.address);

    fake = await startFakeRemoteSigner({
      credentials: [
        { token: PAYER_TOKEN, keys: payers.map((payer) => payer.privateKey) },
        { token: AUTHOR_TOKEN, keys: [author.privateKey] },
      ],
      reject: (method, request) => (
        refuseRegistration && method === 'eth_signTransaction'
          && String((request.params[0] as { data?: unknown }).data).startsWith(CREATE_CONTEXT_GRAPH)
          ? { code: -32000, message: 'policy refused the transaction' }
          : undefined
      ),
    });
    remote = await connectRemoteSigners({ url: fake.url, authToken: PAYER_TOKEN, author: { authToken: AUTHOR_TOKEN } });
    agent = await DKGAgent.create({
      name: 'ExternalSignerPcaCurator',
      store: new OxigraphStore(),
      listenHost: '127.0.0.1',
      listenPort: 0,
      nodeRole: 'edge',
      chainConfig: {
        rpcUrl,
        hubAddress,
        chainId: 'evm:31337',
        signers: remote.operational,
        authors: remote.authors,
      },
    });
    await agent.start();
  }, 180_000);

  afterAll(async () => {
    await agent?.stop().catch(() => {});
    pcaOwner?.destroy();
    await fake?.close();
    if (snapshotId) await revertSnapshot(snapshotId);
  });

  it('registers the graph through a payer that is an agent of the account, with the deposit waived', async () => {
    const parameters = await hubContract('ParametersStorage', [
      'function contextGraphRegistrationDeposit() view returns (uint96)',
      'function minPcaCommitmentForCgWaiver() view returns (uint96)',
    ]);
    expect(await parameters.contextGraphRegistrationDeposit()).toBe(DEPOSIT);
    expect(await parameters.minPcaCommitmentForCgWaiver()).toBeLessThanOrEqual(COMMITTED);
    expect(remote.operational.map((signer) => signer.address)).toEqual(payers.map((payer) => payer.address));
    expect(await tracBalances()).toEqual([0n, 0n]);

    // The signer's author key is the node's default agent, registered at start without a stored key.
    expect(agent.getDefaultAgentAddress()).toBe(author.address);
    expect(agent.getLocalAgentMode(author.address)).toBe('self-sovereign');
    await agent.createContextGraph({ id: CG, name: 'External signer PCA curated', accessPolicy: 1 });

    // The signer first refuses the registration transaction: nothing is sent, and the graph is
    // left unregistered, not pending, so registering it again goes ahead.
    const provider = createProvider();
    const nonce = await provider.getTransactionCount(payers[0].address, 'pending');
    const signingRequests = fake.calls('eth_signTransaction').length;
    refuseRegistration = true;
    await expect(agent.registerContextGraph(CG, { publishAuthorityAccountId: accountId }))
      .rejects.toMatchObject({ code: 'REMOTE_SIGNER_REJECTED' });
    refuseRegistration = false;
    expect(fake.calls('eth_signTransaction')).toHaveLength(signingRequests + 1);
    expect(await provider.getTransactionCount(payers[0].address, 'pending')).toBe(nonce);
    expect(await agent.readLocalContextGraphRegistrationStatus(CG)).toBe('unregistered');

    const registered = await agent.registerContextGraph(CG, { publishAuthorityAccountId: accountId });
    onChainId = BigInt(registered.onChainId);

    const waiver = await hubContract('ContextGraphWaiverStorage', [
      'function waivedCgCount(uint256) view returns (uint256)',
    ]);
    const storage = await hubContract('ContextGraphStorage', [
      'function getContextGraphOwner(uint256) view returns (address)',
      'function getParticipantAgents(uint256) view returns (address[])',
      'function getRegistrationEscrow(uint256) view returns (uint96)',
      'function getPublishAuthorityAccountId(uint256) view returns (uint256)',
    ], true);
    expect(await waiver.waivedCgCount(accountId)).toBe(1n);
    expect(await storage.getRegistrationEscrow(onChainId)).toBe(0n);
    expect(await storage.getPublishAuthorityAccountId(onChainId)).toBe(accountId);
    expect(await storage.getContextGraphOwner(onChainId)).toBe(payers[0].address);
    expect([...await storage.getParticipantAgents(onChainId)]).toContain(author.address);
    expect(await tracBalances()).toEqual([0n, 0n]);
    expect(await agent.getContextGraphCurator(CG)).toBe(`did:dkg:agent:${author.address}`);
    // The author key signed typed data only; every transaction was signed by a payer.
    const transactions = fake.calls('eth_signTransaction');
    expect(transactions.length).toBeGreaterThan(0);
    expect(transactions.every((request) => request.authorization === `Bearer ${PAYER_TOKEN}`)).toBe(true);
  }, 120_000);

  it('publishes into the graph from both payers in parallel, covered by the account and owned by the author', async () => {
    const chain = (agent as unknown as { chain: EVMChainAdapter }).chain;
    const contextGraphs = await hubContract('ContextGraphs', [
      'function isAuthorizedPublisher(uint256, address) view returns (bool)',
    ]);
    for (const payer of payers) expect(await contextGraphs.isAuthorizedPublisher(onChainId, payer.address)).toBe(true);
    expect(await contextGraphs.isAuthorizedPublisher(onChainId, author.address)).toBe(false);

    const epochs = await chain.getConvictionAccountLockDurationEpochs(accountId);
    const published = await Promise.all(['one', 'two'].map((label) => publish(chain, label, epochs)));

    expect(new Set(published.map((result) => result.publisherAddress))).toEqual(new Set(payers.map((payer) => payer.address)));
    for (const result of published) {
      expect(ethers.getAddress(await chain.getKnowledgeAssetOwner(result.kaId))).toBe(author.address);
    }
    expect(await tracBalances()).toEqual([0n, 0n]);
  }, 120_000);
});
