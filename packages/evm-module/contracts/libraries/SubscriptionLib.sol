// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ISubscriptionFunding} from "../interfaces/ISubscriptionFunding.sol";
import {Chronos} from "../storage/Chronos.sol";
import {ServiceSubscriptionsStorage} from "../storage/ServiceSubscriptionsStorage.sol";
import {QueryInferenceStorage} from "../storage/QueryInferenceStorage.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title SubscriptionLib
 * @notice The rules of a subscription (OT-RFC-27) that both funding contracts
 *         apply, `ServiceSubscriptions` from a Conviction Account and
 *         `ServiceSubscriptionsWallet` from a wallet: the pause and the
 *         activation, which epoch a subscription may be for, its id, its
 *         budgets, and how a top-up merges into them. Internal functions, so
 *         each contract carries the same code and no library is linked.
 *
 * A subscription is for one chain epoch. A buyer funds at most one subscription
 * per epoch, for the current epoch or the next one, so a buyer node can fund
 * the next subscription before the boundary.
 */
library SubscriptionLib {
    uint8 internal constant CLASS_INFERENCE = 1;
    uint8 internal constant CLASS_QUERY = 2;

    /// @notice A top-up's additions, merged into a subscription's stored
    /// budgets.
    struct TopUp {
        uint96 value; // what it adds, before the discount
        uint96[] added; // per stored budget, by index, the value it adds
        ServiceSubscriptionsStorage.ServiceBudget[] appended; // its new budgets, in order
    }

    /// @dev `QueryInferenceStorage` is not paused. Returns the activation
    ///      epoch, 0 while unset.
    function requireNotPaused(QueryInferenceStorage qis) internal view returns (uint40 activation) {
        bool isPaused;
        (activation, isPaused) = qis.fundingState();
        if (isPaused) revert ISubscriptionFunding.QueryInferencePaused();
    }

    /// @dev Funding is live: `QueryInferenceStorage` is not paused, and the
    ///      current epoch is at or after the activation epoch, which is set.
    function requireLive(QueryInferenceStorage qis, Chronos chronos) internal view returns (uint256 currentEpoch) {
        uint40 activation = requireNotPaused(qis);
        currentEpoch = chronos.getCurrentEpoch();
        if (activation == 0 || currentEpoch < activation) {
            revert ISubscriptionFunding.QueryInferenceNotActive(activation, currentEpoch);
        }
    }

    /// @dev The subscription of `epoch`, which must be the current epoch or the
    ///      next one. It ends where the next epoch starts, and starts at the
    ///      later of the block time and its epoch's start: a subscription
    ///      funded during its epoch runs from now, a subscription funded ahead
    ///      from its epoch's start. Neither is ever 0, so the record always
    ///      reads as existing.
    function timesOf(
        Chronos chronos,
        uint256 epoch,
        uint256 currentEpoch
    ) internal view returns (uint40 startsAt, uint40 endsAt) {
        if (epoch != currentEpoch && epoch != currentEpoch + 1) {
            revert ISubscriptionFunding.InvalidFundingRequest("epoch");
        }
        uint256 start = chronos.timestampForEpoch(epoch);
        startsAt = SafeCast.toUint40(block.timestamp > start ? block.timestamp : start);
        endsAt = SafeCast.toUint40(chronos.timestampForEpoch(epoch + 1));
    }

    /// @dev The id of the subscription `buyer` funds for `epoch`:
    ///      `keccak256(abi.encode(buyer, epoch))`, one per buyer and epoch.
    function subscriptionIdOf(address buyer, uint256 epoch) internal pure returns (bytes32) {
        return keccak256(abi.encode(buyer, epoch));
    }

    /**
     * @dev The budgets of a funding: 1 to `maxBudgets` of them, in strictly
     *      increasing id, each of a known class, with a non-zero value and a
     *      non-zero price cap. Returns their value, which must fit a uint96.
     */
    function fundingValue(
        ServiceSubscriptionsStorage.ServiceBudget[] calldata budgets,
        uint256 maxBudgets
    ) internal pure returns (uint96 value) {
        uint256 n = budgets.length;
        if (n == 0 || n > maxBudgets) revert ISubscriptionFunding.InvalidFundingRequest("budgetCount");
        uint256 total;
        for (uint256 i; i < n; i++) {
            ServiceSubscriptionsStorage.ServiceBudget calldata b = budgets[i];
            if (i > 0 && b.serviceId <= budgets[i - 1].serviceId) {
                revert ISubscriptionFunding.InvalidFundingRequest("budgetOrder");
            }
            _requireNewBudgetTerms(b);
            total += b.value;
        }
        value = toValue(total);
    }

    /// @dev A subscription value, which must fit a uint96.
    function toValue(uint256 total) internal pure returns (uint96) {
        if (total > type(uint96).max) revert ISubscriptionFunding.InvalidFundingRequest("value");
        return uint96(total);
    }

    /**
     * @dev A top-up of the recorded subscription `s` is open to `buyer`: the
     *      subscription exists, `buyer` is the buyer that funded it, it comes
     *      from the subscription's own source (`fromAccount` for an account's
     *      subscription, a wallet for account 0), and the subscription has not
     *      ended.
     */
    function requireTopUpOpen(
        bytes32 subscriptionId,
        ServiceSubscriptionsStorage.Subscription memory s,
        address buyer,
        bool fromAccount
    ) internal view {
        if (s.startsAt == 0) revert ISubscriptionFunding.SubscriptionNotFound(subscriptionId);
        if (s.buyer != buyer) revert ISubscriptionFunding.NotSubscriptionBuyer(subscriptionId, buyer);
        if ((s.accountId != 0) != fromAccount) {
            revert ISubscriptionFunding.WrongFundingSource(subscriptionId, s.accountId);
        }
        if (block.timestamp >= s.endsAt) revert ISubscriptionFunding.SubscriptionEnded(subscriptionId, s.endsAt);
    }

    /**
     * @dev A top-up's additions, merged into the subscription's stored budgets:
     *      1 or more of them, in strictly increasing id, each with a non-zero
     *      value.
     *        - An addition with a stored budget's id adds to that budget, and
     *          must repeat its class and price cap: neither changes within a
     *          subscription, so requests signed against them stay checkable.
     *        - Any other is a new budget, under the funding rules, appended
     *          after the stored ones, so every stored budget keeps its index.
     *      Stored and new budgets together are at most `maxBudgets`, and the
     *      subscription's value after the top-up must fit a uint96.
     */
    function mergeTopUp(
        ServiceSubscriptionsStorage.ServiceBudget[] memory stored,
        ServiceSubscriptionsStorage.ServiceBudget[] calldata additions,
        uint256 maxBudgets,
        uint96 subscriptionValue
    ) internal pure returns (TopUp memory t) {
        uint256 m = additions.length;
        if (m == 0) revert ISubscriptionFunding.InvalidFundingRequest("budgetCount");
        uint256 n = stored.length;
        t.added = new uint96[](n);
        bool[] memory isNew = new bool[](m);
        uint256 newCount;
        uint256 total;

        for (uint256 j; j < m; j++) {
            ServiceSubscriptionsStorage.ServiceBudget calldata b = additions[j];
            if (j > 0 && b.serviceId <= additions[j - 1].serviceId) {
                revert ISubscriptionFunding.InvalidFundingRequest("budgetOrder");
            }
            uint256 i;
            while (i < n && stored[i].serviceId != b.serviceId) i++;
            if (i < n) {
                if (b.value == 0) revert ISubscriptionFunding.InvalidFundingRequest("budgetValue");
                if (b.serviceClass != stored[i].serviceClass || b.maxPricePerUnit != stored[i].maxPricePerUnit) {
                    revert ISubscriptionFunding.BudgetTermsChanged(b.serviceId);
                }
                t.added[i] = b.value;
            } else {
                _requireNewBudgetTerms(b);
                isNew[j] = true;
                newCount++;
            }
            total += b.value;
        }
        if (n + newCount > maxBudgets) revert ISubscriptionFunding.InvalidFundingRequest("budgetCount");
        t.value = toValue(total);
        toValue(uint256(subscriptionValue) + total);

        t.appended = new ServiceSubscriptionsStorage.ServiceBudget[](newCount);
        uint256 k;
        for (uint256 j; j < m; j++) {
            if (isNew[j]) t.appended[k++] = additions[j];
        }
    }

    /// @dev A new budget's terms: a known class, a non-zero value and a
    ///      non-zero price cap.
    function _requireNewBudgetTerms(ServiceSubscriptionsStorage.ServiceBudget calldata b) private pure {
        if (b.serviceClass != CLASS_INFERENCE && b.serviceClass != CLASS_QUERY) {
            revert ISubscriptionFunding.InvalidFundingRequest("serviceClass");
        }
        if (b.value == 0) revert ISubscriptionFunding.InvalidFundingRequest("budgetValue");
        if (b.maxPricePerUnit == 0) revert ISubscriptionFunding.InvalidFundingRequest("maxPricePerUnit");
    }
}
