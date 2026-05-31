import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Interface } from 'ethers';
import hre from 'hardhat';

import { Hub, WhitelistStorage } from '../../typechain';

type WhitelistStorageFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  WhitelistStorageInterface: Interface;
  WhitelistStorage: WhitelistStorage;
};

describe('@unit WhitelistStorage contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let WhitelistStorageInterface: Interface;
  let WhitelistStorage: WhitelistStorage;

  async function deployWhitelistStorageFixture(): Promise<WhitelistStorageFixture> {
    await hre.deployments.fixture(['WhitelistStorage']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    WhitelistStorage =
      await hre.ethers.getContract<WhitelistStorage>('WhitelistStorage');
    WhitelistStorageInterface = new hre.ethers.Interface(
      hre.helpers.getAbi('WhitelistStorage'),
    );
    accounts = await hre.ethers.getSigners();

    return { accounts, Hub, WhitelistStorageInterface, WhitelistStorage };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub, WhitelistStorage } = await loadFixture(
      deployWhitelistStorageFixture,
    ));
  });

  it('The contract is named "WhitelistStorage"', async () => {
    expect(await WhitelistStorage.name()).to.equal('WhitelistStorage');
  });

  it('The contract is version "10.0.2"', async () => {
    expect(await WhitelistStorage.version()).to.equal('10.0.2');
  });

  it('Address is not whitelisted; expect to be false', async () => {
    expect(await WhitelistStorage.whitelisted(accounts[1].address)).to.equal(
      false,
    );
  });

  it('Whitelist address with owner; expect address to be whitelisted', async () => {
    await Hub.forwardCall(
      WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('whitelistAddress', [
        accounts[1].address,
      ]),
    );

    expect(await WhitelistStorage.whitelisted(accounts[1].address)).to.equal(
      true,
    );
  });

  it('Whitelist new address with non owner; expect to fail and not whitelisted', async () => {
    const WhitelistStorageWithNonOwnerSigner = WhitelistStorage.connect(
      accounts[1],
    );

    await expect(
      WhitelistStorageWithNonOwnerSigner.whitelistAddress(accounts[2].address),
    ).to.be.revertedWithCustomError(WhitelistStorage, 'UnauthorizedAccess');

    expect(
      await WhitelistStorageWithNonOwnerSigner.whitelisted(accounts[2].address),
    ).to.equal(false);
  });

  it('Whitelist and blacklist address with owner; expect to be blacklisted', async () => {
    await Hub.forwardCall(
      await WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('whitelistAddress', [
        accounts[1].address,
      ]),
    );
    await Hub.forwardCall(
      await WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('blacklistAddress', [
        accounts[1].address,
      ]),
    );

    expect(await WhitelistStorage.whitelisted(accounts[1].address)).to.equal(
      false,
    );
  });

  it('Block address with non owner, expect to be reverted', async () => {
    const WhitelistStorageWithNonOwnerSigner = WhitelistStorage.connect(
      accounts[1],
    );

    await expect(
      WhitelistStorageWithNonOwnerSigner.blacklistAddress(accounts[1].address),
    ).to.be.revertedWithCustomError(WhitelistStorage, 'UnauthorizedAccess');
  });

  it('Enable whitelist, expect to be true', async () => {
    await Hub.forwardCall(
      await WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('enableWhitelist'),
    );

    expect(await WhitelistStorage.whitelistingEnabled()).to.equal(true);
  });

  it('Disable whitelist, expect to be false', async () => {
    await Hub.forwardCall(
      await WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('enableWhitelist'),
    );
    await Hub.forwardCall(
      await WhitelistStorage.getAddress(),
      WhitelistStorageInterface.encodeFunctionData('disableWhitelist'),
    );

    expect(await WhitelistStorage.whitelistingEnabled()).to.equal(false);
  });
});
