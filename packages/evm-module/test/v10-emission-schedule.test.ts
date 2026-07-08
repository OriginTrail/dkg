// 10.0.8 deterministic emission schedule — property tests.
//
// The staker-pool distribution of a PCA's committedTRAC is written UP FRONT
// (each billing window's budget forward-spread over the lock length), so the
// pool schedule is fully determined by the commitment's own terms at account
// creation; publishing draws down the per-window budget without re-emitting
// already-scheduled amounts. These tests assert that with an EXACT TypeScript
// model of the contract math (prorateActiveSink 3-range proration +
// EpochStorage's accumulatedRemainder carry) — per-epoch equality to the wei,
// not tolerances.
//
// Covered properties:
//   P1 createAccount writes the exact schedule; conservation to the wei;
//      K_n allocation mapping untouched by the money path.
//   P2 publish-invariance: coverPublishingCost draws budget but never
//      changes the pool schedule (base portion emits nothing).
//   P3 topUp overflow is the ONLY spend-time emission — forward over the
//      lock from the current epoch.
//   P4 settle() is a no-op for scheduled accounts and self-heals synthetic
//      pre-10.0.8 accounts (schedule == B − windowSpent per window + dust).
//   P5 migrateEmissionSchedule: onlyHubOwner, idempotent, loud on unknown id.
//   P6 post-expiry final sweep: only the leftover topUp remains; fullySwept.
//   P7 treasury fee: with a wired treasury the base commitment splits
//      net→staker shard / fee→treasury shard at schedule time (create never
//      bricks — the split is accounting-only), staker + treasury pools
//      conserve committedTRAC exactly, collectTreasuryEmission pays elapsed
//      epochs idempotently, and the topUp tail keeps the immediate skim.

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
  PublishingConvictionStorage,
  Token,
} from '../typechain';

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
  };
}

// ---------------------------------------------------------------------------
// Exact TypeScript model of the contract math.
// ---------------------------------------------------------------------------

interface Range {
  start: bigint;
  end: bigint;
  amount: bigint;
}

/** Byte-exact mirror of PublishingMathLib.prorateActiveSink. */
function prorateActiveSink(
  tokenAmount: bigint,
  anchorEpoch: bigint,
  epochs: bigint,
  epLen: bigint,
  timeRemaining: bigint,
): Range[] {
  const base = tokenAmount / epochs;
  const cur = (base * timeRemaining) / epLen;
  let fin = base - cur;
  const fulls = epochs - 1n;
  const totFull = base * fulls;
  const totalAllocated = cur + totFull + fin;
  if (totalAllocated < tokenAmount) fin += tokenAmount - totalAllocated;

  const out: Range[] = [];
  if (cur > 0n) out.push({ start: anchorEpoch, end: anchorEpoch, amount: cur });
  if (fulls > 0n && totFull > 0n) {
    out.push({ start: anchorEpoch + 1n, end: anchorEpoch + fulls, amount: totFull });
  }
  if (fin > 0n) {
    out.push({ start: anchorEpoch + epochs, end: anchorEpoch + epochs, amount: fin });
  }
  return out;
}

/**
 * Byte-exact mirror of EpochStorage.addTokensToEpochRange's per-epoch split
 * with the shard-global `accumulatedRemainder` carry. Call order matters and
 * is preserved by the callers below.
 */
class PoolModel {
  perEpoch = new Map<bigint, bigint>();
  constructor(public remainder: bigint) {}

  add(r: Range): void {
    const num = r.end - r.start + 1n;
    const total = r.amount + this.remainder;
    const per = total / num;
    this.remainder = total % num;
    for (let e = r.start; e <= r.end; e++) {
      this.perEpoch.set(e, (this.perEpoch.get(e) ?? 0n) + per);
    }
  }
}

/** _feeOf mirror (BPS_DENOMINATOR = 10_000). */
const feeOf = (amount: bigint, bps: bigint): bigint =>
  bps === 0n ? 0n : (amount * bps) / 10_000n;

/**
 * Byte-exact mirror of _scheduleRemaining + _emitForwardFrom for an account:
 * windows [fromWindow, L) each split (B − spent_w [+ dust on last]) into
 * fee = feeOf(remainder, bps) → the treasury shard and net = remainder − fee
 * → the staker shard, both forward from the window's close on the same
 * curve. bps = 0 (treasury unwired at schedule time) degenerates to the
 * all-gross staker schedule.
 */
async function scheduleModel(opts: {
  chronos: Chronos;
  model: PoolModel;
  committed: bigint;
  createdAtTimestamp: bigint;
  lock: bigint;
  epLen: bigint;
  fromWindow?: bigint;
  spent?: Map<bigint, bigint>;
  bps?: bigint;
  feeModel?: PoolModel;
}): Promise<{ scheduled: bigint; treasuryFee: bigint }> {
  const {
    chronos,
    model,
    committed,
    createdAtTimestamp,
    lock,
    epLen,
  } = opts;
  const fromWindow = opts.fromWindow ?? 0n;
  const spent = opts.spent ?? new Map<bigint, bigint>();
  const bps = opts.bps ?? 0n;
  const feeModel = opts.feeModel ?? new PoolModel(0n);

  const base = committed / lock;
  const dust = committed - base * lock;
  let scheduled = 0n;
  let treasuryFee = 0n;

  for (let w = fromWindow; w < lock; w++) {
    const s = spent.get(w) ?? 0n;
    let remainder = s < base ? base - s : 0n;
    if (w === lock - 1n) remainder += dust;
    if (remainder === 0n) continue;
    const fee = feeOf(remainder, bps);
    const net = remainder - fee;

    const fromTs = createdAtTimestamp + (w + 1n) * epLen;
    const anchorEpoch = await chronos.epochAtTimestamp(fromTs);
    const nextBoundary = await chronos.timestampForEpoch(anchorEpoch + 1n);
    const timeRemaining = nextBoundary > fromTs ? nextBoundary - fromTs : 0n;
    if (net > 0n) {
      scheduled += net;
      for (const r of prorateActiveSink(net, anchorEpoch, lock, epLen, timeRemaining)) {
        model.add(r);
      }
    }
    if (fee > 0n) {
      treasuryFee += fee;
      for (const r of prorateActiveSink(fee, anchorEpoch, lock, epLen, timeRemaining)) {
        feeModel.add(r);
      }
    }
  }
  return { scheduled, treasuryFee };
}

describe('@integration V10 deterministic emission schedule (10.0.8)', function () {
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

  // -------------------------------------------------------------------------
  // P1 — exact schedule at createAccount + conservation + K_n untouched
  // -------------------------------------------------------------------------
  it('P1: createAccount writes the exact deterministic schedule (conservation to the wei; K_n untouched)', async () => {
    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;

    const before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    const { accountId, createdAt } = await createAccountFor(accounts[5]);

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
    const events = await Logic.queryFilter(Logic.filters.EmissionScheduled(accountId));
    expect(events.length).to.equal(1);
    expect(events[0].args.fromWindow).to.equal(0n);
    expect(events[0].args.toWindow).to.equal(lock);
    expect(events[0].args.scheduled).to.equal(COMMITTED_TRAC);
    expect(events[0].args.treasuryFee).to.equal(0n);
  });

  // -------------------------------------------------------------------------
  // P2 — publish-invariance: base spends draw budget, never move the pool
  // -------------------------------------------------------------------------
  it('P2: coverPublishingCost within the base budget draws windowSpent but leaves the pool schedule untouched', async () => {
    const owner = accounts[5];
    const agent = accounts[8];
    const { accountId } = await createAccountFor(owner);
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
  it('P3: only the topUp-drawn overflow emits at spend time — forward over the lock from the current epoch', async () => {
    const owner = accounts[5];
    const agent = accounts[8];
    const { accountId } = await createAccountFor(owner);
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
    const tx = await Logic.connect(nftSigner).coverPublishingCost(
      agent.address,
      baseCost,
      e0,
      lock,
    );
    const rc = await tx.wait();
    const txTs = BigInt((await hre.ethers.provider.getBlock(rc!.blockNumber))!.timestamp);

    // Model: prorateActiveSink(overflow, currentEpoch, lock, epLen, timeUntilNextEpoch@tx).
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

  // -------------------------------------------------------------------------
  // P4 — settle(): no-op when scheduled; self-heals synthetic pre-10.0.8 state
  // -------------------------------------------------------------------------
  it('P4: settle() is a pure no-op for scheduled accounts and schedules synthetic pre-10.0.8 accounts exactly (B − spent per window + dust)', async () => {
    // (a) scheduled account → settle is a no-op.
    const { accountId } = await createAccountFor(accounts[5]);
    const e0 = await ChronosContract.getCurrentEpoch();
    const from = e0;
    const to = e0 + 2n * lock + 3n;

    let before = await poolSnapshot(from, to);
    await Logic.settle(accountId);
    let after = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) {
      expect(after.get(e), `epoch ${e}`).to.equal(before.get(e));
    }

    // (b) synthetic pre-10.0.8 account: planted directly in PCS (hub owner
    // passes onlyContracts), lastSettledWindow = 0, some window-0 spend that
    // "was emitted under the old rules" — settle() must schedule exactly
    // committed − spent, window-wise.
    const synthId = 777n;
    const committed = ethers.parseEther('12000') + 5n;
    const nowTs = BigInt(await time.latest());
    const createdAt = nowTs - epLen / 3n; // mid-window-0, mid-epoch
    const createdEpoch = await ChronosContract.epochAtTimestamp(createdAt);
    const expiresAt = createdAt + lock * epLen;
    const expiresEpoch = (await ChronosContract.epochAtTimestamp(expiresAt - 1n)) + 1n;
    await PCS.createAccount(synthId, {
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
    const spent0 = ethers.parseEther('111');
    await PCS.increaseWindowSpent(synthId, 0n, spent0);

    before = await poolSnapshot(from, to);
    const remBefore = await ES.accumulatedRemainder(STAKER_SHARD_ID);

    await Logic.settle(synthId);

    const model = new PoolModel(remBefore);
    const spentMap = new Map<bigint, bigint>([[0n, spent0]]);
    const { scheduled } = await scheduleModel({
      chronos: ChronosContract,
      model,
      committed,
      createdAtTimestamp: createdAt,
      lock,
      epLen,
      spent: spentMap,
    });
    expect(scheduled).to.equal(committed - spent0);

    after = await poolSnapshot(from, to);
    const diff = poolDiff(before, after);
    let sum = 0n;
    for (let e = from; e <= to; e++) {
      expect(diff.get(e) ?? 0n, `epoch ${e}`).to.equal(model.perEpoch.get(e) ?? 0n);
      sum += diff.get(e) ?? 0n;
    }
    const remAfter = await ES.accumulatedRemainder(STAKER_SHARD_ID);
    expect(sum + (remAfter - remBefore)).to.equal(committed - spent0);

    // Idempotence: second settle changes nothing.
    const again = await poolSnapshot(from, to);
    await Logic.settle(synthId);
    const again2 = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) {
      expect(again2.get(e), `epoch ${e}`).to.equal(again.get(e));
    }
  });

  // -------------------------------------------------------------------------
  // P5 — migrateEmissionSchedule gating + idempotence + loud unknown id
  // -------------------------------------------------------------------------
  it('P5: migrateEmissionSchedule is onlyHubOwner, idempotent, and reverts on an unknown id', async () => {
    const { accountId } = await createAccountFor(accounts[5]);

    // Non-owner → HubLib.UnauthorizedAccess.
    await expect(
      Logic.connect(accounts[6]).migrateEmissionSchedule([accountId]),
    ).to.be.reverted;

    // Unknown id → loud revert, not a silent skip.
    await expect(
      Logic.migrateEmissionSchedule([424242n]),
    ).to.be.revertedWithCustomError(Logic, 'UnknownAccount');

    // Already-scheduled account → clean no-op (idempotent batch re-runs).
    const e0 = await ChronosContract.getCurrentEpoch();
    const before = await poolSnapshot(e0, e0 + 2n * lock + 3n);
    await Logic.migrateEmissionSchedule([accountId]);
    const after = await poolSnapshot(e0, e0 + 2n * lock + 3n);
    for (const [e, v] of after) {
      expect(v, `epoch ${e}`).to.equal(before.get(e));
    }
  });

  // -------------------------------------------------------------------------
  // P6 — post-expiry final sweep: only the topUp tail remains
  // -------------------------------------------------------------------------
  it('P6: after expiry, settle() sweeps only the leftover topUp to the final chain epoch and marks fullySwept', async () => {
    const owner = accounts[5];
    const { accountId } = await createAccountFor(owner);

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

    await expect(Logic.settle(accountId))
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
    await Logic.settle(accountId);
    const snap2 = await poolSnapshot(from, to);
    for (let e = from; e <= to; e++) {
      expect(snap2.get(e), `epoch ${e}`).to.equal(snap.get(e));
    }
  });

  // -------------------------------------------------------------------------
  // P7 — 10.0.8 fee basis: the base-commitment fee is ASSESSED at schedule
  //      time as an accounting split (net→staker shard, fee→treasury shard,
  //      same curve — so create cannot brick on the unfunded vault) and PAID
  //      per elapsed epoch via collectTreasuryEmission; the topUp flows keep
  //      the immediate skim — asserted here on the expiry tail.
  // -------------------------------------------------------------------------
  it('P7: with a wired treasury, the base commitment splits net/fee across the two shards and collectTreasuryEmission pays elapsed epochs exactly once', async () => {
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

    // createAccount MUST NOT revert with a wired treasury — the fee split is
    // accounting-only (the frozen wrapper funds the vault only after the
    // logic call; no TRAC moves during scheduling).
    const owner = accounts[5];
    const { accountId, createdAt } = await createAccountFor(owner);

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
    const events = await Logic.queryFilter(Logic.filters.EmissionScheduled(accountId));
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

    await Logic.settle(accountId);

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

  it('reports version 10.0.8', async () => {
    expect(await Logic.version()).to.equal('10.0.8');
  });
});
