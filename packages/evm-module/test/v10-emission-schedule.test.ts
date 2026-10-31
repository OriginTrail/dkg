// Accounts that PublishingConviction 10.0.8 or 10.1.0 scheduled, under 10.2.0,
// and the per-window booking those builds' schedule was made of — property
// tests against an EXACT TypeScript model of the contract math
// (prorateActiveSink 3-range proration + EpochStorage's accumulatedRemainder
// carry), per-epoch equality to the wei, not tolerances.
//
// 10.0.8 and 10.1.0 booked an account's whole base budget up front (each
// billing window's budget forward-spread over the lock length) and left
// `lastSettledWindow` at the lock. Since 10.2.0 no path does, so these suites
// make such accounts with PublishingConvictionScheduleHarness, which runs the
// contract's own `_bookWindows` over every window at once.
//
// Covered properties:
//   P1 createAccount books nothing; a scheduled account carries the exact
//      10.0.8 schedule; conservation to the wei; K_n allocation untouched.
//   P2 a scheduled account's publish draws budget but never changes the pool
//      (its base portion is already scheduled).
//   P3 a scheduled account's topUp overflow is its only spend-time booking —
//      forward over the lock from the current epoch.
//   P4 settle() is a no-op for a scheduled account; an account a build older
//      than 10.0.8 created books exactly its closed windows (B − windowSpent
//      per window) and its cursor stops at the current window.
//   P5 the batch settleMany(uint256[]): permissionless, the single form per id, an
//      unknown id reverts; the one-time migration batch is gone.
//   P6 post-expiry final sweep of a scheduled account: only the leftover topUp
//      remains; fullySwept.
//   P7 treasury fee: with a wired treasury a window's budget splits
//      net→staker shard / fee→treasury shard (accounting only),
//      collectTreasuryEmission pays elapsed epochs idempotently, and the topUp
//      tail keeps the immediate skim.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGPublishingConvictionNFT,
  EpochStorage,
  Hub,
  ParametersStorage,
  PublishingConviction,
  PublishingConvictionScheduleHarness,
  PublishingConvictionStorage,
  Token,
} from '../typechain';
import {
  PoolModel,
  feeOf,
  prorateActiveSink,
  scheduleModel,
} from './helpers/emission-model';
import { deployScheduleHarness } from './helpers/scheduled-accounts';

const STAKER_SHARD_ID = 1n;
const TREASURY_SHARD_ID = 2n;
// 20% discount tier + 7 wei so the `committedTRAC % lock` dust path is live.
const COMMITTED_TRAC = ethers.parseEther('50000') + 7n;

type Fixture = {
  accounts: SignerWithAddress[];
  Hub: Hub;
  Token: Token;
  Chronos: Chronos;
  EpochStorage: EpochStorage;
  ParametersStorage: ParametersStorage;
  ConvictionStakingStorage: ConvictionStakingStorage;
  NFT: DKGPublishingConvictionNFT;
  PublishingConviction: PublishingConviction;
  PCS: PublishingConvictionStorage;
  Harness: PublishingConvictionScheduleHarness;
};

async function deployFixture(): Promise<Fixture> {
  await hre.deployments.fixture([
    'Token',
    'AskStorage',
    'EpochStorage',
    'Chronos',
    'Profile',
    'Identity',
    'KnowledgeAssetsLifecycle',
    'ContextGraphStorage',
    'ContextGraphs',
    'ContextGraphValueStorage',
    'ContextGraphWaiverStorage',
    'DKGPublishingConvictionNFT',
    'DKGStakingConvictionNFT',
    'StakingV10',
  ]);

  const accounts = await hre.ethers.getSigners();
  const Hub = await hre.ethers.getContract<Hub>('Hub');
  await Hub.setContractAddress('HubOwner', accounts[0].address);
  const Harness = await deployScheduleHarness(Hub);

  return {
    accounts,
    Hub,
    Token: await hre.ethers.getContract<Token>('Token'),
    Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
    EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    ParametersStorage:
      await hre.ethers.getContract<ParametersStorage>('ParametersStorage'),
    ConvictionStakingStorage:
      await hre.ethers.getContract<ConvictionStakingStorage>(
        'ConvictionStakingStorage',
      ),
    NFT: await hre.ethers.getContract<DKGPublishingConvictionNFT>(
      'DKGPublishingConvictionNFT',
    ),
    PublishingConviction: await hre.ethers.getContract<PublishingConviction>(
      'PublishingConviction',
    ),
    PCS: await hre.ethers.getContract<PublishingConvictionStorage>(
      'PublishingConvictionStorage',
    ),
    Harness,
  };
}

describe('@integration Accounts scheduled by 10.0.8 and 10.1.0, under PublishingConviction 10.2.0', function () {
  let accounts: SignerWithAddress[];
  let HubContract: Hub;
  let Token: Token;
  let ChronosContract: Chronos;
  let ES: EpochStorage;
  let Params: ParametersStorage;
  let CSS: ConvictionStakingStorage;
  let NFT: DKGPublishingConvictionNFT;
  let Logic: PublishingConviction;
  let PCS: PublishingConvictionStorage;
  let Harness: PublishingConvictionScheduleHarness;

  let epLen: bigint;
  let lock: bigint;

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub: HubContract,
      Token,
      Chronos: ChronosContract,
      EpochStorage: ES,
      ParametersStorage: Params,
      ConvictionStakingStorage: CSS,
      NFT,
      PublishingConviction: Logic,
      PCS,
      Harness,
    } = await loadFixture(deployFixture));
    epLen = await ChronosContract.epochLength();
    lock = await Params.publishingConvictionEpochs();
  });

  /** Read getEpochPool(shard, e) over [from, to] into a map. */
  const poolSnapshot = async (
    from: bigint,
    to: bigint,
    shard: bigint = STAKER_SHARD_ID,
  ): Promise<Map<bigint, bigint>> => {
    const out = new Map<bigint, bigint>();
    for (let e = from; e <= to; e++) {
      out.set(e, await ES.getEpochPool(shard, e));
    }
    return out;
  };

  const poolDiff = (
    before: Map<bigint, bigint>,
    after: Map<bigint, bigint>,
  ): Map<bigint, bigint> => {
    const out = new Map<bigint, bigint>();
    for (const [e, v] of after) out.set(e, v - (before.get(e) ?? 0n));
    return out;
  };

  /** Mint + approve + create a PCA; returns { accountId, createdAtTimestamp }. */
  const createAccountFor = async (
    owner: SignerWithAddress,
    committed: bigint = COMMITTED_TRAC,
  ): Promise<{ accountId: bigint; createdAt: bigint }> => {
    await Token.mint(owner.address, committed);
    await Token.connect(owner).approve(await NFT.getAddress(), committed);
    const tx = await NFT.connect(owner).createAccount(committed, 0);
    const rc = await tx.wait();
    const block = await hre.ethers.provider.getBlock(rc!.blockNumber);
    const accountId = await NFT.totalSupply();
    return { accountId, createdAt: BigInt(block!.timestamp) };
  };

  /** A PCA as 10.0.8 or 10.1.0 left it: created, then its whole base budget scheduled. */
  const createScheduledFor = async (
    owner: SignerWithAddress,
    committed: bigint = COMMITTED_TRAC,
  ): Promise<{ accountId: bigint; createdAt: bigint }> => {
    const created = await createAccountFor(owner, committed);
    await Harness.scheduleInFull(created.accountId);
    return created;
  };

  const settleOne = (accountId: bigint) => Logic.settle(accountId);

  // -------------------------------------------------------------------------
  // P1 — exact schedule at createAccount + conservation + K_n untouched
  // -------------------------------------------------------------------------
  it('P1: createAccount books nothing; a scheduled account carries the exact 10.0.8 schedule (conservation to the wei; K_n untouched)', async () => {
    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;

    const before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    const { accountId, createdAt } = await createAccountFor(accounts[5]);
    // 10.2.0: the creation books nothing, and the account pays at use time.
    const created = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) expect(created.get(e), `epoch ${e}`).to.equal(before.get(e));
    expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(remBefore);
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(0n);
    expect(await Logic.queryFilter(Logic.filters.EmissionScheduled(accountId))).to.have.length(0);

    // As 10.0.8 scheduled it at creation.
    await Harness.scheduleInFull(accountId);

    // Model the schedule exactly.
    const model = new PoolModel(remBefore);
    const { scheduled } = await scheduleModel({
      chronos: ChronosContract,
      model,
      committed: COMMITTED_TRAC,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
    });
    expect(scheduled).to.equal(COMMITTED_TRAC); // base commitment schedules gross

    const after = await poolSnapshot(from, to);
    const diff = poolDiff(before, after);

    // Per-epoch EXACT equality with the model.
    let sum = 0n;
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += diff.get(e) ?? 0n;
    }
    // Conservation to the wei: everything scheduled lands in the pool except
    // the shard-global division remainder still riding accumulatedRemainder.
    const remAfter = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    expect(sum + (remAfter - remBefore)).to.equal(COMMITTED_TRAC);

    // The money path never touches the K_n allocation mapping, and with no
    // treasury wired the treasury shard stays empty.
    for (let e = from; e <= to; e++) {
      expect(await ES.getEpochPublishingAllocation(e)).to.equal(0n);
      expect(await ES.getEpochPool(TREASURY_SHARD_ID, e)).to.equal(0n);
    }

    // Marker set: all windows scheduled in one shot.
    const acct = await PCS.getAccount(accountId);
    expect(acct.lastSettledWindow).to.equal(lock);
    expect(acct.fullySwept).to.equal(false);

    // EmissionScheduled(accountId, 0, lock, committed, 0) emitted exactly once.
    const events = await Harness.queryFilter(Harness.filters.EmissionScheduled(accountId));
    expect(events.length).to.equal(1);
    expect(events[0].args.fromWindow).to.equal(0n);
    expect(events[0].args.toWindow).to.equal(lock);
    expect(events[0].args.scheduled).to.equal(COMMITTED_TRAC);
    expect(events[0].args.treasuryFee).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // P2 — publish-invariance: base spends draw budget, never move the pool
  // -------------------------------------------------------------------------
  it('P2: a scheduled account publishing within the base budget draws windowSpent but leaves the pool schedule untouched', async () => {
    const owner = accounts[5];
    const agent = accounts[8];
    const { accountId } = await createScheduledFor(owner);
    await NFT.connect(owner).registerAgent(accountId, agent.address);

    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;
    const before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    // Spend well within the current window's base allowance (B ≈ 4166 TRAC).
    const baseCost = ethers.parseEther('100');
    const nftSigner = await hre.ethers.getImpersonatedSigner(await NFT.getAddress());
    await hre.network.provider.send('hardhat_setBalance', [
      await NFT.getAddress(),
      '0x1000000000000000000',
    ]);
    await Logic.connect(nftSigner).coverPublishingCost(agent.address, baseCost, e0, lock);

    // Budget drawn (20% discount tier → 80 TRAC discounted)...
    const spent = await PCS.windowSpent(accountId, 0n);
    expect(spent).to.equal((baseCost * 8_000n) / 10_000n);

    // ...but the pool is UNCHANGED, epoch by epoch, to the wei.
    const after = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) {
      expect(after.get(e), `epoch ${e}`).to.equal(before.get(e));
    }
    expect(await ES.accumulatedRemainder(STAKER_SHARD_ID)).to.equal(remBefore);
  });

  // -------------------------------------------------------------------------
  // P3 — topUp overflow is the only spend-time emission, forward over lock
  // -------------------------------------------------------------------------
  it('P3: a scheduled account books only its topUp-drawn overflow at spend time — forward over the lock from the current epoch', async () => {
    const owner = accounts[5];
    const agent = accounts[8];
    const { accountId } = await createScheduledFor(owner);
    await NFT.connect(owner).registerAgent(accountId, agent.address);

    const topUpAmount = ethers.parseEther('1000');
    await Token.mint(owner.address, topUpAmount);
    await Token.connect(owner).approve(await NFT.getAddress(), topUpAmount);
    await NFT.connect(owner).topUp(accountId, topUpAmount);

    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;
    const before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    // Overspend the window's base allowance so exactly `overflow` is drawn
    // from the topUp buffer. B = committed / lock; discounted cost must be
    // B + overflow → baseCost = (B + overflow) / 0.8.
    const B = COMMITTED_TRAC / lock;
    const overflow = ethers.parseEther('500');
    const discountedTarget = B + overflow;
    const baseCost = (discountedTarget * 10_000n) / 8_000n;
    // Integer-division guard: recompute what the contract will compute.
    const discounted = (baseCost * 8_000n) / 10_000n;
    const expectedOverflow = discounted - B;

    const nftSigner = await hre.ethers.getImpersonatedSigner(await NFT.getAddress());
    await hre.network.provider.send('hardhat_setBalance', [
      await NFT.getAddress(),
      '0x1000000000000000000',
    ]);
    // Pass a kaStartEpoch deliberately FAR from the current epoch: the
    // overflow is booked from the current epoch and the (ABI-retained)
    // kaStartEpoch parameter is ignored. Modelling from e0 while the call
    // supplies e0 + 5 makes this test fail if the implementation ever regresses
    // to kaStartEpoch-anchored booking (ranges would shift to e0 + 5).
    const kaStartEpochArg = e0 + 5n;
    const tx = await Logic.connect(nftSigner).coverPublishingCost(
      agent.address,
      baseCost,
      kaStartEpochArg,
      lock,
    );
    const rc = await tx.wait();
    const txTs = BigInt((await hre.ethers.provider.getBlock(rc!.blockNumber))!.timestamp);

    // Model: prorateActiveSink(overflow, currentEpoch, lock, epLen, timeUntilNextEpoch@tx).
    // Anchored at e0 (current epoch), NOT kaStartEpochArg — proving the param is ignored.
    const nextBoundary = await ChronosContract.timestampForEpoch(e0 + 1n);
    const timeRemaining = nextBoundary - txTs;
    const model = new PoolModel(remBefore);
    for (const r of prorateActiveSink(expectedOverflow, e0, lock, epLen, timeRemaining)) {
      model.add(r);
    }

    const after = await poolSnapshot(from, to);
    const diff = poolDiff(before, after);
    let sum = 0n;
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += diff.get(e) ?? 0n;
    }
    const remAfter = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    expect(sum + (remAfter - remBefore)).to.equal(expectedOverflow);

    // Budget gate: window spent capped at B; buffer reduced by the overflow.
    expect(await PCS.windowSpent(accountId, 0n)).to.equal(B);
    expect(await PCS.topUpBalance(accountId)).to.equal(topUpAmount - expectedOverflow);
  });

  /** A PCA a build older than 10.0.8 left: created `ago` seconds back, nothing booked, `spent0` drawn in window 0. */
  const writeOldAccount = async (
    id: bigint,
    committed: bigint,
    ago: bigint,
    spent0: bigint,
  ): Promise<bigint> => {
    const createdAt = BigInt(await time.latest()) - ago;
    const createdEpoch = await ChronosContract.epochAtTimestamp(createdAt);
    const expiresAt = createdAt + lock * epLen;
    const expiresEpoch = (await ChronosContract.epochAtTimestamp(expiresAt - 1n)) + 1n;
    await PCS.createAccount(id, {
      committedTRAC: committed,
      createdAtEpoch: createdEpoch,
      expiresAtEpoch: expiresEpoch,
      createdAtTimestamp: createdAt,
      expiresAtTimestamp: expiresAt,
      lockDurationEpochs: lock,
      discountBps: 0,
      lastSettledWindow: 0,
      fullySwept: false,
      primaryNode: 0,
      lastPrimaryNodeChangeEpoch: createdEpoch,
    });
    if (spent0 > 0n) await PCS.increaseWindowSpent(id, 0n, spent0);
    return createdAt;
  };

  // -------------------------------------------------------------------------
  // P4 — settle(): no-op when scheduled; an older account books closed windows
  // -------------------------------------------------------------------------
  it('P4: settle() is a pure no-op for a scheduled account; an account from before 10.0.8 books exactly its closed windows (B − spent per window), up to the current one', async () => {
    // (a) scheduled account → settle is a no-op, now and windows later.
    const { accountId } = await createScheduledFor(accounts[5]);
    const e0 = await ChronosContract.getCurrentEpoch();
    let before = await poolSnapshot(e0, e0 + 2n * lock + 3n);
    await settleOne(accountId);
    await time.increase(3n * epLen);
    await settleOne(accountId);
    let after = await poolSnapshot(e0, e0 + 2n * lock + 3n);
    for (const [e, v] of after) expect(v, `epoch ${e}`).to.equal(before.get(e));
    expect((await PCS.getAccount(accountId)).lastSettledWindow).to.equal(lock);

    // (b) an account an older build created, planted directly in PCS (the Hub
    // owner passes onlyContracts), two and a third windows ago, nothing booked
    // yet, with a window-0 spend that the older build booked when drawn.
    const synthId = 777n;
    const committed = ethers.parseEther('12000') + 5n;
    const spent0 = ethers.parseEther('111');
    const createdAt = await writeOldAccount(synthId, committed, 2n * epLen + epLen / 3n, spent0);

    const e1 = await ChronosContract.getCurrentEpoch();
    const from = e1 - 3n;
    const to = e1 + 2n * lock + 3n;
    before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const clamp = { firstOpen: (await ES.lastFinalizedEpoch(STAKER_SHARD_ID)) + 1n, currentEpoch: e1 };

    const B = committed / lock;
    await expect(settleOne(synthId))
      .to.emit(Logic, 'EmissionScheduled')
      .withArgs(synthId, 0n, 2n, B - spent0 + B, 0n);

    // Windows 0 and 1, each forward from its close, as the 10.0.8 schedule
    // spread them; the elapsed part clamps into the first open epoch.
    const model = new PoolModel(remBefore, clamp);
    const { scheduled } = await scheduleModel({
      chronos: ChronosContract,
      model,
      committed,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
      spent: new Map<bigint, bigint>([[0n, spent0]]),
      toWindow: 2n,
    });
    expect(scheduled).to.equal(B - spent0 + B);
    after = await poolSnapshot(from, to);
    const diff = poolDiff(before, after);
    let sum = 0n;
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += diff.get(e) ?? 0n;
    }
    const remAfter = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    expect(sum + (remAfter - remBefore)).to.equal(scheduled);
    // The cursor stops at the current window: the account pays at use time.
    expect((await PCS.getAccount(synthId)).lastSettledWindow).to.equal(2n);

    // Idempotence: a second settle in the same window changes nothing.
    const again = await poolSnapshot(from, to);
    await expect(settleOne(synthId)).to.not.emit(Logic, 'EmissionScheduled');
    const again2 = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) expect(again2.get(e), `epoch ${e}`).to.equal(again.get(e));
  });

  // -------------------------------------------------------------------------
  // P5 — the batch settleMany(uint256[]); the one-time migration is gone
  // -------------------------------------------------------------------------
  it('P5: the batch settleMany(uint256[]) is permissionless, settles each id as settle(uint256) does, and reverts on an unknown id; settle has one signature; migrateEmissionSchedule is gone', async () => {
    expect(Logic.interface.getFunction('migrateEmissionSchedule')).to.equal(null);
    // One `settle`, so a bare `settle(id)` call resolves in every ABI client.
    const settles = Logic.interface.fragments.filter((f) => f.type === 'function' && (f as { name?: string }).name === 'settle');
    expect(settles.map((f) => f.format())).to.deep.equal(['settle(uint256)']);
    expect(Logic.interface.getFunction('settleMany')!.format()).to.equal('settleMany(uint256[])');

    const scheduled = await createScheduledFor(accounts[5]);
    const useTime = await createAccountFor(accounts[6]);
    await time.increase(epLen * 2n + 1n);
    const old = 4242n;
    await writeOldAccount(old, ethers.parseEther('24000'), epLen + epLen / 2n, 0n);

    // Unknown id → the whole batch reverts, loudly.
    await expect(
      Logic.connect(accounts[7]).settleMany([useTime.accountId, 424242n]),
    )
      .to.be.revertedWithCustomError(Logic, 'UnknownAccount')
      .withArgs(424242n);

    const tx = await Logic.connect(accounts[7]).settleMany([scheduled.accountId, useTime.accountId, old]);
    const B = COMMITTED_TRAC / lock;
    await expect(tx).to.emit(Logic, 'EmissionScheduled').withArgs(useTime.accountId, 0n, 2n, 2n * B, 0n);
    await expect(tx).to.emit(Logic, 'EmissionScheduled').withArgs(old, 0n, 1n, ethers.parseEther('24000') / lock, 0n);
    const events = (await tx.wait())!.logs
      .map((l) => {
        try {
          return Logic.interface.parseLog({ topics: [...l.topics], data: l.data });
        } catch {
          return null;
        }
      })
      .filter((p) => p?.name === 'EmissionScheduled');
    // The scheduled account books nothing.
    expect(events.map((e) => e!.args.accountId)).to.deep.equal([useTime.accountId, old]);
    expect((await PCS.getAccount(scheduled.accountId)).lastSettledWindow).to.equal(lock);
    expect((await PCS.getAccount(useTime.accountId)).lastSettledWindow).to.equal(2n);
    expect((await PCS.getAccount(old)).lastSettledWindow).to.equal(1n);

    // An empty batch and a repeat are no-ops.
    await expect(Logic.settleMany([])).to.not.emit(Logic, 'EmissionScheduled');
    await expect(Logic.settleMany([useTime.accountId, old])).to.not.emit(Logic, 'EmissionScheduled');
  });

  // -------------------------------------------------------------------------
  // P6 — post-expiry final sweep: only the topUp tail remains
  // -------------------------------------------------------------------------
  it('P6: after expiry, settle() sweeps only a scheduled account\'s leftover topUp to the final chain epoch and marks fullySwept', async () => {
    const owner = accounts[5];
    const { accountId } = await createScheduledFor(owner);

    const topUpAmount = ethers.parseEther('700');
    await Token.mint(owner.address, topUpAmount);
    await Token.connect(owner).approve(await NFT.getAddress(), topUpAmount);
    await NFT.connect(owner).topUp(accountId, topUpAmount);

    const acct = await PCS.getAccount(accountId);
    await time.increaseTo(acct.expiresAtTimestamp + 5n);

    const finalChainEpoch = await ChronosContract.epochAtTimestamp(
      acct.expiresAtTimestamp - 1n,
    );
    const from = finalChainEpoch - 1n;
    const to = finalChainEpoch + 2n;
    const before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    await expect(settleOne(accountId))
      .to.emit(Logic, 'AccountFinalSwept')
      .withArgs(accountId, topUpAmount, 0n);

    // Single-epoch add with the remainder carry modeled exactly.
    const model = new PoolModel(remBefore);
    model.add({ start: finalChainEpoch, end: finalChainEpoch, amount: topUpAmount });

    const after = await poolSnapshot(from, to);
    const diff = poolDiff(before, after);
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
    }

    const acctAfter = await PCS.getAccount(accountId);
    expect(acctAfter.fullySwept).to.equal(true);
    expect(await PCS.topUpBalance(accountId)).to.equal(0n);

    // fullySwept short-circuit: further settles are inert.
    const snap = await poolSnapshot(from, to);
    await settleOne(accountId);
    const snap2 = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) {
      expect(snap2.get(e), `epoch ${e}`).to.equal(snap.get(e));
    }
  });

  // -------------------------------------------------------------------------
  // P7 — fee basis: a window's budget fee is ASSESSED when it is booked as an
  //      accounting split (net→staker shard, fee→treasury shard, same curve)
  //      and PAID per elapsed epoch via collectTreasuryEmission; the topUp
  //      flows keep the immediate skim — asserted here on the expiry tail.
  // -------------------------------------------------------------------------
  it('P7: with a wired treasury, a scheduled account splits net/fee across the two shards and collectTreasuryEmission pays elapsed epochs exactly once', async () => {
    const treasury = accounts[9];

    // Unwired treasury → nothing to collect, loud revert.
    await expect(
      Logic.collectTreasuryEmission(1n, 1n),
    ).to.be.revertedWithCustomError(Logic, 'TreasuryNotSet');

    await Params.setProtocolTreasury(treasury.address);
    const feeBps = BigInt(await Params.protocolTreasuryFee());
    expect(feeBps).to.be.greaterThan(0n); // 300 bps default

    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;
    const before = await poolSnapshot(from, to);
    const feeBefore = await poolSnapshot(from, to, TREASURY_SHARD_ID);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const feeRemBefore = await ES.accumulatedRemainder(TREASURY_SHARD_ID);
    const treasuryBefore = await Token.balanceOf(treasury.address);

    // Neither the creation nor the schedule moves TRAC — the fee split is
    // accounting-only.
    const owner = accounts[5];
    const { accountId, createdAt } = await createScheduledFor(owner);

    // Dual-shard model: per-window fee = floor(remainder × bps / 10⁴) to the
    // treasury shard, net (keeping the wei dust) to the staker shard.
    const model = new PoolModel(remBefore);
    const feeModel = new PoolModel(feeRemBefore);
    const { scheduled, treasuryFee } = await scheduleModel({
      chronos: ChronosContract,
      model,
      feeModel,
      bps: feeBps,
      committed: COMMITTED_TRAC,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
    });
    expect(scheduled + treasuryFee).to.equal(COMMITTED_TRAC);
    expect(treasuryFee).to.be.greaterThan(0n);

    // EmissionScheduled carries the exact split.
    const events = await Harness.queryFilter(Harness.filters.EmissionScheduled(accountId));
    expect(events.length).to.equal(1);
    expect(events[0].args.scheduled).to.equal(scheduled);
    expect(events[0].args.treasuryFee).to.equal(treasuryFee);

    // Per-epoch EXACT equality on BOTH shards.
    const after = await poolSnapshot(from, to);
    const feeAfter = await poolSnapshot(from, to, TREASURY_SHARD_ID);
    const diff = poolDiff(before, after);
    const feeDiff = poolDiff(feeBefore, feeAfter);
    let netSum = 0n;
    let feeSum = 0n;
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `staker epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      expect(feeDiff.get(e) ?? 0n, `treasury epoch ${e}`).to.equal(
        feeModel.perEpoch.get(e) ?? 0n,
      );
      netSum += diff.get(e) ?? 0n;
      feeSum += feeDiff.get(e) ?? 0n;
    }
    // Conservation to the wei across both shards (+ the per-shard division
    // remainders still riding accumulatedRemainder).
    const remMid = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const feeRemMid = await ES.accumulatedRemainder(TREASURY_SHARD_ID);
    expect(
      netSum + (remMid - remBefore) + feeSum + (feeRemMid - feeRemBefore),
    ).to.equal(COMMITTED_TRAC);
    // Assessment moved no TRAC: the treasury is paid by collection, not scheduling.
    expect(await Token.balanceOf(treasury.address)).to.equal(treasuryBefore);

    // Collection range guards: malformed or not-yet-elapsed epochs revert.
    const cur0 = await ChronosContract.getCurrentEpoch();
    await expect(
      Logic.collectTreasuryEmission(cur0, cur0 - 1n),
    ).to.be.revertedWithCustomError(Logic, 'InvalidCollectionRange');
    await expect(
      Logic.collectTreasuryEmission(cur0, cur0),
    ).to.be.revertedWithCustomError(Logic, 'InvalidCollectionRange');
    await expect(
      Logic.collectTreasuryEmission(cur0, cur0 + 3n),
    ).to.be.revertedWithCustomError(Logic, 'InvalidCollectionRange');

    // Let a few emission epochs elapse, then collect them: the treasury is
    // paid exactly the accrued shard-2 pools, once.
    await time.increase(epLen * 4n);
    const cur = await ChronosContract.getCurrentEpoch();
    const collectFrom = e0;
    const collectTo = cur - 1n;
    let expected = 0n;
    for (let e = collectFrom; e <= collectTo; e++) {
      expected += await ES.getEpochRemainingPool(TREASURY_SHARD_ID, e);
    }
    expect(expected).to.be.greaterThan(0n);

    await expect(Logic.collectTreasuryEmission(collectFrom, collectTo))
      .to.emit(Logic, 'TreasuryEmissionCollected')
      .withArgs(collectFrom, collectTo, expected);
    expect((await Token.balanceOf(treasury.address)) - treasuryBefore).to.equal(expected);

    // Idempotent: the same range re-collects nothing (distributed is tracked).
    await expect(Logic.collectTreasuryEmission(collectFrom, collectTo))
      .to.emit(Logic, 'TreasuryEmissionCollected')
      .withArgs(collectFrom, collectTo, 0n);
    expect((await Token.balanceOf(treasury.address)) - treasuryBefore).to.equal(expected);
    for (let e = collectFrom; e <= collectTo; e++) {
      expect(await ES.getEpochRemainingPool(TREASURY_SHARD_ID, e)).to.equal(0n);
    }

    // topUp tail at expiry: the immediate skim stays — fee to the treasury
    // in the same settle() call, net to the final chain epoch.
    const topUpAmount = ethers.parseEther('900');
    await Token.mint(owner.address, topUpAmount);
    await Token.connect(owner).approve(await NFT.getAddress(), topUpAmount);
    await NFT.connect(owner).topUp(accountId, topUpAmount);

    const acct = await PCS.getAccount(accountId);
    await time.increaseTo(acct.expiresAtTimestamp + 5n);
    const finalChainEpoch = await ChronosContract.epochAtTimestamp(
      acct.expiresAtTimestamp - 1n,
    );
    const tailBefore = await ES.getEpochPool(STAKER_SHARD_ID, finalChainEpoch);
    const remBeforeTail = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    const treasuryBeforeTail = await Token.balanceOf(treasury.address);

    await settleOne(accountId);

    const expectedFee = feeOf(topUpAmount, feeBps);
    const expectedNet = topUpAmount - expectedFee;
    const tailModel = new PoolModel(remBeforeTail);
    tailModel.add({ start: finalChainEpoch, end: finalChainEpoch, amount: expectedNet });

    const tailAfter = await ES.getEpochPool(STAKER_SHARD_ID, finalChainEpoch);
    expect(tailAfter - tailBefore).to.equal(tailModel.perEpoch.get(finalChainEpoch) ?? 0n);
    expect(
      (await Token.balanceOf(treasury.address)) - treasuryBeforeTail,
    ).to.equal(expectedFee);
  });

  it('reports version 10.2.0', async () => {
    expect(await Logic.version()).to.equal('10.2.0');
  });
});
