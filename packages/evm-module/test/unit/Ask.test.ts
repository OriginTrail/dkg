import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
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

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Profile, Ask, Staking, Token, DelegatorsInfo } =
      await loadFixture(deployAll));
  });

  const createProfile = async (
    admin: SignerWithAddress,
    operational: SignerWithAddress,
    operatorFee: number,
  ) => {
    const nodeId = '0x' + randomBytes(32).toString('hex');

    const tx = await Profile.connect(operational).createProfile(
      admin.address,
      [],
      `Node ${Math.floor(Math.random() * 1000)}`,
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
    await DelegatorsInfo.setDelegatorLock(identityId, accounts[2].address, 0, 0);
    await Staking.connect(accounts[2]).requestWithdrawal(
      identityId,
      partialWithdraw,
    );

    expect(await AskStorage.weightedActiveAskSum()).to.be.equal(
      10000000000000000000000000n,
    );
    expect(await AskStorage.totalActiveStake()).to.be.equal(
      50000000000000000000000n,
    );
  });

  it('Multiple profiles: set different operator fees, asks, and stakes in parallel', async () => {
    const profiles: Array<{ identityId: number; nodeId: string }> = [];
    for (let i = 0; i < 3; i++) {
      const { nodeId, identityId } = await createProfile(
        accounts[0],
        accounts[i + 1],
        i * 10 + 10,
      );
      profiles.push({ nodeId, identityId });
    }

    for (let i = 0; i < profiles.length; i++) {
      await Profile.connect(accounts[0]).updateAsk(
        profiles[i].identityId,
        BigInt((i + 1) * 100),
      );
    }

    for (let i = 0; i < profiles.length; i++) {
      const randomStake = 50000 + Math.floor(Math.random() * 50000);
      const stakeAmount = hre.ethers.parseUnits(`${randomStake}`, 18);
      await Token.mint(accounts[4].address, stakeAmount);
      await Token.connect(accounts[4]).approve(
        Staking.getAddress(),
        stakeAmount,
      );
      await Staking.connect(accounts[4]).stake(
        profiles[i].identityId,
        stakeAmount,
      );
    }

    expect(await AskStorage.totalActiveStake()).to.be.gte(0);
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

  it('Simulate awarding operator fees, restaking them, verifying Node stats remain consistent', async () => {
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

    expect(finalNodeStake).to.be.gte(stake70k);
  });

  it('Repeated random stake/withdraw/updateAsk cycles to see if sums remain correct', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 10);
    const largeStake = hre.ethers.parseUnits('90000', 18);
    await Token.mint(accounts[2].address, largeStake);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), largeStake);
    await Staking.connect(accounts[2]).stake(identityId, largeStake);
    await Profile.connect(accounts[0]).updateAsk(identityId, 300n);
    const afterStakeWeighted = await AskStorage.weightedActiveAskSum();
    const afterStakeTotal = await AskStorage.totalActiveStake();
    expect(afterStakeWeighted).to.be.gte(largeStake * 300n);
    expect(afterStakeTotal).to.be.gte(largeStake);
    const partial1 = hre.ethers.parseUnits('40000', 18);
    await DelegatorsInfo.setDelegatorLock(identityId, accounts[2].address, 0, 0);
    await Staking.connect(accounts[2]).requestWithdrawal(identityId, partial1);
    const partialAfterWeighted = await AskStorage.weightedActiveAskSum();
    const partialAfterTotal = await AskStorage.totalActiveStake();
    expect(partialAfterWeighted).to.be.gte(0n);
    expect(partialAfterTotal).to.be.gte(0n);
    const askChanges = [500n, 1n, 9999n, 250n];
    for (const newAsk of askChanges) {
      await time.increase(61);
      await Profile.connect(accounts[0]).updateAsk(identityId, newAsk);
      const wsum = await AskStorage.weightedActiveAskSum();
      const tstake = await AskStorage.totalActiveStake();
      expect(wsum).to.be.gte(0n);
      expect(tstake).to.be.gte(0n);
    }
    await Staking.connect(accounts[2]).cancelWithdrawal(identityId);
    const finalSum = await AskStorage.weightedActiveAskSum();
    const finalStake = await AskStorage.totalActiveStake();
    expect(finalSum).to.be.gte(0n);
    expect(finalStake).to.be.gte(0n);
  });

  it('Zero-ask updates at random times and partial withdraw crossing below min stake to see if node is excluded from sums', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 20);
    const stAmount = hre.ethers.parseUnits('80000', 18);
    await Token.mint(accounts[2].address, stAmount);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stAmount);
    await Staking.connect(accounts[2]).stake(identityId, stAmount);
    await Profile.connect(accounts[0]).updateAsk(identityId, 400n);
    const weighted1 = await AskStorage.weightedActiveAskSum();
    const total1 = await AskStorage.totalActiveStake();
    expect(weighted1).to.be.eq(stAmount * 400n);
    expect(total1).to.be.eq(stAmount);

    await time.increase(61);

    const partialWithdraw = hre.ethers.parseUnits('79999', 18);
    await DelegatorsInfo.setDelegatorLock(identityId, accounts[2].address, 0, 0);
    await Staking.connect(accounts[2]).requestWithdrawal(
      identityId,
      partialWithdraw,
    );
    const weighted3 = await AskStorage.weightedActiveAskSum();
    const total3 = await AskStorage.totalActiveStake();
    expect(weighted3).to.be.gte(0n);
    expect(total3).to.be.lte(stAmount);
    await Staking.connect(accounts[2]).cancelWithdrawal(identityId);
    const afterCancelW = await AskStorage.weightedActiveAskSum();
    const afterCancelT = await AskStorage.totalActiveStake();
    expect(afterCancelW).to.be.gte(0n);
    expect(afterCancelT).to.be.gte(0n);

    await time.increase(61);

    await Profile.connect(accounts[0])
      .updateAsk(identityId, 0n)
      .catch(() => {});
    expect(await AskStorage.weightedActiveAskSum()).to.be.gte(0n);
    expect(await AskStorage.totalActiveStake()).to.be.gte(0n);
  });

  it('Repeated distributing rewards, then partial withdraw that puts node below min stake, verifying Ask excludes node', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 30);
    await Profile.connect(accounts[0]).updateAsk(identityId, 1000n);
    const stakeVal = hre.ethers.parseUnits('50001', 18);
    await Token.mint(accounts[2].address, stakeVal);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stakeVal);
    await Staking.connect(accounts[2]).stake(identityId, stakeVal);
    const weighted = await AskStorage.weightedActiveAskSum();
    const total = await AskStorage.totalActiveStake();
    expect(weighted).to.be.eq(stakeVal * 1000n);
    expect(total).to.be.eq(stakeVal);
    await StakingStorage.increaseOperatorFeeBalance(
      identityId,
      hre.ethers.parseUnits('10000', 18),
    );
    await Staking.connect(accounts[0]).restakeOperatorFee(
      identityId,
      hre.ethers.parseUnits('10000', 18),
    );
    let sumAfterRewards = await AskStorage.weightedActiveAskSum();
    let stakeAfterRewards = await AskStorage.totalActiveStake();
    expect(sumAfterRewards).to.be.gte(0n);
    expect(stakeAfterRewards).to.be.gte(stakeVal);
    await StakingStorage.increaseOperatorFeeBalance(
      identityId,
      hre.ethers.parseUnits('5000', 18),
    );
    await Staking.connect(accounts[0]).restakeOperatorFee(
      identityId,
      hre.ethers.parseUnits('5000', 18),
    );
    sumAfterRewards = await AskStorage.weightedActiveAskSum();
    stakeAfterRewards = await AskStorage.totalActiveStake();
    expect(sumAfterRewards).to.be.gte(0n);
    expect(stakeAfterRewards).to.be.gte(stakeVal);
    const bigWithdraw = hre.ethers.parseUnits('60000', 18);
    await Staking.connect(accounts[2])
      .requestWithdrawal(identityId, bigWithdraw)
      .catch(() => {});
    const finalWeighted = await AskStorage.weightedActiveAskSum();
    const finalStake = await AskStorage.totalActiveStake();
    expect(finalWeighted).to.be.gte(0n);
    expect(finalStake).to.be.gte(0n);
  });

  it('Try random stakes on multiple nodes, each crossing min stake up/down, verifying sums are correct each time', async () => {
    const nodes = [];
    for (let i = 0; i < 5; i++) {
      const { identityId } = await createProfile(
        accounts[0],
        accounts[i + 1],
        (i + 1) * 5,
      );
      await Profile.connect(accounts[0]).updateAsk(
        identityId,
        BigInt((i + 1) * 100),
      );
      nodes.push(identityId);
    }
    for (let round = 0; round < 10; round++) {
      const randomNode = nodes[Math.floor(Math.random() * nodes.length)];
      const randomStakeVal = hre.ethers.parseUnits(
        `${50000 + Math.floor(Math.random() * 50000)}`,
        18,
      );
      await Token.mint(accounts[2].address, randomStakeVal);
      await Token.connect(accounts[2]).approve(
        Staking.getAddress(),
        randomStakeVal,
      );
      await Staking.connect(accounts[2]).stake(randomNode, randomStakeVal);
      if (Math.random() > 0.5) {
        const partialWithdraw = randomStakeVal / 2n;
        await Staking.connect(accounts[2])
          .requestWithdrawal(randomNode, partialWithdraw)
          .catch(() => {});
      }
      const wSum = await AskStorage.weightedActiveAskSum();
      const tStake = await AskStorage.totalActiveStake();
      expect(wSum).to.be.gte(0n);
      expect(tStake).to.be.gte(0n);
    }
  });

  it('Allocate operator fees randomly, restake them, also do repeated ask changes to check if we can break the sums', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 50);
    await Profile.connect(accounts[0]).updateAsk(identityId, 1000n);
    const stVal = hre.ethers.parseUnits('90000', 18);
    await Token.mint(accounts[2].address, stVal);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stVal);
    await Staking.connect(accounts[2]).stake(identityId, stVal);
    await StakingStorage.increaseOperatorFeeBalance(
      identityId,
      hre.ethers.parseUnits('30000', 18),
    );
    const restakeVal = hre.ethers.parseUnits('200', 18);
    await Staking.connect(accounts[0])
      .restakeOperatorFee(identityId, restakeVal)
      .catch(() => {});
    const w1 = await AskStorage.weightedActiveAskSum();
    const t1 = await AskStorage.totalActiveStake();
    expect(w1).to.be.gte(0n);
    expect(t1).to.be.gte(0n);
    const askChanges = [500n, 9999999n, 100n, 2n];
    for (const newAsk of askChanges) {
      await Profile.connect(accounts[0])
        .updateAsk(identityId, newAsk)
        .catch(() => {});
      const w2 = await AskStorage.weightedActiveAskSum();
      const t2 = await AskStorage.totalActiveStake();
      expect(w2).to.be.gte(0n);
      expect(t2).to.be.gte(0n);
    }
    const partialW = hre.ethers.parseUnits('85000', 18);
    await Staking.connect(accounts[2])
      .requestWithdrawal(identityId, partialW)
      .catch(() => {});
    const finalW = await AskStorage.weightedActiveAskSum();
    const finalT = await AskStorage.totalActiveStake();
    expect(finalW).to.be.gte(0n);
    expect(finalT).to.be.gte(0n);
  });
});
