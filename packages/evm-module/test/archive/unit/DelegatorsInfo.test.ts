import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre, { ethers } from 'hardhat';

import {
  Token,
  Profile,
  StakingStorage,
  ParametersStorage,
  ProfileStorage,
  ShardingTable,
  ShardingTableStorage,
  AskStorage,
  Hub,
  Staking,
  DelegatorsInfo,
} from '../../typechain';

type StakingFixture = {
  accounts: SignerWithAddress[];
  Token: Token;
  Profile: Profile;
  Staking: Staking;
  StakingStorage: StakingStorage;
  ShardingTableStorage: ShardingTableStorage;
  ShardingTable: ShardingTable;
  ParametersStorage: ParametersStorage;
  ProfileStorage: ProfileStorage;
  AskStorage: AskStorage;
  Hub: Hub;
  DelegatorsInfo: DelegatorsInfo;
};

async function deployStakingFixture(): Promise<StakingFixture> {
  await hre.deployments.fixture(['Profile', 'Staking', 'EpochStorage']);
  const Staking = await hre.ethers.getContract<Staking>('Staking');
  const Profile = await hre.ethers.getContract<Profile>('Profile');
  const Token = await hre.ethers.getContract<Token>('Token');
  const StakingStorage =
    await hre.ethers.getContract<StakingStorage>('StakingStorage');
  const ShardingTableStorage =
    await hre.ethers.getContract<ShardingTableStorage>('ShardingTableStorage');
  const ShardingTable =
    await hre.ethers.getContract<ShardingTable>('ShardingTable');
  const ParametersStorage =
    await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
  const ProfileStorage =
    await hre.ethers.getContract<ProfileStorage>('ProfileStorage');
  const AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const DelegatorsInfo =
    await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo');
  const accounts = await hre.ethers.getSigners();

  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Token,
    Profile,
    Staking,
    StakingStorage,
    ShardingTableStorage,
    ShardingTable,
    ParametersStorage,
    ProfileStorage,
    AskStorage,
    Hub,
    DelegatorsInfo,
  };
}

describe('DelegatorsInfo contract', function () {
  let accounts: SignerWithAddress[];
  let Profile: Profile;
  let DelegatorsInfo: DelegatorsInfo;
  let stakingSigner: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const createProfile = async (
    admin?: SignerWithAddress,
    operational?: SignerWithAddress,
    initialOperatorFee?: bigint,
  ) => {
    const node = '0x' + randomBytes(32).toString('hex');
    const tx = await Profile.connect(operational ?? accounts[1]).createProfile(
      admin ? admin.address : accounts[0],
      [],
      `Node ${Math.floor(Math.random() * 1000)}`,
      node,
      (initialOperatorFee ?? 0n) * 100n,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt?.logs[0].topics[1]);
    return { nodeId: node, identityId };
  };

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Profile, DelegatorsInfo } =
      await loadFixture(deployStakingFixture));

    // Create a signer from the Staking contract address
    const stakingContract = await hre.ethers.getContract<Staking>('Staking');
    const stakingAddress = stakingContract.target.toString();
    stakingSigner = await hre.ethers.getImpersonatedSigner(stakingAddress);

    // Fund the Staking contract address with some ETH for gas
    await hre.network.provider.send('hardhat_setBalance', [
      stakingAddress,
      '0x' + hre.ethers.parseEther('1.0').toString(16),
    ]);
  });

  it('Should have correct name and version', async () => {
    expect(await DelegatorsInfo.name()).to.equal('DelegatorsInfo');
    expect(await DelegatorsInfo.version()).to.equal('1.0.0');
  });

  it('Should add delegator', async () => {
    const { identityId } = await createProfile();
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    const isDelegator = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[1].address,
    );
    expect(isDelegator).to.equal(true);
  });

  it('Should remove delegator', async () => {
    const { identityId } = await createProfile();
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.removeDelegator(identityId, accounts[1].address);
    const isDelegator = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[1].address,
    );
    expect(isDelegator).to.equal(false);
    const nodeDelegators = await DelegatorsInfo.getDelegators(identityId);
    expect(nodeDelegators.length).to.equal(0);
  });
  it('Should remove delegator from end of array', async () => {
    const { identityId } = await createProfile();
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[2].address);
    await DelegatorsInfo.removeDelegator(identityId, accounts[2].address);
    const isDelegator = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[2].address,
    );
    expect(isDelegator).to.equal(false);
    const nodeDelegators = await DelegatorsInfo.getDelegators(identityId);
    expect(nodeDelegators.length).to.equal(1);
    expect(nodeDelegators[0]).to.equal(accounts[1].address);
    const removedDelegatorIndex = await DelegatorsInfo.getDelegatorIndex(
      identityId,
      accounts[2].address,
    );
    expect(removedDelegatorIndex).to.equal(0);
    const keptDelegatorIndex = await DelegatorsInfo.getDelegatorIndex(
      identityId,
      accounts[1].address,
    );
    expect(keptDelegatorIndex).to.equal(0);
  });
  it('Should remove delegator from middle of array', async () => {
    const { identityId } = await createProfile();
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[2].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[3].address);

    const isDelegator1 = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[1].address,
    );
    expect(isDelegator1).to.equal(true);
    const isDelegator2 = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[2].address,
    );
    expect(isDelegator2).to.equal(true);
    const isDelegator3 = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[3].address,
    );
    expect(isDelegator3).to.equal(true);
    await DelegatorsInfo.removeDelegator(identityId, accounts[2].address);

    const isDelegator = await DelegatorsInfo.isNodeDelegator(
      identityId,
      accounts[2].address,
    );
    expect(isDelegator).to.equal(false);
    const nodeDelegators = await DelegatorsInfo.getDelegators(identityId);
    expect(nodeDelegators.length).to.equal(2);
    expect(nodeDelegators[0]).to.equal(accounts[1].address);
    expect(nodeDelegators[1]).to.equal(accounts[3].address);
    const removedDelegatorIndex = await DelegatorsInfo.getDelegatorIndex(
      identityId,
      accounts[2].address,
    );
    expect(removedDelegatorIndex).to.equal(0);
    const keptDelegatorIndex1 = await DelegatorsInfo.getDelegatorIndex(
      identityId,
      accounts[1].address,
    );
    expect(keptDelegatorIndex1).to.equal(0);
    const keptDelegatorIndex3 = await DelegatorsInfo.getDelegatorIndex(
      identityId,
      accounts[3].address,
    );
    expect(keptDelegatorIndex3).to.equal(1);
  });

  it('Should revert when removing non-existent delegator', async () => {
    const { identityId } = await createProfile();
    await expect(
      DelegatorsInfo.removeDelegator(identityId, accounts[1].address),
    ).to.be.revertedWith('Delegator not found');
  });

  it('Should handle multiple operations on same identity', async () => {
    const { identityId } = await createProfile();
    // Add multiple delegators
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[2].address);

    // Remove and re-add
    await DelegatorsInfo.removeDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);

    const delegators = await DelegatorsInfo.getDelegators(identityId);
    expect(delegators.length).to.equal(2);
    // Check if indices were updated correctly
    expect(
      await DelegatorsInfo.getDelegatorIndex(identityId, accounts[1].address),
    ).to.equal(1);
  });

  it('Should return correct delegator list', async () => {
    const { identityId } = await createProfile();
    await DelegatorsInfo.addDelegator(identityId, accounts[1].address);
    await DelegatorsInfo.addDelegator(identityId, accounts[2].address);

    const delegators = await DelegatorsInfo.getDelegators(identityId);
    expect(delegators).to.deep.equal([
      accounts[1].address,
      accounts[2].address,
    ]);
  });

  it('Should return empty array for non-existent identity', async () => {
    const delegators = await DelegatorsInfo.getDelegators(999);
    expect(delegators.length).to.equal(0);
  });

  it('Should set and get lastClaimedEpoch, emit DelegatorLastClaimedEpochUpdated', async () => {
    const { identityId } = await createProfile();

    const delegator = accounts[1].address;
    const epoch = 1;
    const epoch2 = 2;

    await expect(
      DelegatorsInfo.setLastClaimedEpoch(identityId, delegator, epoch),
    )
      .to.emit(DelegatorsInfo, 'DelegatorLastClaimedEpochUpdated')
      .withArgs(identityId, delegator, epoch);

    expect(
      await DelegatorsInfo.getLastClaimedEpoch(identityId, delegator),
    ).to.equal(epoch);

    // Make sure it updates the value
    await expect(
      DelegatorsInfo.setLastClaimedEpoch(identityId, delegator, epoch2),
    )
      .to.emit(DelegatorsInfo, 'DelegatorLastClaimedEpochUpdated')
      .withArgs(identityId, delegator, epoch2);

    expect(
      await DelegatorsInfo.getLastClaimedEpoch(identityId, delegator),
    ).to.equal(epoch2);
  });

  it('Should set and get DelegatorRollingRewards, emit DelegatorRollingRewardsUpdated', async () => {
    const { identityId } = await createProfile();

    const delegator = accounts[1].address;
    const amount = 500;
    const amount2 = 1000;

    await expect(
      DelegatorsInfo.setDelegatorRollingRewards(identityId, delegator, amount),
    )
      .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
      .withArgs(identityId, delegator, amount, amount);

    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegator),
    ).to.equal(amount);

    // Make sure it updates the value
    await expect(
      DelegatorsInfo.setDelegatorRollingRewards(identityId, delegator, amount2),
    )
      .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
      .withArgs(identityId, delegator, amount2, amount2);

    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegator),
    ).to.equal(amount2);
  });

  it('Should set IsOperatorFeeClaimedForEpoch and emit IsOperatorFeeClaimedForEpochUpdated', async () => {
    const { identityId } = await createProfile();

    const epoch = 1;
    const isClaimed = false;

    await expect(
      DelegatorsInfo.setIsOperatorFeeClaimedForEpoch(
        identityId,
        epoch,
        isClaimed,
      ),
    )
      .to.emit(DelegatorsInfo, 'IsOperatorFeeClaimedForEpochUpdated')
      .withArgs(identityId, epoch, isClaimed);
  });

  it('Should set and get NetNodeEpochRewards, emit NetNodeEpochRewardsSet', async () => {
    const { identityId } = await createProfile();

    const amount = 500;
    const epoch = 1;

    await expect(
      DelegatorsInfo.setNetNodeEpochRewards(identityId, epoch, amount),
    )
      .to.emit(DelegatorsInfo, 'NetNodeEpochRewardsSet')
      .withArgs(identityId, epoch, amount);

    expect(
      await DelegatorsInfo.getNetNodeEpochRewards(identityId, epoch),
    ).to.equal(amount);
  });

  it('Should set HasDelegatorClaimedEpochRewards and emit HasDelegatorClaimedEpochRewardsUpdated', async () => {
    const { identityId } = await createProfile();

    const claimed = false;
    const epoch = 1;
    const delegatorKey = ethers.encodeBytes32String('delegator1');

    await expect(
      DelegatorsInfo.setHasDelegatorClaimedEpochRewards(
        epoch,
        identityId,
        delegatorKey,
        claimed,
      ),
    )
      .to.emit(DelegatorsInfo, 'HasDelegatorClaimedEpochRewardsUpdated')
      .withArgs(epoch, identityId, delegatorKey, claimed);
  });

  it('Should set setHasEverDelegatedToNode and emit HasEverDelegatedToNodeUpdated', async () => {
    const { identityId } = await createProfile();

    const claimed = false;
    const delegator = accounts[1].address;

    await expect(
      DelegatorsInfo.setHasEverDelegatedToNode(identityId, delegator, claimed),
    )
      .to.emit(DelegatorsInfo, 'HasEverDelegatedToNodeUpdated')
      .withArgs(identityId, delegator, claimed);
  });

  it('Should set and get setLastStakeHeldEpoch, emit LastStakeHeldEpochUpdated', async () => {
    const { identityId } = await createProfile();

    const epoch = 1;
    const delegator = accounts[1].address;

    await expect(
      DelegatorsInfo.setLastStakeHeldEpoch(identityId, delegator, epoch),
    ).to.emit(DelegatorsInfo, 'LastStakeHeldEpochUpdated');

    expect(
      await DelegatorsInfo.getLastStakeHeldEpoch(identityId, delegator),
    ).to.equal(epoch);
  });

  it('Should set delegator rolling rewards', async () => {
    const { identityId } = await createProfile();
    const delegator = accounts[2].address;
    const amount = 500;

    await expect(await DelegatorsInfo.addDelegator(identityId, delegator))
      .to.emit(DelegatorsInfo, 'DelegatorAdded')
      .withArgs(identityId, delegator);

    await expect(
      await DelegatorsInfo.setDelegatorRollingRewards(
        identityId,
        delegator,
        amount,
      ),
    )
      .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
      .withArgs(identityId, delegator, amount, amount);

    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegator),
    ).to.equal(amount);
  });

  it('Should add to delegator rolling rewards', async () => {
    const { identityId } = await createProfile();
    const delegator = accounts[2].address;
    const amount = 500;
    const amount2 = 1000;

    await expect(await DelegatorsInfo.addDelegator(identityId, delegator))
      .to.emit(DelegatorsInfo, 'DelegatorAdded')
      .withArgs(identityId, delegator);

    await expect(
      await DelegatorsInfo.setDelegatorRollingRewards(
        identityId,
        delegator,
        amount,
      ),
    )
      .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
      .withArgs(identityId, delegator, amount, amount);

    await expect(
      await DelegatorsInfo.addDelegatorRollingRewards(
        identityId,
        delegator,
        amount2,
      ),
    )
      .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
      .withArgs(identityId, delegator, amount2, amount + amount2);

    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegator),
    ).to.equal(amount + amount2);
  });

  it('Should return zero rolling rewards for non-delegator', async () => {
    const { identityId } = await createProfile();
    const delegator = accounts[1].address;

    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(identityId, delegator),
    ).to.equal(0);
  });

  // Access control tests
  describe('Access control', function () {
    it('Should allow Staking contract to call addDelegator but revert for unauthorized', async () => {
      const { identityId } = await createProfile();

      await expect(
        DelegatorsInfo.connect(stakingSigner).addDelegator(
          identityId,
          accounts[1].address,
        ),
      )
        .to.emit(DelegatorsInfo, 'DelegatorAdded')
        .withArgs(identityId, accounts[1].address);

      await expect(
        DelegatorsInfo.connect(accounts[2]).addDelegator(
          identityId,
          accounts[3].address,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call removeDelegator but revert for unauthorized', async () => {
      const { identityId } = await createProfile();

      await DelegatorsInfo.connect(stakingSigner).addDelegator(
        identityId,
        accounts[1].address,
      );

      await expect(
        DelegatorsInfo.connect(stakingSigner).removeDelegator(
          identityId,
          accounts[1].address,
        ),
      )
        .to.emit(DelegatorsInfo, 'DelegatorRemoved')
        .withArgs(identityId, accounts[1].address);

      await expect(
        DelegatorsInfo.connect(accounts[2]).removeDelegator(
          identityId,
          accounts[3].address,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setLastClaimedEpoch but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const epoch = 5;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setLastClaimedEpoch(
          identityId,
          accounts[1].address,
          epoch,
        ),
      )
        .to.emit(DelegatorsInfo, 'DelegatorLastClaimedEpochUpdated')
        .withArgs(identityId, accounts[1].address, epoch);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setLastClaimedEpoch(
          identityId,
          accounts[1].address,
          epoch,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setDelegatorRollingRewards but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const amount = 1000;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setDelegatorRollingRewards(
          identityId,
          accounts[1].address,
          amount,
        ),
      )
        .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
        .withArgs(identityId, accounts[1].address, amount, amount);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setDelegatorRollingRewards(
          identityId,
          accounts[1].address,
          amount,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call addDelegatorRollingRewards but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const initialAmount = 500;
      const additionalAmount = 300;

      await DelegatorsInfo.connect(stakingSigner).setDelegatorRollingRewards(
        identityId,
        accounts[1].address,
        initialAmount,
      );

      await expect(
        DelegatorsInfo.connect(stakingSigner).addDelegatorRollingRewards(
          identityId,
          accounts[1].address,
          additionalAmount,
        ),
      )
        .to.emit(DelegatorsInfo, 'DelegatorRollingRewardsUpdated')
        .withArgs(
          identityId,
          accounts[1].address,
          additionalAmount,
          initialAmount + additionalAmount,
        );

      await expect(
        DelegatorsInfo.connect(accounts[2]).addDelegatorRollingRewards(
          identityId,
          accounts[1].address,
          additionalAmount,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setIsOperatorFeeClaimedForEpoch but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const epoch = 3;
      const isClaimed = true;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setIsOperatorFeeClaimedForEpoch(
          identityId,
          epoch,
          isClaimed,
        ),
      )
        .to.emit(DelegatorsInfo, 'IsOperatorFeeClaimedForEpochUpdated')
        .withArgs(identityId, epoch, isClaimed);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setIsOperatorFeeClaimedForEpoch(
          identityId,
          epoch,
          isClaimed,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setNetNodeEpochRewards but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const epoch = 2;
      const amount = 2000;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setNetNodeEpochRewards(
          identityId,
          epoch,
          amount,
        ),
      )
        .to.emit(DelegatorsInfo, 'NetNodeEpochRewardsSet')
        .withArgs(identityId, epoch, amount);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setNetNodeEpochRewards(
          identityId,
          epoch,
          amount,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setHasDelegatorClaimedEpochRewards but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const epoch = 1;
      const delegatorKey = ethers.encodeBytes32String('testDelegatorKey');
      const claimed = true;

      await expect(
        DelegatorsInfo.connect(
          stakingSigner,
        ).setHasDelegatorClaimedEpochRewards(
          epoch,
          identityId,
          delegatorKey,
          claimed,
        ),
      )
        .to.emit(DelegatorsInfo, 'HasDelegatorClaimedEpochRewardsUpdated')
        .withArgs(epoch, identityId, delegatorKey, claimed);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setHasDelegatorClaimedEpochRewards(
          epoch,
          identityId,
          delegatorKey,
          claimed,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setHasEverDelegatedToNode but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const hasEverDelegated = true;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setHasEverDelegatedToNode(
          identityId,
          accounts[1].address,
          hasEverDelegated,
        ),
      )
        .to.emit(DelegatorsInfo, 'HasEverDelegatedToNodeUpdated')
        .withArgs(identityId, accounts[1].address, hasEverDelegated);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setHasEverDelegatedToNode(
          identityId,
          accounts[1].address,
          hasEverDelegated,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });

    it('Should allow Staking contract to call setLastStakeHeldEpoch but revert for unauthorized', async () => {
      const { identityId } = await createProfile();
      const epoch = 4;

      await expect(
        DelegatorsInfo.connect(stakingSigner).setLastStakeHeldEpoch(
          identityId,
          accounts[1].address,
          epoch,
        ),
      )
        .to.emit(DelegatorsInfo, 'LastStakeHeldEpochUpdated')
        .withArgs(identityId, accounts[1].address, epoch);

      await expect(
        DelegatorsInfo.connect(accounts[2]).setLastStakeHeldEpoch(
          identityId,
          accounts[1].address,
          epoch,
        ),
      ).to.be.revertedWithCustomError(DelegatorsInfo, 'UnauthorizedAccess');
    });
  });

  // Migration tests
  describe('Migration', function () {
    it('Should migrate new addresses to delegators for their nodes', async () => {
      const { identityId } = await createProfile();
      const { identityId: identityId2 } = await createProfile(
        undefined,
        accounts[2],
      ); // Use different operational account

      // Get StakingStorage contract to set up test data
      const stakingStorage =
        await hre.ethers.getContract<StakingStorage>('StakingStorage');

      // Create delegator keys for the addresses we want to migrate
      const delegator1 = accounts[3].address;
      const delegator2 = accounts[4].address;
      const delegatorKey1 = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator1]),
      );
      const delegatorKey2 = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator2]),
      );

      // Set up delegator data in StakingStorage to simulate existing delegations
      // We need to make the delegators active in StakingStorage first
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey1, 1000);
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey2, 2000);
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId2, delegatorKey1, 1500);

      // Verify the delegators are not yet in DelegatorsInfo
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator1),
      ).to.equal(false);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator2),
      ).to.equal(false);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId2, delegator1),
      ).to.equal(false);

      // Migrate the addresses
      const newAddresses = [delegator1, delegator2];
      await expect(DelegatorsInfo.migrate(newAddresses))
        .to.emit(DelegatorsInfo, 'DelegatorAdded')
        .withArgs(identityId, delegator1)
        .and.to.emit(DelegatorsInfo, 'DelegatorAdded')
        .withArgs(identityId, delegator2)
        .and.to.emit(DelegatorsInfo, 'DelegatorAdded')
        .withArgs(identityId2, delegator1);

      // Verify the delegators are now in DelegatorsInfo
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator1),
      ).to.equal(true);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator2),
      ).to.equal(true);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId2, delegator1),
      ).to.equal(true);

      // Verify delegator2 is not in identityId2 (since it wasn't staking there)
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId2, delegator2),
      ).to.equal(false);

      // Verify the delegator lists are correct
      const delegators1 = await DelegatorsInfo.getDelegators(identityId);
      const delegators2 = await DelegatorsInfo.getDelegators(identityId2);

      expect(delegators1).to.include(delegator1);
      expect(delegators1).to.include(delegator2);
      expect(delegators2).to.include(delegator1);
      expect(delegators2).to.not.include(delegator2);
    });

    it('Should handle duplicate migration gracefully', async () => {
      const { identityId } = await createProfile();

      const stakingStorage =
        await hre.ethers.getContract<StakingStorage>('StakingStorage');
      const delegator = accounts[3].address;
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator]),
      );

      // Set up delegator data in StakingStorage
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey, 1000);

      // First migration
      await DelegatorsInfo.migrate([delegator]);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator),
      ).to.equal(true);

      // Second migration of the same address should not add duplicates
      await DelegatorsInfo.migrate([delegator]);

      // Verify the delegator is still there and no duplicates
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator),
      ).to.equal(true);
      const delegators = await DelegatorsInfo.getDelegators(identityId);
      expect(delegators.filter((d) => d === delegator).length).to.equal(1);
    });

    it('Should handle empty address array', async () => {
      // Should not revert with empty array
      await expect(DelegatorsInfo.migrate([])).to.not.be.reverted;
    });

    it('Should handle addresses with no delegator nodes', async () => {
      const { identityId } = await createProfile();

      // Use an address that has no delegator nodes in StakingStorage
      const addressWithNoNodes = accounts[5].address;

      // Should not revert and should not add the address as a delegator
      await expect(DelegatorsInfo.migrate([addressWithNoNodes])).to.not.be
        .reverted;
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, addressWithNoNodes),
      ).to.equal(false);
    });

    it('Should handle mixed addresses (some with nodes, some without)', async () => {
      const { identityId } = await createProfile();

      const stakingStorage =
        await hre.ethers.getContract<StakingStorage>('StakingStorage');
      const delegator = accounts[3].address;
      const delegatorKey = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator]),
      );
      const addressWithNoNodes = accounts[5].address;

      // Set up delegator data for only one address
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey, 1000);

      // Migrate both addresses
      await expect(DelegatorsInfo.migrate([delegator, addressWithNoNodes]))
        .to.emit(DelegatorsInfo, 'DelegatorAdded')
        .withArgs(identityId, delegator);

      // Verify only the address with nodes was added
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, delegator),
      ).to.equal(true);
      expect(
        await DelegatorsInfo.isNodeDelegator(identityId, addressWithNoNodes),
      ).to.equal(false);
    });

    it('Should maintain correct delegator indices after migration', async () => {
      const { identityId } = await createProfile();

      const stakingStorage =
        await hre.ethers.getContract<StakingStorage>('StakingStorage');
      const delegator1 = accounts[3].address;
      const delegator2 = accounts[4].address;
      const delegatorKey1 = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator1]),
      );
      const delegatorKey2 = ethers.keccak256(
        ethers.solidityPacked(['address'], [delegator2]),
      );

      // Set up delegator data in StakingStorage
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey1, 1000);
      await stakingStorage
        .connect(stakingSigner)
        .setDelegatorStakeBase(identityId, delegatorKey2, 2000);

      // Migrate the addresses
      await DelegatorsInfo.migrate([delegator1, delegator2]);

      // Verify indices are correct
      expect(
        await DelegatorsInfo.getDelegatorIndex(identityId, delegator1),
      ).to.equal(0);
      expect(
        await DelegatorsInfo.getDelegatorIndex(identityId, delegator2),
      ).to.equal(1);

      // Verify delegator list order
      const delegators = await DelegatorsInfo.getDelegators(identityId);
      expect(delegators[0]).to.equal(delegator1);
      expect(delegators[1]).to.equal(delegator2);
    });
  });
});
