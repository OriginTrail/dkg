/**
 * Protocol-level invariant assertions for V10 staking.
 *
 * These checks enforce properties that must hold REGARDLESS of which
 * test phase is running, what order operations executed in, or what
 * the prior state of the chain was. They are the DKG analogue of the
 * Aave / Compound / Uniswap invariant suites — see e.g. the Aave v3
 * invariant docs (`tests/invariants/docs/internal-docs.md`) and the
 * "Invariant Testing for DeFi" 2026 industry guide.
 *
 * Categories covered:
 *
 *   1. Conservation — value neither created nor destroyed.
 *      `assertPerNodeAggregation` — for every identity, the sum of raw
 *      stakes across the node's enumerated NFT positions must equal
 *      `getNodeStakeV10(identity)`. This catches mint/burn/transfer
 *      bugs where the per-node aggregate diverges from the bag of
 *      positions stored under that node. Also checks enumeration
 *      coherence: every enumerated tokenId must have raw > 0 (no
 *      stale entries from missed `_popNodeToken` calls).
 *
 *      `assertGlobalAggregation` — sum of per-node V10 stakes equals
 *      `getTotalStakeV10()`. Catches accounting drift where one node's
 *      mutation isn't mirrored in the global aggregate.
 *
 *   2. Solvency — protocol can meet obligations.
 *      `assertVaultSolvency` — `TRAC.balanceOf(CSS) >= totalStakeV10`.
 *      The CSS vault must always hold at least as much TRAC as the
 *      sum of staked principal it owes back to stakers. (Rewards
 *      and operator-fee escrow can ADD to the balance; nothing
 *      legitimate should DROP it below totalStakeV10.)
 *
 *   3. Cap enforcement — for every identity, getNodeStakeV10(id) must
 *      not exceed `parametersStorage.maximumStake()`. The negative
 *      `MaxStakeExceeded` revert test pins one direction; this
 *      invariant pins the dual direction (no successful path slipped
 *      a stake past the cap).
 *
 *   4. Position validity — every enumerated position must have
 *      `lockTier ∈ {0, 1, 3, 6, 12}` (the registered tier set in
 *      bootstrap). Catches storage corruption / tier-table tampering.
 *      Also: any non-zero `raw` MUST come with `multiplier18 > 0`
 *      (no silent reward starvation) and `position.identityId == id`
 *      (no enumeration cross-contamination).
 *
 * All identityId-array helpers reject empty input — a vacuous-pass
 * call site (forgetting to populate the bootstrap's identity set) is
 * almost always a test bug, not a "no nodes to check" scenario.
 *
 * These invariants are CHEAP — each is O(positions on a node) of
 * view-only RPC reads. They should be called at strategic phase
 * boundaries (after bulk staking, after a transfer, after withdraws,
 * after an epoch warp) so any divergence surfaces with the smallest
 * possible reproduction window.
 *
 * IMPORTANT: this module talks to a real Hardhat-backed devnet and
 * makes ZERO assumptions about which suite invokes it. Pass in the
 * already-instantiated contracts; the helper does not fabricate
 * addresses or short-circuit reads.
 */
import { expect } from 'vitest';
import { ethers } from 'ethers';

const VALID_LOCK_TIERS = new Set<bigint>([0n, 1n, 3n, 6n, 12n]);

interface Position {
  raw: bigint;
  lockTier: bigint;
  expiryTimestamp: bigint;
  identityId: bigint;
  cumulativeRewardsClaimed: bigint;
  multiplier18: bigint;
  lastClaimedEpoch: bigint;
  migrationEpoch: bigint;
}

interface InvariantContext {
  /** ConvictionStakingStorage contract (read-only is fine). MUST expose
   * `getPosition(uint256)`, `getNodeStakeV10(uint72)`,
   * `getTotalStakeV10()`, `getNodeTokens(uint72)`. */
  css: ethers.Contract;
  /** ParametersStorage contract; MUST expose `maximumStake()`. */
  params: ethers.Contract;
  /** ERC-20 TRAC token contract; MUST expose `balanceOf(address)`. */
  token: ethers.Contract;
  /** A short, free-form label that prefixes any failure message — use
   *  the calling phase / test name so failures in CI logs are
   *  immediately attributable. */
  label: string;
}

async function readPosition(css: ethers.Contract, tokenId: bigint): Promise<Position> {
  const p = await css.getPosition(tokenId);
  return {
    raw: BigInt(p.raw),
    lockTier: BigInt(p.lockTier),
    expiryTimestamp: BigInt(p.expiryTimestamp),
    identityId: BigInt(p.identityId),
    cumulativeRewardsClaimed: BigInt(p.cumulativeRewardsClaimed),
    multiplier18: BigInt(p.multiplier18),
    lastClaimedEpoch: BigInt(p.lastClaimedEpoch),
    migrationEpoch: BigInt(p.migrationEpoch),
  };
}

/**
 * Conservation invariant: for the given identity, the sum of raw
 * stakes across all NFT positions enumerated under that node must
 * equal `getNodeStakeV10(identityId)`.
 *
 * Also verifies enumeration coherence — `nodeTokens[identityId]` is
 * mutated via `_pushNodeToken` / `_popNodeToken` (swap-with-last);
 * a missed pop would leave a burnt tokenId in the array with
 * `raw == 0`, which would still SUM correctly (0 + everything = real
 * total) but would corrupt every consumer that iterates the array.
 * We therefore additionally assert that every enumerated tokenId has
 * `raw > 0`.
 *
 * Returns the per-token positions read so callers can chain further
 * checks without paying for a second enumeration pass.
 */
export async function assertPerNodeAggregation(
  ctx: InvariantContext,
  identityId: bigint,
): Promise<{ tokens: bigint[]; positions: Position[]; aggregate: bigint }> {
  // ethers v6 returns a Result that's array-like but not Array — copy
  // into a plain array so .map / .reduce are stable across versions.
  const rawTokens = await ctx.css.getNodeTokens(identityId);
  const tokens: bigint[] = Array.from(rawTokens, (t) => BigInt(t as bigint));
  const positions: Position[] = await Promise.all(
    tokens.map((t) => readPosition(ctx.css, t)),
  );
  const summed = positions.reduce((acc, p) => acc + p.raw, 0n);
  const onChain: bigint = BigInt(await ctx.css.getNodeStakeV10(identityId));
  expect(
    summed,
    `${ctx.label}: per-node aggregation invariant violated for identityId=${identityId}. ` +
      `sum(getPosition(token).raw across getNodeTokens) = ${summed}, but ` +
      `getNodeStakeV10(${identityId}) = ${onChain}. ` +
      `This is a Conservation violation — every mint/burn/transfer/redelegate path ` +
      `must keep these two views in sync. Diff: ${summed - onChain} wei.`,
  ).toBe(onChain);

  // Enumeration coherence — no stale (burnt) tokenIds should remain
  // in `nodeTokens[id]`. A burnt position has raw=0; the aggregate
  // sum check above would silently pass even with stale entries.
  // This catch is the thing that pins a `_popNodeToken` regression.
  const stale = positions
    .map((p, i) => ({ tokenId: tokens[i]!, position: p }))
    .filter((entry) => entry.position.raw === 0n);
  expect(
    stale.length,
    `${ctx.label}: per-node enumeration coherence violated for identityId=${identityId}. ` +
      `${stale.length} of ${tokens.length} enumerated tokens have raw=0 ` +
      `(stale = burnt tokens not popped from nodeTokens[id]): ` +
      `${stale.map((e) => e.tokenId.toString()).join(', ')}.`,
  ).toBe(0);

  return { tokens, positions, aggregate: summed };
}

/**
 * Conservation invariant: sum(getNodeStakeV10(id)) over the supplied
 * identities equals `getTotalStakeV10()`.
 *
 * Note: the supplied identity list MUST be exhaustive (i.e. cover
 * every identity that has a non-zero stake). Pass the bootstrap's
 * full identity set; passing a partial list means this check is
 * directional (we can only assert `<= total`). The helper takes a
 * `mode` argument so callers can be explicit about which they want.
 */
export async function assertGlobalAggregation(
  ctx: InvariantContext,
  identityIds: bigint[],
  mode: 'exhaustive' | 'partial',
): Promise<{ summed: bigint; total: bigint }> {
  // Defensive: an empty list silently passes the partial-mode <= check
  // and short-circuits the exhaustive check to "0 == total" which only
  // succeeds on a totally-empty chain. Either is almost certainly a
  // call-site bug (forgot to populate identityIds), not a real test.
  expect(
    identityIds.length,
    `${ctx.label}: assertGlobalAggregation called with empty identityIds — ` +
      `caller must pass the bootstrap's identity set, not an empty array. ` +
      `(An empty list passes the partial-mode check vacuously and would mask drift.)`,
  ).toBeGreaterThan(0);
  const perNode: bigint[] = await Promise.all(
    identityIds.map((id) => ctx.css.getNodeStakeV10(id).then(BigInt)),
  );
  const summed = perNode.reduce((acc, v) => acc + v, 0n);
  const total: bigint = BigInt(await ctx.css.getTotalStakeV10());
  if (mode === 'exhaustive') {
    expect(
      summed,
      `${ctx.label}: global aggregation invariant violated (exhaustive). ` +
        `sum(getNodeStakeV10) over [${identityIds.join(',')}] = ${summed}, ` +
        `but getTotalStakeV10() = ${total}. Diff: ${summed - total} wei.`,
    ).toBe(total);
  } else {
    expect(
      summed,
      `${ctx.label}: global aggregation invariant violated (partial). ` +
        `sum(getNodeStakeV10) over partial list [${identityIds.join(',')}] = ${summed}, ` +
        `but getTotalStakeV10() = ${total}. Sum cannot exceed total.`,
    ).toBeLessThanOrEqual(total);
  }
  return { summed, total };
}

/**
 * Solvency invariant: the CSS vault's TRAC balance must be at least
 * the total V10 stake. Rewards / operator-fee escrow can ADD to the
 * balance; nothing legitimate drops it below totalStakeV10.
 */
export async function assertVaultSolvency(ctx: InvariantContext): Promise<{
  vaultBalance: bigint;
  totalStake: bigint;
  surplus: bigint;
}> {
  const vaultAddress: string = await ctx.css.getAddress();
  const vaultBalance: bigint = BigInt(await ctx.token.balanceOf(vaultAddress));
  const totalStake: bigint = BigInt(await ctx.css.getTotalStakeV10());
  expect(
    vaultBalance,
    `${ctx.label}: vault solvency invariant violated. ` +
      `TRAC.balanceOf(CSS=${vaultAddress}) = ${vaultBalance}, ` +
      `but getTotalStakeV10() = ${totalStake}. ` +
      `Vault must hold at least totalStake; deficit = ${totalStake - vaultBalance} wei.`,
  ).toBeGreaterThanOrEqual(totalStake);
  return { vaultBalance, totalStake, surplus: vaultBalance - totalStake };
}

/**
 * Cap invariant: for every identity, getNodeStakeV10(id) ≤ maximumStake().
 * The dual of the `MaxStakeExceeded` revert test — pinning that no
 * successful path lets a node accumulate stake above the cap.
 */
export async function assertMaxStakeCap(
  ctx: InvariantContext,
  identityIds: bigint[],
): Promise<void> {
  expect(
    identityIds.length,
    `${ctx.label}: assertMaxStakeCap called with empty identityIds — ` +
      `caller must pass the bootstrap's identity set, not an empty array.`,
  ).toBeGreaterThan(0);
  const cap: bigint = BigInt(await ctx.params.maximumStake());
  expect(cap, `${ctx.label}: maximumStake() returned 0`).toBeGreaterThan(0n);
  for (const id of identityIds) {
    const stake: bigint = BigInt(await ctx.css.getNodeStakeV10(id));
    expect(
      stake,
      `${ctx.label}: max-stake cap invariant violated for identityId=${id}. ` +
        `getNodeStakeV10 = ${stake}, maximumStake = ${cap}. ` +
        `A successful staking path slipped a node past the cap.`,
    ).toBeLessThanOrEqual(cap);
  }
}

/**
 * Position-validity invariant: every enumerated position must have
 * lockTier ∈ {0, 1, 3, 6, 12}. Registered tier set is the bootstrap
 * default; if a tier table is mutated at runtime, the caller MUST pass
 * the updated set in `validTiers`. Otherwise the default is enforced.
 *
 * Bonus check: every position with raw > 0 must have multiplier18 > 0
 * (a position with raw stake but zero multiplier accrues no rewards
 * — would silently drain the staker).
 */
export async function assertPositionValidity(
  ctx: InvariantContext,
  identityIds: bigint[],
  validTiers?: Set<bigint>,
): Promise<void> {
  expect(
    identityIds.length,
    `${ctx.label}: assertPositionValidity called with empty identityIds — ` +
      `caller must pass the bootstrap's identity set, not an empty array.`,
  ).toBeGreaterThan(0);
  const tiers = validTiers ?? VALID_LOCK_TIERS;
  for (const id of identityIds) {
    // ethers v6 returns a Result that's array-like but not Array — copy
    // into a plain array so .map / iteration is stable across versions.
    // (Same fix that's in assertPerNodeAggregation; previously this
    //  call site relied on the Result's `.map`, which is not part of
    //  ethers' stable contract.)
    const rawTokens = await ctx.css.getNodeTokens(id);
    const tokens: bigint[] = Array.from(rawTokens, (t) => BigInt(t as bigint));
    for (const tokenId of tokens) {
      const p = await readPosition(ctx.css, tokenId);
      expect(
        tiers.has(p.lockTier),
        `${ctx.label}: position validity violated. ` +
          `tokenId=${tokenId} on identityId=${id} has lockTier=${p.lockTier}, ` +
          `expected one of {${[...tiers].sort((a, b) => Number(a - b)).join(',')}}.`,
      ).toBe(true);
      if (p.raw > 0n) {
        expect(
          p.multiplier18,
          `${ctx.label}: position validity violated. ` +
            `tokenId=${tokenId} on identityId=${id} has raw=${p.raw} ` +
            `but multiplier18=0 — would silently accrue zero rewards.`,
        ).toBeGreaterThan(0n);
        expect(
          p.identityId,
          `${ctx.label}: position validity violated. ` +
            `tokenId=${tokenId} enumerated under identityId=${id}, but its ` +
            `position.identityId=${p.identityId}. Enumeration corruption.`,
        ).toBe(id);
      }
    }
  }
}

/**
 * Convenience composite: runs all four invariant classes in one call.
 * Use at major phase boundaries; for hot loops prefer single-invariant
 * calls to keep RPC traffic minimal.
 */
export async function assertAllStakingInvariants(
  ctx: InvariantContext,
  identityIds: bigint[],
  mode: 'exhaustive' | 'partial' = 'exhaustive',
): Promise<void> {
  await assertGlobalAggregation(ctx, identityIds, mode);
  for (const id of identityIds) {
    await assertPerNodeAggregation(ctx, id);
  }
  await assertVaultSolvency(ctx);
  await assertMaxStakeCap(ctx, identityIds);
  await assertPositionValidity(ctx, identityIds);
}
