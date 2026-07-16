import { randomBytes } from 'crypto';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  EpochStorage,
  Hub,
  Profile,
  RandomSamplingStorage,
  StakingV10,
  Token,
} from '../../typechain';

/**
 * ============================================================================
 * PoC for AUDIT FINDING G-6 (High) — redelegate over-cancels a reward-
 * compounded boosted position (incremental-floored schedule vs one-shot-
 * floored cancel) ⇒ `redelegate` reverts (DoS of a core flow).
 * ============================================================================
 *
 * Root cause (ConvictionStakingStorage.sol):
 *
 *   - createPosition (:1044-1046) SCHEDULES the boost drop at `expiryTs` as
 *       floor(R0 * (m - SCALE) / SCALE)
 *     and applies floor(R0 * m / SCALE) to runningNodeEffectiveStake.
 *
 *   - Every reward-compounding claim routes through StakingV10._claim ->
 *     increaseRaw (:1418-1420), which ADDS an INDEPENDENTLY-floored increment
 *       floor(rew * (m - SCALE) / SCALE)
 *     at the SAME `expiryTs`. After a claim the slot
 *     nodeExpiryDrop[id][expiryTs] therefore holds
 *       floor(R0*(m-S)/S) + floor(rew*(m-S)/S).
 *
 *   - updateOnRedelegate (:1075-1077) recomputes the boost ONE-SHOT from the
 *     final raw:  boost = floor((R0+rew) * (m - SCALE) / SCALE)  and then
 *     _cancelNodeExpiry(old, expiryTs, boost) (:1086) which requires
 *       require(existing >= drop)            (_cancelNodeExpiry, :927)
 *
 *   Because floor is super-additive — floor(a)+floor(b) <= floor(a+b), strict
 *   when the fractional parts sum past 1 — the one-shot `boost` is STRICTLY
 *   GREATER than the accumulated slot whenever the per-increment fractional
 *   remainders carry. The require then REVERTS the whole redelegate. With the
 *   position the sole contributor at its (second-granular, unique) expiryTs,
 *   this bricks redelegate for the remainder of the lock (up to 180/366 days).
 *
 * We use tier 6 (multiplier 3.5x ⇒ (m-S)/S = 2.5). For an ODD wei quantity x,
 * floor(x * 2.5) = floor(x*5/2) truncates exactly 0.5 wei. With BOTH the
 * initial raw R0 and the compounded reward `rew` odd:
 *     slot      = floor(R0*5/2) + floor(rew*5/2) = (R0*5 - 1)/2 + (rew*5 - 1)/2
 *     one-shot  = floor((R0+rew)*5/2) = (R0+rew)*5/2           (sum*5 is even)
 *     one-shot - slot = 1 wei  ⇒  require(existing >= drop) reverts.
 *
 * The same flow on a NON-compounded position (CONTROL 2) cancels EXACTLY and
 * leaves zero drift — proving the revert is the floor asymmetry, not a generic
 * redelegate break.
 */
describe('@integration Regression G-6: reward-compounded redelegate stays live (one-shot delta accounting)', () => {
  const SCALE18 = 10n ** 18n;
  const TIER6 = 6;
  const MUL6 = (35n * SCALE18) / 10n; // 3.5x (storage baseline tier 6)
  // factor (m - S) / S = 2.5  ⇒  boost(x) = floor(x * (MUL6 - SCALE18) / SCALE18)
  const boostOf = (x: bigint): bigint => (x * (MUL6 - SCALE18)) / SCALE18;
  const effOf = (x: bigint): bigint => (x * MUL6) / SCALE18;

  let accounts: SignerWithAddress[];
  let NFT: DKGStakingConvictionNFT;
  let StakingV10Contract: StakingV10;
  let CSS: ConvictionStakingStorage;
  let RSS: RandomSamplingStorage;
  let ProfileContract: Profile;
  let Token: Token;
  let ChronosContract: Chronos;
  let EpochStorageContract: EpochStorage;
  let nextOperational = 1;

  async function deployFixture() {
    await hre.deployments.fixture(['DKGStakingConvictionNFT', 'StakingV10', 'Profile']);
    const accs = await hre.ethers.getSigners();
    const Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accs[0].address);
    return {
      accounts: accs,
      NFT: await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT'),
      StakingV10: await hre.ethers.getContract<StakingV10>('StakingV10'),
      CSS: await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage'),
      RSS: await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage'),
      Profile: await hre.ethers.getContract<Profile>('Profile'),
      Token: await hre.ethers.getContract<Token>('Token'),
      Chronos: await hre.ethers.getContract<Chronos>('Chronos'),
      EpochStorage: await hre.ethers.getContract<EpochStorage>('EpochStorageV8'),
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    const f = await loadFixture(deployFixture);
    accounts = f.accounts;
    NFT = f.NFT;
    StakingV10Contract = f.StakingV10;
    CSS = f.CSS;
    RSS = f.RSS;
    ProfileContract = f.Profile;
    ChronosContract = f.Chronos;
    EpochStorageContract = f.EpochStorage;
    Token = f.Token;
    nextOperational = 1;
  });

  // One operational signer per profile (identity registry rejects re-use).
  const createProfile = async () => {
    const nodeId = '0x' + randomBytes(32).toString('hex');
    const tx = await ProfileContract.connect(accounts[nextOperational++]).createProfile(
      accounts[0].address,
      [],
      `Node ${Math.floor(Math.random() * 1_000_000)}`,
      nodeId,
      0,
    );
    const receipt = await tx.wait();
    const identityId = Number(receipt!.logs[0].topics[1]);
    return { identityId };
  };

  const mintAndApprove = async (staker: SignerWithAddress, amount: bigint) => {
    await Token.mint(staker.address, amount);
    await Token.connect(staker).approve(await StakingV10Contract.getAddress(), amount);
  };

  // Inject the full reward surface for (epoch, identityId).
  const injectEpochRewards = async (
    epoch: bigint,
    identityId: number,
    scorePerStake36: bigint,
    nodeScore18: bigint,
    allNodesScore18: bigint,
    epochPool: bigint,
  ) => {
    await RSS.connect(accounts[0]).setNodeEpochScorePerStake(epoch, identityId, scorePerStake36);
    await RSS.connect(accounts[0]).setNodeEpochScore(epoch, identityId, nodeScore18);
    await RSS.connect(accounts[0]).setAllNodesEpochScore(epoch, allNodesScore18);
    await EpochStorageContract.connect(accounts[0]).addTokensToEpochRange(1, epoch, epoch, epochPool);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // CONTROL 1 — an honest, NON-compounded boosted position redelegates fine.
  // Establishes redelegate is a normally-available core flow on a tier-6 lock.
  // ──────────────────────────────────────────────────────────────────────────
  it('CONTROL: a fresh (non-compounded) boosted position redelegates successfully', async () => {
    const { identityId: nodeA } = await createProfile();
    const { identityId: nodeB } = await createProfile();
    const raw = hre.ethers.parseEther('100000'); // round number, no floor drift

    await mintAndApprove(accounts[0], raw);
    await NFT.connect(accounts[0]).createConviction(nodeA, raw, TIER6);

    // Effective stake landed on A; B has none.
    expect(await CSS.getNodeRunningEffectiveStake(nodeA)).to.equal(effOf(raw));
    expect(await CSS.getNodeRunningEffectiveStake(nodeB)).to.equal(0n);

    await expect(NFT.connect(accounts[0]).redelegate(1, nodeB)).to.emit(CSS, 'PositionRedelegated');

    // Full contribution moved A -> B; A drained to 0, no drift, no revert.
    expect(await CSS.getNodeRunningEffectiveStake(nodeA)).to.equal(0n);
    expect(await CSS.getNodeRunningEffectiveStake(nodeB)).to.equal(effOf(raw));
    expect((await CSS.getPosition(1)).identityId).to.equal(BigInt(nodeB));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CONTROL 2 — the schedule/cancel is EXACT when no reward was compounded.
  // The scheduled boost slot equals the one-shot cancel, so redelegate leaves
  // zero residual drop and zero effective-stake drift. This proves the EXPLOIT
  // revert below is specifically the incremental-vs-one-shot floor asymmetry,
  // not a generic redelegate fault.
  // ──────────────────────────────────────────────────────────────────────────
  it('CONTROL: non-compounded slot is cancelled EXACTLY (no floor drift)', async () => {
    const { identityId: nodeA } = await createProfile();
    const { identityId: nodeB } = await createProfile();
    // ODD raw on its own is harmless: a single floor() can never disagree with itself.
    const raw = hre.ethers.parseEther('100000') + 1n;

    await mintAndApprove(accounts[0], raw);
    await NFT.connect(accounts[0]).createConviction(nodeA, raw, TIER6);

    const pos = await CSS.getPosition(1);
    const expiryTs = pos.expiryTimestamp;

    // Slot scheduled at expiry == the one-shot boost of the SAME raw (single floor).
    const slot = await CSS.getNodeExpiryDrop(nodeA, expiryTs);
    expect(slot).to.equal(boostOf(raw));

    // Redelegate succeeds; A fully drained, slot fully cleared.
    await NFT.connect(accounts[0]).redelegate(1, nodeB);
    expect(await CSS.getNodeRunningEffectiveStake(nodeA)).to.equal(0n);
    expect(await CSS.getNodeExpiryDrop(nodeA, expiryTs)).to.equal(0n);
    expect(await CSS.getNodeExpiryDrop(nodeB, expiryTs)).to.equal(boostOf(raw));
  });

  // ──────────────────────────────────────────────────────────────────────────
  // REGRESSION (G-6 fix) — a reward-compounded boosted position CAN redelegate.
  // increaseRaw now installs the compounded boost as the ONE-SHOT delta from the
  // position's raw, so the scheduled slot / running stake hold floor((R0+rew)*k)
  // exactly — the same value the one-shot unwind removes. No incremental-vs-one-
  // shot asymmetry, so the unwind is exact (strict invariants intact) and
  // redelegate succeeds. Pre-fix the slot held floor(R0*k)+floor(rew*k) (1 wei
  // less) and the unwind reverted "Neg running stake".
  // ──────────────────────────────────────────────────────────────────────────
  it('REGRESSION G-6: reward-compounded redelegate succeeds (one-shot delta accounting is exact)', async () => {
    const { identityId: nodeA } = await createProfile();
    const { identityId: nodeB } = await createProfile();

    // ODD initial raw so its boost floors down exactly 0.5 wei.
    const R0 = hre.ethers.parseEther('100000') + 1n;
    await mintAndApprove(accounts[0], R0);
    await NFT.connect(accounts[0]).createConviction(nodeA, R0, TIER6);

    const pos0 = await CSS.getPosition(1);
    const expiryTs = pos0.expiryTimestamp;
    expect(pos0.raw).to.equal(R0);
    expect(pos0.multiplier18).to.equal(MUL6);

    // Node A earns score for epoch E.
    const epochE = await ChronosContract.getCurrentEpoch();
    const effStake = effOf(R0); // 3.5x boosted effective stake (== contract's delegatorScore base)
    const epochLength = await ChronosContract.epochLength();
    // R0 is chosen (100000e18 + 1) so the 3.5x effective stake is ODD; with
    // scorePerStake36 == SCALE18, delegatorScore18 == effStake exactly, so the
    // compounded reward is the same ODD value — forcing its boost increment to
    // floor down 0.5 wei (the second of the two independent floors).
    expect(effStake % 2n).to.equal(1n);

    // sps36 == 1e18 ⇒ delegatorScore18 = effStake * 1e18 / 1e18 = effStake.
    // Single node, opFee 0, gross = pool*nodeScore/allNodes = nodeScore (pool==nodeScore),
    // so reward = delegatorScore18 * gross / nodeScore = effStake (ODD).
    const scorePerStake36 = SCALE18;
    const nodeScore18 = hre.ethers.parseEther('100');
    const epochPool = nodeScore18;
    await injectEpochRewards(epochE, nodeA, scorePerStake36, nodeScore18, nodeScore18, epochPool);

    // Close epoch E so the claim integrates it.
    await time.increase(Number(epochLength));

    // Pre-fund the CSS vault for the payout-compound, then claim.
    const expectedReward = effStake; // delegatorScore18 with sps36 == 1e18, opFee 0
    expect(expectedReward % 2n).to.equal(1n); // reward is ODD
    await Token.mint(await CSS.getAddress(), expectedReward);

    await expect(NFT.connect(accounts[0]).claim(1))
      .to.emit(StakingV10Contract, 'RewardsClaimed')
      .withArgs(1n, expectedReward);

    // Raw grew by the odd reward; position still boosted (tier 6 = 180 days,
    // we only advanced one 30-day epoch).
    const posC = await CSS.getPosition(1);
    expect(posC.raw).to.equal(R0 + expectedReward);
    const nowTs = BigInt((await hre.ethers.provider.getBlock('latest'))!.timestamp);
    expect(nowTs).to.be.lessThan(BigInt(expiryTs)); // still inside the boost window

    // ── WITNESS (boost slot) — increaseRaw now installs the boost as the ONE-SHOT
    //    delta floor((R0+rew)*k) - floor(R0*k), so after the compounded claim the
    //    slot holds floor((R0+rew)*k) exactly — the same value updateOnRedelegate's
    //    _cancelNodeExpiry removes. The PRE-FIX code stored the sum of two
    //    independent floors (1 wei less), which the one-shot unwind over-cancelled. ──
    const slotAfterClaim = await CSS.getNodeExpiryDrop(nodeA, expiryTs);
    const oneShotBoost = boostOf(R0 + expectedReward); // one floor (== what the unwind removes)
    const preFixAccumulatedBoost = boostOf(R0) + boostOf(expectedReward); // two floors (old, buggy)
    expect(slotAfterClaim).to.equal(oneShotBoost); // now one-shot consistent
    expect(oneShotBoost).to.equal(preFixAccumulatedBoost + 1n); // the 1 wei the old code stranded

    // ── WITNESS (running effective stake) — likewise installed as the one-shot
    //    delta, so node A's running stake equals floor((R0+rew)*m), matching the
    //    one-shot unwind. (Pre-fix this was floor(R0*m)+floor(rew*m), 1 wei short,
    //    and the unwind tripped "Neg running stake".) ──
    const runningA = await CSS.getNodeRunningEffectiveStake(nodeA);
    const oneShotEff = effOf(R0 + expectedReward); // one floor
    const preFixAccumulatedEff = effOf(R0) + effOf(expectedReward); // two floors (old, buggy)
    expect(runningA).to.equal(oneShotEff);
    expect(oneShotEff).to.equal(preFixAccumulatedEff + 1n);

    // ── THE FIX (G-6) — because the position's contribution is one-shot consistent,
    //    the unwind is EXACT (no incremental-vs-one-shot asymmetry, strict
    //    _cancelNodeExpiry / _applyNodeStakeDelta invariants intact), so redelegate
    //    SUCCEEDS where it used to revert "Neg running stake". ──
    await expect(NFT.connect(accounts[0]).redelegate(1, nodeB)).to.emit(
      CSS,
      'PositionRedelegated',
    );

    // Position moved to B; node A drained to EXACTLY 0 (no dust removed from any
    // other delegator — the unwind matched the contribution), node B receives the
    // position's full one-shot contribution.
    expect(await NFT.ownerOf(1)).to.equal(accounts[0].address);
    expect((await CSS.getPosition(1)).identityId).to.equal(BigInt(nodeB));
    expect(await CSS.getNodeRunningEffectiveStake(nodeA)).to.equal(0n);
    expect(await CSS.getNodeExpiryDrop(nodeA, expiryTs)).to.equal(0n);
    expect(await CSS.getNodeRunningEffectiveStake(nodeB)).to.equal(oneShotEff);
    expect(await CSS.getNodeExpiryDrop(nodeB, expiryTs)).to.equal(oneShotBoost);
  });
});
