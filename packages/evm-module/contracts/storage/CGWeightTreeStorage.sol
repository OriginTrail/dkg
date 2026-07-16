// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Chronos} from "./Chronos.sol";
import {ContextGraphValueStorage} from "./ContextGraphValueStorage.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";

/**
 * @title CGWeightTreeStorage
 * @notice Fenwick / Binary-Indexed-Tree index over Context-Graph ids for O(log)
 *         value-weighted challenge selection in RandomSampling. See
 *         docs/rfcs/scalable-weighted-cg-sampling.md.
 *
 *         - `cgWeight[cg]` is the CG's approximate current-epoch weight (the Fenwick leaf).
 *         - `bit`         holds standard BIT partial range sums over a FIXED power-of-two capacity.
 *         - `bitTotal`    is the cached Σ cgWeight == prefixSum(BIT_CAPACITY).
 *
 *         `ContextGraphValueStorage` is the source of truth; this tree is an
 *         eventually-consistent fast index reconciled by `settle`. Challenge
 *         correctness never depends on weight freshness (RandomSampling's KA
 *         filter drops expired KAs after the draw), so leaves may be approximate.
 *
 * @dev CAPACITY IS FIXED AT DEPLOY — never grow it. A mapping-backed Fenwick whose
 *      logical size grows is silently wrong: when the live id count crosses a 2^k
 *      boundary, the newly-relevant internal node bit[2^k] must cover (0, 2^k] but
 *      never received the point updates written to lower leaves before it "existed",
 *      so prefixSum past that boundary is permanently short — no revert, bitTotal
 *      stays self-consistent, only the draw distribution is wrong. Fixing capacity up
 *      front makes every leaf's update path reach all its ancestors from the start;
 *      the mapping is sparse so unused leaves cost nothing. Because RandomSampling is
 *      a fresh-deploy contract, capacity is (re)chosen per deploy via the constructor.
 */
contract CGWeightTreeStorage is INamed, IVersioned, IInitializable, HubDependent {
    using SafeCast for uint256;
    using SafeCast for int256;

    string private constant _NAME = "CGWeightTreeStorage";
    string private constant _VERSION = "1.0.0";

    /// @dev Thrown by _bitUpdate when an id is 0 (Fenwick is 1-based; lowbit(0)==0 loops
    ///      forever) or >= BIT_CAPACITY (the update loop would no-op yet bitTotal would
    ///      still move — silently breaking the Σ-consistency invariant). Real guard, not
    ///      just "size capacity big enough": defense-in-depth vs the monotonic CG counter.
    error CgIdOutOfBitCapacity(uint256 cg, uint256 capacity);
    error CapacityNotPowerOfTwo(uint256 capacity);
    error NotBackfilling();

    event WeightSet(uint256 indexed cg, uint256 oldWeight, uint256 newWeight);
    event BackfillFinalized(uint256 bitTotal);

    Chronos public chronos;
    ContextGraphValueStorage public contextGraphValueStorage;

    /// @notice Fixed power-of-two capacity; valid CG ids are 1..BIT_CAPACITY-1.
    uint256 public immutable BIT_CAPACITY;

    mapping(uint256 index => uint256) internal bit; // Fenwick partial range sums
    mapping(uint256 cg => uint256) public cgWeight; // explicit per-CG leaf (O(1) reads)
    uint256 public bitTotal; // cached Σ cgWeight == prefixSum(BIT_CAPACITY)
    mapping(uint256 cg => uint256) public cgSettledEpoch; // epoch the leaf was last reconciled to
    bool public backfillLocked; // true during migration seeding; gates `seed`

    constructor(address hubAddress, uint256 bitCapacity) HubDependent(hubAddress) {
        // Power-of-two so the descent's top step is exactly BIT_CAPACITY and lowbit math is clean.
        if (bitCapacity == 0 || (bitCapacity & (bitCapacity - 1)) != 0) {
            revert CapacityNotPowerOfTwo(bitCapacity);
        }
        BIT_CAPACITY = bitCapacity;
        backfillLocked = true; // released by finishBackfill() once seeding completes
    }

    function initialize() public virtual override onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
        contextGraphValueStorage = ContextGraphValueStorage(hub.getContractAddress("ContextGraphValueStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // -------------------------------------------------------------------------
    // Fenwick primitives
    // -------------------------------------------------------------------------

    /// @dev Standard Fenwick point update by a signed delta; keeps bitTotal in sync.
    function _bitUpdate(uint256 i, int256 delta) internal {
        // Guard first (unconditional): an out-of-range/zero id must revert even on a no-op delta,
        // matching the docstring's defense-in-depth intent against the monotonic CG counter.
        if (i == 0 || i >= BIT_CAPACITY) revert CgIdOutOfBitCapacity(i, BIT_CAPACITY);
        if (delta == 0) return;
        for (uint256 x = i; x <= BIT_CAPACITY; x += (x & (~x + 1))) {
            bit[x] = (bit[x].toInt256() + delta).toUint256(); // never underflows: see invariants
        }
        // Slither flags this cached-total SSTORE as "costly op in a loop" via the settleMany/
        // seedMany batch call stacks; updating bitTotal once per leaf change is required and is
        // the whole point of the cached total (O(1) reads).
        // slither-disable-next-line costly-loop
        bitTotal = (bitTotal.toInt256() + delta).toUint256();
    }

    /// @notice Smallest index whose prefix sum is STRICTLY greater than `r` (mirrors the
    ///         legacy `running > r` straddle). Capacity is a fixed power of two, so the top
    ///         step is BIT_CAPACITY — no highest-bit computation needed. Caller guarantees
    ///         `r < bitTotal`.
    function findStrictGt(uint256 r) public view returns (uint256 idx) {
        uint256 cum = 0;
        idx = 0;
        for (uint256 step = BIT_CAPACITY; step != 0; step >>= 1) {
            uint256 next = idx + step;
            if (next <= BIT_CAPACITY && cum + bit[next] <= r) {
                // <= r ⇒ still go right
                idx = next;
                cum += bit[next];
            }
        }
        idx += 1; // first index that pushes the running sum strictly past r
    }

    /// @notice Renormalized strict-gt search over (all weighted CGs \ `excluded`).
    ///         Subtracts each excluded leaf's contribution DURING the descent, which
    ///         reproduces the legacy "re-summed adjustedTotal" distribution exactly —
    ///         do NOT replace with an "advance to next nonzero leaf" walk (that skews the
    ///         distribution and starves the tail). Caller guarantees `r < workingTotal`.
    ///         O(excluded.length · log).
    function findStrictGtExcluding(uint256 r, uint256[] memory excluded) public view returns (uint256 idx) {
        uint256 cum = 0;
        idx = 0;
        for (uint256 step = BIT_CAPACITY; step != 0; step >>= 1) {
            uint256 next = idx + step;
            if (next > BIT_CAPACITY) continue;
            // bit[next] covers ids (idx, next]; net out any excluded leaves in that span.
            // Cannot underflow: excluded leaves in (idx, next] are a subset of bit[next]'s sum.
            uint256 nodeSum = bit[next] - _excludedInRange(idx + 1, next, excluded);
            if (cum + nodeSum <= r) {
                idx = next;
                cum += nodeSum;
            }
        }
        idx += 1;
        // idx can never be an excluded CG: its leaf was netted out of every enclosing nodeSum.
    }

    /// @notice Working total for a renormalized draw = bitTotal − Σ current weight of excluded ids.
    ///         Recompute per attempt (a prior settle may have moved bitTotal).
    function workingTotal(uint256[] memory excluded) public view returns (uint256) {
        return bitTotal - _excludedSum(excluded);
    }

    function _excludedInRange(uint256 lo, uint256 hi, uint256[] memory excluded) internal view returns (uint256 s) {
        uint256 n = excluded.length;
        for (uint256 j = 0; j < n; j++) {
            uint256 e = excluded[j];
            if (e >= lo && e <= hi) s += cgWeight[e];
        }
    }

    function _excludedSum(uint256[] memory excluded) internal view returns (uint256 s) {
        uint256 n = excluded.length;
        for (uint256 j = 0; j < n; j++) s += cgWeight[excluded[j]];
    }

    // -------------------------------------------------------------------------
    // Migration seeding (permissioned, only while backfill-locked)
    // -------------------------------------------------------------------------

    /// @notice Set a CG's leaf to `weight` during the one-time migration backfill.
    ///         Restricted to the locked window so weights can only be injected during
    ///         seeding; post-unlock the only writer is `settle` (reconcile to truth).
    function seed(uint256 cg, uint256 weight) external onlyContracts {
        if (!backfillLocked) revert NotBackfilling();
        _setWeight(cg, weight);
    }

    function seedMany(uint256[] calldata cgs, uint256[] calldata weights) external onlyContracts {
        if (!backfillLocked) revert NotBackfilling();
        uint256 n = cgs.length;
        require(n == weights.length, "len mismatch");
        for (uint256 k = 0; k < n; k++) _setWeight(cgs[k], weights[k]);
    }

    /// @notice End the migration backfill; enables the prod draw/settle path in RandomSampling.
    ///         One-way and not re-callable, so an accidental double-call reverts loudly rather than
    ///         silently re-emitting. Recovery from a premature call is a fresh redeploy (capacity is
    ///         immutable and chosen per deploy anyway).
    function finishBackfill() external onlyContracts {
        if (!backfillLocked) revert NotBackfilling();
        backfillLocked = false;
        emit BackfillFinalized(bitTotal);
    }

    // -------------------------------------------------------------------------
    // Lazy settlement (the only place truth meets the index)
    // -------------------------------------------------------------------------

    /// @notice Reconcile a CG's leaf to its true current-epoch weight in the ledger, and
    ///         finalize the ledger so subsequent reads of this CG are O(1). Permissionless
    ///         by design (settle-on-spend, settle-on-miss, keeper): finalizeCGValueUpTo is
    ///         onlyContracts but the call originates from this Hub-registered contract.
    // Slither: the "reentrancy" detectors flag the state writes after finalizeCGValueUpTo/
    // getCGValueAtEpoch, but those callees are TRUSTED Hub-registered storage contracts that do
    // pure storage math — no ETH/token transfer, no low-level call, no untrusted callback — so
    // there is no reentrancy surface. State-after-call ordering is required (finalize must run
    // before the value read).
    // slither-disable-next-line reentrancy-no-eth,reentrancy-benign,reentrancy-events
    function settle(uint256 cg) public {
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > 0) contextGraphValueStorage.finalizeCGValueUpTo(cg, currentEpoch - 1);
        uint256 truth = contextGraphValueStorage.getCGValueAtEpoch(cg, currentEpoch);
        _setWeight(cg, truth);
        cgSettledEpoch[cg] = currentEpoch;
    }

    /// @notice Permissionless batch settle (keeper backstop for dormant / under-stated CGs).
    // Slither: external calls inside the loop are unavoidable for a batch settle; each callee is
    // a trusted Hub storage contract (see settle). The batch is caller-bounded.
    // slither-disable-next-line calls-loop
    function settleMany(uint256[] calldata cgs) external {
        uint256 n = cgs.length;
        for (uint256 k = 0; k < n; k++) settle(cgs[k]);
    }

    function _setWeight(uint256 cg, uint256 weight) internal {
        uint256 cached = cgWeight[cg];
        if (weight != cached) {
            _bitUpdate(cg, weight.toInt256() - cached.toInt256());
            cgWeight[cg] = weight;
            emit WeightSet(cg, cached, weight);
        }
    }
}
