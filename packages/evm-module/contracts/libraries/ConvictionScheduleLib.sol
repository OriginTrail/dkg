// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ConvictionScheduleLib
 * @notice A Conviction Account's scheduled staker emission per chain epoch,
 *         rebuilt from the account's stored terms. Conviction Account service
 *         spending (OT-RFC-27) labels the cost of a funded plan period
 *         against this emission, and a label may never exceed what the
 *         account itself emits in an epoch, so this is the labels' basis.
 *
 * The schedule (PublishingConviction 10.0.8 and later). An account with lock L
 * has L billing windows of one epoch length E each, from its creation time T0.
 * When window w closes, at T0 + (w + 1)·E, its amount R_w is spread forward
 * over L epoch lengths by `PublishingMathLib.prorateActiveSink`:
 *
 *     base_w = floor(R_w / L)
 *     cur_w  = floor(base_w · tr / E)          credited to epoch anchor + w
 *     base_w                                   credited to each epoch from
 *                                              anchor + w + 1 to anchor + w + L − 1
 *     fin_w  = R_w − cur_w − base_w·(L − 1)    credited to epoch anchor + w + L
 *
 * where `anchor` is the epoch in which window 0 closes and `tr` is the time
 * left in that epoch after the close, 0 < tr <= E. Chronos epochs have a fixed
 * length, so window w closes in epoch anchor + w, with the same tr for every
 * window. The account's emission in epoch e, with k = e − anchor, is then
 *
 *     S(e) = [k <= L − 1]·cur_k
 *          + Σ base_w over w from max(0, k − L + 1) to min(L − 1, k − 1)
 *          + [k >= L]·fin_(k − L)
 *
 * for 0 <= k <= 2L − 1, and 0 outside that span. `build` precomputes the
 * prefix sums of base_w in O(L), so each `emissionAt` costs O(1).
 *
 * The caller chooses each R_w. For an account whose whole schedule was written
 * at creation it is the window budget floor(C / L) of the commitment C, with
 * the `C mod L` dust on the last window. For an older account the caller
 * passes a lower bound of what was scheduled. EpochStorage's shard-wide
 * division remainder is not part of S: it rides on top of the account's own
 * credits, so the account's credit to each epoch is at least S(e).
 */
library ConvictionScheduleLib {
    struct Basis {
        uint256 anchorEpoch; // the epoch in which window 0 closes
        uint256 lock; // L, the account's number of billing windows
        uint256 epochLength; // E, in seconds
        uint256 timeRemaining; // tr, with 0 < tr <= E
        uint96[] windowAmounts; // R_w, length L
        uint256[] basePrefix; // basePrefix[i] = Σ floor(R_w / L) over w < i, length L + 1
    }

    error ZeroLock();
    error WindowAmountsLengthMismatch(uint256 lock, uint256 length);
    error InvalidTimeRemaining(uint256 timeRemaining, uint256 epochLength);

    /// @notice Build the basis and fill its prefix sums. Reverts when `lock` is
    ///         0, when `windowAmounts` does not hold one amount per window, or
    ///         when `timeRemaining` is 0 or above `epochLength`.
    function build(
        uint256 anchorEpoch,
        uint256 lock,
        uint256 epochLength,
        uint256 timeRemaining,
        uint96[] memory windowAmounts
    ) internal pure returns (Basis memory b) {
        if (lock == 0) revert ZeroLock();
        if (windowAmounts.length != lock) revert WindowAmountsLengthMismatch(lock, windowAmounts.length);
        if (timeRemaining == 0 || timeRemaining > epochLength) {
            revert InvalidTimeRemaining(timeRemaining, epochLength);
        }

        uint256[] memory basePrefix = new uint256[](lock + 1);
        uint256 sum;
        for (uint256 w; w < lock; w++) {
            sum += uint256(windowAmounts[w]) / lock;
            basePrefix[w + 1] = sum;
        }

        b.anchorEpoch = anchorEpoch;
        b.lock = lock;
        b.epochLength = epochLength;
        b.timeRemaining = timeRemaining;
        b.windowAmounts = windowAmounts;
        b.basePrefix = basePrefix;
    }

    /// @notice S(epoch): the account's scheduled emission in `epoch`, and 0
    ///         outside [firstEpoch(b), lastEpoch(b)]. Reverts rather than
    ///         truncate if the sum does not fit in uint96, which the windows
    ///         of a real account, summing to at most its commitment, never
    ///         reach.
    function emissionAt(Basis memory b, uint256 epoch) internal pure returns (uint96) {
        if (epoch < b.anchorEpoch) return 0;
        uint256 k = epoch - b.anchorEpoch;
        uint256 lock = b.lock;
        if (k > 2 * lock - 1) return 0;

        uint256 s;
        if (k < lock) {
            // cur_k: the partial first-epoch credit of window k.
            s = ((uint256(b.windowAmounts[k]) / lock) * b.timeRemaining) / b.epochLength;
        } else {
            // fin_(k − L): the dust-corrected final credit of window k − L.
            uint256 amount = b.windowAmounts[k - lock];
            uint256 base = amount / lock;
            s = amount - (base * b.timeRemaining) / b.epochLength - base * (lock - 1);
        }
        if (k > 0) {
            // base_w of every window whose full-epoch range covers epoch e.
            uint256 lo = k + 1 > lock ? k + 1 - lock : 0;
            uint256 hi = k - 1 < lock - 1 ? k - 1 : lock - 1;
            if (lo <= hi) {
                s += b.basePrefix[hi + 1] - b.basePrefix[lo];
            }
        }
        return SafeCast.toUint96(s);
    }

    /// @notice The first epoch the account emits in: the anchor.
    function firstEpoch(Basis memory b) internal pure returns (uint256) {
        return b.anchorEpoch;
    }

    /// @notice The last epoch the account emits in: anchor + 2·lock − 1.
    function lastEpoch(Basis memory b) internal pure returns (uint256) {
        return b.anchorEpoch + 2 * b.lock - 1;
    }
}
