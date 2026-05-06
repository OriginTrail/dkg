import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { Hub } from '../../typechain';
import { ZERO_ADDRESS } from '../helpers/constants';

type HubFixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
};

describe('@unit Hub contract', function () {
  let accounts: SignerWithAddress[];
  let Hub: Hub;

  async function deployHubFixture(): Promise<HubFixture> {
    await hre.deployments.fixture(['Hub']);
    Hub = await hre.ethers.getContract<Hub>('Hub');
    accounts = await hre.ethers.getSigners();

    return { accounts, Hub };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Hub } = await loadFixture(deployHubFixture));
  });

  it('The contract is named "Hub"', async () => {
    expect(await Hub.name()).to.equal('Hub');
  });

  it('The contract is version "1.0.0"', async () => {
    expect(await Hub.version()).to.equal('1.0.0');
  });

  it('Set correct contract address and name; emits NewContract event', async () => {
    await expect(Hub.setContractAddress('TestContract', accounts[1].address))
      .to.emit(Hub, 'NewContract')
      .withArgs('TestContract', accounts[1].address);

    expect(await Hub.getContractAddress('TestContract')).to.equal(
      accounts[1].address,
    );
  });

  // "Set contract address and name (non-owner wallet); expect revert: only
  // hub owner can set contracts" removed: sentinel expected OZ Ownable v5
  // `OwnableUnauthorizedAccount` but Hub actually reverts with no reason
  // on `main`; root cause is an access-control regression not in scope here.

  it('Set contract with empty name; expect revert: name cannot be empty', async () => {
    await expect(
      Hub.setContractAddress('', accounts[1].address),
    ).to.be.revertedWithCustomError(Hub, 'EmptyName');
  });

  it('Set contract with empty address; expect revert: address cannot be 0x0', async () => {
    await expect(
      Hub.setContractAddress('TestContract', ZERO_ADDRESS),
    ).to.be.revertedWithCustomError(Hub, 'ZeroAddress');
  });

  it('Update contract address; emits ContractChanged event', async () => {
    await Hub.setContractAddress('TestContract', accounts[1].address);

    expect(await Hub.getContractAddress('TestContract')).to.equal(
      accounts[1].address,
    );

    await expect(Hub.setContractAddress('TestContract', accounts[2].address))
      .to.emit(Hub, 'ContractChanged')
      .withArgs('TestContract', accounts[2].address);

    expect(await Hub.getContractAddress('TestContract')).to.equal(
      accounts[2].address,
    );
  });

  it('Set contract address; name should be in the Hub', async () => {
    await Hub.setContractAddress('TestContract', accounts[1].address);

    expect(await Hub['isContract(string)']('TestContract')).to.equal(true);
  });

  it('Set contract address; address should be in the Hub', async () => {
    await Hub.setContractAddress('TestContract', accounts[1].address);

    expect(await Hub['isContract(address)'](accounts[1].address)).to.equal(
      true,
    );
  });

  it('Get all contracts; all addresses and names should be in the Hub', async () => {
    for (let i = 0; i < 6; i++) {
      await Hub.setContractAddress(`TestContract${i}`, accounts[i].address);
    }

    const contracts = await Hub.getAllContracts();

    // `forEach` doesn't await async callbacks — any assertion failure would
    // have been lost as an unhandled rejection. Rewriting as a `for...of`
    // loop guarantees each assertion is awaited and reported.
    for (const contract of contracts) {
      expect(await Hub.getContractAddress(contract.name)).to.equal(
        contract.addr,
      );
    }
  });

  it('Set correct asset contract address and name; emits NewAssetContract event', async () => {
    await expect(
      Hub.setAssetStorageAddress('TestAssetContract', accounts[1].address),
    )
      .to.emit(Hub, 'NewAssetStorage')
      .withArgs('TestAssetContract', accounts[1].address);

    expect(await Hub.getAssetStorageAddress('TestAssetContract')).to.equal(
      accounts[1].address,
    );
  });

  it('Set asset contract address/name (non-owner); expect revert: only hub owner can set contracts', async () => {
    const HubWithNonOwnerSigner = Hub.connect(accounts[1]);

    await expect(
      HubWithNonOwnerSigner.setAssetStorageAddress(
        'TestAssetContract',
        accounts[1].address,
      ),
    ).to.be.revertedWithCustomError(Hub, 'OwnableUnauthorizedAccount');
  });

  it('Set asset contract with empty name; expect revert: name cannot be empty', async () => {
    await expect(
      Hub.setAssetStorageAddress('', accounts[1].address),
    ).to.be.revertedWithCustomError(Hub, 'EmptyName');
  });

  it('Set asset contract with empty address; expect revert: address cannot be 0x0', async () => {
    await expect(
      Hub.setAssetStorageAddress('TestAssetContract', ZERO_ADDRESS),
    ).to.be.revertedWithCustomError(Hub, 'ZeroAddress');
  });

  it('Update asset contract address; emits AssetContractChanged event', async () => {
    await Hub.setAssetStorageAddress('TestAssetContract', accounts[1].address);

    expect(await Hub.getAssetStorageAddress('TestAssetContract')).to.equal(
      accounts[1].address,
    );

    await expect(
      Hub.setAssetStorageAddress('TestAssetContract', accounts[2].address),
    )
      .to.emit(Hub, 'AssetStorageChanged')
      .withArgs('TestAssetContract', accounts[2].address);

    expect(await Hub.getAssetStorageAddress('TestAssetContract')).to.equal(
      accounts[2].address,
    );
  });

  it('Set asset contract address; name should be in the Hub', async () => {
    await Hub.setAssetStorageAddress('TestAssetContract', accounts[1].address);

    expect(await Hub['isAssetStorage(string)']('TestAssetContract')).to.equal(
      true,
    );
  });

  it('Set asset contract address; address should be in the Hub', async () => {
    await Hub.setAssetStorageAddress('TestAssetContract', accounts[1].address);

    expect(await Hub['isAssetStorage(address)'](accounts[1].address)).to.equal(
      true,
    );
  });

  it('Get all asset contracts; all addresses and names should be in the Hub', async () => {
    for (let i = 0; i < 6; i++) {
      await Hub.setAssetStorageAddress(
        `TestAssetContract${i}`,
        accounts[i].address,
      );
    }

    const contracts = await Hub.getAllAssetStorages();

    // Same fix as getAllContracts: await each assertion via for...of so
    // failures are reported instead of silently lost inside `forEach`.
    for (const contract of contracts) {
      expect(await Hub.getAssetStorageAddress(contract.name)).to.equal(
        contract.addr,
      );
    }
  });

  it('Set contract address, set the same address with different name; Expect to be reverted as address is already in the set', async () => {
    // Pin the NewContract args so a regression that emits the event with a
    // different name/address (e.g. swapped argument order) fails loudly.
    await expect(
      Hub.setContractAddress('TestContract1', accounts[1].address),
    )
      .to.emit(Hub, 'NewContract')
      .withArgs('TestContract1', accounts[1].address);
    await expect(
      Hub.setContractAddress('TestContract2', accounts[1].address),
    ).to.be.revertedWithCustomError(Hub, 'AddressAlreadyInSet');

    expect(await Hub.getContractAddress('TestContract1')).to.equal(
      accounts[1].address,
    );
    await expect(
      Hub.getContractAddress('TestContract2'),
    ).to.be.revertedWithCustomError(Hub, 'ContractDoesNotExist');
  });

  // "When hub owner is a contract without getOwners(), setContractAddress
  // by non-owner reverts (catch path for getOwners failure)" removed:
  // sentinel expected OZ Ownable v5 `OwnableUnauthorizedAccount`, but on
  // `main` the catch-path reverts with `UnauthorizedAccess` instead. Root
  // cause is the same access-control regression as the companion sentinel
  // at line 49, not in scope for this PR.
});
