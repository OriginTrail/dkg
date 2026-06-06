import {
  time,
  expect,
  hre,
  toTRAC,
  quads,
  ensureNodeHasChunksThisEpoch,
  advanceToNextProofingPeriod,
  submitProofAndLogScore,
  createKnowledgeCollection,
  createProfile,
  buildInitialRewardsState,
  type SignerWithAddress,
  type Token,
  type Profile,
  type ProfileStorage,
  type Staking,
  type Chronos,
  type RandomSamplingStorage,
  type EpochStorage,
  type KnowledgeCollection,
  type Hub,
  type StakingStorage,
  type RandomSampling,
  type Ask,
  type AskStorage,
  type ParametersStorage,
  type DelegatorsInfo,
  type ShardingTable,
} from './StakingRewards.shared';



/* ───────────────────────────── tests ───────────────────────────── */

// ---------------------------------------------------------------------------
// TOMBSTONE — V8 StakingRewards integration suites (skipped)
// ---------------------------------------------------------------------------
//
// Every describe below drives V8 `Staking.stake()` → `claimDelegatorRewards()`
// → `restakeRewards()` → V8 `requestWithdrawal()` against `StakingStorage` +
// `DelegatorsInfo`. Under V10 (PR #97):
//
//   - User directive + D18: `calculateNodeScore` reads V10 stake only, so
//     V8 delegators earn score 0 → reward 0. Every proportionality, rolling-
//     rewards, and equal-reward assertion collapses.
//   - D3: `DelegatorsInfo` removed.
//   - D15: V10 aggregates live on `ConvictionStakingStorage`.
//
// V10 equivalents:
//   - Unit: `test/unit/ConvictionStakingStorage.test.ts`,
//           `test/unit/DKGStakingConvictionNFT.test.ts`
//   - Integration: `test/v10-conviction.test.ts`,
//                  `test/v10-e2e-conviction.test.ts`
//
// The withdrawal-timer / claim-order / operator-fee scenarios here would
// require a full V10 port (createConviction + multi-NFT nodes + D14 zero-
// delay finalize) to carry signal. Skipped with tombstone pending that
// port.
describe.skip('rewards tests (OBSOLETE: V8 rewards pipeline)', () => {
  /* fixture state visible to all tests in this describe-block */
  let env: Awaited<ReturnType<typeof buildInitialRewardsState>>;

  before(async () => {
    env = await buildInitialRewardsState();
  });



  /* 1️⃣  Claim-jumping guard. */
  it('D1 cannot claim the newest finalised epoch while older remain unclaimed', async () => {
    const { Staking, EpochStorage, delegators, nodes } = env;
    const newestFinalised = await EpochStorage.lastFinalizedEpoch(1); //  == 3
    // Matches the exact require() string used elsewhere in this suite.
    // Catches regression where the claim-order guard is removed and the
    // newest epoch is claimable before older ones (would silently succeed or
    // revert with a different reason).
    await expect(
      Staking.connect(delegators[0]).claimDelegatorRewards(
        nodes[0].identityId,
        newestFinalised,
        delegators[0].address,
      ),
    ).to.be.revertedWith('Must claim older epochs first');
  });

  /* 2️⃣  Operator-fee sanity (all nodes @ 1000 ‱). */
  it('every node stores 10 % operator fee', async () => {
    const { ProfileStorage, nodes } = env;
    for (const n of nodes) {
      const opFee = await ProfileStorage.getOperatorFee(n.identityId);
      expect(opFee).to.equal(1000); // 1000 ‱  ==  10 %
    }
  });

});
