// The window bookings of a use-time Conviction Account (OT-RFC-27,
// PublishingConviction 10.2.0): once billing window w has closed, the next
// touch books its unused budget B − windowSpent[w] to the staker pool, spread
// over the lock's epoch-lengths after the window's close — the per-window math
// of the 10.0.8 schedule, one window at a time.
//
// Covered, against an exact model of the contract math and EpochStorage:
//   - on time (in the epoch in which the window closes), an idle account gets,
//     window by window, exactly the credits its 10.0.8 schedule wrote for that
//     window, and at the end of the lock exactly the same pool, epoch by epoch;
//   - late, no booking credits an epoch that has ended: the share of the
//     spread that falls on the ended epochs is booked into the current epoch,
//     and the rest of the spread is as scheduled. One epoch late, the credits
//     are the same on an idle shard as on one another booking has just
//     finalized; several epochs late, on the staker and the treasury shard
//     alike, the windows are conserved; and the expiry tail of an account
//     swept epochs after its lock lands in the current epoch;
//   - the batch settleMany(uint256[]) books exactly what settling each account
//     alone books;
//   - with a treasury wired, a booking splits net and fee on one curve, and a
//     use-time publish skims its fee at once.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, Result } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionScheduleHarness,
  PublishingConvictionStorage,
  Token,
} from '../typechain';
import { ACCOUNT_STACK_TAGS, TRAC, costOf } from './helpers/conviction-service';
import { PoolModel, feeOf, fromCurrentEpoch, prorateActiveSink, scheduleModel } from './helpers/emission-model';
import { deployScheduleHarness } from './helpers/scheduled-accounts';

const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;
// The 20 % tier, with `committed mod lock` dust.
const COMMITTED = 50_000n * TRAC + 7n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  ES: EpochStorage;
  Params: ParametersStorage;
  NFT: DKGPublishingConvictionNFT;
  PC: PublishingConviction;
  PCS: PublishingConvictionStorage;
  Harness: PublishingConvictionScheduleHarness;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture(ACCOUNT_STACK_TAGS);
  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  const Harness = await deployScheduleHarness(Hub);
  await Hub.setContractAddress('KnowledgeAssetsLifecycle', accounts[5].address);
  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    ES: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    Params: await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>('DKGPublishingConvictionNFT'),
    PC: await hre.ethers.getContract<PublishingConviction>('PublishingConviction'),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>('PublishingConvictionStorage'),
    Harness,
  };
}

describe('@integration Window bookings of a use-time Conviction Account (PublishingConviction 10.2.0)', function () {
  let accounts: SignerWithAddress[];
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let NFT: DKGPublishingConvictionNFT;
  let PC: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let Harness: PublishingConvictionScheduleHarness;

  let epLen: bigint;
  let lock: bigint;
  let kal: SignerWithAddress;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({ accounts, Token, Chronos: ChronosContract, ES, Params, NFT, PC, PCS, Harness } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
    kal = accounts[5];
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  const blockTime = async (receipt: ContractTransactionReceipt) =>
    BigInt((await hre.ethers.provider.getBlock(receipt.blockNumber))!.timestamp);

  const createAccount = async (holder: SignerWithAddress, committed: bigint = COMMITTED) => {
    await Token.mint(holder.address, committed);
    await Token.connect(holder).approve(await NFT.getAddress(), committed);
    const receipt = (await (await NFT.connect(holder).createAccount(committed, 0)).wait())!;
    return { accountId: await NFT.totalSupply(), createdAt: await blockTime(receipt) };
  };

  const settle = async (accountId: bigint) => (await (await PC.settle(accountId)).wait())!;

  const eventsOf = async (receipt: ContractTransactionReceipt, contract: BaseContract, name: string) => {
    const address = (await contract.getAddress()).toLowerCase();
    const out: Result[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== address) continue;
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === name) out.push(parsed.args);
    }
    return out;
  };

  /** The ranges a receipt credited to `shard`, as [start, end, amount], in order. */
  const credits = async (receipt: ContractTransactionReceipt, shard: bigint = STAKER_SHARD_ID): Promise<bigint[][]> =>
    (await eventsOf(receipt, ES, 'TokensAddedToEpochRange'))
      .filter((a) => a.shardId === shard)
      .map((a) => [a.startEpoch, a.endEpoch, a.tokenAmount]);

  const asTuples = (ranges: Array<{ start: bigint; end: bigint; amount: bigint }>) =>
    ranges.map((r) => [r.start, r.end, r.amount]);

  const poolSnapshot = async (from: bigint, to: bigint, shard: bigint = STAKER_SHARD_ID) => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) out.set(e, await ES.getEpochPool(shard, e));
    return out;
  };

  /** The epoch a transaction ran in. */
  const epochOf = async (receipt: ContractTransactionReceipt) => ChronosContract.epochAtTimestamp(await blockTime(receipt));

  /** What `receipt` added to each epoch's pool on `shard`, over [from, to], given the pools before it. */
  const deltas = async (before: Map<bigint, bigint>, from: bigint, to: bigint, shard: bigint = STAKER_SHARD_ID) => {
    const out = new Map<bigint, bigint>();
    for (const [e, v] of await poolSnapshot(from, to, shard)) out.set(e, v - before.get(e)!);
    return out;
  };

  /**
   * The property, without the model: nothing `receipt` credited to `shard`
   * starts before the epoch it ran in, and no ended epoch's pool moved.
   */
  const expectNoEndedEpochCredited = async (
    receipt: ContractTransactionReceipt,
    delta: Map<bigint, bigint>,
    shard: bigint = STAKER_SHARD_ID,
  ) => {
    const current = await epochOf(receipt);
    const got = await credits(receipt, shard);
    expect(got.length).to.be.greaterThan(0);
    for (const [start] of got) expect(start >= current, `credit from ${start} in ${current}`).to.equal(true);
    for (const [e, v] of delta) if (e < current) expect(v, `ended epoch ${e}`).to.equal(0n);
  };

  // -------------------------------------------------------------------------
  // On time
  // -------------------------------------------------------------------------

  it('on time, an idle account gets window by window exactly the credits its 10.0.8 schedule wrote, and the same pool epoch by epoch', async () => {
    const { accountId, createdAt } = await createAccount(accounts[20]);
    const first = await ChronosContract.epochAtTimestamp(createdAt + epLen);
    const from = first - 1n;
    const to = first + 2n * lock + 1n;
    const snapshot = await takeSnapshot();

    // What 10.0.8 wrote at creation: every window at once.
    const scheduled = (await (await Harness.scheduleInFull(accountId)).wait())!;
    const schedule = await credits(scheduled);
    const schedulePool = await poolSnapshot(from, to);
    const scheduleCarry = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    await snapshot.restore();
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(0n);

    // Use time: each window booked at its close, in the epoch it closes in.
    const booked: bigint[][] = [];
    for (let w = 0n; w < lock; w++) {
      const close = createdAt + (w + 1n) * epLen;
      await time.setNextBlockTimestamp(close);
      const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);
      const receipt = await settle(accountId);
      const got = await credits(receipt);

      // The window's own ranges of the 10.0.8 schedule: none of them starts
      // before the epoch the window closes in, the epoch of the booking.
      const model = new PoolModel(carry);
      await scheduleModel({
        chronos: ChronosContract,
        model,
        committed: COMMITTED,
        createdAtTimestamp: createdAt,
        lock,
        epLen,
        currentEpoch: await epochOf(receipt),
        fromWindow: w,
        toWindow: w + 1n,
      });
      expect(got, `window ${w}`).to.deep.equal(asTuples(model.credited));
      expect(got[0][0], `window ${w}`).to.equal(await ChronosContract.epochAtTimestamp(close));
      const [ev] = await eventsOf(receipt, PC, 'EmissionScheduled');
      expect([ev.fromWindow, ev.toWindow]).to.deep.equal([w, w + 1n]);
      booked.push(...got);
    }

    // Window by window, the very ranges of the schedule, in its order...
    expect(booked).to.deep.equal(schedule);
    // ...so the pool and the shard's carry end exactly where the schedule left them.
    expect(await poolSnapshot(from, to)).to.deep.equal(schedulePool);
    expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(scheduleCarry);
    expect((await PCS.getAccount(accountId)).fullySwept).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // Late
  // -------------------------------------------------------------------------

  it("one epoch late, the close epoch's share is booked into the current epoch, the same on an idle shard as on a busy one, and the rest is as scheduled", async () => {
    const { accountId, createdAt } = await createAccount(accounts[20]);
    const close = createdAt + epLen;
    const anchor = await ChronosContract.epochAtTimestamp(close);
    const B = COMMITTED / lock;
    const scheduled = prorateActiveSink(
      B,
      anchor,
      lock,
      epLen,
      (await ChronosContract.timestampForEpoch(anchor + 1n)) - close,
    );
    // The close epoch's share, booked into the current epoch ahead of the
    // rest; the full epochs, which start in the current epoch, and the final
    // one are untouched.
    const expected = [[anchor + 1n, anchor + 1n, scheduled[0].amount], ...asTuples(scheduled.slice(1))];

    // Another account, whose publish books into the shard on the busy run.
    const other = await createAccount(accounts[21]);
    await NFT.connect(accounts[21]).registerAgent(other.accountId, accounts[22].address);
    // Into the next epoch: the epoch the window closed in has ended.
    await time.increaseTo(await ChronosContract.timestampForEpoch(anchor + 1n));
    const snapshot = await takeSnapshot();
    const from = anchor - 1n;
    const to = anchor + lock + 1n;

    const lateBooking = async () => {
      const before = await poolSnapshot(from, to);
      const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);
      const receipt = await settle(accountId);
      expect(await epochOf(receipt)).to.equal(anchor + 1n);
      expect(await credits(receipt)).to.deep.equal(expected);
      const delta = await deltas(before, from, to);
      await expectNoEndedEpochCredited(receipt, delta);
      const model = new PoolModel(carry);
      for (const r of fromCurrentEpoch(scheduled, anchor + 1n)) model.add(r);
      for (const [e, v] of delta) expect(v, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
    };

    // Idle: nothing has booked into the shard since before the close, so
    // EpochStorage has not finalized the close epoch and would credit it.
    expect(await ES.lastFinalizedEpoch(STAKER_SHARD_ID)).to.be.lessThan(anchor);
    await lateBooking();

    // Busy: a publish in the current epoch has just finalized the shard
    // through the close epoch.
    await snapshot.restore();
    await NFT.connect(kal).coverPublishingCost(accounts[22].address, TRAC, anchor + 1n, 1n);
    expect(await ES.lastFinalizedEpoch(STAKER_SHARD_ID)).to.equal(anchor);
    await lateBooking();
  });

  it('several epochs late, every share of the ended epochs is booked into the current epoch, on the staker and the treasury shard alike, and the windows are conserved', async () => {
    const treasury = accounts[9];
    await Params.setProtocolTreasury(treasury.address);
    const feeBps = BigInt(await Params.protocolTreasuryFee());
    const { accountId, createdAt } = await createAccount(accounts[20]);
    const B = COMMITTED / lock;
    // Five windows close, and the next touch comes a third of an epoch after
    // the last close: window 0 is four or five epochs late.
    const firstAnchor = await ChronosContract.epochAtTimestamp(createdAt + epLen);
    await time.increaseTo(createdAt + 5n * epLen + epLen / 3n);
    const current = await ChronosContract.getCurrentEpoch();
    expect(current - firstAnchor >= 4n).to.equal(true);
    const from = firstAnchor - 1n;
    const to = current + lock + 3n;
    const before = await poolSnapshot(from, to);
    const feeBefore = await poolSnapshot(from, to, TREASURY_SHARD_ID);
    const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const feeCarry = await ES.accumulatedRemainder(TREASURY_SHARD_ID);
    const treasuryBalance = await Token.balanceOf(treasury.address);

    const receipt = await settle(accountId);
    expect(await epochOf(receipt)).to.equal(current);

    const staker = new PoolModel(carry);
    const treasuryShard = new PoolModel(feeCarry);
    const { scheduled, treasuryFee } = await scheduleModel({
      chronos: ChronosContract,
      model: staker,
      feeModel: treasuryShard,
      bps: feeBps,
      committed: COMMITTED,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
      currentEpoch: current,
      toWindow: 5n,
    });
    expect(scheduled + treasuryFee).to.equal(5n * B);
    expect(treasuryFee).to.be.greaterThan(0n);
    const [ev] = await eventsOf(receipt, PC, 'EmissionScheduled');
    expect([ev.fromWindow, ev.toWindow, ev.scheduled, ev.treasuryFee]).to.deep.equal([0n, 5n, scheduled, treasuryFee]);

    // The property on each shard, then the credits and pools to the wei.
    const shards = [
      { shard: STAKER_SHARD_ID, model: staker, poolsBefore: before, carryBefore: carry, total: scheduled },
      { shard: TREASURY_SHARD_ID, model: treasuryShard, poolsBefore: feeBefore, carryBefore: feeCarry, total: treasuryFee },
    ];
    for (const { shard, model, poolsBefore, carryBefore, total } of shards) {
      const delta = await deltas(poolsBefore, from, to, shard);
      await expectNoEndedEpochCredited(receipt, delta, shard);
      expect(await credits(receipt, shard), `shard ${shard}`).to.deep.equal(asTuples(model.credited));
      let sum = 0n;
      for (const [e, v] of delta) {
        expect(v, `shard ${shard}, epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
        sum += v;
      }
      expect(sum + (await ES.accumulatedRemainder(shard)) - carryBefore, `shard ${shard}`).to.equal(total);
    }
    // The arrears are one credit into the current epoch, ahead of the rest.
    expect((await credits(receipt))[0].slice(0, 2)).to.deep.equal([current, current]);
    // A booking moves no TRAC.
    expect(await Token.balanceOf(treasury.address)).to.equal(treasuryBalance);
  });

  it('swept epochs after its lock, an account books its windows and its top-up tail from the current epoch on', async () => {
    const L = 3n;
    await Params.setPublishingConvictionEpochs(L);
    const holder = accounts[20];
    const { accountId, createdAt } = await createAccount(holder);
    const topUp = 1_000n * TRAC + 1n;
    await Token.mint(holder.address, topUp);
    await Token.connect(holder).approve(await NFT.getAddress(), topUp);
    await NFT.connect(holder).topUp(accountId, topUp);

    // Three epochs after the lock's final chain epoch.
    const acct = await PCS.getAccount(accountId);
    const finalEpoch = await ChronosContract.epochAtTimestamp(acct.expiresAtTimestamp - 1n);
    await time.increaseTo((await ChronosContract.timestampForEpoch(finalEpoch + 3n)) + epLen / 2n);
    const current = finalEpoch + 3n;
    const from = (await ChronosContract.epochAtTimestamp(createdAt + epLen)) - 1n;
    const to = current + L + 2n;
    const before = await poolSnapshot(from, to);
    const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    const receipt = await settle(accountId);
    expect(await epochOf(receipt)).to.equal(current);
    const [swept] = await eventsOf(receipt, PC, 'AccountFinalSwept');
    expect([swept.topUpSwept, swept.dustSwept]).to.deep.equal([topUp, 0n]);

    // Every window, then the tail, into the current epoch.
    const model = new PoolModel(carry);
    const { scheduled } = await scheduleModel({
      chronos: ChronosContract,
      model,
      committed: COMMITTED,
      createdAtTimestamp: createdAt,
      lock: L,
      epLen,
      currentEpoch: current,
    });
    expect(scheduled).to.equal(COMMITTED);
    model.add({ start: current, end: current, amount: topUp });
    const got = await credits(receipt);
    expect(got).to.deep.equal(asTuples(model.credited));
    expect(got[got.length - 1]).to.deep.equal([current, current, topUp]);

    const delta = await deltas(before, from, to);
    await expectNoEndedEpochCredited(receipt, delta);
    let sum = 0n;
    for (const [e, v] of delta) {
      expect(v, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += v;
    }
    expect(sum + (await ES.accumulatedRemainder(STAKER_SHARD_ID)) - carry).to.equal(COMMITTED + topUp);
    expect((await PCS.getAccount(accountId)).fullySwept).to.equal(true);
  });

  // -------------------------------------------------------------------------
  // The batch
  // -------------------------------------------------------------------------

  it('the batch settleMany(uint256[]) books exactly what settling each account alone books, in order', async () => {
    const ids: bigint[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await createAccount(accounts[20 + i], COMMITTED + BigInt(i) * 1_000n * TRAC)).accountId);
      await time.increase(epLen / 3n);
    }
    await time.increase(2n * epLen);
    const snapshot = await takeSnapshot();

    // One transaction per account, in one block.
    await hre.network.provider.send('evm_setAutomine', [false]);
    const txs = [];
    try {
      for (const id of ids) txs.push(await PC.settle(id, { gasLimit: 3_000_000 }));
      await hre.network.provider.send('evm_mine', []);
    } finally {
      await hre.network.provider.send('evm_setAutomine', [true]);
    }
    const alone: bigint[][] = [];
    const aloneEvents: unknown[][] = [];
    for (const tx of txs) {
      const receipt = (await tx.wait())!;
      alone.push(...(await credits(receipt)));
      for (const ev of await eventsOf(receipt, PC, 'EmissionScheduled')) aloneEvents.push([...ev]);
    }
    const aloneCursors = [];
    for (const id of ids) aloneCursors.push((await PCS.getAccount(id)).lastSettledWindow);

    await snapshot.restore();
    const batch = (await (await PC.connect(accounts[30]).settleMany(ids)).wait())!;
    expect(await credits(batch)).to.deep.equal(alone);
    expect((await eventsOf(batch, PC, 'EmissionScheduled')).map((ev) => [...ev])).to.deep.equal(aloneEvents);
    for (const [i, id] of ids.entries()) {
      expect((await PCS.getAccount(id)).lastSettledWindow).to.equal(aloneCursors[i]);
    }
    expect(aloneEvents.length).to.equal(ids.length);
  });

  // -------------------------------------------------------------------------
  // The treasury fee
  // -------------------------------------------------------------------------

  it('with a treasury wired, a booking splits net and fee on one curve, and a use-time publish skims its fee at once', async () => {
    const treasury = accounts[9];
    await Params.setProtocolTreasury(treasury.address);
    const feeBps = BigInt(await Params.protocolTreasuryFee());
    const { accountId, createdAt } = await createAccount(accounts[20]);
    await NFT.connect(accounts[20]).registerAgent(accountId, accounts[22].address);
    const B = COMMITTED / lock;
    const vault = await hre.ethers.getContract('ConvictionStakingStorage');

    // A publish: the fee on the whole draw leaves the vault for the treasury
    // in the same transaction, and the net is booked over the KA's epochs.
    const cost = costOf(1_000n * TRAC, 2_000n);
    const fee = feeOf(cost, feeBps);
    const treasuryBefore = await Token.balanceOf(treasury.address);
    const vaultBefore = await Token.balanceOf(await vault.getAddress());
    const e0 = await ChronosContract.getCurrentEpoch();
    const published = (await (
      await NFT.connect(kal).coverPublishingCost(accounts[22].address, 1_000n * TRAC, e0, 3n)
    ).wait())!;
    expect((await Token.balanceOf(treasury.address)) - treasuryBefore).to.equal(fee);
    expect(vaultBefore - (await Token.balanceOf(await vault.getAddress()))).to.equal(fee);
    const ts = await blockTime(published);
    const timeLeft = epLen - ((ts - (await ChronosContract.startTime())) % epLen);
    expect(await credits(published)).to.deep.equal(asTuples(prorateActiveSink(cost - fee, e0, 3n, epLen, timeLeft)));
    expect(await credits(published, TREASURY_SHARD_ID)).to.have.length(0);

    // Window 0 closes: B − cost, split into net and fee, both forward from the
    // close on the same curve, and no TRAC moves.
    await time.setNextBlockTimestamp(createdAt + epLen);
    const staker = new PoolModel(await ES.accumulatedRemainder(STAKER_SHARD_ID));
    const treasuryShard = new PoolModel(await ES.accumulatedRemainder(TREASURY_SHARD_ID));
    const treasuryMid = await Token.balanceOf(treasury.address);
    const receipt = await settle(accountId);
    const { scheduled, treasuryFee } = await scheduleModel({
      chronos: ChronosContract,
      model: staker,
      feeModel: treasuryShard,
      bps: feeBps,
      committed: COMMITTED,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
      currentEpoch: await epochOf(receipt),
      spent: new Map([[0n, cost]]),
      toWindow: 1n,
    });
    expect(scheduled + treasuryFee).to.equal(B - cost);
    expect(treasuryFee).to.equal(feeOf(B - cost, feeBps));
    const [ev] = await eventsOf(receipt, PC, 'EmissionScheduled');
    expect([ev.scheduled, ev.treasuryFee]).to.deep.equal([scheduled, treasuryFee]);
    expect(await credits(receipt)).to.deep.equal(asTuples(staker.credited));
    expect(await credits(receipt, TREASURY_SHARD_ID)).to.deep.equal(asTuples(treasuryShard.credited));
    // The staker and treasury curves start in the same epochs.
    expect((await credits(receipt)).map((r) => [r[0], r[1]])).to.deep.equal(
      (await credits(receipt, TREASURY_SHARD_ID)).map((r) => [r[0], r[1]]),
    );
    expect(await Token.balanceOf(treasury.address)).to.equal(treasuryMid);
  });
});
