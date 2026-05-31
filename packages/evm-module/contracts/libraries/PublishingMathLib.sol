// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library PublishingMathLib {
    struct ActiveSinkRange {
        uint40 startEpoch;
        uint40 endEpoch;
        uint96 tokenAmount;
    }

    function discountBps(uint96 committedTRAC) internal pure returns (uint256) {
        if (committedTRAC >= 1_000_000 ether) return 7500;
        if (committedTRAC >= 500_000 ether)   return 5000;
        if (committedTRAC >= 250_000 ether)   return 4000;
        if (committedTRAC >= 100_000 ether)   return 3000;
        if (committedTRAC >= 50_000 ether)    return 2000;
        if (committedTRAC >= 25_000 ether)    return 1000;
        return 0;
    }

    function prorateActiveSink(
        uint96 tokenAmount,
        uint40 currentEpoch,
        uint256 epochs,
        uint256 epochLengthInSeconds,
        uint256 timeRemainingInCurrentEpoch
    ) internal pure returns (ActiveSinkRange[3] memory ranges) {
        uint256 baseTokensPerFullEpoch = tokenAmount / epochs;
        uint256 currentEpochAllocation = (baseTokensPerFullEpoch * timeRemainingInCurrentEpoch) / epochLengthInSeconds;
        uint256 finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation;
        uint256 numberOfFullEpochs = epochs - 1;
        uint256 totalTokensForFullEpochs = baseTokensPerFullEpoch * numberOfFullEpochs;
        uint256 totalAllocated = currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
        if (totalAllocated < tokenAmount) {
            finalEpochAllocation += tokenAmount - totalAllocated;
        }

        if (currentEpochAllocation > 0) {
            ranges[0] = ActiveSinkRange({
                startEpoch: currentEpoch,
                endEpoch: currentEpoch,
                tokenAmount: uint96(currentEpochAllocation)
            });
        }
        if (numberOfFullEpochs > 0 && totalTokensForFullEpochs > 0) {
            ranges[1] = ActiveSinkRange({
                startEpoch: currentEpoch + 1,
                endEpoch: currentEpoch + uint40(numberOfFullEpochs),
                tokenAmount: uint96(totalTokensForFullEpochs)
            });
        }
        if (finalEpochAllocation > 0) {
            ranges[2] = ActiveSinkRange({
                startEpoch: currentEpoch + uint40(epochs),
                endEpoch: currentEpoch + uint40(epochs),
                tokenAmount: uint96(finalEpochAllocation)
            });
        }
    }
}
