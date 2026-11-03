// The development deploy of the plan-period contracts (OT-RFC-27), run through
// the real deploy steps 052c, 052d, 052e and 052f on the in-process network:
//   - every contract is registered in the Hub and wired, in an order that lets
//     each initialize as it is deployed;
//   - the parameters of deployments/parameters.json are set, λ at once, and a
//     later run forwards no λ or grace equal to the latest one accepted;
//   - the activation epoch is the deployment epoch, so a period can be funded
//     right after the deploy, as the suites and the local devnet do.

import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { Contract } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionServiceStorage,
  Hub,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  ServiceSubscriptions,
  ServiceSubscriptionsWallet,
  Token,
} from '../typechain';
import { ACCOUNT_STACK_TAGS, TRAC, subscriptionIdOf, walletRequestOf } from './helpers/conviction-service';

async function deployFixture() {
  await hre.deployments.fixture([
    ...ACCOUNT_STACK_TAGS,
    'ServiceSubscriptions',
    'QueryInferenceSettlement',
    'QueryInferenceActivation',
  ]);
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
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
    accounts: await hre.ethers.getSigners(),
  };
}

describe('@integration The development deploy of the plan-period contracts', () => {
  beforeEach(() => {
    hre.helpers.resetDeploymentsJson();
  });

  it('registers and wires every contract, at the versions of this release', async () => {
    const { Hub, Token, QIS, CSS, SS, SSW, QS } = await loadFixture(deployFixture);
    expect(await QIS.version()).to.equal('1.0.0');
    expect(await CSS.version()).to.equal('1.2.0');
    expect(await SS.version()).to.equal('1.2.0');
    expect(await SSW.version()).to.equal('1.0.0');
    expect(await QS.version()).to.equal('1.0.0');
    expect(await QS.name()).to.equal('QueryInferenceSettlement');
    expect(await Hub['isContract(address)'](await QS.getAddress())).to.equal(true);
    for (const [getter, name] of [
      ['queryInferenceStorage', 'QueryInferenceStorage'],
      ['convictionServiceStorage', 'ConvictionServiceStorage'],
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

  it('a later run forwards no λ or receipt grace equal to the latest accepted, scheduled or already in force', async () => {
    const { Hub, Chronos, QIS } = await loadFixture(deployFixture);
    const forward = async (fn: string, args: unknown[]) =>
      Hub.forwardCall(await QIS.getAddress(), QIS.interface.encodeFunctionData(fn, args));
    const helpers = hre.helpers as unknown as {
      parametersConfig: Record<string, Record<string, Record<string, string>>>;
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
      const c = await Chronos.getCurrentEpoch();
      // Governance schedules λ 3,000 and a grace of 1,800 s for the next
      // epoch, and the configuration follows.
      await forward('setLambdaBps', [3_000n]);
      await forward('setReceiptGraceSeconds', [1_800n]);
      Object.assign(config, { lambdaBps: '3000', receiptGraceSeconds: '1800' });
      const schedule = async () => [
        await QIS.nextLambdaBps(),
        await QIS.nextLambdaFromEpoch(),
        await QIS.nextReceiptGraceSeconds(),
        await QIS.nextReceiptGraceFromEpoch(),
      ];

      // Scheduled, not yet in force: nothing is forwarded.
      expect(await rerun()).to.deep.equal([]);
      // In force, in the epoch where it took effect, with the epoch before it
      // still open: forwarding either value would revert the whole run.
      await time.increaseTo(await Chronos.timestampForEpoch(c + 1n));
      expect(await rerun()).to.deep.equal([]);
      expect(await schedule()).to.deep.equal([3_000n, c + 1n, 1_800n, c + 1n]);
      expect([await QIS.latestLambdaBps(), await QIS.latestReceiptGraceSeconds()]).to.deep.equal([3_000n, 1_800n]);
    } finally {
      for (const key of Object.keys(config)) delete config[key];
      Object.assign(config, saved);
      helpers.contractDeployments = deployments;
    }
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
