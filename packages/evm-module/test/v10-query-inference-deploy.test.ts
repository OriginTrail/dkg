// The development deploy of the subscription contracts (OT-RFC-27), run through
// the real deploy steps 052c, 052d, 052e and 052f on the in-process network:
//   - every contract is registered in the Hub and wired, in an order that lets
//     each initialize as it is deployed;
//   - the parameters of deployments/parameters.json are set, λ among them, and
//     a later run forwards a λ only if it differs from the one set, which then
//     applies at once;
//   - the activation epoch is the deployment epoch, so a subscription can be funded
//     right after the deploy, as the suites and the local devnet do.

import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import hre from 'hardhat';

import {
  ServiceSubscriptionsStorage,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
} from '../typechain';
import { deployAccountStack } from './helpers/account-stack';
import { ACCOUNT_STACK_TAGS, TRAC, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';

async function deployFixture() {
  const stack = await deployAccountStack([
    ...ACCOUNT_STACK_TAGS,
    'ServiceSubscriptions',
    'QueryInferenceSettlement',
    'QueryInferenceActivation',
  ]);
  const at = async <T>(name: string) =>
    (await hre.ethers.getContractAt(name, await stack.Hub.getContractAddress(name))) as T;
  return {
    ...stack,
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    SSS: await at<ServiceSubscriptionsStorage>('ServiceSubscriptionsStorage'),
    SS: await at<ServiceSubscriptions>('ServiceSubscriptions'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
  };
}

describe('@integration The development deploy of the subscription contracts', () => {
  beforeEach(() => {
    hre.helpers.resetDeploymentsJson();
  });

  it('registers and wires every contract, at the versions of this release', async () => {
    const { Hub, Token, QIS, SSS, SS, SSW, QS } = await loadFixture(deployFixture);
    expect(await QIS.version()).to.equal('1.0.0');
    expect(await SSS.version()).to.equal('1.2.0');
    expect(await SS.version()).to.equal('1.2.0');
    expect(await SSW.version()).to.equal('1.0.0');
    expect(await QS.version()).to.equal('1.0.0');
    expect(await QS.name()).to.equal('QueryInferenceSettlement');
    expect(await Hub['isContract(address)'](await QS.getAddress())).to.equal(true);
    for (const [getter, name] of [
      ['queryInferenceStorage', 'QueryInferenceStorage'],
      ['serviceSubscriptionsStorage', 'ServiceSubscriptionsStorage'],
      ['chronos', 'Chronos'],
      ['identityStorage', 'IdentityStorage'],
      ['profileStorage', 'ProfileStorage'],
      ['shardingTableStorage', 'ShardingTableStorage'],
      ['randomSamplingStorage', 'RandomSamplingStorage'],
      ['convictionStakingStorage', 'ConvictionStakingStorage'],
      ['parametersStorage', 'ParametersStorage'],
    ] as const) {
      expect(await (QS as unknown as Record<string, () => Promise<string>>)[getter](), getter).to.equal(
        await Hub.getContractAddress(name),
      );
    }

    expect(await SS.queryInferenceStorage()).to.equal(await QIS.getAddress());
    expect(await SS.serviceSubscriptionsStorage()).to.equal(await SSS.getAddress());
    expect(await SSW.queryInferenceStorage()).to.equal(await QIS.getAddress());
    expect(await SSW.serviceSubscriptionsStorage()).to.equal(await SSS.getAddress());
    expect(await SSW.tokenContract()).to.equal(await Token.getAddress());
    expect(await SSW.stakingStorageAddress()).to.equal(await Hub.getContractAddress('ConvictionStakingStorage'));
    expect(await SSW.chronos()).to.equal(await Hub.getContractAddress('Chronos'));
    expect(await SSW.status()).to.equal(true);
  });

  it('sets the parameters of the development environment, λ included', async () => {
    const { QIS, SSS } = await loadFixture(deployFixture);
    expect(await QIS.maxItemsPerBatch()).to.equal(256n);
    expect(await QIS.maxGroupsPerBatch()).to.equal(32n);
    expect(await QIS.lambdaBps()).to.equal(5_000n);
    expect(await QIS.paused()).to.equal(false);
    expect(await SSS.maxBudgetsPerSubscription()).to.equal(16n);
  });

  it('a later run forwards no λ equal to the one set, before an epoch boundary or after it, and a λ that differs applies at once', async () => {
    const { Hub, Chronos, QIS } = await loadFixture(deployFixture);
    const forward = async (fn: string, args: unknown[]) =>
      Hub.forwardCall(await QIS.getAddress(), QIS.interface.encodeFunctionData(fn, args));
    const helpers = hre.helpers as unknown as {
      parametersConfig: Record<string, Record<string, Record<string, unknown>>>;
      contractDeployments: { contracts: Record<string, { evmAddress: string }> };
    };
    const config = helpers.parametersConfig.development.QueryInferenceStorage;
    const saved = { ...config };
    const deployments = helpers.contractDeployments;
    helpers.contractDeployments = {
      contracts: { Hub: { evmAddress: await Hub.getAddress() }, QueryInferenceStorage: { evmAddress: await QIS.getAddress() } },
    };
    /** A run's parameter step for the storage, and what it logged of the setters it forwarded. */
    const rerun = async () => {
      const lines: string[] = [];
      const original = console.log;
      console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
      try {
        await hre.helpers.updateContractParameters('QueryInferenceStorage', QIS as unknown as Contract);
      } finally {
        console.log = original;
      }
      return lines.filter((l) => l.includes('Setting parameter'));
    };
    try {
      // The deploy's own values: nothing to forward.
      expect(await rerun()).to.deep.equal([]);

      // Governance sets λ 3,000, and the configuration follows.
      const c = await Chronos.getCurrentEpoch();
      await forward('setLambdaBps', [3_000n]);
      config.lambdaBps = '3000';
      expect(await rerun()).to.deep.equal([]);
      await time.increaseTo(await Chronos.timestampForEpoch(c + 1n));
      expect(await rerun()).to.deep.equal([]);
      expect(await QIS.lambdaBps()).to.equal(3_000n);

      // A configuration that differs is forwarded, and reads at once.
      config.lambdaBps = '2500';
      expect(await rerun()).to.deep.equal(["[QueryInferenceStorage] Setting parameter 'lambdaBps' value to be 2500."]);
      expect(await QIS.lambdaBps()).to.equal(2_500n);
      expect(await rerun()).to.deep.equal([]);
    } finally {
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, saved);
      helpers.contractDeployments = deployments;
    }
  });

  it('activates in the deployment epoch, so a wallet subscription is funded right after the deploy', async () => {
    const { Chronos, Token, QIS, SSS, SSW, accounts } = await loadFixture(deployFixture);
    const epoch = await Chronos.getCurrentEpoch();
    expect(await QIS.activationEpoch()).to.equal(epoch);
    // The epoch takes λ when its first value counts.
    expect(await QIS.lambdaBps()).to.equal(5_000n);
    expect(await QIS.getEpochTotals(epoch)).to.deep.equal([0n, 0n, 0n]);

    const buyer = accounts[21];
    await Token.connect(buyer).approve(await SSW.getAddress(), 10n * TRAC);
    await SSW.connect(buyer).fundFromWallet(walletRequestOf(epoch));
    expect(await SSS.subscriptionExists(subscriptionIdOf(buyer.address, epoch))).to.equal(true);
    expect(await QIS.walletFunding(epoch)).to.equal(10n * TRAC);
    expect(await QIS.walletFunding(epoch + 1n)).to.equal(0n);
  });
});
