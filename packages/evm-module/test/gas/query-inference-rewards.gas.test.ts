// Gas of a StakingV10 claim per claimed epoch, with and without the
// query/inference pool (OT-RFC-27), on the development deploy of the staking,
// account and subscription stacks. Every case claims the same position over 1
// and over 4 epochs; in each epoch the node proves and takes the publishing
// pool, and, with the pool active, a wallet-funded subscription brings the epoch its
// money. The claim comes as soon as the last epoch has ended, and it is the
// first on the node in each epoch, so it splits off the operator fee there.
//
// The cases:
//   - no pool: the Hub holds no settlement, so StakingV10 wires none;
//   - pool not active: the settlement is wired, its activation epoch unset;
//   - pool, no value: no receipt lands, so each epoch's money rolls forward and
//     the node's gross reads 0 without walking the run;
//   - pool: the node lands receipts in each epoch, and the claim reads its
//     gross, with nothing to run first.
// "per epoch" is the cost of each epoch past the first: (4 epochs − 1 epoch) / 3.
// None has a target; each is held to succeeding within the test network's
// per-transaction gas.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract } from 'ethers';
import hre from 'hardhat';

import {
  ServiceSubscriptionsStorage,
  QueryInferenceSettlement,
  QueryInferenceStorage,
  ServiceSubscriptionsWallet,
} from '../../typechain';
import { deployAccountStack } from '../helpers/account-stack';
import {
  ACCOUNT_STACK_TAGS,
  CLASS_INFERENCE,
  Domain,
  TRAC,
  budget,
  subscriptionIdOf,
  walletRequestOf,
} from '../helpers/conviction-service';
import { SCALE18, hardhatWallet, queryInferenceDomain, signedItems } from '../helpers/query-inference';

const UNIT_PRICE = 10n ** 15n;
const TX_GAS_LIMIT = 15_000_000n; // hardhat.node.config.ts, networks.hardhat.gas

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture() {
  const { ES: EpochStorage, ...stack } = await deployAccountStack([
    ...ACCOUNT_STACK_TAGS,
    'ServiceSubscriptions',
    'QueryInferenceSettlement',
    'QueryInferenceActivation',
  ]);
  const at = async <T>(name: string) =>
    (await hre.ethers.getContractAt(name, await stack.Hub.getContractAddress(name))) as T;
  return {
    ...stack,
    EpochStorage,
    QIS: await at<QueryInferenceStorage>('QueryInferenceStorage'),
    SSS: await at<ServiceSubscriptionsStorage>('ServiceSubscriptionsStorage'),
    SSW: await at<ServiceSubscriptionsWallet>('ServiceSubscriptionsWallet'),
    QS: await at<QueryInferenceSettlement>('QueryInferenceSettlement'),
  };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;
type Mode = 'no pool' | 'pool not active' | 'pool, no value' | 'pool';

describe('@gas StakingV10 claims with and without the query/inference pool', function () {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let f: Fixture;
  let domain: Domain;
  const key = hardhatWallet(60);
  const measured = new Map<Mode, [bigint, bigint]>();

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
  });

  after(() => {
    console.table(
      [...measured.entries()].map(([mode, [one, four]]) => ({
        case: mode,
        '1 epoch': Number(one),
        '4 epochs': Number(four),
        'per epoch': Number((four - one) / 3n),
      })),
    );
  });

  const forward = async (contract: BaseContract, fn: string, args: unknown[] = []) =>
    f.Hub.forwardCall(await contract.getAddress(), contract.interface.encodeFunctionData(fn, args));
  const latest = async () => BigInt(await time.latest());
  const toEpoch = async (e: bigint) => time.increaseTo(await f.Chronos.timestampForEpoch(e));

  const delegate = async (staker: SignerWithAddress, identityId: bigint, amount: bigint) => {
    await f.Token.mint(staker.address, amount);
    await f.Token.connect(staker).approve(await f.StakingV10.getAddress(), amount);
    await f.StakingNFT.connect(staker).createConviction(identityId, amount, 0n);
    return f.StakingNFT.nextTokenId();
  };

  /** Claim one position over `epochs` epochs in `mode`; returns the claim's gas. */
  const claimGas = async (mode: Mode, epochs: bigint): Promise<bigint> => {
    if (mode === 'no pool') {
      await f.Hub.removeContractByName('QueryInferenceSettlement');
      await forward(f.StakingV10, 'initialize');
      expect(await f.StakingV10.queryInferenceSettlement()).to.equal(hre.ethers.ZeroAddress);
    } else if (mode === 'pool not active') {
      const fresh = (await (
        await hre.ethers.getContractFactory('QueryInferenceStorage')
      ).deploy(await f.Hub.getAddress())) as unknown as QueryInferenceStorage;
      await fresh.waitForDeployment();
      await f.Hub.setContractAddress('QueryInferenceStorage', await fresh.getAddress());
      await forward(fresh, 'initialize');
      for (const c of [f.QS, f.StakingV10]) await forward(c, 'initialize');
      expect(await fresh.activationEpoch()).to.equal(0n);
    }
    const withMoney = mode === 'pool, no value' || mode === 'pool';

    const [operational, admin, delegator, buyer] = [f.accounts[30], f.accounts[31], f.accounts[10], f.accounts[20]];
    const label = 'gas seller';
    const receipt = await (
      await f.Profile.connect(operational).createProfile(
        admin.address,
        [],
        label,
        hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label)),
        1_000n,
      )
    ).wait();
    const node = BigInt(receipt!.logs[0].topics[1]);
    await delegate(operational, node, 1_250_000n * TRAC);
    const tokenId = await delegate(delegator, node, 250_000n * TRAC);

    const a = await f.Chronos.getCurrentEpoch();
    const last = a + epochs - 1n;
    for (let e = a; e <= last; e++) {
      if (e > a) await toEpoch(e);
      // The node's proofs, which its batch needs first, and the publishing pool.
      const score = 100n * TRAC;
      await f.RSS.addToNodeEpochScore(e, node, score);
      await f.RSS.addToAllNodesEpochScore(e, score);
      await f.RSS.setNodeEpochScorePerStake(e, node, (score * SCALE18) / (await f.Vault.getNodeEffectiveStake(node)));
      await f.EpochStorage.addTokensToEpochRange(1, e, e, 500n * TRAC);
      await f.Token.mint(await f.Vault.getAddress(), 500n * TRAC);
      if (withMoney) {
        await f.Token.mint(buyer.address, 40n * TRAC);
        await f.Token.connect(buyer).approve(await f.SSW.getAddress(), 40n * TRAC);
        await f.SSW.connect(buyer).fundFromWallet(
          walletRequestOf(e, { budgets: [budget(0, CLASS_INFERENCE, 40n * TRAC, UNIT_PRICE)], sessionKey: key.address }),
        );
      }
      if (mode === 'pool') {
        const p = subscriptionIdOf(buyer.address, e);
        const { items } = signedItems({
          domain,
          wallet: key,
          subscriptionId: p,
          serviceId: (await f.SSS.getBudget(p, 0n)).serviceId,
          seller: node,
          count: 1,
          units: (8n * TRAC) / UNIT_PRICE,
          price: UNIT_PRICE,
          issuedAt: await latest(),
        });
        await f.QS.connect(operational).submitReceiptBatch([{ subscriptionId: p, budgetIndex: 0n, minCounted: 0n, items }]);
      }
    }
    await toEpoch(last + 1n);

    const tx = await f.StakingNFT.connect(delegator).claim(tokenId);
    const gas = (await tx.wait())!.gasUsed;
    expect(gas).to.be.lessThan(TX_GAS_LIMIT);
    if (withMoney) {
      expect(await f.QS.queryInferenceGross(last, node)).to.equal(mode === 'pool' ? 40n * TRAC : 0n);
      expect(await f.QS.epochPool(last)).to.equal(mode === 'pool' ? 40n * TRAC : 0n);
    }
    // What the claim split: the publishing pool, and the query/inference gross
    // where the node has value, less the operator fee of 10 %.
    const gross = 500n * TRAC + (mode === 'pool' ? 40n * TRAC : 0n);
    expect(await f.Vault.getNetNodeEpochRewards(node, last)).to.equal(gross - gross / 10n);
    expect((await f.Vault.getPosition(tokenId)).lastClaimedEpoch).to.equal(last);
    return gas;
  };

  for (const mode of ['no pool', 'pool not active', 'pool, no value', 'pool'] as Mode[]) {
    it(`claims over 1 and 4 epochs: ${mode}`, async () => {
      const one = await claimGas(mode, 1n);
      f = await loadFixture(deployFixture);
      domain = await queryInferenceDomain(f.QIS);
      const four = await claimGas(mode, 4n);
      measured.set(mode, [one, four]);
    });
  }
});
