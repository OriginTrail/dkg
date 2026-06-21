/**
 * Issue-liveness placeholders for two HIGH / pre-mainnet CONTRACT issues.
 *
 * Both are intentionally `it.skip` (pending) rather than fabricated green tests:
 * each needs a substantial, exact on-chain fixture (and for #1091, a design
 * change) that a contracts engineer should author so the repro is trustworthy.
 * A wrong contract test is worse than none. The detailed repro recipe below is
 * the head-start. When the repro is implemented, unskip it — it should FAIL
 * (reproduce the bug), then pass once the contract is fixed, then stay in CI.
 *
 *   #1091 — RandomSampling challenge seed is grindable (block.difficulty +
 *           blockhash are proposer-influenceable / off-chain-recomputable).
 *           https://github.com/OriginTrail/dkg/issues/1091
 *   #614  — DKGPublishingConvictionNFT unused-funds sweep can allocate prorated
 *           funds into an already-closed (claimed) epoch → unclaimable.
 *           https://github.com/OriginTrail/dkg/issues/614
 */

describe('@issue-liveness contracts (HIGH / pre-mainnet)', () => {
  // GH #1091 — grindable RandomSampling challenge seed.
  //
  // Repro recipe (needs the full eligible-challenge fixture: profile + stake +
  // an eligible CG with KAs + sharding table, so `createChallenge` produces a
  // real non-zero draw and `previewChallengeForSeed` returns the same tuple):
  //   1. Deploy the RS stack; register a node profile; stake; create an
  //      eligible CG + at least one KA so `_isCGEligible` passes.
  //   2. In a single block, recompute the seed off-chain exactly as
  //      `_deriveChallengeSeed`:
  //        keccak256(abi.encodePacked(
  //          block.difficulty,
  //          blockhash(block.number - ((block.difficulty % 256) + 1)),
  //          originalSender,
  //          uint8(1) /* sector */))
  //   3. Call `previewChallengeForSeed(recomputedSeed, currentEpoch)` → predicted
  //      (cgId, kaId, chunkId).
  //   4. Call `createChallenge()` from `originalSender` in the SAME block and read
  //      the emitted `ChallengeGenerated(cgId, kaId, chunkId, …)`.
  //   5. ASSERT-CORRECT (the fix): a node must NOT be able to predict its own
  //      challenge from public block data before committing — i.e. the predicted
  //      tuple must differ from / be unobservable relative to the actual draw.
  //      Today they are identical (the seed is fully recomputable), so the
  //      assertion fails → bug reproduced. The durable fix is commit–reveal or a
  //      VRF (the contract's own `_deriveChallengeSeed` NatSpec acknowledges this
  //      is "tracked separately").
  it.skip('GH #1091: challenge draw is not predictable from public block data (needs commit-reveal/VRF fixture)');

  // GH #614 — sweep allocates unused epoch funds into an already-closed epoch.
  //
  // Repro recipe (needs the PublishingConviction billing-window math fixture):
  //   1. Create a publishing-conviction account with committed TRAC and an
  //      `expiresAtEpoch` chosen so the billing period ENDS mid-epoch.
  //   2. Advance chronos epochs so the account's window boundary straddles an
  //      epoch boundary, and have a delegator/agent CLAIM the earlier epoch's
  //      allocation (closing it).
  //   3. Trigger `settle(accountId)` / the post-expiry final sweep.
  //   4. ASSERT-CORRECT (the fix): every wei of unused committed TRAC is swept
  //      into a CURRENT/future, still-claimable window. Today the prorated split
  //      can land a portion in the previous (already-closed, already-claimed)
  //      epoch, where regular claim mechanics can never recover it → assert the
  //      post-sweep claimable total equals the committed-minus-spent total
  //      (it falls short by the stranded slice today).
  it.skip('GH #614: post-expiry sweep leaves no funds stranded in a closed epoch (needs billing-window fixture)');
});
