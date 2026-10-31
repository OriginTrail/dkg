// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ConvictionServiceStorage} from "./storage/ConvictionServiceStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {QueryInferenceStorage} from "./storage/QueryInferenceStorage.sol";
import {RandomSamplingStorage} from "./storage/RandomSamplingStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {ServicePeriodLib} from "./libraries/ServicePeriodLib.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title QueryInferenceSettlement
 * @notice Settlement of the query/inference pool of OT-RFC-27 ("NeuroSymbolic
 *         Marketplace"): Core Node sellers submit batches of buyer-signed
 *         requests with their receipts, which become claims on the buyers'
 *         funded buckets; the claims are finalized against each bucket's
 *         funded cap into the QIF inputs of the epoch after the period.
 *
 * The formats. Requests and receipts are EIP-712 typed data under the domain
 * `{name: "DKGQueryInference", version: "1", chainId, verifyingContract:
 * QueryInferenceStorage}`, built by hand as `ServiceSubscriptions` builds its
 * own. The domain binds the storage, which is never upgraded in place, so
 * requests signed but not yet submitted survive an upgrade of this contract.
 *   - `ServiceRequest`, signed by the period's session key as a 64-byte
 *     EIP-2098 compact signature with a low `s`, names the period, the
 *     bucket, the seller's identity id and a nonce unique per period and
 *     seller, and bounds the accepted unit ask, the units, the value and the
 *     time.
 *   - `QueryInferenceReceipt` is the seller's statement of what it delivered
 *     against a request. A batch carries its fields but not its
 *     `requestDigest`, which this contract recomputes; the batch's sender
 *     authenticates the seller for all of them, so no per-receipt seller
 *     signature is checked.
 *
 * A batch (`submitReceiptBatch`) is accepted only from an operational key of a
 * node that has a profile and a place in the sharding table, the checks
 * `RandomSampling.submitProof` makes, and that node is the seller of every
 * receipt in it. The contract fills in the period, the bucket and the seller
 * of each request itself, so a request signed for another seller, period or
 * bucket recovers to another address and fails as a bad signature. Every
 * objective fault OT-RFC-27 lists is checked, and any fault reverts the whole
 * batch (`ReceiptFault`), so sellers simulate first. Nothing is stored per
 * receipt: a nonce bit per request, and per bucket and seller the claimed
 * value and the same weighted by the seller's stake factor, which is
 * captured once per batch and never revised.
 *
 * Finalization (`finalizeClaims`). An epoch e has one batch deadline, its end
 * plus the receipt grace of e, which falls in e + 1, the due epoch of its
 * periods; a Conviction Account period whose assignment ended sooner has an
 * earlier deadline of its own. A seller's claims in a bucket are finalized in
 * e + 1 and only there, after the epoch's deadline, and are void once e + 1
 * has ended. Anyone may finalize, and the value goes to the seller the claim
 * names, who must have a positive node score in e + 1. A bucket's claims
 * above its funded cap all shrink by the same ratio, so the order of batches
 * gives no priority, and the result counts as R and QueryInferenceScore in
 * e + 1.
 *
 * The close (`closeEpochs`, `ensureClosed`). Epochs close in order, from the
 * activation epoch, once they have ended. An epoch's money B is what is due in
 * it (the wallet-funded value and the Conviction Account cost of the periods
 * of the epoch before) plus the carry. If no node finalized value in it, the carry becomes B and its pool is
 * 0 (rollover); otherwise its pool is B and the carry 0. The close freezes the
 * pool and λ beside the epoch's totals ΣR and ΣQueryInferenceScore, which
 * nothing writes once it has ended, so `queryInferenceGross`, a node's gross
 * reward from the pool, reads only frozen values. `previewEpochClose` and
 * `previewQueryInferenceGross` replay, in a view, the closes an open epoch is
 * still to have, so an ended epoch's pool and gross read the same before its
 * close as after it.
 *
 * Architecture: stateless logic, as `ServiceSubscriptions`. Every byte of
 * settlement state lives in `QueryInferenceStorage`, and the periods in
 * `ConvictionServiceStorage`. The storages it reads or writes, and `Chronos`,
 * are wired at `initialize()`. It never calls the Token, moves no TRAC, and
 * accepts no ETH: no TRAC is ever sent to a seller.
 *
 * Gates: every batch and finalization is refused while
 * `QueryInferenceStorage` is paused, before its activation epoch and while that
 * is unset.
 */
contract QueryInferenceSettlement is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "QueryInferenceSettlement";
    // Version history:
    //   1.0.0 — receipt batches, their finalization against the funded cap,
    //           the epoch close of the query/inference pool, and a preview of
    //           an open epoch's close (OT-RFC-27).
    string private constant _VERSION = "1.0.0";

    uint256 internal constant _SCALE18 = 1e18;
    uint256 internal constant _BPS = 10_000;

    // EIP-712, built by hand as ServiceSubscriptions builds its domain.
    bytes32 private constant _EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _EIP712_NAME_HASH = keccak256(bytes("DKGQueryInference"));
    bytes32 private constant _EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 public constant SERVICE_REQUEST_TYPEHASH =
        keccak256(
            "ServiceRequest(bytes32 subscriptionId,bytes32 bucketId,uint72 seller,uint64 nonce,uint96 acceptedAskWeiPerUnit,uint64 maxUnits,uint96 maxValueWei,uint40 issuedAt,uint40 expiry)"
        );
    bytes32 public constant QUERY_INFERENCE_RECEIPT_TYPEHASH =
        keccak256(
            "QueryInferenceReceipt(bytes32 requestDigest,bytes32 resultCommitment,uint64 units,uint96 valueWei,uint40 completedAt)"
        );
    /// @dev floor(secp256k1n / 2). A signature with a larger `s` is the
    ///      malleated twin of a low-`s` one and is refused; solady's recovery
    ///      does not check this itself.
    uint256 private constant _SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    /// @dev The low 255 bits of an EIP-2098 `vs`: its `s`.
    uint256 private constant _S_MASK = (uint256(1) << 255) - 1;
    /// @dev Nothing is cached yet: no nonce word, whose index is at most
    ///      2^56 − 1, and no epoch.
    uint256 private constant _NONE = type(uint256).max;

    // ============================================================
    //                          Formats
    // ============================================================

    /// @notice A buyer's authorization of one call, signed by the period's
    ///         session key.
    struct ServiceRequest {
        bytes32 subscriptionId; // the funded period
        bytes32 bucketId; // the bucket's model or service
        uint72 seller; // the seller Core Node's identity id
        uint64 nonce; // unique per period and seller
        uint96 acceptedAskWeiPerUnit; // the seller's unit ask, which the buyer accepted
        uint64 maxUnits;
        uint96 maxValueWei; // the most the receipt may be worth
        uint40 issuedAt;
        uint40 expiry;
    }

    /// @notice The seller's statement of what it delivered against a request.
    struct QueryInferenceReceipt {
        bytes32 requestDigest; // the EIP-712 digest of the request it answers
        bytes32 resultCommitment; // the seller's hash of the result it returned
        uint64 units; // units delivered, at most maxUnits
        uint96 valueWei; // units × acceptedAskWeiPerUnit
        uint40 completedAt;
    }

    // ============================================================
    //                          Inputs
    // ============================================================

    /// @notice One receipt in a batch: its request's own fields (the period,
    ///         the bucket and the seller come from the group and the sender),
    ///         the receipt's fields but its request digest, and the session
    ///         key's compact signature over the request.
    struct ReceiptItem {
        uint64 nonce;
        uint96 acceptedAskWeiPerUnit;
        uint64 maxUnits;
        uint96 maxValueWei;
        uint40 issuedAt;
        uint40 expiry;
        uint64 units;
        uint96 valueWei;
        bytes32 resultCommitment;
        uint40 completedAt;
        bytes32 sigR;
        bytes32 sigVS;
    }

    /// @notice The receipts of one bucket of one period.
    struct ReceiptGroup {
        bytes32 subscriptionId;
        uint8 bucketIndex; // the bucket's index in the period, its funding order
        ReceiptItem[] items;
    }

    /// @notice A seller's claim in one bucket of one period.
    struct ClaimRef {
        bytes32 subscriptionId;
        uint8 bucketIndex;
        uint72 seller; // the seller's identity id
    }

    /// @notice Why a claim was not finalized. A skipped claim is untouched.
    enum Skip {
        None, // finalized
        UnknownPeriod, // no period is recorded under the id
        UnknownBucket, // the period has no bucket at the index
        AlreadyFinalized,
        TooEarly, // before the batch deadline of the period's epoch
        Void, // the epoch after the period has ended: the claim never counts
        NothingClaimed,
        NoScore // the seller has no node score in the current epoch, yet
    }

    /// @notice Why a batch is refused: a group's fault, or an item's.
    enum Fault {
        None,
        // A group's.
        UnknownPeriod, // no period is recorded under the id
        UnknownBucket, // the period has no bucket at the index
        PastDeadline, // after the period's batch deadline
        EmptyGroup, // no items
        // An item's: the faults OT-RFC-27 lists.
        BadSignature, // not signed by the session key, or for another seller, period or bucket
        InactiveAssignment, // issued once the Conviction Account assignment had ended
        DuplicateNonce, // the nonce is used, earlier or in this batch
        OutsideTime, // outside the period, completed before issue, or after expiry
        AskOutOfRange, // a zero ask, or one above the bucket's price cap
        BadArithmetic, // zero or too many units, a value other than units × ask, or above the maximum
        ZeroResultCommitment // no result commitment
    }

    // ============================================================
    //                  Hub-wired dependencies
    // ============================================================

    QueryInferenceStorage public queryInferenceStorage;
    ConvictionServiceStorage public convictionServiceStorage;
    Chronos public chronos;
    IdentityStorage public identityStorage;
    ProfileStorage public profileStorage;
    ShardingTableStorage public shardingTableStorage;
    RandomSamplingStorage public randomSamplingStorage;
    ConvictionStakingStorage public convictionStakingStorage;
    ParametersStorage public parametersStorage;

    // ============================================================
    //                          Events
    // ============================================================

    /// @notice A group of `itemCount` receipts was claimed: `value` of receipt
    ///         value on the bucket, by `seller`, at the batch's stake factor.
    ///         `groupDigest` is the hash of the group's receipt digests, in
    ///         order, so a buyer finds its receipts.
    event ReceiptsClaimed(
        bytes32 indexed subscriptionId,
        uint8 indexed bucketIndex,
        uint72 indexed seller,
        uint256 itemCount,
        uint96 value,
        uint256 stakeFactor18,
        bytes32 groupDigest
    );
    /// @notice A batch was accepted. `batchDigest` is the hash of all its
    ///         receipt digests, in order.
    event ReceiptBatchAccepted(
        uint72 indexed seller,
        bytes32 batchDigest,
        uint256 itemCount,
        uint256 value,
        uint256 stakeFactor18
    );

    /// @notice A seller's claim in a bucket was finalized: of `claimed`,
    ///         `value` counts as its R and `score` as its QueryInferenceScore
    ///         in `epoch`, the epoch after the period.
    event ClaimsFinalized(
        bytes32 indexed subscriptionId,
        uint8 indexed bucketIndex,
        uint72 indexed seller,
        uint256 epoch,
        uint96 claimed,
        uint96 value,
        uint96 score
    );
    /// @notice A claim named in `finalizeClaims` was not finalized, for
    ///         `reason`.
    event ClaimSkipped(bytes32 indexed subscriptionId, uint8 indexed bucketIndex, uint72 indexed seller, Skip reason);
    /// @notice Epoch `epoch` closed: `walletDue` and `convictionDue` were due
    ///         in it and `carryIn` carried into it; `pool` is what its nodes
    ///         share, by ΣR `sumR`, ΣQueryInferenceScore `sumScore` and λ
    ///         `lambdaBps`. The carry out is
    ///         `walletDue + convictionDue + carryIn − pool`.
    event EpochClosed(
        uint256 indexed epoch,
        uint96 walletDue,
        uint96 convictionDue,
        uint96 carryIn,
        uint96 pool,
        uint128 sumR,
        uint128 sumScore,
        uint16 lambdaBps
    );

    // ============================================================
    //                          Errors
    // ============================================================

    /// @notice The sender's node has a profile but no place in the sharding
    ///         table.
    error NodeNotInShardingTable(uint72 identityId);
    /// @notice A batch has 1 to `maxGroupsPerBatch` groups and 1 to
    ///         `maxItemsPerBatch` items.
    error BatchOutOfBounds(uint256 groupCount, uint256 itemCount);
    /// @notice Group `groupIndex` of the batch is refused.
    error GroupFault(uint256 groupIndex, Fault fault);
    /// @notice Item `itemIndex` of group `groupIndex` of the batch is refused.
    error ReceiptFault(uint256 groupIndex, uint256 itemIndex, Fault fault);
    /// @notice `QueryInferenceStorage` is paused.
    error QueryInferencePaused();
    /// @notice The current epoch is before the activation epoch, or that is
    ///         still unset (0).
    error QueryInferenceNotActive(uint40 activationEpoch, uint256 currentEpoch);
    /// @notice `epoch` is still open after a bounded close, which reached
    ///         `closedThrough`. Anyone clears it with `closeEpochs`, and an
    ///         epoch that has not ended yet cannot be closed.
    error QueryInferenceCloseBehind(uint256 closedThrough, uint256 epoch);

    // ============================================================
    //                    Working records
    // ============================================================

    /// @dev What a batch keeps across its groups.
    struct Batch {
        uint72 seller;
        uint256 stakeFactor18;
        bytes32 domain;
        bytes32[] digests; // every receipt digest, in order
        uint256 next; // the next free index in `digests`
        uint256 value;
        uint256 graceEpoch; // the epoch whose grace `grace` is, or _NONE
        uint256 grace;
    }

    /// @dev What every item of a group is checked against.
    struct Terms {
        address sessionKey;
        uint256 periodStart;
        uint256 periodEnd;
        uint256 assignmentEnd; // when a Conviction Account assignment ended; max for a wallet period
        bytes32 bucketId;
        uint256 maxAsk;
    }

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires every dependency. The Hub reverts `ContractDoesNotExist` for
    ///      a name it does not hold.
    function initialize() external onlyHub {
        queryInferenceStorage = QueryInferenceStorage(hub.getContractAddress("QueryInferenceStorage"));
        convictionServiceStorage = ConvictionServiceStorage(hub.getContractAddress("ConvictionServiceStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        randomSamplingStorage = RandomSamplingStorage(hub.getContractAddress("RandomSamplingStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                       Receipt batches
    // ============================================================

    /**
     * @notice Claim the receipts of `groups` as the seller, the node whose
     *         operational key sends the transaction. All or nothing: any
     *         fault reverts the whole batch.
     * @dev    The sender's node must have a profile and a place in the
     *         sharding table. The batch has 1 to `maxGroupsPerBatch` groups
     *         and 1 to `maxItemsPerBatch` items, and its stake factor is
     *         captured once, before the groups.
     *
     *         A group names a recorded period and one of its buckets, has
     *         items, and lands by the period's batch deadline: the period's
     *         end, or for a Conviction Account period the end of its
     *         assignment if that comes sooner, plus the receipt grace of the
     *         period's epoch. Each item then passes, in order:
     *           1. its request, rebuilt with the group's period and bucket and
     *              the sender's identity, recovers with a low `s` to the
     *              period's session key;
     *           2. for a Conviction Account period, it was issued before the
     *              assignment ended (its expiry, or its revocation if sooner);
     *           3. its nonce is unused, earlier and in this batch;
     *           4. periodStart <= issuedAt < periodEnd, and
     *              issuedAt <= completedAt <= min(expiry, periodEnd);
     *           5. 0 < acceptedAskWeiPerUnit <= the bucket's price cap;
     *           6. 0 < units <= maxUnits, valueWei == units × ask in 256 bits,
     *              and valueWei <= maxValueWei;
     *           7. a non-zero result commitment.
     *         A claim above the bucket's funded value is accepted: the cap
     *         applies at finalization, to every seller of the bucket alike.
     * @return batchDigest The hash of the batch's receipt digests, in order.
     */
    function submitReceiptBatch(ReceiptGroup[] calldata groups) external returns (bytes32 batchDigest) {
        QueryInferenceStorage qis = queryInferenceStorage;
        (uint40 activation, bool isPaused, uint8 maxGroups, uint16 maxItems) = qis.batchState();
        _requireLive(activation, isPaused);
        uint72 seller = _coreNodeOf(msg.sender);

        uint256 groupCount = groups.length;
        uint256 itemCount;
        for (uint256 g; g < groupCount; g++) {
            itemCount += groups[g].items.length;
        }
        if (groupCount == 0 || groupCount > maxGroups || itemCount == 0 || itemCount > maxItems) {
            revert BatchOutOfBounds(groupCount, itemCount);
        }

        Batch memory b = Batch({
            seller: seller,
            stakeFactor18: stakeFactor(seller),
            domain: domainSeparator(),
            digests: new bytes32[](itemCount),
            next: 0,
            value: 0,
            graceEpoch: _NONE,
            grace: 0
        });
        for (uint256 g; g < groupCount; g++) {
            _acceptGroup(qis, b, g, groups[g]);
        }

        bytes32[] memory digests = b.digests;
        assembly ("memory-safe") {
            batchDigest := keccak256(add(digests, 0x20), shl(5, mload(digests)))
        }
        emit ReceiptBatchAccepted(seller, batchDigest, itemCount, b.value, b.stakeFactor18);
    }

    // ============================================================
    //                        Finalization
    // ============================================================

    /**
     * @notice Finalize the claims of `refs`, each a seller's claim in one
     *         bucket. Anyone may call; the value goes to the seller a ref
     *         names.
     * @dev    The call reverts only for what holds for every ref: the pause
     *         and activation. A ref that cannot be finalized now is skipped,
     *         untouched, with a `ClaimSkipped` event naming why, so a keeper
     *         can finalize for many sellers in one call. In order of the
     *         checks: the period and the bucket exist; the claim is not
     *         finalized; for a period of epoch e, the current epoch is e + 1
     *         and the time is after the batch deadline of e, the epoch's end
     *         plus the grace of e (before it, `TooEarly`; from e + 2 on,
     *         `Void`); something was claimed; and the seller has a positive
     *         node score in the current epoch.
     *
     *         The window opens at the epoch's batch deadline even for a
     *         Conviction Account period whose own deadline came sooner: a new
     *         assignment of its buyer key clears a revocation, which could
     *         otherwise let batches for it land again after some of its claims
     *         were finalized. No period's deadline is later than its epoch's,
     *         so no batch lands once the window is open, and a bucket needs no
     *         close time.
     *
     *         With F the bucket's funded cap and C its claims over all
     *         sellers, the seller's claim c and weighted claim w count as
     *         c × min(1, F / C) and w × min(1, F / C), floored, in the current
     *         epoch.
     * @return finalized How many refs were finalized.
     */
    function finalizeClaims(ClaimRef[] calldata refs) external returns (uint256 finalized) {
        QueryInferenceStorage qis = queryInferenceStorage;
        (uint40 activation, bool isPaused) = qis.fundingState();
        uint256 current = _requireLive(activation, isPaused);
        uint256 graceEpoch = _NONE;
        uint256 grace;
        for (uint256 i; i < refs.length; i++) {
            ClaimRef calldata ref = refs[i];
            ConvictionServiceStorage.Subscription memory s = convictionServiceStorage.getSubscription(
                ref.subscriptionId
            );
            uint256 epoch = ServicePeriodLib.epochOf(s);
            if (s.periodStart != 0 && epoch != graceEpoch) {
                grace = qis.receiptGraceSecondsAt(epoch);
                graceEpoch = epoch;
            }
            Skip reason = _finalize(qis, ref, s, current, grace);
            if (reason == Skip.None) {
                finalized++;
            } else {
                emit ClaimSkipped(ref.subscriptionId, ref.bucketIndex, ref.seller, reason);
            }
        }
    }

    // ============================================================
    //                           Close
    // ============================================================

    /**
     * @notice Close ended epochs in order, from the one after `closedThrough`,
     *         at most `maxSteps` of them. Permissionless.
     * @dev    Nothing closes while the activation epoch is unset, and no epoch
     *         closes before it has ended. The close itself never divides, so
     *         it reverts only if an epoch's money exceeded a uint96, beyond
     *         every TRAC there is.
     * @return closed The last closed epoch after the call.
     */
    function closeEpochs(uint256 maxSteps) external returns (uint256 closed) {
        (closed, ) = _closeThrough(type(uint256).max, maxSteps, false);
    }

    /**
     * @notice Make sure `epoch` is closed, closing the epochs up to it in
     *         order, at most `maxCloseStepsPerClaim` of them. A reward claim
     *         calls it before it reads an epoch.
     * @dev    An epoch before the activation epoch, or any while that is
     *         unset, never closes, and returns at once. If `epoch` is still
     *         open after the bounded close, because the closes are further
     *         behind or because it has not ended, it reverts
     *         `QueryInferenceCloseBehind`; `closeEpochs` clears the first.
     * @return closed The last closed epoch after the call.
     */
    function ensureClosed(uint256 epoch) external returns (uint256 closed) {
        uint256 activation;
        (closed, activation) = _closeThrough(epoch, 0, true);
        if (activation == 0 || epoch < activation) return closed;
        if (closed < epoch) revert QueryInferenceCloseBehind(closed, epoch);
    }

    // ============================================================
    //                           Views
    // ============================================================

    /// @notice The query/inference pool epoch `epoch`'s nodes share, frozen at
    ///         its close; 0 while it is open.
    function epochPool(uint256 epoch) external view returns (uint96) {
        QueryInferenceStorage.EpochClose memory c = queryInferenceStorage.getEpochClose(epoch);
        return c.closed ? c.pool : 0;
    }

    /**
     * @notice Node `identityId`'s gross reward from the query/inference pool
     *         of `epoch`: pool × QIF, as OT-RFC-27 defines it,
     *         floor(pool × (1 − λ) × R / ΣR) + floor(pool × λ × QIS / ΣQIS),
     *         over the values frozen at the close. If ΣQIS is 0 while ΣR is
     *         not, which needs every seller's stake factor to be 0, the second
     *         term takes the R share. 0 for an epoch still open, an empty pool
     *         or a node with no finalized value. Over all nodes it sums to at
     *         most the pool.
     */
    function queryInferenceGross(uint256 epoch, uint72 identityId) external view returns (uint256 gross) {
        QueryInferenceStorage qis = queryInferenceStorage;
        QueryInferenceStorage.EpochClose memory c = qis.getEpochClose(epoch);
        if (c.closed) gross = _gross(qis, epoch, identityId, c.pool, c.lambdaBps);
    }

    /**
     * @notice The pool epoch `epoch`'s nodes share and its λ, as its close
     *         freezes them: the frozen values once it has closed and, while
     *         it is open, its close previewed by replaying the closes from the
     *         one after `closedThrough` through `epoch`, over the money due
     *         and the carry as they stand, by the rule of the close. Exact for
     *         an epoch that has ended, in which no money is booked and no
     *         claim is finalized any more; for one that has not, the close as
     *         if it ended now. (0, 0) for an epoch before the activation
     *         epoch, or any while that is unset: those never close.
     */
    function previewEpochClose(uint256 epoch) public view returns (uint96 pool, uint16 lambdaBps) {
        QueryInferenceStorage qis = queryInferenceStorage;
        QueryInferenceStorage.EpochClose memory c = qis.getEpochClose(epoch);
        if (c.closed) return (c.pool, c.lambdaBps);
        (uint40 activation, uint256 closed, uint96 carryIn, ) = qis.closeState();
        // Epochs up to `closedThrough` that are not closed precede activation.
        if (activation == 0 || epoch <= closed) return (0, 0);
        // The rule of `_closeEpoch`: an epoch's money is the wallet value and
        // the Conviction Account cost due in it and the carry, its pool if a
        // node finalized value in it, and the carry out otherwise.
        for (uint256 e = closed + 1; e <= epoch; e++) {
            (uint96 wallet, uint96 conviction) = _incoming(qis, e);
            uint96 money = SafeCast.toUint96(uint256(wallet) + conviction + carryIn);
            if (qis.getEpochTotals(e).sumR == 0) {
                (pool, carryIn) = (0, money);
            } else {
                (pool, carryIn) = (money, 0);
            }
        }
        lambdaBps = qis.lambdaBpsAt(epoch);
    }

    /// @notice `queryInferenceGross` over `previewEpochClose`: node
    ///         `identityId`'s gross reward from the pool of `epoch`, frozen
    ///         once it has closed and previewed while it is open. For an epoch
    ///         that has ended, what `queryInferenceGross` reads once it closes.
    function previewQueryInferenceGross(uint256 epoch, uint72 identityId) external view returns (uint256) {
        (uint96 pool, uint16 lambdaBps) = previewEpochClose(epoch);
        return _gross(queryInferenceStorage, epoch, identityId, pool, lambdaBps);
    }

    /// @notice The EIP-712 domain separator of requests and receipts: name
    ///         `DKGQueryInference`, version `1`, this chain and
    ///         `QueryInferenceStorage`.
    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _EIP712_DOMAIN_TYPEHASH,
                    _EIP712_NAME_HASH,
                    _EIP712_VERSION_HASH,
                    block.chainid,
                    address(queryInferenceStorage)
                )
            );
    }

    /// @notice The EIP-712 digest of a request, which the session key signs.
    function hashRequest(ServiceRequest calldata r) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                SERVICE_REQUEST_TYPEHASH,
                r.subscriptionId,
                r.bucketId,
                r.seller,
                r.nonce,
                r.acceptedAskWeiPerUnit,
                r.maxUnits,
                r.maxValueWei,
                r.issuedAt,
                r.expiry
            )
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
    }

    /// @notice The EIP-712 digest of a receipt, which the seller signs off
    ///         chain and which batch digests are built from.
    function hashReceipt(QueryInferenceReceipt calldata r) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                QUERY_INFERENCE_RECEIPT_TYPEHASH,
                r.requestDigest,
                r.resultCommitment,
                r.units,
                r.valueWei,
                r.completedAt
            )
        );
        return MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
    }

    /**
     * @notice The stake factor S a batch from `identityId` captures now, with
     *         18 decimals: sqrt(min(stake, maximumStake) / maximumStake), the
     *         factor of the node score, computed as `RandomSampling` computes
     *         it.
     * @dev    The stake is the lower of the node's live effective stake and the
     *         snapshot its current proof challenge took, so stake added for one
     *         block lifts no factor, as for proofs. With no snapshot, the live
     *         stake is used.
     */
    function stakeFactor(uint72 identityId) public view returns (uint256) {
        uint256 stake = convictionStakingStorage.getNodeEffectiveStake(identityId);
        RandomSamplingStorage rss = randomSamplingStorage;
        if (rss.nodeChallengeStakeSnapshotSet(identityId)) {
            uint256 snapshot = rss.nodeChallengeStakeSnapshot(identityId);
            if (snapshot < stake) stake = snapshot;
        }
        uint256 cap = uint256(parametersStorage.maximumStake());
        if (stake > cap) stake = cap;
        return Math.sqrt(((stake * _SCALE18) / cap) * _SCALE18);
    }

    /**
     * @notice The batch deadline of a period: the last time a batch for it
     *         lands. It is the period's end plus the receipt grace of its
     *         epoch, or, for a Conviction Account period whose assignment has
     *         ended sooner (its expiry, or its revocation), that end plus the
     *         grace. 0 for an unknown period.
     */
    function batchDeadline(bytes32 subscriptionId) external view returns (uint256) {
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        if (s.periodStart == 0) return 0;
        uint256 end = s.periodEnd;
        if (s.accountId != 0) {
            uint256 assignmentEnd = _assignmentEnd(css.getAssignment(s.accountId, s.assignee));
            if (assignmentEnd < end) end = assignmentEnd;
        }
        return end + queryInferenceStorage.receiptGraceSecondsAt(ServicePeriodLib.epochOf(s));
    }

    /**
     * @notice A bucket's funded cap: the most receipt value its claims
     *         finalize to. The bucket's value, top-ups included, for a wallet
     *         period; for a Conviction Account period, that value at the
     *         account's discount, floored, so sellers absorb the discount. 0
     *         for an unknown period or bucket.
     */
    function fundedCap(bytes32 subscriptionId, uint8 bucketIndex) external view returns (uint256) {
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        if (s.periodStart == 0 || bucketIndex >= s.bucketCount) return 0;
        return _fundedCap(s, css.getBucket(subscriptionId, bucketIndex).value);
    }

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev Finalize one claim, or say why not; see `finalizeClaims`. `s` is
    ///      the ref's period record and `grace` the receipt grace of its epoch.
    function _finalize(
        QueryInferenceStorage qis,
        ClaimRef calldata ref,
        ConvictionServiceStorage.Subscription memory s,
        uint256 current,
        uint256 grace
    ) internal returns (Skip) {
        if (s.periodStart == 0) return Skip.UnknownPeriod;
        if (ref.bucketIndex >= s.bucketCount) return Skip.UnknownBucket;
        QueryInferenceStorage.SellerClaim memory c = qis.getSellerClaim(
            ref.subscriptionId,
            ref.bucketIndex,
            ref.seller
        );
        if (c.finalized) return Skip.AlreadyFinalized;
        uint256 epoch = ServicePeriodLib.epochOf(s);
        if (current > epoch + 1) return Skip.Void;
        if (current <= epoch || block.timestamp <= uint256(s.periodEnd) + grace) return Skip.TooEarly;
        if (c.claimed == 0) return Skip.NothingClaimed;
        if (randomSamplingStorage.getNodeEpochScore(current, ref.seller) == 0) return Skip.NoScore;

        uint256 cap = _fundedCap(s, convictionServiceStorage.getBucket(ref.subscriptionId, ref.bucketIndex).value);
        uint256 total = qis.bucketClaimed(ref.subscriptionId, ref.bucketIndex);
        uint96 value = c.claimed;
        uint96 score = c.weighted;
        if (total > cap) {
            value = uint96(Math.mulDiv(value, cap, total));
            score = uint96(Math.mulDiv(score, cap, total));
        }
        qis.finalizeClaim(ref.subscriptionId, ref.bucketIndex, ref.seller, current, value, score);
        emit ClaimsFinalized(ref.subscriptionId, ref.bucketIndex, ref.seller, current, c.claimed, value, score);
        return Skip.None;
    }

    /**
     * @dev Close epochs in order up to `through`, or the last ended epoch if
     *      sooner, at most `maxSteps` of them, or `maxCloseStepsPerClaim` when
     *      `bounded`. Returns the last closed epoch, and the activation epoch.
     */
    function _closeThrough(
        uint256 through,
        uint256 maxSteps,
        bool bounded
    ) internal returns (uint256 closed, uint256 activation) {
        QueryInferenceStorage qis = queryInferenceStorage;
        uint96 carried;
        uint8 claimSteps;
        (activation, closed, carried, claimSteps) = qis.closeState();
        if (activation == 0 || through <= closed) return (closed, activation);
        if (bounded) maxSteps = claimSteps;

        // An epoch has ended once the current epoch is after it.
        uint256 last = chronos.getCurrentEpoch() - 1;
        if (through < last) last = through;
        uint96 carryIn = carried;
        for (uint256 steps; steps < maxSteps && closed < last; steps++) {
            closed++;
            carryIn = _closeEpoch(qis, closed, carryIn);
        }
    }

    /// @dev Close `epoch`: its money is its incoming money and `carryIn`,
    ///      which become its pool if a node finalized value in it, and the
    ///      carry out otherwise.
    function _closeEpoch(QueryInferenceStorage qis, uint256 epoch, uint96 carryIn) internal returns (uint96 carryOut) {
        (uint96 wallet, uint96 conviction) = _incoming(qis, epoch);
        QueryInferenceStorage.EpochTotals memory t = qis.getEpochTotals(epoch);
        uint16 lambda = qis.lambdaBpsAt(epoch);
        uint96 money = SafeCast.toUint96(uint256(wallet) + conviction + carryIn);
        uint96 pool;
        if (t.sumR == 0) {
            carryOut = money;
        } else {
            pool = money;
        }
        qis.closeEpoch(epoch, pool, lambda, carryOut);
        emit EpochClosed(epoch, wallet, conviction, carryIn, pool, t.sumR, t.sumScore, lambda);
    }

    /// @dev The money that joins `epoch`'s pool at its close, beside the
    ///      carry: the wallet-funded value and the Conviction Account cost due
    ///      in it. Every source of an epoch's money is read here, and only here.
    function _incoming(QueryInferenceStorage qis, uint256 epoch) internal view returns (uint96 wallet, uint96 conviction) {
        return qis.dueIn(epoch);
    }

    /// @dev Node `identityId`'s pool × QIF in `epoch`, for a pool `pool` and λ
    ///      `lambda`, over the epoch's totals; see `queryInferenceGross`.
    function _gross(
        QueryInferenceStorage qis,
        uint256 epoch,
        uint72 identityId,
        uint256 pool,
        uint256 lambda
    ) internal view returns (uint256 gross) {
        if (pool == 0) return 0;
        QueryInferenceStorage.NodeEpoch memory n = qis.getNodeEpoch(identityId, epoch);
        // A node's score never exceeds its value, so no value means no score.
        if (n.r == 0) return 0;
        QueryInferenceStorage.EpochTotals memory t = qis.getEpochTotals(epoch);

        gross = Math.mulDiv(pool * (_BPS - lambda), n.r, _BPS * uint256(t.sumR));
        if (lambda != 0) {
            gross += t.sumScore == 0
                ? Math.mulDiv(pool * lambda, n.r, _BPS * uint256(t.sumR))
                : Math.mulDiv(pool * lambda, n.score, _BPS * uint256(t.sumScore));
        }
    }

    /// @dev The funded cap of a bucket of value `value` in period `s`.
    function _fundedCap(ConvictionServiceStorage.Subscription memory s, uint256 value) internal pure returns (uint256) {
        if (s.accountId == 0) return value;
        return (value * (_BPS - uint256(s.discountBps))) / _BPS;
    }

    /**
     * @dev Check one group and claim its value. Used nonces are kept per
     *      group in one cached word of the seller's bitmap, read from the
     *      storage when the word changes and written back, with this group's
     *      bits, before another is read and at the end, so a later group of
     *      the same period and seller reads them.
     */
    function _acceptGroup(QueryInferenceStorage qis, Batch memory b, uint256 g, ReceiptGroup calldata group) internal {
        uint256 n = group.items.length;
        if (n == 0) revert GroupFault(g, Fault.EmptyGroup);
        bytes32 subscriptionId = group.subscriptionId;
        Terms memory t = _termsOf(qis, b, g, subscriptionId, group.bucketIndex);

        uint256 first = b.next;
        uint256 value;
        uint256 word = _NONE;
        uint256 stored; // the cached word's bits in the storage
        uint256 used; // the bits this group sets in it
        for (uint256 j; j < n; j++) {
            ReceiptItem calldata it = group.items[j];
            bytes32 requestDigest = _requestDigest(b.domain, subscriptionId, t.bucketId, b.seller, it);

            // 1. Signed by the session key, for this seller, period and bucket.
            if (!_signedBy(requestDigest, it.sigR, it.sigVS, t.sessionKey)) _fault(g, j, Fault.BadSignature);
            // 2. Issued while the Conviction Account assignment was live.
            uint256 issuedAt = it.issuedAt;
            if (issuedAt >= t.assignmentEnd) _fault(g, j, Fault.InactiveAssignment);
            // 3. An unused nonce.
            uint256 nonce = it.nonce;
            if (nonce >> 8 != word) {
                if (used != 0) qis.useNonces(subscriptionId, b.seller, uint64(word), used);
                word = nonce >> 8;
                stored = qis.nonceWord(subscriptionId, b.seller, uint64(word));
                used = 0;
            }
            uint256 bit = uint256(1) << (nonce & 0xff);
            if ((stored | used) & bit != 0) _fault(g, j, Fault.DuplicateNonce);
            used |= bit;
            // 4. Within the period, and completed between issue and expiry.
            uint256 completedAt = it.completedAt;
            if (
                issuedAt < t.periodStart ||
                issuedAt >= t.periodEnd ||
                completedAt < issuedAt ||
                completedAt > it.expiry ||
                completedAt > t.periodEnd
            ) _fault(g, j, Fault.OutsideTime);
            // 5. An ask within the bucket's price cap.
            uint256 ask = it.acceptedAskWeiPerUnit;
            if (ask == 0 || ask > t.maxAsk) _fault(g, j, Fault.AskOutOfRange);
            // 6. Possible arithmetic, at exactly the signed ask.
            uint256 units = it.units;
            uint256 itemValue = it.valueWei;
            if (units == 0 || units > it.maxUnits || units * ask != itemValue || itemValue > it.maxValueWei) {
                _fault(g, j, Fault.BadArithmetic);
            }
            // 7. A result commitment.
            if (it.resultCommitment == bytes32(0)) _fault(g, j, Fault.ZeroResultCommitment);

            value += itemValue;
            b.digests[b.next++] = _receiptDigest(b.domain, requestDigest, it);
        }
        if (used != 0) qis.useNonces(subscriptionId, b.seller, uint64(word), used);

        uint96 claimed = SafeCast.toUint96(value);
        qis.addClaim(subscriptionId, group.bucketIndex, b.seller, claimed, uint96((value * b.stakeFactor18) / _SCALE18));
        b.value += value;

        bytes32 groupDigest;
        bytes32[] memory digests = b.digests;
        assembly ("memory-safe") {
            groupDigest := keccak256(add(add(digests, 0x20), shl(5, first)), shl(5, n))
        }
        emit ReceiptsClaimed(subscriptionId, group.bucketIndex, b.seller, n, claimed, b.stakeFactor18, groupDigest);
    }

    /// @dev A group's period and bucket exist, and the batch lands by the
    ///      period's batch deadline. Returns what its items are checked
    ///      against.
    function _termsOf(
        QueryInferenceStorage qis,
        Batch memory b,
        uint256 g,
        bytes32 subscriptionId,
        uint8 bucketIndex
    ) internal view returns (Terms memory t) {
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        if (s.periodStart == 0) revert GroupFault(g, Fault.UnknownPeriod);
        if (bucketIndex >= s.bucketCount) revert GroupFault(g, Fault.UnknownBucket);

        t.sessionKey = s.sessionKey;
        t.periodStart = s.periodStart;
        t.periodEnd = s.periodEnd;
        t.assignmentEnd = type(uint256).max;
        uint256 usableUntil = s.periodEnd;
        if (s.accountId != 0) {
            t.assignmentEnd = _assignmentEnd(css.getAssignment(s.accountId, s.assignee));
            if (t.assignmentEnd < usableUntil) usableUntil = t.assignmentEnd;
        }

        uint256 epoch = ServicePeriodLib.epochOf(s);
        if (epoch != b.graceEpoch) {
            b.grace = qis.receiptGraceSecondsAt(epoch);
            b.graceEpoch = epoch;
        }
        if (block.timestamp > usableUntil + b.grace) revert GroupFault(g, Fault.PastDeadline);

        ConvictionServiceStorage.Bucket memory bucket = css.getBucket(subscriptionId, bucketIndex);
        t.bucketId = bucket.bucketId;
        t.maxAsk = bucket.maxAskWeiPerUnit;
    }

    /// @dev When a Conviction Account assignment ended or ends: its expiry, or
    ///      its revocation if that is sooner. The built revocation does not
    ///      check the expiry, so a revocation can come after it.
    function _assignmentEnd(ConvictionServiceStorage.Assignment memory a) internal pure returns (uint256 end) {
        end = a.expiresAt;
        if (a.revokedAt != 0 && a.revokedAt < end) end = a.revokedAt;
    }

    /// @dev The EIP-712 digest of the request an item answers, hashed in
    ///      scratch memory past the free memory pointer, so a batch's memory
    ///      does not grow with its items.
    function _requestDigest(
        bytes32 domain,
        bytes32 subscriptionId,
        bytes32 bucketId,
        uint72 seller,
        ReceiptItem calldata it
    ) internal pure returns (bytes32) {
        bytes32 typeHash = SERVICE_REQUEST_TYPEHASH;
        uint256 nonce = it.nonce;
        uint256 ask = it.acceptedAskWeiPerUnit;
        uint256 maxUnits = it.maxUnits;
        uint256 maxValue = it.maxValueWei;
        uint256 issuedAt = it.issuedAt;
        uint256 expiry = it.expiry;
        bytes32 structHash;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, typeHash)
            mstore(add(m, 0x20), subscriptionId)
            mstore(add(m, 0x40), bucketId)
            mstore(add(m, 0x60), seller)
            mstore(add(m, 0x80), nonce)
            mstore(add(m, 0xa0), ask)
            mstore(add(m, 0xc0), maxUnits)
            mstore(add(m, 0xe0), maxValue)
            mstore(add(m, 0x100), issuedAt)
            mstore(add(m, 0x120), expiry)
            structHash := keccak256(m, 0x140)
        }
        return MessageHashUtils.toTypedDataHash(domain, structHash);
    }

    /// @dev The EIP-712 digest of an item's receipt, hashed as
    ///      `_requestDigest` hashes the request.
    function _receiptDigest(
        bytes32 domain,
        bytes32 requestDigest,
        ReceiptItem calldata it
    ) internal pure returns (bytes32) {
        bytes32 typeHash = QUERY_INFERENCE_RECEIPT_TYPEHASH;
        bytes32 resultCommitment = it.resultCommitment;
        uint256 units = it.units;
        uint256 valueWei = it.valueWei;
        uint256 completedAt = it.completedAt;
        bytes32 structHash;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, typeHash)
            mstore(add(m, 0x20), requestDigest)
            mstore(add(m, 0x40), resultCommitment)
            mstore(add(m, 0x60), units)
            mstore(add(m, 0x80), valueWei)
            mstore(add(m, 0xa0), completedAt)
            structHash := keccak256(m, 0xc0)
        }
        return MessageHashUtils.toTypedDataHash(domain, structHash);
    }

    /// @dev A 64-byte EIP-2098 signature `(r, vs)` over `digest`, with a low
    ///      `s`, recovers to `key`. A failed recovery yields the zero address,
    ///      which never matches: the funding contracts refuse a zero session
    ///      key.
    function _signedBy(bytes32 digest, bytes32 r, bytes32 vs, address key) internal view returns (bool) {
        if (uint256(vs) & _S_MASK > _SECP256K1_HALF_N) return false;
        address recovered = ECDSA.tryRecover(digest, r, vs);
        return recovered != address(0) && recovered == key;
    }

    /// @dev The identity of the node whose operational key is `operational`:
    ///      it has a profile and a place in the sharding table, the checks
    ///      `RandomSampling.submitProof` makes. Only operational keys map to an
    ///      identity, so an admin key or an address that is no node's key
    ///      gets identity 0, which has no profile.
    function _coreNodeOf(address operational) internal view returns (uint72 identityId) {
        identityId = identityStorage.getIdentityId(operational);
        if (!profileStorage.profileExists(identityId)) revert ProfileLib.ProfileDoesntExist(identityId);
        if (!shardingTableStorage.nodeExists(identityId)) revert NodeNotInShardingTable(identityId);
    }

    /// @dev Not paused, and the current epoch is at or after the activation
    ///      epoch, which is set. Returns the current epoch.
    function _requireLive(uint40 activation, bool isPaused) internal view returns (uint256 currentEpoch) {
        if (isPaused) revert QueryInferencePaused();
        currentEpoch = chronos.getCurrentEpoch();
        if (activation == 0 || currentEpoch < activation) revert QueryInferenceNotActive(activation, currentEpoch);
    }

    function _fault(uint256 g, uint256 j, Fault fault) internal pure {
        revert ReceiptFault(g, j, fault);
    }
}
