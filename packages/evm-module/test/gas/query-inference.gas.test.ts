// Gas of receipt settlement for the query/inference pool (OT-RFC-27) on the
// real account and staking stacks: receipt batches of 1, 32, 128 and 256 items,
// in one group and in many, and a batch counted in part; and the first read of
// a node's gross, with no rollover run behind its epoch and after one of 100
// epochs. A batch has no target yet: each is printed, and held to succeeding
// within the per-transaction gas of the test network. A read is held to a
// ceiling just above what it measured.
//
// "First" writes every slot from zero: the seller's nonce word, the budget's
// fill, the node's value in the epoch and the epoch's totals with its λ, so
// each first batch opens an epoch of its own. "Again" adds a batch to those
// slots, in the same nonce word but for the second batch of 256 items.
//
// A read is measured as a transaction of its own, with every slot it reads
// cold, so its figure includes the 21,000 gas of a transaction and its calldata.
// Only the first claim on a node in an epoch reads the node's gross: later
// claims read the split which that one stored.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import { ServiceBudget, CLASS_INFERENCE, CLASS_QUERY, Domain, TRAC, budget, subscriptionIdOf, walletRequestOf } from '../helpers/conviction-service';
import {
  ReceiptGroup,
  SettlementStack,
  createNode,
  deploySettlementStack,
  hardhatWallet,
  queryInferenceDomain,
  scoreNode,
  signedItems,
} from '../helpers/query-inference';

const UNIT_PRICE = 10n ** 9n;
const TX_GAS_LIMIT = 15_000_000n; // hardhat.node.config.ts, networks.hardhat.gas

// Instrumented coverage runs say nothing about deployed gas.
const skipUnderCoverage = process.argv.some((a) => a.includes('coverage'));

/** This suite's own fixture, so loadFixture keeps a snapshot for it alone. */
async function deployFixture(): Promise<SettlementStack> {
  return deploySettlementStack();
}

describe('@gas Receipt settlement of the query/inference pool', function () {
  before(function () {
    if (skipUnderCoverage) this.skip();
  });

  let f: SettlementStack;
  let domain: Domain;
  let seller: { identityId: bigint; operational: SignerWithAddress };
  const key = hardhatWallet(60);
  const measured: Array<[string, bigint, number]> = [];

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    f = await loadFixture(deployFixture);
    domain = await queryInferenceDomain(f.QIS);
    await f.Hub.forwardCall(
      await f.SSS.getAddress(),
      f.SSS.interface.encodeFunctionData('setMaxBudgetsPerSubscription', [32n]),
    );
    // λ 0.5, as the development deploy sets it, so a node's gross has both terms.
    await f.Hub.forwardCall(await f.QIS.getAddress(), f.QIS.interface.encodeFunctionData('setLambdaBps', [5_000n]));
    seller = {
      identityId: await createNode({
        ...f,
        operational: f.accounts[40],
        admin: f.accounts[41],
        stake: 1_250_000n * TRAC,
      }),
      operational: f.accounts[40],
    };
    await scoreNode(f.RSS, await f.Chronos.getCurrentEpoch(), seller.identityId);
  });

  after(() => {
    console.table(
      measured.map(([name, gas, items]) => ({
        case: name,
        gas: Number(gas),
        'per item': items > 0 ? Math.round(Number(gas) / items) : '',
      })),
    );
  });

  const record = (name: string, receipt: { gasUsed: bigint }, items = 0) => {
    expect(receipt.gasUsed <= TX_GAS_LIMIT, `${name}: ${receipt.gasUsed}`).to.equal(true);
    measured.push([name, receipt.gasUsed, items]);
  };

  const latest = async () => BigInt(await time.latest());

  /** Move on to the next epoch, where nothing has counted yet, with the seller's proof in it. */
  const nextEpoch = async (): Promise<bigint> => {
    const e = (await f.Chronos.getCurrentEpoch()) + 1n;
    await time.increaseTo(await f.Chronos.timestampForEpoch(e));
    await scoreNode(f.RSS, e, seller.identityId);
    return e;
  };

  /** A wallet subscription of the current epoch for buyer `index`, with `budgets` budgets of 1,000 TRAC. */
  const fund = async (index: number, budgets: number): Promise<string> => {
    const epoch = await f.Chronos.getCurrentEpoch();
    const who = f.accounts[index];
    const list: ServiceBudget[] = Array.from({ length: budgets }, (_, i) =>
      budget(i, i % 2 === 0 ? CLASS_INFERENCE : CLASS_QUERY, 1_000n * TRAC, UNIT_PRICE),
    );
    const value = list.reduce((a, b) => a + b.value, 0n);
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { budgets: list, sessionKey: key.address }));
    return subscriptionIdOf(who.address, epoch);
  };

  /** `perGroup` signed items on each (subscription, budget index) of `targets`, nonces counted per subscription. */
  const groupsOf = async (targets: Array<[string, number]>, perGroup: number, firstNonce = 0n) => {
    const issuedAt = await latest();
    const next = new Map<string, bigint>();
    const groups: ReceiptGroup[] = [];
    for (const [subscriptionId, budgetIndex] of targets) {
      const nonce = next.get(subscriptionId) ?? firstNonce;
      const { items } = signedItems({
        domain,
        wallet: key,
        subscriptionId,
        serviceId: (await f.SSS.getBudget(subscriptionId, budgetIndex)).serviceId,
        seller: seller.identityId,
        firstNonce: nonce,
        count: perGroup,
        units: 1_000n,
        price: UNIT_PRICE,
        issuedAt,
      });
      next.set(subscriptionId, nonce + BigInt(perGroup));
      groups.push({ subscriptionId, budgetIndex: BigInt(budgetIndex), minCounted: 0n, items });
    }
    return groups;
  };

  const submit = async (groups: ReceiptGroup[]) =>
    (await (await f.QS.connect(seller.operational).submitReceiptBatch(groups)).wait())!;

  it('submitReceiptBatch, one group: 1, 32, 128 and 256 items, first and again', async () => {
    for (const [i, items] of [1, 32, 128, 256].entries()) {
      await nextEpoch();
      const p = await fund(100 + i, 1);
      record(`batch, 1 group of ${items}, first`, await submit(await groupsOf([[p, 0]], items)), items);
      record(`batch, 1 group of ${items}, again`, await submit(await groupsOf([[p, 0]], items, BigInt(items))), items);
    }
  });

  it('submitReceiptBatch, many groups: 128 items in 4 groups, 256 in 4, 256 in 32 over 8 subscriptions, and 32 of one item each on one subscription', async () => {
    await nextEpoch();
    const p = await fund(110, 4);
    record('batch, 4 groups of 32 (128), first', await submit(await groupsOf([0, 1, 2, 3].map((i) => [p, i]), 32)), 128);
    await nextEpoch();
    const q = await fund(111, 4);
    record('batch, 4 groups of 64 (256), first', await submit(await groupsOf([0, 1, 2, 3].map((i) => [q, i]), 64)), 256);
    await nextEpoch();
    const subscriptions: string[] = [];
    for (let i = 0; i < 8; i++) subscriptions.push(await fund(120 + i, 4));
    const targets = subscriptions.flatMap((pp) => [0, 1, 2, 3].map((i) => [pp, i] as [string, number]));
    record('batch, 32 groups of 8 (256) over 8 subscriptions, first', await submit(await groupsOf(targets, 8)), 256);
    await nextEpoch();
    const many = await fund(130, 32);
    const budgets = Array.from({ length: 32 }, (_, i) => [many, i] as [string, number]);
    record('batch, 32 groups of 1 on one subscription, first', await submit(await groupsOf(budgets, 1)), 32);
  });

  it('submitReceiptBatch, counted in part: a group worth more than its budget has left', async () => {
    await nextEpoch();
    const over = await fund(131, 1);
    // 1,000 TRAC funded, 2,000 TRAC of receipts.
    const { items } = signedItems({
      domain,
      wallet: key,
      subscriptionId: over,
      serviceId: (await f.SSS.getBudget(over, 0n)).serviceId,
      seller: seller.identityId,
      count: 2,
      units: 10n ** 12n,
      price: UNIT_PRICE,
      issuedAt: await latest(),
    });
    record('batch, 1 group of 2, counted in part, first', await submit([{ subscriptionId: over, budgetIndex: 0n, minCounted: 0n, items }]), 2);
    expect(await f.QIS.budgetUsed(over, 0n)).to.equal(1_000n * TRAC);
    expect(await f.QS.budgetLeft(over, 0n)).to.equal(0n);
  });

  it('queryInferenceGross, the first read: a node with value and a node with none, with no rollover run behind the epoch and after a run of 100 epochs', async () => {
    const buyer = 140;
    const SUBSCRIPTION = 1_000n * TRAC;
    const noValue = await createNode({ ...f, operational: f.accounts[42], admin: f.accounts[43] });
    const read = async (epoch: bigint, identityId: bigint) => {
      const tx = await f.accounts[0].sendTransaction({
        to: await f.QS.getAddress(),
        data: f.QS.interface.encodeFunctionData('queryInferenceGross', [epoch, identityId]),
      });
      return (await tx.wait())!;
    };
    /** Each ceiling is what its read measured, rounded up to the next 1,000 gas, or the figure the contract documents. */
    const held = (name: string, receipt: { gasUsed: bigint }, ceiling: bigint) => {
      record(name, receipt);
      expect(receipt.gasUsed, name).to.be.at.most(ceiling);
    };
    const landValue = async () => submit(await groupsOf([[await fund(buyer, 1), 0]], 1));
    const a = await f.QIS.activationEpoch();
    expect(await f.Chronos.getCurrentEpoch()).to.equal(a);
    const atActivation = await takeSnapshot();

    // Value in the activation epoch, where the read steps back through nothing;
    // and in the next epoch, where it steps back once, to the value before it.
    await landValue();
    await nextEpoch();
    expect(await f.QS.queryInferenceGross(a, seller.identityId)).to.equal(SUBSCRIPTION);
    const noRun = await read(a, seller.identityId);
    held('queryInferenceGross, value, no run, at activation', noRun, 45_000n);
    await landValue();
    await nextEpoch();
    expect(await f.QS.queryInferenceGross(a + 1n, seller.identityId)).to.equal(SUBSCRIPTION);
    held('queryInferenceGross, value, no run, value the epoch before', await read(a + 1n, seller.identityId), 49_000n);
    const noValueNoRun = await read(a + 1n, noValue);
    held('queryInferenceGross, no value, no run', noValueNoRun, 31_000n);

    // 100 epochs of money and no value, down to the activation epoch, and then value.
    await atActivation.restore();
    for (let e = a; e < a + 100n; e++) {
      if (e > a) await time.increaseTo(await f.Chronos.timestampForEpoch(e));
      await fund(buyer, 1);
    }
    const end = await nextEpoch();
    expect(end).to.equal(a + 100n);
    await landValue();
    await nextEpoch();

    // The sole seller's gross is all 101 subscriptions' money, so the read walked the whole run.
    expect(await f.QS.epochPool(end - 1n)).to.equal(0n);
    expect(await f.QS.epochPool(end)).to.equal(101n * SUBSCRIPTION);
    expect(await f.QS.queryInferenceGross(end, seller.identityId)).to.equal(101n * SUBSCRIPTION);
    expect(await f.QS.queryInferenceGross(end, noValue)).to.equal(0n);
    const afterRun = await read(end, seller.identityId);
    held('queryInferenceGross, value, after a run of 100 epochs', afterRun, 1_016_000n);
    // About 10,000 gas per epoch, as QueryInferenceSettlement.epochPool says.
    held('queryInferenceGross, each epoch of the run', { gasUsed: (afterRun.gasUsed - noRun.gasUsed) / 100n }, 10_000n);

    // A node with no value walks nothing: the run costs it not one gas.
    const noValueAfterRun = await read(end, noValue);
    held('queryInferenceGross, no value, after a run of 100 epochs', noValueAfterRun, 31_000n);
    expect(noValueAfterRun.gasUsed).to.equal(noValueNoRun.gasUsed);
  });
});
