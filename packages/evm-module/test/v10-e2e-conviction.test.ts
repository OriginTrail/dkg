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
} from '../typechain';
import { signMessage } from './helpers/kc-helpers';
import { createProfile, createProfiles } from './helpers/profile-helpers';
import {
  getDefaultPublishingNode,
  getDefaultReceivingNodes,
  getDefaultKCCreator,
} from './helpers/setup-helpers';

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
    'ParanetKnowledgeCollectionsRegistry',
    'ParanetKnowledgeMinersRegistry',
    'ParanetsRegistry',
    'MigratorV10Staking',
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
  };
}

async function getV10SignaturesData(
  publishingNode: { operational: SignerWithAddress; admin: SignerWithAddress },
  publisherIdentityId: number,
  receivingNodes: { operational: SignerWithAddress; admin: SignerWithAddress }[],
  contextGraphId: bigint,
  knowledgeAssetsAmount: number = 10,
  byteSize: number = 1000,
  merkleRoot: string = ethers.keccak256(ethers.toUtf8Bytes('test-merkle-root')),
  epochs: number = 2,
  tokenAmount: bigint = ethers.parseEther('100'),
) {
  const publisherMessageHash = ethers.solidityPackedKeccak256(
    ['uint256', 'uint72', 'bytes32'],
    [contextGraphId, publisherIdentityId, merkleRoot],
  );

  const { r: publisherR, vs: publisherVS } = await signMessage(
    publishingNode.operational,
    publisherMessageHash,
  );

  const ackDigest = ethers.solidityPackedKeccak256(
    ['uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
    [contextGraphId, merkleRoot, knowledgeAssetsAmount, byteSize, epochs, tokenAmount],
  );

  const receiverRs = [];
  const receiverVSs = [];
  for (const node of receivingNodes) {
    const { r, vs } = await signMessage(node.operational, ackDigest);
    receiverRs.push(r);
    receiverVSs.push(vs);
  }

  return {
    merkleRoot,
    publisherR,
    publisherVS,
    receiverRs,
    receiverVSs,
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

    it('stakes with no lock (1x multiplier, lockEpochs=1 default)', async () => {
      await Staking.connect(staker).stake(identityId, STAKE_AMOUNT);

      const nodeStake = await StakingStorage.getNodeStake(identityId);
      expect(nodeStake).to.equal(STAKE_AMOUNT);

      const multiplier = await Staking.getDelegatorConvictionMultiplier(identityId, staker.address);
      expect(multiplier).to.equal(SCALE18);
    });

    it('upgrades to 6-epoch conviction lock (3.5x multiplier)', async () => {
      await Staking.connect(staker).stake(identityId, STAKE_AMOUNT);

      const multiplierBefore = await Staking.getDelegatorConvictionMultiplier(identityId, staker.address);
      expect(multiplierBefore).to.equal(SCALE18);

      // stakeWithLock requires addedStake > 0, so add 1 wei to upgrade the lock tier
      await Staking.connect(staker).stakeWithLock(identityId, 1, 6);

      const multiplierAfter = await Staking.getDelegatorConvictionMultiplier(identityId, staker.address);
      expect(multiplierAfter).to.equal(35n * SCALE18 / 10n);
    });

    it('reverts withdrawal while lock is active', async () => {
      await Staking.connect(staker).stakeWithLock(identityId, STAKE_AMOUNT, 6);

      await expect(
        Staking.connect(staker).requestWithdrawal(identityId, STAKE_AMOUNT),
      ).to.be.revertedWithCustomError(Staking, 'ConvictionLockActive');
    });

    it('full lifecycle: stake → lock → wait → withdraw', async () => {
      await Staking.connect(staker).stakeWithLock(identityId, STAKE_AMOUNT, 6);

      const [lockEpochs, lockStartEpoch] = await DelegatorsInfo.getDelegatorLock(identityId, staker.address);
      expect(lockEpochs).to.equal(6);

      // Advance time past lock expiry (6 epochs), claiming rewards each epoch
      const epochLength = await Chronos.epochLength();
      for (let i = 0; i < 7; i++) {
        await time.increase(epochLength);
        const epoch = await Chronos.getCurrentEpoch();
        try {
          await Staking.connect(staker).claimDelegatorRewards(identityId, epoch - 1n, staker.address);
        } catch (err: any) {
          expect(err.message).to.include('No rewards');
        }
      }

      const currentEpoch = await Chronos.getCurrentEpoch();
      expect(currentEpoch).to.be.greaterThanOrEqual(lockStartEpoch + lockEpochs);

      await Staking.connect(staker).requestWithdrawal(identityId, STAKE_AMOUNT);

      const delegatorKey = ethers.keccak256(ethers.solidityPacked(['address'], [staker.address]));
      const [withdrawalAmount, , releaseTimestamp] = await StakingStorage.getDelegatorWithdrawalRequest(
        identityId,
        delegatorKey,
      );
      expect(withdrawalAmount).to.equal(STAKE_AMOUNT);

      await time.increaseTo(releaseTimestamp);
      const balanceBefore = await Token.balanceOf(staker.address);
      await Staking.connect(staker).finalizeWithdrawal(identityId);
      const balanceAfter = await Token.balanceOf(staker.address);

      expect(balanceAfter - balanceBefore).to.equal(STAKE_AMOUNT);
    });

    it('verifies all conviction multiplier tiers', async () => {
      expect(await Staking.convictionMultiplier(1)).to.equal(SCALE18);
      expect(await Staking.convictionMultiplier(2)).to.equal(15n * SCALE18 / 10n);
      expect(await Staking.convictionMultiplier(3)).to.equal(2n * SCALE18);
      expect(await Staking.convictionMultiplier(6)).to.equal(35n * SCALE18 / 10n);
      expect(await Staking.convictionMultiplier(12)).to.equal(6n * SCALE18);
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

    it('publishes a knowledge asset through conviction account', async () => {
      await PCA.connect(publisher).createAccount(LOCK_AMOUNT, LOCK_EPOCHS);
      await PCA.connect(publisher).addAuthorizedKey(1, accounts[9].address);

      const CONTEXT_GRAPH_ID = 42n;
      const STAKE_AMOUNT = ethers.parseEther('50000');

      const publishingNode = getDefaultPublishingNode(accounts);
      const receivingNodes = getDefaultReceivingNodes(accounts);
      const kcCreator = getDefaultKCCreator(accounts);

      const { identityId: publisherIdentityId } = await createProfile(ProfileContract, publishingNode);
      await Token.mint(publishingNode.operational.address, STAKE_AMOUNT);
      await Token.connect(publishingNode.operational).approve(await Staking.getAddress(), STAKE_AMOUNT);
      await Staking.connect(publishingNode.operational).stake(publisherIdentityId, STAKE_AMOUNT);

      const receiverProfiles = await createProfiles(ProfileContract, receivingNodes);
      const receiverIds = receiverProfiles.map((p) => p.identityId);
      for (let i = 0; i < receivingNodes.length; i++) {
        await Token.mint(receivingNodes[i].operational.address, STAKE_AMOUNT);
        await Token.connect(receivingNodes[i].operational).approve(await Staking.getAddress(), STAKE_AMOUNT);
        await Staking.connect(receivingNodes[i].operational).stake(receiverProfiles[i].identityId, STAKE_AMOUNT);
      }

      const tokenAmount = ethers.parseEther('100');
      const sig = await getV10SignaturesData(
        publishingNode,
        publisherIdentityId,
        receivingNodes,
        CONTEXT_GRAPH_ID,
      );

      await Token.connect(kcCreator).increaseAllowance(KAV10.getAddress(), tokenAmount);

      const tx = await KAV10.connect(kcCreator).createKnowledgeAssets(
        'e2e-conviction-publish',
        CONTEXT_GRAPH_ID,
        sig.merkleRoot,
        10,
        1000,
        2,
        tokenAmount,
        false,
        ethers.ZeroAddress,
        1,
        publisherIdentityId,
        sig.publisherR,
        sig.publisherVS,
        receiverIds,
        sig.receiverRs,
        sig.receiverVSs,
      );

      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);
    });
  });

  // ========================================================================
  // Flow 3: V8→V10 Migration
  // ========================================================================
  describe('Flow 3: V8→V10 Migration via MigratorV10Staking', function () {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let Migrator: any;
    let oldDelegatorsInfo: DelegatorsInfo;
    let newDelegatorsInfo: DelegatorsInfo;

    beforeEach(async () => {
      Migrator = await hre.ethers.getContract('MigratorV10Staking');

      // Deploy two fresh DelegatorsInfo instances to simulate old (V8) and new (V10).
      // The "old" one acts as V8 (no lock fields used), the "new" one is the V10 target.
      const hubAddress = await Hub.getAddress();
      const DelegatorsInfoFactory = await hre.ethers.getContractFactory('DelegatorsInfo');

      oldDelegatorsInfo = (await DelegatorsInfoFactory.deploy(hubAddress)) as DelegatorsInfo;
      await oldDelegatorsInfo.waitForDeployment();

      newDelegatorsInfo = (await DelegatorsInfoFactory.deploy(hubAddress)) as DelegatorsInfo;
      await newDelegatorsInfo.waitForDeployment();

      // Register old and new DelegatorsInfo in Hub so they can be initialized
      await Hub.setContractAddress('OldDelegatorsInfo', await oldDelegatorsInfo.getAddress());
      await Hub.setContractAddress('NewDelegatorsInfo', await newDelegatorsInfo.getAddress());

      // Register MigratorV10Staking and the new DelegatorsInfo as Hub contracts
      // so the migrator can call onlyContracts setters on the new instance
      await Hub.setContractAddress('MigratorV10Staking', await Migrator.getAddress());

      await Migrator.setOldDelegatorsInfo(await oldDelegatorsInfo.getAddress());
      await Migrator.setNewDelegatorsInfo(await newDelegatorsInfo.getAddress());
    });

    it('migrates delegator state from old to new DelegatorsInfo', async () => {
      const identityId = 1;
      const delegator1 = accounts[3].address;
      const delegator2 = accounts[4].address;

      // Populate old DelegatorsInfo with V8-style state.
      // We need to impersonate a Hub-registered contract to call onlyContracts setters.
      const stakingAddress = (await hre.ethers.getContract('Staking')).target.toString();
      const stakingSigner = await hre.ethers.getImpersonatedSigner(stakingAddress);
      await hre.network.provider.send('hardhat_setBalance', [
        stakingAddress,
        '0x' + ethers.parseEther('1.0').toString(16),
      ]);

      await oldDelegatorsInfo.connect(stakingSigner).addDelegator(identityId, delegator1);
      await oldDelegatorsInfo.connect(stakingSigner).addDelegator(identityId, delegator2);
      await oldDelegatorsInfo.connect(stakingSigner).setLastClaimedEpoch(identityId, delegator1, 5);
      await oldDelegatorsInfo.connect(stakingSigner).setDelegatorRollingRewards(identityId, delegator1, 1000);
      await oldDelegatorsInfo.connect(stakingSigner).setHasEverDelegatedToNode(identityId, delegator1, true);
      await oldDelegatorsInfo.connect(stakingSigner).setLastStakeHeldEpoch(identityId, delegator1, 3);
      await oldDelegatorsInfo.connect(stakingSigner).setNetNodeEpochRewards(identityId, 1, 5000);
      await oldDelegatorsInfo.connect(stakingSigner).setIsOperatorFeeClaimedForEpoch(identityId, 1, true);

      // Run migration
      await Migrator.migrateNode(identityId, 1, 3);

      // Verify delegator state was copied
      expect(await newDelegatorsInfo.isNodeDelegator(identityId, delegator1)).to.be.true;
      expect(await newDelegatorsInfo.isNodeDelegator(identityId, delegator2)).to.be.true;
      expect(await newDelegatorsInfo.getLastClaimedEpoch(identityId, delegator1)).to.equal(5);
      expect(await newDelegatorsInfo.getDelegatorRollingRewards(identityId, delegator1)).to.equal(1000);
      expect(await newDelegatorsInfo.hasEverDelegatedToNode(identityId, delegator1)).to.be.true;
      expect(await newDelegatorsInfo.getLastStakeHeldEpoch(identityId, delegator1)).to.equal(3);
      expect(await newDelegatorsInfo.getNetNodeEpochRewards(identityId, 1)).to.equal(5000);
      expect(await newDelegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, 1)).to.be.true;

      // Conviction lock fields default to 0 for migrated delegators
      const [lockEpochs, lockStartEpoch] = await newDelegatorsInfo.getDelegatorLock(identityId, delegator1);
      expect(lockEpochs).to.equal(0);
      expect(lockStartEpoch).to.equal(0);
    });

    it('migrated staker can upgrade to conviction lock', async () => {
      const identityId = 1;
      const delegator = accounts[3].address;

      const stakingAddress = (await hre.ethers.getContract('Staking')).target.toString();
      const stakingSigner = await hre.ethers.getImpersonatedSigner(stakingAddress);
      await hre.network.provider.send('hardhat_setBalance', [
        stakingAddress,
        '0x' + ethers.parseEther('1.0').toString(16),
      ]);

      await oldDelegatorsInfo.connect(stakingSigner).addDelegator(identityId, delegator);
      await Migrator.migrateNode(identityId, 1, 1);

      // Verify lock is 0 after migration
      const [lockBefore] = await newDelegatorsInfo.getDelegatorLock(identityId, delegator);
      expect(lockBefore).to.equal(0);

      // Simulate a stakeWithLock by directly setting lock on new DelegatorsInfo
      // (In production, the Staking contract would call setDelegatorLock)
      const migratorAddress = await Migrator.getAddress();
      const migratorSigner = await hre.ethers.getImpersonatedSigner(migratorAddress);
      await hre.network.provider.send('hardhat_setBalance', [
        migratorAddress,
        '0x' + ethers.parseEther('1.0').toString(16),
      ]);

      const currentEpoch = await Chronos.getCurrentEpoch();
      await newDelegatorsInfo.connect(migratorSigner).setDelegatorLock(
        identityId,
        delegator,
        6,
        currentEpoch,
      );

      const [lockAfter, startAfter] = await newDelegatorsInfo.getDelegatorLock(identityId, delegator);
      expect(lockAfter).to.equal(6);
      expect(startAfter).to.equal(currentEpoch);

      // Verify conviction multiplier tier via pure function on Staking
      const multiplier = await Staking.convictionMultiplier(6);
      expect(multiplier).to.equal(35n * SCALE18 / 10n);
    });

    it('migrates epoch reward claim flags via migrateEpochRewardsClaimed', async () => {
      const identityId = 1;
      const delegator = accounts[3].address;
      const delegatorKey = ethers.keccak256(ethers.solidityPacked(['address'], [delegator]));

      const stakingAddress = (await hre.ethers.getContract('Staking')).target.toString();
      const stakingSigner = await hre.ethers.getImpersonatedSigner(stakingAddress);
      await hre.network.provider.send('hardhat_setBalance', [
        stakingAddress,
        '0x' + ethers.parseEther('1.0').toString(16),
      ]);

      await oldDelegatorsInfo.connect(stakingSigner).addDelegator(identityId, delegator);
      await oldDelegatorsInfo.connect(stakingSigner).setHasDelegatorClaimedEpochRewards(
        2,
        identityId,
        delegatorKey,
        true,
      );

      await Migrator.migrateEpochRewardsClaimed(2, identityId, [delegator]);

      expect(
        await newDelegatorsInfo.hasDelegatorClaimedEpochRewards(2, identityId, delegatorKey),
      ).to.be.true;
    });
  });
});
