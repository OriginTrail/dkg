import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  FalseReturnERC20,
  Hub,
  Profile,
  StakingV10,
} from '../typechain';

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  NFT: DKGStakingConvictionNFT;
  StakingV10: StakingV10;
  ConvictionStakingStorage: ConvictionStakingStorage;
  Profile: Profile;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');

  await Hub.setContractAddress('HubOwner', accounts[0].address);

  return {
    accounts,
    Hub,
    NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
    StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
    ConvictionStakingStorage: await hre.ethers.getContract<ConvictionStakingStorage>(
      'ConvictionStakingStorage',
    ),
    Profile: await hre.ethers.getContract<Profile>('Profile'),
  };
}

describe('@integration V10 ERC-20 false-return staking guards', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let ConvictionStakingStorageContract: ConvictionStakingStorage;
  let ProfileContract: Profile;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      NFT,
      StakingV10: StakingV10Contract,
      ConvictionStakingStorage: ConvictionStakingStorageContract,
      Profile: ProfileContract,
    } = await loadFixture(deployFixture));
  });

  const createProfile = async () => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(accounts[1]).createProfile(
      accounts[0].address,
      [],
      `False Return Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { nodeId, identityId };
  };

  const useFalseReturnToken = async () => {
    const TokenFactory = await hre.ethers.getContractFactory('FalseReturnERC20');
    const token = (await TokenFactory.deploy('False TRAC', 'fTRAC')) as unknown as FalseReturnERC20;
    await token.waitForDeployment();

    await Hub.setContractAddress('Token', await token.getAddress());
    await Hub.forwardCall(
      await ConvictionStakingStorageContract.getAddress(),
      ConvictionStakingStorageContract.interface.encodeFunctionData('initialize'),
    );
    await Hub.forwardCall(
      await StakingV10Contract.getAddress(),
      StakingV10Contract.interface.encodeFunctionData('initialize'),
    );

    return token;
  };

  it('reverts before creating a CSS position when transferFrom returns false', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');
    const token = await useFalseReturnToken();

    await token.mint(accounts[0].address, amount);
    await token.connect(accounts[0]).approve(await StakingV10Contract.getAddress(), amount);
    await token.setTransferFromReturnsFalse(true);

    const cssAddress = await ConvictionStakingStorageContract.getAddress();
    const cssBalanceBefore = await token.balanceOf(cssAddress);
    const nodeStakeBefore = await ConvictionStakingStorageContract.getNodeStakeV10(identityId);

    await expect(NFT.connect(accounts[0]).createConviction(identityId, amount, 12)).to.be.reverted;

    const position = await ConvictionStakingStorageContract.getPosition(1);
    expect(position.identityId).to.equal(0n);
    expect(position.raw).to.equal(0n);
    expect(await ConvictionStakingStorageContract.getNodeStakeV10(identityId)).to.equal(nodeStakeBefore);
    expect(await token.balanceOf(cssAddress)).to.equal(cssBalanceBefore);
  });

  it('keeps the CSS position when withdrawal transfer returns false', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');
    const token = await useFalseReturnToken();

    await token.mint(accounts[0].address, amount);
    await token.connect(accounts[0]).approve(await StakingV10Contract.getAddress(), amount);
    await NFT.connect(accounts[0]).createConviction(identityId, amount, 0);

    const positionBefore = await ConvictionStakingStorageContract.getPosition(1);
    await token.setTransferReturnsFalse(true);

    await expect(NFT.connect(accounts[0]).withdraw(1)).to.be.reverted;

    const positionAfter = await ConvictionStakingStorageContract.getPosition(1);
    expect(positionAfter.identityId).to.equal(positionBefore.identityId);
    expect(positionAfter.raw).to.equal(positionBefore.raw);
  });

  it('keeps the operator-fee withdrawal request when finalization transfer returns false', async () => {
    const { identityId } = await createProfile();
    const amount = hre.ethers.parseEther('1000');
    const token = await useFalseReturnToken();

    await token.mint(await ConvictionStakingStorageContract.getAddress(), amount);
    await ConvictionStakingStorageContract.increaseOperatorFeeBalance(identityId, amount);
    await StakingV10Contract.requestOperatorFeeWithdrawal(identityId, amount);

    const requestBefore = await ConvictionStakingStorageContract.getOperatorFeeWithdrawalRequest(identityId);
    await time.increaseTo(requestBefore[2]);
    await token.setTransferReturnsFalse(true);

    await expect(StakingV10Contract.finalizeOperatorFeeWithdrawal(identityId)).to.be.reverted;

    const requestAfter = await ConvictionStakingStorageContract.getOperatorFeeWithdrawalRequest(identityId);
    expect(requestAfter[0]).to.equal(requestBefore[0]);
    expect(requestAfter[1]).to.equal(requestBefore[1]);
    expect(requestAfter[2]).to.equal(requestBefore[2]);
  });
});
