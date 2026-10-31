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
//   - one epoch late, the elapsed epoch's share lands in the current epoch and
//     the rest of the spread is as scheduled;
//   - several epochs late, EpochStorage's clamp moves every elapsed start to
//     the first open epoch, and the window is conserved;
//   - the batch settle(uint256[]) books exactly what settling each account
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
import { PoolModel, feeOf, prorateActiveSink, scheduleModel } from './helpers/emission-model';
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

  const settle = async (accountId: bigint) => (await (await PC['settle(uint256)'](accountId)).wait())!;

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

  /** EpochStorage's clamp of a shard as it stands: its first open epoch, and the current epoch. */
  const clampOf = async (shard: bigint = STAKER_SHARD_ID) => ({
    firstOpen: (await ES.lastFinalizedEpoch(shard)) + 1n,
    currentEpoch: await ChronosContract.getCurrentEpoch(),
  });

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

      // The window's own ranges of the 10.0.8 schedule, and no clamp: none
      // of them starts before the epoch the window closes in.
      const model = new PoolModel(carry, await clampOf());
      await scheduleModel({
        chronos: ChronosContract,
        model,
        committed: COMMITTED,
        createdAtTimestamp: createdAt,
        lock,
        epLen,
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

  it("one epoch late, the elapsed epoch's share lands in the current epoch and the rest of the spread is as scheduled", async () => {
    const { accountId, createdAt } = await createAccount(accounts[20]);
    const close = createdAt + epLen;
    const anchor = await ChronosContract.epochAtTimestamp(close);
    const B = COMMITTED / lock;

    // Into the next epoch, where another account's publish finalizes the
    // shard through the epoch before: the window's close epoch has ended.
    const other = await createAccount(accounts[21]);
    await NFT.connect(accounts[21]).registerAgent(other.accountId, accounts[22].address);
    await time.increaseTo(await ChronosContract.timestampForEpoch(anchor + 1n));
    await NFT.connect(kal).coverPublishingCost(accounts[22].address, TRAC, anchor + 1n, 1n);
    expect(await ES.lastFinalizedEpoch(STAKER_SHARD_ID)).to.equal(anchor);

    const scheduled = prorateActiveSink(
      B,
      anchor,
      lock,
      epLen,
      (await ChronosContract.timestampForEpoch(anchor + 1n)) - close,
    );
    const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const clamp = await clampOf();
    const before = await poolSnapshot(anchor - 1n, anchor + lock + 1n);
    const receipt = await settle(accountId);

    // The first range, of the close epoch alone, moves to the current epoch;
    // the full epochs and the final one are untouched.
    const expected = asTuples(scheduled);
    expected[0] = [anchor + 1n, anchor + 1n, expected[0][2]];
    expect(await credits(receipt)).to.deep.equal(expected);
    const model = new PoolModel(carry, clamp);
    for (const r of scheduled) model.add(r);
    const after = await poolSnapshot(anchor - 1n, anchor + lock + 1n);
    for (const [e, v] of after) expect(v - before.get(e)!, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
    expect(after.get(anchor)).to.equal(before.get(anchor));
  });

  it("several epochs late, EpochStorage's clamp moves each elapsed start to the first open epoch, and the windows are conserved", async () => {
    const { accountId, createdAt } = await createAccount(accounts[20]);
    const B = COMMITTED / lock;
    // Three windows close, and the next touch comes two epochs after the last.
    await time.increaseTo(createdAt + 3n * epLen + 2n * epLen + epLen / 3n);
    const current = await ChronosContract.getCurrentEpoch();
    const from = current - 6n;
    const to = current + lock + 3n;
    const before = await poolSnapshot(from, to);
    const carry = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const clamp = await clampOf();

    const receipt = await settle(accountId);
    const [ev] = await eventsOf(receipt, PC, 'EmissionScheduled');
    expect([ev.fromWindow, ev.toWindow, ev.scheduled]).to.deep.equal([0n, 5n, 5n * B]);

    const model = new PoolModel(carry, clamp);
    await scheduleModel({
      chronos: ChronosContract,
      model,
      committed: COMMITTED,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
      toWindow: 5n,
    });
    expect(await credits(receipt)).to.deep.equal(asTuples(model.credited));
    // Nothing lands before the first open epoch, which the first credit opened.
    for (const [start] of (await credits(receipt)).slice(1)) expect(start >= current).to.equal(true);

    const after = await poolSnapshot(from, to);
    let sum = 0n;
    for (const [e, v] of after) {
      expect(v - before.get(e)!, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += v - before.get(e)!;
    }
    expect(sum + (await ES.accumulatedRemainder(STAKER_SHARD_ID)) - carry).to.equal(5n * B);
  });

  // -------------------------------------------------------------------------
  // The batch
  // -------------------------------------------------------------------------

  it('the batch settle(uint256[]) books exactly what settling each account alone books, in order', async () => {
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
      for (const id of ids) txs.push(await PC['settle(uint256)'](id, { gasLimit: 3_000_000 }));
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
    const batch = (await (await PC.connect(accounts[30])['settle(uint256[])'](ids)).wait())!;
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
    const staker = new PoolModel(await ES.accumulatedRemainder(STAKER_SHARD_ID), await clampOf());
    const treasuryShard = new PoolModel(await ES.accumulatedRemainder(TREASURY_SHARD_ID), await clampOf(TREASURY_SHARD_ID));
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
