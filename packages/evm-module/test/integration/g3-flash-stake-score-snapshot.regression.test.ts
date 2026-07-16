import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  RandomSampling,
  RandomSamplingStorage,
  Chronos,
  DKGKnowledgeAssets,
  Profile,
  Hub,
  ContextGraphStorage,
  ContextGraphValueStorage,
  CGWeightTreeStorage,
  ConvictionStakingStorage,
  DKGStakingConvictionNFT,
  StakingV10,
  ParametersStorage,
  Token,
  ShardingTable,
} from '../../typechain';
import { createProfile } from '../helpers/profile-helpers';

/**
 * ============================================================================
 * PoC for AUDIT FINDING G-3 (HIGH) — flash-stake proof-score inflation.
 * ============================================================================
 *
 * `RandomSampling.submitProof` derives the node's per-proof score from the
 * effective stake read LIVE at the proof block:
 *     convictionStakingStorage.settleNodeTo(identityId, tsNow);
 *     uint256 effectiveNodeStake = getNodeRunningEffectiveStake(identityId);
 *     uint256 score18 = _calculateNodeScore(identityId, effectiveNodeStake);
 *     ...addToNodeEpochScore / addToAllNodesEpochScore     (persists whole epoch)
 * where the stake factor is sqrt(effStake / stakeCap)  (RandomSampling.sol:766-767).
 *
 * `getNodeRunningEffectiveStake` returns the bare INSTANTANEOUS running stake
 * (CSS:1505-1507) — no time-averaging over the epoch. A tier-0 conviction
 * position (1x, no lock, expiryTimestamp == 0) applies its full raw to
 * `runningNodeEffectiveStake` immediately on `createConviction` (CSS:1037-1041)
 * and is withdrawable the very next call (StakingV10.withdraw gates only on
 * `expiryTimestamp == 0 || now >= expiryTimestamp`, no cooldown on this path).
 *
 * EXPLOIT: a node holding only the minimum real stake (50k) flash-mints a
 * tier-0 position that pushes its running effective stake to the cap (5M) in
 * the block where it calls submitProof, captures the cap-level sqrt-stake
 * factor for the WHOLE epoch, then withdraws the flash position the next block —
 * recovering the principal with ~zero capital-time-at-risk. The inflated score
 * is indistinguishable from a node that locked 5M continuously, yet honest
 * competitors who only locked 50k are diluted ~10x.
 *
 * Controls prove the score machinery is honest: a real 50k node scores ~0.1x
 * cap; a node that genuinely holds 5M scores ~1.0x cap. The exploit shows the
 * 50k node steals the 5M node's score for one block of stake.
 */
describe('@integration Regression G-3: challenge-time stake snapshot neutralizes flash-stake score inflation', () => {
  const SCALE18 = 10n ** 18n;
  const OPEN_POLICY = 1;
  const TEST_KA_BYTE_SIZE = 128n;

  // Structured single-leaf public KA (matches the V10 merkle / F-01 template):
  // honest proof is `content = publicContent`, proof = [SENTINEL].
  const SENTINEL_NO_PRIVATE = ethers.keccak256(
    ethers.toUtf8Bytes('DKG_NO_PRIVATE_DATA_V10'),
  );
  const publicContent = ethers.toUtf8Bytes('g3-secret-chunk-content');
  const publicRoot = ethers.keccak256(publicContent); // 1-leaf tree: root == leaf
  const merkleRoot = ethers.keccak256(
    ethers.concat([publicRoot, SENTINEL_NO_PRIVATE]),
  );
  const honestProof = [SENTINEL_NO_PRIVATE];

  let accounts: Awaited<ReturnType<typeof hre.ethers.getSigners>>;
  let opSigner: (typeof accounts)[number];
  let Hub: Hub;
  let RandomSampling: RandomSampling;
  let RandomSamplingStorage: RandomSamplingStorage;
  let Chronos: Chronos;
  let DKGKnowledgeAssets: DKGKnowledgeAssets;
  let Profile: Profile;
  let ContextGraphStorage: ContextGraphStorage;
  let ContextGraphValueStorage: ContextGraphValueStorage;
  let CGWeightTreeStorage: CGWeightTreeStorage;
  let CSS: ConvictionStakingStorage;
  let NFT: DKGStakingConvictionNFT;
  let StakingV10: StakingV10;
  let ParametersStorage: ParametersStorage;
  let Token: Token;
  let ShardingTable: ShardingTable;
  let minimumStake: bigint;
  let maximumStake: bigint;
  let kaNumber = 0n;
  // Each node gets a disjoint pair of accounts so multiple nodes coexist.
  let nextAcct = 1;

  async function deployFixture() {
    await hre.deployments.fixture([
      'Token', 'Hub', 'ParametersStorage', 'WhitelistStorage', 'IdentityStorage',
      'ShardingTableStorage', 'ShardingTable', 'StakingStorage', 'ProfileStorage',
      'Chronos', 'EpochStorage', 'DKGKnowledgeAssets', 'AskStorage', 'DelegatorsInfo',
      'RandomSamplingStorage', 'ContextGraphValueStorage', 'ContextGraphStorage',
      'RandomSampling', 'Profile',
      // V10 conviction staking stack (the score-feeding effective-stake layer).
      'DKGStakingConvictionNFT', 'StakingV10',
    ]);
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    await Hub.setContractAddress('HubOwner', accounts[0].address);
    await Hub.setContractAddress('TestStorageOperator', accounts[19].address);

    RandomSampling = await hre.ethers.getContract<RandomSampling>('RandomSampling');
    RandomSamplingStorage = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    DKGKnowledgeAssets = await hre.ethers.getContract<DKGKnowledgeAssets>('DKGKnowledgeAssets');
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ContextGraphStorage = await hre.ethers.getContract<ContextGraphStorage>('ContextGraphStorage');
    ContextGraphValueStorage = await hre.ethers.getContract<ContextGraphValueStorage>('ContextGraphValueStorage');
    CGWeightTreeStorage = await hre.ethers.getContract<CGWeightTreeStorage>('CGWeightTreeStorage');
    CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    NFT = await hre.ethers.getContract<DKGStakingConvictionNFT>('DKGStakingConvictionNFT');
    StakingV10 = await hre.ethers.getContract<StakingV10>('StakingV10');
    ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    Token = await hre.ethers.getContract<Token>('Token');
    ShardingTable = await hre.ethers.getContract<ShardingTable>('ShardingTable');
    await CGWeightTreeStorage.connect(accounts[19]).finishBackfill();
    opSigner = accounts[19];
    minimumStake = await ParametersStorage.minimumStake();
    maximumStake = await ParametersStorage.maximumStake();
    kaNumber = 0n;
    nextAcct = 1;
  }

  function nextKaId(): bigint {
    kaNumber += 1n;
    return (BigInt(opSigner.address) << 96n) | kaNumber;
  }

  async function createPublicCG(): Promise<bigint> {
    await (
      await ContextGraphStorage.connect(opSigner).createContextGraph(
        accounts[1].address, [], 0, 0, OPEN_POLICY, ethers.ZeroAddress, 0, ethers.ZeroHash,
      )
    ).wait();
    return ContextGraphStorage.getLatestContextGraphId();
  }

  async function seedKa(cgId: bigint): Promise<bigint> {
    const currentEpoch = await Chronos.getCurrentEpoch();
    const receipt = await (
      await DKGKnowledgeAssets.connect(opSigner).createKnowledgeAsset(
        opSigner.address, opSigner.address, nextKaId(), 'g3-poc',
        merkleRoot, 1, TEST_KA_BYTE_SIZE, currentEpoch, currentEpoch + 5n, 0, false, 1,
      )
    ).wait();
    const iface = DKGKnowledgeAssets.interface;
    const topic = iface.getEvent('KnowledgeAssetCreated')!.topicHash;
    const log = receipt!.logs.find((l) => l.topics[0] === topic)!;
    const kaId = iface.parseLog(log as unknown as { topics: string[]; data: string })!.args[0] as bigint;
    await (await ContextGraphStorage.connect(opSigner).registerKnowledgeAssetToContextGraph(cgId, kaId)).wait();
    await (await ContextGraphValueStorage.connect(opSigner).addCGValueForEpochRange(cgId, currentEpoch, 5n, 1_000n)).wait();
    await (await CGWeightTreeStorage.connect(opSigner).settle(cgId)).wait();
    return kaId;
  }

  // Mint TRAC to `who` and approve StakingV10 (the NFT path pulls via StakingV10).
  async function fund(who: (typeof accounts)[number], amount: bigint) {
    await (await Token.mint(who.address, amount)).wait();
    await (await Token.connect(who).approve(await StakingV10.getAddress(), amount)).wait();
  }

  // Register a sharding-table node with a REAL baseline tier-0 conviction
  // position of `baseline` TRAC (effective == raw at 1x). insertNode is the
  // owner state-seeding shortcut F-01 uses — a >= minStake node would be in
  // the table on the normal path anyway.
  async function setupNode(baseline: bigint) {
    const operational = accounts[nextAcct++];
    const admin = accounts[nextAcct++];
    const { identityId } = await createProfile(Profile, { operational, admin });
    await fund(operational, baseline);
    // tier 0 = rest state (1x, no lock); real stake feeding the score. Because
    // `baseline >= minimumStake`, StakingV10.stake auto-inserts the node into
    // the sharding table (StakingV10.sol:367) — the genuine production path, no
    // owner shortcut needed.
    await (await NFT.connect(operational).createConviction(identityId, baseline, 0)).wait();
    return { operational, admin, identityId: BigInt(identityId) };
  }

  // Drive the REAL createChallenge path so a single-leaf public KA is pinned.
  async function challenge(node: { operational: (typeof accounts)[number] }) {
    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(node.operational).createChallenge();
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    await loadFixture(deployFixture);
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL A — an HONEST node with only the minimum (50k) real stake submits
  // a genuine proof. The score it earns reflects sqrt(50k / 5M) ≈ 0.1x cap.
  // (Establishes the harness is wired and the honest low-stake baseline.)
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: honest 50k node earns the low (sqrt(0.01) ~ 0.1x cap) score', async () => {
    const cgId = await createPublicCG();
    await seedKa(cgId);
    const node = await setupNode(minimumStake);
    await challenge(node);

    const epoch = await Chronos.getCurrentEpoch();
    expect(await CSS.getNodeRunningEffectiveStake(node.identityId)).to.equal(minimumStake);

    await RandomSampling.connect(node.operational).submitProof(publicContent, honestProof);

    const score = await RandomSamplingStorage.getNodeEpochScore(epoch, node.identityId);
    expect(score).to.be.gt(0n);
    // sqrt(50000/5000000) = 0.1 of the cap-level stake factor.
    expect(await CSS.getNodeRunningEffectiveStake(node.identityId)).to.equal(minimumStake);
    return { score };
  });

  // ────────────────────────────────────────────────────────────────────────
  // CONTROL B — an HONEST node that genuinely holds the CAP (5M) of real,
  // continuously-held stake earns ~1.0x cap score: ~10x the 50k node.
  // (Shows the sqrt-stake scaling is legitimate when the stake is actually
  // held — this is the score the formula is DESIGNED to require 5M for.)
  // ────────────────────────────────────────────────────────────────────────
  it('CONTROL: honest 5M-staked node earns ~10x the 50k node (legit cap score)', async () => {
    const cgId = await createPublicCG();
    await seedKa(cgId);

    const small = await setupNode(minimumStake);
    const big = await setupNode(maximumStake); // genuinely holds the cap
    await challenge(small);
    await challenge(big);

    const epoch = await Chronos.getCurrentEpoch();
    expect(await CSS.getNodeRunningEffectiveStake(big.identityId)).to.equal(maximumStake);

    await RandomSampling.connect(small.operational).submitProof(publicContent, honestProof);
    await RandomSampling.connect(big.operational).submitProof(publicContent, honestProof);

    const smallScore = await RandomSamplingStorage.getNodeEpochScore(epoch, small.identityId);
    const bigScore = await RandomSamplingStorage.getNodeEpochScore(epoch, big.identityId);

    // score ∝ sqrt(effStake): sqrt(5M)/sqrt(50k) = sqrt(100) = 10.
    const ratio = (bigScore * 1000n) / smallScore;
    expect(ratio).to.be.closeTo(10_000n, 50n); // ~10.0x, within rounding
  });

  // ────────────────────────────────────────────────────────────────────────
  // REGRESSION (G-3 fix) — a 50k node FLASH-stakes to the cap (5M) in the proof
  // block, but its challenge was created at 50k, so min(snapshot, live) = 50k and
  // it earns exactly the honest 50k score — the spike buys NOTHING. Reverting the
  // snapshot cap re-inflates this to ~10x (re-breaking the test).
  // ────────────────────────────────────────────────────────────────────────
  it('REGRESSION G-3: flash-stake to the cap yields NO score advantage (challenge-time snapshot caps it)', async () => {
    const cgId = await createPublicCG();
    await seedKa(cgId);

    // Two identical 50k baseline nodes. `honest` proves at 50k; `attacker`
    // flash-spikes to the cap for the single proof block.
    const honest = await setupNode(minimumStake);
    const attacker = await setupNode(minimumStake);
    await challenge(honest);
    await challenge(attacker);

    const epoch = await Chronos.getCurrentEpoch();

    // ---- honest 50k node proves normally ----
    await RandomSampling.connect(honest.operational).submitProof(publicContent, honestProof);
    const honestScore = await RandomSamplingStorage.getNodeEpochScore(epoch, honest.identityId);

    // ---- attacker: flash-mint a tier-0 position bringing total stake to cap ----
    const flashAmount = maximumStake - minimumStake; // 50k + flash == 5M cap
    const funder = attacker.operational;
    await fund(funder, flashAmount);

    const effBeforeFlash = await CSS.getNodeRunningEffectiveStake(attacker.identityId);
    expect(effBeforeFlash).to.equal(minimumStake);

    const flashTx = await (
      await NFT.connect(funder).createConviction(attacker.identityId, flashAmount, 0)
    ).wait();
    // Parse the minted flash tokenId from PositionCreated(owner, tokenId, ...).
    const pcTopic = NFT.interface.getEvent('PositionCreated')!.topicHash;
    const pcLog = flashTx!.logs.find((l) => l.topics[0] === pcTopic)!;
    const flashTokenId = NFT.interface.parseLog(
      pcLog as unknown as { topics: string[]; data: string },
    )!.args[1] as bigint;

    // Effective stake is now at the cap — INSTANTLY, no lock, same epoch.
    const effAfterFlash = await CSS.getNodeRunningEffectiveStake(attacker.identityId);
    expect(effAfterFlash).to.equal(maximumStake);

    // ---- attacker submits proof at the spiked stake ----
    await RandomSampling.connect(attacker.operational).submitProof(publicContent, honestProof);
    const attackerScore = await RandomSamplingStorage.getNodeEpochScore(epoch, attacker.identityId);

    // (1) FIX: the attacker is scored against its CHALLENGE-TIME snapshot (50k),
    //     not the flashed cap — min(snapshot, live) = 50k — so its score EQUALS
    //     the honest 50k node's. The within-period spike buys nothing.
    expect(attackerScore).to.equal(honestScore);
    expect(attackerScore).to.be.lt(honestScore * 2n); // emphatically NOT the ~10x of the bug

    // (2) The flash stake is still immediately withdrawable (tier-0 is liquid by
    //     design) and the principal comes back — but it earned no extra score.
    const balBefore = await Token.balanceOf(funder.address);
    await (await NFT.connect(funder).withdraw(flashTokenId)).wait();
    const balAfter = await Token.balanceOf(funder.address);
    expect(balAfter - balBefore).to.equal(flashAmount); // full principal back, same epoch

    // (3) Effective stake collapses back to the 50k baseline; the (un-inflated)
    //     epoch score is sticky as before — but it was never inflated.
    expect(await CSS.getNodeRunningEffectiveStake(attacker.identityId)).to.equal(minimumStake);
    expect(
      await RandomSamplingStorage.getNodeEpochScore(epoch, attacker.identityId),
    ).to.equal(attackerScore);

    // (4) allNodesEpochScore is NOT poisoned: two equal 50k nodes contribute
    //     equally; neither dominates the reward-distribution denominator.
    const allScore = await RandomSamplingStorage.getAllNodesEpochScore(epoch);
    expect(allScore).to.equal(honestScore + attackerScore);
    expect(attackerScore).to.equal(allScore / 2n); // exactly half — no dilution

    // (5) DENOMINATOR INTEGRITY: the snapshot caps the score NUMERATOR only — the
    //     score-per-stake denominator stays the LIVE effective stake. So the
    //     attacker (proved at 5M live) gets a per-stake rate ~1/100 of the honest
    //     50k node's (same score(50k) numerator, divided by 5M vs 50k). Had the
    //     denominator been capped too, the rates would MATCH and delegator
    //     distribution would over-pay (Σ delegatorStake·rate > nodeScore).
    const honestSps = await RandomSamplingStorage.getEpochLastScorePerStake(honest.identityId, epoch);
    const attackerSps = await RandomSamplingStorage.getEpochLastScorePerStake(attacker.identityId, epoch);
    expect(honestSps).to.be.gt(0n);
    expect(attackerSps).to.be.gt(0n);
    // honest/attacker == 5M/50k == 100x  ⇒  ratio*1000 ≈ 100_000
    const rateRatio = (honestSps * 1000n) / attackerSps;
    expect(rateRatio).to.be.closeTo(100_000n, 2_000n);
  });

  // ────────────────────────────────────────────────────────────────────────
  // REGRESSION (G-3 zero-snapshot 🔴) — a node IN the sharding table with ZERO
  // V10 effective stake at challenge time must still be capped (at 0), not left
  // uncapped. Presence is gated on the explicit `...Set` FLAG, not on
  // `snapshot != 0`, so a stale/unmigrated zero-stake node cannot flash-stake
  // into a score. (createChallenge only checks table membership, not stake.)
  // ────────────────────────────────────────────────────────────────────────
  it('REGRESSION G-3: a zero-stake-at-challenge node is capped at 0 via the present-flag (no flash bypass)', async () => {
    const cgId = await createPublicCG();
    await seedKa(cgId);

    // In the table via owner insertNode, but with NO conviction stake.
    const operational = accounts[nextAcct++];
    const admin = accounts[nextAcct++];
    const { identityId } = await createProfile(Profile, { operational, admin });
    // @ts-expect-error – direct insertNode for test setup (owner bypasses onlyContracts)
    await ShardingTable.connect(accounts[0]).insertNode(identityId);
    const nodeId = BigInt(identityId);

    await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
    await RandomSampling.connect(operational).createChallenge();
    const epoch = await Chronos.getCurrentEpoch();

    // The snapshot is 0 but PRESENT (flag set) — the exact case the bug missed.
    expect(await CSS.getNodeRunningEffectiveStake(nodeId)).to.equal(0n);
    expect(await RandomSamplingStorage.nodeChallengeStakeSnapshot(nodeId)).to.equal(0n);
    expect(await RandomSamplingStorage.nodeChallengeStakeSnapshotSet(nodeId)).to.equal(true);

    // Flash-stake to the cap, then prove: min(snapshot 0, live cap) = 0 ⇒ score 0.
    await fund(operational, maximumStake);
    await NFT.connect(operational).createConviction(nodeId, maximumStake, 0);
    expect(await CSS.getNodeRunningEffectiveStake(nodeId)).to.equal(maximumStake);

    await RandomSampling.connect(operational).submitProof(publicContent, honestProof);
    // Pre-fix (snapshot != 0 sentinel) this scored at the flashed cap. Now: 0.
    expect(await RandomSamplingStorage.getNodeEpochScore(epoch, nodeId)).to.equal(0n);
  });
});
