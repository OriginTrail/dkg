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

  describe('protocol treasury fee', () => {
    it('defaults: fee = 300 bps (3%), treasury = zero address, cap = 1000 bps', async () => {
      expect(await ParametersStorage.protocolTreasuryFee()).to.equal(300n);
      expect(await ParametersStorage.protocolTreasury()).to.equal(
        hre.ethers.ZeroAddress,
      );
      expect(await ParametersStorage.MAX_PROTOCOL_TREASURY_FEE()).to.equal(
        1000n,
      );
    });

    it('owner can set protocolTreasuryFee within the cap and it emits ParameterChanged', async () => {
      const tx = await Hub.forwardCall(
        await ParametersStorage.getAddress(),
        ParametersStorageInterface.encodeFunctionData('setProtocolTreasuryFee', [
          500,
        ]),
      );
      await expect(tx)
        .to.emit(ParametersStorage, 'ParameterChanged')
        .withArgs('protocolTreasuryFee', 500n);
      expect(await ParametersStorage.protocolTreasuryFee()).to.equal(500n);
    });

    it('owner can set the fee to the cap and to 0 (disable)', async () => {
      await Hub.forwardCall(
        await ParametersStorage.getAddress(),
        ParametersStorageInterface.encodeFunctionData('setProtocolTreasuryFee', [
          1000,
        ]),
      );
      expect(await ParametersStorage.protocolTreasuryFee()).to.equal(1000n);

      await Hub.forwardCall(
        await ParametersStorage.getAddress(),
        ParametersStorageInterface.encodeFunctionData('setProtocolTreasuryFee', [
          0,
        ]),
      );
      expect(await ParametersStorage.protocolTreasuryFee()).to.equal(0n);
    });

    it('setProtocolTreasuryFee reverts above the cap', async () => {
      await expect(
        Hub.forwardCall(
          await ParametersStorage.getAddress(),
          ParametersStorageInterface.encodeFunctionData(
            'setProtocolTreasuryFee',
            [1001],
          ),
        ),
      ).to.be.revertedWith('protocolTreasuryFee too large');
    });

    it('setProtocolTreasuryFee reverts for non-owner', async () => {
      await expect(
        ParametersStorage.connect(accounts[1]).setProtocolTreasuryFee(100),
      ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
    });

    it('owner can set protocolTreasury and it emits ProtocolTreasurySet', async () => {
      const treasury = accounts[3].address;
      const tx = await Hub.forwardCall(
        await ParametersStorage.getAddress(),
        ParametersStorageInterface.encodeFunctionData('setProtocolTreasury', [
          treasury,
        ]),
      );
      await expect(tx)
        .to.emit(ParametersStorage, 'ProtocolTreasurySet')
        .withArgs(treasury);
      expect(await ParametersStorage.protocolTreasury()).to.equal(treasury);
    });

    it('setProtocolTreasury reverts for non-owner', async () => {
      await expect(
        ParametersStorage.connect(accounts[1]).setProtocolTreasury(
          accounts[3].address,
        ),
      ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
    });
  });

  describe('minPcaCommitmentForCgWaiver (OT-RFC-53 waiver floor)', () => {
    it('defaults to 25,000 TRAC', async () => {
      expect(await ParametersStorage.minPcaCommitmentForCgWaiver()).to.equal(
        hre.ethers.parseEther('25000'),
      );
    });

    it('owner can set it, the value updates, and it emits ParameterChanged', async () => {
      const v = hre.ethers.parseEther('5000');
      const tx = await Hub.forwardCall(
        await ParametersStorage.getAddress(),
        ParametersStorageInterface.encodeFunctionData(
          'setMinPcaCommitmentForCgWaiver',
          [v],
        ),
      );
      await expect(tx)
        .to.emit(ParametersStorage, 'ParameterChanged')
        .withArgs('minPcaCommitmentForCgWaiver', v);
      expect(await ParametersStorage.minPcaCommitmentForCgWaiver()).to.equal(v);
    });

    it('setMinPcaCommitmentForCgWaiver reverts for non-owner', async () => {
      await expect(
        ParametersStorage.connect(accounts[1]).setMinPcaCommitmentForCgWaiver(
          hre.ethers.parseEther('1'),
        ),
      ).to.be.revertedWith('Only Hub Owner, Hub, or Multisig Owner can call');
    });
  });
});
