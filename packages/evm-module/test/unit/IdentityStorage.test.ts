import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import { Hub, Identity, IdentityStorage } from '../../typechain';
import { ECDSA, OPERATIONAL_KEY, ADMIN_KEY } from '../helpers/constants';

type IdentityStorageFixture = {
  accounts: SignerWithAddress[];
  Identity: Identity;
  IdentityStorage: IdentityStorage;
};

describe('@unit IdentityStorage contract', function () {
  let accounts: SignerWithAddress[];
  let Identity: Identity;
  let IdentityStorage: IdentityStorage;
  let operationalKey: string,
    adminKey: string,
    newAdminKeyBytes32: string,
    operationalKeyBytes32: string,
    adminKeyBytes32: string,
    newOperationalKeyBytes32: string;

  async function deployIdentityStorageFixture(): Promise<IdentityStorageFixture> {
    await hre.deployments.fixture(['IdentityStorage', 'Identity'], {
      keepExistingDeployments: false,
    });
    Identity = await hre.ethers.getContract<Identity>('Identity');
    IdentityStorage =
      await hre.ethers.getContract<IdentityStorage>('IdentityStorage');
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    accounts = await hre.ethers.getSigners();
    await Hub.setContractAddress('HubOwner', accounts[0].address);

    return { accounts, Identity, IdentityStorage };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Identity, IdentityStorage } = await loadFixture(
      deployIdentityStorageFixture,
    ));
    operationalKey = accounts[1].address;
    adminKey = accounts[2].address;
    adminKeyBytes32 = ethers.keccak256(
      ethers.solidityPacked(['address'], [accounts[2].address]),
    );
    operationalKeyBytes32 = ethers.keccak256(
      ethers.solidityPacked(['address'], [accounts[1].address]),
    );
    newOperationalKeyBytes32 = ethers.keccak256(
      ethers.solidityPacked(['address'], [accounts[4].address]),
    );
    newAdminKeyBytes32 = ethers.keccak256(
      ethers.solidityPacked(['address'], [accounts[3].address]),
    );
  });

  it('The contract is named "Identity"', async () => {
    expect(await IdentityStorage.name()).to.equal('IdentityStorage');
  });

  it('The contract is version "10.0.2"', async () => {
    expect(await IdentityStorage.version()).to.equal('10.0.2');
  });

  it('Get the identity id for operational key, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);

    expect(identityId).to.equal(1);
  });

  it('Validate the purpose of the admin and operational key, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    const isAdminKey = await IdentityStorage.keyHasPurpose(
      identityId,
      adminKeyBytes32,
      ADMIN_KEY,
    );
    const isOperationalKey = await IdentityStorage.keyHasPurpose(
      identityId,
      operationalKeyBytes32,
      OPERATIONAL_KEY,
    );

    expect(isAdminKey).to.be.eql(true);
    expect(isOperationalKey).to.be.eql(true);
  });

  it('Get the admin key values and should matched, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    const getAdminKeyValue = await IdentityStorage.getKey(
      identityId,
      adminKeyBytes32,
    );

    expect(getAdminKeyValue[0]).to.equal(ADMIN_KEY);
    expect(getAdminKeyValue[1]).to.equal(ECDSA);
    expect(getAdminKeyValue[2]).to.equal(adminKeyBytes32);
  });

  it('Get the operational key values and should matched, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    const getOperationalKeyValue = await IdentityStorage.getKey(
      identityId,
      operationalKeyBytes32,
    );

    expect(getOperationalKeyValue[0]).to.equal(OPERATIONAL_KEY);
    expect(getOperationalKeyValue[1]).to.equal(ECDSA);
    expect(getOperationalKeyValue[2]).to.equal(operationalKeyBytes32);
  });

  it('Get the list of keys with admin purpose, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    await IdentityStorage.addKey(
      identityId,
      newAdminKeyBytes32,
      ADMIN_KEY,
      ECDSA,
    );
    const getKeysByPurpose = await IdentityStorage.getKeysByPurpose(
      identityId,
      ADMIN_KEY,
    );

    expect(getKeysByPurpose.length).to.equal(2);
    expect(getKeysByPurpose[0]).to.equal(adminKeyBytes32);
    expect(getKeysByPurpose[1]).to.equal(newAdminKeyBytes32);
  });

  it('Get the list of keys with operational purpose, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    await IdentityStorage.addKey(
      identityId,
      newOperationalKeyBytes32,
      OPERATIONAL_KEY,
      ECDSA,
    );
    const getKeysByPurpose = await IdentityStorage.getKeysByPurpose(
      identityId,
      OPERATIONAL_KEY,
    );

    expect(getKeysByPurpose.length).to.equal(2);
    expect(getKeysByPurpose[0]).to.equal(operationalKeyBytes32);
    expect(getKeysByPurpose[1]).to.equal(newOperationalKeyBytes32);
  });

  it('Set a new operational key identity id, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);

    expect(identityId).to.equal(1);

    const newIdentityId = 2;
    await IdentityStorage.setOperationalKeyIdentityId(
      operationalKeyBytes32,
      newIdentityId,
    );
    const fetchNewIdentityId =
      await IdentityStorage.getIdentityId(operationalKey);

    expect(fetchNewIdentityId).to.equal(newIdentityId);
  });

  it('Remove a new set operational key identity id, expect to pass', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const newIdentityId = 2;
    await IdentityStorage.setOperationalKeyIdentityId(
      operationalKeyBytes32,
      newIdentityId,
    );
    await IdentityStorage.removeOperationalKeyIdentityId(operationalKeyBytes32);
    const fetchIdentityId = await IdentityStorage.getIdentityId(operationalKey);

    expect(fetchIdentityId).to.equal(0);
  });

  it('Add 2 operational keys, remove operational key, expect KeyRemoved event to be emitted', async () => {
    await Identity.createIdentity(operationalKey, adminKey);
    const identityId = await IdentityStorage.getIdentityId(operationalKey);
    await IdentityStorage.addKey(
      identityId,
      newOperationalKeyBytes32,
      OPERATIONAL_KEY,
      ECDSA,
    );

    await expect(
      IdentityStorage.removeKey(identityId, newOperationalKeyBytes32),
    )
      .to.emit(IdentityStorage, 'KeyRemoved')
      .withArgs(identityId, newOperationalKeyBytes32, OPERATIONAL_KEY, ECDSA);
  });
});
