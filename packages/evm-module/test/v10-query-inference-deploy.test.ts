// The development deploy of the plan-period contracts (OT-RFC-27), run through
// the real deploy steps 052c, 052d and 052e on the in-process network:
//   - every contract is registered in the Hub and wired, in an order that lets
//     each initialize as it is deployed;
//   - the parameters of deployments/parameters.json are set, λ at once;
//   - the activation epoch is the deployment epoch, so a period can be funded
//     right after the deploy, as the suites and the local devnet do.

import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  Hub,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../typechain';
import { ACCOUNT_STACK_TAGS, TRAC, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';

async function deployFixture() {
  await hre.deployments.fixture([...ACCOUNT_STACK_TAGS, 'ServiceSubscriptions']);
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const at = async <T>(name: string) => (await hre.ethers.getContractAt(name, await Hub.getContractAddress(name))) as T;
  return {
    Hub,
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    Token: await hre.ethers.getContract<Token>('Token'),
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    CSS: await at<ConvictionServiceStorage>('ConvictionServiceStorage'),
    SS: await at<ServiceSubscriptions>('ServiceSubscriptions'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    accounts: await hre.ethers.getSigners(),
  };
}

describe('@integration The development deploy of the plan-period contracts', () => {
  beforeEach(() => {
    hre.helpers.resetDeploymentsJson();
  });

  it('registers and wires every contract, at the versions of this release', async () => {
    const { Hub, Token, QIS, CSS, SS, SSW } = await loadFixture(deployFixture);
    expect(await QIS.version()).to.equal('1.0.0');
    expect(await CSS.version()).to.equal('1.1.0');
    expect(await SS.version()).to.equal('1.1.0');
    expect(await SSW.version()).to.equal('1.0.0');

    expect(await SS.queryInferenceStorage()).to.equal(await QIS.getAddress());
    expect(await SS.convictionServiceStorage()).to.equal(await CSS.getAddress());
    expect(await SSW.queryInferenceStorage()).to.equal(await QIS.getAddress());
    expect(await SSW.convictionServiceStorage()).to.equal(await CSS.getAddress());
    expect(await SSW.tokenContract()).to.equal(await Token.getAddress());
    expect(await SSW.stakingStorageAddress()).to.equal(await Hub.getContractAddress('ConvictionStakingStorage'));
    expect(await SSW.chronos()).to.equal(await Hub.getContractAddress('Chronos'));
    expect(await SSW.status()).to.equal(true);
  });

  it('sets the parameters of the development environment, λ included', async () => {
    const { QIS, CSS } = await loadFixture(deployFixture);
    expect(await QIS.receiptGraceSeconds()).to.equal(3_600n);
    expect(await QIS.maxItemsPerBatch()).to.equal(256n);
    expect(await QIS.maxGroupsPerBatch()).to.equal(32n);
    expect(await QIS.maxCloseStepsPerClaim()).to.equal(32n);
    expect(await QIS.lambdaBps()).to.equal(5_000n);
    expect(await QIS.nextLambdaFromEpoch()).to.equal(0n);
    expect(await QIS.paused()).to.equal(false);
    expect(await CSS.maxBucketsPerPeriod()).to.equal(16n);
  });

  it('activates in the deployment epoch, so a wallet period is funded right after the deploy', async () => {
    const { Chronos, Token, QIS, CSS, SSW, accounts } = await loadFixture(deployFixture);
    const epoch = await Chronos.getCurrentEpoch();
    expect(await QIS.activationEpoch()).to.equal(epoch);
    expect(await QIS.closedThrough()).to.equal(epoch - 1n);
    expect(await QIS.lambdaBpsAt(epoch)).to.equal(5_000n);

    const buyer = accounts[21];
    await Token.connect(buyer).approve(await SSW.getAddress(), 10n * TRAC);
    await SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch));
    expect(await CSS.subscriptionExists(subscriptionIdOf(buyer.address, epoch))).to.equal(true);
    expect(await QIS.walletDue(epoch + 1n)).to.equal(10n * TRAC);
  });
});
