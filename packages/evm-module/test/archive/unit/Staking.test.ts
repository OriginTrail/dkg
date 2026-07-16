import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

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
  Chronos,
  RandomSamplingStorage,
  EpochStorage,
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
  Chronos: Chronos;
  RandomSamplingStorage: RandomSamplingStorage;
  EpochStorage: EpochStorage;
  DelegatorsInfo: DelegatorsInfo;
};

async function deployStakingFixture(): Promise<StakingFixture> {
  await hre.deployments.fixture([
    'Profile',
    'Staking',
    'EpochStorage',
    'Chronos',
    'RandomSamplingStorage',
    'DelegatorsInfo',
  ]);
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
  const Chronos = await hre.ethers.getContract<Chronos>('Chronos');
  const RandomSamplingStorage =
    await hre.ethers.getContract<RandomSamplingStorage>(
      'RandomSamplingStorage',
    );
  const EpochStorage =
    await hre.ethers.getContract<EpochStorage>('EpochStorageV8');
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
    Chronos,
    RandomSamplingStorage,
    EpochStorage,
    DelegatorsInfo,
  };
}

describe('Staking contract', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let Profile: Profile;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let ShardingTableStorage: ShardingTableStorage;
  let ParametersStorage: ParametersStorage;
  let RandomSamplingStorage: RandomSamplingStorage;
  let Chronos: Chronos;
  let EpochStorage: EpochStorage;
  let DelegatorsInfo: DelegatorsInfo;

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
    ({
      accounts,
      Token,
      Profile,
      Staking,
      StakingStorage,
      ShardingTableStorage,
      ParametersStorage,
      RandomSamplingStorage,
      Chronos,
      EpochStorage,
      DelegatorsInfo,
    } = await loadFixture(deployStakingFixture));
  });

  /**********************************************************************
   * Sanity checks     *
   **********************************************************************/
  it('Should have correct name and version', async () => {
    expect(await Staking.name()).to.equal('Staking');
    expect(await Staking.version()).to.equal('1.0.1');
  });

  /**********************************************************************
   * Staking tests     *
   **********************************************************************/

  it('Should revert if staking 0 tokens', async () => {
    const { identityId } = await createProfile();
    await expect(Staking.stake(identityId, 0)).to.be.revertedWithCustomError(
      Staking,
      'ZeroTokenAmount',
    );
  });

  it('Should revert if profile does not exist', async () => {
    await expect(Staking.stake(9999, 100)).to.be.revertedWithCustomError(
      Staking,
      'ProfileDoesntExist',
    );
  });

  it('Should revert if token allowance too low', async () => {
    const { identityId } = await createProfile();
    await expect(Staking.stake(identityId, 100)).to.be.revertedWithCustomError(
      Staking,
      'TooLowAllowance',
    );
  });

  it('Should revert if token balance too low', async () => {
    const { identityId } = await createProfile();
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      2n ** 96n - 1n,
    );
    await expect(
      Staking.stake(identityId, 2n ** 96n - 1n),
    ).to.be.revertedWithCustomError(Staking, 'TooLowBalance');
  });

  it('Should revert if maximum stake exceeded', async () => {
    const { identityId } = await createProfile();
    const maxStake = await ParametersStorage.maximumStake();
    await Token.mint(accounts[0].address, maxStake + 1n);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      maxStake + 1n,
    );
    await Staking.stake(identityId, maxStake);
    await expect(Staking.stake(identityId, 1)).to.be.revertedWithCustomError(
      Staking,
      'MaximumStakeExceeded',
    );
  });

  it('Should stake successfully and reflect on node stake', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    const stakingBalanceBefore = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );
    await Staking.stake(identityId, amount);
    const stakingBalanceAfter = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );
    expect(stakingBalanceAfter - stakingBalanceBefore).to.equal(
      amount,
      'StakingStorage contract balance increase by staked amount',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      amount,
      'Node stake should be equal to the staked amount',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(
        identityId,
        hre.ethers.keccak256(
          hre.ethers.solidityPacked(['address'], [accounts[0].address]),
        ),
      ),
    ).to.equal(amount, 'Delegator stake should be equal to the staked amount');
  });
  /**********************************************************************
   * Sharding table tests     *
   **********************************************************************/

  it('Should NOT add the node to the sharding table when below minimum stake', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      false,
      'Node should not be added to the sharding table',
    );
  });

  it('Should add node to sharding table when above minimum stake', async () => {
    const { identityId } = await createProfile();
    const minStake = await ParametersStorage.minimumStake();
    await Token.mint(accounts[0].address, minStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      minStake,
    );
    await Staking.stake(identityId, minStake);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      true,
      'Node should be added to the sharding table',
    );
  });

  it('Should have node enter / exit sharding table when stake changes below / above minimum stake', async () => {
    const { identityId } = await createProfile();
    const minStake = await ParametersStorage.minimumStake();
    // stake minStake - 1 → should not enter table
    const almost = minStake - 1n;
    await Token.mint(accounts[0].address, almost + 1n);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      almost + 1n,
    );
    await Staking.stake(identityId, almost);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      false,
      'Node should not be added to the sharding table',
    );

    // add +1 wei to reach exact minStake → should enter table
    await Staking.stake(identityId, 1n);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      true,
      'Node should be added to the sharding table',
    );

    // advance past conviction lock
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Request withdrawal of 1 wei to fall below minStake
    await Staking.requestWithdrawal(identityId, 1n);
    const req = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    await time.increaseTo(req[2]);
    await Staking.finalizeWithdrawal(identityId);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      false,
      'Node should not be added to the sharding table',
    );
  });

  it('Should have node be removed then re-enter sharding table after drop below / above threshold', async () => {
    const { identityId } = await createProfile();
    const minStake = await ParametersStorage.minimumStake();

    // Stake exactly minimum → node enters table
    await Token.mint(accounts[0].address, minStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      minStake,
    );
    await Staking.stake(identityId, minStake);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      true,
      'Node should be added to the sharding table',
    );

    // advance past conviction lock
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Request withdrawal of 1 wei so node drops below minimum
    await Staking.requestWithdrawal(identityId, 1n);
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const [, , ts] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );
    await time.increaseTo(ts);
    await Staking.finalizeWithdrawal(identityId);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      false,
      'Node should not be added to the sharding table',
    );

    // Restake 1 wei to cross back above minimum
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await Staking.stake(identityId, 1n);
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(
      true,
      'Node should be added to the sharding table',
    );
  });

  /**********************************************************************
   * Redelegation tests     *
   **********************************************************************/

  it('Should redelegate stake to another identity', async () => {
    const node1 = await createProfile();
    const node2 = await createProfile(accounts[0], accounts[2]);
    const initialStake = hre.ethers.parseEther('100000');
    await Token.mint(accounts[0].address, initialStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      initialStake,
    );
    await Staking.stake(node1.identityId, initialStake);
    // redelegate half
    const halfStake = initialStake / 2n;
    await Staking.redelegate(node1.identityId, node2.identityId, halfStake);

    // check that the stake is correctly updated
    expect(await StakingStorage.getNodeStake(node1.identityId)).to.equal(
      halfStake,
      'Node1 stake should be equal to the half stake',
    );
    expect(await StakingStorage.getNodeStake(node2.identityId)).to.equal(
      halfStake,
      'Node2 stake should be equal to the half stake',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(
        node1.identityId,
        hre.ethers.keccak256(
          hre.ethers.solidityPacked(['address'], [accounts[0].address]),
        ),
      ),
    ).to.equal(halfStake, 'Delegator1 stake should be equal to the half stake');
    expect(
      await StakingStorage.getDelegatorStakeBase(
        node2.identityId,
        hre.ethers.keccak256(
          hre.ethers.solidityPacked(['address'], [accounts[0].address]),
        ),
      ),
    ).to.equal(halfStake, 'Delegator2 stake should be equal to the half stake');

    // Additional tests for redelegation:
    // 1) Redelegate zero tokens
    await expect(
      Staking.redelegate(node1.identityId, node2.identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
    // 2) Redelegate from non-existent identity
    await expect(
      Staking.redelegate(9999, node2.identityId, 100),
    ).to.be.revertedWithCustomError(Staking, 'ProfileDoesntExist');
    // 3) Redelegate to non-existent identity
    await expect(
      Staking.redelegate(node1.identityId, 9999, 100),
    ).to.be.revertedWithCustomError(Staking, 'ProfileDoesntExist');
  });

  it('Should NOT BE ABLE to redelegate more stake to another identity than the delegator has', async () => {
    const node1 = await createProfile();
    const node2 = await createProfile(accounts[0], accounts[2]);
    const initialStake = hre.ethers.parseEther('100000');
    await Token.mint(accounts[0].address, initialStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      initialStake,
    );
    await Staking.stake(node1.identityId, initialStake);
    await expect(
      Staking.redelegate(node1.identityId, node2.identityId, initialStake + 1n),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalExceedsStake');
  });
  /**********************************************************************
   * Redelegation Nuances
   **********************************************************************/

  it('⛔️ Redelegate to the SAME node should revert', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('10');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await expect(
      Staking.redelegate(identityId, identityId, stakeAmt),
    ).to.be.revertedWith('Cannot redelegate to the same node');
  });

  it('⛔️ Redelegate that would overflow maximumStake on destination node should revert', async () => {
    const max = await ParametersStorage.maximumStake();
    // create two nodes
    const nodeSrc = await createProfile();
    const nodeDst = await createProfile(accounts[0], accounts[2]);

    // Stake maxStake – 5 to destination node via admin for simplicity
    const nearMax = max - 5n;
    await Token.mint(accounts[0].address, nearMax);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      nearMax,
    );
    await Staking.stake(nodeDst.identityId, nearMax);

    // Stake 10 on source node (so redelegating 10 would exceed by 5)
    const stakeSrc = 10n;
    await Token.mint(accounts[0].address, stakeSrc);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeSrc,
    );
    await Staking.stake(nodeSrc.identityId, stakeSrc);
    await expect(
      Staking.redelegate(nodeSrc.identityId, nodeDst.identityId, stakeSrc),
    ).to.be.revertedWithCustomError(Staking, 'MaximumStakeExceeded');
  });

  it('✅ Redelegating full stake removes delegator from source node and adds to destination node', async () => {
    const node1 = await createProfile();
    const node2 = await createProfile(accounts[0], accounts[2]);

    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(node1.identityId, amount);

    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );

    // Preconditions
    expect(
      await DelegatorsInfo.isNodeDelegator(
        node1.identityId,
        accounts[0].address,
      ),
    ).to.equal(true, 'Delegator should be present on node1');
    expect(
      await DelegatorsInfo.isNodeDelegator(
        node2.identityId,
        accounts[0].address,
      ),
    ).to.equal(false, 'Delegator should not be present on node2');
    expect(
      await StakingStorage.getDelegatorStakeBase(node1.identityId, dKey),
    ).to.equal(amount, 'Delegator stake should be equal to the amount');
    expect(
      await StakingStorage.getDelegatorStakeBase(node2.identityId, dKey),
    ).to.equal(0n, 'Delegator stake should be equal to 0');

    // Redelegation
    await Staking.redelegate(node1.identityId, node2.identityId, amount);
    // Source node: delegator removed and stake zero
    expect(
      await StakingStorage.getDelegatorStakeBase(node1.identityId, dKey),
    ).to.equal(0n, 'Delegator stake should be equal to 0');
    expect(
      await DelegatorsInfo.isNodeDelegator(
        node1.identityId,
        accounts[0].address,
      ),
    ).to.equal(false, 'Delegator should not be present on node1');

    // Destination node: delegator present and stake amount
    expect(
      await StakingStorage.getDelegatorStakeBase(node2.identityId, dKey),
    ).to.equal(amount, 'Delegator stake should be equal to the amount  ');
    expect(
      await DelegatorsInfo.isNodeDelegator(
        node2.identityId,
        accounts[0].address,
      ),
    ).to.equal(true, 'Delegator should be present on node2');
  });
  /**********************************************************************
   * Withdrawal tests     *
   **********************************************************************/

  it('Should revert finalizeWithdrawal if not requested', async () => {
    const { identityId } = await createProfile();
    await expect(
      Staking.finalizeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalWasntInitiated');
  });

  it('Should handle requestWithdrawal with zero tokens', async () => {
    const { identityId } = await createProfile();
    await expect(
      Staking.requestWithdrawal(identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('Should handle requestWithdrawal exceeding stake', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    await expect(
      Staking.requestWithdrawal(identityId, amount + 1n),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalExceedsStake');
  });

  it('Should create a withdrawal request, and not be able to finalize it immediately', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    const delay = await ParametersStorage.stakeWithdrawalDelay();
    const tx = await Staking.requestWithdrawal(identityId, amount / 2n);
    const block = await hre.ethers.provider.getBlock(
      (await tx.wait())!.blockNumber,
    );
    const requestTimestamp = block!.timestamp;
    const req = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    expect(req[0]).to.equal(
      amount / 2n,
      'Withdrawal amount should be equal to the half of the staked amount',
    );
    expect(req[2]).to.equal(
      BigInt(requestTimestamp) + delay,
      'Withdrawal request timestamp should be correct',
    );
    await expect(
      Staking.finalizeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalPeriodPending');
  });

  it('should not be able to finalize withdrawal if the request was not initiated', async () => {
    const { identityId } = await createProfile();
    await expect(
      Staking.finalizeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalWasntInitiated');
  });

  it('Should finalize withdrawal after delay', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    await Staking.requestWithdrawal(identityId, amount / 2n);
    const req = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    await time.increaseTo(req[2]);
    const balanceBefore = await Token.balanceOf(accounts[0].address);
    await Staking.finalizeWithdrawal(identityId);
    const balanceAfter = await Token.balanceOf(accounts[0].address);
    expect(balanceAfter - balanceBefore).to.equal(
      amount / 2n,
      'Balance should be equal to the half of the staked amount',
    );
  });

  it('Should revert finalizeWithdrawal if too early', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    await Staking.requestWithdrawal(identityId, amount / 2n);
    const req = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    await time.increaseTo(req[2] - 10n);
    await expect(
      Staking.finalizeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalPeriodPending');
  });

  it('Should cancel withdrawal request', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('200');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    await Staking.requestWithdrawal(identityId, hre.ethers.parseEther('100'));
    await Staking.cancelWithdrawal(identityId);
    const req = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    expect(req[0]).to.equal(0, 'Withdrawal amount should be equal to 0');
  });

  it('Should revert cancelWithdrawal if no request', async () => {
    const { identityId } = await createProfile();
    await expect(
      Staking.cancelWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalWasntInitiated');
  });

  /**********************************************************************
   * Operator fee tests     *
   **********************************************************************/

  it('Should revert if restake operator fee called with 0 tokens', async () => {
    const { identityId } = await createProfile();
    await expect(
      Staking.restakeOperatorFee(identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('Should revert restakeOperatorFee when amount exceeds operator fee balance', async () => {
    const { identityId } = await createProfile();
    // Seed small operator fee balance
    await StakingStorage.setOperatorFeeBalance(identityId, 10n);
    // Attempt to restake more than balance
    await expect(
      Staking.restakeOperatorFee(identityId, 11n),
    ).to.be.revertedWithCustomError(Staking, 'AmountExceedsOperatorFeeBalance');
  });

  it('Should restake operator fee successfully', async () => {
    // 1. Create a node profile where msg.sender (accounts[0]) is admin
    const { identityId } = await createProfile();
    // 2. Manually set operator fee balance via the Hub owner (onlyContracts passes for hub owner)
    const feeBalance = hre.ethers.parseEther('100');
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      feeBalance,
    );

    // 3. Stake 50000 tokens to the node
    const amount = hre.ethers.parseEther('50000');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      amount,
      'Node stake should be equal to the staked amount',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(
        identityId,
        hre.ethers.keccak256(
          hre.ethers.solidityPacked(['address'], [accounts[0].address]),
        ),
      ),
    ).to.equal(amount, 'Delegator stake should be equal to the staked amount');

    // 4. Snapshot before restake
    const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const delegatorStakeBefore = await StakingStorage.getDelegatorStakeBase(
      identityId,
      delegatorKey,
    );
    const opFeeBalanceBefore =
      await StakingStorage.getOperatorFeeBalance(identityId);
    const stakingBalanceBefore = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );

    // 4. Restake a portion of the operator fee
    const restakeAmount = hre.ethers.parseEther('40');
    await Staking.restakeOperatorFee(identityId, restakeAmount);

    // 5. Snapshot after restake
    const nodeStakeAfter = await StakingStorage.getNodeStake(identityId);
    const delegatorStakeAfter = await StakingStorage.getDelegatorStakeBase(
      identityId,
      delegatorKey,
    );
    const opFeeBalanceAfter =
      await StakingStorage.getOperatorFeeBalance(identityId);
    const stakingBalanceAfter = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );

    // 6. Assertions
    expect(opFeeBalanceAfter).to.equal(
      opFeeBalanceBefore - restakeAmount,
      'Operator fee balance should be reduced by the restaked amount',
    );
    expect(nodeStakeAfter).to.equal(
      nodeStakeBefore + restakeAmount,
      'Node stake should be increased by the restaked amount',
    );
    expect(delegatorStakeAfter).to.equal(
      delegatorStakeBefore + restakeAmount,
      'Delegator stake should be increased by the restaked amount',
    );
    expect(stakingBalanceAfter - stakingBalanceBefore).to.equal(
      0,
      'StakingStorage contract balance should not change',
    );
  });

  /**********************************************************************
   * Operator fee withdrawal tests
   **********************************************************************/

  it('Should request and finalize operator fee withdrawal successfully', async () => {
    const { identityId } = await createProfile();

    // Seed operator fee balance directly
    const initialFeeBalance = hre.ethers.parseEther('100');
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      initialFeeBalance,
    );
    // Also mint equivalent tokens to the StakingStorage contract so it can transfer them out
    await Token.mint(await StakingStorage.getAddress(), initialFeeBalance);

    // Request withdrawal for half of the balance
    const withdrawalAmount = hre.ethers.parseEther('50');
    const delay = await ParametersStorage.stakeWithdrawalDelay();
    const tx = await Staking.requestOperatorFeeWithdrawal(
      identityId,
      withdrawalAmount,
    );
    const tsReq = (await hre.ethers.provider.getBlock(
      (await tx.wait()).blockNumber,
    ))!.timestamp;

    const [storedAmount, , releaseTs] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(storedAmount).to.equal(
      withdrawalAmount,
      'Stored amount should be equal to the withdrawal amount',
    );
    expect(releaseTs).to.equal(
      tsReq + Number(delay),
      'Release timestamp should be equal to the request timestamp plus the delay',
    );

    // Advance time and finalize
    await time.increaseTo(BigInt(releaseTs));
    const balanceBefore = await Token.balanceOf(accounts[0].address);
    const stakingStorageBalanceBefore = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );
    await Staking.finalizeOperatorFeeWithdrawal(identityId);
    const balanceAfter = await Token.balanceOf(accounts[0].address);
    const stakingStorageBalanceAfter = await Token.balanceOf(
      await StakingStorage.getAddress(),
    );
    expect(balanceAfter - balanceBefore).to.equal(
      withdrawalAmount,
      'Balance should be equal to the withdrawal amount',
    );
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      initialFeeBalance - withdrawalAmount,
      'Operator fee balance should be reduced by the withdrawal amount',
    );
    expect(stakingStorageBalanceBefore - stakingStorageBalanceAfter).to.equal(
      withdrawalAmount,
      'StakingStorage contract balance should be lowered by the withdrawal amount',
    );
  });

  it('Should revert finalizeOperatorFeeWithdrawal if called too early', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('20');
    // set operator fee balance
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      feeBal,
    );
    // request withdrawal
    const withdrawAmt = hre.ethers.parseEther('10');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawAmt);
    await expect(
      Staking.finalizeOperatorFeeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalPeriodPending');
  });

  it('Should revert requestOperatorFeeWithdrawal when amount exceeds balance', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('30');
    // set operator fee balance
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      feeBal,
    );
    // mint tokens to the StakingStorage contract
    await Token.mint(await StakingStorage.getAddress(), feeBal);
    // attempt to request withdrawal with amount exceeding balance -> should revert
    await expect(
      Staking.requestOperatorFeeWithdrawal(identityId, feeBal + 1n),
    ).to.be.revertedWithCustomError(Staking, 'AmountExceedsOperatorFeeBalance');
  });

  it('Should revert requestOperatorFeeWithdrawal with zero amount', async () => {
    const { identityId } = await createProfile();
    // attempt to request withdrawal with zero amount -> should revert
    await expect(
      Staking.requestOperatorFeeWithdrawal(identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('Should allow restake of remaining operator fee while a withdrawal is pending', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('60');
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      feeBal,
    );
    await Token.mint(await StakingStorage.getAddress(), feeBal);
    // initiate withdrawal of 40
    const withdrawFirst = hre.ethers.parseEther('40');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawFirst);

    // Remaining operator fee balance is 20; restake 10
    const restakeAmt = hre.ethers.parseEther('10');
    const nodeStakeBefore = await StakingStorage.getNodeStake(identityId);
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const delegatorStakeBefore = await StakingStorage.getDelegatorStakeBase(
      identityId,
      delegatorKey,
    );

    // restake
    await Staking.restakeOperatorFee(identityId, restakeAmt);

    // assertions
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal - withdrawFirst - restakeAmt,
      'Operator fee balance should be reduced by the withdrawal amount and the restaked amount',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      nodeStakeBefore + restakeAmt,
      'Node stake should be increased by the restaked amount',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, delegatorKey),
    ).to.equal(
      delegatorStakeBefore + restakeAmt,
      'Delegator stake should be increased by the restaked amount',
    );
  });

  it('finalizeOperatorFeeWithdrawal second call reverts', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('20');
    // set operator fee balance
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      feeBal,
    );
    // request withdrawal
    const withdrawAmt = hre.ethers.parseEther('10');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawAmt);
    const [, , ts] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    await Token.mint(await StakingStorage.getAddress(), feeBal);
    await time.increaseTo(BigInt(ts));
    await Staking.finalizeOperatorFeeWithdrawal(identityId);
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal - withdrawAmt,
      'Balance should be equal to feeBal - withdrawAmt',
    );
    const [reqAmount] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(reqAmount).to.equal(0n, 'Withdrawal request should be cleared');

    await expect(
      Staking.finalizeOperatorFeeWithdrawal(identityId),
    ).to.be.revertedWithCustomError(Staking, 'WithdrawalWasntInitiated');
  });

  /**********************************************************************
   * Staking before claiming rewards tests     *
   **********************************************************************/

  it('Should revert additional staking if previous epoch rewards not claimed', async () => {
    // create profile
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('1000');
    // mint and stake
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);

    // move to next epoch
    const Chronos = await hre.ethers.getContract('Chronos');
    const ttn = await Chronos.timeUntilNextEpoch();
    await time.increase(ttn + 1n);
    const currentEpoch = await Chronos.getCurrentEpoch();
    const prevEpoch = currentEpoch - 1n;

    // Add delegator score to simulate earnings in prev epoch
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      prevEpoch,
      identityId,
      delegatorKey,
      1,
    );

    // attempt to stake more -> should revert
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.be.revertedWith(
      'Must claim the previous epoch rewards before changing stake',
    );
  });

  it('Should revert withdrawal request if previous epoch rewards not claimed', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('1000');
    // mint and stake
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    // move to next epoch
    const Chronos = await hre.ethers.getContract('Chronos');
    const ttn = await Chronos.timeUntilNextEpoch();
    await time.increase(ttn + 1n);
    const currentEpoch = await Chronos.getCurrentEpoch();
    const prevEpoch = currentEpoch - 1n;

    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      prevEpoch,
      identityId,
      delegatorKey,
      1,
    );
    // attempt to request withdrawal -> should revert
    await expect(Staking.requestWithdrawal(identityId, 1n)).to.be.revertedWith(
      'Must claim the previous epoch rewards before changing stake',
    );
  });

  /**********************************************************************
   * Epoch-claim dependency tests
   **********************************************************************/

  it('⛔️ Should revert stake change when previous epochs rewards are unclaimed', async () => {
    const { identityId } = await createProfile();
    const initialStake = hre.ethers.parseEther('500');
    // mint and stake
    await Token.mint(accounts[0].address, initialStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      initialStake,
    );
    await Staking.stake(identityId, initialStake);
    let currentEpoch = await Chronos.getCurrentEpoch();

    // Add delegator score to simulate earnings in prev epoch
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      currentEpoch,
      identityId,
      delegatorKey,
      1,
    );

    // Fast-forward 3 epochs ➡️ currentEpoch = 4
    const tlen = await Chronos.epochLength();
    await time.increase(tlen * 3n + 3n);
    currentEpoch = await Chronos.getCurrentEpoch();

    // Attempt to stake +1 wei without having claimed
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.be.revertedWith(
      'Must claim all previous epoch rewards before changing stake',
    );
  });

  it('⛔️ Should revert adding stake when only some epochs are claimed', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('500');
    const initialEpoch = await Chronos.getCurrentEpoch();
    // mint and stake
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);

    // Add delegator score to simulate earnings in initial epoch and next epoch
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      initialEpoch,
      identityId,
      delegatorKey,
      1,
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      initialEpoch + 1n,
      identityId,
      delegatorKey,
      2,
    );

    // Fast-forward 3 epochs
    const len = await Chronos.epochLength();
    await time.increase(len * 3n + 3n);

    // Claim rewards for initial epoch
    await Staking.claimDelegatorRewards(
      identityId,
      initialEpoch,
      accounts[0].address,
    );

    // Try to stake — should still revert
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.be.revertedWith(
      'Must claim all previous epoch rewards before changing stake',
    );

    // Claim all rewards, then staking should succeed
    await Staking.claimDelegatorRewards(
      identityId,
      initialEpoch + 1n,
      accounts[0].address,
    );

    // Try to stake — should still revert
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await Staking.stake(identityId, 1n);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      amount + 1n,
      'staking successful after claiming all rewards',
    );
  });

  it('⛔️ Should revert restaking operator fee when only some epochs are claimed', async () => {
    const { identityId } = await createProfile();
    const { identityId: destId } = await createProfile(undefined, accounts[3]);
    const stakeBase = hre.ethers.parseEther('500');
    // Stake base so node exists
    await Token.mint(accounts[0].address, stakeBase);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeBase,
    );
    await Staking.stake(identityId, stakeBase);

    // create rewards in epoch0 and epoch1
    const startEpoch = await Chronos.getCurrentEpoch();
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      startEpoch,
      identityId,
      dKey,
      1,
    );
    await RandomSamplingStorage.addToNodeEpochScore(startEpoch, identityId, 1);
    await RandomSamplingStorage.addToAllNodesEpochScore(startEpoch, 1);
    await EpochStorage.addTokensToEpochRange(
      1,
      startEpoch,
      startEpoch,
      hre.ethers.parseEther('10'),
    );

    // advance one epoch and add more rewards
    const len = await Chronos.epochLength();
    await time.increase(len + 2n);
    const secondEpoch = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      secondEpoch,
      identityId,
      dKey,
      2,
    );
    await RandomSamplingStorage.addToNodeEpochScore(secondEpoch, identityId, 2);
    await RandomSamplingStorage.addToAllNodesEpochScore(secondEpoch, 2);
    await EpochStorage.addTokensToEpochRange(
      1,
      secondEpoch,
      secondEpoch,
      hre.ethers.parseEther('10'),
    );

    // advance another epoch so both epochs are claimable
    await time.increase(len + 2n);

    // Claim only first epoch
    await Staking.claimDelegatorRewards(
      identityId,
      startEpoch,
      accounts[0].address,
    );

    // Attempt to redelegate 1 wei – expect revert due to unclaimed second epoch
    await expect(Staking.redelegate(identityId, destId, 1n)).to.be.revertedWith(
      'Must claim the previous epoch rewards before changing stake',
    );

    // Claim remaining epoch and then redelegation should succeed
    await Staking.claimDelegatorRewards(
      identityId,
      secondEpoch,
      accounts[0].address,
    );

    const sourceBefore = await StakingStorage.getNodeStake(identityId);
    const destBefore = await StakingStorage.getNodeStake(destId);

    await expect(Staking.redelegate(identityId, destId, 1n)).to.not.be.reverted;

    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      sourceBefore - 1n,
    );
    expect(await StakingStorage.getNodeStake(destId)).to.equal(destBefore + 1n);
  });

  it('✅ Should allow stake change after all previous rewards claimed', async () => {
    const { identityId } = await createProfile();
    const baseStake = hre.ethers.parseEther('500');
    await Token.mint(accounts[0].address, baseStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      baseStake,
    );
    // stake
    await Staking.stake(identityId, baseStake);
    const initialEpoch = await Chronos.getCurrentEpoch();

    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      initialEpoch + 1n,
      identityId,
      delegatorKey,
      1,
    );

    const epochLen = await Chronos.epochLength();
    // fast-forward 3 epochs
    await time.increase(epochLen * 3n + 3n);

    // Pretend all rewards claimed up to prevEp
    await Staking.claimDelegatorRewards(
      identityId,
      initialEpoch,
      accounts[0].address,
    );
    await Staking.claimDelegatorRewards(
      identityId,
      initialEpoch + 1n,
      accounts[0].address,
    );

    // Stake additional 1 wei – should pass
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.not.be.reverted;
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      baseStake + 1n,
    );
  });

  /**********************************************************************
   * Boundary & Limit tests
   **********************************************************************/

  it('✅ Stake exactly maximumStake should succeed, +1 wei should revert', async () => {
    const { identityId } = await createProfile();
    const maxStake = await ParametersStorage.maximumStake();

    await Token.mint(accounts[0].address, maxStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      maxStake,
    );
    await expect(Staking.stake(identityId, maxStake)).to.not.be.reverted;
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(maxStake);

    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.be.revertedWithCustomError(
      Staking,
      'MaximumStakeExceeded',
    );
  });

  it('⛔️ Restake operator fee that pushes above maximumStake should revert', async () => {
    const { identityId } = await createProfile();
    const maxStake = await ParametersStorage.maximumStake();

    // stake maxStake - 5
    const base = maxStake - 5n;
    await Token.mint(accounts[0].address, base);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), base);
    await Staking.stake(identityId, base);
    // set operator fee balance to 10 TRAC
    const opFee = 10n;
    await StakingStorage.connect(accounts[0]).setOperatorFeeBalance(
      identityId,
      opFee,
    );

    await expect(
      Staking.restakeOperatorFee(identityId, 6n),
    ).to.be.revertedWithCustomError(Staking, 'MaximumStakeExceeded');
  });

  /**********************************************************************
   * rollingRewards & cumulativeEarned / cumulativePaidOut
   **********************************************************************/

  it('📊 rollingRewards accumulate & auto-restake; earned / paidOut updated', async () => {
    const { identityId } = await createProfile();
    const SCALE18 = hre.ethers.parseUnits('1', 18);

    /* 1️⃣  Stake once in epoch-1 */
    const stakeBase = hre.ethers.parseEther('1000');
    await Token.mint(accounts[0].address, stakeBase);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeBase,
    );
    await Staking.stake(identityId, stakeBase);

    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );

    /* helper to create "rewards" for an epoch */
    // Inject rewards for epoch-1 immediately so first claim yields rolling rewards
    const epoch1 = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToNodeEpochScore(
      epoch1,
      identityId,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(epoch1, SCALE18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epoch1,
      identityId,
      dKey,
      SCALE18,
    );
    const tokenRewards1 = hre.ethers.parseEther('20');
    await EpochStorage.addTokensToEpochRange(1, epoch1, epoch1, tokenRewards1);

    /* 2️⃣  Produce rewards for epoch-2 and epoch-3 */
    const len = await Chronos.epochLength();
    await time.increase(len + 2n); // -> epoch-2
    const epoch2 = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToNodeEpochScore(
      epoch2,
      identityId,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(epoch2, SCALE18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epoch2,
      identityId,
      dKey,
      SCALE18,
    );
    const tokenRewards2 = hre.ethers.parseEther('30');
    await EpochStorage.addTokensToEpochRange(1, epoch2, epoch2, tokenRewards2);

    await time.increase(len + 2n); // -> epoch-3
    const epoch3 = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToNodeEpochScore(
      epoch3,
      identityId,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(epoch3, SCALE18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epoch3,
      identityId,
      dKey,
      SCALE18,
    );
    const tokenRewards3 = hre.ethers.parseEther('40');
    await EpochStorage.addTokensToEpochRange(1, epoch3, epoch3, tokenRewards3);

    /* 3️⃣  Move to epoch-4 so gap > 1 and claim epoch-3-1 (= epoch-3?) Actually previousEpoch will be 3 */
    await time.increase(len + 2n); // -> epoch-4
    const epoch4 = await Chronos.getCurrentEpoch(); // claim epoch-1 first (oldest unclaimed)

    await Staking.claimDelegatorRewards(
      identityId,
      epoch1,
      accounts[0].address,
    );
    const rolling1 = await DelegatorsInfo.getDelegatorRollingRewards(
      identityId,
      accounts[0].address,
    );

    expect(rolling1).to.equal(
      tokenRewards1,
      'Rolling rewards should be equal to tokenRewards1',
    );

    /* cumulativeEarned should have grown, cumulativePaidOut unchanged (0) */
    const [earned1, paid1] = await StakingStorage.getDelegatorRewardsInfo(
      identityId,
      dKey,
    );
    expect(earned1).to.equal(
      tokenRewards1,
      'Earned rewards should equal rewards from epoch 1 after first claim',
    );
    expect(paid1).to.equal(0n, 'Paid should be 0');

    /* 4️⃣  Claim next epoch (gap ≤ 1) – rollingRewards should auto-restake */
    const secondClaimEpoch = epoch2; // claim epoch-2 next (gap ≤1)
    await Staking.claimDelegatorRewards(
      identityId,
      secondClaimEpoch,
      accounts[0].address,
    );

    const rolling2 = await DelegatorsInfo.getDelegatorRollingRewards(
      identityId,
      accounts[0].address,
    );
    expect(rolling2).to.be.gt(
      0n,
      'rollingRewards should still be accumulating',
    );
    console.log('    Rolling rewards still accumulating');

    /* 5️⃣  Claim epoch3 now (prev epoch) — triggers auto-restake */
    const thirdClaimEpoch = epoch4 - 1n; // == epoch3
    console.log(
      '🌱  Claiming epoch',
      thirdClaimEpoch,
      'to trigger auto-restake',
    );
    await Staking.claimDelegatorRewards(
      identityId,
      thirdClaimEpoch,
      accounts[0].address,
    );

    const rolling3 = await DelegatorsInfo.getDelegatorRollingRewards(
      identityId,
      accounts[0].address,
    );
    expect(rolling3).to.equal(
      0n,
      'rollingRewards must be zero after auto-restake',
    );
    console.log('    Rolling rewards reset to zero');

    const finalStake = await StakingStorage.getDelegatorStakeBase(
      identityId,
      dKey,
    );
    expect(finalStake).to.be.gt(
      stakeBase,
      'Final stake should grow after auto-restake',
    );

    const [earned2, paid2] = await StakingStorage.getDelegatorRewardsInfo(
      identityId,
      dKey,
    );
    expect(earned2).to.be.gt(earned1, 'Earned should grow');
    expect(paid2).to.equal(0n, 'Paid stays zero');

    /* 6️⃣  restakeOperatorFee does NOT touch earned/paidOut */
    console.log('    Setting operator fee balance to 10 TRAC');
    await StakingStorage.setOperatorFeeBalance(identityId, 10n);
    console.log('    Restaking operator fee');
    await Staking.restakeOperatorFee(identityId, 5n);
    const [earned3, paid3] = await StakingStorage.getDelegatorRewardsInfo(
      identityId,
      dKey,
    );
    console.log('    Earned assertion passed');
    expect(earned3).to.equal(earned2, 'Earned should be equal to earned2');
    console.log('    Paid assertion passed');
    expect(paid3).to.equal(paid2, 'Paid should be equal to paid2');
    console.log('    Paid assertion passed');
  });

  /******************* rolling rewards accumulate then flush ***********/
  it('rolling rewards accumulate over multiple epochs then flush into stake', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);

    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    // epoch1 & epoch2 add scores
    const ep1 = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      ep1,
      identityId,
      dKey,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(ep1, SCALE18);
    await RandomSamplingStorage.addToNodeEpochScore(ep1, identityId, SCALE18);
    await EpochStorage.addTokensToEpochRange(
      1,
      ep1,
      ep1,
      hre.ethers.parseEther('10'),
    );
    // advance epoch
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    const ep2 = await Chronos.getCurrentEpoch();
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      ep2,
      identityId,
      dKey,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(ep2, SCALE18);
    await RandomSamplingStorage.addToNodeEpochScore(ep2, identityId, SCALE18);
    await EpochStorage.addTokensToEpochRange(
      1,
      ep2,
      ep2,
      hre.ethers.parseEther('10'),
    );
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Claim epoch2 only (epoch1 older) should revert first
    await expect(
      Staking.claimDelegatorRewards(identityId, ep2, accounts[0].address),
    ).to.be.revertedWith('Must claim older epochs first');

    // Claim epoch1 → rolling should accumulate (but not restake)
    await Staking.claimDelegatorRewards(identityId, ep1, accounts[0].address);
    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(
        identityId,
        accounts[0].address,
      ),
    ).to.be.gt(0);

    // Claim epoch2 now – rolling flushed to stake
    await Staking.claimDelegatorRewards(identityId, ep2, accounts[0].address);
    expect(
      await DelegatorsInfo.getDelegatorRollingRewards(
        identityId,
        accounts[0].address,
      ),
    ).to.equal(0);
  });

  /**********************************************************************
   * Operator-Fee Corner-Case tests
   **********************************************************************/
  it('🔄 Two consecutive operator-fee withdrawal requests accumulate', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('100');
    // seed operator-fee balance
    await StakingStorage.setOperatorFeeBalance(identityId, feeBal);

    // 1️⃣ first request 40 TRAC
    const first = hre.ethers.parseEther('40');
    await Staking.requestOperatorFeeWithdrawal(identityId, first);

    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal - first,
      'Balance should be equal to feeBal - first',
    );

    // 2️⃣ second request 30 TRAC – should accumulate
    const second = hre.ethers.parseEther('30');
    await Staking.requestOperatorFeeWithdrawal(identityId, second);

    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal - first - second,
      'Balance should reflect both deductions',
    );
    const [amount, , release] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(amount).to.equal(
      first + second,
      'Second request should be added to the first one',
    );
    expect(release).to.be.gt(0, 'Release timestamp set');
  });

  it('cancelOperatorFeeWithdrawal replenishes balance and deletes request', async () => {
    const { identityId } = await createProfile();
    await StakingStorage.setOperatorFeeBalance(identityId, 40n);
    await Staking.requestOperatorFeeWithdrawal(identityId, 30n);
    await Staking.cancelOperatorFeeWithdrawal(identityId);
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      40n,
      'Balance should be equal to 40',
    );
    const [amt] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(amt).to.equal(0n, 'Amount should be 0');
  });

  it('✅ Cancel withdrawal then restake pending operator fee', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('50');
    await StakingStorage.setOperatorFeeBalance(identityId, feeBal);
    const withdrawAmt = hre.ethers.parseEther('20');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawAmt);

    // Cancel it
    await Staking.cancelOperatorFeeWithdrawal(identityId);
    const [amountAfter] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(amountAfter).to.equal(
      0,
      'Withdrawal request should be cleared after cancel',
    );
    // balance back to original
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal,
    );

    // Restake the same 20
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const stakeBefore = await StakingStorage.getNodeStake(identityId);
    await Staking.restakeOperatorFee(identityId, withdrawAmt);
    expect(await StakingStorage.getOperatorFeeBalance(identityId)).to.equal(
      feeBal - withdrawAmt,
      'Balance should be equal to feeBal - withdrawAmt',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      stakeBefore + withdrawAmt,
      'Stake should be equal to stakeBefore + withdrawAmt',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, delegatorKey),
    ).to.equal(withdrawAmt, 'Delegator stake should be equal to withdrawAmt');
  });

  it('⛔️ Restake 0 operator-fee while withdrawal pending should revert', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('10');
    await StakingStorage.setOperatorFeeBalance(identityId, feeBal);
    const withdrawAmt = hre.ethers.parseEther('5');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawAmt);
    await expect(
      Staking.restakeOperatorFee(identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('🔒 Only profile admin can access operator-fee functions', async () => {
    // admin = accounts[0], operational = accounts[1]
    const { identityId } = await createProfile(accounts[0], accounts[1]);
    await StakingStorage.setOperatorFeeBalance(
      identityId,
      hre.ethers.parseEther('10'),
    );
    const other = accounts[2];

    const expectOnlyAdmin = async (
      promise: Promise<any>, // eslint-disable-line @typescript-eslint/no-explicit-any
    ) =>
      expect(promise).to.be.revertedWithCustomError(
        Staking,
        'OnlyProfileAdminFunction',
      );

    await expectOnlyAdmin(
      Staking.connect(other).requestOperatorFeeWithdrawal(identityId, 1),
    );
    await expectOnlyAdmin(
      Staking.connect(other).cancelOperatorFeeWithdrawal(identityId),
    );
    await expectOnlyAdmin(
      Staking.connect(other).restakeOperatorFee(identityId, 1),
    );
  });

  it('📈 Operator-fee percentage path: fee credited once and only once', async () => {
    // 0️⃣ setup profile with 10% operator fee
    const { identityId } = await createProfile();
    // update operator fee to 10% (1000 ‱)
    await Profile.updateOperatorFee(identityId, 1000);

    // Delegator addresses
    const deleg1 = accounts[0];
    const deleg2 = accounts[1];

    // 1️⃣ both delegators stake 1 000 TRAC each
    const stakeAmt = hre.ethers.parseEther('1000');
    for (const d of [deleg1, deleg2]) {
      await Token.mint(d.address, stakeAmt);
      await Token.connect(d).approve(await Staking.getAddress(), stakeAmt);
      await Staking.connect(d).stake(identityId, stakeAmt);
    }
    // 2️⃣ create rewards for current epoch
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    const epochNow = await Chronos.getCurrentEpoch();
    const dKey1 = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [deleg1.address]),
    );
    const dKey2 = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [deleg2.address]),
    );
    const rewardPool = hre.ethers.parseEther('100');

    await RandomSamplingStorage.addToNodeEpochScore(
      epochNow,
      identityId,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(epochNow, SCALE18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epochNow,
      identityId,
      dKey1,
      SCALE18 / 2n,
    );
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epochNow,
      identityId,
      dKey2,
      SCALE18 / 2n,
    );
    await EpochStorage.addTokensToEpochRange(1, epochNow, epochNow, rewardPool);

    // 3️⃣ advance to next epoch so epochNow < currentEpoch
    const ttn = await Chronos.timeUntilNextEpoch();
    await time.increase(ttn + 1n);
    // operator fee balance before claims
    const opBalBefore = await StakingStorage.getOperatorFeeBalance(identityId);
    // 4️⃣ first delegator claims → fee credited once
    await Staking.connect(deleg1).claimDelegatorRewards(
      identityId,
      epochNow,
      deleg1.address,
    );
    const opBalAfterFirst =
      await StakingStorage.getOperatorFeeBalance(identityId);
    const expectedFee = rewardPool / 10n; // 10%
    expect(opBalAfterFirst - opBalBefore).to.equal(
      expectedFee,
      'Operator-fee balance should increase by 10% of pool',
    );
    // flag must be set
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(
      await DelegatorsInfo.isOperatorFeeClaimedForEpoch(identityId, epochNow),
    ).to.be.true;
    // 5️⃣ second delegator claims → fee NOT added again
    await Staking.connect(deleg2).claimDelegatorRewards(
      identityId,
      epochNow,
      deleg2.address,
    );
    const opBalAfterSecond =
      await StakingStorage.getOperatorFeeBalance(identityId);
    expect(opBalAfterSecond).to.equal(
      opBalAfterFirst,
      'Operator-fee balance should not change on second claim',
    );
    // Leftover rewards recorded for delegators should be 90% of pool
    const leftover = await DelegatorsInfo.getNetNodeEpochRewards(
      identityId,
      epochNow,
    );
    expect(leftover).to.equal(
      rewardPool - expectedFee,
      'Leftover rewards for delegators should be 90% of pool',
    );
  });

  /**********************************************************************
   * Claim guards & batch claiming
   **********************************************************************/

  it('⛔️ Double-claim guard: second claim reverts', async () => {
    const { identityId } = await createProfile();
    const deleg = accounts[0];
    const stake = hre.ethers.parseEther('100');
    await Token.mint(deleg.address, stake);
    await Token.connect(deleg).approve(await Staking.getAddress(), stake);
    await Staking.connect(deleg).stake(identityId, stake);

    // produce rewards for epoch E
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    const epochE = await Chronos.getCurrentEpoch();
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [deleg.address]),
    );
    await RandomSamplingStorage.addToNodeEpochScore(
      epochE,
      identityId,
      SCALE18,
    );
    await RandomSamplingStorage.addToAllNodesEpochScore(epochE, SCALE18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epochE,
      identityId,
      dKey,
      SCALE18,
    );

    await EpochStorage.addTokensToEpochRange(
      1,
      epochE,
      epochE,
      hre.ethers.parseEther('10'),
    );

    // advance to next epoch so claims are allowed
    const ttn = await Chronos.timeUntilNextEpoch();
    await time.increase(ttn + 1n);

    // first claim succeeds
    await Staking.connect(deleg).claimDelegatorRewards(
      identityId,
      epochE,
      deleg.address,
    );
    // second claim should revert
    await expect(
      Staking.connect(deleg).claimDelegatorRewards(
        identityId,
        epochE,
        deleg.address,
      ),
    ).to.be.revertedWith('Already claimed all finalised epochs');
  });

  it('✅ batchClaimDelegatorRewards happy-path (2 epochs × 2 delegators)', async () => {
    const { identityId } = await createProfile();
    const deleg1 = accounts[0];
    const deleg2 = accounts[1];

    const stake = hre.ethers.parseEther('50');
    for (const d of [deleg1, deleg2]) {
      await Token.mint(d.address, stake);
      await Token.connect(d).approve(await Staking.getAddress(), stake);
      await Staking.connect(d).stake(identityId, stake);
    }
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    // epochs E1 and E2
    const epoch1 = await Chronos.getCurrentEpoch();
    const epoch2 = epoch1 + 1n;

    const makeRewards = async (ep: bigint) => {
      for (const d of [deleg1, deleg2]) {
        const dKey = hre.ethers.keccak256(
          hre.ethers.solidityPacked(['address'], [d.address]),
        );
        await RandomSamplingStorage.addToEpochNodeDelegatorScore(
          ep,
          identityId,
          dKey,
          SCALE18 / 2n,
        );
      }
      await RandomSamplingStorage.addToNodeEpochScore(ep, identityId, SCALE18);
      await RandomSamplingStorage.addToAllNodesEpochScore(ep, SCALE18);
      await EpochStorage.addTokensToEpochRange(
        1,
        ep,
        ep,
        hre.ethers.parseEther('10'),
      );
    };

    await makeRewards(epoch1);
    // advance to epoch2
    let inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);
    await makeRewards(epoch2);
    // advance to epoch3 so both epochs are claimable
    inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);
    // batch claim
    await Staking.batchClaimDelegatorRewards(
      identityId,
      [epoch1, epoch2],
      [deleg1.address, deleg2.address],
    );
    // verify lastClaimedEpoch for both delegators == epoch2
    for (const d of [deleg1, deleg2]) {
      const last = await DelegatorsInfo.getLastClaimedEpoch(
        identityId,
        d.address,
      );
      expect(last).to.equal(
        epoch2,
        'Last claimed epoch should be equal to epoch2',
      );
    }
  });

  /**********************************************************************
   * Withdrawal corner-cases
   **********************************************************************/

  it('🔀 Multiple withdrawal requests merge amounts', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('1000');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // first request 300
    const req1 = hre.ethers.parseEther('300');
    await Staking.requestWithdrawal(identityId, req1);
    // second request 200
    const req2 = hre.ethers.parseEther('200');
    await Staking.requestWithdrawal(identityId, req2);

    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const [pending, ,] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );
    expect(pending).to.equal(req1 + req2, 'Request amount should accumulate');

    // node stake reduced by 500
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      stakeAmt - req1 - req2,
    );
  });

  it('↩️ cancelWithdrawal partially restakes when near maximumStake', async () => {
    // shrink maximumStake for easier maths
    const smallMax = hre.ethers.parseEther('20');
    await ParametersStorage.setMaximumStake(smallMax);

    const { identityId } = await createProfile();

    // Delegator A stakes maxStake (20)
    await Token.mint(accounts[0].address, smallMax);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      smallMax,
    );
    await Staking.stake(identityId, smallMax);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Delegator A requests withdrawal 10 → node stake becomes 10
    const withdrawAmt = hre.ethers.parseEther('10');
    await Staking.requestWithdrawal(identityId, withdrawAmt);

    // Delegator B stakes 8 so node stake becomes 18
    await Token.mint(accounts[2].address, hre.ethers.parseEther('8'));
    await Token.connect(accounts[2]).approve(
      await Staking.getAddress(),
      hre.ethers.parseEther('8'),
    );
    await Staking.connect(accounts[2]).stake(
      identityId,
      hre.ethers.parseEther('8'),
    );

    // Snapshot before cancel
    const dKeyA = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const dKeyB = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    const [, , tsBefore] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKeyA,
    );
    const stakeBefore = await StakingStorage.getNodeStake(identityId); // should be 18

    await Staking.cancelWithdrawal(identityId);

    // After cancel: 2 restaked, 8 pending
    const [pendingAfter, , tsAfter] =
      await StakingStorage.getDelegatorWithdrawalRequest(identityId, dKeyA);
    expect(pendingAfter).to.equal(
      hre.ethers.parseEther('8'),
      'Delegator 1 still has 8 pending in withdrawal',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      stakeBefore + hre.ethers.parseEther('2'),
      'Node stake should be 18 + 2 = 20',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, dKeyA),
    ).to.equal(hre.ethers.parseEther('12'), 'Delegator A stake should be 12');
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, dKeyB),
    ).to.equal(hre.ethers.parseEther('8'), 'Delegator B stake should be 8');
    expect(tsAfter).to.equal(tsBefore, 'Release timestamp must stay unchanged');
  });

  /**********************************************************************
   * Maximum / Minimum stake edge behaviours
   **********************************************************************/

  it('🎯 Restake operator-fee hits maximumStake exactly, +1 wei reverts', async () => {
    const { identityId } = await createProfile();
    const maxStake = await ParametersStorage.maximumStake();

    // Stake maxStake - 2
    const base = maxStake - 2n;
    await Token.mint(accounts[0].address, base);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), base);
    await Staking.stake(identityId, base);

    // Put operator-fee balance 3 wei (2 to reach max, 1 to exceed)
    await StakingStorage.setOperatorFeeBalance(identityId, 3n);

    // Restake 2 – should succeed and hit the cap exactly
    await expect(Staking.restakeOperatorFee(identityId, 2n)).to.not.be.reverted;
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      maxStake,
      'Node stake should be equal to maxStake',
    );

    // Restake +1 wei – should revert
    await expect(
      Staking.restakeOperatorFee(identityId, 1n),
    ).to.be.revertedWithCustomError(Staking, 'MaximumStakeExceeded');
  });

  it('↩️ cancelWithdrawal fully restakes when node well below maximumStake', async () => {
    const { identityId } = await createProfile();

    // Use current maximumStake as cap reference
    const maxStake = await ParametersStorage.maximumStake();

    // Stake a small fraction of the cap (10%) so there is ample head-room
    const baseStake = maxStake / 10n;
    await Token.mint(accounts[0].address, baseStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      baseStake,
    );
    await Staking.stake(identityId, baseStake);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Request withdrawal of half that stake
    const withdrawAmt = baseStake / 2n;
    await Staking.requestWithdrawal(identityId, withdrawAmt);

    // Snapshot state before cancel
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const [pendingBefore] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );

    // Sanity – pending equals requested amount
    expect(pendingBefore).to.equal(
      withdrawAmt,
      'Pending should be equal to requested amount',
    );

    // Cancel the withdrawal – should restake full amount (pending becomes 0)
    await Staking.cancelWithdrawal(identityId);

    // After cancel
    const [pendingAfter] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );
    expect(pendingAfter).to.equal(
      0n,
      'All pending amount should have been restaked',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      baseStake,
      'Node stake should be equal to stakeBefore + withdrawAmt',
    );
    expect(await StakingStorage.getTotalStake()).to.equal(
      baseStake,
      'Total stake should be equal to totalBefore + withdrawAmt',
    );

    // Delegator should still be registered for the node
    expect(
      await DelegatorsInfo.isNodeDelegator(identityId, accounts[0].address),
    ).to.equal(true, 'Delegator should still be registered for the node');
  });

  it('↩️ cancelWithdrawal does NOT restake when node already at maximumStake', async () => {
    // Shrink maximumStake for deterministic maths
    const smallMax = hre.ethers.parseEther('20');
    await ParametersStorage.setMaximumStake(smallMax);

    const { identityId } = await createProfile();

    // Delegator A stakes the full max
    await Token.mint(accounts[0].address, smallMax);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      smallMax,
    );
    await Staking.stake(identityId, smallMax);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Delegator A requests withdrawal of 10
    const withdrawAmt = hre.ethers.parseEther('10');
    await Staking.requestWithdrawal(identityId, withdrawAmt);

    // Delegator B fills the gap so node stake is back at the cap
    await Token.mint(accounts[2].address, withdrawAmt);
    await Token.connect(accounts[2]).approve(
      await Staking.getAddress(),
      withdrawAmt,
    );
    await Staking.connect(accounts[2]).stake(identityId, withdrawAmt);

    // Ensure node stake equals the maximum before cancel
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(smallMax);

    // Snapshot state
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const [pendingBefore, , tsBefore] =
      await StakingStorage.getDelegatorWithdrawalRequest(identityId, dKey);
    const totalBefore = await StakingStorage.getTotalStake();

    // Cancel withdrawal – should NOT restake anything
    await Staking.cancelWithdrawal(identityId);

    const [pendingAfter, , tsAfter] =
      await StakingStorage.getDelegatorWithdrawalRequest(identityId, dKey);
    expect(pendingAfter).to.equal(
      pendingBefore,
      'Pending amount should remain unchanged',
    );
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      smallMax,
      'Node stake should remain at maximum',
    );
    expect(await StakingStorage.getTotalStake()).to.equal(
      totalBefore,
      'Total stake should be unchanged',
    );
    expect(tsAfter).to.equal(
      tsBefore,
      'Release timestamp should stay the same',
    );

    // Delegator remains registered
    expect(
      await DelegatorsInfo.isNodeDelegator(identityId, accounts[0].address),
    ).to.equal(true, 'Delegator should still be registered for the node');
  });

  /**********************************************************************
   * Claim-pointer auto-advance & delegator-removal behaviours
   **********************************************************************/

  it('🚦 _validateDelegatorEpochClaims auto-advances when previous epoch has no score', async () => {
    const { identityId } = await createProfile();
    // Stake some amount in the current epoch
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);

    // Snapshot lastClaimedEpoch after initial stake
    const lastClaimedBefore = await DelegatorsInfo.getLastClaimedEpoch(
      identityId,
      accounts[0].address,
    );

    // Advance to the next epoch WITHOUT adding any scores
    const inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);
    // Current and previous epoch values
    const currentEpoch = await Chronos.getCurrentEpoch();
    const prevEpoch = currentEpoch - 1n;

    // Attempt to change stake (add 10) – should NOT revert because helper auto-advances
    const addAmt = hre.ethers.parseEther('10');
    await Token.mint(accounts[0].address, addAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      addAmt,
    );
    await expect(Staking.stake(identityId, addAmt)).to.not.be.reverted;
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      amount + addAmt,
      'Node stake should be equal to amount + addAmt',
    );

    // Verify the claim pointer was auto-advanced to prevEpoch
    const lastClaimedAfter = await DelegatorsInfo.getLastClaimedEpoch(
      identityId,
      accounts[0].address,
    );
    expect(lastClaimedAfter).to.equal(
      prevEpoch,
      'Last claimed epoch should auto-advance to previous epoch',
    );
    expect(lastClaimedAfter).to.be.gt(
      lastClaimedBefore,
      'Pointer must advance',
    );
  });

  it('👤 _handleDelegatorRemovalOnZeroStake keeps delegator when they earned score in epoch', async () => {
    const { identityId } = await createProfile();
    // Stake
    const stakeAmt = hre.ethers.parseEther('50');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Add some score for the current epoch so delegatorEpochScore18 > 0
    const epoch = await Chronos.getCurrentEpoch();
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      epoch,
      identityId,
      dKey,
      SCALE18,
    );

    // Withdraw ALL stake
    await Staking.requestWithdrawal(identityId, stakeAmt);

    // Delegator should still be registered & lastStakeHeldEpoch == currentEpoch
    const lastStakeHeld = await DelegatorsInfo.getLastStakeHeldEpoch(
      identityId,
      accounts[0].address,
    );
    expect(lastStakeHeld).to.equal(
      epoch,
      'lastStakeHeldEpoch must be set to current epoch',
    );
    expect(
      await DelegatorsInfo.isNodeDelegator(identityId, accounts[0].address),
    ).to.equal(true, 'Delegator should still be registered for the node');
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, dKey),
    ).to.equal(0n, 'Delegator stake should be 0');
  });

  it('👥 _handleDelegatorRemovalOnZeroStake removes delegator when no score earned in epoch', async () => {
    const { identityId } = await createProfile();
    // Stake
    const stakeAmt = hre.ethers.parseEther('40');
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // No score added for current epoch

    // Withdraw ALL stake
    await Staking.requestWithdrawal(identityId, stakeAmt);

    // Delegator should be removed immediately (isNodeDelegator == false) and lastStakeHeldEpoch == 0
    const lastStakeHeld = await DelegatorsInfo.getLastStakeHeldEpoch(
      identityId,
      accounts[0].address,
    );
    expect(lastStakeHeld).to.equal(0n, 'lastStakeHeldEpoch must stay zero');
    expect(
      await DelegatorsInfo.isNodeDelegator(identityId, accounts[0].address),
    ).to.equal(false, 'Delegator should be removed');
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, dKey),
    ).to.equal(0n, 'Delegator stake should be 0');
  });

  it('🪫 zero-stake restake bumps index without adding score', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('10');
    // Stake initial amount
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Withdraw full stake and finalise so stakeBase becomes 0
    await Staking.requestWithdrawal(identityId, stakeAmt);
    // advance time to let withdrawal finalise
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const [, , ts] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );
    await time.increaseTo(BigInt(ts));
    await Staking.finalizeWithdrawal(identityId);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(
      0n,
      'Node stake should be 0',
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, dKey),
    ).to.equal(0n, 'Delegator stake should be 0');

    // Move to next epoch
    const inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);
    const epoch = await Chronos.getCurrentEpoch();

    // Manually set a non-zero nodeScorePerStake so prepare branches
    const perStake = 123n;
    await RandomSamplingStorage.addToNodeEpochScorePerStake(
      epoch,
      identityId,
      perStake,
    );

    // Sanity: delegator score for epoch should be zero
    expect(
      await RandomSamplingStorage.getEpochNodeDelegatorScore(
        epoch,
        identityId,
        dKey,
      ),
    ).to.equal(0n);

    // Restake 1 wei (will invoke _prepareForStakeChange with stakeBase==0)
    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await Staking.stake(identityId, 1n);

    // Index should now equal perStake and score still zero
    expect(
      await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
        epoch,
        identityId,
        dKey,
      ),
    ).to.equal(
      perStake,
      'Delegator last settled node epoch score per stake should be equal to perStake',
    );
    expect(
      await RandomSamplingStorage.getEpochNodeDelegatorScore(
        epoch,
        identityId,
        dKey,
      ),
    ).to.equal(0n, 'Delegator score for epoch should be 0');
  });

  it('💸 finalizeOperatorFeeWithdrawal happy-path updates cumulatives and transfers tokens', async () => {
    const { identityId } = await createProfile();
    const initialFeeBalance = hre.ethers.parseEther('150');
    await StakingStorage.setOperatorFeeBalance(identityId, initialFeeBalance);

    // Request withdrawal of 60
    const withdrawAmt = hre.ethers.parseEther('60');
    await Staking.requestOperatorFeeWithdrawal(identityId, withdrawAmt);
    // capture request release timestamp from storage
    const [, , releaseTs] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);

    // Mint tokens to the StakingStorage contract so withdrawal can succeed
    await Token.mint(await StakingStorage.getAddress(), withdrawAmt);

    // Snapshot cumulative paid-out before
    const paidOutBefore =
      await StakingStorage.getOperatorFeeCumulativePaidOutRewards(identityId);
    const balBefore = await Token.balanceOf(accounts[0].address);

    // Advance time to release
    await time.increaseTo(BigInt(releaseTs));
    await Staking.finalizeOperatorFeeWithdrawal(identityId);

    const paidOutAfter =
      await StakingStorage.getOperatorFeeCumulativePaidOutRewards(identityId);
    const balAfter = await Token.balanceOf(accounts[0].address);

    expect(paidOutAfter).to.equal(
      paidOutBefore + withdrawAmt,
      'Cumulative paid-out should increase',
    );
    expect(balAfter - balBefore).to.equal(
      withdrawAmt,
      'Admin balance should increase by withdrawn amount',
    );
    // Request should be cleared after finalization
    const [reqAmtAfter] =
      await StakingStorage.getOperatorFeeWithdrawalRequest(identityId);
    expect(reqAmtAfter).to.equal(
      0,
      'Withdrawal request amount should be zero after finalization',
    );
  });

  it('🚫 batchClaimDelegatorRewards reverts when older epochs unclaimed', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('30');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);

    // Move to next epoch E2
    let inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);
    const epoch2 = await Chronos.getCurrentEpoch();
    // Advance to E3 so both previous epochs are claimable
    inc = await Chronos.timeUntilNextEpoch();
    await time.increase(inc + 1n);

    // Attempt batch claim skipping epoch1 – expect revert
    await expect(
      Staking.batchClaimDelegatorRewards(
        identityId,
        [epoch2],
        [accounts[0].address],
      ),
    ).to.be.revertedWith('Must claim older epochs first');
  });

  /**********************************************************************
   * Token/Allowance & sharding-table guards
   **********************************************************************/

  it('⛔️ redelegate with 0 amount reverts ZeroTokenAmount', async () => {
    const { identityId: fromId } = await createProfile(undefined, accounts[3]);
    const { identityId: toId } = await createProfile(undefined, accounts[4]);
    await expect(
      Staking.redelegate(fromId, toId, 0n),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('📈 ShardingTableIsFull guard triggers when limit reached', async () => {
    // Reduce table size for test speed
    await ParametersStorage.setShardingTableSizeLimit(2);
    const minStake = await ParametersStorage.minimumStake();

    let opIndex = 3;
    const stakeNode = async () => {
      const { identityId } = await createProfile(
        undefined,
        accounts[opIndex++],
      );
      await Token.mint(accounts[0].address, minStake);
      await Token.connect(accounts[0]).approve(
        await Staking.getAddress(),
        minStake,
      );
      await Staking.stake(identityId, minStake);
    };

    await stakeNode(); // node 1
    await stakeNode(); // node 2 – at limit

    const { identityId: overflowId } = await createProfile(
      undefined,
      accounts[opIndex++],
    );
    await Token.mint(accounts[0].address, minStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      minStake,
    );
    await expect(
      Staking.stake(overflowId, minStake),
    ).to.be.revertedWithCustomError(Staking, 'ShardingTableIsFull');
  });

  it('📣 emits OperatorFeeBalanceUpdated and DelegatorBaseStakeUpdated on restakeOperatorFee', async () => {
    const { identityId } = await createProfile();
    // Seed operator fee balance
    const initialFee = 50n;
    await StakingStorage.setOperatorFeeBalance(identityId, initialFee);

    // ensure node has stake
    const stakeAmt = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);

    const restakeAmt = 20n;
    const newFeeBal = initialFee - restakeAmt;
    const delegatorKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const baseBefore = await StakingStorage.getDelegatorStakeBase(
      identityId,
      delegatorKey,
    );

    const tx = await Staking.restakeOperatorFee(identityId, restakeAmt);

    await expect(tx)
      .to.emit(StakingStorage, 'OperatorFeeBalanceUpdated')
      .withArgs(identityId, newFeeBal);

    await expect(tx)
      .to.emit(StakingStorage, 'DelegatorBaseStakeUpdated')
      .withArgs(identityId, delegatorKey, baseBefore + restakeAmt);
  });

  /**********************************************************************
   * Events & sharding‑table transition on redelegate
   **********************************************************************/
  it('Moves both nodes in sharding table', async () => {
    const nodeA = await createProfile();
    const nodeB = await createProfile(accounts[0], accounts[2]);

    // make nodeA eligible for the table
    const minStake = await ParametersStorage.minimumStake();
    await Token.mint(accounts[0].address, minStake);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      minStake,
    );
    await Staking.stake(nodeA.identityId, minStake);

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await ShardingTableStorage.nodeExists(nodeA.identityId)).to.be.true;

    await Staking.redelegate(nodeA.identityId, nodeB.identityId, minStake);

    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await ShardingTableStorage.nodeExists(nodeA.identityId)).to.be.false;
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    expect(await ShardingTableStorage.nodeExists(nodeB.identityId)).to.be.true;
  });

  /**********************************************************************
   * Withdrawal “fast‑path” when node is above new maximumStake
   **********************************************************************/
  it('requestWithdrawal transfers immediately when newStake ≥ lowered maximumStake', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // Governance lowers the cap below current stake – makes the branch reachable
    const newMax = stakeAmt - hre.ethers.parseEther('10');
    await ParametersStorage.setMaximumStake(newMax);

    const balBefore = await Token.balanceOf(accounts[0].address);
    const withdraw = hre.ethers.parseEther('5');

    await Staking.requestWithdrawal(identityId, withdraw);
    const balAfter = await Token.balanceOf(accounts[0].address);

    expect(balAfter - balBefore).to.equal(
      withdraw,
      'payout should be immediate',
    );

    const [pending] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [accounts[0].address]),
      ),
    );
    expect(pending).to.equal(0n, 'no pending request stored');
  });

  /**********************************************************************
   * Operator‑fee withdrawal: merge‑then‑exceed should revert
   **********************************************************************/
  it('requestOperatorFeeWithdrawal amount exceeds operator fee balance reverts', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('100');
    await StakingStorage.setOperatorFeeBalance(identityId, feeBal);

    await Staking.requestOperatorFeeWithdrawal(
      identityId,
      hre.ethers.parseEther('80'),
    ); // existing request

    await expect(
      Staking.requestOperatorFeeWithdrawal(
        identityId,
        hre.ethers.parseEther('30'),
      ), // 80+30 > 100
    ).to.be.revertedWithCustomError(Staking, 'AmountExceedsOperatorFeeBalance');
  });

  /**********************************************************************
   * restakeOperatorFee updates cumulativePaidOut bookkeeping
   **********************************************************************/
  it('restakeOperatorFee bumps cumulativePaidOut', async () => {
    const { identityId } = await createProfile();
    const feeBal = hre.ethers.parseEther('50');
    await StakingStorage.setOperatorFeeBalance(identityId, feeBal);

    const before =
      await StakingStorage.getOperatorFeeCumulativePaidOutRewards(identityId);
    const restake = hre.ethers.parseEther('20');
    await Staking.restakeOperatorFee(identityId, restake);
    const after =
      await StakingStorage.getOperatorFeeCumulativePaidOutRewards(identityId);

    expect(after - before).to.equal(restake);
  });

  /**********************************************************************
   * _validateDelegatorEpochClaims: must‑claim‑before‑re‑stake guard
   **********************************************************************/
  it('Re-stake after full exit with unclaimed score reverts', async () => {
    const { identityId } = await createProfile();
    const stakeAmt = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, stakeAmt);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      stakeAmt,
    );
    await Staking.stake(identityId, stakeAmt);
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    // give delegator some score in the current epoch
    const curEp = await Chronos.getCurrentEpoch();
    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const SCALE18 = hre.ethers.parseUnits('1', 18);
    await RandomSamplingStorage.addToEpochNodeDelegatorScore(
      curEp,
      identityId,
      dKey,
      SCALE18,
    );

    // withdraw everything and finalise
    await Staking.requestWithdrawal(identityId, stakeAmt);
    const [, , ts] = await StakingStorage.getDelegatorWithdrawalRequest(
      identityId,
      dKey,
    );
    expect(curEp).to.equal(
      await DelegatorsInfo.getLastStakeHeldEpoch(
        identityId,
        accounts[0].address,
      ),
    );
    await time.increaseTo(BigInt(ts));
    await Staking.finalizeWithdrawal(identityId);

    // hop to next epoch – the rewards are now claimable
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    await Token.mint(accounts[0].address, 1n);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1n);
    await expect(Staking.stake(identityId, 1n)).to.be.revertedWith(
      'Must claim rewards up to the lastStakeHeldEpoch before changing stake',
    );
  });

  /**********************************************************************
   * claimDelegatorRewards basic guards
   **********************************************************************/
  it('claimDelegatorRewards reverts for non-finalised epoch & unknown delegator', async () => {
    const { identityId } = await createProfile();
    // epoch not finalised
    await expect(
      Staking.claimDelegatorRewards(
        identityId,
        await Chronos.getCurrentEpoch(),
        accounts[0].address,
      ),
    ).to.be.revertedWith('Epoch not finalised');

    // move one epoch forward; now previous epoch is finalised
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);
    await expect(
      Staking.claimDelegatorRewards(
        identityId,
        (await Chronos.getCurrentEpoch()) - 1n,
        accounts[5].address,
      ),
    ).to.be.revertedWith('Delegator not found');
  });

  it('reverts when claiming rewards for currentEpoch + 1', async () => {
    const { identityId } = await createProfile();
    const epochPlus = (await Chronos.getCurrentEpoch()) + 1n;
    await expect(
      Staking.claimDelegatorRewards(identityId, epochPlus, accounts[0].address),
    ).to.be.revertedWith('Epoch not finalised');
  });

  it('handles claim when node score is zero (no rewards)', async () => {
    const { identityId } = await createProfile();
    await Token.mint(accounts[0].address, 1000);
    await Token.connect(accounts[0]).approve(await Staking.getAddress(), 1000);
    await Staking.stake(identityId, 1000);

    const epoch = await Chronos.getCurrentEpoch();
    // finalise epoch without adding scores
    await time.increase((await Chronos.timeUntilNextEpoch()) + 1n);

    const dKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    const balBefore = await StakingStorage.getDelegatorStakeBase(
      identityId,
      dKey,
    );
    await Staking.claimDelegatorRewards(identityId, epoch, accounts[0].address);
    const balAfter = await StakingStorage.getDelegatorStakeBase(
      identityId,
      dKey,
    );
    expect(balAfter).to.equal(balBefore); // stake unchanged
    // pointer advanced
    expect(
      await DelegatorsInfo.getLastClaimedEpoch(identityId, accounts[0].address),
    ).to.equal(epoch);
  });

  /**********************************************************************
   * V10 Phase 4 — _recordStake (two-layer staking wire, decision #13)
   *
   * The NFT path uses `bytes32(tokenId)` as the delegator key in
   * StakingStorage, disjoint from the V8 legacy `keccak256(address)`
   * key space. This lets multiple NFTs for the same delegator/node
   * pair be settled independently without colliding with the V8
   * stake() path.
   **********************************************************************/

  // Helper: convert uint256 tokenId -> bytes32 key (same encoding as Solidity
  // `bytes32(uint256(tokenId))`).
  const tokenIdKey = (tokenId: bigint | number): string =>
    hre.ethers.zeroPadValue(hre.ethers.toBeHex(tokenId), 32);

  // Helper: register a signer under a Hub contract name so onlyContracts
  // and the NFT-identity gate see it as the expected caller.
  const impersonateHubContract = async (
    name: string,
    signer: SignerWithAddress,
  ) => {
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress(name, signer.address);
  };

  it('_recordStake: NFT caller succeeds and writes bytes32(tokenId) key', async () => {
    const { identityId } = await createProfile();
    const nftSigner = accounts[5];
    const minStake = await ParametersStorage.minimumStake();
    const amount = minStake; // use minStake so sharding add path is also exercised

    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);

    const tokenId = 1n;
    const lockEpochs = 12;

    const totalBefore = await StakingStorage.getTotalStake();

    const tx = await Staking.connect(nftSigner)[
      '_recordStake'
    ](tokenId, identityId, amount, lockEpochs);
    await expect(tx)
      .to.emit(Staking, 'StakeRecorded')
      .withArgs(tokenId, identityId, amount, lockEpochs, nftSigner.address);

    // bytes32(tokenId) delegator key has the stake
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(tokenId)),
    ).to.equal(amount);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(amount);
    expect(await StakingStorage.getTotalStake()).to.equal(totalBefore + amount);

    // V8 legacy key (keccak256(nftSigner.address)) is NOT credited
    const legacyKey = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [nftSigner.address]),
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, legacyKey),
    ).to.equal(0);

    // Node should be in sharding table (we staked exactly minStake)
    expect(await ShardingTableStorage.nodeExists(identityId)).to.equal(true);
  });

  it('_recordStake: reverts when caller is a random EOA (onlyContracts gate)', async () => {
    const { identityId } = await createProfile();
    const randomEOA = accounts[9]; // not registered in Hub, not owner
    await expect(
      Staking.connect(randomEOA)[
        '_recordStake'
      ](1n, identityId, 1000, 12),
    ).to.be.revertedWithCustomError(Staking, 'UnauthorizedAccess');
  });

  it('_recordStake: reverts with OnlyConvictionNFT for a Hub contract that is NOT the NFT contract', async () => {
    const { identityId } = await createProfile();
    // Register a signer as DKGStakingConvictionNFT so the identity lookup
    // resolves, then register a DIFFERENT signer as another Hub contract.
    // The second signer passes `onlyContracts` but fails the explicit
    // NFT-identity gate, which is exactly what OnlyConvictionNFT guards.
    await impersonateHubContract('DKGStakingConvictionNFT', accounts[5]);
    const fakeOther = accounts[8];
    await impersonateHubContract('FakeOtherContract', fakeOther);
    await expect(
      Staking.connect(fakeOther)[
        '_recordStake'
      ](1n, identityId, 1000, 12),
    ).to.be.revertedWithCustomError(Staking, 'OnlyConvictionNFT');
  });

  it('_recordStake: reverts on zero amount', async () => {
    const { identityId } = await createProfile();
    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);
    await expect(
      Staking.connect(nftSigner)[
        '_recordStake'
      ](1n, identityId, 0, 12),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('_recordStake: reverts with ProfileDoesntExist for an unregistered identityId', async () => {
    // Mirror of the V8 `stake()` guard. Without the profileExists modifier
    // the write path would happily stash stake against a ghost identityId and
    // _addNodeToShardingTable would insert a phantom node at
    // sha256(profileStorage.getNodeId(identityId)) — which resolves to
    // sha256("") for a missing profile — so this test locks the invariant
    // and the Phase 4 phantom-stake bug cannot reappear.
    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);
    const minStake = await ParametersStorage.minimumStake();
    const ghostIdentityId = 9999;

    await expect(
      Staking.connect(nftSigner)[
        '_recordStake'
      ](1n, ghostIdentityId, minStake, 12),
    ).to.be.revertedWithCustomError(Staking, 'ProfileDoesntExist');

    // And no phantom state leaked past the revert
    expect(
      await StakingStorage.getDelegatorStakeBase(
        ghostIdentityId,
        tokenIdKey(1n),
      ),
    ).to.equal(0);
    expect(await StakingStorage.getNodeStake(ghostIdentityId)).to.equal(0);
    expect(await ShardingTableStorage.nodeExists(ghostIdentityId)).to.equal(
      false,
    );
  });

  it('_recordStake: replaying the same tokenId on the same node reverts with TokenIdAlreadyRecorded and accounting stays consistent', async () => {
    // V10 model: each NFT is an immutable create-once position. A caller bug
    // that re-submits the same tokenId must not double-count nodeStake /
    // totalStake while overwriting the delegator base. Without the freshness
    // guard, the second call would write delegatorBase = secondAmount but
    // node total = firstAmount + secondAmount — accounting off by exactly
    // firstAmount. This test locks that guard and also asserts that the
    // revert leaves the first record untouched.
    const { identityId } = await createProfile();
    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);

    const firstAmount = 1_000n;
    const totalBefore = await StakingStorage.getTotalStake();

    await Staking.connect(nftSigner)[
      '_recordStake'
    ](7n, identityId, firstAmount, 12);

    // Replay — same tokenId on the same node — must revert.
    await expect(
      Staking.connect(nftSigner)[
        '_recordStake'
      ](7n, identityId, 9_999n, 6),
    )
      .to.be.revertedWithCustomError(Staking, 'TokenIdAlreadyRecorded')
      .withArgs(7n, identityId);

    // First record intact, no leak from the reverted replay.
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(7n)),
    ).to.equal(firstAmount);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(firstAmount);
    expect(await StakingStorage.getTotalStake()).to.equal(
      totalBefore + firstAmount,
    );
  });

  it('_recordStake: replaying the same tokenId on a DIFFERENT node reverts with TokenIdAlreadyRecorded (global scope)', async () => {
    // An NFT is bound to exactly one node for its lifetime. A per-(node,
    // tokenId) guard would miss this replay because the fresh node's
    // bucket is empty — the tokenId would end up staked on two nodes at
    // once, double-paying rewards. The fix checks
    // `getDelegatorNodesCount(bytes32(tokenId))` which tracks all nodes
    // this tokenId is currently registered on.
    const { identityId: identityA } = await createProfile();
    const { identityId: identityB } = await createProfile(
      accounts[0],
      accounts[2],
    );
    expect(identityA).to.not.equal(identityB);

    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);

    const amountA = 500n;
    const totalBefore = await StakingStorage.getTotalStake();

    // First call: record tokenId 13 on node A.
    await Staking.connect(nftSigner)[
      '_recordStake'
    ](13n, identityA, amountA, 12);

    // Sanity: tokenId 13 is now registered on exactly one node.
    expect(
      await StakingStorage.getDelegatorNodesCount(tokenIdKey(13n)),
    ).to.equal(1n);

    // Cross-node replay: same tokenId, different node — must revert.
    await expect(
      Staking.connect(nftSigner)[
        '_recordStake'
      ](13n, identityB, 777n, 6),
    )
      .to.be.revertedWithCustomError(Staking, 'TokenIdAlreadyRecorded')
      .withArgs(13n, identityB);

    // Node A still has the first record, node B untouched, totals unchanged
    // past the first call.
    expect(
      await StakingStorage.getDelegatorStakeBase(identityA, tokenIdKey(13n)),
    ).to.equal(amountA);
    expect(
      await StakingStorage.getDelegatorStakeBase(identityB, tokenIdKey(13n)),
    ).to.equal(0n);
    expect(await StakingStorage.getNodeStake(identityA)).to.equal(amountA);
    expect(await StakingStorage.getNodeStake(identityB)).to.equal(0n);
    expect(await StakingStorage.getTotalStake()).to.equal(
      totalBefore + amountA,
    );
    // Still registered on exactly one node.
    expect(
      await StakingStorage.getDelegatorNodesCount(tokenIdKey(13n)),
    ).to.equal(1n);
  });

  it('_recordStake: baselines delegatorLastSettled to the current nodeEpochScorePerStake (score-earned-before-NFT safety)', async () => {
    // Without calling _prepareForStakeChange before writing the fresh stake,
    // a later reward claim on this NFT would read
    // delegatorLastSettledNodeEpochScorePerStake = 0 and collect score the
    // node earned before the NFT existed. This test reproduces the scenario
    // (bump the node's score-per-stake index first, THEN mint the NFT) and
    // asserts the baseline is set at mint time so the claim window starts
    // from "now", not from zero. Mirrors the existing V8 zero-stake-restake
    // regression earlier in this file (search "🪫 zero-stake restake bumps
    // index without adding score") — same mechanism, NFT-keyed.
    const { identityId } = await createProfile();
    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);

    const epoch = await Chronos.getCurrentEpoch();

    // Advance the node's score-per-stake index before the NFT is minted.
    // accounts[0] is the hub owner so it can call onlyContracts setters.
    const advancedIndex = 1_234n * 10n ** 18n; // 1e18-scaled, arbitrary
    await RandomSamplingStorage.addToNodeEpochScorePerStake(
      epoch,
      identityId,
      advancedIndex,
    );

    const minStake = await ParametersStorage.minimumStake();
    await Staking.connect(nftSigner)[
      '_recordStake'
    ](42n, identityId, minStake, 12);

    // Fresh NFT's delegatorLastSettled must equal the node's current index,
    // not 0. That makes (nodeIndex_end - delegatorLastSettled) at claim time
    // count only the score earned AFTER this NFT was minted.
    const settled =
      await RandomSamplingStorage.getDelegatorLastSettledNodeEpochScorePerStake(
        epoch,
        identityId,
        tokenIdKey(42n),
      );
    expect(settled).to.equal(advancedIndex);

    // And no score was credited to the NFT for the pre-mint period.
    expect(
      await RandomSamplingStorage.getEpochNodeDelegatorScore(
        epoch,
        identityId,
        tokenIdKey(42n),
      ),
    ).to.equal(0n);
  });

  it('_recordStake: multiple tokenIds for same (delegator, node) pair are independent', async () => {
    const { identityId } = await createProfile();
    const nftSigner = accounts[5];
    await impersonateHubContract('DKGStakingConvictionNFT', nftSigner);

    const a1 = 100;
    const a2 = 250;

    await Staking.connect(nftSigner)[
      '_recordStake'
    ](1n, identityId, a1, 12);
    await Staking.connect(nftSigner)[
      '_recordStake'
    ](2n, identityId, a2, 6);

    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(1n)),
    ).to.equal(a1);
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(2n)),
    ).to.equal(a2);
    expect(await StakingStorage.getNodeStake(identityId)).to.equal(a1 + a2);
  });

  it('_recordStake: V8 legacy stake() path unchanged, delegator key stays keccak256(address)', async () => {
    // Regression: the legacy stake() path must be byte-for-byte untouched by
    // the new _recordStake entry. Same assertion as the pre-existing stake
    // test, but re-asserted here to lock the invariant against the Phase 4 change.
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('100');
    await Token.mint(accounts[0].address, amount);
    await Token.connect(accounts[0]).approve(
      await Staking.getAddress(),
      amount,
    );
    await Staking.stake(identityId, amount);

    const v8Key = hre.ethers.keccak256(
      hre.ethers.solidityPacked(['address'], [accounts[0].address]),
    );
    expect(
      await StakingStorage.getDelegatorStakeBase(identityId, v8Key),
    ).to.equal(amount);
    // And nothing was written to any small-integer tokenId key
    for (let t = 0; t < 5; t++) {
      expect(
        await StakingStorage.getDelegatorStakeBase(identityId, tokenIdKey(t)),
      ).to.equal(0);
    }
  });

  it('_recordStake: key-space disjointness — sampled keccak256(address) never equals bytes32(smallTokenId)', async () => {
    // Empirical sample — not a structural proof. `keccak256` outputs are
    // uniform over the full 256-bit space, so a collision with
    // `bytes32(smallTokenId)` is mathematically possible but has probability
    // ≈ 2⁻¹⁶⁰ per hash when `tokenId < 2⁹⁶`. We cannot prove the key spaces
    // are structurally disjoint, only that they are disjoint for realistic
    // inputs with overwhelming probability.
    //
    // This test locks the empirical guarantee for real Hardhat signer
    // addresses and small tokenIds: the first 20 bytes of each sampled
    // keccak256 are non-zero (which would require a 2⁻¹⁶⁰ freak event to
    // fail), and `bytes32(tokenId)` for `tokenId < 2⁹⁶` is zero across its
    // first 20 bytes by construction. Disjoint high-byte patterns →
    // disjoint values → no collision.
    const addrs = [
      accounts[0].address,
      accounts[1].address,
      accounts[2].address,
      accounts[3].address,
      accounts[4].address,
    ];
    for (const addr of addrs) {
      const v8 = hre.ethers.keccak256(
        hre.ethers.solidityPacked(['address'], [addr]),
      );
      // Assert at least one of the first 20 bytes of keccak256(address) is
      // non-zero. Probability of failure on any real address ≈ 2⁻¹⁶⁰.
      const v8High20 = v8.slice(2, 2 + 40); // first 20 bytes as hex
      expect(v8High20).to.not.equal('0'.repeat(40));

      for (let t = 0n; t < 10n; t++) {
        const nftKey = tokenIdKey(t);
        // For `tokenId < 2⁹⁶` (all practical NFT counters), the first 20
        // bytes of `bytes32(tokenId)` are zero by construction — the cast
        // only touches the low 12 bytes.
        expect(nftKey.slice(2, 2 + 40)).to.equal('0'.repeat(40));
        // Therefore the two values cannot be equal without a 2⁻¹⁶⁰ freak
        // collision in keccak256.
        expect(v8).to.not.equal(nftKey);
      }
    }
  });
});
