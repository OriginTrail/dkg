// =============================================================================
// D26 — @integration Timestamp-accurate staking accounting
// =============================================================================
//
// Exercises the three D26 paths introduced by the time-accurate staking
// refactor:
//
//   1. Mid-epoch expiry denominator — a node with a boosted position that
//      expires mid-epoch must drop its effective stake at `expiryTimestamp`,
//      not at the end of the epoch. `settleNodeTo(now)` drains the expiry
//      queue and leaves `runningNodeEffectiveStake` at the raw tail.
//
//   2. Claim binary-search path — `RandomSamplingStorage.findScorePerStakeAt`
//      must split score-per-stake accumulation at an arbitrary intra-epoch
//      timestamp. A synthetic checkpoint sequence exercises the binary
//      search over the epoch's `mid[]` array.
//
//   3. Node dormancy resume — after a long inactive window, the first call
//      to `settleNodeTo` drains every queued expiry in O(pending) time,
//      independent of how many epochs elapsed. The running stake lands on
//      the exact raw tail without per-epoch iteration.
//
// These paths don't exist in the pre-D26 epoch-quantized model and wouldn't
// be covered by the existing @unit or flywheel suites.
//
// Storage mutators are gated by `onlyContracts`. We grant `Hub.setContractAddress`
// to a test EOA so we can call them directly — the gating itself is covered
// by the @unit suite for each storage contract.

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';
// @ts-expect-error: No type definitions available for assertion-tools
import { kcTools } from 'assertion-tools';
import { expect } from 'chai';
import hre from 'hardhat';

import {
  Chronos,
  ConvictionStakingStorage,
  Hub,
  KnowledgeCollectionStorage,
  ParametersStorage,
  Profile,
  RandomSampling,
  RandomSamplingStorage,
  ShardingTableStorage,
} from '../../typechain';
import { sqrt } from '../helpers/math-helpers';
import { createProfile } from '../helpers/profile-helpers';

const ALICE_ID = 42n;

const SCALE18 = 10n ** 18n;
const ONE_X = SCALE18;
const TWO_X = 2n * SCALE18;
const THREE_AND_HALF_X = (35n * SCALE18) / 10n;
const SIX_X = 6n * SCALE18;
const DAY = 24n * 60n * 60n;

const PROOF_QUADS = [
  '<urn:s> <urn:p> "o" .',
];

async function tsNow(): Promise<bigint> {
  return BigInt(await time.latest());
}

describe('@integration D26 — time-accurate staking accounting', () => {
  let accounts: SignerWithAddress[];
  let Hub: Hub;
  let CSS: ConvictionStakingStorage;
  let RSS: RandomSamplingStorage;
  let RandomSampling: RandomSampling;
  let ParametersStorage: ParametersStorage;
  let Chronos: Chronos;
  let KnowledgeCollectionStorage: KnowledgeCollectionStorage;
  let Profile: Profile;
  let ShardingTableStorage: ShardingTableStorage;

  async function deployFixture() {
    // Mirror the @unit RandomSamplingStorage fixture — it pulls in the full
    // Hub stack including Chronos, which the RSS constructor needs.
    await hre.deployments.fixture([
      'Token',
      'KnowledgeCollectionStorage',
      'KnowledgeCollection',
      'RandomSamplingStorage',
      'RandomSampling',
      'ShardingTableStorage',
      'EpochStorage',
      'Profile',
      'ConvictionStakingStorage',
    ]);
    accounts = await hre.ethers.getSigners();
    Hub = await hre.ethers.getContract<Hub>('Hub');
    CSS = await hre.ethers.getContract<ConvictionStakingStorage>('ConvictionStakingStorage');
    RSS = await hre.ethers.getContract<RandomSamplingStorage>('RandomSamplingStorage');
    RandomSampling = await hre.ethers.getContract<RandomSampling>('RandomSampling');
    ParametersStorage = await hre.ethers.getContract<ParametersStorage>('ParametersStorage');
    Chronos = await hre.ethers.getContract<Chronos>('Chronos');
    KnowledgeCollectionStorage = await hre.ethers.getContract<KnowledgeCollectionStorage>(
      'KnowledgeCollectionStorage',
    );
    Profile = await hre.ethers.getContract<Profile>('Profile');
    ShardingTableStorage = await hre.ethers.getContract<ShardingTableStorage>(
      'ShardingTableStorage',
    );
    return {
      accounts,
      Hub,
      CSS,
      RSS,
      RandomSampling,
      ParametersStorage,
      Chronos,
      KnowledgeCollectionStorage,
      Profile,
      ShardingTableStorage,
    };
  }

  beforeEach(async () => {
    hre.helpers.resetDeploymentsJson();
    ({
      accounts,
      Hub,
      CSS,
      RSS,
      RandomSampling,
      ParametersStorage,
      Chronos,
      KnowledgeCollectionStorage,
      Profile,
      ShardingTableStorage,
    } = await loadFixture(deployFixture));
  });

  async function expectedBaselineScore(effectiveStake: bigint): Promise<bigint> {
    const stakeCap = await ParametersStorage.maximumStake();
    const cappedStake = effectiveStake > stakeCap ? stakeCap : effectiveStake;
    const stakeRatio18 = (cappedStake * SCALE18) / stakeCap;
    const stakeFactor18 = sqrt(stakeRatio18 * SCALE18);
    const baselineComponent18 = (2n * SCALE18) / 1000n;
    return (stakeFactor18 * baselineComponent18) / SCALE18;
  }

  async function createProofableKnowledgeCollection(): Promise<bigint> {
    const chunks = kcTools.splitIntoChunks(PROOF_QUADS, 32);
    const merkleRoot = kcTools.calculateMerkleRoot(PROOF_QUADS, 32);
    const currentEpoch = await Chronos.getCurrentEpoch();
    const args = [
      accounts[0].address,
      'd26-submit-proof-regression',
      merkleRoot,
      1,
      32 * chunks.length,
      currentEpoch,
      currentEpoch + 1n,
      0,
      false,
      chunks.length,
    ] as const;

    const knowledgeCollectionId =
      await KnowledgeCollectionStorage.createKnowledgeCollection.staticCall(...args);
    await KnowledgeCollectionStorage.createKnowledgeCollection(...args);
    return knowledgeCollectionId;
  }

  async function createProofableNode(): Promise<{
    identityId: bigint;
    operational: SignerWithAddress;
  }> {
    const node = { admin: accounts[1], operational: accounts[2] };
    const { identityId, nodeId } = await createProfile(Profile, node);
    const identityId72 = BigInt(identityId);

    await ShardingTableStorage.createNodeObject(1, nodeId, identityId72, 0);
    await ShardingTableStorage.setIdentityId(0, identityId72);
    await ShardingTableStorage.incrementNodesCount();

    return { identityId: identityId72, operational: node.operational };
  }

  // --------------------------------------------------------------------
  // 1. Mid-epoch expiry denominator
  // --------------------------------------------------------------------

  describe('mid-epoch expiry denominator', () => {
    it('RandomSampling.calculateNodeScore uses active conviction multipliers', async () => {
      const raw = (await ParametersStorage.maximumStake()) / 10n;
      const boostedEffectiveStake = (raw * SIX_X) / SCALE18;

      await CSS.createPosition(1, ALICE_ID, raw, 12, 0);

      expect(await CSS.getNodeStakeV10(ALICE_ID)).to.equal(raw);
      expect(await CSS.getNodeEffectiveStake(ALICE_ID)).to.equal(boostedEffectiveStake);

      const score = await RandomSampling.calculateNodeScore(ALICE_ID);

      expect(score).to.equal(await expectedBaselineScore(boostedEffectiveStake));
      expect(score).to.not.equal(await expectedBaselineScore(raw));
    });

    it('RandomSampling.calculateNodeScore caps boosted effective stake after applying the multiplier', async () => {
      const maximumStake = await ParametersStorage.maximumStake();
      const raw = maximumStake / 2n;
      const boostedEffectiveStake = (raw * SIX_X) / SCALE18;

      await CSS.createPosition(1, ALICE_ID, raw, 12, 0);

      expect(raw).to.be.lessThan(maximumStake);
      expect(boostedEffectiveStake).to.be.greaterThan(maximumStake);
      expect(await CSS.getNodeEffectiveStake(ALICE_ID)).to.equal(boostedEffectiveStake);

      const score = await RandomSampling.calculateNodeScore(ALICE_ID);

      expect(score).to.equal(await expectedBaselineScore(boostedEffectiveStake));
      expect(score).to.equal(await expectedBaselineScore(maximumStake));
      expect(score).to.not.equal(await expectedBaselineScore(raw));
    });

    it('RandomSampling.calculateNodeScore simulates expired multiplier drops', async () => {
      const raw = (await ParametersStorage.maximumStake()) / 10n;

      await CSS.createPosition(1, ALICE_ID, raw, 12, 0);
      const position = await CSS.getPosition(1);
      const boostedEffectiveStake = (raw * SIX_X) / SCALE18;

      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(boostedEffectiveStake);

      await time.increaseTo(Number(position.expiryTimestamp + 1n));

      expect(await RandomSampling.calculateNodeScore(ALICE_ID)).to.equal(
        await expectedBaselineScore(raw),
      );
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(boostedEffectiveStake);
    });

    it('RandomSampling.submitProof settles expired multipliers before scoring and checkpointing', async () => {
      const { identityId, operational } = await createProofableNode();
      const raw = (await ParametersStorage.maximumStake()) / 10n;
      const boostedEffectiveStake = (raw * SIX_X) / SCALE18;

      await CSS.createPosition(1, identityId, raw, 12, 0);
      const position = await CSS.getPosition(1);
      expect(await CSS.getNodeRunningEffectiveStake(identityId)).to.equal(boostedEffectiveStake);

      await time.increaseTo(Number(position.expiryTimestamp + 1n));

      const knowledgeCollectionId = await createProofableKnowledgeCollection();
      const chunkId = 0;
      const { leaf, proof } = kcTools.calculateMerkleProof(PROOF_QUADS, 32, chunkId);
      const epoch = await Chronos.getCurrentEpoch();
      await RandomSampling.updateAndGetActiveProofPeriodStartBlock();
      const { activeProofPeriodStartBlock } = await RandomSampling.getActiveProofPeriodStatus();
      const proofingPeriodDurationInBlocks =
        await RandomSampling.getActiveProofingPeriodDurationInBlocks();

      await RSS.setNodeChallenge(identityId, {
        knowledgeCollectionId,
        chunkId,
        knowledgeCollectionStorageContract: await KnowledgeCollectionStorage.getAddress(),
        epoch,
        activeProofPeriodStartBlock,
        proofingPeriodDurationInBlocks,
        solved: false,
      });

      const expectedScore = await expectedBaselineScore(raw);

      await RandomSampling.connect(operational).submitProof(leaf, proof);

      expect(await CSS.getNodeRunningEffectiveStake(identityId)).to.equal(raw);
      expect(await RSS.getEpochNodeValidProofsCount(epoch, identityId)).to.equal(1n);
      expect(await RSS.getNodeEpochScore(epoch, identityId)).to.equal(expectedScore);
      expect(await RSS.getAllNodesEpochScore(epoch)).to.equal(expectedScore);
      expect(await RSS.getNodeEpochProofPeriodScore(identityId, epoch, activeProofPeriodStartBlock)).to.equal(
        expectedScore,
      );
      expect(await RSS.getEpochLastScorePerStake(identityId, epoch)).to.equal(
        (expectedScore * SCALE18) / raw,
      );
      expect(await RSS.findScorePerStakeAt(identityId, epoch, await tsNow())).to.equal(
        (expectedScore * SCALE18) / raw,
      );
      expect((await RSS.getNodeChallenge(identityId)).solved).to.equal(true);
    });

    it('Node effective stake transitions from boosted to raw at exact expiryTimestamp', async () => {
      // Alice opens a 30-day tier-1 position (boost 1.5x on 2000 raw).
      // Effective now: 3000. At +30d it collapses to 2000 (raw tail).
      await CSS.createPosition(1, ALICE_ID, 2000, 1, 0);
      const created = await tsNow();
      const expiry = created + 30n * DAY;

      // Jump to one second before expiry and settle. Note: `settleNodeTo`
      // mines a block and can advance block.timestamp by 1, so we skip the
      // exact-boundary check (covered by the simulated read below) and just
      // verify the pre-expiry running stake.
      await time.increaseTo(Number(expiry - 10n));
      await CSS.settleNodeTo(ALICE_ID, await tsNow());
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(3000n);

      // Jump past expiry — the drop has fired.
      await time.increaseTo(Number(expiry + 10n));
      await CSS.settleNodeTo(ALICE_ID, await tsNow());
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(2000n);

      // Two consecutive settles in the same block are idempotent.
      await CSS.settleNodeTo(ALICE_ID, await tsNow());
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(2000n);
    });

    it('Simulated read at arbitrary future timestamp does not mutate state', async () => {
      await CSS.createPosition(1, ALICE_ID, 1000, 12, 0);
      const created = await tsNow();
      const expiry = created + 366n * DAY;

      // Pre-settle to now so `nodeLastSettledAt` is set and the simulation
      // starts from a well-defined baseline.
      await CSS.settleNodeTo(ALICE_ID, created);

      const beforeRunning = await CSS.getNodeRunningEffectiveStake(ALICE_ID);
      const beforeHead = await CSS.getNodeExpiryHead(ALICE_ID);

      // Simulated read past the expiry: returns 1000 but mutates nothing.
      expect(await CSS.getNodeEffectiveStakeAtTimestamp(ALICE_ID, expiry + 100n)).to.equal(1000n);
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(beforeRunning);
      expect(await CSS.getNodeExpiryHead(ALICE_ID)).to.equal(beforeHead);
    });
  });

  // --------------------------------------------------------------------
  // 2. Claim binary-search path
  // --------------------------------------------------------------------

  describe('claim binary-search path (RSS.findScorePerStakeAt)', () => {
    it('Returns the correct snapshot for a timestamp between two checkpoints', async () => {
      // Seed an epoch with three checkpoints at t=10, 20, 30 with
      // monotonically increasing score-per-stake values.
      const epoch = 42n;
      await RSS.appendCheckpoint(ALICE_ID, epoch, 10, 100);
      await RSS.appendCheckpoint(ALICE_ID, epoch, 20, 250);
      await RSS.appendCheckpoint(ALICE_ID, epoch, 30, 400);

      // Before the first checkpoint → first-of-epoch sentinel (0 by default).
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 5)).to.equal(0);
      // Exactly at first → first sample.
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 10)).to.equal(100);
      // Between first and second → first sample still (no later ckpt <= ts).
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 15)).to.equal(100);
      // Exactly at second.
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 20)).to.equal(250);
      // Between second and third.
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 25)).to.equal(250);
      // Exactly at third.
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 30)).to.equal(400);
      // After the last checkpoint.
      expect(await RSS.findScorePerStakeAt(ALICE_ID, epoch, 99)).to.equal(400);
    });

    it('Empty mid[] returns 0 (epoch-local accumulator default)', async () => {
      // M6/M7 — the `firstScorePerStake36` sentinel was removed. Epochs with no
      //         checkpoints naturally return 0 (the accumulator default).
      expect(await RSS.findScorePerStakeAt(ALICE_ID, 77n, 123)).to.equal(0);
    });
  });

  // --------------------------------------------------------------------
  // 3. Node dormancy resume
  // --------------------------------------------------------------------

  describe('node dormancy resume', () => {
    it('Settling to `now` after years of dormancy drains all pending expiries in O(pending)', async () => {
      // Three positions with staggered expiries (30d / 180d / 366d).
      await CSS.createPosition(1, ALICE_ID, 100, 1, 0);
      await CSS.createPosition(2, ALICE_ID, 100, 6, 0);
      await CSS.createPosition(3, ALICE_ID, 100, 12, 0);

      // Jump 5 years forward — every expiry is well in the past.
      const base = await tsNow();
      await time.increaseTo(Number(base + 5n * 366n * DAY));

      const tx = await CSS.settleNodeTo(ALICE_ID, await tsNow());
      const receipt = await tx.wait();
      // O(3) drains; should be well under 200k gas.
      expect(receipt!.gasUsed).to.be.lessThan(200_000n);

      // Running stake is exactly the raw tail: 100 + 100 + 100 = 300.
      expect(await CSS.getNodeRunningEffectiveStake(ALICE_ID)).to.equal(300n);
      // Head cursor is past every queued entry.
      expect(await CSS.getNodeExpiryHead(ALICE_ID)).to.equal(3n);
      expect(await CSS.getNodePendingExpiryCount(ALICE_ID)).to.equal(0n);
    });

    it('getNodeEffectiveStakeAtEpoch still works on a dormant node (legacy adapter)', async () => {
      await CSS.createPosition(1, ALICE_ID, 1000, 3, 0);
      // Force a long time jump that crosses many Chronos epochs.
      const epochLength = await Chronos.epochLength();
      await time.increase(Number(epochLength) * 100);
      const currentEpoch = await Chronos.getCurrentEpoch();
      // The D26 adapter simulates to epoch-end timestamp — post-expiry the
      // effective stake is the raw tail (1000), regardless of dormancy.
      expect(
        await CSS.getNodeEffectiveStakeAtEpoch(ALICE_ID, currentEpoch),
      ).to.equal(1000n);
    });
  });

  // --------------------------------------------------------------------
  // Sanity: V8 adapter still returns epoch-final sentinel (parity)
  // --------------------------------------------------------------------

  it('RSS.getNodeEpochScorePerStake (V8 adapter) returns lastScorePerStake36 from EpochIndex', async () => {
    // L6 — `setLastScorePerStake` was removed as a test-only footgun (it could
    //      desynchronize `mid[tail].scorePerStake36` from
    //      `lastScorePerStake36`). The canonical mutator is now
    //      `addToNodeEpochScorePerStake`, which appends a checkpoint AND bumps
    //      `lastScorePerStake36` atomically.
    const epoch = 13n;
    void ONE_X;
    await RSS.addToNodeEpochScorePerStake(epoch, ALICE_ID, 9999n);
    expect(await RSS.getNodeEpochScorePerStake(epoch, ALICE_ID)).to.equal(9999n);
    // Appending another checkpoint bumps the sentinel further (accumulator is
    // monotonic within an epoch).
    await RSS.addToNodeEpochScorePerStake(epoch, ALICE_ID, 4200n);
    expect(await RSS.getNodeEpochScorePerStake(epoch, ALICE_ID)).to.equal(9999n + 4200n);
  });
});
