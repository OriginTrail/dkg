# RFC: Scalable value-weighted Context-Graph sampling for RandomSampling

- **Status:** Draft (rev 2 — review-hardened) / for review
- **Area:** `packages/evm-module` — `RandomSampling.sol`, `RandomSamplingStorage.sol`, `ContextGraphValueStorage.sol`
- **Target:** support **5k–100k+** Context Graphs (CGs) on mainnet
- **Author:** (draft)

> **Rev 2 (review).** Three correctness fixes folded in before implementation:
> 1. The retry-exclusion draw now **subtracts excluded leaves during the Fenwick descent** — the
>    previous "advance to the next nonzero leaf" wording was *not* renormalization (it dumps an
>    excluded CG's mass onto its neighbor and starves the tail) and would fail Test #2.
> 2. The BIT uses a **fixed power-of-two capacity**, not a growing `bitSize` — a mapping-backed
>    Fenwick whose logical size grows silently corrupts the internal node at every 2^k boundary.
> 3. `cgWeight > 0 ⇒ CG active` is now an enforced **invariant** (was Open Decision #3), because
>    `_isCGEligible` already gates on `isContextGraphActive`.
>
> Fixes (1) and (2) were both *silent* — consistent `bitTotal`, passing functional tests, wrong
> only in the sampling distribution; they are caught only by distribution/property tests. Also
> tightened: settle-on-miss scope, preview/draw divergence, a fairness tolerance, and gas-aware
> migration batching. Line refs verified against `release/rc18`.

---

## TL;DR

RandomSampling picks which Context Graph to challenge by a **value-weighted random draw** — CGs with more (active) TRAC spend should be challenged more. Today that draw does **two full linear scans over every CG ever created**, and each per-CG weight read **replays every epoch since that CG was last touched**. So per-challenge cost is roughly `O(retries · 2 · N · D)` where `N` = total CGs and `D` = epochs of un-applied history. At 5k–100k CGs this blows past the block gas limit; it is the one mainnet scaling cliff that needs a contract change, not a config tweak.

**Proposal, in two moves:**

1. **Replace the linear scan with a Fenwick/Binary-Indexed-Tree (BIT) index over CG ids** → the weighted draw becomes an `O(log)` prefix search (~21 reads against a fixed-capacity tree, instead of 100k+ reads — and constant in the live CG count).
2. **Replace the exact, calendar-synchronized weight bookkeeping with lazy settlement.** We can do this safely because **the draw already filters expired knowledge assets after it picks a CG** — so a CG's weight only needs to be *approximately* right. We never run a per-epoch sweep; weights are reconciled opportunistically (on the next spend, on a wasted draw, or by a cheap keeper).

Result: `O(log N)` reads and writes, **no per-epoch roll, no draw-gating, no clustered-expiry gas cliff.** The only heavy step is a one-time, batched migration to seed the tree. The existing `cgValueDiff` ledger stays as the source of truth; the BIT is a fast index kept loosely in sync with it.

---

## Problem

### How selection works today

`RandomSampling._pickWeightedChallenge` (`RandomSampling.sol:576-679`) draws a CG like this:

1. **Scan 1 — total:** loop `i = 1..cgCount` (`cgCount = getLatestContextGraphId()`), sum `getCGValueAtEpoch(i, currentEpoch)` for every eligible CG into `adjustedTotal`.
2. **Scan 2 — straddle pick:** draw `r = seed % adjustedTotal`, loop `i = 1..cgCount` again accumulating the running weight, and pick the first CG where `running > r` (`RandomSampling.sol:618`, strict `>`).
3. **KA + leaf pick:** inside the chosen CG, pick a KA (up to `MAX_KA_RETRIES = 10`) and a leaf; an outer loop (up to `MAX_CG_RETRIES = 5`) excludes a CG that has no challengeable KA and re-draws over the remaining set.

`createChallenge` (`RandomSampling.sol:205`) is **state-changing** (it calls `setNodeChallenge`, `:230`), which matters below.

### The two unbounded cost axes

- **`N` = `cgCount`.** `getLatestContextGraphId()` returns the monotonic `_contextGraphCounter` (`ContextGraphStorage.sol:58,613`), incremented on every CG creation (`:236`) and **never decremented**. Both scans run `1..cgCount`.
- **`D` = `currentEpoch − cgLastFinalizedEpoch[cg]`.** `_pickWeightedChallenge` is `view`, so it never finalizes; every weight read takes the simulation path `_simulateCGValueFinalization` (`ContextGraphValueStorage.sol:279-303`), which **replays one cold `SLOAD` per epoch** since the CG was last finalized. Dormant CGs accumulate a long tail.

Leading-order cost ≈ `R · 2 · N · (1 + (1+D))` SLOADs, `R ≤ 5`. The contract docstring's "~2.1M gas at 1K CGs" silently assumes `D = 0`, which never holds. **A single scan of 100k cold SLOADs alone is ≈ 210M gas** — versus a block limit in the tens of millions. The mechanism is dead well before 100k; realistic ceiling today is ~hundreds of CGs once `D` grows.

### How a CG's weight is defined today

When a KA is published to a CG with value `V` over `lifetime` epochs, `ContextGraphValueStorage.addCGValueForEpochRange` (`:110`) records a per-epoch rate `perEpoch = V / lifetime` as two ledger entries:

```
cgValueDiff[cgId][startEpoch]            += perEpoch     // :131  weight starts
cgValueDiff[cgId][startEpoch + lifetime] -= perEpoch     // :132  weight ends (expiry)
```

A CG's weight in epoch `E` is the running sum of its `cgValueDiff` entries up to `E`. **Weights are never rewritten per epoch** — they change only when a start (`+`) or expiry (`−`) entry's epoch arrives. Expiry is implicit ("No cleanup, no keeper", `ContextGraphValueStorage.sol:22-23`); the `−perEpoch` just sits in the ledger until someone sums past it — which is the `D` replay cost.

### Goal

Challenge CGs in proportion to their **active TRAC spend** (more spend → more challenges), at 100k+ CGs, within block gas, without changing reward fairness.

### Constraints / facts that shape the design

- `deactivateContextGraph` (`ContextGraphStorage.sol:363`) exists but has **no callers anywhere** in the contracts/SDK — the CG set is effectively **append-only** today. There is no reactivation function.
- After the draw picks a CG, the **KA pick filters expired KAs**: `getEndEpoch(candidate) < currentEpoch → skip` (`RandomSampling.sol:648`). A challenge therefore **cannot land on expired data regardless of whether the CG's weight is current.** This is the key correctness backstop the simplification relies on.
- `RandomSampling` / `RandomSamplingStorage` are **non-upgradeable, fresh-deploy** contracts; redeploys use `clearOutstandingChallenges()` to avoid challenge-struct mismatch.
- Write:read ratio is heavily read-dominated (a handful of spends per epoch vs many challenges, each doing `2·N` weight reads) — so paying `O(log N)` on writes to make reads `O(log N)` is a clear win.

---

## Solution

### Core idea

Maintain a **Fenwick/BIT over CG ids**, where `cgWeight[cg]` is that CG's (approximate) current-epoch weight, plus a cached `bitTotal`. The weighted draw becomes:

```
r   = seed % bitTotal                 // O(1)
cg  = bitPrefixSearch(r)              // O(log N): smallest cg with prefixSum(cg) > r
```

This eliminates **both** scans. `prefixSum`/search touch `log2(BIT_CAPACITY)` tree nodes (~21 for a ~2M-id capacity), independent of the live CG count. This is the no-exclusion happy path; the retry path uses the exclusion-aware variant in *Exact-exclusion fidelity* below.

### The simplification: approximate weights via lazy settlement

The painful machinery in a naive Fenwick port is keeping leaves exactly in sync with the calendar (a per-epoch "roll" that applies due weight changes, plus gating so a draw never reads a half-rolled tree). We avoid all of it by letting leaves be **approximately** right and reconciling lazily:

- **Correctness is unconditional and does not depend on weight freshness.** An over-drawn CG cannot produce a bad challenge — the KA filter (`:648`) drops expired KAs and the retry loop moves on. So weight staleness only ever affects *sampling fairness*, never proof validity.
- **Staleness is bounded and bidirectional.** Between settlements a leaf can drift two ways: *over*-stated when a paid window expires (an un-applied `−` diff), and *under*-stated when future-dated value activates (an un-applied `+` diff, e.g. from `extend` or a scheduled start). The common case — publish-now, `startEpoch == currentEpoch` — is applied immediately by settle-on-spend, so steady-state drift is small.
- We reconcile a leaf to the ledger's true value **only when we already touch the CG**:
  - **on its next spend** (settle-on-spend) — applies immediate value at once;
  - **on a wasted draw** (settle-on-miss) — heals *over*-statement: a drawn-but-dead CG gets settled down so it stops being over-drawn;
  - **via a permissionless keeper** (`settleMany`) — the backstop for *under*-statement (newly-activated scheduled value the draw won't otherwise touch) and for fully-dormant CGs.

The `cgValueDiff` ledger remains the **source of truth**; the BIT is a fast, eventually-consistent **index** over it.

### Why this is enough for the stated goal

Sampling is a heuristic, not an accounting invariant. "More TRAC → bigger leaf → drawn more" holds continuously; the only inaccuracy is that a CG whose paid windows lapsed may keep a slightly-too-large leaf until it's next settled — which costs at most a wasted retry, never a wrong challenge.

---

## Diagram

```
                    SOURCE OF TRUTH                         FAST INDEX (approximate)
        ┌───────────────────────────────────┐      ┌───────────────────────────────────┐
        │ ContextGraphValueStorage           │      │ CGWeightTree (new)                 │
        │   cgValueDiff[cg][epoch]  (± rate)  │      │   bit[1..CAP] (Fenwick, fixed cap) │
        │   cgLastFinalizedEpoch[cg]          │      │   cgWeight[cg] + bitTotal          │
        │   getCGValueAtEpoch(cg, E) = truth  │      │   cgSettledEpoch[cg] (leaf as-of)  │
        └───────────────────────────────────┘      └───────────────────────────────────┘
                     ▲     ▲                                  ▲            │
        settle(cg):  │     │ reconcile leaf := truth          │ bitUpdate  │ bitPrefixSearch
        truth-cached │     └──────────────────────────────────┘            ▼
                     │
   WRITE PATH (rare) │                              READ PATH (hot, every challenge)
   publish/extend ───┘                              createChallenge:
     addCGValueForEpochRange(cg, ...)                 r  = seed % bitTotal           (O(1))
     settle(cg)        // reconcile leaf to new truth  cg = bitPrefixSearch(r)        (O(log N))
                                                       (kc, leaf) = pickKC(cg)        // filters expired (:648)
                                                       on miss → settle(cg); retry    // self-heals stale leaf

   BACKGROUND (optional)                             MIGRATION (one-time, batched)
   keeper.settleMany([cg...])  // dormant cleanup     for cg in 1..counter (batched, backfillLocked):
                                                        finalizeCGValueUpTo(cg, currentEpoch-1)
                                                        cgWeight[cg] := getCGValueAtEpoch(cg, E)
                                                        _bitUpdate(cg, +cgWeight[cg])  // tree+total
                                                      assert bitTotal == Σ leaves   // unlock
```

---

## Detailed design

### New storage (`CGWeightTreeStorage`, or fields added to a fresh `RandomSamplingStorage`)

```solidity
// Fenwick/BIT over CG ids 1..BIT_CAPACITY (standard BIT layout). bit[i] holds a partial range sum.
//
// CAPACITY IS FIXED AT DEPLOY — never grow it. A mapping-backed Fenwick whose logical size GROWS is
// silently WRONG: when the live id count crosses a 2^k boundary, the newly-relevant internal node
// bit[2^k] must cover (0, 2^k] but never received the point updates written to lower leaves before it
// "existed", so every prefixSum past that boundary is permanently short — no revert, bitTotal still
// self-consistent, only the draw distribution is wrong. (Worked example: size 4, update cgWeight[2] →
// touches bit[2],bit[4],stops; grow to 8 → bit[8] covers (0,8] but is missing cgWeight[2] forever.)
// Fixing capacity up front makes every leaf's update path reach all its ancestors from the start.
// The mapping is sparse, so unused leaves cost nothing; op depth is log2(BIT_CAPACITY) (~21 for a
// ~2M cap) regardless of the live count.
uint256 public immutable BIT_CAPACITY;             // power-of-two ≥ max-ever CG id; set in constructor
mapping(uint256 => uint256) internal bit;          // weights are non-negative (perEpoch >= 0)
mapping(uint256 => uint256) public  cgWeight;      // explicit per-CG weight (the Fenwick leaf) — O(1) reads
uint256 public bitTotal;                            // cached Σ cgWeight == prefixSum(BIT_CAPACITY)
mapping(uint256 => uint256) public cgSettledEpoch;  // epoch the leaf was last reconciled to
bool    public backfillLocked;                       // draws disabled until migration seeding completes
```

Weights are non-negative integers (`perEpoch = V / lifetime ≥ 0`), so the BIT stores `uint256` and we reason about deltas as signed at the call site. Note `perEpoch` is **integer division** (`ContextGraphValueStorage.sol:128`): sub-`lifetime` value truncates toward zero, so a CG can legitimately carry a `0` leaf — fine, zero leaves are never drawn. `BIT_CAPACITY` is `immutable` (chosen at deploy, see Migration) with a guard that makes `cgId ≥ BIT_CAPACITY` unreachable.

### Primitive operations

```solidity
// Standard Fenwick point update by a signed delta; keeps bitTotal in sync.
function _bitUpdate(uint256 i, int256 delta) internal {
    if (delta == 0) return;
    // REAL guard, not just "size capacity big enough": if i >= BIT_CAPACITY the loop below never
    // runs, yet bitTotal is still mutated → invariant 1 silently broken. i == 0 would loop forever
    // (lowbit(0) == 0). Defense-in-depth vs the monotonic CG counter this contract doesn't own.
    require(i != 0 && i < BIT_CAPACITY, CgIdOutOfBitCapacity());
    // Bound is the FIXED capacity, not a live counter (see storage note). A growing bound here is
    // the silent-corruption bug: an early leaf's update path must reach EVERY ancestor up to
    // capacity — including 2^k nodes that only start mattering once ids grow into them.
    for (uint256 x = i; x <= BIT_CAPACITY; x += (x & (~x + 1))) {
        bit[x] = uint256(int256(bit[x]) + delta);   // never underflows: see invariant below
    }
    bitTotal = uint256(int256(bitTotal) + delta);
}

// Smallest index whose prefix sum is STRICTLY greater than r (mirrors current `running > r`, :618).
// Capacity is a fixed power of two, so the top step is BIT_CAPACITY — no _highBit() needed.
// Caller guarantees r < workingTotal. (Exclusion-aware variant below for the retry path.)
function _bitFindStrictGt(uint256 r) internal view returns (uint256 idx) {
    uint256 cum = 0;
    idx = 0;
    for (uint256 step = BIT_CAPACITY; step != 0; step >>= 1) {
        uint256 next = idx + step;
        if (next <= BIT_CAPACITY && cum + bit[next] <= r) {   // <= r ⇒ we still need to go right
            idx = next;
            cum += bit[next];
        }
    }
    idx += 1;   // first index that pushes the running sum strictly past r
}
```

> **Boundary parity:** the `cum + bit[next] <= r` / `idx += 1` form reproduces the current strict-`>` straddle (`running > r`) exactly, so a fresh-attempt draw is distribution-identical to today given the same seed and weights.

### Settlement (the only place truth meets the index)

```solidity
// Reconcile a CG's leaf to its true current-epoch weight, and finalize the ledger
// so subsequent reads of this CG are O(1) (D collapses to 0 for it).
// `public` / permissionless by design (settle-on-miss, keeper). The internal
// finalizeCGValueUpTo is onlyContracts, but the call originates from RandomSampling
// (a Hub contract), so it passes; getCGValueAtEpoch is public view.
function settle(uint256 cg) public {
    uint256 currentEpoch = chronos.getCurrentEpoch();
    if (currentEpoch > 0) contextGraphValueStorage.finalizeCGValueUpTo(cg, currentEpoch - 1);
    uint256 truth  = contextGraphValueStorage.getCGValueAtEpoch(cg, currentEpoch); // O(1) after finalize
    uint256 cached = cgWeight[cg];                              // explicit O(1) leaf
    if (truth != cached) {
        _bitUpdate(cg, int256(truth) - int256(cached));    // moves tree + bitTotal
        cgWeight[cg] = truth;                                  // keep explicit leaf in lockstep
    }
    cgSettledEpoch[cg] = currentEpoch;
}
```

We keep an explicit `mapping(uint256 => uint256) cgWeight` (declared in storage above) so single-leaf reads are `O(1)`: both `settle` and the exclusion math read `cgWeight[cg]` directly instead of computing `prefixSum(cg) − prefixSum(cg-1)`. One extra slot per CG — worth it for clarity and to keep the exclusion subtraction cheap. Every `_bitUpdate(cg, …)` is paired with a `cgWeight[cg]` write so the two never diverge.

### Hooking the existing flows

- **On spend** (every caller of `addCGValueForEpochRange` — publish, update, extend): after the ledger write, call `settle(cg)`. Note `addCGValueForEpochRange` **already** finalizes the CG to `currentEpoch-1` (`ContextGraphValueStorage.sol:138`), so settle's `finalizeCGValueUpTo` is a no-op on this path and the real work is the `_bitUpdate` to the new true value. Because the ledger nets additive deltas (extend adds positive diffs; the original expiry diff is untouched), `settle` picks up the new value with no per-KA tracking. `O(log)` on the rare write path.
- **In `createChallenge`** (read path): replace the twin scan with the BIT draw; keep the existing KA/leaf pick and retry loop. On a miss, call `settle(cg)` before excluding it. **What settle-on-miss does and does *not* heal:**
  - ✅ **Expiry over-statement** — lapsed paid windows. `settle` reconciles the leaf to `getCGValueAtEpoch`, which is `0` once all windows expired, so the CG stops being over-drawn ("self-healing").
  - ❌ **Positive value, no challengeable KA** — every KA expired, or curated KAs with `catalogLeafCount == 0` (`RandomSampling.sol:649`). Truth is still positive, so `settle` leaves the leaf positive; the CG can be drawn-and-wasted again on a later challenge. **This is not a regression** — today's twin-scan re-picks and re-excludes such a CG every challenge too — but the leaf does not zero out.
  - ❌ **Under-statement** — future-dated `+` (extend / scheduled start) not yet active. A CG that *gained* weight is not the one drawn-and-missed, so settle-on-miss never fires for it; it relies on settle-on-spend or the keeper.
- **Keeper (optional):** `settleMany(uint256[] cgIds)` — permissionless batch `settle`, for dormant CGs and for the under-statement case the draw won't otherwise touch. Whether it's needed is the main open decision (below) and depends on Phase-0 measurement.

### Exact-exclusion fidelity (the retry renormalization)

Today the outer retry loop excludes an exhausted CG and **renormalizes over the remaining set** (it defends against a high-weight CG with no challengeable KAs starving the draw). We must reproduce that renormalized distribution **exactly**.

**Do not "advance to the next nonzero leaf" after landing on an excluded CG — that is not renormalization.** It dumps the excluded CG's probability mass onto its right-neighbor and can starve everything past the cut. Concretely: four equal-weight CGs (10 each), exclude CG2, draw `r ∈ [0,30)` over the full tree → `r∈[10,20)` lands CG2 → "advance" gives CG3, and `r∈[20,30)` also gives CG3, so the result is `CG1=⅓, CG3=⅔, CG4=0` instead of `⅓` each. Wrong distribution, and it fails Test #2.

The correct move: draw over `workingTotal = bitTotal − Σ cgWeight[excluded]` and **subtract each excluded leaf's contribution during the Fenwick descent**, so the excluded mass is removed from exactly the nodes that cover it. The excluded set is in-memory and ≤ `MAX_CG_RETRIES`, so it's a cheap per-step deduction:

```solidity
// Renormalized weighted draw over (eligible CGs \ excluded), distribution-identical to today's
// re-summed adjustedTotal. O(MAX_CG_RETRIES · log).  r in [0, workingTotal).
function _bitFindStrictGtExcluding(
    uint256 r,
    uint256[] memory excluded,
    uint8 excludedCount
) internal view returns (uint256 idx) {
    uint256 cum = 0;
    idx = 0;
    for (uint256 step = BIT_CAPACITY; step != 0; step >>= 1) {
        uint256 next = idx + step;
        if (next > BIT_CAPACITY) continue;
        // bit[next] covers ids (idx, next]; net out any excluded leaves in that span.
        uint256 nodeSum = bit[next] - _excludedInRange(idx + 1, next, excluded, excludedCount);
        if (cum + nodeSum <= r) {        // <= r ⇒ still go right (preserves strict-> boundary, :618)
            idx = next;
            cum += nodeSum;
        }
    }
    idx += 1;
    // idx can never be an excluded CG: its leaf was netted out of every enclosing nodeSum,
    // so the running prefix cannot straddle r at an excluded index.
}

// Σ cgWeight[e] for excluded e with lo <= e <= hi. <= MAX_CG_RETRIES iterations.
function _excludedInRange(uint256 lo, uint256 hi, uint256[] memory excluded, uint8 n)
    internal view returns (uint256 s)
{
    for (uint8 j = 0; j < n; j++) {
        uint256 e = excluded[j];
        if (e >= lo && e <= hi) s += cgWeight[e];
    }
}
```

Driver (mirrors today's `exhaustedCgs` loop, `RandomSampling.sol:590-672`):

```solidity
uint256[] memory excluded = new uint256[](MAX_CG_RETRIES);
uint8 excludedCount = 0;
for (uint8 cgAttempt = 0; cgAttempt < MAX_CG_RETRIES; cgAttempt++) {
    // Recompute each attempt: a prior settle() may have moved bitTotal, and excluded leaves are
    // netted at their CURRENT value — so there is no double-counting with settle's tree mutation.
    uint256 workingTotal = bitTotal - _excludedSum(excluded, excludedCount);
    if (workingTotal == 0) {
        if (cgAttempt == 0) revert NoEligibleContextGraph();   // same semantics as today (:602-608)
        revert NoEligibleKnowledgeAsset();
    }
    uint256 r  = uint256(cgSeed) % workingTotal;
    uint256 cg = _bitFindStrictGtExcluding(r, excluded, excludedCount);
    // ... pick KA inside cg (unchanged: :626-667); on success return ...
    // on miss:
    settle(cg);                                  // heals expiry over-statement (may drop cgWeight[cg] & bitTotal)
    excluded[excludedCount++] = cg;              // exclude for the rest of THIS challenge regardless
    cgSeed = keccak256(abi.encodePacked(cgSeed, "cgRetry", cgAttempt));
}
```

`_excludedSum` is the same loop as `_excludedInRange` without the range bound. Because `workingTotal` and the in-descent deduction both read the **current** `cgWeight[e]`, the math stays consistent even after `settle` has already reduced an excluded leaf (an expired CG settled to 0 contributes 0 to both — no double subtraction). No temp-mutation of shared storage, so no restore-bug risk.

> **Don't "harden" the subtraction.** `bit[next] − _excludedInRange(idx+1, next, …)` cannot underflow: by invariant 1, `bit[next]` equals the sum of `cgWeight` over exactly `(idx, next]`, and the excluded leaves in that span are a subset of that sum. A defensive `max(0, …)` or saturating-sub here would silently *mask* a real invariant break instead — leave it as a plain subtraction so Test #3 catches any violation.

> **Boundary & parity.** The `<= r` / `idx += 1` form preserves the strict-`>` straddle (`running > r`, :618). With an empty excluded set this is bit-identical to today's attempt-1 draw given the same seed and weights. The `view` helper `previewChallengeForSeed` uses the same search — **caveat:** a `view` cannot settle-on-miss, so under stale leaves preview may diverge from the state-changing draw (see Security).

### Invariants

1. **Non-negativity & total consistency:** every leaf ≥ 0 and `bitTotal == Σ leaves`. Held by: leaves seeded ≥ 0; spends add ≥ 0; `settle` sets leaf to `getCGValueAtEpoch ≥ 0`; `_bitUpdate` only moves a leaf toward its non-negative truth. **Cross-check (free oracle):** when all CGs are active, `bitTotal` should also equal the ledger's finalized **global** total (`totalValueCumulative`, fed by `totalValueDiff` at `ContextGraphValueStorage.sol:134-135`) up to lazy-settle drift — assert it at migration and optionally at runtime.
2. **Eligibility ⇔ weight (must be enforced).** A CG contributes to the draw **iff** `cgWeight[cg] > 0`, but the real eligibility gate is `_isCGEligible == isContextGraphActive` (`RandomSampling.sol:711`). These must not drift apart. Today they can't — `deactivateContextGraph` (`ContextGraphStorage.sol:363`) has **no callers**, so every created CG is permanently active (`active = true` at `:247`) and a weight-only tree is sound. To keep it sound the contract MUST maintain **`cgWeight[cg] > 0 ⇒ CG active`**: if deactivation is ever wired up, its first action is `settle(cg); _bitUpdate(cg, -cgWeight[cg]); cgWeight[cg] = 0` (plus a ≥2-active-CG floor), so an inactive CG always has a zero leaf and is never drawn. Add a guard/test asserting the active flag never flips without zeroing the leaf. *(Promoted from Open Decision #3 because `isContextGraphActive` is already the live gate, not a future feature.)*
3. **Bounded bidirectional drift (fairness only).** Between settlements a leaf may be over-stated (un-applied expiry `−`) or under-stated (un-applied future-dated `+`). Over-statement from expiry is corrected by settle-on-miss; under-statement (and the positive-value-but-unchallengeable case) relies on settle-on-spend or the keeper — see *Hooking* for exact scope. Drift bounds sampling skew, **not** correctness.
4. **No bad challenge from staleness — unconditional:** guaranteed by the KA filter (`:648`) regardless of leaf freshness or drift direction.

> **Freshness vs simplicity.** Over-statement self-heals for free; under-statement is the case the keeper exists to bound. If low-latency fairness for scheduled/extended value matters more than minimal machinery, add an optional **epoch-due index** — `epochDueCgs[E]` populated whenever `addCGValueForEpochRange` writes a diff at epoch `E`, settled in bulk on the first challenge of epoch `E` (or by the keeper). This is a *churn-sized* settle (`O(diffs-due-this-epoch · log N)`), not the `O(N)` synchronized roll, and needs no draw-gating because correctness never depends on it. Recommended only if measurements show under-statement lag matters; otherwise the keeper suffices.

### Edge cases

- `workingTotal == 0` (no eligible/weighted CG): revert with today's semantics — `NoEligibleContextGraph` on attempt 0, `NoEligibleKnowledgeAsset` once all eligible CGs are excluded (`RandomSampling.sol:602-608`).
- Single CG / single nonzero leaf: prefix search returns it; fine.
- Zero-weight leaf: prefix sum is flat across it, so the search never lands on it — naturally skipped (no eligibility SLOAD needed).
- **Expired** CG with stale nonzero leaf: drawn occasionally → KA pick finds nothing live → `settle` reconciles the leaf to truth, which is **0 once all paid windows have lapsed** → excluded; next time its leaf is 0 and it's skipped.
- CG with **positive** ledger value but no challengeable KA (all KAs expired, or curated with `catalogLeafCount == 0`, `:649`): drawn → missed → `settle` leaves the leaf **positive** → excluded for this challenge but drawable again later. Same as today's twin-scan; bounded by `MAX_CG_RETRIES` per challenge. Not healed by settle (see *Hooking*).
- New CG creation: **no tree growth needed.** Capacity is fixed at deploy and `bit`/`cgWeight` are sparse mappings, so a new id's weight is implicitly 0 until its first spend — no `createContextGraph → BIT` hook. Defensive guard: revert if a CG id ever reaches `BIT_CAPACITY` (size capacity to make this unreachable).

### Gas & storage

`log` below is `log2(BIT_CAPACITY)` ≈ **21** (fixed) — *not* `log2(N)`. Cost does not grow with the live CG count.

| Operation | Cost | Frequency |
|---|---|---|
| Draw, no exclusions (`createChallenge`) | `O(log)` ≈ 21 node reads + KA/leaf pick | hot — every challenge |
| Draw with `k` exclusions | `O(k · log)` (each descent step deducts ≤ `k` excluded leaves) | retry path only |
| Settle-on-miss (per missed CG) | `O(log)` + `O(D_cg)` finalize the **first** time a dormant CG is touched, then `O(log)` | up to `MAX_CG_RETRIES`× per challenge |
| Spend update (`settle` + `_bitUpdate`) | `O(log)` (`finalizeCGValueUpTo` already done by the spend, `:138`) | rare — per publish/extend |
| Keeper `settleMany(k)` | `O(k · log)` | optional, batched |
| Migration seed | `O(N)` SSTOREs, **batched, gas-aware** | one-time |

**Worst-case challenge gas is now variable and partly attacker-influenced.** A clustered-expiry cohort can force up to `MAX_CG_RETRIES` (≤5) settle-on-miss calls in one `createChallenge`, each paying `O(D_cg)` the *first* time it finalizes a long-dormant CG. It is bounded (≤5 freshly-encountered CGs) and self-amortizing (each settled CG is `O(log)` thereafter), but the prologue should budget for it — if Phase-0 `D` is large, consider capping first-touch finalize work per challenge (defer the rest to the keeper). There is still **no synchronized per-epoch roll**, so no block-gas cliff.

Storage: `bit` + explicit `cgWeight` + `cgSettledEpoch` ≈ `3·N` *populated* slots — mapping-sparse, so `BIT_CAPACITY` does not pre-allocate. Reads drop from hundreds-of-millions of gas to tens of thousands.

### Security

- **Seed grindability is unchanged.** The draw is still seeded from the same source; commit-reveal/VRF is explicitly out of V10 scope. This RFC neither improves nor worsens it.
- **Staleness can't break proofs** (invariant 4).
- **Clustered-expiry attack:** an adversary publishing many KAs with identical lifetimes makes a cohort expire together. Under lazy settlement this leaves many over-stated leaves; the draw may waste retries landing on them, each healed by settle-on-miss (or pre-empted by the keeper). Bounded by `MAX_CG_RETRIES` per challenge with **no synchronized roll and therefore no block-gas cliff** — strictly better than the "exact roll + draw-gating" alternative (see the worst-case gas note above).
- **Preview vs. real draw can diverge.** `previewChallengeForSeed` is `view` and **cannot** settle-on-miss, so under stale (over-stated) leaves it may predict a different CG than the state-changing `createChallenge` (which self-heals and re-draws). Today the two agree (both `view`-sum the same source). Identify every consumer of preview before shipping and decide whether best-effort prediction is acceptable; if exactness is required, document that preview is approximate under drift.
- **Migration safety / challenge pause:** draws are disabled (`backfillLocked`) until seeding completes and the `bitTotal == Σ leaves` check (plus the global-total cross-check) passes. **This pauses all challenges for the whole multi-tx seeding window** — bound the window (pre-compute leaves off-chain, batch aggressively) and communicate the outage; for a fresh redeploy it overlaps the unavoidable `clearOutstandingChallenges()` transition.

### Testing

1. **Distribution parity (settled state):** BIT draw vs current twin-scan over the same seeds and weights, with fully-settled leaves — attempt-1 must be bit-identical (validates the strict-`>` boundary). Under drift the distributions diverge by design; parity is asserted only when settled.
2. **Renormalization equivalence (corrected exclusion path):** for randomized weight vectors and excluded sets of size `1..MAX_CG_RETRIES`, the subtract-during-descent draw must match the analytic renormalized distribution. **Include the regression the old "advance to next nonzero" wording failed:** N equal-weight CGs, exclude one, assert every survivor is equiprobable (no neighbor double-count, no starved tail).
3. **Fixed-capacity Fenwick correctness:** property test that draws/prefix sums stay correct as ids are added **across multiple 2^k boundaries** (the growth-corruption regression) — seed leaves below a 2^k index, add ids above it, assert `bitTotal == Σ leaves` and prefix sums match a brute-force oracle.
4. **Stale-leaf self-heal (expiry only):** seed an over-stated leaf from a lapsed window, draw, assert settle-on-miss reconciles it to 0 and excludes it. **Companion negative test:** a CG with positive value but no challengeable KA stays positive after settle (documents the non-healing case).
5. **Eligibility ⇔ weight invariant:** assert no path flips `active` without zeroing the leaf; if a deactivation hook exists, assert an inactive CG is never drawn.
6. **Fairness tolerance (drift regime):** with a realistic publish/expire/extend workload and settle-on-miss only, assert observed draw frequencies stay within the agreed tolerance of true active weight (define the tolerance — see Open Decisions).
7. **Preview vs. draw:** agree when settled; characterize divergence under stale leaves.
8. **Edge cases:** zero working total, single CG, all-expired, capacity guard.
9. **Migration:** seed in gas-aware batches, assert `bitTotal == Σ leaves` and the global-total cross-check, draws reverted while `backfillLocked`.
10. **Gas benchmarks** at `N = 1k / 10k / 100k` for draw (0 and 5 exclusions), spend, settle (cold/warm `D`), and a representative migration batch.

---

## Migration runbook (one-time)

1. Deploy fresh `RandomSampling` + `RandomSamplingStorage` (+ `CGWeightTreeStorage`) with `backfillLocked = true` and **`BIT_CAPACITY` set to a power of two comfortably above the current `getLatestContextGraphId()`** (it's `immutable`; because this is a fresh-deploy contract, capacity is re-chosen at each redeploy). The capacity guard must make `cgId ≥ BIT_CAPACITY` unreachable.
2. **Pre-finalize + seed in batches** (permissioned keeper): for `cg` in `1..counter`, `finalizeCGValueUpTo(cg, currentEpoch-1)` then set `cgWeight[cg] = getCGValueAtEpoch(cg, currentEpoch)` and `_bitUpdate(cg, +cgWeight[cg])`. **Batch by gas, not by count** — `finalizeCGValueUpTo` is `O(D_cg)` and dormant CGs cost far more, so a fixed per-tx CG *count* can blow the block limit; size each tx against a gas budget (or pre-compute leaves off-chain and seed with cheap writes). Keep the pause window short.
3. **Validation tx:** assert `bitTotal == Σ leaves`, cross-check against the ledger's finalized global total, spot-check sample leaves against `getCGValueAtEpoch`; then set `backfillLocked = false`.
4. `clearOutstandingChallenges()`. **`ContextGraphStorage` (the id counter) is untouched**, so CG ids are stable and nothing downstream breaks.

---

## Phasing

- **Phase 0 — Measure (do regardless):** current mainnet `cgCount` and the observed `D` distribution. Determines whether we need an interim stopgap while Phase 2 is built.
- **Phase 1 — Optional interim D-fix:** if current scale already strains gas, ship the cheap `finalizeCGValueUpTo(currentEpoch-1)` step in the `createChallenge` prologue (no new storage, no migration) to restore the baseline while Phase 2 lands. Throwaway-cheap; the same finalize machinery is reused by the Phase 2 migration.
- **Phase 2 — This RFC:** BIT + lazy settle, with the migration runbook. This is the end state required for 5k–100k+ CGs.

---

## Open decisions

1. **Settle-on-miss only, or also a keeper / epoch-due index?** **RESOLVED for V10 → settle-on-spend + settle-on-miss only; defer the keeper and the epoch-due index.** Settle-on-miss alone heals *expiry* over-statement; under-statement (future-dated/extended value) is the only gap, and Phase-0 (`base_sepolia_v10`, epoch 521) showed **no detectable future-dated backlog** (the 8 weighted CGs' Σ equals the global total) while dormancy manifests as *zero*-weight CGs that the BIT skips for free. The deferral is **reversible at zero cost**: `settleMany` already ships as a permissionless function, so enabling the keeper later is an off-chain bot, not a redeploy. **Trigger to revisit:** mainnet shows significant `extend`/scheduled value, *or* dormant CGs that retain nonzero weight. The `epochDueCgs` index only if the property test (below) later shows under-statement latency materially breaches the fairness bar.
2. **Fairness tolerance.** **RESOLVED (provisional) → per-CG draw frequency within ±2% of true active-weight share, and wasted-retry rate < 1%**, over a realistic publish/expire/extend workload; this is the pass/fail bar for the drift-regime property test and the keeper tripwire. ±2% sits inside the natural variance of a per-period pseudo-random draw and below the granularity at which reward/scoring differences matter. The bar is a **CI confidence check, not an on-chain invariant** (correctness is independent of weight freshness — Invariant 4 — so there is nothing to enforce at runtime). The test is meaningful only against the integrated draw + settle hooks (with *exact* leaves the deviation is 0%, already covered by the parity test), so it lands in **Phase 2**. Reconfirm the number once mainnet weight dispersion is known.
3. **Keep `V/lifetime` per-epoch amortization, or simplify the weight definition?** The BIT is agnostic to how the leaf value is derived — recommend keeping the existing economic definition (active per-epoch TRAC) unchanged; only the *indexing* changes.
4. **Storage placement.** **RESOLVED → dedicated `CGWeightTreeStorage`** (built; clean separation let the Fenwick be unit-tested in isolation — 19 tests). Not fields on `RandomSamplingStorage`.

> **Resolved (was Open Decision #3 — deactivation).** Promoted to **Invariant 2**: `cgWeight > 0 ⇒ CG active`, enforced. No deactivation callers today; if added, the hook is `settle(cg); _bitUpdate(cg, -cgWeight[cg]); cgWeight[cg] = 0` plus a ≥2-active-CG floor.

---

## Alternatives considered

- **Exact Fenwick + synchronized per-epoch roll + draw-gating.** The "accounting-correct" version. Rejected: it carries a clustered-expiry per-epoch gas spike (mitigated only by a resumable cursor + draw-gating that delays first challenges of an epoch) and significant correctness machinery — all to achieve weight exactness the sampling goal does not require. Lazy settlement gets the same sampling behavior far more simply.
- **Alias method.** `O(1)` draw, but **any weight change forces an `O(N)` table rebuild**; weights change every epoch via implicit decay → ~`O(N)` gas per epoch. Worse than status quo. Rejected.
- **Segment tree.** Algorithmically equivalent to Fenwick but 2–4× the storage with no benefit here. Rejected in favor of Fenwick.
- **Off-chain draw + on-chain verify.** Verifying the *weighted* (not merely eligible) property on-chain needs the same prefix structure (back to Fenwick) or a per-epoch weight-vector commitment (relocates the problem off-chain), and a grind-resistant seed needs commit-reveal/VRF — out of V10 scope. Rejected.
- **Cumulative weight (no expiry at all).** Simplest possible, but over-samples CGs whose data has expired → wasted retries and (absent the KA filter) un-answerable challenges. Lazy settlement keeps expiry semantics at the same simplicity, so it is strictly preferable. Rejected.
