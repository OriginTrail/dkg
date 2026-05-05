/**
 * KnowledgeAssetsV10-edge-quorum.test.ts
 *
 * Tests added by PR #405 ("Fix edge publishes with dynamic core ACK quorum"):
 *   - empty-host context graphs accept any active sharding-table core ACKs
 *     (edge-owned CGs with no fixed hostingNodes / no legacy quorum coupling).
 *   - ACKs from operational keys whose identity is NOT in the active
 *     sharding-table core set are rejected (`_verifySignature` checks active
 *     core membership, not just stake-eligibility).
 *
 * The broader KAV10-extra audit suite was deleted on main as part of the
 * "fix(cli,storage,query,publisher): 6 critical source fixes" cleanup
 * (commit 3f496377). Only the two cases above are kept here because they
 * cover behaviour that this PR introduces and that no other test in the
 * suite exercises.
 */
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  AskStorage,
  Chronos,
  ContextGraphStorage,
  ContextGraphs,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  ParametersStorage,
  Profile,
  Staking,
  StakingV10,
  Token,
} from '../../typechain';
import {
  buildPublishAckDigest,
  buildPublishParams,
  buildPublisherDigest,
  DEFAULT_CHAIN_ID,
  signPublishDigests,
} from '../helpers/v10-kc-helpers';
import { createProfile, createProfiles } from '../helpers/profile-helpers';
import {
  getDefaultKCCreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from '../helpers/setup-helpers';
import { NodeAccounts } from '../helpers/types';

describe('@unit KnowledgeAssetsV10 — edge-CG ACK quorum (PR #405)', () => {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let KAV10: KnowledgeAssetsV10;
  let KCS: KnowledgeCollectionStorage;
  let TokenContract: Token;
  let ProfileContract: Profile;
  let StakingContract: Staking;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let ParametersStorageContract: ParametersStorage;
  let Facade: ContextGraphs;
  let CGStorageContract: ContextGraphStorage;

  let kav10Address: string;
  const chainId = DEFAULT_CHAIN_ID;
  const MIN_STAKE = ethers.parseEther('50000');

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'AskStorage',
      'EpochStorage',
      'Chronos',
      'Profile',
      'Identity',
      'Staking',
      'ParametersStorage',
      'IdentityStorage',
      'KnowledgeCollectionStorage',
      'PaymasterManager',
      'ContextGraphStorage',
      'ContextGraphs',
      'ContextGraphValueStorage',
      'DKGPublishingConvictionNFT',
      'StakingV10',
      'DKGStakingConvictionNFT',
      'KnowledgeAssetsV10',
    ]);
    const signers = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', signers[0].address);
    return {
      accounts: signers,
      Hub,
      KAV10: await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10'),
      KCS: await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      ),
      Token: await hre.ethers.getContract<Token>('Token'),
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      Staking: await hre.ethers.getContract<Staking>('Staking'),
      StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
      StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
        'DKGStakingConvictionNFT',
      ),
      ParametersStorage: await hre.ethers.getContract<ParametersStorage>(
        'ParametersStorage',
      ),
      AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
      Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
      Facade: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
      CGStorage: await hre.ethers.getContract<ContextGraphStorage>(
        'ContextGraphStorage',
      ),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    HubContract = f.Hub;
    KAV10 = f.KAV10;
    KCS = f.KCS;
    TokenContract = f.Token;
    ProfileContract = f.Profile;
    StakingContract = f.Staking;
    StakingV10Contract = f.StakingV10;
    StakingNFT = f.StakingNFT;
    ParametersStorageContract = f.ParametersStorage;
    Facade = f.Facade;
    CGStorageContract = f.CGStorage;
    kav10Address = await KAV10.getAddress();
  });

  async function fundAndStakeNode(node: NodeAccounts, identityId: number) {
    await TokenContract.mint(node.operational.address, MIN_STAKE);
    await TokenContract.connect(node.operational).approve(
      await StakingV10Contract.getAddress(),
      MIN_STAKE,
    );
    await StakingNFT.connect(node.operational).createConviction(
      identityId,
      MIN_STAKE,
      1,
    );
  }

  async function setupNodes(receivingNodesCount = 3) {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts, receivingNodesCount);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    await fundAndStakeNode(publishingNode, publisherIdentityId);
    const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);
    for (let i = 0; i < receivingNodes.length; i++) {
      await fundAndStakeNode(receivingNodes[i], receiverProfiles[i].identityId);
    }
    return { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds };
  }

  async function createOpenCG(creator: SignerWithAddress): Promise<bigint> {
    await Facade.connect(creator).createContextGraph(
      [10n, 20n, 30n],
      [],
      2,
      0,
      1,
      ethers.ZeroAddress,
      0,
    );
    return CGStorageContract.getLatestContextGraphId();
  }

  it('empty-host CG accepts any 3 active sharding-table core ACKs', async () => {
    const creator = getDefaultKCCreator(accounts);
    const { publishingNode, publisherIdentityId, receivingNodes, receiverIdentityIds } =
      await setupNodes(3);

    await Facade.connect(creator).createContextGraph(
      [],
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
    );
    const cgId = await CGStorageContract.getLatestContextGraphId();
    expect(await CGStorageContract.getHostingNodes(cgId)).to.deep.equal([]);

    const p = await buildPublishParams({
      chainId,
      kav10Address,
      publishingNode,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      contextGraphId: cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes('e8-empty-hosts')),
      knowledgeAssetsAmount: 10,
      byteSize: 1000,
      epochs: 2,
      tokenAmount: ethers.parseEther('100'),
      isImmutable: false,
      publishOperationId: 'e8-empty-hosts-op',
    });

    await TokenContract.connect(creator).approve(kav10Address, p.tokenAmount);
    await expect(KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress)).to.not.be
      .reverted;
  });

  it('rejects an ACK from an operational key whose identity is not active in the sharding table', async () => {
    const creator = getDefaultKCCreator(accounts);
    const { publishingNode, publisherIdentityId } = await setupNodes(0);
    const inactiveNode = { admin: accounts[13], operational: accounts[14] };
    const { identityId: inactiveIdentityId } = await createProfile(
      ProfileContract,
      inactiveNode,
    );
    const cgId = await createOpenCG(creator);

    await ParametersStorageContract.connect(accounts[0]).setMinimumRequiredSignatures(1);

    const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('e8-inactive-ack'));
    const tokenAmount = ethers.parseEther('100');
    const publisherDigest = buildPublisherDigest(
      chainId,
      kav10Address,
      publisherIdentityId,
      cgId,
      merkleRoot,
    );
    const ackDigest = buildPublishAckDigest(
      chainId,
      kav10Address,
      cgId,
      merkleRoot,
      10,
      1000,
      2,
      tokenAmount,
      1,
    );
    const sig = await signPublishDigests(
      publishingNode,
      [inactiveNode],
      publisherDigest,
      ackDigest,
    );
    const p = {
      publishOperationId: 'e8-inactive-ack-op',
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 10,
      byteSize: 1000,
      epochs: 2,
      tokenAmount,
      isImmutable: false,
      merkleLeafCount: 1,
      publisherNodeIdentityId: publisherIdentityId,
      publisherNodeR: sig.publisherR,
      publisherNodeVS: sig.publisherVS,
      identityIds: [inactiveIdentityId],
      r: sig.receiverRs,
      vs: sig.receiverVSs,
    };

    await TokenContract.connect(creator).approve(kav10Address, tokenAmount);
    await expect(
      KAV10.connect(creator).publishDirect(p, ethers.ZeroAddress),
    ).to.be.revertedWith('ACK signer is not an active core node');
  });
});
