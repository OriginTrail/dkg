import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
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
  ProfileStorage,
  AskStorage,
  EpochStorage,
  ParametersStorage,
  KnowledgeCollectionStorage,
  Profile,
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
  ProfileStorage: ProfileStorage;
  AskStorage: AskStorage;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  KnowledgeCollectionStorage: KnowledgeCollectionStorage;
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
  let ProfileStorage: ProfileStorage;
  let AskStorage: AskStorage;
  let EpochStorage: EpochStorage;
  let ParametersStorage: ParametersStorage;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
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

    return {
      accounts,
      RandomSampling,
      Hub,
      HubLib,
      Chronos,
      RandomSamplingStorage,
      IdentityStorage,
      StakingStorage,
      ProfileStorage,
      AskStorage,
      EpochStorage,
      ParametersStorage,
      KnowledgeCollectionStorage,
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
      ProfileStorage,
      AskStorage,
      EpochStorage,
      ParametersStorage,
      KnowledgeCollectionStorage,
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
      expect(await newRandomSampling.stakingStorage()).to.equal(
        await StakingStorage.getAddress(),
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
      expect(await RandomSampling.stakingStorage()).to.equal(
        await StakingStorage.getAddress(),
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
});
