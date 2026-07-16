import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  mineBlocks,
  mineProofPeriodBlocks,
} from '../../test/helpers/blockchain-helpers';
import {
  Hub,
  RandomSampling,
  HubLib,
  Chronos,
  RandomSamplingStorage,
  IdentityStorage,
  StakingStorage,
  ConvictionStakingStorage,
  ProfileStorage,
  AskStorage,
  EpochStorage,
  ParametersStorage,
  DKGKnowledgeAssets,
  Profile,
  ContextGraphStorage,
  ContextGraphValueStorage,
  CGWeightTreeStorage,
} from '../../typechain';

type RandomSamplingFixture = {
  accounts: SignerWithAddress[];
  RandomSampling: RandomSampling;
  Hub: Hub;
  HubLib: HubLib;
  Chronos: Chronos;
  RandomSamplingStorage: RandomSamplingStorage;
  IdentityStorage: IdentityStorage;
  StakingStorage: StakingStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  ProfileStorage: ProfileStorage;
  AskStorage: AskStorage;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  DKGKnowledgeAssets: DKGKnowledgeAssets;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
  CGWeightTreeStorage: CGWeightTreeStorage;
  Profile: Profile;
};

const PANIC_ARITHMETIC_OVERFLOW = 0x11;

describe('@unit RandomSampling', () => {
  let accounts: SignerWithAddress[];
  let RandomSampling: RandomSampling;
  let Hub: Hub;
  let HubLib: HubLib;
  let Chronos: Chronos;
  let RandomSamplingStorage: RandomSamplingStorage;
  let IdentityStorage: IdentityStorage;
  let StakingStorage: StakingStorage;
  let ConvictionStakingStorage: ConvictionStakingStorage;
  let ProfileStorage: ProfileStorage;
  let AskStorage: AskStorage;
  let EpochStorage: EpochStorage;
  let ParametersStorage: ParametersStorage;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let ContextGraphStorage: ContextGraphStorage;
  let ContextGraphValueStorage: ContextGraphValueStorage;
  let CGWeightTreeStorage: CGWeightTreeStorage;
  let Profile: Profile;

  async function deployRandomSamplingFixture(): Promise<RandomSamplingFixture> {
    await hre.deployments.fixture([
      'Token',
      'Hub',
      'ParametersStorage',
      'WhitelistStorage',
      'IdentityStorage',
      'ShardingTableStorage',
      'StakingStorage',
      'ProfileStorage',
      'Chronos',
      'EpochStorage',
      'DKGKnowledgeAssets',
      'AskStorage',
      'DelegatorsInfo',
      'RandomSamplingStorage',
      'ContextGraphValueStorage',
      'ContextGraphStorage',
      'RandomSampling',
      'Profile',
    ]);
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    const hubLibDeployment = await hre.deployments.deploy('HubLib', {
      from: accounts[0].address,
      log: true,
    });
    HubLib = await hre.ethers.getContract<HubLib>(
      'HubLib',
      hubLibDeployment.address,
    );

    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    RandomSamplingStorage = await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );
    RandomSampling =
      await hre.ethers.getContract<RandomSampling>('RandomSampling');
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    StakingStorage =
      await hre.ethers.getContract<StakingStorage>('StakingStorage');
    ConvictionStakingStorage = await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    );
    ProfileStorage =
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
    AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
    EpochStorage = await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
    ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    DKGKnowledgeAssets =
      await hre.ethers.getContract<DKGKnowledgeAssets>(
        'DKGKnowledgeAssets',
      );
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    );
    ContextGraphValueStorage =
      await hre.ethers.getContract<ContextGraphValueStorage>(
        'ContextGraphValueStorage',
      );
    CGWeightTreeStorage =
      await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');

    // Register a sentinel signer as a Hub contract so Phase 10 weighted-
    // selection tests can call `onlyContracts` methods on ContextGraphStorage /
    // ContextGraphValueStorage / DKGKnowledgeAssets directly, without
    // routing through the production facades (ContextGraphs, KnowledgeCollection).
    // Must run after HubOwner is set so `setContractAddress` passes the auth
    // check. Safe for existing tests because accounts[19] is never used elsewhere.
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);

    // Phase 10.x — a fresh chain has no CGs to migrate, so unlock the BIT index
    // immediately (mirrors the operator's post-deploy finishBackfill). accounts[19]
    // is now a registered Hub contract, so it passes onlyContracts.
    await CGWeightTreeStorage.connect(accounts[19]).finishBackfill();

    return {
      accounts,
      RandomSampling,
      Hub,
      HubLib,
      Chronos,
      RandomSamplingStorage,
      IdentityStorage,
      StakingStorage,
      ConvictionStakingStorage,
      ProfileStorage,
      AskStorage,
      EpochStorage,
      ParametersStorage,
      DKGKnowledgeAssets,
      ContextGraphStorage,
      ContextGraphValueStorage,
      CGWeightTreeStorage,
      Profile,
    };
  }

  async function updateAndGetActiveProofPeriod() {
    const tx = await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await tx.wait();
    return await RandomSampling.getActiveProofPeriodStatus();
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      RandomSampling,
      Hub,
      HubLib,
      Chronos,
      RandomSamplingStorage,
      IdentityStorage,
      StakingStorage,
      ConvictionStakingStorage,
      ProfileStorage,
      AskStorage,
      EpochStorage,
      ParametersStorage,
      DKGKnowledgeAssets,
      ContextGraphStorage,
      ContextGraphValueStorage,
      CGWeightTreeStorage,
      Profile,
    } = await loadFixture(deployRandomSamplingFixture));
  });

  describe('constructor', () => {
    it('Should set correct Hub reference', async () => {
      const hubAddress = await RandomSampling.hub();
      expect(hubAddress).to.equal(Hub.target);
    });
  });

  describe('initialize()', () => {
    it('Should initialize all contract references correctly', async () => {
      // Deploy new instance to test initialization
      const RandomSamplingFactory =
        await hre.ethers.getContractFactory('RandomSampling');
      const newRandomSampling = await RandomSamplingFactory.deploy(Hub.target);

      await newRandomSampling.initialize();

      // Verify all storage references are set
      expect(await newRandomSampling.identityStorage()).to.equal(
        await IdentityStorage.getAddress(),
      );
      expect(await newRandomSampling.randomSamplingStorage()).to.equal(
        await RandomSamplingStorage.getAddress(),
      );
      // D15: RandomSampling now reads V10 stake from ConvictionStakingStorage
      //      (StakingStorage dropped as a direct dependency).
      expect(await newRandomSampling.convictionStakingStorage()).to.equal(
        await ConvictionStakingStorage.getAddress(),
      );
      expect(await newRandomSampling.profileStorage()).to.equal(
        await ProfileStorage.getAddress(),
      );
      expect(await newRandomSampling.askStorage()).to.equal(
        await AskStorage.getAddress(),
      );
      expect(await newRandomSampling.chronos()).to.equal(
        await Chronos.getAddress(),
      );
      expect(await newRandomSampling.parametersStorage()).to.equal(
        await ParametersStorage.getAddress(),
      );
    });

    it('Should revert if not called by Hub', async () => {
      const RandomSamplingFactory =
        await hre.ethers.getContractFactory('RandomSampling');
      const newRandomSampling = await RandomSamplingFactory.deploy(Hub.target);

      await expect(newRandomSampling.connect(accounts[1]).initialize())
        .to.be.revertedWithCustomError(newRandomSampling, 'UnauthorizedAccess')
        .withArgs('Only Hub');
    });
  });

  describe('name()', () => {
    it('Should return correct name', async () => {
      expect(await RandomSampling.name()).to.equal('RandomSampling');
    });
  });

  describe('version()', () => {
    it('Should return correct version', async () => {
      expect(await RandomSampling.version()).to.equal('10.6.0');
    });
  });

  describe('isPendingProofingPeriodDuration()', () => {
    it('Should return false when no pending duration', async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be
        .false;
    });

    it('Should return true when pending duration exists', async () => {
      await RandomSampling.setProofingPeriodDurationInBlocks(200);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be.true;
    });

    it('Should return false after pending duration becomes active', async () => {
      await RandomSampling.setProofingPeriodDurationInBlocks(200);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be.true;

      // Move to next epoch
      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength));

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await RandomSampling.isPendingProofingPeriodDuration()).to.be
        .false;
    });
  });

  describe('setProofingPeriodDurationInBlocks()', () => {
    it('Should revert if durationInBlocks is 0', async () => {
      await expect(
        RandomSampling.setProofingPeriodDurationInBlocks(0),
      ).to.be.revertedWith('Duration in blocks must be greater than 0');
    });

    it('Should add new duration when no pending duration exists', async () => {
      const newDuration = 200;
      const initialLength =
        await RandomSamplingStorage.getProofingPeriodDurationsLength();

      await RandomSampling.setProofingPeriodDurationInBlocks(newDuration);

      const finalLength =
        await RandomSamplingStorage.getProofingPeriodDurationsLength();
      expect(finalLength).to.equal(initialLength + 1n);

      const latestDuration =
        await RandomSamplingStorage.getLatestProofingPeriodDurationInBlocks();
      expect(latestDuration).to.equal(newDuration);
    });

    it('Should replace pending duration when pending duration exists', async () => {
      const firstDuration = 200;
      const secondDuration = 300;

      // Add first duration
      await RandomSampling.setProofingPeriodDurationInBlocks(firstDuration);
      const lengthAfterFirst =
        await RandomSamplingStorage.getProofingPeriodDurationsLength();

      // Add second duration (should replace)
      await RandomSampling.setProofingPeriodDurationInBlocks(secondDuration);
      const lengthAfterSecond =
        await RandomSamplingStorage.getProofingPeriodDurationsLength();

      // Length should be same (replacement, not addition)
      expect(lengthAfterSecond).to.equal(lengthAfterFirst);

      const latestDuration =
        await RandomSamplingStorage.getLatestProofingPeriodDurationInBlocks();
      expect(latestDuration).to.equal(secondDuration);
    });

    it('Should set effective epoch to current epoch + 1', async () => {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await RandomSampling.setProofingPeriodDurationInBlocks(200);

      const latestEffectiveEpoch =
        await RandomSamplingStorage.getLatestProofingPeriodDurationEffectiveEpoch();
      expect(latestEffectiveEpoch).to.equal(currentEpoch + 1n);
    });

    // TODO: Test access control when multisig is properly set up
    // it('Should revert if called by non-owner', async () => {
    //   await expect(
    //     RandomSampling.connect(accounts[1]).setProofingPeriodDurationInBlocks(100)
    //   ).to.be.revertedWithCustomError(HubLib, 'UnauthorizedAccess')
    //     .withArgs('Only Hub Owner or Multisig Owner');
    // });
  });

  describe('Access Control Modifiers', () => {
    it('Should revert createChallenge if profile does not exist', async () => {
      await expect(
        RandomSampling.connect(accounts[5]).createChallenge(),
      ).to.be.revertedWithCustomError(RandomSampling, 'ProfileDoesntExist');
    });

    it('Should revert submitProof if profile does not exist', async () => {
      await expect(
        RandomSampling.connect(accounts[5]).submitProof(ethers.ZeroHash, []),
      ).to.be.revertedWithCustomError(RandomSampling, 'ProfileDoesntExist');
    });
  });

  describe('Constants and Public Variables', () => {
    it('Should have correct SCALE18 constant', async () => {
      expect(await RandomSampling.SCALE18()).to.equal(1000000000000000000n);
    });

    it('Should have initialized storage contract references', async () => {
      // Verify that contract references are properly initialized
      expect(await RandomSampling.identityStorage()).to.equal(
        await IdentityStorage.getAddress(),
      );
      expect(await RandomSampling.randomSamplingStorage()).to.equal(
        await RandomSamplingStorage.getAddress(),
      );
      // D15: RandomSampling reads V10 stake from ConvictionStakingStorage.
      expect(await RandomSampling.convictionStakingStorage()).to.equal(
        await ConvictionStakingStorage.getAddress(),
      );
      expect(await RandomSampling.profileStorage()).to.equal(
        await ProfileStorage.getAddress(),
      );
      expect(await RandomSampling.askStorage()).to.equal(
        await AskStorage.getAddress(),
      );
      expect(await RandomSampling.chronos()).to.equal(
        await Chronos.getAddress(),
      );
      expect(await RandomSampling.parametersStorage()).to.equal(
        await ParametersStorage.getAddress(),
      );
      expect(await RandomSampling.knowledgeAssetStorage()).to.equal(
        await DKGKnowledgeAssets.getAddress(),
      );
    });
  });

  // Fails because the hubOwner is not a multisig, but an individual account
  describe('setProofingPeriodDurationInBlocks()', () => {
    it('Should revert if durationInBlocks is 0', async () => {
      await expect(
        RandomSampling.setProofingPeriodDurationInBlocks(0),
      ).to.be.revertedWith('Duration in blocks must be greater than 0');
    });

    // // TODO: This test fails because the hub owner is not the multisig owner
    // it('Should revert if called by non-contract', async () => {
    //   await expect(
    //     RandomSampling.connect(accounts[1]).setProofingPeriodDurationInBlocks(
    //       100,
    //     ),
    //   )
    //     .to.be.revertedWithCustomError(HubLib, 'UnauthorizedAccess')
    //     .withArgs('Only Hub Owner or Multisig Owner');
    // });
  });

  describe('Proofing Period Management', () => {
    it('Should return the correct proofing period status', async () => {
      const { activeProofPeriodStartBlock } =
        await updateAndGetActiveProofPeriod();
      const duration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();

      // Initial check
      const status = await RandomSampling.getActiveProofPeriodStatus();
      expect(status.activeProofPeriodStartBlock).to.be.a('bigint');
      expect(status.isValid).to.be.a('boolean');
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(status.isValid).to.be.true;

      // Test at middle of period
      const middleBlock = activeProofPeriodStartBlock + duration / 2n;
      await mineBlocks(
        Number(
          middleBlock - BigInt(await hre.ethers.provider.getBlockNumber()),
        ),
      );
      const middleStatus = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(middleStatus.isValid).to.be.true;

      // Test at end of period
      const endBlock = activeProofPeriodStartBlock + duration - 1n;
      await mineBlocks(
        Number(endBlock - BigInt(await hre.ethers.provider.getBlockNumber())),
      );
      const endStatus = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(endStatus.isValid).to.be.true;

      // Test after period ends
      await mineBlocks(1);
      const afterStatus = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(afterStatus.isValid).to.be.false;
    });

    it('Should update start block correctly for different period scenarios', async () => {
      // Test when no period has passed
      const { activeProofPeriodStartBlock: initialBlock } =
        await updateAndGetActiveProofPeriod();
      const statusNoPeriod = await RandomSampling.getActiveProofPeriodStatus();
      expect(statusNoPeriod.activeProofPeriodStartBlock).to.equal(initialBlock);

      // Test when 1 full period has passed
      const duration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      await mineBlocks(Number(duration));
      const { activeProofPeriodStartBlock: onePeriodBlock } =
        await updateAndGetActiveProofPeriod();
      expect(onePeriodBlock).to.equal(initialBlock + duration);

      // Test when 2 full periods have passed (mine one less so the update tx runs
      // exactly at the period boundary; otherwise the tx mines an extra block and we advance one period)
      await mineBlocks(Number(duration) - 1);
      const { activeProofPeriodStartBlock: twoPeriodBlock } =
        await updateAndGetActiveProofPeriod();
      expect(twoPeriodBlock).to.equal(initialBlock + duration * 2n);

      // Test when n full periods have passed (using n=5 as example).
      // Mine (duration - 1) per iteration so the final update tx runs exactly at the period boundary.
      const n = 5;
      for (let i = 0; i < n - 2; i++) {
        await mineBlocks(Number(duration) - 1);
      }
      await mineBlocks(2); // compensate so we land at initialBlock + n*duration when update runs
      const { activeProofPeriodStartBlock: nPeriodBlock } =
        await updateAndGetActiveProofPeriod();
      expect(nPeriodBlock).to.equal(initialBlock + duration * BigInt(n));
    });

    it('Should return correct historical proofing period start', async () => {
      const { activeProofPeriodStartBlock } =
        await updateAndGetActiveProofPeriod();
      const duration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();

      // Test invalid inputs
      await expect(
        RandomSampling.getHistoricalProofPeriodStartBlock(0, 1),
      ).to.be.revertedWith('Proof period start block must be greater than 0');

      await expect(
        RandomSampling.getHistoricalProofPeriodStartBlock(100, 0),
      ).to.be.revertedWith('Offset must be greater than 0');

      await expect(
        RandomSampling.getHistoricalProofPeriodStartBlock(
          activeProofPeriodStartBlock + 10n,
          1,
        ),
      ).to.be.revertedWith('Proof period start block is not valid');

      await expect(
        RandomSampling.getHistoricalProofPeriodStartBlock(
          activeProofPeriodStartBlock,
          999,
        ),
      ).to.be.revertedWithPanic(PANIC_ARITHMETIC_OVERFLOW);

      // Test valid historical blocks
      await mineProofPeriodBlocks(RandomSampling);
      const { activeProofPeriodStartBlock: newPeriodStartBlock } =
        await updateAndGetActiveProofPeriod();

      // Test offset 1
      const onePeriodBack =
        await RandomSampling.getHistoricalProofPeriodStartBlock(
          newPeriodStartBlock,
          1,
        );
      expect(onePeriodBack).to.equal(newPeriodStartBlock - duration);

      // Test offset 2
      const twoPeriodsBack =
        await RandomSampling.getHistoricalProofPeriodStartBlock(
          newPeriodStartBlock,
          2,
        );
      expect(twoPeriodsBack).to.equal(newPeriodStartBlock - duration * 2n);

      // Test offset 3
      const threePeriodsBack =
        await RandomSampling.getHistoricalProofPeriodStartBlock(
          newPeriodStartBlock,
          3,
        );
      expect(threePeriodsBack).to.equal(newPeriodStartBlock - duration * 3n);

      // Test that returned block is aligned with period start
      expect(threePeriodsBack % duration).to.equal(
        0n,
        'Historical block should be aligned with period start',
      );
    });

    it('Should return correct active proof period', async () => {
      const { activeProofPeriodStartBlock, isValid } =
        await updateAndGetActiveProofPeriod();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(isValid).to.be.equal(true, 'Period should be valid');

      // Read duration and block number in one go, then compute how many
      // blocks to mine. Each contract call can advance the block by 1,
      // so read current block last and subtract 1 for safety margin.
      const duration = Number(await RandomSampling.getActiveProofingPeriodDurationInBlocks());
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const periodEnd = Number(activeProofPeriodStartBlock) + duration;
      const blocksToMine = Math.max(0, periodEnd - currentBlock - 2);
      await mineBlocks(blocksToMine);

      let statusAfterUpdate = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAfterUpdate.isValid).to.be.equal(
        true,
        'Period should still be valid',
      );

      // Mine enough blocks to definitely pass the end of the period
      const currentBlock2 = await hre.ethers.provider.getBlockNumber();
      const blocksToEnd = Math.max(1, periodEnd - currentBlock2 + 1);
      await mineBlocks(blocksToEnd);
      statusAfterUpdate = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAfterUpdate.isValid).to.be.equal(
        false,
        'Period should not be valid',
      );

      // Update the period and mine blocks for the new period
      await updateAndGetActiveProofPeriod();
      const newStatus = await RandomSampling.getActiveProofPeriodStatus();
      const durationNew = Number(await RandomSampling.getActiveProofingPeriodDurationInBlocks());
      const currentBlockNew = await hre.ethers.provider.getBlockNumber();
      const periodEndNew = Number(newStatus.activeProofPeriodStartBlock) + durationNew;
      const blocksToMineNew = Math.max(0, periodEndNew - currentBlockNew - 2);
      await mineBlocks(blocksToMineNew);

      statusAfterUpdate = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAfterUpdate.isValid).to.be.equal(
        true,
        'New period should be valid',
      );
    });

    it('Should pick correct proofing period duration based on epoch', async () => {
      const initialDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      const epochLength = await Chronos.epochLength();

      // Test initial duration
      expect(initialDuration).to.equal(
        BigInt(await RandomSampling.getActiveProofingPeriodDurationInBlocks()),
      );

      // Test duration in middle of epoch
      await time.increase(Number(epochLength) / 2);
      const midEpochDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      expect(midEpochDuration).to.equal(
        initialDuration,
        'Duration should not change mid-epoch',
      );

      // Set new duration for next epoch
      const newDuration = 1000;
      await RandomSampling.setProofingPeriodDurationInBlocks(newDuration);

      // Verify duration hasn't changed yet
      const beforeEpochEndDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      expect(beforeEpochEndDuration).to.equal(
        initialDuration,
        'Duration should not change before epoch end',
      );

      // Move to next epoch
      await time.increase(Number(epochLength) + 1);
      const nextEpochDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      expect(nextEpochDuration).to.equal(
        BigInt(newDuration),
        'Duration should change in next epoch',
      );

      // Set another duration for future epoch
      const futureDuration = 2000;
      await RandomSampling.setProofingPeriodDurationInBlocks(futureDuration);

      // Verify current epoch still has previous duration
      const currentEpochDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      expect(currentEpochDuration).to.equal(
        BigInt(newDuration),
        'Current epoch should keep previous duration',
      );

      // Move to future epoch
      await time.increase(Number(epochLength));
      const futureEpochDuration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();
      expect(futureEpochDuration).to.equal(
        BigInt(futureDuration),
        'Future epoch should have new duration',
      );
    });

    it('Should return correct proofing period duration based on epoch history', async () => {
      const baseDuration = 100;
      const testEpochs = 5;
      const currentEpoch = await Chronos.getCurrentEpoch();
      const epochLength = await Chronos.epochLength();

      // Set up multiple durations with different effective epochs
      const durations = [];
      for (let i = 0; i < testEpochs; i++) {
        const duration = baseDuration + i * 100;
        durations.push(duration);

        await RandomSampling.setProofingPeriodDurationInBlocks(duration);

        await time.increase(Number(epochLength));
      }

      const finalEpoch = await Chronos.getCurrentEpoch();
      expect(finalEpoch).to.equal(currentEpoch + BigInt(testEpochs));

      // Test invalid epoch (before first duration)
      await expect(
        RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
          currentEpoch - 1n,
        ),
      ).to.be.revertedWith('No applicable duration found');

      // Test each epoch's duration
      for (let i = 0; i < testEpochs; i++) {
        const targetEpoch = finalEpoch - BigInt(i);
        const expectedDuration = durations[testEpochs - 1 - i];

        const actual =
          await RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
            targetEpoch,
          );
        expect(actual).to.equal(
          expectedDuration,
          `Epoch ${targetEpoch} should have duration ${expectedDuration}`,
        );
      }

      // Test edge case - current epoch
      const currentEpochDuration =
        await RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
          finalEpoch,
        );
      expect(currentEpochDuration).to.equal(
        durations[durations.length - 1],
        'Current epoch should have the latest duration',
      );

      // Test edge case - first epoch with duration
      const firstEpochWithDuration = currentEpoch;
      const firstEpochDuration =
        await RandomSamplingStorage.getEpochProofingPeriodDurationInBlocks(
          firstEpochWithDuration,
        );
      expect(firstEpochDuration).to.equal(
        durations[0],
        'First epoch should have the first duration',
      );
    });

    it('Should return same block when no period has passed', async () => {
      const { activeProofPeriodStartBlock: initialBlock } =
        await updateAndGetActiveProofPeriod();

      // Mine blocks up to the last block of the current period
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const blocksToMine =
        Number(initialBlock) +
        Number(await RandomSampling.getActiveProofingPeriodDurationInBlocks()) -
        currentBlock -
        2;
      await mineBlocks(blocksToMine);

      const tx = await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
      await tx.wait();
      const { activeProofPeriodStartBlock: newBlock } =
        await RandomSampling.getActiveProofPeriodStatus();

      // Should return the same block since we haven't reached the end of the period
      expect(newBlock).to.equal(initialBlock);

      // Mine one more block to reach the end of the period
      await mineBlocks(1);

      const tx2 =
        await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
      await tx2.wait();
      const { activeProofPeriodStartBlock: finalBlock } =
        await RandomSampling.getActiveProofPeriodStatus();

      // Should update the block since we've reached the end of the period
      expect(finalBlock).to.be.greaterThan(initialBlock);
    });

    it('Should return correct status for different block numbers', async () => {
      const { activeProofPeriodStartBlock } =
        await updateAndGetActiveProofPeriod();
      const duration =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();

      // Test at start block
      const statusAtStart = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAtStart.isValid).to.be.true;
      expect(statusAtStart.activeProofPeriodStartBlock).to.equal(
        activeProofPeriodStartBlock,
      );

      // Test at middle block
      const middleBlock = activeProofPeriodStartBlock + duration / 2n;
      await mineBlocks(
        Number(
          middleBlock - BigInt(await hre.ethers.provider.getBlockNumber()),
        ),
      );
      const statusAtMiddle = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAtMiddle.isValid).to.be.true;

      // Test at last valid block
      const lastValidBlock = activeProofPeriodStartBlock + duration - 1n;
      await mineBlocks(
        Number(
          lastValidBlock - BigInt(await hre.ethers.provider.getBlockNumber()),
        ),
      );
      const statusAtLastValid =
        await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAtLastValid.isValid).to.be.true;

      // Test at first invalid block
      await mineBlocks(1);
      const statusAtInvalid = await RandomSampling.getActiveProofPeriodStatus();
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(statusAtInvalid.isValid).to.be.false;
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 10 — value-weighted challenge generation
  // ---------------------------------------------------------------------------
  //
  // These tests exercise the two-level weighted draw added to
  // `_generateChallenge`:
  //   Step 1 — pick a CG weighted by its per-epoch TRAC value at the current
  //            epoch, excluding curated ("private") and inactive CGs.
  //   Step 2 — pick a KA uniformly at random from the chosen CG's KA list and
  //            retry up to MAX_KA_RETRIES on expired KAs.
  //
  // We deploy ContextGraphStorage + ContextGraphValueStorage in an extended
  // fixture, register a test signer as a Hub contract so it can seed state
  // directly, and drive the weighted picker via the read-only helper
  // `previewChallengeForSeed(seed)`. The helper makes distribution regression
  // feasible (10k draws in milliseconds, no block mining, no state reset).
  // ---------------------------------------------------------------------------
  describe('Phase 10 — value-weighted challenge generation', () => {
    const CURATED_POLICY = 0; // curated → counts as "private" for Phase 10
    const OPEN_POLICY = 1;
    const TEST_KA_BYTE_SIZE = 128n;

    /** Hub sentinel — registered as a "contract" in `deployRandomSamplingFixture`
     *  so it can bypass the production facades and call `onlyContracts`
     *  methods on storage contracts directly. */
    let opSigner: SignerWithAddress;

    // OT-RFC-43 Option 1 (1a): KA ids are caller-supplied, author-namespaced
    // packed values `(uint160(author) << 96) | uint96(number)`. `createKa`
    // seeds with `author == opSigner`, so allocate a fresh number per KA in
    // opSigner's namespace. Reset per test so snapshot-reverted runs realloc.
    let _kaIdCounter: bigint;
    beforeEach(() => {
      opSigner = accounts[19];
      _kaIdCounter = 0n;
    });
    const nextOpSignerKaId = (): bigint => {
      _kaIdCounter += 1n;
      return (BigInt(opSigner.address) << 96n) | _kaIdCounter;
    };

    /**
     * Create a Context Graph via the storage directly and return its id.
     * Policy arg: 0 = curated (private for Phase 10 / RFC-39), 1 = open.
     *
     * Codex PR #630 R1 #1325 (cherry-picked from C2): `getIsCurated()` was
     * re-anchored from `publishPolicy == 0` to `accessPolicy != 0`. The
     * Phase 10 picker (step 2 of `_pickWeightedChallenge`) calls
     * `getIsCurated()` to decide whether to apply the per-KA ciphertext-
     * commitment filter. So the arg this helper takes — semantically
     * "should this CG be treated as curated?" — now drives `accessPolicy`
     * and we keep `publishPolicy` open in both branches (the picker
     * doesn't read `publishPolicy`; an open publish policy keeps the
     * fixture simple and avoids needing an authority signature).
     */
    async function createCG(curatedPolicy: number): Promise<bigint> {
      const owner = accounts[1].address;
      const accessPolicy = curatedPolicy === CURATED_POLICY ? 1 : 0;
      const tx = await ContextGraphStorage.connect(opSigner).createContextGraph(
        owner,
        [], // no participant agents
        0, // metadataBatchId
        accessPolicy,
        1, // publishPolicy = open (picker doesn't read this; keeps fixture simple)
        ethers.ZeroAddress, // publishAuthority — unused with open publish policy
        0, // publishAuthorityAccountId
        ethers.ZeroHash, // nameHash (integration branch post-PR #595)
      );
      await tx.wait();
      return ContextGraphStorage.getLatestContextGraphId();
    }

    /**
     * Seed a KA directly on DKGKnowledgeAssets and register it to the
     * given CG. Returns the new KA id. `endEpoch` controls the expiry — pass
     * `currentEpoch - 1` to create an already-expired KA.
     */
    async function createKa(
      cgId: bigint,
      endEpoch: bigint,
      merkleLeafCount: bigint = 1n,
    ): Promise<bigint> {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const startEpoch = currentEpoch;
      const createTx = await DKGKnowledgeAssets.connect(
        opSigner,
      ).createKnowledgeAsset(
        opSigner.address, // publisher
        opSigner.address, // author — ERC-721 KA mint recipient (greenfield model)
        nextOpSignerKaId(), // OT-RFC-43 (1a): caller-supplied author-namespaced id
        'phase-10-test-op',
        ethers.keccak256(
          ethers.toUtf8Bytes(
            `phase-10-ka-${cgId}-${Date.now()}-${Math.random()}`,
          ),
        ),
        1, // knowledgeAssetsAmount (mintKnowledgeAssetsTokens requires >=1)
        TEST_KA_BYTE_SIZE,
        startEpoch,
        endEpoch,
        0, // tokenAmount
        false, // isImmutable
        merkleLeafCount, // merkleLeafCount (v10 — pin-the-leaf-count guard)
      );
      const receipt = await createTx.wait();
      // Parse ka id from the KnowledgeAssetCreated event.
      const iface = DKGKnowledgeAssets.interface;
      const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
      const log = receipt!.logs.find((l) => l.topics[0] === topic);
      if (!log) {
        throw new Error('KnowledgeAssetCreated event not found');
      }
      const parsed = iface.parseLog(log as unknown as {
        topics: string[];
        data: string;
      })!;
      const kaId = parsed.args[0] as bigint;
      await ContextGraphStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(
        cgId,
        kaId,
      );
      return kaId;
    }

    /**
     * Allocate `value` TRAC to `cgId` spread evenly across `lifetime` epochs
     * starting at the current epoch via ContextGraphValueStorage.
     */
    async function seedCGValue(
      cgId: bigint,
      value: bigint,
      lifetime = 1n,
    ): Promise<void> {
      const currentEpoch = await Chronos.getCurrentEpoch();
      await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(
        cgId,
        currentEpoch,
        lifetime,
        value,
      );
      // Mirror production settle-on-spend: reconcile the BIT leaf to the new
      // ledger truth (settle reads getCGValueAtEpoch — the same getter the
      // legacy scan read, so the BIT draw matches the old draw bit-for-bit).
      await CGWeightTreeStorage.connect(opSigner).settle(cgId);
    }

    /**
     * Derive a caller-supplied test seed with the same shape as the on-chain
     * entropy mix so we can inspect distribution behaviour without actually
     * mining blocks. The contract's internal seed is derived identically from
     * block state + msg.sender, but the public preview helper accepts an
     * arbitrary bytes32 so tests can enumerate draws deterministically.
     */
    function testSeed(i: number): string {
      return ethers.keccak256(
        ethers.solidityPacked(['string', 'uint256'], ['phase10-draw-', i]),
      );
    }

    // -----------------------------------------------------------------------
    // Test 1 — Happy path: a single public CG with one active KA is always
    // selected regardless of the draw seed.
    // -----------------------------------------------------------------------
    it('picks the only public CG when it is the only eligible graph', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      const kaId = await createKa(cgId, endEpoch);
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      const chunkByteSize = await RandomSamplingStorage.CHUNK_BYTE_SIZE();
      const expectedMaxChunk = TEST_KA_BYTE_SIZE / BigInt(chunkByteSize); // 4

      for (let i = 0; i < 10; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        expect(preview.cgId).to.equal(cgId);
        expect(preview.kaId).to.equal(kaId);
        // KA byte size (128) > chunk byte size (32), so chunkId is drawn from
        // the rotated KA seed in [0, byteSize/chunkSize) = [0, 4).
        expect(preview.chunkId).to.be.lessThan(expectedMaxChunk);
      }
    });

    // -----------------------------------------------------------------------
    // Test 2 — Edge: only-curated-CG-holds-value scenario, KA uncommitted.
    //
    // RFC-39 Phase B (PR-B) / OT-RFC-49: curated CGs are now CG-level eligible,
    // but the KA in this test has no `(catalogRoot, catalogLeafCount)`
    // commitment. The picker's inner per-KA retry exhausts all MAX_KA_RETRIES
    // (each candidate is skipped at `getCatalogLeafCount == 0`), then the
    // outer CG-retry marks the curated CG exhausted and re-draws; with no
    // other CGs holding value, the second outer pass hits zero adjustedTotal
    // and the picker reverts with `NoEligibleKnowledgeAsset` (NOT
    // `NoEligibleContextGraph` — the first pass had a positive adjusted
    // total). This is the spec-faithful behaviour: a curated CG with only
    // pre-LU-11 KAs is functionally the same as a CG with only expired KAs.
    // -----------------------------------------------------------------------
    it('reverts NoEligibleKnowledgeAsset when only an uncommitted curated CG holds value', async () => {
      const curatedCgId = await createCG(CURATED_POLICY);
      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      await createKa(curatedCgId, endEpoch);
      await seedCGValue(curatedCgId, 5_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0)),
      ).to.be.revertedWithCustomError(
        RandomSampling,
        'NoEligibleKnowledgeAsset',
      );
    });

    // -----------------------------------------------------------------------
    // Test 3 — Mixed-curation scenario: curated CG (no commitment) coexists
    // with a public CG.
    //
    // RFC-39 Phase A.5 / OT-RFC-49 behaviour: curated CGs participate in the
    // CG-level lottery; the per-KA catalog-commitment gate is what keeps legacy
    // (pre-LU-11) curated KAs out of the curated draw.
    //
    // Codex PR #630 R1 #3 added a bounded outer CG-retry to
    // `_pickWeightedChallenge` so a single high-value legacy curated CG
    // can't DoS the entire sampling tick. With this retry, the picker
    // self-heals when it lands on a curated CG whose KAs are all
    // uncommitted: it marks that CG exhausted, re-draws against the
    // remaining eligible CGs, and falls through to the public CG. So
    // even though the curated CG carries 10× the weight, all 25 draws
    // succeed and EVERY successful draw must land on the public CG/KA
    // (a success on the curated branch would mean the per-KA commitment
    // filter is leaking and `setCatalogCommitment` is no longer
    // a prerequisite for inclusion in the curated lottery).
    // -----------------------------------------------------------------------
    it('skips curated KAs without catalog commitment; CG-retry fallback routes every draw to the public CG', async () => {
      const curatedCg = await createCG(CURATED_POLICY);
      const openCg = await createCG(OPEN_POLICY);

      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      await createKa(curatedCg, endEpoch);
      const openKa = await createKa(openCg, endEpoch);

      // Curated CG holds 10x the value of the public CG. Pre-R1 the picker
      // would have reverted on every curated-weighted draw; post-R1 the
      // outer CG-retry exhausts the curated CG and falls back to the
      // public one. The per-KA commitment filter is still what guarantees
      // the curated KA never gets picked (only public KAs survive step 2).
      await seedCGValue(curatedCg, 10_000n);
      await seedCGValue(openCg, 1_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < 25; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        // Every successful draw MUST be the public CG / public KA. A
        // success on the curated branch would mean the per-KA commitment
        // filter is leaking.
        expect(preview.cgId).to.equal(openCg);
        expect(preview.kaId).to.equal(openKa);
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 — CG with only expired KAs: MAX_KA_RETRIES are exhausted and the
    // picker reverts with NoEligibleKnowledgeAsset (the whole challenge
    // is skipped — node retries next proof period).
    // -----------------------------------------------------------------------
    it('reverts NoEligibleKnowledgeAsset when every KA in the CG has expired', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const currentEpoch = await Chronos.getCurrentEpoch();
      // Create a KA that is still live, seed value, then advance Chronos far
      // enough that the KA has expired by the time we generate the challenge.
      // The CG's value ledger is finalized only up to currentEpoch-1, so the
      // per-epoch view must still report non-zero at the new current epoch
      // (so the picker reaches the KA draw step and fails there).
      const endEpoch = currentEpoch + 1n;
      await createKa(cgId, endEpoch);
      // Give the CG value for a long lifetime so it remains weighted after
      // the epoch advance.
      await seedCGValue(cgId, 10_000n, 20n);

      // Advance Chronos past the KA's endEpoch.
      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * 5);
      const newEpoch = await Chronos.getCurrentEpoch();
      expect(newEpoch).to.be.greaterThan(endEpoch);

      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0)),
      ).to.be.revertedWithCustomError(
        RandomSampling,
        'NoEligibleKnowledgeAsset',
      );
    });

    // -----------------------------------------------------------------------
    // F08 regression — a non-curated KA with `merkleLeafCount == 0` must be
    // SKIPPED (like an expired / curated-zero KA), NOT hard-revert the draw.
    // Before the fix, `_pickKa` did `revert NoEligibleKnowledgeAsset` the
    // instant the draw landed on a zero-leaf public KA. Such a KA is
    // publishable (the publish path validates a non-zero root but not a
    // non-zero leaf count), so a single one could DoS proof-of-storage for any
    // node whose seed hit it — even when other valid KAs (here, four) exist.
    // The draw must always resolve to a valid KA and never revert.
    // -----------------------------------------------------------------------
    it('F08: skips a zero-merkleLeafCount public KA instead of reverting the draw', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      const zeroLeafKa = await createKa(cgId, endEpoch, 0n);
      const validKas = new Set<bigint>();
      for (let i = 0; i < 4; i++) {
        validKas.add(await createKa(cgId, endEpoch, 1n));
      }
      await seedCGValue(cgId, 10_000n, 20n);

      for (let i = 0; i < 40; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        expect(preview.cgId).to.equal(cgId);
        expect(
          preview.kaId,
          `seed ${i} must not draw the zero-leaf KA`,
        ).to.not.equal(zeroLeafKa);
        expect(
          validKas.has(preview.kaId),
          `seed ${i} must draw a valid KA`,
        ).to.equal(true);
      }
    });

    // -----------------------------------------------------------------------
    // Permissionless keeper — prune expired KAs from a CG's sampling list. This
    // is the committed, non-reverting cleanup path: `createChallenge`'s in-draw
    // settle work rolls back on an all-miss revert, so a CG clogged with expired
    // entries needs this keeper (its own tx) to recover. Deterministic — no
    // internal-seed/createChallenge dependency.
    // -----------------------------------------------------------------------
    describe('pruneExpiredKnowledgeAssets (keeper)', () => {
      it('removes expired KAs, preserves live KAs + the kaToContextGraph binding', async () => {
        const cgId = await createCG(OPEN_POLICY);
        const currentEpoch = await Chronos.getCurrentEpoch();
        const liveEnd = currentEpoch + 100n;
        const expiredEnd = currentEpoch + 1n;

        // Interleave live/expired: [live1, exp1, live2, exp2, exp3].
        const live1 = await createKa(cgId, liveEnd);
        const exp1 = await createKa(cgId, expiredEnd);
        const live2 = await createKa(cgId, liveEnd);
        const exp2 = await createKa(cgId, expiredEnd);
        await createKa(cgId, expiredEnd);
        expect(await ContextGraphStorage.getContextGraphKaCount(cgId)).to.equal(5n);

        // Advance past the expired endEpoch (live KAs stay live).
        const epochLength = await Chronos.epochLength();
        await time.increase(Number(epochLength) * 5);
        expect(await Chronos.getCurrentEpoch()).to.be.greaterThan(expiredEnd);

        const removed = await RandomSampling.pruneExpiredKnowledgeAssets.staticCall(cgId, 0n, 100n);
        expect(removed).to.equal(3n);
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 100n);

        // Only the 2 live KAs remain IN THE SAMPLING LIST.
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(2n);
        const remaining = new Set<bigint>([
          await ContextGraphStorage.getSamplingKaAt(cgId, 0),
          await ContextGraphStorage.getSamplingKaAt(cgId, 1),
        ]);
        expect(remaining.has(live1)).to.equal(true);
        expect(remaining.has(live2)).to.equal(true);
        expect(remaining.has(exp1)).to.equal(false);
        // Reverse binding for a pruned (expired) KA survives — readers/dedup intact.
        expect(await ContextGraphStorage.kaToContextGraph(exp2)).to.equal(cgId);
        // Reconciler-safety invariant: the append-only registration list is NOT
        // mutated by sampling pruning — its count stays at all 5 registered.
        expect(await ContextGraphStorage.getContextGraphKaCount(cgId)).to.equal(5n);
      });

      it('is bounded by maxScan and clears a large flood across calls', async () => {
        const cgId = await createCG(OPEN_POLICY);
        const expiredEnd = (await Chronos.getCurrentEpoch()) + 1n;
        for (let i = 0; i < 8; i++) await createKa(cgId, expiredEnd);
        const epochLength = await Chronos.epochLength();
        await time.increase(Number(epochLength) * 5);

        // maxScan=3 → at most 3 removed this call.
        expect(await RandomSampling.pruneExpiredKnowledgeAssets.staticCall(cgId, 0n, 3n)).to.equal(3n);
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 3n);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(5n);
        // Follow-up clears the rest of the SAMPLING list.
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 100n);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(0n);
        // The append-only registration list still holds all 8.
        expect(await ContextGraphStorage.getContextGraphKaCount(cgId)).to.equal(8n);
      });

      it('startIndex reaches the expired tail past a live prefix (live-prefix recoverability)', async () => {
        const cgId = await createCG(OPEN_POLICY);
        const currentEpoch = await Chronos.getCurrentEpoch();
        const liveEnd = currentEpoch + 100n;
        const expiredEnd = currentEpoch + 1n;
        for (let i = 0; i < 4; i++) await createKa(cgId, liveEnd); // live prefix
        for (let i = 0; i < 3; i++) await createKa(cgId, expiredEnd); // expired tail
        const epochLength = await Chronos.epochLength();
        await time.increase(Number(epochLength) * 5);

        // A from-0 scan with maxScan below the 4-live prefix removes nothing...
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 3n);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(7n);
        // ...but starting at the tail clears the expired entries.
        expect(await RandomSampling.pruneExpiredKnowledgeAssets.staticCall(cgId, 4n, 10n)).to.equal(3n);
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 4n, 10n);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(4n);
      });

      it('recovery path: a clogged CG starves previewChallengeForSeed before pruning, succeeds after', async () => {
        // The bug this keeper fixes: a bounded within-CG draw starved by expired
        // dead slots. Prove the actual draw path — not just list mutation.
        const cgId = await createCG(OPEN_POLICY);
        const currentEpoch = await Chronos.getCurrentEpoch();
        const liveKa = await createKa(cgId, currentEpoch + 100n);
        for (let i = 0; i < 20; i++) await createKa(cgId, currentEpoch + 1n); // expired flood
        await seedCGValue(cgId, 10_000n, 20n); // keep the single CG weighted across the advance
        const epochLength = await Chronos.epochLength();
        await time.increase(Number(epochLength) * 5); // expire the 20 fillers

        // Find a seed whose draw starves on the expired slots (reverts). With
        // 1 live / 20 expired, P(starve) per seed ≈ (20/21)^10 ≈ 0.61, so a
        // reverting seed within 50 is a near-certainty (P(miss) ≈ 1e-21).
        let cloggedSeed: number | undefined;
        for (let i = 0; i < 50; i++) {
          try {
            await RandomSampling.previewChallengeForSeed(testSeed(i));
          } catch {
            cloggedSeed = i;
            break;
          }
        }
        expect(cloggedSeed, 'expected a seed that starves on the expired flood').to.not.equal(undefined);
        // BEFORE: that seed reverts — the draw is clogged.
        await expect(
          RandomSampling.previewChallengeForSeed(testSeed(cloggedSeed!)),
        ).to.be.revertedWithCustomError(RandomSampling, 'NoEligibleKnowledgeAsset');

        // Prune the expired KAs via the keeper (its own committed tx).
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 100n);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(1n);

        // AFTER: the SAME seed now resolves to the live KA — the draw recovered.
        const after = await RandomSampling.previewChallengeForSeed(testSeed(cloggedSeed!));
        expect(after.cgId).to.equal(cgId);
        expect(after.kaId).to.equal(liveKa);
      });

      it('reconciler-safety: pruning never rewinds the append-only ordinal, so a later publish is always appended (round-4 regression)', async () => {
        // The exact failure mode the decoupled sampling list prevents: pruning
        // must NOT shrink the registration list, or the off-chain reconciler's
        // [watermark, head) cursor could skip a later publish forever.
        const cgId = await createCG(OPEN_POLICY);
        const currentEpoch = await Chronos.getCurrentEpoch();
        await createKa(cgId, currentEpoch + 1n);
        await createKa(cgId, currentEpoch + 1n);
        await createKa(cgId, currentEpoch + 1n);
        const headBeforePrune = await ContextGraphStorage.getContextGraphKaCount(cgId);
        expect(headBeforePrune).to.equal(3n);

        const epochLength = await Chronos.epochLength();
        await time.increase(Number(epochLength) * 5);
        await RandomSampling.pruneExpiredKnowledgeAssets(cgId, 0n, 100n);

        // Sampling list emptied, but the registration head is UNCHANGED — the
        // reconciler cursor is not rewound.
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(0n);
        expect(await ContextGraphStorage.getContextGraphKaCount(cgId)).to.equal(headBeforePrune);

        // A later publish appends at the NEXT ordinal (head grows monotonically),
        // so the reconciler can never skip it — and it is sampling-eligible.
        const laterKa = await createKa(cgId, currentEpoch + 100n);
        expect(await ContextGraphStorage.getContextGraphKaCount(cgId)).to.equal(headBeforePrune + 1n);
        expect(await ContextGraphStorage.getContextGraphKaAt(cgId, headBeforePrune)).to.equal(laterKa);
        expect(await ContextGraphStorage.getSamplingKaCount(cgId)).to.equal(1n);
        expect(await ContextGraphStorage.getSamplingKaAt(cgId, 0n)).to.equal(laterKa);
      });

      it('the swap-pop primitive is gated to the RandomSampling contract', async () => {
        const cgId = await createCG(OPEN_POLICY);
        const ka = await createKa(cgId, (await Chronos.getCurrentEpoch()) + 5n);
        // opSigner is a Hub-registered sentinel but NOT the RandomSampling contract.
        await expect(
          ContextGraphStorage.connect(opSigner).swapRemoveSamplingKnowledgeAssetAt(cgId, 0, ka),
        ).to.be.revertedWithCustomError(ContextGraphStorage, 'OnlyRandomSampling');
      });
    });

    // -----------------------------------------------------------------------
    // Test 5 — Distribution regression: 3 public CGs weighted 70/20/10 should
    // be picked at those ratios over many draws. Using the read-only preview
    // helper with per-draw seeds makes this both deterministic and fast.
    //
    // Draw count reduced from 10,000 to 2,000 so the test reliably completes
    // under solidity-coverage instrumentation (which slows each RPC call by
    // an order of magnitude). 2k draws is still well over the 3σ noise floor
    // for a 70/20/10 split (std dev A ≈ 20, B ≈ 18, C ≈ 13).
    // -----------------------------------------------------------------------
    it('distribution converges to 70/20/10 over 2,000 draws', async () => {
      const cgA = await createCG(OPEN_POLICY);
      const cgB = await createCG(OPEN_POLICY);
      const cgC = await createCG(OPEN_POLICY);

      const endEpoch = (await Chronos.getCurrentEpoch()) + 100n;
      await createKa(cgA, endEpoch);
      await createKa(cgB, endEpoch);
      await createKa(cgC, endEpoch);

      // Raw value values become per-epoch contributions of 7000 / 2000 / 1000.
      await seedCGValue(cgA, 7_000n);
      await seedCGValue(cgB, 2_000n);
      await seedCGValue(cgC, 1_000n);

      const DRAWS = 2_000;
      const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < DRAWS; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        if (preview.cgId === cgA) counts.A++;
        else if (preview.cgId === cgB) counts.B++;
        else if (preview.cgId === cgC) counts.C++;
        else throw new Error(`unexpected cgId ${preview.cgId}`);
      }

      // Expected means: A=1400, B=400, C=200. ~±10% absolute tolerance still
      // catches a broken walker while remaining non-flaky on well-mixed seeds.
      expect(counts.A).to.be.greaterThan(1250).and.lessThan(1550);
      expect(counts.B).to.be.greaterThan(300).and.lessThan(500);
      expect(counts.C).to.be.greaterThan(100).and.lessThan(300);
    }).timeout(600_000);

    // -----------------------------------------------------------------------
    // Test 6 — Inactive (deactivated) CGs must be excluded even if they
    // currently hold value. Exercises the second branch of the read-time
    // filter beyond the curated-policy check.
    // -----------------------------------------------------------------------
    it('excludes deactivated CGs from the weighted draw', async () => {
      const deactivated = await createCG(OPEN_POLICY);
      const activeCg = await createCG(OPEN_POLICY);

      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      await createKa(deactivated, endEpoch);
      const activeKa = await createKa(activeCg, endEpoch);

      await seedCGValue(deactivated, 10_000n);
      await seedCGValue(activeCg, 1_000n);

      // Deactivate the richer CG — it must be skipped during the walk.
      await ContextGraphStorage.connect(opSigner)
        .deactivateContextGraph(deactivated);

      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < 15; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        expect(preview.cgId).to.equal(activeCg);
        expect(preview.kaId).to.equal(activeKa);
      }
    });

    // -----------------------------------------------------------------------
    // Test 7 — Plan invariant (v10 plan lines 713–714): a CG's per-epoch
    // contribution must auto-decay to zero once its seeded lifetime expires,
    // and the picker must then auto-exclude it. The KA is deliberately kept
    // live beyond the seed lifetime so the only driver of auto-exclusion is
    // the value decay in ContextGraphValueStorage — not KA expiry.
    // -----------------------------------------------------------------------
    it('auto-excludes a CG whose seed lifetime has expired (per-epoch contribution decays to zero)', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const startEpoch = await Chronos.getCurrentEpoch();
      const seedLifetime = 5n;
      // KA outlives the seed so auto-exclusion can only be driven by
      // ContextGraphValueStorage's per-epoch decay.
      await createKa(cgId, startEpoch + 100n);
      await seedCGValue(cgId, 10_000n, seedLifetime);

      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(cgId, startEpoch),
      ).to.be.greaterThan(0n);

      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * Number(seedLifetime + 1n));
      const newEpoch = await Chronos.getCurrentEpoch();
      expect(newEpoch).to.be.greaterThan(startEpoch + seedLifetime);

      // Storage-level invariant: per-epoch contribution decayed to zero.
      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(cgId, newEpoch),
      ).to.equal(0n);

      // BIT leaf is a snapshot from seed time; reconcile it to the decayed ledger
      // truth (models settle-on-miss / the keeper). After settle the leaf is 0.
      await CGWeightTreeStorage.connect(opSigner).settle(cgId);

      // Picker-level invariant: adjustedTotal == 0 → revert.
      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0)),
      ).to.be.revertedWithCustomError(
        RandomSampling,
        'NoEligibleContextGraph',
      );
    });

    // -----------------------------------------------------------------------
    // Test 8 — Plan invariant (v10 plan line 713): an "empty" CG (per-epoch
    // contribution = 0 post-expiry) must never be selected even when it
    // originally held 10× the nominal value, provided a still-active CG
    // coexists. Proves the weighted walk respects per-epoch decay — a live
    // low-value CG beats a "rich" decayed CG.
    // -----------------------------------------------------------------------
    it('never selects a CG whose seed has decayed while a live neighbor exists', async () => {
      const expiredCg = await createCG(OPEN_POLICY);
      const activeCg = await createCG(OPEN_POLICY);
      const startEpoch = await Chronos.getCurrentEpoch();
      const shortLifetime = 5n;
      const longLifetime = 100n;

      // Both KAs live past the advance so picker exclusion is driven only
      // by value decay, not KA expiry.
      await createKa(expiredCg, startEpoch + longLifetime);
      const activeKa = await createKa(activeCg, startEpoch + longLifetime);

      // Expired CG: 10× the nominal TRAC but a 5-epoch lifetime.
      // Active  CG: 1/10 the nominal TRAC but a 100-epoch lifetime.
      await seedCGValue(expiredCg, 10_000n, shortLifetime);
      await seedCGValue(activeCg, 1_000n, longLifetime);

      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * Number(shortLifetime + 1n));
      const newEpoch = await Chronos.getCurrentEpoch();

      // Reconcile both BIT leaves to the decayed ledger (models settle-on-miss /
      // keeper): the expired CG settles to 0, the live neighbor keeps its weight.
      await CGWeightTreeStorage.connect(opSigner).settle(expiredCg);
      await CGWeightTreeStorage.connect(opSigner).settle(activeCg);

      // Storage invariant: expired decayed to zero, active still > 0.
      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(expiredCg, newEpoch),
      ).to.equal(0n);
      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(activeCg, newEpoch),
      ).to.be.greaterThan(0n);

      // Picker invariant: every draw lands on the active CG.
      for (let i = 0; i < 20; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(testSeed(i));
        expect(preview.cgId).to.equal(activeCg);
        expect(preview.kaId).to.equal(activeKa);
      }
    });

    // -----------------------------------------------------------------------
    // Test 9 — Draw-level parity (BIT refactor discriminator): the full
    // (cgId, kaId, chunkId) tuple from previewChallengeForSeed must match a JS
    // oracle replicating the EXACT on-chain seed threading — r = seed % total
    // straddle for the CG; kaSeed = keccak256(seed, uint8(0)) for the KA index
    // and the leaf. If this fails, the draw diverged (seed threading or the
    // tree weight broke) — do NOT just adjust the expectation.
    // -----------------------------------------------------------------------
    it('draw-level parity: (cgId,kaId,chunkId) matches the seed-threading oracle', async () => {
      const endEpoch = (await Chronos.getCurrentEpoch()) + 100n;
      // Multiple KAs per CG (exercise the kaSeed→idx pick) and leafCount > 1
      // (exercise the chunk draw). leafCount is uniform within each CG below.
      const cgA = await createCG(OPEN_POLICY);
      await createKa(cgA, endEpoch, 4n);
      await createKa(cgA, endEpoch, 4n);
      const cgB = await createCG(OPEN_POLICY);
      await createKa(cgB, endEpoch, 7n);
      const cgC = await createCG(OPEN_POLICY);
      await createKa(cgC, endEpoch, 3n);
      await createKa(cgC, endEpoch, 3n);
      await createKa(cgC, endEpoch, 3n);

      await seedCGValue(cgA, 5_000n);
      await seedCGValue(cgB, 3_000n);
      await seedCGValue(cgC, 2_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      const cgs = [cgA, cgB, cgC];
      const leafCountByCg: Record<string, bigint> = {
        [cgA.toString()]: 4n,
        [cgB.toString()]: 7n,
        [cgC.toString()]: 3n,
      };
      // Prefetch weights + KA ordering so the oracle is a pure function.
      const weight: Record<string, bigint> = {};
      const kaList: Record<string, bigint[]> = {};
      for (const cg of cgs) {
        weight[cg.toString()] = await ContextGraphValueStorage.getCGValueAtEpoch(
          cg,
          currentEpoch,
        );
        // The draw reads the SAMPLING list, so the oracle must mirror it.
        const n = Number(await ContextGraphStorage.getSamplingKaCount(cg));
        const list: bigint[] = [];
        for (let i = 0; i < n; i++) {
          list.push(await ContextGraphStorage.getSamplingKaAt(cg, BigInt(i)));
        }
        kaList[cg.toString()] = list;
      }
      const total = cgs.reduce((s, cg) => s + weight[cg.toString()], 0n);

      function oracle(seed: string): { cg: bigint; ka: bigint; chunk: bigint } {
        const r = BigInt(seed) % total;
        let running = 0n;
        let cg = 0n;
        for (const c of cgs) {
          running += weight[c.toString()];
          if (running > r) {
            cg = c;
            break;
          }
        }
        // attempt 0 (all KAs live & public): kaSeed = keccak256(seed, uint8(0)).
        const kaSeed = ethers.keccak256(
          ethers.solidityPacked(['bytes32', 'uint8'], [seed, 0]),
        );
        const list = kaList[cg.toString()];
        const idx = Number(BigInt(kaSeed) % BigInt(list.length));
        const ka = list[idx];
        const chunk = BigInt(kaSeed) % leafCountByCg[cg.toString()];
        return { cg, ka, chunk };
      }

      for (let i = 0; i < 60; i++) {
        const seed = testSeed(i);
        const got = await RandomSampling.previewChallengeForSeed(seed);
        const exp = oracle(seed);
        expect(got.cgId, `cgId i=${i}`).to.equal(exp.cg);
        expect(got.kaId, `kaId i=${i}`).to.equal(exp.ka);
        expect(got.chunkId, `chunkId i=${i}`).to.equal(exp.chunk);
      }
    });

    // -----------------------------------------------------------------------
    // Test 10 — Fairness bar (RFC acceptance criterion): in the settled state,
    // per-CG draw frequency stays within ±2 percentage points of its true
    // active-weight share. Deterministic seed sequence, so this is a fixed
    // pass/fail check, not a flaky statistical one.
    // -----------------------------------------------------------------------
    // 5000-draw statistical check: too slow under coverage instrumentation (each
    // instrumented draw is far slower, so it exceeds the 600s mocha timeout on CI).
    // It adds no unique contract-line coverage, so skip it under coverage — same
    // convention as ContextGraphStorage.test.ts's heavy-test skip.
    const skipFairnessUnderCoverage = process.argv.some((a) => a.includes('coverage'));
    (skipFairnessUnderCoverage ? it.skip : it)('fairness: draw frequency within ±2pp of weight share (settled state)', async () => {
      const endEpoch = (await Chronos.getCurrentEpoch()) + 100n;
      const sharePct = [50n, 25n, 15n, 7n, 3n]; // sums to 100
      const cgIds: bigint[] = [];
      for (const w of sharePct) {
        const cg = await createCG(OPEN_POLICY);
        await createKa(cg, endEpoch);
        await seedCGValue(cg, w * 1_000n);
        cgIds.push(cg);
      }
      const totalShare = Number(sharePct.reduce((a, b) => a + b, 0n)); // 100
      const currentEpoch = await Chronos.getCurrentEpoch();

      const DRAWS = 5_000;
      const counts = new Map<string, number>();
      for (let i = 0; i < DRAWS; i++) {
        const p = await RandomSampling.previewChallengeForSeed(testSeed(1_000_000 + i));
        counts.set(
          p.cgId.toString(),
          (counts.get(p.cgId.toString()) ?? 0) + 1,
        );
      }
      cgIds.forEach((cg, k) => {
        const observed = (counts.get(cg.toString()) ?? 0) / DRAWS;
        const expected = Number(sharePct[k]) / totalShare;
        expect(
          Math.abs(observed - expected),
          `cg share ${expected} observed ${observed}`,
        ).to.be.lessThan(0.02);
      });
    }).timeout(600_000);
  });
});
