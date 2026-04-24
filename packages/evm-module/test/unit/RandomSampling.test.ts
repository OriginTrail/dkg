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
  KnowledgeCollectionStorage,
  Profile,
  ContextGraphStorage,
  ContextGraphValueStorage,
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
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  ContextGraphStorage: ContextGraphStorage;
  ContextGraphValueStorage: ContextGraphValueStorage;
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
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let ContextGraphStorage: ContextGraphStorage;
  let ContextGraphValueStorage: ContextGraphValueStorage;
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
      'KnowledgeCollectionStorage',
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
    KnowledgeCollectionStorage =
      await hre.ethers.getContract<KnowledgeCollectionStorage>(
        'KnowledgeCollectionStorage',
      );
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>(
      'ContextGraphStorage',
    );
    ContextGraphValueStorage =
      await hre.ethers.getContract<ContextGraphValueStorage>(
        'ContextGraphValueStorage',
      );

    // Register a sentinel signer as a Hub contract so Phase 10 weighted-
    // selection tests can call `onlyContracts` methods on ContextGraphStorage /
    // ContextGraphValueStorage / KnowledgeCollectionStorage directly, without
    // routing through the production facades (ContextGraphs, KnowledgeCollection).
    // Must run after HubOwner is set so `setContractAddress` passes the auth
    // check. Safe for existing tests because accounts[19] is never used elsewhere.
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);

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
      KnowledgeCollectionStorage,
      ContextGraphStorage,
      ContextGraphValueStorage,
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
      KnowledgeCollectionStorage,
      ContextGraphStorage,
      ContextGraphValueStorage,
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
      expect(await RandomSampling.version()).to.equal('1.0.0');
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
        RandomSampling.connect(accounts[5]).submitProof('chunk', []),
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
      expect(await RandomSampling.knowledgeCollectionStorage()).to.equal(
        await KnowledgeCollectionStorage.getAddress(),
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
  //   Step 2 — pick a KC uniformly at random from the chosen CG's KC list and
  //            retry up to MAX_KC_RETRIES on expired KCs.
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
    const TEST_KC_BYTE_SIZE = 128n;

    /** Hub sentinel — registered as a "contract" in `deployRandomSamplingFixture`
     *  so it can bypass the production facades and call `onlyContracts`
     *  methods on storage contracts directly. */
    let opSigner: SignerWithAddress;

    beforeEach(() => {
      opSigner = accounts[19];
    });

    /**
     * Create a Context Graph via the storage directly and return its id.
     * Policy: 0 = curated (private for Phase 10), 1 = open.
     */
    async function createCG(publishPolicy: number): Promise<bigint> {
      const owner = accounts[1].address;
      const authority =
        publishPolicy === CURATED_POLICY
          ? accounts[2].address
          : ethers.ZeroAddress;
      const tx = await ContextGraphStorage.connect(opSigner).createContextGraph(
        owner,
        [10n, 20n, 30n], // hosting nodes (sorted, non-zero, distinct)
        [], // no participant agents
        2, // requiredSignatures
        0, // metadataBatchId
        publishPolicy,
        authority,
        0, // publishAuthorityAccountId
      );
      await tx.wait();
      return ContextGraphStorage.getLatestContextGraphId();
    }

    /**
     * Seed a KC directly on KnowledgeCollectionStorage and register it to the
     * given CG. Returns the new KC id. `endEpoch` controls the expiry — pass
     * `currentEpoch - 1` to create an already-expired KC.
     */
    async function createKC(cgId: bigint, endEpoch: bigint): Promise<bigint> {
      const currentEpoch = await Chronos.getCurrentEpoch();
      const startEpoch = currentEpoch;
      const createTx = await KnowledgeCollectionStorage.connect(
        opSigner,
      ).createKnowledgeCollection(
        opSigner.address, // publisher
        'phase-10-test-op',
        ethers.keccak256(
          ethers.toUtf8Bytes(
            `phase-10-kc-${cgId}-${Date.now()}-${Math.random()}`,
          ),
        ),
        1, // knowledgeAssetsAmount (mintKnowledgeAssetsTokens requires >=1)
        TEST_KC_BYTE_SIZE,
        startEpoch,
        endEpoch,
        0, // tokenAmount
        false, // isImmutable
      );
      const receipt = await createTx.wait();
      // Parse kc id from the KnowledgeCollectionCreated event.
      const iface = KnowledgeCollectionStorage.interface;
      const topic = iface.getEvent('KnowledgeCollectionCreated')!.topicHash;
      const log = receipt!.logs.find((l) => l.topics[0] === topic);
      if (!log) {
        throw new Error('KnowledgeCollectionCreated event not found');
      }
      const parsed = iface.parseLog(log as unknown as {
        topics: string[];
        data: string;
      })!;
      const kcId = parsed.args[0] as bigint;
      await ContextGraphStorage.connect(opSigner).registerKCToContextGraph(
        cgId,
        kcId,
      );
      return kcId;
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
    // Test 1 — Happy path: a single public CG with one active KC is always
    // selected regardless of the draw seed.
    // -----------------------------------------------------------------------
    it('picks the only public CG when it is the only eligible graph', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      const kcId = await createKC(cgId, endEpoch);
      await seedCGValue(cgId, 1_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      const chunkByteSize = await RandomSamplingStorage.CHUNK_BYTE_SIZE();
      const expectedMaxChunk = TEST_KC_BYTE_SIZE / BigInt(chunkByteSize); // 4

      for (let i = 0; i < 10; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(cgId);
        expect(preview.kcId).to.equal(kcId);
        // KC byte size (128) > chunk byte size (32), so chunkId is drawn from
        // the rotated KC seed in [0, byteSize/chunkSize) = [0, 4).
        expect(preview.chunkId).to.be.lessThan(expectedMaxChunk);
      }
    });

    // -----------------------------------------------------------------------
    // Test 2 — Edge: no eligible value at all (no CGs or every CG is curated)
    // => revert with NoEligibleContextGraph.
    // -----------------------------------------------------------------------
    it('reverts NoEligibleContextGraph when only curated CGs hold value', async () => {
      const curatedCgId = await createCG(CURATED_POLICY);
      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      await createKC(curatedCgId, endEpoch);
      await seedCGValue(curatedCgId, 5_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0), currentEpoch),
      ).to.be.revertedWithCustomError(
        RandomSampling,
        'NoEligibleContextGraph',
      );
    });

    // -----------------------------------------------------------------------
    // Test 3 — Private CG coexists with a public CG: private must be excluded
    // and the public CG must win 100% of draws.
    // -----------------------------------------------------------------------
    it('excludes curated CGs and always picks the public CG', async () => {
      const curatedCg = await createCG(CURATED_POLICY);
      const openCg = await createCG(OPEN_POLICY);

      const endEpoch = (await Chronos.getCurrentEpoch()) + 5n;
      await createKC(curatedCg, endEpoch);
      const openKc = await createKC(openCg, endEpoch);

      // Private CG holds 10x the value of the public CG. Weighting would
      // prefer the private one by naive ratio, so this test asserts the
      // read-time exclusion filter.
      await seedCGValue(curatedCg, 10_000n);
      await seedCGValue(openCg, 1_000n);

      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < 25; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(openCg);
        expect(preview.kcId).to.equal(openKc);
      }
    });

    // -----------------------------------------------------------------------
    // Test 4 — CG with only expired KCs: MAX_KC_RETRIES are exhausted and the
    // picker reverts with NoEligibleKnowledgeCollection (the whole challenge
    // is skipped — node retries next proof period).
    // -----------------------------------------------------------------------
    it('reverts NoEligibleKnowledgeCollection when every KC in the CG has expired', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const currentEpoch = await Chronos.getCurrentEpoch();
      // Create a KC that is still live, seed value, then advance Chronos far
      // enough that the KC has expired by the time we generate the challenge.
      // The CG's value ledger is finalized only up to currentEpoch-1, so the
      // per-epoch view must still report non-zero at the new current epoch
      // (so the picker reaches the KC draw step and fails there).
      const endEpoch = currentEpoch + 1n;
      await createKC(cgId, endEpoch);
      // Give the CG value for a long lifetime so it remains weighted after
      // the epoch advance.
      await seedCGValue(cgId, 10_000n, 20n);

      // Advance Chronos past the KC's endEpoch.
      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * 5);
      const newEpoch = await Chronos.getCurrentEpoch();
      expect(newEpoch).to.be.greaterThan(endEpoch);

      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0), newEpoch),
      ).to.be.revertedWithCustomError(
        RandomSampling,
        'NoEligibleKnowledgeCollection',
      );
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
      await createKC(cgA, endEpoch);
      await createKC(cgB, endEpoch);
      await createKC(cgC, endEpoch);

      // Raw value values become per-epoch contributions of 7000 / 2000 / 1000.
      await seedCGValue(cgA, 7_000n);
      await seedCGValue(cgB, 2_000n);
      await seedCGValue(cgC, 1_000n);

      const DRAWS = 2_000;
      const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < DRAWS; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
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
      await createKC(deactivated, endEpoch);
      const activeKc = await createKC(activeCg, endEpoch);

      await seedCGValue(deactivated, 10_000n);
      await seedCGValue(activeCg, 1_000n);

      // Deactivate the richer CG — it must be skipped during the walk.
      await ContextGraphStorage.connect(opSigner)
        .deactivateContextGraph(deactivated);

      const currentEpoch = await Chronos.getCurrentEpoch();
      for (let i = 0; i < 15; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(
          testSeed(i),
          currentEpoch,
        );
        expect(preview.cgId).to.equal(activeCg);
        expect(preview.kcId).to.equal(activeKc);
      }
    });

    // -----------------------------------------------------------------------
    // Test 7 — Plan invariant (v10 plan lines 713–714): a CG's per-epoch
    // contribution must auto-decay to zero once its seeded lifetime expires,
    // and the picker must then auto-exclude it. The KC is deliberately kept
    // live beyond the seed lifetime so the only driver of auto-exclusion is
    // the value decay in ContextGraphValueStorage — not KC expiry.
    // -----------------------------------------------------------------------
    it('auto-excludes a CG whose seed lifetime has expired (per-epoch contribution decays to zero)', async () => {
      const cgId = await createCG(OPEN_POLICY);
      const startEpoch = await Chronos.getCurrentEpoch();
      const seedLifetime = 5n;
      // KC outlives the seed so auto-exclusion can only be driven by
      // ContextGraphValueStorage's per-epoch decay.
      await createKC(cgId, startEpoch + 100n);
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

      // Picker-level invariant: adjustedTotal == 0 → revert.
      await expect(
        RandomSampling.previewChallengeForSeed(testSeed(0), newEpoch),
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

      // Both KCs live past the advance so picker exclusion is driven only
      // by value decay, not KC expiry.
      await createKC(expiredCg, startEpoch + longLifetime);
      const activeKc = await createKC(activeCg, startEpoch + longLifetime);

      // Expired CG: 10× the nominal TRAC but a 5-epoch lifetime.
      // Active  CG: 1/10 the nominal TRAC but a 100-epoch lifetime.
      await seedCGValue(expiredCg, 10_000n, shortLifetime);
      await seedCGValue(activeCg, 1_000n, longLifetime);

      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * Number(shortLifetime + 1n));
      const newEpoch = await Chronos.getCurrentEpoch();

      // Storage invariant: expired decayed to zero, active still > 0.
      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(expiredCg, newEpoch),
      ).to.equal(0n);
      expect(
        await ContextGraphValueStorage.getCGValueAtEpoch(activeCg, newEpoch),
      ).to.be.greaterThan(0n);

      // Picker invariant: every draw lands on the active CG.
      for (let i = 0; i < 20; i++) {
        const preview = await RandomSampling.previewChallengeForSeed(
          testSeed(i),
          newEpoch,
        );
        expect(preview.cgId).to.equal(activeCg);
        expect(preview.kcId).to.equal(activeKc);
      }
    });
  });
});
