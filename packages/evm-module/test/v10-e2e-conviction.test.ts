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

    // V10 Phase 8 Task 4: the publisher conviction path is now covered by
    // the unit tests in `test/unit/KnowledgeAssetsV10.test.ts` (Tier 1 T1.1
    // exercises the conviction publish end-to-end through the new
    // `DKGPublishingConvictionNFT` contract). The legacy `createKnowledgeAssets`
    // ABI was removed in Task 1 — any rewrite here would duplicate the unit
    // fixture wholesale, so we skip the test and point to the replacement.
    // eslint-disable-next-line mocha/no-skipped-tests
    it.skip('publishes a knowledge asset through conviction account (covered by @unit KnowledgeAssetsV10 T1.1)', async () => {
      // Intentionally empty — see comment above.
    });
  });

});
