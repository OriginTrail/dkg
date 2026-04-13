// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

/**
 * @title ContextGraphValueStorage
 * @notice Lightweight per-CG and global per-epoch TRAC value tracker for V10
 *         value-weighted challenges. Mirrors `EpochStorage.sol` diff/cumulative
 *         finalize pattern at lines 149-174 / 279-310 exactly, but scaled to
 *         int256/uint256 because publish values are wei-of-TRAC and exceed uint96.
 *
 * Design rationale (see V10_CONTRACTS_REDESIGN_v2.md §"Data in
 * ContextGraphValueStorage"): a KC published with value `V` for `lifetime`
 * epochs contributes `V / lifetime` per epoch during its active window
 * [startEpoch, startEpoch + lifetime - 1]. Expiry is handled implicitly by the
 * negative diff written at `startEpoch + lifetime`. No cleanup, no keeper.
 *
 * `addCGValueForEpochRange` uses plain integer division per the spec. A couple
 * wei of rounding dust per publish is acceptable — this mapping is used for
 * challenge weighting, not reward distribution.
 *
 * The dormant shard mappings (`cgShard`, `shardKnowledgeValue`) are reserved
 * storage slots for future V11 sharding. Setters will be added alongside the
 * V11 logic contracts; no API exists today.
 */
contract ContextGraphValueStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ContextGraphValueStorage";
    string private constant _VERSION = "1.0.0";

    event CGValueAddedForEpochRange(
        uint256 indexed cgId,
        uint256 startEpoch,
        uint256 endEpoch,
        uint256 lifetime,
        uint256 value,
        uint256 perEpoch
    );
    event CGValueFinalized(uint256 indexed cgId, uint256 startEpoch, uint256 endEpoch);
    event GlobalValueFinalized(uint256 startEpoch, uint256 endEpoch);

    error ZeroLifetime();
    error ZeroValue();
    error NegativeCumulative();
    error BackfillForbidden();
    error FutureOrCurrentEpoch();

    Chronos public chronos;

    // Per-CG diff/cumulative ledgers.
    mapping(uint256 cgId => mapping(uint256 epoch => int256)) public cgValueDiff;
    mapping(uint256 cgId => mapping(uint256 epoch => uint256)) public cgValueCumulative;
    mapping(uint256 cgId => uint256) public cgLastFinalizedEpoch;

    // Global diff/cumulative ledgers (sum across all CGs).
    mapping(uint256 epoch => int256) public totalValueDiff;
    mapping(uint256 epoch => uint256) public totalValueCumulative;
    uint256 public globalLastFinalizedEpoch;

    /// @dev Reserved storage slots for future V11 sharding. Setters will be
    ///      added alongside the V11 logic contracts; no API exists today.
    mapping(uint256 cgId => uint256) public cgShard;
    mapping(uint256 shardId => mapping(uint256 epoch => uint256)) public shardKnowledgeValue;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // -------------------------------------------------------------------------
    // State mutators
    // -------------------------------------------------------------------------

    /**
     * @notice Record that `value` TRAC will be paid for `cgId` spread evenly
     *         across `lifetime` epochs starting at `startEpoch`. Each epoch in
     *         [startEpoch, startEpoch + lifetime - 1] receives `value/lifetime`.
     * @dev Mirrors `EpochStorage.addTokensToEpochRange`. Finalizes per-CG and
     *      global ledgers up to `currentEpoch - 1` after the diff writes so
     *      stale epochs are crystallized before the next read. Rounding dust is
     *      discarded per the spec (challenge weighting, not reward payout).
     *
     *      Invariant: `startEpoch >= currentEpoch`. Backfilling into an
     *      already-finalized epoch would corrupt `cgValueCumulative` silently
     *      because the cumulative at that epoch has already been crystallized
     *      and subsequent reads hit the fast path. Reverts `BackfillForbidden`
     *      if the caller tries.
     *
     *      Retraction / expiry is automatic via the paired negative diff
     *      written at `startEpoch + lifetime`. There is no removal function
     *      by design: Phase 8 value-changing ops (CREATE, byte-size-grow
     *      UPDATE, lifetime extension) are all positive deltas, and natural
     *      expiry is handled by the diff ledger itself.
     */
    function addCGValueForEpochRange(
        uint256 cgId,
        uint256 startEpoch,
        uint256 lifetime,
        uint256 value
    ) external onlyContracts {
        if (lifetime == 0) {
            revert ZeroLifetime();
        }
        if (value == 0) {
            revert ZeroValue();
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (startEpoch < currentEpoch) {
            revert BackfillForbidden();
        }

        uint256 perEpoch = value / lifetime;
        int256 perEpochSigned = SafeCast.toInt256(perEpoch);

        cgValueDiff[cgId][startEpoch] += perEpochSigned;
        cgValueDiff[cgId][startEpoch + lifetime] -= perEpochSigned;

        totalValueDiff[startEpoch] += perEpochSigned;
        totalValueDiff[startEpoch + lifetime] -= perEpochSigned;

        if (currentEpoch > 1) {
            _finalizeCGValueUpTo(cgId, currentEpoch - 1);
            _finalizeGlobalValueUpTo(currentEpoch - 1);
        }

        emit CGValueAddedForEpochRange(
            cgId,
            startEpoch,
            startEpoch + lifetime - 1,
            lifetime,
            value,
            perEpoch
        );
    }

    /**
     * @notice Crystallizes `cgValueCumulative[cgId]` up to `epoch` so
     *         subsequent reads at or below `epoch` become O(1). Safe to call
     *         repeatedly: a call with `epoch <= cgLastFinalizedEpoch[cgId]`
     *         is a no-op.
     * @dev Intended to be called by RandomSampling before a challenge draw
     *      (see V10_CONTRACTS_REDESIGN_v2 "On challenge generation"), but any
     *      Hub-registered contract may call it. Reads stay pure `view`; this
     *      is the state-changing half of the "finalize then read" pattern.
     * @dev Reverts FutureOrCurrentEpoch if `epoch` is at or beyond the current
     *      epoch. Only past epochs may be finalized; current-epoch reads always
     *      take the simulation path to reflect in-flight diff writes.
     */
    function finalizeCGValueUpTo(uint256 cgId, uint256 epoch) external onlyContracts {
        if (epoch >= chronos.getCurrentEpoch()) {
            revert FutureOrCurrentEpoch();
        }
        if (epoch <= cgLastFinalizedEpoch[cgId]) {
            return;
        }
        _finalizeCGValueUpTo(cgId, epoch);
    }

    /**
     * @notice Crystallizes `totalValueCumulative` up to `epoch`. See
     *         {finalizeCGValueUpTo} for semantics.
     * @dev Reverts FutureOrCurrentEpoch if `epoch` is at or beyond the current
     *      epoch. Only past epochs may be finalized; current-epoch reads always
     *      take the simulation path to reflect in-flight diff writes.
     */
    function finalizeGlobalValueUpTo(uint256 epoch) external onlyContracts {
        if (epoch >= chronos.getCurrentEpoch()) {
            revert FutureOrCurrentEpoch();
        }
        if (epoch <= globalLastFinalizedEpoch) {
            return;
        }
        _finalizeGlobalValueUpTo(epoch);
    }

    // -------------------------------------------------------------------------
    // Read helpers
    // -------------------------------------------------------------------------

    /// @notice Active per-epoch contribution of `cgId` at `epoch` (sum of all
    ///         active KCs' per-epoch values at that epoch). Returns the
    ///         simulated value if the epoch has not been finalized yet.
    function getCGValueAtEpoch(uint256 cgId, uint256 epoch) public view returns (uint256) {
        if (epoch <= cgLastFinalizedEpoch[cgId]) {
            return cgValueCumulative[cgId][epoch];
        }
        return _simulateCGValueFinalization(cgId, epoch);
    }

    /// @notice Global sum across all CGs of active per-epoch contributions at `epoch`.
    function getTotalValueAtEpoch(uint256 epoch) public view returns (uint256) {
        if (epoch <= globalLastFinalizedEpoch) {
            return totalValueCumulative[epoch];
        }
        return _simulateGlobalValueFinalization(epoch);
    }

    function getCurrentCGValue(uint256 cgId) external view returns (uint256) {
        return getCGValueAtEpoch(cgId, chronos.getCurrentEpoch());
    }

    function getCurrentTotalValue() external view returns (uint256) {
        return getTotalValueAtEpoch(chronos.getCurrentEpoch());
    }

    // -------------------------------------------------------------------------
    // Internal finalization
    // -------------------------------------------------------------------------

    function _finalizeCGValueUpTo(uint256 cgId, uint256 epoch) internal {
        uint256 lastFinalized = cgLastFinalizedEpoch[cgId];
        if (epoch <= lastFinalized) {
            return;
        }

        uint256 startEpoch = lastFinalized + 1;
        int256 running;
        if (lastFinalized > 0) {
            running = int256(cgValueCumulative[cgId][lastFinalized]);
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            running += cgValueDiff[cgId][e];
            // Cumulative values are non-negative by construction (positive diffs
            // at startEpoch are always matched by negative diffs at
            // startEpoch+lifetime). Revert defensively on underflow.
            if (running < 0) {
                revert NegativeCumulative();
            }
            cgValueCumulative[cgId][e] = uint256(running);
        }

        cgLastFinalizedEpoch[cgId] = epoch;

        emit CGValueFinalized(cgId, startEpoch, epoch);
    }

    function _finalizeGlobalValueUpTo(uint256 epoch) internal {
        uint256 lastFinalized = globalLastFinalizedEpoch;
        if (epoch <= lastFinalized) {
            return;
        }

        uint256 startEpoch = lastFinalized + 1;
        int256 running;
        if (lastFinalized > 0) {
            running = int256(totalValueCumulative[lastFinalized]);
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            running += totalValueDiff[e];
            if (running < 0) {
                revert NegativeCumulative();
            }
            totalValueCumulative[e] = uint256(running);
        }

        globalLastFinalizedEpoch = epoch;

        emit GlobalValueFinalized(startEpoch, epoch);
    }

    function _simulateCGValueFinalization(uint256 cgId, uint256 epoch) internal view returns (uint256) {
        uint256 lastFinalized = cgLastFinalizedEpoch[cgId];
        if (epoch <= lastFinalized) {
            return cgValueCumulative[cgId][epoch];
        }

        int256 running;
        if (lastFinalized > 0) {
            running = int256(cgValueCumulative[cgId][lastFinalized]);
        }

        for (uint256 e = lastFinalized + 1; e <= epoch; e++) {
            running += cgValueDiff[cgId][e];
            // Unify policy with the mutate path (`_finalizeCGValueUpTo`): a
            // negative running total would signal ledger corruption and is an
            // unrecoverable invariant break. Reverting here — even from a view
            // function — gives RPC clients immediate visibility instead of
            // silently clamping to zero.
            if (running < 0) {
                revert NegativeCumulative();
            }
        }

        return uint256(running);
    }

    function _simulateGlobalValueFinalization(uint256 epoch) internal view returns (uint256) {
        uint256 lastFinalized = globalLastFinalizedEpoch;
        if (epoch <= lastFinalized) {
            return totalValueCumulative[epoch];
        }

        int256 running;
        if (lastFinalized > 0) {
            running = int256(totalValueCumulative[lastFinalized]);
        }

        for (uint256 e = lastFinalized + 1; e <= epoch; e++) {
            running += totalValueDiff[e];
            if (running < 0) {
                revert NegativeCumulative();
            }
        }

        return uint256(running);
    }
}
