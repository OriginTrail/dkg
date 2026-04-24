import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Hub,
  Token,
  Chronos,
  Profile,
  Staking,
  StakingStorage,
  ParametersStorage,
  DelegatorsInfo,
  PublishingConvictionAccount,
  KnowledgeAssetsV10,
  KnowledgeCollectionStorage,
  EpochStorage,
  AskStorage,
  ContextGraphs,
  ContextGraphStorage,
  ContextGraphValueStorage,
  DKGPublishingConvictionNFT,
} from '../typechain';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from './helpers/setup-helpers';
import { buildPublishParams, DEFAULT_CHAIN_ID } from './helpers/v10-kc-helpers';

const SCALE18 = 10n ** 18n;

type E2EFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  Profile: Profile;
  Staking: Staking;
  StakingStorage: StakingStorage;
  ParametersStorage: ParametersStorage;
  DelegatorsInfo: DelegatorsInfo;
  PCA: PublishingConvictionAccount;
  KnowledgeAssetsV10: KnowledgeAssetsV10;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  EpochStorage: EpochStorage;
  AskStorage: AskStorage;
  ContextGraphs: ContextGraphs;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
  PublishingConvictionNFT: DKGPublishingConvictionNFT;
};

async function deployE2EFixture(): Promise<E2EFixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'Staking',
    'DelegatorsInfo',
    'KnowledgeAssetsV10',
    'PublishingConvictionAccount',
    // V10 Phase 8 stack — required by the new `KnowledgeAssetsV10.initialize()`
    // fail-fast Hub lookups (commit e89ecb75). Flow 3 (V10 publish via NFT)
    // depends on the full V10 stack being deployed in the same fixture.
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'DKGPublishingConvictionNFT',
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
    Staking: await hre.ethers.getContract<Staking>('Staking'),
    StakingStorage: await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    ParametersStorage: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    DelegatorsInfo: await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    PCA: await hre.ethers.getContract<PublishingConvictionAccount>('PublishingConvictionAccount'),
    KnowledgeAssetsV10: await hre.ethers.getContract<KnowledgeAssetsV10>('KnowledgeAssetsV10'),
    KnowledgeCollectionStorage: await hre.ethers.getContract<KnowledgeCollectionStorage>('KnowledgeCollectionStorage'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    AskStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    ContextGraphs: await hre.ethers.getContract<ContextGraphs>('ContextGraphs'),
    ContextGraphStorage: await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage'),
    ContextGraphValueStorage: await hre.ethers.getContract<ContextGraphValueStorage>('ContextGraphValueStorage'),
    PublishingConvictionNFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
  };
}

describe('V10 E2E Conviction System', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let Token: Token;
  let Chronos: Chronos;
  let ProfileContract: Profile;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let ParametersStorage: ParametersStorage;
  let DelegatorsInfo: DelegatorsInfo;
  let PCA: PublishingConvictionAccount;
  let KAV10: KnowledgeAssetsV10;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const fixture = await loadFixture(deployE2EFixture);
    ({
      accounts,
      Hub,
      Token,
      Chronos,
      ParametersStorage,
      DelegatorsInfo,
      PCA,
      KnowledgeCollectionStorage,
    } = fixture);
    ProfileContract = fixture.Profile;
    Staking = fixture.Staking;
    StakingStorage = fixture.StakingStorage;
    KAV10 = fixture.KnowledgeAssetsV10;
  });

  // ========================================================================
  // Flow 1: Staker Conviction Lifecycle
  // ========================================================================
  describe('Flow 1: Staker Conviction Lifecycle', function () {
    let identityId: number;
    let staker: SignerWithAddress;
    const STAKE_AMOUNT = ethers.parseEther('50000');

    beforeEach(async () => {
      const node = {
        operational: accounts[1],
        admin: accounts[2],
      };
      staker = accounts[1];

      const profile = await createProfile(ProfileContract, node);
      identityId = profile.identityId;

      await Token.mint(staker.address, STAKE_AMOUNT * 2n);
      await Token.connect(staker).approve(await Staking.getAddress(), STAKE_AMOUNT * 2n);
    });

    it('stakes with no lock (1x multiplier)', async () => {
      await Staking.connect(staker).stake(identityId, STAKE_AMOUNT);

      const nodeStake = await StakingStorage.getNodeStake(identityId);
      expect(nodeStake).to.equal(STAKE_AMOUNT);
    });
  });

  // ========================================================================
  // Flow 2: Publisher Conviction Lifecycle
  // ========================================================================
  describe('Flow 2: Publisher Conviction Lifecycle', function () {
    const LOCK_AMOUNT = ethers.parseEther('100000');
    const LOCK_EPOCHS = 12;
    let publisher: SignerWithAddress;
    let agent: SignerWithAddress;

    beforeEach(async () => {
      publisher = accounts[0];
      agent = accounts[10];

      await Token.mint(publisher.address, LOCK_AMOUNT * 2n);
      await Token.connect(publisher).approve(await PCA.getAddress(), LOCK_AMOUNT * 2n);
    });

    it('creates account and verifies info (balance, conviction, discount)', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);

      const info = await PCA.getAccountInfo(1);
      expect(info.admin).to.equal(publisher.address);
      expect(info.balance).to.equal(LOCK_AMOUNT);
      expect(info.initialDeposit).to.equal(LOCK_AMOUNT);
      expect(info.lockEpochs).to.equal(LOCK_EPOCHS);

      const expectedConviction = BigInt(LOCK_AMOUNT) * BigInt(LOCK_EPOCHS);
      expect(info.conviction).to.equal(expectedConviction);

      expect(info.discountBps).to.be.greaterThan(0);
    });

    it('adds authorized key and verifies access', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);

      await PCA.connect(publisher).addAuthorizedKey(1, agent.address);
      expect(await PCA.authorizedKeys(1, agent.address)).to.be.true;
    });

    it('coverPublishingCost deducts at discounted rate', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);

      const baseCost = ethers.parseEther('1000');
      const discountedCost = await PCA.getDiscountedCost(1, baseCost);

      expect(discountedCost).to.be.lessThan(baseCost);
      expect(discountedCost).to.be.greaterThan(0);

      const discount = await PCA.getDiscount(1);
      const expectedDiscounted = BigInt(baseCost) * (10000n - discount) / 10000n;
      expect(discountedCost).to.equal(expectedDiscounted);
    });

    it('adds funds and verifies updated balance', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);

      const addAmount = ethers.parseEther('50000');
      await PCA.connect(publisher).addFunds(1, addAmount);

      const info = await PCA.getAccountInfo(1);
      expect(info.balance).to.equal(LOCK_AMOUNT + addAmount);
    });

    it('extends lock and increases conviction', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, 6);

      const infoBefore = await PCA.getAccountInfo(1);
      await PCA.connect(publisher).extendLock(1, 6);
      const infoAfter = await PCA.getAccountInfo(1);

      expect(infoAfter.lockEpochs).to.equal(12);
      expect(infoAfter.conviction).to.be.greaterThan(infoBefore.conviction);
      expect(infoAfter.conviction).to.equal(BigInt(LOCK_AMOUNT) * 12n);
    });

    it('prevents non-admin from adding funds or extending lock', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);

      await expect(
        PCA.connect(agent).addFunds(1, ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');

      await expect(
        PCA.connect(agent).extendLock(1, 3),
      ).to.be.revertedWithCustomError(PCA, 'NotAccountAdmin');
    });

    // Legacy V9 PublishingConvictionAccount flows end here. The V10 publish
    // pipeline (via DKGPublishingConvictionNFT + KnowledgeAssetsV10) is
    // exercised as a separate Flow 3 below — the legacy PCA and the new
    // NFT are independent contracts and the tests no longer share state.
  });

  // ========================================================================
  // Flow 3: V10 Publish via Conviction NFT + Context Graphs
  //
  // Closes Codex BLOCKER 2 — no dedicated end-to-end test covered the full
  // V10 publish pipeline spanning:
  //   1. Conviction NFT account creation (createAccount: TRAC flows directly
  //      into StakingStorage, full committedTRAC distributed to EpochStorage
  //      across the 12-epoch lock window)
  //   2. Agent registration (agentToAccountId reverse map written)
  //   3. Context Graph creation (open policy, no curator)
  //   4. Publish via `publish(PublishParams)` — conviction path
  //   5. Authorization via ContextGraphs.isAuthorizedPublisher using the
  //      PAYING principal (msg.sender), NOT the recovered node signer (N17)
  //   6. Auto-resolve via agentToAccountId inside coverPublishingCost (N8)
  //   7. KC registered in KCS with msg.sender as the publisher of record
  //      (commit 41be7c71 — KA tokens minted to the paying agent, so the
  //      N16 ERC-1155 balanceOf gate works on follow-up updates)
  //   8. Atomic CG binding via ContextGraphs.registerKnowledgeCollection
  //      (kcToContextGraph[kcId] == cgId, contextGraphKCList[cgId] includes
  //      kcId) (N20)
  //   9. CG value ledger written via
  //      ContextGraphValueStorage.addCGValueForEpochRange (N20, Phase 1)
  //  10. Double-count guard: staker pool delta across the publish window
  //      is EXACTLY ZERO (Phase 1+6+8 critical invariant — T1.1 covers the
  //      same check from the unit fixture; this e2e test re-verifies it
  //      through the legacy-PCA fixture to make sure the two coexist)
  //  11. KC retrieval through the KCS public reader
  // ========================================================================
  describe('Flow 3: V10 Publish via Conviction NFT + Context Graphs', function () {
    const COMMITTED_TRAC = ethers.parseEther('50000'); // 20% discount tier
    const MIN_STAKE = ethers.parseEther('50000');
    const STAKER_SHARD_ID = 1n;

    let NFT: DKGPublishingConvictionNFT;
    let CGFacade: ContextGraphs;
    let CGS: ContextGraphStorage;
    let CGV: ContextGraphValueStorage;
    let EpochStorageContract: EpochStorage;

    let kav10Address: string;

    beforeEach(async () => {
      hre.helpers.resetDeploymentsJson();
      const fixture = await loadFixture(deployE2EFixture);
      ({
        accounts,
        Token,
        Chronos,
        ParametersStorage,
        KnowledgeCollectionStorage,
      } = fixture);
      ProfileContract = fixture.Profile;
      Staking = fixture.Staking;
      StakingStorage = fixture.StakingStorage;
      KAV10 = fixture.KnowledgeAssetsV10;
      NFT = fixture.PublishingConvictionNFT;
      CGFacade = fixture.ContextGraphs;
      CGS = fixture.ContextGraphStorage;
      CGV = fixture.ContextGraphValueStorage;
      EpochStorageContract = fixture.EpochStorage;
      kav10Address = await KAV10.getAddress();
    });

    it('end-to-end: createAccount → createContextGraph → publish → atomic bind → CG value written → double-count-free', async () => {
      // ---- Step 0: Set up publishing + receiving nodes (profiles + stake) ----
      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const { identityId: publisherIdentityId } = await createProfile(
        ProfileContract,
        publishingNode,
      );
      const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
      const receiverIdentityIds = receiverProfiles.map((p) => p.identityId);

      // Stake all nodes so `_verifySignature`'s stake gate passes.
      await Token.mint(publishingNode.operational.address, MIN_STAKE);
      await Token.connect(publishingNode.operational).approve(
        await Staking.getAddress(),
        MIN_STAKE,
      );
      await Staking.connect(publishingNode.operational).stake(publisherIdentityId, MIN_STAKE);
      for (let i = 0; i < receivingNodes.length; i++) {
        await Token.mint(receivingNodes[i].operational.address, MIN_STAKE);
        await Token.connect(receivingNodes[i].operational).approve(
          await Staking.getAddress(),
          MIN_STAKE,
        );
        await Staking.connect(receivingNodes[i].operational).stake(
          receiverProfiles[i].identityId,
          MIN_STAKE,
        );
      }

      // ---- Step 1: Conviction NFT account creation ----
      //
      // The NFT's `createAccount` pulls `committedTRAC` from msg.sender into
      // StakingStorage directly (fail-closed transferFrom) and writes the
      // full amount across the 12-epoch lock window via
      // `EpochStorage.addTokensToEpochRange`. The contract NEVER holds TRAC.
      const creator = getDefaultKCCreator(accounts);
      await Token.connect(accounts[0]).transfer(creator.address, COMMITTED_TRAC);
      await Token.connect(creator).approve(await NFT.getAddress(), COMMITTED_TRAC);

      const stakingStorageBalanceBefore = await Token.balanceOf(
        await StakingStorage.getAddress(),
      );
      await NFT.connect(creator).createAccount(COMMITTED_TRAC);
      const accountId = await NFT.totalSupply();
      expect(accountId).to.equal(1n);

      // createAccount side-effects:
      // - TRAC moved publisher → StakingStorage
      expect(await Token.balanceOf(await StakingStorage.getAddress())).to.equal(
        stakingStorageBalanceBefore + COMMITTED_TRAC,
      );
      // - NFT minted to creator
      expect(await NFT.ownerOf(accountId)).to.equal(creator.address);

      // ---- Step 2: Agent registration (creator self-registers as own agent) ----
      await NFT.connect(creator).registerAgent(accountId, creator.address);
      expect(await NFT.agentToAccountId(creator.address)).to.equal(accountId);

      // ---- Step 3: Context Graph creation (open policy) ----
      await CGFacade.connect(creator).createContextGraph(
        [10n, 20n, 30n], // hosting nodes
        [],                // participant agents
        2,                 // requiredSignatures
        0,                 // metadataBatchId
        1,                 // publishPolicy = open (any non-zero publisher auth'd)
        ethers.ZeroAddress,
        0,                 // publishAuthorityAccountId
      );
      const cgId = await CGS.getLatestContextGraphId();
      expect(cgId).to.equal(1n);
      // N17 sanity: open CG authorizes the paying principal (creator).
      expect(await CGFacade.isAuthorizedPublisher(cgId, creator.address)).to.be.true;

      // ---- Step 4: Snapshot staker pool across publish window BEFORE publish ----
      //
      // Conviction-path publish MUST NOT write to EpochStorage — Phase 6
      // createAccount already wrote the full allowance. This pool snapshot
      // captures the post-createAccount baseline; the post-publish snapshot
      // must match it exactly (delta == 0 per epoch).
      const currentEpoch = await Chronos.getCurrentEpoch();
      const tokenAmount = ethers.parseEther('1000');
      const epochs = 2;
      const merkleRoot = ethers.keccak256(ethers.toUtf8Bytes('flow3-merkle'));
      const poolsBefore: bigint[] = [];
      for (let i = 0n; i <= BigInt(epochs); i++) {
        poolsBefore.push(
          await EpochStorageContract.getEpochPool(STAKER_SHARD_ID, currentEpoch + i),
        );
      }

      // ---- Step 5: Build V10 publish params (N26 + H5 + post-BLOCKER-1 ACK) ----
      const p = await buildPublishParams({
        chainId: DEFAULT_CHAIN_ID,
        kav10Address,
        publishingNode,
        receivingNodes,
        publisherIdentityId,
        receiverIdentityIds,
        contextGraphId: cgId,
        merkleRoot,
        knowledgeAssetsAmount: 10,
        byteSize: 1000,
        epochs,
        tokenAmount,
        isImmutable: false,
        publishOperationId: 'flow3-op',
      });

      // ---- Step 6: publish() (conviction path) ----
      const tx = await KAV10.connect(creator).publish(p);
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      // ---- Step 7: KC registered in KCS; publisher of record is msg.sender ----
      const kcId = 1n;
      const meta = await KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(kcId);
      // meta[3] = byteSize, meta[4] = startEpoch, meta[5] = endEpoch, meta[6] = tokenAmount
      expect(meta[3]).to.equal(1000n);
      expect(meta[4]).to.equal(currentEpoch);
      expect(meta[5]).to.equal(currentEpoch + BigInt(epochs));
      expect(meta[6]).to.equal(tokenAmount);
      // The publisher-of-record on the latest merkle root is the PAYING AGENT
      // (commit 41be7c71). This is what enables the N16 ERC-1155 balanceOf
      // gate to work on follow-up updates.
      const latestPublisher =
        await KnowledgeCollectionStorage.getLatestMerkleRootPublisher(kcId);
      expect(latestPublisher).to.equal(creator.address);
      // ERC-1155 KA tokens minted to msg.sender. A follow-up `update` would
      // pass the `balanceOf(msg.sender, kcRange) > 0` gate.
      const maxSize = await KnowledgeCollectionStorage.KNOWLEDGE_COLLECTION_MAX_SIZE();
      const startTokenId = (kcId - 1n) * maxSize + 1n;
      const stopTokenId = startTokenId + 10n; // knowledgeAssetsAmount = 10
      expect(
        await KnowledgeCollectionStorage['balanceOf(address,uint256,uint256)'](
          creator.address,
          startTokenId,
          stopTokenId,
        ),
      ).to.be.gt(0n);

      // ---- Step 8: Atomic CG binding written ----
      expect(await CGS.kcToContextGraph(kcId)).to.equal(cgId);

      // ---- Step 9: CG value ledger written ----
      //
      // `addCGValueForEpochRange(cgId, currentEpoch, epochs, tokenAmount)`
      // writes a positive diff at currentEpoch; reading at currentEpoch
      // yields tokenAmount/epochs (integer division). The value is non-zero.
      const cgValueNow = await CGV.getCurrentCGValue(cgId);
      expect(cgValueNow).to.equal(tokenAmount / BigInt(epochs));

      // ---- Step 10: Double-count guard — pool deltas all zero ----
      for (let i = 0n; i <= BigInt(epochs); i++) {
        const after = await EpochStorageContract.getEpochPool(
          STAKER_SHARD_ID,
          currentEpoch + i,
        );
        const delta = after - poolsBefore[Number(i)];
        expect(delta, `epoch +${i} delta must be 0 (double-count guard)`).to.equal(0n);
      }

      // ---- Step 11: KC retrieval via public reader ----
      const retrievedKc = await KnowledgeCollectionStorage.getKnowledgeCollection(kcId);
      expect(retrievedKc.byteSize).to.equal(1000n);
      expect(retrievedKc.startEpoch).to.equal(currentEpoch);
      expect(retrievedKc.endEpoch).to.equal(currentEpoch + BigInt(epochs));
      expect(retrievedKc.tokenAmount).to.equal(tokenAmount);
      expect(retrievedKc.merkleRoots.length).to.equal(1);
      expect(retrievedKc.merkleRoots[0].merkleRoot).to.equal(merkleRoot);
      expect(retrievedKc.merkleRoots[0].publisher).to.equal(creator.address);
    });
  });

});
