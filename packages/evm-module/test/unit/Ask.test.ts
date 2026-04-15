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
} from '../../typechain';

type FullIntegrationFixture = {
  accounts: SignerWithAddress[];
  Profile: Profile;
  AskStorage: AskStorage;
  Ask: Ask;
  Staking: Staking;
  StakingStorage: StakingStorage;
  Token: Token;
};

describe('@unit Ask', () => {
  let accounts: SignerWithAddress[];
  let Profile: Profile;
  let AskStorage: AskStorage;
  let Ask: Ask;
  let Staking: Staking;
  let StakingStorage: StakingStorage;
  let Token: Token;

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
    };
  }

  let profileCounter: number;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Profile, Ask, Staking, Token } =
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

  it('Multiple profiles: set different asks and stakes, verify weighted sums are exact', async () => {
    const profiles: Array<{ identityId: number; ask: bigint; stake: bigint }> = [];
    // Asks must stay within the IQR-based active set bounds
    // (askLowerBoundFactor=0.533, askUpperBoundFactor=1.467)
    const asks = [100n, 120n, 130n];
    const stakes = [
      hre.ethers.parseUnits('50000', 18),
      hre.ethers.parseUnits('60000', 18),
      hre.ethers.parseUnits('70000', 18),
    ];

    for (let i = 0; i < 3; i++) {
      const { identityId } = await createProfile(
        accounts[0],
        accounts[i + 1],
        i * 10 + 10,
      );

      await Profile.connect(accounts[0]).updateAsk(identityId, asks[i]);

      await Token.mint(accounts[4].address, stakes[i]);
      await Token.connect(accounts[4]).approve(Staking.getAddress(), stakes[i]);
      await Staking.connect(accounts[4]).stake(identityId, stakes[i]);

      profiles.push({ identityId, ask: asks[i], stake: stakes[i] });
    }

    const expectedTotalStake = stakes.reduce((a, b) => a + b, 0n);
    const expectedWeightedSum = profiles.reduce((acc, p) => acc + p.stake * p.ask, 0n);

    expect(await AskStorage.totalActiveStake()).to.equal(expectedTotalStake);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(expectedWeightedSum);
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

  it('Stake/withdraw/updateAsk cycle maintains exact sums', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 10);
    const largeStake = hre.ethers.parseUnits('90000', 18);
    await Token.mint(accounts[2].address, largeStake);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), largeStake);
    await Staking.connect(accounts[2]).stake(identityId, largeStake);
    await Profile.connect(accounts[0]).updateAsk(identityId, 300n);

    expect(await AskStorage.weightedActiveAskSum()).to.equal(largeStake * 300n);
    expect(await AskStorage.totalActiveStake()).to.equal(largeStake);

    const partial1 = hre.ethers.parseUnits('40000', 18);
    await Staking.connect(accounts[2]).requestWithdrawal(identityId, partial1);

    const remainingAfterPartial = largeStake - partial1;
    expect(await AskStorage.weightedActiveAskSum()).to.equal(remainingAfterPartial * 300n);
    expect(await AskStorage.totalActiveStake()).to.equal(remainingAfterPartial);

    // Ask values must stay within IQR-based active set bounds
    // (askLowerBoundFactor=0.533, askUpperBoundFactor=1.467)
    const askChanges = [280n, 250n, 320n, 300n];
    for (const newAsk of askChanges) {
      await time.increase(61);
      await Profile.connect(accounts[0]).updateAsk(identityId, newAsk);
      expect(await AskStorage.weightedActiveAskSum()).to.equal(remainingAfterPartial * newAsk);
      expect(await AskStorage.totalActiveStake()).to.equal(remainingAfterPartial);
    }

    await Staking.connect(accounts[2]).cancelWithdrawal(identityId);
    const lastAsk = askChanges[askChanges.length - 1];
    expect(await AskStorage.weightedActiveAskSum()).to.equal(largeStake * lastAsk);
    expect(await AskStorage.totalActiveStake()).to.equal(largeStake);
  });

  it('Partial withdraw near min stake: verify node exclusion from sums', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 20);
    const stAmount = hre.ethers.parseUnits('80000', 18);
    await Token.mint(accounts[2].address, stAmount);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stAmount);
    await Staking.connect(accounts[2]).stake(identityId, stAmount);
    await Profile.connect(accounts[0]).updateAsk(identityId, 400n);

    expect(await AskStorage.weightedActiveAskSum()).to.equal(stAmount * 400n);
    expect(await AskStorage.totalActiveStake()).to.equal(stAmount);

    await time.increase(61);

    const partialWithdraw = hre.ethers.parseUnits('79999', 18);
    await Staking.connect(accounts[2]).requestWithdrawal(
      identityId,
      partialWithdraw,
    );
    // Remaining stake (1e18) is below minimumStake (50000e18), so the
    // node is excluded from the active set entirely.
    expect(await AskStorage.totalActiveStake()).to.equal(0n);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(0n);

    // Cancelling withdrawal restores full stake → node re-enters active set
    await Staking.connect(accounts[2]).cancelWithdrawal(identityId);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(stAmount * 400n);
    expect(await AskStorage.totalActiveStake()).to.equal(stAmount);

    await time.increase(61);

    await expect(
      Profile.connect(accounts[0]).updateAsk(identityId, 0n),
    ).to.be.revertedWithCustomError(Profile, 'ZeroAsk');
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

  it('Multiple nodes with deterministic stakes: verify exact weighted sums after each operation', async () => {
    // Asks must stay within the IQR-based active set bounds
    // (askLowerBoundFactor=0.533, askUpperBoundFactor=1.467)
    const nodeData = [
      { ask: 100n, stakes: [55000n, 60000n] },
      { ask: 110n, stakes: [70000n, 75000n] },
      { ask: 120n, stakes: [80000n] },
      { ask: 130n, stakes: [65000n, 50000n, 90000n] },
      { ask: 140n, stakes: [52000n] },
    ];

    const identityIds: number[] = [];
    for (let i = 0; i < nodeData.length; i++) {
      const { identityId } = await createProfile(
        accounts[0],
        accounts[i + 1],
        (i + 1) * 5,
      );
      await Profile.connect(accounts[0]).updateAsk(identityId, nodeData[i].ask);
      identityIds.push(identityId);
    }

    let expectedTotalStake = 0n;
    let expectedWeightedSum = 0n;

    for (let i = 0; i < nodeData.length; i++) {
      for (const rawStake of nodeData[i].stakes) {
        const stakeWei = hre.ethers.parseUnits(rawStake.toString(), 18);
        await Token.mint(accounts[8].address, stakeWei);
        await Token.connect(accounts[8]).approve(Staking.getAddress(), stakeWei);
        await Staking.connect(accounts[8]).stake(identityIds[i], stakeWei);
        expectedTotalStake += stakeWei;
        expectedWeightedSum += stakeWei * nodeData[i].ask;
      }
    }

    expect(await AskStorage.totalActiveStake()).to.equal(expectedTotalStake);
    expect(await AskStorage.weightedActiveAskSum()).to.equal(expectedWeightedSum);
  });

  it('Ask changes correctly update weighted sum without changing total stake', async () => {
    const { identityId } = await createProfile(accounts[0], accounts[1], 50);
    await Profile.connect(accounts[0]).updateAsk(identityId, 100n);
    const stVal = hre.ethers.parseUnits('90000', 18);
    await Token.mint(accounts[2].address, stVal);
    await Token.connect(accounts[2]).approve(Staking.getAddress(), stVal);
    await Staking.connect(accounts[2]).stake(identityId, stVal);

    expect(await AskStorage.weightedActiveAskSum()).to.equal(stVal * 100n);
    expect(await AskStorage.totalActiveStake()).to.equal(stVal);

    // Ask values must stay within IQR-based active set bounds
    // (askLowerBoundFactor=0.533, askUpperBoundFactor=1.467)
    const askChanges = [90n, 80n, 110n];
    for (const newAsk of askChanges) {
      await time.increase(61);
      await Profile.connect(accounts[0]).updateAsk(identityId, newAsk);
      expect(await AskStorage.weightedActiveAskSum()).to.equal(stVal * newAsk);
      expect(await AskStorage.totalActiveStake()).to.equal(stVal);
    }
  });
});
