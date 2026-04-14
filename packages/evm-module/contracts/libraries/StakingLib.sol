// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library StakingLib {
    struct NodeData {
        uint96 stake;
        uint256 rewardIndex;
        uint96 cumulativeEarnedRewards;
        uint96 cumulativePaidOutRewards;
        uint96 operatorFeeBalance;
        uint96 operatorFeeCumulativeEarnedRewards;
        uint96 operatorFeeCumulativePaidOutRewards;
        uint256 delegatorCount;
    }

    struct DelegatorData {
        uint96 stakeBase;
        uint96 stakeRewardIndexed;
        uint256 lastRewardIndex;
        uint96 cumulativeEarnedRewards;
        uint96 cumulativePaidOutRewards;
    }

    struct StakeWithdrawalRequest {
        uint96 amount;
        uint96 indexedOutAmount;
        uint256 timestamp;
    }

    error WithdrawalWasntInitiated();
    error WithdrawalPeriodPending(uint256 nowTimestamp, uint256 endTimestamp);
    error MaximumStakeExceeded(uint256 amount);
    error WithdrawalExceedsStake(uint96 stake, uint96 amount);
    error AmountExceedsOperatorFeeBalance(uint96 feeBalance, uint96 amount);
}
