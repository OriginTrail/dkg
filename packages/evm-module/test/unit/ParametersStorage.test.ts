import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Interface } from 'ethers';
import hre from 'hardhat';

import { ParametersStorage, Hub } from '../../typechain';

type ParametersStorageFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  ParametersStorageInterface: Interface;
  ParametersStorage: ParametersStorage;
};

describe('@unit ParametersStorage contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let ParametersStorageInterface: Interface;
  let ParametersStorage: ParametersStorage;
  let minimumStake;
  let stakeWithdrawalDelay;

  async function deployParametersStorageFixture(): Promise<ParametersStorageFixture> {
    await hre.deployments.fixture(['ParametersStorage']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    ParametersStorageInterface = new hre.ethers.Interface(
      hre.helpers.getAbi('ParametersStorage'),
    );
    ParametersStorage =
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return { accounts, Hub, ParametersStorageInterface, ParametersStorage };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, ParametersStorageInterface, ParametersStorage } =
      await loadFixture(deployParametersStorageFixture));
  });

  it('validate minimum stake for owner, expect to pass', async () => {
    const minStakeInContract = '50000000000000000000000';
    const newMinSakeValue = '40000000000000000000000';
    minimumStake = await ParametersStorage.minimumStake();

    expect(minimumStake.toString()).be.eql(minStakeInContract);

    // set a new value for min stake and validate is correct
    await Hub.forwardCall(
      await ParametersStorage.getAddress(),
      ParametersStorageInterface.encodeFunctionData('setMinimumStake', [
        newMinSakeValue,
      ]),
    );
    minimumStake = await ParametersStorage.minimumStake();

    expect(minimumStake.toString()).be.eql(newMinSakeValue);
  });

  it('validate minimum stake for non owner, expect to fail', async () => {
    minimumStake = await ParametersStorage.minimumStake();

    await expect(
      ParametersStorage.connect(accounts[1]).setMinimumStake(
        minimumStake.toString(),
      ),
    ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
  });

  it('validate stake withdrawal delay for owner, expect to pass', async () => {
    const valueInContract = 1;
    const newValue = '7';
    stakeWithdrawalDelay = await ParametersStorage.stakeWithdrawalDelay();
    expect(Number(stakeWithdrawalDelay) / 60).to.eql(valueInContract);

    // set new value for stake withdrawal delay and validate is correct
    await Hub.forwardCall(
      await ParametersStorage.getAddress(),
      ParametersStorageInterface.encodeFunctionData('setStakeWithdrawalDelay', [
        newValue,
      ]),
    );
    stakeWithdrawalDelay = await ParametersStorage.stakeWithdrawalDelay();

    expect(stakeWithdrawalDelay.toString()).be.eql(newValue);
  });

  it('validate stake withdrawal delay for non owner', async () => {
    stakeWithdrawalDelay = await ParametersStorage.stakeWithdrawalDelay();

    await expect(
      ParametersStorage.connect(accounts[1]).setStakeWithdrawalDelay(
        stakeWithdrawalDelay.toString(),
      ),
    ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
  });
});
