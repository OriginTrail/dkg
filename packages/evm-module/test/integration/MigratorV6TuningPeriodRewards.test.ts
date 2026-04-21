import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre, { ethers } from 'hardhat';
// import * as readline from 'readline';

import {
  Hub,
  Token,
  Chronos,
  StakingStorage,
  RandomSamplingStorage,
  ParametersStorage,
  ProfileStorage,
  DelegatorsInfo,
  Ask,
  Staking,
  RandomSampling,
  Profile,
  AskStorage,
  ShardingTableStorage,
  ShardingTable,
  MigratorV6TuningPeriodRewards,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

const toTRAC = (x: string | number) => ethers.parseUnits(x.toString(), 18);

type TestContracts = {
  hub: Hub;
  token: Token;
  chronos: Chronos;
  stakingStorage: StakingStorage;
  randomSamplingStorage: RandomSamplingStorage;
  parametersStorage: ParametersStorage;
  profileStorage: ProfileStorage;
  delegatorsInfo: DelegatorsInfo;
  staking: Staking;
  profile: Profile;
  randomSampling: RandomSampling;
  askStorage: AskStorage;
  ask: Ask;
  migrator: MigratorV6TuningPeriodRewards;
  shardingTableStorage: ShardingTableStorage;
  shardingTable: ShardingTable;
};

type TestAccounts = {
  owner: SignerWithAddress;
  node1: { operational: SignerWithAddress; admin: SignerWithAddress };
  node2: { operational: SignerWithAddress; admin: SignerWithAddress };
  delegator1: SignerWithAddress;
  delegator2: SignerWithAddress;
  delegator3: SignerWithAddress;
};

async function setupTestEnvironment(): Promise<{
  accounts: TestAccounts;
  contracts: TestContracts;
  nodeIds: { node1Id: bigint; node2Id: bigint };
}> {
  hre.helpers.resetDeploymentsJson();
  // Deploy only the contracts that the migrator actually needs
  await hre.deployments.fixture([
    'MigratorV6TuningPeriodRewards',
    'Staking',
    'Profile',
    'Token',
    'RandomSampling',
    'EpochStorage',
  ]);

  const signers = await hre.ethers.getSigners();
  const accounts: TestAccounts = {
    owner: signers[0],
    node1: { operational: signers[1], admin: signers[2] },
    node2: { operational: signers[3], admin: signers[4] },
    delegator1: signers[5],
    delegator2: signers[6],
    delegator3: signers[7],
  };

  const contracts: TestContracts = {
    hub: await hre.ethers.getContract<Hub>('Hub'),
    token: await hre.ethers.getContract<Token>('Token'),
    chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    stakingStorage:
      await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    randomSamplingStorage: await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    ),
    parametersStorage:
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    profileStorage:
      await hre.ethers.getContract<ProfileStorage>('ProfileStorage'),
    delegatorsInfo:
      await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    staking: await hre.ethers.getContract<Staking>('Staking'),
    profile: await hre.ethers.getContract<Profile>('Profile'),
    randomSampling:
      await hre.ethers.getContract<RandomSampling>('RandomSampling'),
    askStorage: await hre.ethers.getContract<AskStorage>('AskStorage'),
    ask: await hre.ethers.getContract<Ask>('Ask'),
    shardingTableStorage: await hre.ethers.getContract<ShardingTableStorage>(
      'ShardingTableStorage',
    ),
    shardingTable: await hre.ethers.getContract<ShardingTable>('ShardingTable'),
    migrator: await hre.ethers.getContract<MigratorV6TuningPeriodRewards>(
      'MigratorV6TuningPeriodRewards',
    ),
  };

  await contracts.hub.setContractAddress('HubOwner', accounts.owner.address);

  // Mint tokens for all participants
  for (const delegator of [
    accounts.delegator1,
    accounts.delegator2,
    accounts.delegator3,
  ]) {
    await contracts.token.mint(delegator.address, toTRAC(100_000));
  }
  await contracts.token.mint(accounts.owner.address, toTRAC(1_000_000));
  await contracts.token.mint(
    accounts.node1.operational.address,
    toTRAC(100_000),
  );
  await contracts.token.mint(
    accounts.node2.operational.address,
    toTRAC(100_000),
  );

  // Create profiles for nodes
  const node1Profile = await createProfile(contracts.profile, accounts.node1);

  const node2Profile = await createProfile(contracts.profile, accounts.node2);

  return {
    accounts,
    contracts,
    nodeIds: {
      node1Id: BigInt(node1Profile.identityId),
      node2Id: BigInt(node2Profile.identityId),
    },
  };
}

async function advanceEpochAndEnsureActivity(
  contracts: TestContracts,
): Promise<void> {
  // Simply advance to next epoch for testing purposes
  const epochLength = await contracts.chronos.epochLength();
  await time.increase(Number(epochLength));

  // Trigger epoch advancement in system
  await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();
}

describe('MigratorV6TuningPeriodRewards Integration Tests', function () {
  let accounts: TestAccounts;
  let contracts: TestContracts;
  let nodeIds: { node1Id: bigint; node2Id: bigint };
  let node1Id: bigint;
  let node2Id: bigint;

  beforeEach(async function () {
    const setup = await setupTestEnvironment();
    accounts = setup.accounts;
    contracts = setup.contracts;
    nodeIds = setup.nodeIds;
    node1Id = nodeIds.node1Id;
    node2Id = nodeIds.node2Id;
  });

  describe('Reward Amount Setting', function () {
    describe('Delegator Reward Amount Setting', function () {
      it('should successfully set delegator reward amount and emit event', async function () {
        const rewardAmount = toTRAC(5_000);

        await expect(
          contracts.migrator.setDelegatorRewardAmount(
            node1Id,
            accounts.delegator1.address,
            rewardAmount,
          ),
        )
          .to.emit(contracts.migrator, 'DelegatorRewardAmountSet')
          .withArgs(node1Id, accounts.delegator1.address, rewardAmount);

        // Verify the amount was stored correctly
        const storedAmount = await contracts.migrator.delegatorRewardAmount(
          node1Id,
          accounts.delegator1.address,
        );
        expect(storedAmount).to.equal(rewardAmount);
      });

      it('should allow updating delegator reward amount', async function () {
        const initialAmount = toTRAC(1_000);
        const updatedAmount = toTRAC(2_500);

        // Set initial amount
        await contracts.migrator.setDelegatorRewardAmount(
          node1Id,
          accounts.delegator1.address,
          initialAmount,
        );

        // Update to new amount
        await expect(
          contracts.migrator.setDelegatorRewardAmount(
            node1Id,
            accounts.delegator1.address,
            updatedAmount,
          ),
        )
          .to.emit(contracts.migrator, 'DelegatorRewardAmountSet')
          .withArgs(node1Id, accounts.delegator1.address, updatedAmount);

        // Verify the updated amount
        const storedAmount = await contracts.migrator.delegatorRewardAmount(
          node1Id,
          accounts.delegator1.address,
        );
        expect(storedAmount).to.equal(updatedAmount);
      });

      it('should reject zero delegator reward amounts', async function () {
        await expect(
          contracts.migrator.setDelegatorRewardAmount(
            node1Id,
            accounts.delegator1.address,
            0,
          ),
        ).to.be.revertedWith('No reward');
      });

      it('should reject setting rewards for non-existent profiles', async function () {
        const nonExistentNodeId = 99999n;

        await expect(
          contracts.migrator.setDelegatorRewardAmount(
            nonExistentNodeId,
            accounts.delegator1.address,
            toTRAC(1_000),
          ),
        ).to.be.revertedWithCustomError(
          contracts.migrator,
          'ProfileDoesntExist',
        );
      });
    });

    describe('Operator Reward Amount Setting', function () {
      it('should successfully set operator reward amount and emit event', async function () {
        const rewardAmount = toTRAC(3_000);

        await expect(
          contracts.migrator.setOperatorRewardAmount(node1Id, rewardAmount),
        )
          .to.emit(contracts.migrator, 'OperatorRewardAmountSet')
          .withArgs(node1Id, rewardAmount);

        // Verify the amount was stored correctly
        const storedAmount =
          await contracts.migrator.operatorRewardAmount(node1Id);
        expect(storedAmount).to.equal(rewardAmount);
      });

      it('should allow updating operator reward amount', async function () {
        const initialAmount = toTRAC(2_000);
        const updatedAmount = toTRAC(4_500);

        // Set initial amount
        await contracts.migrator.setOperatorRewardAmount(
          node1Id,
          initialAmount,
        );

        // Update to new amount
        await expect(
          contracts.migrator.setOperatorRewardAmount(node1Id, updatedAmount),
        )
          .to.emit(contracts.migrator, 'OperatorRewardAmountSet')
          .withArgs(node1Id, updatedAmount);

        // Verify the updated amount
        const storedAmount =
          await contracts.migrator.operatorRewardAmount(node1Id);
        expect(storedAmount).to.equal(updatedAmount);
      });

      it('should reject zero operator reward amounts', async function () {
        await expect(
          contracts.migrator.setOperatorRewardAmount(node1Id, 0),
        ).to.be.revertedWith('No reward');
      });

      it('should reject setting rewards for non-existent profiles', async function () {
        const nonExistentNodeId = 99999n;

        await expect(
          contracts.migrator.setOperatorRewardAmount(
            nonExistentNodeId,
            toTRAC(1_000),
          ),
        ).to.be.revertedWithCustomError(
          contracts.migrator,
          'ProfileDoesntExist',
        );
      });
    });

    describe('Access Control for Setters', function () {
      it('should only allow owner or multisig to set delegator rewards', async function () {
        // `_checkOwnerOrMultiSigOwner` in the V6 migrator reverts via
        // `HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner")`.
        // Pinning both the error name and its string arg catches regressions
        // where the gate is swapped for a different primitive (e.g. Ownable)
        // or opened to any caller.
        const rewardAmount = toTRAC(1_000);
        await expect(
          contracts.migrator
            .connect(accounts.delegator1)
            .setDelegatorRewardAmount(
              node1Id,
              accounts.delegator1.address,
              rewardAmount,
            ),
        )
          .to.be.revertedWithCustomError(
            contracts.migrator,
            'UnauthorizedAccess',
          )
          .withArgs('Only Hub Owner or Multisig Owner');

        // Owner-path success: assert state changed rather than only
        // .not.be.reverted, so a regression that silently no-ops still fails.
        await contracts.migrator.setDelegatorRewardAmount(
          node1Id,
          accounts.delegator1.address,
          rewardAmount,
        );
        expect(
          await contracts.migrator.delegatorRewardAmount(
            node1Id,
            accounts.delegator1.address,
          ),
        ).to.equal(rewardAmount);
      });

      it('should only allow owner or multisig to set operator rewards', async function () {
        const rewardAmount = toTRAC(1_000);
        await expect(
          contracts.migrator
            .connect(accounts.delegator1)
            .setOperatorRewardAmount(node1Id, rewardAmount),
        )
          .to.be.revertedWithCustomError(
            contracts.migrator,
            'UnauthorizedAccess',
          )
          .withArgs('Only Hub Owner or Multisig Owner');

        // Owner-path success: prove state updated via the public mapping
        // getter so silent no-op regressions surface.
        await contracts.migrator.setOperatorRewardAmount(node1Id, rewardAmount);
        expect(await contracts.migrator.operatorRewardAmount(node1Id)).to.equal(
          rewardAmount,
        );
      });
    });
  });

  describe('Delegator Reward Migration', function () {
    it('should successfully migrate delegator rewards while system is active', async function () {
      // Test migrator directly without initial stakes since it handles historical rewards
      const initialDelegatorStake =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator1.address]),
          ),
        );
      const initialNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const initialTotalStake = await contracts.stakingStorage.getTotalStake();

      // Set and migrate reward
      const rewardAmount = toTRAC(1_000);
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      // Verify state changes
      const finalDelegatorStake =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator1.address]),
          ),
        );
      const finalNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const finalTotalStake = await contracts.stakingStorage.getTotalStake();

      expect(finalDelegatorStake).to.equal(
        initialDelegatorStake + rewardAmount,
      );
      expect(finalNodeStake).to.equal(initialNodeStake + rewardAmount);
      expect(finalTotalStake).to.equal(initialTotalStake + rewardAmount);

      // Verify delegator is properly registered
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.true;

      // Verify claim flag is set
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.migrator.claimedDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.true;
    });

    it('should maintain system consistency during active RandomSampling', async function () {
      // Advance epoch to create activity
      await advanceEpochAndEnsureActivity(contracts);

      // Get current epoch scores before migration
      const currentEpoch = await contracts.chronos.getCurrentEpoch();
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );

      const initialScore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegatorKey,
        );

      // Migrate reward - use large enough amount to meet minimum stake
      const minimumStake = await contracts.parametersStorage.minimumStake();
      const rewardAmount = minimumStake + toTRAC(1_000); // Ensure above minimum
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      // Verify score tracking is maintained
      const finalScore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegatorKey,
        );

      // Score should be preserved (migration shouldn't affect current epoch scores)
      expect(finalScore).to.equal(initialScore);

      // Verify node is properly maintained in sharding table (should be true now with larger stake)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.shardingTableStorage.nodeExists(node1Id)).to.be
        .true;
    });

    it('should handle multiple delegator migrations correctly', async function () {
      const delegators = [
        accounts.delegator1,
        accounts.delegator2,
        accounts.delegator3,
      ];
      const rewardAmounts = [toTRAC(1_000), toTRAC(1_500), toTRAC(2_000)];

      const initialNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const totalRewards = rewardAmounts.reduce(
        (sum, amount) => sum + amount,
        0n,
      );

      // Set and migrate rewards for all delegators
      for (let i = 0; i < delegators.length; i++) {
        await contracts.migrator.setDelegatorRewardAmount(
          node1Id,
          delegators[i].address,
          rewardAmounts[i],
        );
        await contracts.migrator.migrateDelegatorReward(
          node1Id,
          delegators[i].address,
        );
      }

      // Verify total node stake increased by sum of all rewards
      const finalNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      expect(finalNodeStake).to.equal(initialNodeStake + totalRewards);

      // Verify each delegator's individual stakes
      for (let i = 0; i < delegators.length; i++) {
        const delegatorKey = ethers.keccak256(
          ethers.solidityPacked(['address'], [delegators[i].address]),
        );
        const expectedStake = rewardAmounts[i]; // No initial stake, just the migrated reward
        const actualStake =
          await contracts.stakingStorage.getDelegatorStakeBase(
            node1Id,
            delegatorKey,
          );
        expect(actualStake).to.equal(expectedStake);
      }
    });

    it('should reject double migration attempts', async function () {
      const rewardAmount = toTRAC(1_000);

      // Set reward amount and first migration should succeed
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      // Second migration should fail
      await expect(
        contracts.migrator.migrateDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.revertedWith('Already claimed delegator reward for this node');
    });

    it('should reject migration when no reward amount is set', async function () {
      await expect(
        contracts.migrator.migrateDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.revertedWith('No reward');
    });

    it('should reject migrations for non-existent profiles', async function () {
      const nonExistentNodeId = 99999n;

      await expect(
        contracts.migrator.setDelegatorRewardAmount(
          nonExistentNodeId,
          accounts.delegator1.address,
          toTRAC(1_000),
        ),
      ).to.be.revertedWithCustomError(contracts.migrator, 'ProfileDoesntExist');
    });

    it('should handle migration for new delegators (first-time delegation)', async function () {
      // Don't setup initial stakes - test migration for completely new delegator
      const newDelegator = accounts.delegator1;
      const rewardAmount = toTRAC(5_000);

      // Verify delegator is not initially registered
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          newDelegator.address,
        ),
      ).to.be.false;

      // Set and migrate reward for new delegator
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        newDelegator.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        newDelegator.address,
      );

      // Verify delegator is now registered
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          newDelegator.address,
        ),
      ).to.be.true;

      // Verify stake was correctly assigned
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [newDelegator.address]),
      );
      const finalStake = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
      expect(finalStake).to.equal(rewardAmount);
    });
  });

  describe('Operator Reward Migration', function () {
    it('should successfully migrate operator rewards', async function () {
      const initialOperatorBalance =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
      const rewardAmount = toTRAC(5_000);

      await contracts.migrator.setOperatorRewardAmount(node1Id, rewardAmount);
      await contracts.migrator.migrateOperatorReward(node1Id);

      const finalOperatorBalance =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
      expect(finalOperatorBalance).to.equal(
        initialOperatorBalance + rewardAmount,
      );

      // Verify claim flag is set
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.migrator.claimedOperatorReward(node1Id)).to.be
        .true;
    });

    it('should reject double operator reward migrations', async function () {
      const rewardAmount = toTRAC(5_000);

      // Set reward and first migration should succeed
      await contracts.migrator.setOperatorRewardAmount(node1Id, rewardAmount);
      await contracts.migrator.migrateOperatorReward(node1Id);

      // Second migration should fail
      await expect(
        contracts.migrator.migrateOperatorReward(node1Id),
      ).to.be.revertedWith('Already claimed operator reward for this node');
    });

    it('should reject migration when no reward amount is set', async function () {
      await expect(
        contracts.migrator.migrateOperatorReward(node1Id),
      ).to.be.revertedWith('No reward');
    });

    it('should reject operator migrations for non-existent profiles', async function () {
      const nonExistentNodeId = 99999n;

      await expect(
        contracts.migrator.setOperatorRewardAmount(
          nonExistentNodeId,
          toTRAC(1_000),
        ),
      ).to.be.revertedWithCustomError(contracts.migrator, 'ProfileDoesntExist');
    });
  });

  describe('Combined Migration Scenarios', function () {
    it('should handle mixed delegator and operator migrations correctly', async function () {
      const delegatorReward = toTRAC(2_000);
      const operatorReward = toTRAC(3_000);

      const initialNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const initialOperatorBalance =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

      // Set and migrate both types of rewards
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        delegatorReward,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );
      await contracts.migrator.setOperatorRewardAmount(node1Id, operatorReward);
      await contracts.migrator.migrateOperatorReward(node1Id);

      // Verify delegator reward increased node stake
      const finalNodeStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      expect(finalNodeStake).to.equal(initialNodeStake + delegatorReward);

      // Verify operator reward increased operator balance (but not node stake)
      const finalOperatorBalance =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
      expect(finalOperatorBalance).to.equal(
        initialOperatorBalance + operatorReward,
      );
    });

    it('should maintain system integrity during live migration', async function () {
      // Advance epoch and ensure activity
      await advanceEpochAndEnsureActivity(contracts);

      const initialSystemState = {
        totalStake: await contracts.stakingStorage.getTotalStake(),
        node1Stake: await contracts.stakingStorage.getNodeStake(node1Id),
        node2Stake: await contracts.stakingStorage.getNodeStake(node2Id),
        node1OperatorBalance:
          await contracts.stakingStorage.getOperatorFeeBalance(node1Id),
        node2OperatorBalance:
          await contracts.stakingStorage.getOperatorFeeBalance(node2Id),
      };

      // Use larger rewards to ensure nodes meet minimum stake requirements
      const minimumStake = await contracts.parametersStorage.minimumStake();
      const delegatorReward1 = minimumStake + toTRAC(1_500);
      const delegatorReward2 = minimumStake + toTRAC(2_500);
      const operatorReward1 = toTRAC(1_000);
      const operatorReward2 = toTRAC(1_200);

      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        delegatorReward1,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );
      await contracts.migrator.setDelegatorRewardAmount(
        node2Id,
        accounts.delegator2.address,
        delegatorReward2,
      );
      await contracts.migrator.migrateDelegatorReward(
        node2Id,
        accounts.delegator2.address,
      );
      await contracts.migrator.setOperatorRewardAmount(
        node1Id,
        operatorReward1,
      );
      await contracts.migrator.migrateOperatorReward(node1Id);
      await contracts.migrator.setOperatorRewardAmount(
        node2Id,
        operatorReward2,
      );
      await contracts.migrator.migrateOperatorReward(node2Id);

      // Verify system state consistency
      const finalSystemState = {
        totalStake: await contracts.stakingStorage.getTotalStake(),
        node1Stake: await contracts.stakingStorage.getNodeStake(node1Id),
        node2Stake: await contracts.stakingStorage.getNodeStake(node2Id),
        node1OperatorBalance:
          await contracts.stakingStorage.getOperatorFeeBalance(node1Id),
        node2OperatorBalance:
          await contracts.stakingStorage.getOperatorFeeBalance(node2Id),
      };

      expect(finalSystemState.totalStake).to.equal(
        initialSystemState.totalStake + delegatorReward1 + delegatorReward2,
      );
      expect(finalSystemState.node1Stake).to.equal(
        initialSystemState.node1Stake + delegatorReward1,
      );
      expect(finalSystemState.node2Stake).to.equal(
        initialSystemState.node2Stake + delegatorReward2,
      );
      expect(finalSystemState.node1OperatorBalance).to.equal(
        initialSystemState.node1OperatorBalance + operatorReward1,
      );
      expect(finalSystemState.node2OperatorBalance).to.equal(
        initialSystemState.node2OperatorBalance + operatorReward2,
      );

      // Verify both nodes are now in sharding table (with larger stakes above minimum)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.shardingTableStorage.nodeExists(node1Id)).to.be
        .true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.shardingTableStorage.nodeExists(node2Id)).to.be
        .true;
    });
  });

  describe('Reward accrual correctness with RandomSampling', function () {
    it('should accrue current epoch score only on post-migration score-per-stake delta', async function () {
      const epoch = await contracts.chronos.getCurrentEpoch();

      // Bootstrap: ensure node is in sharding table with existing stake (different delegator)
      const minimumStake = await contracts.parametersStorage.minimumStake();
      const bootstrapStake = minimumStake + toTRAC(2_000);
      await contracts.token
        .connect(accounts.delegator2)
        .approve(await contracts.staking.getAddress(), bootstrapStake);
      await contracts.staking
        .connect(accounts.delegator2)
        .stake(node1Id, bootstrapStake);

      // Set initial node score-per-stake for this epoch (pre-migration)
      const preMigrationSps36 = ethers.parseUnits('1', 18); // 1e18 (36-dec fixed scales against 1e18)
      await contracts.randomSamplingStorage
        .connect(accounts.owner)
        .addToNodeEpochScorePerStake(epoch, node1Id, preMigrationSps36);

      // Verify delegator has zero score before migration
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      const scoreBefore =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          epoch,
          node1Id,
          delegatorKey,
        );
      expect(scoreBefore).to.equal(0n);

      // Set and migrate delegator reward (creates stake base and settles to current SPS index)
      const migratedStake = toTRAC(3_000);
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        migratedStake,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      // Increase node score-per-stake after migration
      const postMigrationDeltaSps36 = ethers.parseUnits('0.5', 18); // 0.5e18 delta
      await contracts.randomSamplingStorage
        .connect(accounts.owner)
        .addToNodeEpochScorePerStake(epoch, node1Id, postMigrationDeltaSps36);

      // Settle delegator to materialize post-migration SPS delta into epoch score
      await contracts.staking
        .connect(accounts.owner)
        .prepareForStakeChange(epoch, node1Id, delegatorKey);

      // Expected delegator epoch score = migratedStake * deltaSps / 1e18
      const expectedScore =
        (migratedStake * postMigrationDeltaSps36) / ethers.parseUnits('1', 18);

      const scoreAfter =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          epoch,
          node1Id,
          delegatorKey,
        );
      expect(scoreAfter).to.equal(expectedScore);
    });
  });

  describe('Migration without Access Control', function () {
    it('should allow anyone to migrate rewards once amounts are set', async function () {
      // Set rewards as owner
      await contracts.migrator.setDelegatorRewardAmount(
        node2Id,
        accounts.delegator1.address,
        toTRAC(1_000),
      );
      await contracts.migrator.setOperatorRewardAmount(node2Id, toTRAC(1_000));

      // Anyone should be able to call migration functions
      await expect(
        contracts.migrator
          .connect(accounts.delegator1)
          .migrateDelegatorReward(node2Id, accounts.delegator1.address),
      ).to.not.be.reverted;

      await expect(
        contracts.migrator
          .connect(accounts.delegator2)
          .migrateOperatorReward(node2Id),
      ).to.not.be.reverted;
    });
  });

  describe('Edge Cases and Error Conditions', function () {
    it('should handle migration when node has no existing delegators', async function () {
      // Don't setup any initial stakes
      const newDelegator = accounts.delegator1;
      const rewardAmount = toTRAC(10_000);

      // Verify node has no delegators initially
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          newDelegator.address,
        ),
      ).to.be.false;

      // Set and migrate - should succeed and register the delegator
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        newDelegator.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        newDelegator.address,
      );

      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          newDelegator.address,
        ),
      ).to.be.true;

      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [newDelegator.address]),
      );
      const finalStake = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
      expect(finalStake).to.equal(rewardAmount);
    });

    it('should handle migration that brings node above minimum stake threshold', async function () {
      // Ensure node starts below minimum stake
      const minimumStake = await contracts.parametersStorage.minimumStake();
      const nodeStake = await contracts.stakingStorage.getNodeStake(node2Id);

      if (nodeStake >= minimumStake) {
        // Reset node stake for this test
        await contracts.stakingStorage.setNodeStake(node2Id, 0);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        expect(await contracts.shardingTableStorage.nodeExists(node2Id)).to.be
          .false;
      }

      // Set and migrate enough to bring above minimum
      const rewardAmount = minimumStake + toTRAC(1_000);
      await contracts.migrator.setDelegatorRewardAmount(
        node2Id,
        accounts.delegator1.address,
        rewardAmount,
      );
      await contracts.migrator.migrateDelegatorReward(
        node2Id,
        accounts.delegator1.address,
      );

      // Verify node is now in sharding table
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.shardingTableStorage.nodeExists(node2Id)).to.be
        .true;
    });

    it('should allow migration that exceeds maximum stake (no validation in original contract)', async function () {
      // This should succeed since the original contract doesn't validate maximum stake
      const largeReward = toTRAC(1_000_000); // Very large amount

      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        largeReward,
      );
      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      // Verify the migration succeeded
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.migrator.claimedDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.true;

      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      const finalStake = await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
      expect(finalStake).to.equal(largeReward);
    });
  });

  describe('Interactive Demo: VA Tuning Period Rewards Migration', function () {
    it('should demonstrate complete migration flow with interactive pauses', async function () {
      console.log('\n🎬 ===========================================');
      console.log('🎬 VA TUNING PERIOD REWARDS MIGRATION DEMO');
      console.log('🎬 ===========================================\n');

      // // Helper function for interactive pauses
      // const waitForInput = async (message: string) => {
      //   // console.log(`\n⏸️  ${message}`);
      //   // console.log('   Press Enter to continue...');
      //   // In a real demo, you'd use readline or similar
      //   // For now, we'll simulate with a small delay
      //   await new Promise((resolve) => {
      //     const rl = readline.createInterface({
      //       input: process.stdin,
      //       output: process.stdout,
      //     });
      //     rl.question(
      //       `\n⏸️  ${message}\n   Press Enter to continue...`,
      //       (answer) => {
      //         rl.close();
      //         resolve(answer);
      //       },
      //     );
      //   });
      //   console.log('\n' + '-'.repeat(100) + '\n');
      // };

      // Color codes for better visibility
      const colors = {
        reset: '\x1b[0m',
        bright: '\x1b[1m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        bgRed: '\x1b[41m',
        bgGreen: '\x1b[42m',
        bgYellow: '\x1b[43m',
        bgBlue: '\x1b[44m',
      };

      // Helper function to display state
      const displayState = async (
        title: string,
        contracts: TestContracts,
        accounts: TestAccounts,
        node1Id: bigint,
      ) => {
        console.log(
          `\n${colors.cyan}${colors.bright}📊 ${title}${colors.reset}`,
        );
        console.log(
          '   ┌─────────────────────────────────────────────────────────┐',
        );

        // Stake information
        const node1Stake = await contracts.stakingStorage.getNodeStake(node1Id);
        const delegator1Key = ethers.keccak256(
          ethers.solidityPacked(['address'], [accounts.delegator1.address]),
        );
        const delegator1Stake =
          await contracts.stakingStorage.getDelegatorStakeBase(
            node1Id,
            delegator1Key,
          );
        const delegator2Key = ethers.keccak256(
          ethers.solidityPacked(['address'], [accounts.delegator2.address]),
        );
        const delegator2Stake =
          await contracts.stakingStorage.getDelegatorStakeBase(
            node1Id,
            delegator2Key,
          );

        console.log(
          `   │ Node1 Total Stake: ${ethers.formatEther(node1Stake)} TRAC`,
        );
        console.log(
          `   │ Delegator1 Stake: ${ethers.formatEther(delegator1Stake)} TRAC`,
        );
        console.log(
          `   │ Delegator2 Stake: ${ethers.formatEther(delegator2Stake)} TRAC`,
        );

        // Delegator status
        const isDelegator1 = await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator1.address,
        );
        const isDelegator2 = await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator2.address,
        );

        console.log(
          `   │ Delegator1 Registered: ${isDelegator1 ? '✅ YES' : '❌ NO'}`,
        );
        console.log(
          `   │ Delegator2 Registered: ${isDelegator2 ? '✅ YES' : '❌ NO'}`,
        );

        // Operator balance
        const operatorBalance =
          await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
        console.log(
          `   │ Operator Balance: ${ethers.formatEther(operatorBalance)} TRAC`,
        );

        console.log(
          '   └─────────────────────────────────────────────────────────┘',
        );
      };

      // Phase 1: Setup & Initial State
      console.log('🚀 PHASE 1: Initial System State');
      console.log(
        '   Setting up the staking system with nodes and delegators...\n',
      );

      // First, let's create a realistic scenario where delegators were already staking
      console.log(
        '📝 Setting up realistic scenario: Delegators were already staking during tuning period',
      );

      // Delegator1 stakes some tokens
      const initialStake1 = toTRAC(10_000);
      await contracts.token
        .connect(accounts.delegator1)
        .approve(await contracts.staking.getAddress(), initialStake1);
      await contracts.staking
        .connect(accounts.delegator1)
        .stake(node1Id, initialStake1);

      // Delegator2 stakes some tokens
      const initialStake2 = toTRAC(8_000);
      await contracts.token
        .connect(accounts.delegator2)
        .approve(await contracts.staking.getAddress(), initialStake2);
      await contracts.staking
        .connect(accounts.delegator2)
        .stake(node1Id, initialStake2);

      console.log(
        `   ✅ Delegator1 staked: ${ethers.formatEther(initialStake1)} TRAC`,
      );
      console.log(
        `   ✅ Delegator2 staked: ${ethers.formatEther(initialStake2)} TRAC`,
      );

      await displayState(
        'STATE AFTER INITIAL STAKING',
        contracts,
        accounts,
        node1Id,
      );

      // await waitForInput(
      //   'Initial staking complete - now explaining the V6 tuning period rewards',
      // );

      // Phase 2: Explain V6 Tuning Period Rewards
      console.log(
        `\n${colors.blue}${colors.bright}📚 UNDERSTANDING V6 TUNING PERIOD REWARDS${colors.reset}`,
      );
      console.log(
        '   Some V6 rewards were not distributed when we moved to the V8 system.',
      );
      console.log('   The simulation we created calculated those rewards.');
      console.log(
        '   The MigratorV6TuningPeriodRewards contract fixes the V6 rewards part by distributing',
      );
      console.log('   the backlogged rewards retroactively.\n');

      // Phase 3: Explain the Problem
      console.log(
        `\n${colors.red}${colors.bright}⚠️  THE PROBLEM: V6 Tuning Period Rewards Not Distributed${colors.reset}`,
      );
      console.log(
        '   Some V6 rewards were not distributed when we moved to the V8 system.',
      );
      console.log(
        '   The migrator contract allows us to retroactively distribute these earned rewards.\n',
      );

      // await waitForInput(
      //   'Problem explained - now setting up active node scenario',
      // );

      // Phase 4: Score Update Scenario (Critical for Active Nodes) - BEFORE migration
      console.log(
        `\n${colors.yellow}${colors.bright}🎯 PHASE 2: Active Node with Proofs${colors.reset}`,
      );
      console.log(
        '   Demonstrating how the migrator handles score updates for active nodes...\n',
      );

      console.log(
        '📝 Setting up scenario: Node is actively submitting proofs and has accumulated scores',
      );

      // Advance epoch to create activity and scores
      const epochLength = await contracts.chronos.epochLength();
      await time.increase(Number(epochLength));
      await contracts.randomSampling.updateAndGetActiveProofPeriodStartBlock();

      const currentEpoch = await contracts.chronos.getCurrentEpoch();
      console.log(
        `   ${colors.cyan}✅ Advanced to epoch: ${currentEpoch}${colors.reset}`,
      );

      // Simulate node submitting proofs and accumulating scores
      const proofScore = ethers.parseUnits('0.001', 18); // 0.001e18 score-per-stake (much smaller, more realistic)
      await contracts.randomSamplingStorage
        .connect(accounts.owner)
        .addToNodeEpochScorePerStake(currentEpoch, node1Id, proofScore);

      console.log(
        `   📊 Node submitted proofs, accumulated score-per-stake: ${ethers.formatEther(proofScore)}`,
      );

      // Calculate and display node total score
      const nodeTotalStake =
        await contracts.stakingStorage.getNodeStake(node1Id);
      const nodeTotalScore =
        (nodeTotalStake * proofScore) / ethers.parseUnits('1', 18);
      console.log(
        `   📈 Node total score: ${ethers.formatEther(nodeTotalScore)} (${ethers.formatEther(nodeTotalStake)} stake × ${ethers.formatEther(proofScore)} score-per-stake)`,
      );

      // Check initial delegator scores before migration
      const delegator1Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator1.address]),
      );
      const delegator2Key = ethers.keccak256(
        ethers.solidityPacked(['address'], [accounts.delegator2.address]),
      );

      const initialDelegator1Score =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegator1Key,
        );
      const initialDelegator2Score =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegator2Key,
        );

      console.log(
        `   📊 Initial Delegator1 score: ${ethers.formatEther(initialDelegator1Score)}`,
      );
      console.log(
        `   📊 Initial Delegator2 score: ${ethers.formatEther(initialDelegator2Score)}`,
      );
      console.log(
        `   💡 Note: Scores are calculated as: delegator_stake × node_score_per_stake`,
      );

      // await waitForInput(
      //   'Node has active proofs and scores - now configuring rewards',
      // );

      // Phase 5: Reward Configuration
      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.magenta}${colors.bright}💰 PHASE 3: Configuring V6 Tuning Period Rewards${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log(
        '   Setting up the rewards that should have been distributed during the V6 tuning period...\n',
      );

      const delegator1Reward = toTRAC(5_000);
      const delegator2Reward = toTRAC(3_000);
      const operatorReward = toTRAC(2_000);

      console.log(
        `   💸 Setting Delegator1 V6 tuning reward: ${ethers.formatEther(delegator1Reward)} TRAC`,
      );
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator1.address,
        delegator1Reward,
      );

      console.log(
        `   💸 Setting Delegator2 V6 tuning reward: ${ethers.formatEther(delegator2Reward)} TRAC`,
      );
      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator2.address,
        delegator2Reward,
      );

      console.log(
        `   💸 Setting Operator V6 tuning reward: ${ethers.formatEther(operatorReward)} TRAC`,
      );
      await contracts.migrator.setOperatorRewardAmount(node1Id, operatorReward);

      // await waitForInput(
      //   'V6 tuning period rewards configured - ready to start migration',
      // );

      // Phase 6: Migration Execution
      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.blue}${colors.bright}🔄 PHASE 4: Executing V6 Tuning Period Reward Migrations${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log(
        '   Migrating the earned but undistributed V6 tuning rewards to actual stakes and balances...',
      );
      console.log(
        '   Note: This will also update delegator scores via prepareForStakeChange()...\n',
      );

      // Step 1: Migrate Delegator1
      console.log(
        `${colors.green}${colors.bright}👤 STEP 1: Migrating Delegator1 V6 Tuning Rewards${colors.reset}`,
      );
      console.log('   ' + '-'.repeat(60));
      console.log(`   💰 Amount: ${ethers.formatEther(delegator1Reward)} TRAC`);

      const beforeDelegator1 =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator1.address]),
          ),
        );
      const beforeNode1 = await contracts.stakingStorage.getNodeStake(node1Id);

      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );

      const afterDelegator1 =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator1.address]),
          ),
        );
      const afterNode1 = await contracts.stakingStorage.getNodeStake(node1Id);

      console.log(
        `   📈 Delegator1 stake: ${ethers.formatEther(beforeDelegator1)} → ${ethers.formatEther(afterDelegator1)} TRAC`,
      );
      console.log(
        `   📈 Node1 total stake: ${ethers.formatEther(beforeNode1)} → ${ethers.formatEther(afterNode1)} TRAC`,
      );

      // Check Delegator1 score immediately after migration
      const afterDelegator1Score =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegator1Key,
        );
      console.log(
        `   📊 Delegator1 score: ${ethers.formatEther(initialDelegator1Score)} → ${ethers.formatEther(afterDelegator1Score)}`,
      );

      // await waitForInput(
      //   'Delegator1 V6 tuning rewards migrated - ready for Delegator2',
      // );

      // Step 2: Migrate Delegator2
      console.log(
        `\n${colors.green}${colors.bright}👤 STEP 2: Migrating Delegator2 V6 Tuning Rewards${colors.reset}`,
      );
      console.log('   ' + '-'.repeat(60));
      console.log(`   💰 Amount: ${ethers.formatEther(delegator2Reward)} TRAC`);

      const beforeDelegator2 =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator2.address]),
          ),
        );

      await contracts.migrator.migrateDelegatorReward(
        node1Id,
        accounts.delegator2.address,
      );

      const afterDelegator2 =
        await contracts.stakingStorage.getDelegatorStakeBase(
          node1Id,
          ethers.keccak256(
            ethers.solidityPacked(['address'], [accounts.delegator2.address]),
          ),
        );
      const finalNode1 = await contracts.stakingStorage.getNodeStake(node1Id);

      console.log(
        `   📈 Delegator2 stake: ${ethers.formatEther(beforeDelegator2)} → ${ethers.formatEther(afterDelegator2)} TRAC`,
      );
      console.log(
        `   📈 Node1 total stake: ${ethers.formatEther(afterNode1)} → ${ethers.formatEther(finalNode1)} TRAC`,
      );

      // Check Delegator2 score immediately after migration
      const afterDelegator2Score =
        await contracts.randomSamplingStorage.getEpochNodeDelegatorScore(
          currentEpoch,
          node1Id,
          delegator2Key,
        );
      console.log(
        `   ${colors.cyan}📊 Delegator2 score: ${ethers.formatEther(initialDelegator2Score)} → ${ethers.formatEther(afterDelegator2Score)}${colors.reset}`,
      );

      // await waitForInput(
      //   'Delegator2 V6 tuning rewards migrated - ready for operator migration',
      // );

      // Step 3: Migrate Operator Rewards
      console.log(
        `\n${colors.magenta}${colors.bright}👨‍💼 STEP 3: Migrating Operator V6 Tuning Rewards${colors.reset}`,
      );
      console.log('   ' + '-'.repeat(60));
      console.log(`   💰 Amount: ${ethers.formatEther(operatorReward)} TRAC`);

      const beforeOperator =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

      await contracts.migrator.migrateOperatorReward(node1Id);

      const afterOperator =
        await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

      console.log(
        `   📈 Operator balance: ${ethers.formatEther(beforeOperator)} → ${ethers.formatEther(afterOperator)} TRAC`,
      );
      console.log(
        `   💡 Note: Operator rewards don't affect node stake, only operator balance`,
      );

      // await waitForInput(
      //   'Operator V6 tuning rewards migrated - checking final state',
      // );

      // Phase 7: Final State Verification
      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.green}${colors.bright}✅ PHASE 5: Final State Verification${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log(
        '   Verifying all V6 tuning period rewards were successfully distributed...\n',
      );

      await displayState(
        'FINAL STATE AFTER V6 TUNING PERIOD REWARD MIGRATION',
        contracts,
        accounts,
        node1Id,
      );

      // Verify claim flags
      const delegator1Claimed = await contracts.migrator.claimedDelegatorReward(
        node1Id,
        accounts.delegator1.address,
      );
      const delegator2Claimed = await contracts.migrator.claimedDelegatorReward(
        node1Id,
        accounts.delegator2.address,
      );
      const operatorClaimed =
        await contracts.migrator.claimedOperatorReward(node1Id);

      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.cyan}${colors.bright}🏁 V6 TUNING PERIOD REWARD MIGRATION STATUS${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log(
        `   ✅ Delegator1 V6 tuning rewards claimed: ${delegator1Claimed ? 'YES' : 'NO'}`,
      );
      console.log(
        `   ✅ Delegator2 V6 tuning rewards claimed: ${delegator2Claimed ? 'YES' : 'NO'}`,
      );
      console.log(
        `   ✅ Operator V6 tuning rewards claimed: ${operatorClaimed ? 'YES' : 'NO'}`,
      );

      // await waitForInput('Final state verified - testing security features');

      // Phase 8: Security Validation
      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.red}${colors.bright}🔒 PHASE 6: Security Validation${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log(
        '   Testing double migration prevention and access control...\n',
      );

      // Test double migration prevention
      console.log(
        `${colors.red}🚫 Testing Double Migration Prevention${colors.reset}`,
      );
      console.log('   ' + '-'.repeat(60));
      console.log(
        '   Attempting to migrate Delegator1 V6 tuning rewards again...',
      );

      await expect(
        contracts.migrator.migrateDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.revertedWith('Already claimed delegator reward for this node');

      console.log(`   ✅ Double migration correctly prevented`);

      // Test access control
      console.log(`\n${colors.red}🔐 Testing Access Control${colors.reset}`);
      console.log('   ' + '-'.repeat(60));
      console.log('   Attempting to set V6 tuning rewards as non-admin...');

      await expect(
        contracts.migrator
          .connect(accounts.delegator1)
          .setDelegatorRewardAmount(
            node1Id,
            accounts.delegator3.address,
            toTRAC(1_000),
          ),
      )
        .to.be.revertedWithCustomError(
          contracts.migrator,
          'UnauthorizedAccess',
        )
        .withArgs('Only Hub Owner or Multisig Owner');

      console.log(`   ✅ Only system admin can set V6 tuning rewards`);

      // Test that anyone can execute migrations once set
      console.log(
        `\n${colors.green}✅ Testing Migration Execution by Anyone${colors.reset}`,
      );
      console.log('   ' + '-'.repeat(60));
      console.log('   Setting up a new V6 tuning reward for Delegator3...');

      await contracts.migrator.setDelegatorRewardAmount(
        node1Id,
        accounts.delegator3.address,
        toTRAC(1_000),
      );

      console.log('   Executing migration as Delegator3...');
      await contracts.migrator
        .connect(accounts.delegator3)
        .migrateDelegatorReward(node1Id, accounts.delegator3.address);

      console.log(
        `   ✅ Anyone can execute migrations once V6 tuning rewards are set`,
      );

      // await waitForInput('Security validation complete - demo finished');

      // Final summary
      console.log('\n' + '='.repeat(80));
      console.log(
        `${colors.green}${colors.bright}🎉 V6 TUNING PERIOD REWARDS MIGRATION DEMO COMPLETE!${colors.reset}`,
      );
      console.log('='.repeat(80));
      console.log('   Summary of what was accomplished:');
      console.log(
        '   • Set up realistic scenario with existing delegators and stakes',
      );
      console.log('   • Explained the V6 tuning period context');
      console.log('   • Demonstrated active node with proofs and scores');
      console.log(
        '   • Configured V6 tuning period rewards that were never distributed',
      );
      console.log(
        '   • Successfully migrated all V6 tuning rewards to actual stakes/balances',
      );
      console.log('   • Verified score updates via prepareForStakeChange()');
      console.log('   • Verified delegator registration and claim flags');
      console.log('   • Confirmed security features work correctly');
      console.log(
        '   • Demonstrated that anyone can execute migrations once set',
      );
      console.log(
        `\n✨ The MigratorV6TuningPeriodRewards contract successfully distributed`,
      );
      console.log(
        'the backlogged rewards from the V6 tuning period while maintaining',
      );
      console.log('proper score tracking for active nodes!');
      console.log('='.repeat(80));

      // Verify final expectations
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.migrator.claimedDelegatorReward(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.migrator.claimedDelegatorReward(
          node1Id,
          accounts.delegator2.address,
        ),
      ).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(await contracts.migrator.claimedOperatorReward(node1Id)).to.be
        .true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator1.address,
        ),
      ).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator2.address,
        ),
      ).to.be.true;
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      expect(
        await contracts.delegatorsInfo.isNodeDelegator(
          node1Id,
          accounts.delegator3.address,
        ),
      ).to.be.true;

      // Verify that scores were properly updated
      expect(afterDelegator1Score).to.be.gt(initialDelegator1Score);
      expect(afterDelegator2Score).to.be.gt(initialDelegator2Score);
    });
  });
});
