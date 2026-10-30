// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ConvictionScheduleLib} from "../libraries/ConvictionScheduleLib.sol";

/// @title ConvictionScheduleLibHarness
/// @notice Test-only: exposes `ConvictionScheduleLib` for unit tests.
contract ConvictionScheduleLibHarness {
    function emissionAt(
        uint256 anchorEpoch,
        uint256 lock,
        uint256 epochLength,
        uint256 timeRemaining,
        uint96[] calldata windowAmounts,
        uint256 epoch
    ) external pure returns (uint96) {
        ConvictionScheduleLib.Basis memory b = ConvictionScheduleLib.build(
            anchorEpoch,
            lock,
            epochLength,
            timeRemaining,
            windowAmounts
        );
        return ConvictionScheduleLib.emissionAt(b, epoch);
    }

    /// @notice S(e) for every epoch from `fromEpoch` to `toEpoch`, inclusive,
    ///         over one basis.
    function emissionRange(
        uint256 anchorEpoch,
        uint256 lock,
        uint256 epochLength,
        uint256 timeRemaining,
        uint96[] calldata windowAmounts,
        uint256 fromEpoch,
        uint256 toEpoch
    ) external pure returns (uint96[] memory amounts) {
        ConvictionScheduleLib.Basis memory b = ConvictionScheduleLib.build(
            anchorEpoch,
            lock,
            epochLength,
            timeRemaining,
            windowAmounts
        );
        amounts = new uint96[](toEpoch - fromEpoch + 1);
        for (uint256 i; i < amounts.length; i++) {
            amounts[i] = ConvictionScheduleLib.emissionAt(b, fromEpoch + i);
        }
    }

    /// @notice The emission span, which depends only on the anchor and the
    ///         lock. The basis is built with a nominal epoch length and empty
    ///         windows, so `lock` is validated exactly as `build` validates it.
    function span(uint256 anchorEpoch, uint256 lock) external pure returns (uint256 firstEpoch, uint256 lastEpoch) {
        ConvictionScheduleLib.Basis memory b = ConvictionScheduleLib.build(anchorEpoch, lock, 1, 1, new uint96[](lock));
        return (ConvictionScheduleLib.firstEpoch(b), ConvictionScheduleLib.lastEpoch(b));
    }
}
