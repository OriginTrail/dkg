// Gas of receipt settlement for the query/inference pool (OT-RFC-27) on the
// real account and staking stacks: receipt batches of 1, 32, 128 and 256
// items, in one group and in many; finalization of one claim and of many;
// and epoch closes. Each case is measured and printed for review; none has a
// target yet, so the test holds each transaction to succeeding, and every
// batch to the per-transaction gas of the test network.
//
// "First" writes every slot from zero: the seller's nonce word, its claim and
// the bucket's total. "Again" adds a batch to a claim that exists.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ContractTransactionReceipt } from 'ethers';
import hre from 'hardhat';

import { Bucket, CLASS_INFERENCE, CLASS_QUERY, Domain, TRAC, bucket, subscriptionIdOf, walletRequestOf } from '../helpers/conviction-service';
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

const UNIT_ASK = 10n ** 9n;
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
      await f.CSS.getAddress(),
      f.CSS.interface.encodeFunctionData('setMaxBucketsPerPeriod', [32n]),
    );
    seller = {
      identityId: await createNode({
        ...f,
        operational: f.accounts[40],
        admin: f.accounts[41],
        stake: 1_250_000n * TRAC,
      }),
      operational: f.accounts[40],
    };
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

  const record = (name: string, receipt: ContractTransactionReceipt, items = 0) => {
    expect(receipt.gasUsed <= TX_GAS_LIMIT, `${name}: ${receipt.gasUsed}`).to.equal(true);
    measured.push([name, receipt.gasUsed, items]);
  };

  const latest = async () => BigInt(await time.latest());

  /** A wallet period of the current epoch for buyer `index`, with `buckets` buckets of 1,000 TRAC. */
  const fund = async (index: number, buckets: number): Promise<string> => {
    const epoch = await f.Chronos.getCurrentEpoch();
    const who = f.accounts[index];
    const list: Bucket[] = Array.from({ length: buckets }, (_, i) =>
      bucket(i, i % 2 === 0 ? CLASS_INFERENCE : CLASS_QUERY, 1_000n * TRAC, UNIT_ASK),
    );
    const value = list.reduce((a, b) => a + b.value, 0n);
    await f.Token.mint(who.address, value);
    await f.Token.connect(who).approve(await f.SSW.getAddress(), value);
    await f.SSW.connect(who).fundFromWallet(walletRequestOf(epoch, { buckets: list, sessionKey: key.address }));
    return subscriptionIdOf(who.address, epoch);
  };

  /** `perGroup` signed items on each (period, bucket index) of `targets`, nonces counted per period. */
  const groupsOf = async (targets: Array<[string, number]>, perGroup: number, firstNonce = 0n) => {
    const issuedAt = await latest();
    const next = new Map<string, bigint>();
    const groups: ReceiptGroup[] = [];
    for (const [subscriptionId, bucketIndex] of targets) {
      const nonce = next.get(subscriptionId) ?? firstNonce;
      const { items } = signedItems({
        domain,
        wallet: key,
        subscriptionId,
        bucketId: (await f.CSS.getBucket(subscriptionId, bucketIndex)).bucketId,
        seller: seller.identityId,
        firstNonce: nonce,
        count: perGroup,
        units: 1_000n,
        ask: UNIT_ASK,
        issuedAt,
      });
      next.set(subscriptionId, nonce + BigInt(perGroup));
      groups.push({ subscriptionId, bucketIndex: BigInt(bucketIndex), items });
    }
    return groups;
  };

  const submit = async (groups: ReceiptGroup[]) =>
    (await (await f.QS.connect(seller.operational).submitReceiptBatch(groups)).wait())!;

  it('submitReceiptBatch, one group: 1, 32, 128 and 256 items, first and again', async () => {
    for (const [i, items] of [1, 32, 128, 256].entries()) {
      const p = await fund(100 + i, 1);
      record(`batch, 1 group of ${items}, first`, await submit(await groupsOf([[p, 0]], items)), items);
      record(`batch, 1 group of ${items}, again`, await submit(await groupsOf([[p, 0]], items, BigInt(items))), items);
    }
  });

  it('submitReceiptBatch, many groups: 128 items in 4 groups, 256 in 4, and 256 in 32 over 8 periods', async () => {
    const p = await fund(110, 4);
    record('batch, 4 groups of 32 (128), first', await submit(await groupsOf([0, 1, 2, 3].map((i) => [p, i]), 32)), 128);
    const q = await fund(111, 4);
    record('batch, 4 groups of 64 (256), first', await submit(await groupsOf([0, 1, 2, 3].map((i) => [q, i]), 64)), 256);
    const periods: string[] = [];
    for (let i = 0; i < 8; i++) periods.push(await fund(120 + i, 4));
    const targets = periods.flatMap((pp) => [0, 1, 2, 3].map((i) => [pp, i] as [string, number]));
    record('batch, 32 groups of 8 (256) over 8 periods, first', await submit(await groupsOf(targets, 8)), 256);
  });

  it('finalizeClaims: one claim under the cap, one over it, and 32 claims in one call', async () => {
    const e = await f.Chronos.getCurrentEpoch();
    const under = await fund(130, 1);
    const over = await fund(131, 1);
    const many = await fund(132, 32);
    await submit(await groupsOf([[under, 0]], 1));
    // 1,000 TRAC funded, 2,000 TRAC claimed.
    const big = signedItems({
      domain,
      wallet: key,
      subscriptionId: over,
      bucketId: (await f.CSS.getBucket(over, 0n)).bucketId,
      seller: seller.identityId,
      count: 2,
      units: 10n ** 12n,
      ask: UNIT_ASK,
      issuedAt: await latest(),
    });
    await submit([{ subscriptionId: over, bucketIndex: 0n, items: big.items }]);
    await submit(await groupsOf(Array.from({ length: 32 }, (_, i) => [many, i] as [string, number]), 1));

    const deadline = (await f.Chronos.timestampForEpoch(e + 1n)) + (await f.QIS.receiptGraceSecondsAt(e));
    await time.increaseTo(deadline + 1n);
    await scoreNode(f.RSS, e + 1n, seller.identityId);
    const ref = (subscriptionId: string, bucketIndex: number) => ({
      subscriptionId,
      bucketIndex: BigInt(bucketIndex),
      seller: seller.identityId,
    });
    const finalize = async (refs: ReturnType<typeof ref>[]) => (await (await f.QS.finalizeClaims(refs)).wait())!;
    record('finalizeClaims, 1 claim under the cap', await finalize([ref(under, 0)]));
    record('finalizeClaims, 1 claim over the cap', await finalize([ref(over, 0)]));
    record('finalizeClaims, 32 claims', await finalize(Array.from({ length: 32 }, (_, i) => ref(many, i))));
    record('finalizeClaims, 1 claim skipped (finalized)', await finalize([ref(under, 0)]));
  });

  it('closeEpochs and ensureClosed: an epoch with a pool, an empty epoch, 32 epochs, and nothing to close', async () => {
    const e = await f.Chronos.getCurrentEpoch();
    const p = await fund(140, 1);
    await submit(await groupsOf([[p, 0]], 1));
    const deadline = (await f.Chronos.timestampForEpoch(e + 1n)) + (await f.QIS.receiptGraceSecondsAt(e));
    await time.increaseTo(deadline + 1n);
    await scoreNode(f.RSS, e + 1n, seller.identityId);
    await f.QS.finalizeClaims([{ subscriptionId: p, bucketIndex: 0n, seller: seller.identityId }]);
    await time.increaseTo(await f.Chronos.timestampForEpoch(e + 2n));

    const close = async (steps: bigint) => (await (await f.QS.closeEpochs(steps)).wait())!;
    record('closeEpochs, 1 empty epoch', await close(1n));
    record('closeEpochs, 1 epoch with a pool', await close(1n));
    record('closeEpochs, nothing to close', await close(10n));
    await time.increaseTo(await f.Chronos.timestampForEpoch(e + 34n));
    record('closeEpochs, 32 empty epochs', await close(32n));
    record('ensureClosed, already closed', (await (await f.QS.ensureClosed(e + 33n)).wait())!);
  });
});
