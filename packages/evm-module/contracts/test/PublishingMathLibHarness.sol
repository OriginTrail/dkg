// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {PublishingMathLib} from "../libraries/PublishingMathLib.sol";

contract PublishingMathLibHarness {
    function prorateActiveSink(
        uint96 tokenAmount,
        uint40 currentEpoch,
        uint256 epochs,
        uint256 epochLengthInSeconds,
        uint256 timeRemainingInCurrentEpoch
    )
        external
        pure
        returns (uint40[3] memory starts, uint40[3] memory ends, uint96[3] memory amounts)
    {
        PublishingMathLib.ActiveSinkRange[3] memory ranges = PublishingMathLib.prorateActiveSink(
            tokenAmount,
            currentEpoch,
            epochs,
            epochLengthInSeconds,
            timeRemainingInCurrentEpoch
        );

        for (uint256 i; i < ranges.length; i++) {
            starts[i] = ranges[i].startEpoch;
            ends[i] = ranges[i].endEpoch;
            amounts[i] = ranges[i].tokenAmount;
        }
    }
}
