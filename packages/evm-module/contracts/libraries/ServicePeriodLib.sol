// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IServicePeriodFunding} from "../interfaces/IServicePeriodFunding.sol";
import {Chronos} from "../storage/Chronos.sol";
import {ConvictionServiceStorage} from "../storage/ConvictionServiceStorage.sol";
import {QueryInferenceStorage} from "../storage/QueryInferenceStorage.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ServicePeriodLib
 * @notice The rules of a plan period (OT-RFC-27) that both funding contracts
 *         apply, `ServiceSubscriptions` from a Conviction Account and
 *         `ServiceSubscriptionsWallet` from a wallet: the pause and the
 *         activation, which epoch a period may be, its id, its buckets, and
 *         how a top-up merges into them. Internal functions, so each contract
 *         carries the same code and no library is linked.
 *
 * A plan period is one chain epoch. A buyer key funds at most one period per
 * epoch, for the current epoch or the next one, so a buyer node can fund the
 * next period before the boundary.
 */
library ServicePeriodLib {
    uint8 internal constant CLASS_INFERENCE = 1;
    uint8 internal constant CLASS_QUERY = 2;

    /// @notice A top-up's additions, merged into a period's stored buckets.
    struct TopUp {
        uint96 value; // what it adds, before the discount
        uint96[] added; // per stored bucket, by index, the value it adds
        ConvictionServiceStorage.Bucket[] appended; // its new buckets, in order
    }

    /// @dev `QueryInferenceStorage` is not paused. Returns the activation
    ///      epoch, 0 while unset.
    function requireNotPaused(QueryInferenceStorage qis) internal view returns (uint40 activation) {
        bool isPaused;
        (activation, isPaused) = qis.fundingState();
        if (isPaused) revert IServicePeriodFunding.QueryInferencePaused();
    }

    /// @dev Funding is live: `QueryInferenceStorage` is not paused, and the
    ///      current epoch is at or after the activation epoch, which is set.
    function requireLive(QueryInferenceStorage qis, Chronos chronos) internal view returns (uint256 currentEpoch) {
        uint40 activation = requireNotPaused(qis);
        currentEpoch = chronos.getCurrentEpoch();
        if (activation == 0 || currentEpoch < activation) {
            revert IServicePeriodFunding.QueryInferenceNotActive(activation, currentEpoch);
        }
    }

    /// @dev The period of `epoch`, which must be the current epoch or the next
    ///      one. It ends where the next epoch starts, and starts at the later
    ///      of the block time and its epoch's start: a period funded during its
    ///      epoch runs from now, a period funded ahead from its epoch's start.
    ///      Neither is ever 0, so the record always reads as existing.
    function periodOf(
        Chronos chronos,
        uint256 epoch,
        uint256 currentEpoch
    ) internal view returns (uint40 periodStart, uint40 periodEnd) {
        if (epoch != currentEpoch && epoch != currentEpoch + 1) {
            revert IServicePeriodFunding.InvalidFundingRequest("epoch");
        }
        uint256 start = chronos.timestampForEpoch(epoch);
        periodStart = SafeCast.toUint40(block.timestamp > start ? block.timestamp : start);
        periodEnd = SafeCast.toUint40(chronos.timestampForEpoch(epoch + 1));
    }

    /// @dev The id of the period `buyer` funds for `epoch`:
    ///      `keccak256(abi.encode(buyer, epoch))`, one per buyer key and epoch.
    function subscriptionIdOf(address buyer, uint256 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(buyer, epoch));
    }

    /// @dev The epoch of a recorded period, which its funding stored as the
    ///      period id. Its money is due in the epoch after it.
    function epochOf(ConvictionServiceStorage.Subscription memory s) internal pure returns (uint256) {
        return uint256(s.periodId);
    }

    /**
     * @dev The buckets of a funding: 1 to `maxBuckets` of them, in strictly
     *      increasing id, each of a known class, with a non-zero value and a
     *      non-zero price cap. Returns them as stored, and their value, which
     *      must fit a uint96.
     */
    function fundingBuckets(
        IServicePeriodFunding.BucketInput[] calldata inputs,
        uint256 maxBuckets
    ) internal pure returns (ConvictionServiceStorage.Bucket[] memory buckets, uint96 value) {
        uint256 n = inputs.length;
        if (n == 0 || n > maxBuckets) revert IServicePeriodFunding.InvalidFundingRequest("bucketCount");
        buckets = new ConvictionServiceStorage.Bucket[](n);
        uint256 total;
        for (uint256 i; i < n; i++) {
            IServicePeriodFunding.BucketInput calldata b = inputs[i];
            if (i > 0 && b.bucketId <= inputs[i - 1].bucketId) {
                revert IServicePeriodFunding.InvalidFundingRequest("bucketOrder");
            }
            _requireNewBucketTerms(b);
            total += b.value;
            buckets[i] = _stored(b);
        }
        value = toValue(total);
    }

    /// @dev A period value, which must fit a uint96.
    function toValue(uint256 total) internal pure returns (uint96) {
        if (total > type(uint96).max) revert IServicePeriodFunding.InvalidFundingRequest("value");
        return uint96(total);
    }

    /**
     * @dev A top-up of the recorded period `s` is open to `buyer`: the period
     *      exists, `buyer` is the key that funded it, it comes from the
     *      period's own source (`fromConviction` for an account's period, a
     *      wallet for account 0), and the period has not ended. No claim of
     *      the period is finalized before its epoch ends, so none is yet.
     */
    function requireTopUpOpen(
        bytes32 subscriptionId,
        ConvictionServiceStorage.Subscription memory s,
        address buyer,
        bool fromConviction
    ) internal view {
        if (s.periodStart == 0) revert IServicePeriodFunding.PeriodNotFound(subscriptionId);
        if (s.assignee != buyer) revert IServicePeriodFunding.NotPeriodBuyer(subscriptionId, buyer);
        if ((s.accountId != 0) != fromConviction) {
            revert IServicePeriodFunding.WrongFundingSource(subscriptionId, s.accountId);
        }
        if (block.timestamp >= s.periodEnd) revert IServicePeriodFunding.PeriodEnded(subscriptionId, s.periodEnd);
    }

    /**
     * @dev A top-up's additions, merged into the period's stored buckets: 1 or
     *      more of them, in strictly increasing id, each with a non-zero value.
     *        - An addition with a stored bucket's id adds to that bucket, and
     *          must repeat its class and price cap: neither changes within a
     *          period, so requests signed against them stay checkable.
     *        - Any other is a new bucket, under the funding rules, appended
     *          after the stored ones, so every stored bucket keeps its index.
     *      Stored and new buckets together are at most `maxBuckets`, and the
     *      period's value after the top-up must fit a uint96.
     */
    function mergeTopUp(
        ConvictionServiceStorage.Bucket[] memory stored,
        IServicePeriodFunding.BucketInput[] calldata additions,
        uint256 maxBuckets,
        uint96 periodValue
    ) internal pure returns (TopUp memory t) {
        uint256 m = additions.length;
        if (m == 0) revert IServicePeriodFunding.InvalidFundingRequest("bucketCount");
        uint256 n = stored.length;
        t.added = new uint96[](n);
        bool[] memory isNew = new bool[](m);
        uint256 newCount;
        uint256 total;

        for (uint256 j; j < m; j++) {
            IServicePeriodFunding.BucketInput calldata b = additions[j];
            if (j > 0 && b.bucketId <= additions[j - 1].bucketId) {
                revert IServicePeriodFunding.InvalidFundingRequest("bucketOrder");
            }
            uint256 i;
            while (i < n && stored[i].bucketId != b.bucketId) i++;
            if (i < n) {
                if (b.value == 0) revert IServicePeriodFunding.InvalidFundingRequest("bucketValue");
                if (b.serviceClass != stored[i].serviceClass || b.maxAskWeiPerUnit != stored[i].maxAskWeiPerUnit) {
                    revert IServicePeriodFunding.BucketTermsChanged(b.bucketId);
                }
                t.added[i] = b.value;
            } else {
                _requireNewBucketTerms(b);
                isNew[j] = true;
                newCount++;
            }
            total += b.value;
        }
        if (n + newCount > maxBuckets) revert IServicePeriodFunding.InvalidFundingRequest("bucketCount");
        t.value = toValue(total);
        toValue(uint256(periodValue) + total);

        t.appended = new ConvictionServiceStorage.Bucket[](newCount);
        uint256 k;
        for (uint256 j; j < m; j++) {
            if (isNew[j]) t.appended[k++] = _stored(additions[j]);
        }
    }

    /// @dev A new bucket's terms: a known class, a non-zero value and a
    ///      non-zero price cap.
    function _requireNewBucketTerms(IServicePeriodFunding.BucketInput calldata b) private pure {
        if (b.serviceClass != CLASS_INFERENCE && b.serviceClass != CLASS_QUERY) {
            revert IServicePeriodFunding.InvalidFundingRequest("serviceClass");
        }
        if (b.value == 0) revert IServicePeriodFunding.InvalidFundingRequest("bucketValue");
        if (b.maxAskWeiPerUnit == 0) revert IServicePeriodFunding.InvalidFundingRequest("maxAskWeiPerUnit");
    }

    function _stored(
        IServicePeriodFunding.BucketInput calldata b
    ) private pure returns (ConvictionServiceStorage.Bucket memory) {
        return
            ConvictionServiceStorage.Bucket({
                bucketId: b.bucketId,
                serviceClass: b.serviceClass,
                value: b.value,
                maxAskWeiPerUnit: b.maxAskWeiPerUnit
            });
    }
}
