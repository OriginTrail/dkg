// Standalone V10 Publishing Conviction NFT lifecycle: create → topUp →
// registerAgent → deregisterAgent → settle, plus the discounted publish
// path through a real KnowledgeAssetsLifecycle.publish() and the post-expiry
// revert. Peer of test/v10-e2e-conviction.test.ts (Flow 3).

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  ContextGraphs,
  ContextGraphStorage,
  DKGPublishingConvictionNFT,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  KnowledgeAssetsLifecycle,
  DKGKnowledgeAssets,
  ParametersStorage,
  Profile,
  PublishingConviction,
  StakingV10,
  Token,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultKCCreator,
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
} from './helpers/setup-helpers';
import {
  buildPublishParams,
  buildUpdateParams,
  packReservedKaId,
  DEFAULT_CHAIN_ID,
} from './helpers/v10-kc-helpers';

const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
const EXPECTED_DISCOUNT_BPS = 2000n;
const STAKER_SHARD_ID = 1n;
const MIN_STAKE = ethers.parseEther('50000');

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  ConvictionStakingStorage: ConvictionStakingStorage;
  StakingV10: StakingV10;
  StakingNFT: DKGStakingConvictionNFT;
  KnowledgeAssetsLifecycle: KnowledgeAssetsLifecycle;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
  EpochStorage: EpochStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  NFT: DKGPublishingConvictionNFT;
  PublishingConviction: PublishingConviction;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
    ConvictionStakingStorage:
      await hre.ethers.getContract<ConvictionStakingStorage>(
        'ConvictionStakingStorage',
      ),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    StakingNFT: await hre.ethers.getContract<DKGStakingConvictionNFT>(
      'DKGStakingConvictionNFT',
    ),
    KnowledgeAssetsLifecycle: await hre.ethers.getContract<KnowledgeAssetsLifecycle>(
      'KnowledgeAssetsLifecycle',
    ),
    DKGKnowledgeAssets:
      await hre.ethers.getContract<DKGKnowledgeAssets>(
        'DKGKnowledgeAssets',
      ),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage:
      await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
    PublishingConviction:
      await hre.ethers.getContract<PublishingConviction>(
        'PublishingConviction',
      ),
  };
}

describe('@integration V10 PCA lifecycle (DKGPublishingConvictionNFT)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let HubContract: Hub;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let ConvictionStakingStorage: ConvictionStakingStorage;
  let StakingV10Contract: StakingV10;
  let StakingNFT: DKGStakingConvictionNFT;
  let KAV10: KnowledgeAssetsLifecycle;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let EpochStorageContract: EpochStorage;
  let CGFacade: ContextGraphs;
  let CGS: ContextGraphStorage;
  let NFT: DKGPublishingConvictionNFT;
  let LogicContract: PublishingConviction;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos,
      Profile: ProfileContract,
      ConvictionStakingStorage,
      StakingV10: StakingV10Contract,
      StakingNFT,
      KnowledgeAssetsLifecycle: KAV10,
      DKGKnowledgeAssets,
      EpochStorage: EpochStorageContract,
      ContextGraphs: CGFacade,
      ContextGraphStorage: CGS,
      NFT,
      PublishingConviction: LogicContract,
    } = await loadFixture(deployFixture));
  });

  afterEach(async () => {
    // Flow-through invariant: the NFT contract must NEVER custody TRAC.
    expect(await Token.balanceOf(await NFT.getAddress())).to.equal(0n);
  });

  // Mint + fund a fresh conviction account owned by `owner`.
  const createAccountFor = async (
    owner: SignerWithAddress,
  ): Promise<bigint> => {
    await Token.mint(owner.address, COMMITTED_TRAC);
    await Token.connect(owner).approve(await NFT.getAddress(), COMMITTED_TRAC);
    await NFT.connect(owner).createAccount(COMMITTED_TRAC);
    return NFT.totalSupply();
  };

  // --------------------------------------------------------------------------
  // 1. create → topUp → registerAgent → deregisterAgent → settle
  // --------------------------------------------------------------------------
  it('asserts on-chain state across create/topUp/registerAgent/deregisterAgent/settle', async () => {
    const creator = getDefaultKCCreator(accounts);
    const agent = accounts[8];
    const stranger = accounts[7];

    // ---- createAccount ----
    const accountId = await createAccountFor(creator);
    expect(accountId).to.equal(1n);
    expect(await NFT.ownerOf(accountId)).to.equal(creator.address);
    let info = await NFT.getAccountInfo(accountId);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.discountBps).to.equal(EXPECTED_DISCOUNT_BPS);
    expect(info.topUpBuffer).to.equal(0n);
    expect(info.agentCount).to.equal(0n);
    expect(info.fullySwept).to.equal(false);
    const expiresAtEpochAtCreate = info.expiresAtEpoch;

    // ---- topUp (owner-gated, does not move committedTRAC/expiry) ----
    const top = ethers.parseEther('1000');
    await Token.mint(creator.address, top);
    await Token.connect(creator).approve(await NFT.getAddress(), top);
    await expect(NFT.connect(creator).topUp(accountId, top))
      .to.emit(LogicContract, 'ToppedUp')
      .withArgs(accountId, top, top);
    info = await NFT.getAccountInfo(accountId);
    expect(info.topUpBuffer).to.equal(top);
    expect(info.committedTRAC).to.equal(COMMITTED_TRAC);
    expect(info.expiresAtEpoch).to.equal(expiresAtEpochAtCreate);

    // Owner-gating invariant: a non-owner write must propagate the revert.
    await expect(
      NFT.connect(stranger).topUp(accountId, top),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- registerAgent ----
    await expect(NFT.connect(creator).registerAgent(accountId, agent.address))
      .to.emit(LogicContract, 'AgentRegistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(true);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(accountId);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(1n);
    await expect(
      NFT.connect(stranger).registerAgent(accountId, stranger.address),
    ).to.be.revertedWithCustomError(NFT, 'NotAccountOwner');

    // ---- deregisterAgent ----
    await expect(NFT.connect(creator).deregisterAgent(accountId, agent.address))
      .to.emit(LogicContract, 'AgentDeregistered')
      .withArgs(accountId, agent.address);
    expect(await NFT.isAgent(accountId, agent.address)).to.equal(false);
    expect(await NFT.agentToAccountId(agent.address)).to.equal(0n);
    expect((await NFT.getAccountInfo(accountId)).agentCount).to.equal(0n);

    // ---- settle: one elapsed window advances the lazy-settlement cursor ----
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength));
    await NFT.connect(stranger).settle(accountId); // permissionless
    expect((await NFT.getAccountInfo(accountId)).lastSettledWindow).to.equal(
      1n,
    );

    // ---- settle: post-expiry final sweep marks the account fully swept ----
    const acct = await NFT.accounts(accountId);
    const lockDurationEpochs = acct[5];
    await time.increase(Number(epochLength) * (Number(lockDurationEpochs) + 1));
    await expect(NFT.connect(stranger).settle(accountId)).to.emit(
      LogicContract,
      'AccountFinalSwept',
    );
    expect((await NFT.getAccountInfo(accountId)).fullySwept).to.equal(true);
  });

  // V10 ACK signer gate reads `getNodeStakeV10`; bring nodes' V10 stake
  // above zero via the conviction-staking NFT path.
  const stakeV10 = async (
    staker: SignerWithAddress,
    identityId: number,
    amount: bigint,
  ) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(
      await StakingV10Contract.getAddress(),
      amount,
    );
    await StakingNFT.connect(staker).createConviction(identityId, amount, 1);
  };

  // Stand up publisher + receiver profiles (V10-staked for the ACK signer
  // gate), a fresh registered conviction agent, and an open context graph.
  // Returns everything `buildPublishParams` needs plus the account's
  // `lockDurationEpochs` (the discount-branch epoch count).
  const setupRegisteredAgentPublish = async () => {
    const publishingNode = getDefaultPublishingNode(accounts);
    const receivingNodes = getDefaultReceivingNodes(accounts);
    const { identityId: publisherIdentityId } = await createProfile(
      ProfileContract,
      publishingNode,
    );
    const receiverProfiles = await createProfiles(
      ProfileContract,
      receivingNodes,
    );
    const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

    await stakeV10(publishingNode.operational, publisherIdentityId, MIN_STAKE);
    for (let i = 0; i < receivingNodes.length; i++) {
      await stakeV10(
        receivingNodes[i].operational,
        receiverProfiles[i].identityId,
        MIN_STAKE,
      );
    }

    const creator = getDefaultKCCreator(accounts);
    const accountId = await createAccountFor(creator);
    await NFT.connect(creator).registerAgent(accountId, creator.address);
    expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      0,
      1,
      ethers.ZeroAddress,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be
      .true;

    // Discount branch requires p.epochs == lockDurationEpochs.
    const epochs = Number((await NFT.accounts(accountId))[5]);
    return {
      creator,
      accountId,
      cgId,
      epochs,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    };
  };

  const createCuratedContextGraphFor = async (
    creator: SignerWithAddress,
  ): Promise<bigint> => {
    await CGFacade.connect(creator).createContextGraph(
      [],
      0,
      1,
      0,
      creator.address,
      0,
      ethers.ZeroHash,
    );
    const cgId = await CGS.getLatestContextGraphId();
    expect(await CGS.getIsCurated(cgId)).to.equal(true);
    expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be
      .true;
    return cgId;
  };

  // --------------------------------------------------------------------------
  // 2. registered agent publishes via real KnowledgeAssetsLifecycle.publish()
  // --------------------------------------------------------------------------
  it('takes the discount branch when epochs == lockDurationEpochs and the discounted cost is asserted on chain', async () => {
    const {
      creator,
      epochs,
      cgId,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    } = await setupRegisteredAgentPublish();

    const tokenAmount = ethers.parseEther('1000');
    const expectedDiscounted =
      (tokenAmount * (10_000n - EXPECTED_DISCOUNT_BPS)) / 10_000n;
    expect(expectedDiscounted).to.be.lessThan(tokenAmount);

    const currentEpoch = await Chronos.getCurrentEpoch();
    const merkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('v10-pca-lifecycle'),
    );
    // OT-RFC-43 Option 1 (1a): author-namespaced packed id we expect to mint.
    const reservedKaId = packReservedKaId(creator.address, 1);
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'v10-pca-lifecycle-op',
      reservedKaId,
    });

    const tx = await KAV10.connect(creator).publish(p);
    const receipt = await tx.wait();
    expect(receipt!.status).to.equal(1);

    // The conviction branch funds the staker pool with the DISCOUNTED cost
    // via the NFT's `coverPublishingCost` → `addTokensToEpochRange`. A
    // direct-spend fallthrough would instead distribute the full amount.
    const epochStorageAddr = (
      await EpochStorageContract.getAddress()
    ).toLowerCase();
    let activeSinkSum = 0n;
    for (const log of receipt!.logs) {
      if (log.address.toLowerCase() !== epochStorageAddr) continue;
      try {
        const parsed = EpochStorageContract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        });
        if (parsed?.name === 'TokensAddedToEpochRange') {
          expect(BigInt(parsed.args.shardId)).to.equal(STAKER_SHARD_ID);
          expect(BigInt(parsed.args.startEpoch)).to.be.gte(currentEpoch);
          expect(BigInt(parsed.args.endEpoch)).to.be.lte(
            currentEpoch + BigInt(epochs),
          );
          activeSinkSum += BigInt(parsed.args.tokenAmount);
        }
      } catch {
        // not the event we're after
      }
    }
    expect(activeSinkSum).to.equal(expectedDiscounted);

    // KC records the FULL tokenAmount; only the staker-pool distribution is
    // discounted — the on-chain proof the discount branch (not direct
    // spend) executed. OT-RFC-43 Option 1 (1a): the minted kaId equals the
    // packed reservedKaId we supplied (ids are no longer globally sequential).
    const kaId = reservedKaId;
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(creator.address);
    const meta =
      await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
    expect(meta[6]).to.equal(tokenAmount);
    expect(activeSinkSum).to.be.lessThan(meta[6]);
  });

  // --------------------------------------------------------------------------
  // 3. expired account: real publish() loses the discount and reverts
  // --------------------------------------------------------------------------
  //
  // On an expired PCA `KnowledgeAssetsLifecycle.publish()` gates the conviction
  // discount off (block.timestamp >= expiresAtTimestamp) and falls through
  // to the direct-spend branch — `_addTokens` pulls the FULL cost from the
  // agent. The registered agent here was only ever funded for the up-front
  // `committedTRAC` (consumed by createAccount) and never approved KAV10
  // for a direct spend, so the post-expiry publish reverts with
  // `TooLowAllowance` and no KC is created (atomic rollback). The same
  // agent publishing the SAME unfunded params BEFORE expiry succeeds via
  // the NFT-funded discount branch (asserted in test 2) — the revert is
  // expiry-driven, not a missing-approval artifact.
  it('expired account: real publish() drops the discount, reverts TooLowAllowance, creates no KC', async () => {
    const {
      creator,
      accountId,
      epochs,
      cgId,
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
    } = await setupRegisteredAgentPublish();

    // Advance past `expiresAtTimestamp` (lockDurationEpochs + 1 to clear
    // the window containing expiry plus the chain-epoch drift buffer).
    const epochLength = await Chronos.epochLength();
    await time.increase(Number(epochLength) * (epochs + 1));
    expect(
      BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp),
    ).to.be.gte((await NFT.getAccountInfo(accountId)).expiresAtTimestamp);

    const tokenAmount = ethers.parseEther('1000');
    const merkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('v10-pca-lifecycle-expired'),
    );
    const p = await buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes,
      publisherIdentityId,
      receiverIdentityIds,
      author: creator,
      contextGraphId: cgId,
      merkleRoot,
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs,
      tokenAmount,
      isImmutable: false,
      publishOperationId: 'v10-pca-lifecycle-expired-op',
    });

    await expect(
      KAV10.connect(creator).publish(p),
    ).to.be.revertedWithCustomError(KAV10, 'TooLowAllowance');

    // Atomic rollback: the expired publish minted no knowledge collection.
    // OT-RFC-43 Option 1 (1a): `getLatestKnowledgeAssetId` is deprecated (it
    // reverts), so we assert the reserved id was never minted — `ownerOf`
    // reverts on a non-existent token.
    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(DKGKnowledgeAssets, 'ERC721NonexistentToken');
  });

  // --------------------------------------------------------------------------
  // 4. Greenfield KA invariants (KC→KA rename / PR #815)
  // --------------------------------------------------------------------------
  //
  // These guard the core economic + ownership invariants of the greenfield
  // Knowledge Asset model that the KC→KA rename re-plumbed. Before this
  // block the `KnowledgeAssetsLifecycle.publish` negatives (one-KA-per-tx,
  // strict-positive token floor) and the owner-sealed update gate had no
  // direct on-chain coverage — only happy-path publishes were exercised, so
  // a regression that dropped a gate or renamed an error would have shipped
  // green. Each test pins the EXACT custom error (and args) rather than a
  // bare `to.be.reverted`, so a renamed/removed revert turns the lane red.

  const buildBasePublishParams = async (
    setup: Awaited<ReturnType<typeof setupRegisteredAgentPublish>>,
    label: string,
    overrides: Partial<Parameters<typeof buildPublishParams>[0]> = {},
  ) =>
    buildPublishParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      author: setup.creator,
      contextGraphId: setup.cgId,
      merkleRoot: ethers.keccak256(ethers.toUtf8Bytes(label)),
      knowledgeAssetsAmount: 1,
      byteSize: 1000,
      epochs: setup.epochs,
      tokenAmount: ethers.parseEther('1000'),
      isImmutable: false,
      publishOperationId: `${label}-op`,
      ...overrides,
    });

  it('greenfield: publish reverts InvalidKnowledgeAssetsAmount unless exactly one KA is minted per tx', async () => {
    const setup = await setupRegisteredAgentPublish();
    // The author attestation does NOT commit to knowledgeAssetsAmount, so the
    // amount gate (`_executePublishCore`) is reached before the ACK signature
    // check — flipping the count to anything but 1 must revert with the
    // amount echoed back.
    const attemptedKaIds: bigint[] = [];
    for (const amount of [0, 2, 5]) {
      const p = await buildBasePublishParams(setup, `amount-gate-${amount}`, {
        knowledgeAssetsAmount: amount,
      });
      attemptedKaIds.push(BigInt(p.reservedKaId));
      await expect(KAV10.connect(setup.creator).publish(p))
        .to.be.revertedWithCustomError(KAV10, 'InvalidKnowledgeAssetsAmount')
        .withArgs(BigInt(amount));
    }
    // None of the reverted attempts minted a token. OT-RFC-43 Option 1 (1a):
    // `getLatestKnowledgeAssetId` reverts (deprecated), so assert each
    // reserved id is unminted (`ownerOf` reverts on a non-existent token).
    for (const id of attemptedKaIds) {
      await expect(
        DKGKnowledgeAssets.ownerOf(id),
      ).to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'ERC721NonexistentToken',
      );
    }
  });

  it('greenfield: publish reverts InvalidTokenAmount(1,0) on a zero token amount (strict-positive floor)', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'token-floor', {
      tokenAmount: 0n,
    });
    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(KAV10, 'InvalidTokenAmount')
      .withArgs(1, 0);
    // OT-RFC-43 Option 1 (1a): nothing minted — the reserved id stays unowned.
    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('greenfield: curated publish requires a catalog commitment before value enters sampling', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const p = await buildBasePublishParams(setup, 'curated-missing-catalog', {
      contextGraphId: curatedCgId,
    });

    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(
        KAV10,
        'CuratedCGRequiresCatalogCommitment',
      )
      .withArgs(curatedCgId);

    await expect(
      DKGKnowledgeAssets.ownerOf(p.reservedKaId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('greenfield: curated publish with a full catalog commitment persists the sampling proof anchor', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const catalogRoot = ethers.keccak256(
      ethers.toUtf8Bytes('curated-publish-catalog-root'),
    );
    const catalogLeafCount = 3n;
    const p = await buildBasePublishParams(setup, 'curated-with-catalog', {
      contextGraphId: curatedCgId,
      catalogRoot,
      catalogLeafCount,
    });

    await (await KAV10.connect(setup.creator).publish(p)).wait();

    const kaId = BigInt(p.reservedKaId);
    expect(await CGS.kaToContextGraph(kaId)).to.equal(curatedCgId);
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(catalogRoot);
    expect(await DKGKnowledgeAssets.getCatalogLeafCount(kaId)).to.equal(
      catalogLeafCount,
    );
  });

  it('update: paid legacy curated top-up requires the first catalog commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 777);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-uncommitted-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-uncommitted')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-paid-top-up'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-paid-top-up-op',
      author: setup.creator,
    });

    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(
        KAV10,
        'CuratedCGRequiresCatalogCommitment',
      )
      .withArgs(curatedCgId);
  });

  it('update: paid legacy curated top-up succeeds when it supplies the first catalog commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 778);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-first-commit-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-first-commit')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);

    const firstCommitmentRoot = ethers.keccak256(
      ethers.toUtf8Bytes('legacy-curated-first-commit-root'),
    );
    const firstCommitmentCount = 4n;
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-paid-top-up-committed'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount + ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-first-commit-op',
      author: setup.creator,
      newCatalogRoot: firstCommitmentRoot,
      newCatalogLeafCount: firstCommitmentCount,
    });

    await (await KAV10.connect(setup.creator).update(up)).wait();

    // The paid top-up supplied the first commitment, so the legacy KA can now
    // enter value-weighted sampling — the commitment anchor is persisted.
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(firstCommitmentRoot);
    expect(await DKGKnowledgeAssets.getCatalogLeafCount(kaId)).to.equal(
      firstCommitmentCount,
    );
  });

  it('update: metadata-only maintenance of a legacy uncommitted curated KA stays allowed without a commitment', async () => {
    const setup = await setupRegisteredAgentPublish();
    const curatedCgId = await createCuratedContextGraphFor(setup.creator);
    const storageOperator = accounts[19];
    await HubContract.setContractAddress(
      'TestStorageOperator',
      storageOperator.address,
    );

    const currentEpoch = await Chronos.getCurrentEpoch();
    const endEpoch = currentEpoch + BigInt(setup.epochs);
    const initialTokenAmount = ethers.parseEther('1000');
    const kaId = packReservedKaId(setup.creator.address, 779);
    await DKGKnowledgeAssets.connect(storageOperator).createKnowledgeAsset(
      storageOperator.address,
      setup.creator.address,
      kaId,
      'legacy-curated-metadata-only-op',
      ethers.keccak256(ethers.toUtf8Bytes('legacy-curated-metadata-only')),
      1,
      1000,
      currentEpoch,
      endEpoch,
      initialTokenAmount,
      false,
      1,
    );
    await CGS.connect(storageOperator).registerKnowledgeAssetToContextGraph(
      curatedCgId,
      kaId,
    );

    // No paid top-up (newTokenAmount unchanged) and no catalog pair: this is
    // metadata-only maintenance, which stays allowed for legacy uncommitted
    // curated KAs — the commitment gate only guards value-adding (paid) updates.
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: curatedCgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: ethers.keccak256(
        ethers.toUtf8Bytes('legacy-curated-metadata-only-update'),
      ),
      newByteSize: 1000n,
      newTokenAmount: initialTokenAmount,
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'legacy-curated-metadata-only-op',
      author: setup.creator,
    });

    await (await KAV10.connect(setup.creator).update(up)).wait();

    // Still uncommitted and that is fine — metadata maintenance does not force
    // a commitment on a legacy curated KA.
    expect(await DKGKnowledgeAssets.getCatalogRoot(kaId)).to
      .equal(ethers.ZeroHash);
  });

  it('greenfield: a successful publish mints exactly one KA (the packed reservedKaId) to the author and binds it to the CG', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'greenfield-mint');
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    // OT-RFC-43 Option 1 (1a): the minted kaId equals the packed reservedKaId
    // (author-namespaced; ids are no longer globally sequential).
    const kaId = BigInt(p.reservedKaId);
    expect(kaId >> 96n).to.equal(BigInt(setup.creator.address));
    // Minted to the attesting author (not the relaying node / msg.sender path).
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Atomic kaId → cgId binding written by `registerKnowledgeAsset`.
    expect(await CGS.kaToContextGraph(kaId)).to.equal(setup.cgId);
  });

  it('greenfield: update is owner-sealed — a valid attestation from a non-owner reverts NotKnowledgeAssetOwner', async () => {
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'owner-gate-publish');
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    // OT-RFC-43 Option 1 (1a): minted kaId == packed reservedKaId.
    const kaId = BigInt(p.reservedKaId);
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );

    // A non-owner who correctly signs the EIP-712 update attestation over
    // THEIR OWN address passes `_verifyUpdateAuthorAttestation` but must still
    // be rejected by the ownerOf gate. `msg.sender` is the authorized CG
    // publisher (creator) so the policy branch is not what trips — the owner
    // mismatch is.
    const nonOwner = accounts[8];
    expect(nonOwner.address).to.not.equal(setup.creator.address);

    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n, // fresh KA from a single publish
      newMerkleRoot: ethers.keccak256(ethers.toUtf8Bytes('owner-gate-update')),
      newByteSize: 1000n,
      newTokenAmount: ethers.parseEther('1'),
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'owner-gate-update-op',
      author: nonOwner,
    });

    await expect(KAV10.connect(setup.creator).update(up))
      .to.be.revertedWithCustomError(KAV10, 'NotKnowledgeAssetOwner')
      .withArgs(kaId, setup.creator.address, nonOwner.address);
  });

  // --------------------------------------------------------------------------
  // 5. Protocol treasury fee split on the direct-spend path (v10.0.2)
  // --------------------------------------------------------------------------
  //
  // `_addTokens` skims the protocol treasury fee out of the staker-bound
  // TRAC on every paid publish/update/lifetime-extension. The split is a
  // conservation invariant — `fee + net == gross`, the publisher pays the
  // gross, nothing is minted or burned — yet it had NO test. A regression
  // that double-charged the fee, paid it out of thin air, or skewed the
  // split would have shipped green. These two tests pin BOTH branches of
  // `_treasuryFee`: governance opted-in (recipient wired) and the SHIPPING
  // default (recipient unset → fee dormant, full gross to stakers).
  //
  // Both force the DIRECT-SPEND branch by publishing with
  // `epochs != lockDurationEpochs`, which fails PCA eligibility gate (3) so
  // `_addTokens` runs against the publisher's own wallet (no time travel,
  // the PCA stays live).

  it('treasury: direct-spend publish skims the protocol fee — fee + staker-net == gross', async () => {
    const setup = await setupRegisteredAgentPublish();

    const Parameters =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    const treasury = accounts[6];
    const feeBps = 500n; // 5% — well under MAX_PROTOCOL_TREASURY_FEE (1000)
    await Parameters.setProtocolTreasury(treasury.address);
    await Parameters.setProtocolTreasuryFee(feeBps);
    expect(await Parameters.protocolTreasury()).to.equal(treasury.address);

    const tokenAmount = ethers.parseEther('1000');
    const expectedFee = (tokenAmount * feeBps) / 10_000n; // 50 ether
    const expectedNet = tokenAmount - expectedFee; // 950 ether

    // Fund the publisher (msg.sender on direct-spend) for the gross + approve.
    await Token.mint(setup.creator.address, tokenAmount);
    await Token.connect(setup.creator).approve(
      await KAV10.getAddress(),
      tokenAmount,
    );

    const cssAddr = await ConvictionStakingStorage.getAddress();
    const treasuryBefore = await Token.balanceOf(treasury.address);
    const cssBefore = await Token.balanceOf(cssAddr);
    const creatorBefore = await Token.balanceOf(setup.creator.address);

    const p = await buildBasePublishParams(setup, 'treasury-split', {
      epochs: setup.epochs + 1, // breaks the PCA discount-branch eligibility
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    const feePaid = (await Token.balanceOf(treasury.address)) - treasuryBefore;
    const netToStakers = (await Token.balanceOf(cssAddr)) - cssBefore;
    const creatorSpent =
      creatorBefore - (await Token.balanceOf(setup.creator.address));

    expect(feePaid).to.equal(expectedFee);
    expect(netToStakers).to.equal(expectedNet);
    // Conservation: the fee is carved OUT of the gross (not added on top);
    // the publisher pays exactly the gross and nothing is minted/burned.
    expect(feePaid + netToStakers).to.equal(tokenAmount);
    expect(creatorSpent).to.equal(tokenAmount);
  });

  it('treasury: with no recipient wired (shipping default) the FULL gross reaches stakers', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Default deploy: protocolTreasury == address(0) with a NON-zero default
    // bps. `_treasuryFee` must short-circuit to (0, address(0)) so the fee
    // stays dormant and the entire gross flows to the staker pool. This is
    // the path almost every mainnet publish takes today.
    const Parameters =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    expect(await Parameters.protocolTreasury()).to.equal(ethers.ZeroAddress);
    expect(await Parameters.protocolTreasuryFee()).to.be.greaterThan(0n);

    const tokenAmount = ethers.parseEther('1000');
    await Token.mint(setup.creator.address, tokenAmount);
    await Token.connect(setup.creator).approve(
      await KAV10.getAddress(),
      tokenAmount,
    );

    const cssAddr = await ConvictionStakingStorage.getAddress();
    const cssBefore = await Token.balanceOf(cssAddr);

    const p = await buildBasePublishParams(setup, 'treasury-dormant', {
      epochs: setup.epochs + 1,
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    expect((await Token.balanceOf(cssAddr)) - cssBefore).to.equal(tokenAmount);
  });

  // --------------------------------------------------------------------------
  // 6. Update happy-path: kaId/owner stable, merkle-root history grows
  // --------------------------------------------------------------------------
  //
  // The only update coverage before this was the owner-gate REVERT. The
  // success path — a metadata-only update mutates the KA in place, never
  // mints a new id, never changes the owner, and appends to the merkle-root
  // chain — was untested. A regression that minted a fresh kaId on update,
  // overwrote (rather than appended) the merkle root, or reassigned
  // ownership would slip through. `newTokenAmount == current` keeps delta at
  // zero so the update charges nothing (no PCA / approval plumbing needed).

  it('update: metadata-only update keeps kaId + owner stable and appends to the merkle-root history', async () => {
    const setup = await setupRegisteredAgentPublish();

    const publishMerkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('update-happy-publish'),
    );
    const tokenAmount = ethers.parseEther('1000');
    const p = await buildBasePublishParams(setup, 'update-happy', {
      merkleRoot: publishMerkleRoot,
      tokenAmount,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();

    // OT-RFC-43 Option 1 (1a): minted kaId == packed reservedKaId.
    const kaId = BigInt(p.reservedKaId);
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Fresh KA: exactly one merkle root, equal to the publish root.
    expect((await DKGKnowledgeAssets.getMerkleRoots(kaId)).length).to.equal(1);
    expect(await DKGKnowledgeAssets.getLatestMerkleRoot(kaId)).to.equal(
      publishMerkleRoot,
    );

    // Metadata-only update: SAME tokenAmount (delta 0 → no payment) + SAME
    // byteSize; only the merkle root rolls forward. preUpdateMerkleRootCount
    // = 1 pins the optimistic-concurrency version the ACK quorum signs over.
    const newMerkleRoot = ethers.keccak256(
      ethers.toUtf8Bytes('update-happy-v2'),
    );
    const up = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'update-happy-op',
      author: setup.creator, // KA owner signs the EIP-712 update attestation
    });
    await (await KAV10.connect(setup.creator).update(up)).wait();

    // kaId stable: update mutates in place, never mints a new id. OT-RFC-43
    // Option 1 (1a): the KA is still owned at the SAME packed id (no new mint).
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Owner stable across the update.
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );
    // Merkle-root history GREW by exactly one; the new root is appended last.
    const roots = await DKGKnowledgeAssets.getMerkleRoots(kaId);
    expect(roots.length).to.equal(2);
    expect(roots[0].merkleRoot).to.equal(publishMerkleRoot);
    expect(roots[1].merkleRoot).to.equal(newMerkleRoot);
    expect(await DKGKnowledgeAssets.getLatestMerkleRoot(kaId)).to.equal(
      newMerkleRoot,
    );
    // tokenAmount unchanged (delta 0).
    const meta = await DKGKnowledgeAssets.getKnowledgeAssetMetadata(kaId);
    expect(meta[6]).to.equal(tokenAmount);
  });

  // --------------------------------------------------------------------------
  // 7. OT-RFC-43 Option 1 (variant 1a) — caller-supplied, author-namespaced
  //    KA ids (§B5). The KA id is now a deterministic packed value
  //    `(uint160(author) << 96) | uint96(number)` chosen off-chain. KCS
  //    enforces `(reservedKaId >> 96) == author` (the EIP-712 attestation
  //    signer / NFT mint recipient, NOT msg.sender) so a wallet can only mint
  //    in its own namespace; a re-used id reverts (no silent clobber); the old
  //    global counter getter is deprecated; and ownership (OT-RFC-45) survives
  //    NFT transfer under the new id scheme.
  // --------------------------------------------------------------------------

  // Direct-spend funding for a publisher that is NOT a registered agent:
  // mint the gross + approve KAV10 so `_addTokens` can pull it.
  const fundDirectSpend = async (
    publisher: SignerWithAddress,
    amount: bigint,
  ) => {
    await Token.mint(publisher.address, amount);
    await Token.connect(publisher).approve(await KAV10.getAddress(), amount);
  };

  it('B5(a): publish with a valid packed reservedKaId mints kaId == reservedKaId and ownerOf == the attested AUTHOR (not msg.sender/publisher)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // publisher (msg.sender) != author. The open CG authorizes any non-zero
    // publisher; the publisher is NOT a registered agent + epochs is off the
    // discount tier, so payment runs through the direct-spend branch against
    // the publisher's own wallet. The author only signs the EIP-712
    // attestation and is the ERC-721 mint recipient.
    const publisher = accounts[10];
    const author = accounts[11];
    expect(publisher.address).to.not.equal(author.address);
    expect(publisher.address).to.not.equal(setup.creator.address);

    const tokenAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(author.address, 7);
    await fundDirectSpend(publisher, tokenAmount);

    const p = await buildBasePublishParams(setup, 'b5-a-author-namespaced', {
      author, // EIP-712 attestation signer + NFT mint recipient
      epochs: setup.epochs + 1, // off the PCA discount tier → direct-spend
      tokenAmount,
      reservedKaId,
    });

    await (await KAV10.connect(publisher).publish(p)).wait();

    // The minted id is EXACTLY the supplied reservedKaId.
    expect(BigInt(p.reservedKaId)).to.equal(reservedKaId);
    // High 160 bits == the AUTHOR, not the publisher/msg.sender.
    expect(reservedKaId >> 96n).to.equal(BigInt(author.address));
    expect(reservedKaId >> 96n).to.not.equal(BigInt(publisher.address));
    // NFT minted to the attested author (OT-RFC-43: namespace binds to author).
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      author.address,
    );
  });

  it('B5(b): a reservedKaId whose high bits != author reverts KaIdNamespaceMismatch', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Pack the id in a DIFFERENT address's namespace than the attested author
    // (setup.creator). The contract recomputes `kaId >> 96` and compares it to
    // the attested author, so this is rejected before any mint.
    const otherAddr = accounts[12];
    expect(otherAddr.address).to.not.equal(setup.creator.address);
    const wrongNamespaceId = packReservedKaId(otherAddr.address, 1);

    const p = await buildBasePublishParams(setup, 'b5-b-wrong-namespace', {
      reservedKaId: wrongNamespaceId,
    });

    await expect(KAV10.connect(setup.creator).publish(p))
      .to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'KaIdNamespaceMismatch',
      )
      .withArgs(wrongNamespaceId, setup.creator.address);

    // Nothing minted under the foreign id.
    await expect(
      DKGKnowledgeAssets.ownerOf(wrongNamespaceId),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'ERC721NonexistentToken',
    );
  });

  it('B5(f): a delegated publisher cannot swap the author-signed reservedKaId to another number in the same namespace (OT-RFC-43 §F2 digest binding)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // The author (setup.creator) signs an attestation that binds slot #7.
    const signedKaId = packReservedKaId(setup.creator.address, 7);
    const p = await buildBasePublishParams(setup, 'b5-f-signed-slot-7', {
      reservedKaId: signedKaId,
    });

    // A relay/publisher tampers the publish to mint at slot #99 instead —
    // still inside the author's OWN namespace, so the `(kaId >> 96) == author`
    // guard would pass. Pre-F2 the author signature covered only the content,
    // so this substitution succeeded. With `reservedKaId` bound into the
    // EIP-712 digest, the recomputed digest no longer recovers to the author.
    const substitutedKaId = packReservedKaId(setup.creator.address, 99);
    expect(substitutedKaId >> 96n).to.equal(BigInt(setup.creator.address));
    const tampered = { ...p, reservedKaId: substitutedKaId };

    await expect(
      KAV10.connect(setup.creator).publish(tampered),
    ).to.be.revertedWithCustomError(KAV10, 'InvalidAuthorSignature');

    // Neither the signed nor the substituted slot was minted.
    for (const id of [signedKaId, substitutedKaId]) {
      await expect(
        DKGKnowledgeAssets.ownerOf(id),
      ).to.be.revertedWithCustomError(
        DKGKnowledgeAssets,
        'ERC721NonexistentToken',
      );
    }
  });

  it('B5(c): reusing the same (author, number) reverts KaIdAlreadyMinted on the second publish (no silent clobber)', async () => {
    const setup = await setupRegisteredAgentPublish();

    // First publish claims the packed id and mints it to the author.
    const reservedKaId = packReservedKaId(setup.creator.address, 42);
    const p1 = await buildBasePublishParams(setup, 'b5-c-first', {
      reservedKaId,
    });
    await (await KAV10.connect(setup.creator).publish(p1)).wait();
    expect(await DKGKnowledgeAssets.ownerOf(reservedKaId)).to.equal(
      setup.creator.address,
    );

    // Second publish reuses the EXACT same reservedKaId (same author + number)
    // with a fresh merkle root / operation id. The id is already minted, so it
    // must revert — not silently overwrite the existing KA.
    const p2 = await buildBasePublishParams(setup, 'b5-c-second', {
      reservedKaId,
    });
    await expect(KAV10.connect(setup.creator).publish(p2))
      .to.be.revertedWithCustomError(DKGKnowledgeAssets, 'KaIdAlreadyMinted')
      .withArgs(reservedKaId);

    // The original KA is untouched: still exactly one merkle root, the first.
    const roots = await DKGKnowledgeAssets.getMerkleRoots(reservedKaId);
    expect(roots.length).to.equal(1);
    expect(roots[0].merkleRoot).to.equal(
      ethers.keccak256(ethers.toUtf8Bytes('b5-c-first')),
    );
  });

  it('B5(d): getLatestKnowledgeAssetId() is deprecated and always reverts GetLatestKnowledgeAssetIdDeprecated', async () => {
    // The global sequential counter is gone under Option 1 — packed ids are
    // not enumerable through a single "latest id". The getter must revert
    // regardless of how many KAs exist (pure function: even on a clean state).
    await expect(
      DKGKnowledgeAssets.getLatestKnowledgeAssetId(),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'GetLatestKnowledgeAssetIdDeprecated',
    );

    // Still reverts after a successful publish (the count changed, the getter
    // did not come back).
    const setup = await setupRegisteredAgentPublish();
    const p = await buildBasePublishParams(setup, 'b5-d-deprecated');
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    await expect(
      DKGKnowledgeAssets.getLatestKnowledgeAssetId(),
    ).to.be.revertedWithCustomError(
      DKGKnowledgeAssets,
      'GetLatestKnowledgeAssetIdDeprecated',
    );
  });

  it('B5(e): update stays owner-only across an NFT transfer — old author reverts NotKnowledgeAssetOwner, new owner succeeds', async () => {
    const setup = await setupRegisteredAgentPublish();

    // Publish: author (setup.creator) owns the freshly minted KA NFT.
    const publishRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-publish'));
    const tokenAmount = ethers.parseEther('1000');
    const reservedKaId = packReservedKaId(setup.creator.address, 99);
    const p = await buildBasePublishParams(setup, 'b5-e-publish', {
      merkleRoot: publishRoot,
      tokenAmount,
      reservedKaId,
    });
    await (await KAV10.connect(setup.creator).publish(p)).wait();
    const kaId = reservedKaId;
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(
      setup.creator.address,
    );

    // Transfer the KA NFT to a new owner. The kaId is unchanged (the packed id
    // is the ERC-721 tokenId); only the owner moves.
    const newOwner = accounts[13];
    expect(newOwner.address).to.not.equal(setup.creator.address);
    await DKGKnowledgeAssets.connect(setup.creator).transferFrom(
      setup.creator.address,
      newOwner.address,
      kaId,
    );
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(newOwner.address);

    // (1) An update attested by the OLD author (no longer the owner) reverts
    //     NotKnowledgeAssetOwner — owner-only survives the NFT transfer.
    const staleRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-stale'));
    const staleUpdate = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: staleRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only, no payment
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'b5-e-stale-op',
      author: setup.creator, // old author signs — now NOT the owner
    });
    await expect(KAV10.connect(setup.creator).update(staleUpdate))
      .to.be.revertedWithCustomError(KAV10, 'NotKnowledgeAssetOwner')
      .withArgs(kaId, newOwner.address, setup.creator.address);

    // (2) An update attested by the NEW owner succeeds — the merkle-root
    //     history grows and the new root is appended.
    const newRoot = ethers.keccak256(ethers.toUtf8Bytes('b5-e-new'));
    const newOwnerUpdate = await buildUpdateParams({
      chainId: DEFAULT_CHAIN_ID,
      kav10Address: await KAV10.getAddress(),
      receivingNodes: setup.receivingNodes,
      publisherIdentityId: setup.publisherIdentityId,
      receiverIdentityIds: setup.receiverIdentityIds,
      contextGraphId: setup.cgId,
      id: kaId,
      preUpdateMerkleRootCount: 1n,
      newMerkleRoot: newRoot,
      newByteSize: 1000n,
      newTokenAmount: tokenAmount, // delta 0 — metadata-only, no payment
      mintKnowledgeAssetsAmount: 0n,
      knowledgeAssetsToBurn: [],
      updateOperationId: 'b5-e-new-op',
      author: newOwner, // new owner signs + owns → passes both gates
    });
    await (await KAV10.connect(newOwner).update(newOwnerUpdate)).wait();

    // Owner unchanged by the update; merkle-root history grew by one.
    expect(await DKGKnowledgeAssets.ownerOf(kaId)).to.equal(newOwner.address);
    const roots = await DKGKnowledgeAssets.getMerkleRoots(kaId);
    expect(roots.length).to.equal(2);
    expect(roots[0].merkleRoot).to.equal(publishRoot);
    expect(roots[1].merkleRoot).to.equal(newRoot);
  });
});
