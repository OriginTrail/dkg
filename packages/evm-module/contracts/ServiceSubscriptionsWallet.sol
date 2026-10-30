// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IServicePeriodFunding} from "./interfaces/IServicePeriodFunding.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ConvictionServiceStorage} from "./storage/ConvictionServiceStorage.sol";
import {QueryInferenceStorage} from "./storage/QueryInferenceStorage.sol";
import {ServicePeriodLib} from "./libraries/ServicePeriodLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 * @title ServiceSubscriptionsWallet
 * @notice Service plan periods funded from the buyer key's wallet (OT-RFC-27,
 *         "NeuroSymbolic Marketplace"): a buyer key pays one plan period per
 *         transaction in TRAC, and tops it up within the period.
 *
 * A plan period is one chain epoch, the current one or the next, and a buyer
 * key funds at most one period per epoch: wallet periods and Conviction
 * Account periods (`ServiceSubscriptions`) share one id per buyer key and
 * epoch. The period is recorded in `ConvictionServiceStorage` under account 0,
 * which no account has, with the same record, buckets and events as an
 * account's period, so sellers verify every period the same way.
 *
 * Money: the whole payment moves from the buyer key into the vault
 * (`ConvictionStakingStorage`), with no protocol fee, whether or not a
 * treasury is wired: every subscription token enters the query/inference pool.
 * It is booked to `QueryInferenceStorage` as due in the epoch after the
 * period, the epoch in which the period's receipt value first counts. The
 * payment is non-refundable, and no TRAC is ever sent to a seller.
 *
 * Architecture: stateless logic, as `ServiceSubscriptions`, whose Conviction
 * Account paths it complements; the two contracts apply the same period rules
 * through `ServicePeriodLib`. The Token, the vault, `ConvictionServiceStorage`,
 * `QueryInferenceStorage` and `Chronos` are wired at `initialize()`. Its only
 * Token call is `transferFrom` from the buyer key to the vault, made after
 * every storage write. It accepts no ETH.
 *
 * Gates: only the buyer key that funded a period tops it up, and every funding
 * and top-up is refused while `QueryInferenceStorage` is paused, before its
 * activation epoch and while that is unset. Every funding needs a non-zero
 * session key.
 */
contract ServiceSubscriptionsWallet is INamed, IVersioned, ContractStatus, IInitializable, IServicePeriodFunding {
    string private constant _NAME = "ServiceSubscriptionsWallet";
    // Version history:
    //   1.0.0 — wallet-funded plan periods of one epoch, and their top-ups and
    //           upgrades (OT-RFC-27).
    string private constant _VERSION = "1.0.0";

    /// @notice A buyer key's request to fund one plan period from its wallet:
    ///         the fields of an account's funding request, without the account.
    struct WalletFundingRequest {
        uint256 epoch; // the period's epoch: the current one or the next
        address sessionKey; // the buyer's request-signing key; never zero
        bytes32 planDigest; // the buyer's commitment to its plan, opaque here
        BucketInput[] buckets; // 1 to maxBucketsPerPeriod, strictly increasing bucketId
    }

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    IERC20 public tokenContract;
    /// @notice The vault, `ConvictionStakingStorage`, that receives every payment.
    address public stakingStorageAddress;
    ConvictionServiceStorage public convictionServiceStorage;
    QueryInferenceStorage public queryInferenceStorage;
    Chronos public chronos;

    error TokenTransferFailed();

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires every dependency. The Hub reverts `ContractDoesNotExist` for
    ///      a name it does not hold.
    function initialize() external onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        stakingStorageAddress = hub.getContractAddress("ConvictionStakingStorage");
        convictionServiceStorage = ConvictionServiceStorage(hub.getContractAddress("ConvictionServiceStorage"));
        queryInferenceStorage = QueryInferenceStorage(hub.getContractAddress("QueryInferenceStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                       Buyer actions
    // ============================================================

    /**
     * @notice Fund the plan period of `r.epoch` from the buyer key's wallet,
     *         as `msg.sender`: the buckets' whole value moves into the vault.
     *         Atomic: every refusal reverts the whole transaction.
     * @dev In order: funding is live, the session key, the period's epoch (the
     *      current one or the next), the buckets and the value by the funding
     *      rules, and one period per buyer key and epoch. Then the value is
     *      booked as due in the epoch after the period, the record is written
     *      under account 0 with a cost equal to the value and no discount,
     *      window or draw, and last the payment is pulled. The buyer key
     *      approves this contract for the value beforehand.
     * @return subscriptionId `ServiceSubscriptions.subscriptionIdOf(msg.sender, r.epoch)`.
     */
    function fundFromWallet(WalletFundingRequest calldata r) external returns (bytes32 subscriptionId) {
        ConvictionServiceStorage css = convictionServiceStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, a session key, and the period of the current
        //    epoch or the next one.
        uint256 currentEpoch = ServicePeriodLib.requireLive(qis, chronos);
        if (r.sessionKey == address(0)) revert ZeroSessionKey();
        (uint40 periodStart, uint40 periodEnd) = ServicePeriodLib.periodOf(chronos, r.epoch, currentEpoch);

        // 2. The buckets and their value.
        (ConvictionServiceStorage.Bucket[] memory buckets, uint96 value) = ServicePeriodLib.fundingBuckets(
            r.buckets,
            css.maxBucketsPerPeriod()
        );

        // 3. One period per buyer key and epoch, shared with account periods.
        subscriptionId = ServicePeriodLib.subscriptionIdOf(buyer, r.epoch);
        if (css.subscriptionExists(subscriptionId)) revert PeriodAlreadyFunded(subscriptionId);

        // 4. The value due in the epoch after the period.
        qis.addWalletDue(r.epoch + 1, value);

        // 5. The record, under account 0. The period id is the period's epoch.
        css.createSubscription(
            subscriptionId,
            ConvictionServiceStorage.Subscription({
                accountId: 0,
                assignee: buyer,
                sessionKey: r.sessionKey,
                periodId: bytes32(r.epoch),
                planDigest: r.planDigest,
                periodStart: periodStart,
                periodEnd: periodEnd,
                fundedEpoch: SafeCast.toUint40(currentEpoch),
                fundedWindow: 0,
                discountBps: 0,
                bucketCount: uint8(buckets.length),
                value: value,
                cost: value,
                drawnFromWindow: 0,
                drawnFromTopUp: 0
            }),
            buckets
        );

        // 6. The payment, after every write.
        _pull(buyer, value);

        emit PeriodFunded(
            subscriptionId,
            0,
            buyer,
            r.epoch,
            r.sessionKey,
            r.planDigest,
            periodStart,
            periodEnd,
            value,
            value,
            0,
            r.buckets
        );
    }

    /**
     * @notice Top up or upgrade a wallet-funded period, as the buyer key that
     *         funded it: add value to its buckets, or add buckets. The added
     *         value moves into the vault.
     * @dev Refused unless funding is live, the period was funded from a wallet
     *      by `msg.sender`, and it has not ended. An addition to a stored bucket repeats its
     *      class and price cap, which never change within a period; a new
     *      bucket is appended under the funding rules. The added value is due
     *      in the epoch after the period, as the period's own value is.
     * @return value The value added, and paid.
     */
    function topUpFromWallet(
        bytes32 subscriptionId,
        BucketInput[] calldata additions,
        bytes32 planDigest
    ) external returns (uint96 value) {
        ConvictionServiceStorage css = convictionServiceStorage;
        QueryInferenceStorage qis = queryInferenceStorage;
        address buyer = msg.sender;

        // 1. Funding is live, and the period is open to this top-up.
        ServicePeriodLib.requireLive(qis, chronos);
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        ServicePeriodLib.requireTopUpOpen(subscriptionId, s, buyer, false);

        // 2. The additions, merged into the stored buckets.
        ServicePeriodLib.TopUp memory t = ServicePeriodLib.mergeTopUp(
            css.getBuckets(subscriptionId),
            additions,
            css.maxBucketsPerPeriod(),
            s.value
        );
        value = t.value;

        // 3. The value due in the epoch after the period, and the record.
        qis.addWalletDue(ServicePeriodLib.epochOf(s) + 1, value);
        css.applyTopUp(
            subscriptionId,
            ConvictionServiceStorage.TopUpAmounts({value: value, cost: value, drawnFromWindow: 0, drawnFromTopUp: 0}),
            planDigest,
            t.added,
            t.appended
        );

        // 4. The payment, after every write.
        _pull(buyer, value);

        emit PeriodToppedUp(subscriptionId, 0, buyer, value, value, planDigest, additions);
    }

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev Move `amount` from `from` into the vault. The Token reverts on a
    ///      short balance or allowance; a `false` return reverts here.
    function _pull(address from, uint96 amount) internal {
        if (!tokenContract.transferFrom(from, stakingStorageAddress, amount)) revert TokenTransferFailed();
    }
}
