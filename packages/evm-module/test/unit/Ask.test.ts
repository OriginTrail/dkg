import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Profile,
  AskStorage,
  Ask,
  Staking,
  Hub,
  Token,
  StakingStorage,
  DelegatorsInfo,
} from '../../typechain';

type FullIntegrationFixture = {
  accounts: SignerWithAddress[];
  Profile: Profile;
  AskStorage: AskStorage;
  Ask: Ask;
  Staking: Staking;
  StakingStorage: StakingStorage;
  Token: Token;
  DelegatorsInfo: DelegatorsInfo;
};

describe('@unit Ask', () => {
  let accounts: SignerWithAddress[];
  let Profile: Profile;
  let AskStorage: AskStorage;
  let Ask: Ask;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let Token: Token;
  let DelegatorsInfo: DelegatorsInfo;

  async function deployAll(): Promise<FullIntegrationFixture> {
    await hre.deployments.fixture([
      'Profile',
      'Ask',
      'Staking',
      'Token',
      'EpochStorage',
    ]);

    Profile = await hre.ethers.getContract<Profile>('Profile');
    AskStorage = await hre.ethers.getContract<AskStorage>('AskStorage');
    Ask = await hre.ethers.getContract<Ask>('Ask');
    Staking = await hre.ethers.getContract<Staking>('Staking');
    StakingStorage =
      await hre.ethers.getContract<StakingStorage>('StakingStorage');
    Token = await hre.ethers.getContract<Token>('Token');
    const DelegatorsInfoContract =
      await hre.ethers.getContract<DelegatorsInfo>('DelegatorsInfo');

    accounts = await hre.ethers.getSigners();

    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return {
      accounts,
      Profile,
      AskStorage,
      Ask,
      Staking,
      StakingStorage,
      Token,
      DelegatorsInfo: DelegatorsInfoContract,
    };
  }

  let profileCounter: number;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Profile, Ask, Staking, Token, DelegatorsInfo } =
      await loadFixture(deployAll));
    profileCounter = 0;
  });

  const createProfile = async (
    admin: SignerWithAddress,
    operational: SignerWithAddress,
    operatorFee: number,
  ) => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    profileCounter += 1;

    const tx = await Profile.connect(operational).createProfile(
      admin.address,
      [],
      `Node ${profileCounter}`,
      nodeId,
      operatorFee * 100,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { nodeId, identityId };
  };

  it('Full flow: create profile, set ask, stake, check Ask & Staking', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 10);
    expect(identityId).to.be.gt(0);

    const newAsk = 200n;
    await Profile.connect(accounts[0]).updateAsk(identityId, newAsk);

    const stakeAmount = hre.ethers.parseUnits('60000', 18);
    await Token.mint(accounts[2].address, stakeAmount);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stakeAmount);
    await Staking.connect(accounts[2]).stake(identityId, stakeAmount);

    const totalActiveStake = await AskStorage.totalActiveStake();
    expect(totalActiveStake).to.be.equal(stakeAmount);

    const expectedWeighted = stakeAmount * newAsk;
    const weightedSum = await AskStorage.weightedActiveAskSum();
    expect(weightedSum).to.equal(expectedWeighted);

    const partialWithdraw = hre.ethers.parseUnits('10000', 18);
    await Staking.connect(accounts[2]).requestWithdrawal(
      identityId,
      partialWithdraw,
    );

    const remainingStake = stakeAmount - partialWithdraw;
    expect(await AskStorage.weightedActiveAskSum()).to.be.equal(
      remainingStake * newAsk,
    );
    expect(await AskStorage.totalActiveStake()).to.be.equal(remainingStake);
  });

  it('Edge case: set ask=0 => expect revert from Profile.updateAsk(...)', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 10);
    await expect(
      Profile.connect(accounts[0]).updateAsk(identityId, 0),
    ).to.be.revertedWithCustomError(Profile, 'ZeroAsk');
  });

  it('Edge case: stake=0 => expect revert from Staking', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 10);
    await Profile.connect(accounts[0]).updateAsk(identityId, 100n);

    await expect(
      Staking.connect(accounts[2]).stake(identityId, 0),
    ).to.be.revertedWithCustomError(Staking, 'ZeroTokenAmount');
  });

  it('Operator fee restake increases node stake correctly', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 15);
    await Profile.connect(accounts[0]).updateAsk(identityId, 250n);
    const stake70k = hre.ethers.parseUnits('70000', 18);
    await Token.mint(accounts[2].address, stake70k);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stake70k);
    await Staking.connect(accounts[2]).stake(identityId, stake70k);

    const reward = hre.ethers.parseUnits('10000', 18);
    await Token.mint(accounts[0].address, reward);
    await StakingStorage.increaseOperatorFeeBalance(identityId, BigInt(reward));

    const restake = hre.ethers.parseUnits('500', 18);
    await Staking.connect(accounts[0]).restakeOperatorFee(identityId, restake);

    const finalNodeStake = await StakingStorage.getNodeStake(identityId);
    expect(finalNodeStake).to.equal(stake70k + restake);
  });

  it('Restake operator fees then partial withdraw: sums remain consistent', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 30);
    const askVal = 1000n;
    await Profile.connect(accounts[0]).updateAsk(identityId, askVal);
    const stakeVal = hre.ethers.parseUnits('50001', 18);
    await Token.mint(accounts[2].address, stakeVal);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stakeVal);
    await Staking.connect(accounts[2]).stake(identityId, stakeVal);

    expect(await AskStorage.weightedActiveAskSum()).to.equal(stakeVal * askVal);
    expect(await AskStorage.totalActiveStake()).to.equal(stakeVal);

    const restake1 = hre.ethers.parseUnits('10000', 18);
    await StakingStorage.increaseOperatorFeeBalance(identityId, restake1);
    await Staking.connect(accounts[0]).restakeOperatorFee(identityId, restake1);

    const stakeAfterRestake1 = stakeVal + restake1;
    expect(await AskStorage.totalActiveStake()).to.equal(stakeAfterRestake1);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(stakeAfterRestake1 * askVal);

    const restake2 = hre.ethers.parseUnits('5000', 18);
    await StakingStorage.increaseOperatorFeeBalance(identityId, restake2);
    await Staking.connect(accounts[0]).restakeOperatorFee(identityId, restake2);

    const stakeAfterRestake2 = stakeAfterRestake1 + restake2;
    expect(await AskStorage.totalActiveStake()).to.equal(stakeAfterRestake2);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(stakeAfterRestake2 * askVal);
  });

});
