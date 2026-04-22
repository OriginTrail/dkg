import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { expect } from 'chai';
import hre, { ethers } from 'hardhat';

import {
  DelegatorsInfo,
  Hub,
  MigratorV6TuningPeriodRewards,
  Profile,
  StakingStorage,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

const toTRAC = (x: string | number) => ethers.parseUnits(x.toString(), 18);

type MigratorV6Epochs9to12RewardsLike = MigratorV6TuningPeriodRewards & {
  START_EPOCH(): Promise<bigint>;
  END_EPOCH(): Promise<bigint>;
};

type TestContracts = {
  hub: Hub;
  profile: Profile;
  stakingStorage: StakingStorage;
  delegatorsInfo: DelegatorsInfo;
  migrator: MigratorV6Epochs9to12RewardsLike;
};

type TestAccounts = {
  owner: SignerWithAddress;
  node1: { operational: SignerWithAddress; admin: SignerWithAddress };
  delegator1: SignerWithAddress;
  delegator2: SignerWithAddress;
};

async function setupTestEnvironment(): Promise<{
  accounts: TestAccounts;
  contracts: TestContracts;
  node1Id: bigint;
}> {
  hre.helpers.resetDeploymentsJson();
  await hre.deployments.fixture([
    'MigratorV6Epochs9to12Rewards',
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
    delegator1: signers[3],
    delegator2: signers[4],
  };

  const contracts: TestContracts = {
    hub: await hre.ethers.getContract<Hub>('Hub'),
    profile: await hre.ethers.getContract<Profile>('Profile'),
    stakingStorage:
      await hre.ethers.getContract<StakingStorage>('StakingStorage'),
    delegatorsInfo:
      await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo'),
    migrator: (await hre.ethers.getContract(
      'MigratorV6Epochs9to12Rewards',
    )) as unknown as MigratorV6Epochs9to12RewardsLike,
  };

  await contracts.hub.setContractAddress('HubOwner', accounts.owner.address);

  const node1Profile = await createProfile(contracts.profile, accounts.node1);

  return {
    accounts,
    contracts,
    node1Id: BigInt(node1Profile.identityId),
  };
}

describe('MigratorV6Epochs9to12Rewards Integration Tests', function () {
  let accounts: TestAccounts;
  let contracts: TestContracts;
  let node1Id: bigint;

  beforeEach(async function () {
    const setup = await setupTestEnvironment();
    accounts = setup.accounts;
    contracts = setup.contracts;
    node1Id = setup.node1Id;
  });

  it('exposes expected contract metadata and epoch range', async function () {
    expect(await contracts.migrator.name()).to.equal(
      'MigratorV6Epochs9to12Rewards',
    );
    expect(await contracts.migrator.version()).to.equal('1.0.0');
    expect(await contracts.migrator.START_EPOCH()).to.equal(9n);
    expect(await contracts.migrator.END_EPOCH()).to.equal(12n);
  });

  it('migrates delegator reward into stake balances', async function () {
    const rewardAmount = toTRAC(1_000);
    const delegator = accounts.delegator1.address;
    const delegatorKey = ethers.keccak256(
      ethers.solidityPacked(['address'], [delegator]),
    );

    const initialDelegatorStake =
      await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
    const initialNodeStake =
      await contracts.stakingStorage.getNodeStake(node1Id);
    const initialTotalStake = await contracts.stakingStorage.getTotalStake();

    await contracts.migrator.setDelegatorRewardAmount(
      node1Id,
      delegator,
      rewardAmount,
    );
    await contracts.migrator.migrateDelegatorReward(node1Id, delegator);

    const finalDelegatorStake =
      await contracts.stakingStorage.getDelegatorStakeBase(
        node1Id,
        delegatorKey,
      );
    const finalNodeStake = await contracts.stakingStorage.getNodeStake(node1Id);
    const finalTotalStake = await contracts.stakingStorage.getTotalStake();

    expect(finalDelegatorStake).to.equal(initialDelegatorStake + rewardAmount);
    expect(finalNodeStake).to.equal(initialNodeStake + rewardAmount);
    expect(finalTotalStake).to.equal(initialTotalStake + rewardAmount);
    expect(
      await contracts.migrator.claimedDelegatorReward(node1Id, delegator),
    ).to.equal(true);
    expect(
      await contracts.delegatorsInfo.isNodeDelegator(node1Id, delegator),
    ).to.equal(true);
  });

  it('rejects double delegator migration', async function () {
    const rewardAmount = toTRAC(1_000);
    const delegator = accounts.delegator1.address;

    await contracts.migrator.setDelegatorRewardAmount(
      node1Id,
      delegator,
      rewardAmount,
    );
    await contracts.migrator.migrateDelegatorReward(node1Id, delegator);

    await expect(
      contracts.migrator.migrateDelegatorReward(node1Id, delegator),
    ).to.be.revertedWith('Already claimed delegator reward for this node');
  });

  it('migrates operator reward into operator fee balance', async function () {
    const rewardAmount = toTRAC(2_000);
    const initialOperatorBalance =
      await contracts.stakingStorage.getOperatorFeeBalance(node1Id);

    await contracts.migrator.setOperatorRewardAmount(node1Id, rewardAmount);
    await contracts.migrator.migrateOperatorReward(node1Id);

    const finalOperatorBalance =
      await contracts.stakingStorage.getOperatorFeeBalance(node1Id);
    expect(finalOperatorBalance).to.equal(
      initialOperatorBalance + rewardAmount,
    );
    expect(await contracts.migrator.claimedOperatorReward(node1Id)).to.equal(
      true,
    );
  });

  it('allows only owner/multisig owner to set reward amounts', async function () {
    // V6-epochs9..12 migrator gate is the same as the other migrators:
    // `HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner")`.
    // Pin the custom error + arg to catch regressions that weaken the ACL.
    await expect(
      contracts.migrator
        .connect(accounts.delegator2)
        .setDelegatorRewardAmount(
          node1Id,
          accounts.delegator1.address,
          toTRAC(1_000),
        ),
    )
      .to.be.revertedWithCustomError(
        contracts.migrator,
        'UnauthorizedAccess',
      )
      .withArgs('Only Hub Owner or Multisig Owner');

    await expect(
      contracts.migrator
        .connect(accounts.delegator2)
        .setOperatorRewardAmount(node1Id, toTRAC(1_000)),
    )
      .to.be.revertedWithCustomError(
        contracts.migrator,
        'UnauthorizedAccess',
      )
      .withArgs('Only Hub Owner or Multisig Owner');
  });
});
