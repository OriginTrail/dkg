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
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title QueryInferenceSettlement
 * @notice Settlement of the query/inference pool of OT-RFC-27 ("NeuroSymbolic
 *         Marketplace"): Core Node sellers submit batches of buyer-signed
 *         requests with their receipts, and each batch counts as it lands, up
 *         to what the buyer's bucket has left, towards the QIF inputs of the
 *         period's epoch.
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
 * node that has a profile, a place in the sharding table and a positive node
 * score in the current epoch, and that node is the seller of every receipt in
 * it. The contract fills in the period, the bucket and the seller of each
 * request itself, so a request signed for another seller, period or bucket
 * recovers to another address and fails as a bad signature. Every objective
 * fault OT-RFC-27 lists is checked, and any fault reverts the whole batch
 * (`ReceiptFault`), so sellers simulate first. Nothing is stored per receipt:
 * only a nonce bit per request, and what counts.
 *
 * Counting. A batch lands only during its period's epoch: the epoch's end is
 * the deadline, and a receipt that misses it never counts. A group counts in
 * the transaction that lands it:
 *   - `counted`, the lesser of the group's value and what the bucket has left,
 *     fills the bucket at face value. Batches count in the order they land, and
 *     what has landed is never reduced. A group refuses to land for less than
 *     its `minCounted`, or for nothing, so a seller keeps its receipts for a
 *     later top-up rather than spending their nonces.
 *   - R, which is `counted` at the period's discount, floored, and
 *     QueryInferenceScore, which is R at the batch's stake factor, join the
 *     node's and the epoch's totals in the period's epoch. A Conviction Account
 *     period's cost is its value at the same discount, so a bucket's R never
 *     exceeds what was paid for it.
 *
 * The pool (`epochPool`). An epoch's money is what was funded for its periods:
 * the wallet-funded value and the Conviction Account cost. If no node counted
 * value in an epoch, its pool is 0 and its money rolls forward. Otherwise its
 * pool is its money plus that of the unbroken run of epochs before it in which
 * no node counted value, back to the activation epoch. No step runs when an
 * epoch ends: nothing writes an epoch's money or totals once it has ended, so
 * from then on `epochPool` and `queryInferenceGross` read final values, and a
 * reward claim reads them straight away. The pool is paid out as the nodes'
 * gross rewards, each of its two terms floored, so less than 2 wei per node
 * with value stays in the vault: the same kind of remainder as the floors of
 * `StakingV10`'s split of a node's reward.
 *
 * Architecture: stateless logic, as `ServiceSubscriptions`. Every byte of
 * settlement state lives in `QueryInferenceStorage`, and the periods in
 * `ConvictionServiceStorage`. The storages it reads or writes, and `Chronos`,
 * are wired at `initialize()`. It never calls the Token, moves no TRAC, and
 * accepts no ETH: no TRAC is ever sent to a seller.
 *
 * Gates: every batch is refused while `QueryInferenceStorage` is paused, before
 * its activation epoch and while that is unset.
 *
 * Out of the Hub. `QueryInferenceStorage` takes writes only from Hub
 * contracts, so while this contract is out of the Hub, which is the emergency
 * switch (`StakingV10.queryInferenceSettlement`), every batch reverts. A fresh
 * deployment, registered and initialized, takes over the same storage.
 */
contract QueryInferenceSettlement is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "QueryInferenceSettlement";
    // Version history:
    //   1.0.0 — receipt batches that count as they land, up to what the bucket
    //           has left, and the read of an epoch's pool (OT-RFC-27).
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
    ///      2^56 − 1.
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
        uint96 minCounted; // the least face value the group lands for; less reverts the batch
        ReceiptItem[] items;
    }

    /// @notice Why a batch is refused: a group's fault, or an item's.
    enum Fault {
        None,
        // A group's.
        UnknownPeriod, // no period is recorded under the id
        UnknownBucket, // the period has no bucket at the index
        OutsideEpoch, // the current epoch is not the period's
        EmptyGroup, // no items
        BelowMinCounted, // the bucket has less left than the group's minimum, or nothing
        // An item's: the faults OT-RFC-27 lists.
        BadSignature, // not signed by the session key, or for another seller, period or bucket
        InactiveAssignment, // issued once the assignment the period was funded under had ended
        DuplicateNonce, // the nonce is used, earlier or in this batch
        OutsideTime, // issued before the period, completed before issue, after expiry, or after the batch
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

    /// @notice A group of `itemCount` receipts landed: of the `claimed` receipt
    ///         value on the bucket, `counted` fit what the bucket had left, for
    ///         `seller`, at the batch's stake factor. `groupDigest` is the hash
    ///         of the group's receipt digests, in order, so a buyer finds its
    ///         receipts.
    event ReceiptsClaimed(
        bytes32 indexed subscriptionId,
        uint8 indexed bucketIndex,
        uint72 indexed seller,
        uint256 itemCount,
        uint256 claimed,
        uint256 counted,
        uint256 stakeFactor18,
        bytes32 groupDigest
    );
    /// @notice A batch was accepted. `batchDigest` is the hash of all its
    ///         receipt digests, in order.
    event ReceiptBatchAccepted(
        uint72 indexed seller,
        bytes32 batchDigest,
        uint256 itemCount,
        uint256 claimed,
        uint256 counted,
        uint256 stakeFactor18
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
    /// @notice The seller has no node score in `epoch`, the current one, yet: it
    ///         lands batches once it has proved in the epoch.
    error NoNodeScore(uint72 identityId, uint256 epoch);

    // ============================================================
    //                    Working records
    // ============================================================

    /// @dev What a batch keeps across its groups.
    struct Batch {
        uint72 seller;
        uint256 epoch; // the current epoch, the only one a batch lands in
        uint256 stakeFactor18;
        bytes32 domain;
        bytes32[] digests; // every receipt digest, in order
        uint256 next; // the next free index in `digests`
        uint256 claimed;
        uint256 counted;
    }

    /// @dev What a group is checked against and counts by.
    struct Terms {
        address sessionKey;
        uint256 periodStart;
        uint256 assignmentEnd; // when the period's own assignment ended or ends; max for a wallet period
        bytes32 bucketId;
        uint256 maxAsk;
        uint256 bucketValue;
        uint256 discountBps;
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
     * @notice Count the receipts of `groups` for the seller, the node whose
     *         operational key sends the transaction. All or nothing: any
     *         fault reverts the whole batch.
     * @dev    The sender's node must have a profile, a place in the sharding
     *         table and a positive node score in the current epoch, so a node
     *         with counted value always has a share of the epoch's rewards to
     *         pay it through. The batch has 1 to `maxGroupsPerBatch` groups and
     *         1 to `maxItemsPerBatch` items, and its stake factor is captured
     *         once, before the groups.
     *
     *         A group names a recorded period of the current epoch and one of
     *         its buckets, and has items. Whatever becomes of a Conviction
     *         Account assignment, a request served before it ended lands until
     *         the epoch ends. Each item then passes, in order:
     *           1. its request, rebuilt with the group's period and bucket and
     *              the sender's identity, recovers with a low `s` to the
     *              period's session key;
     *           2. for a Conviction Account period, it was issued before the
     *              assignment the period was funded under ended (its expiry,
     *              or its revocation if sooner), an end that a later
     *              assignment of the buyer key does not move;
     *           3. its nonce is unused, earlier and in this batch;
     *           4. periodStart <= issuedAt <= completedAt <= min(expiry, the
     *              block time): a batch claims only work already done, and the
     *              block time is within the period's epoch;
     *           5. 0 < acceptedAskWeiPerUnit <= the bucket's price cap;
     *           6. 0 < units <= maxUnits, valueWei == units × ask in 256 bits,
     *              and valueWei <= maxValueWei;
     *           7. a non-zero result commitment.
     *         The group then counts the lesser of its value and what the bucket
     *         has left, which must be more than 0 and at least `minCounted`.
     *         Value above what the bucket has left does not count, and its
     *         receipts' nonces stay used.
     * @return batchDigest The hash of the batch's receipt digests, in order.
     */
    function submitReceiptBatch(ReceiptGroup[] calldata groups) external returns (bytes32 batchDigest) {
        QueryInferenceStorage qis = queryInferenceStorage;
        (uint40 activation, bool isPaused, uint8 maxGroups, uint16 maxItems) = qis.batchState();
        uint256 current = _requireLive(activation, isPaused);
        uint72 seller = _coreNodeOf(msg.sender);
        if (randomSamplingStorage.getNodeEpochScore(current, seller) == 0) revert NoNodeScore(seller, current);

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
            epoch: current,
            stakeFactor18: stakeFactor(seller),
            domain: domainSeparator(),
            digests: new bytes32[](itemCount),
            next: 0,
            claimed: 0,
            counted: 0
        });
        for (uint256 g; g < groupCount; g++) {
            _acceptGroup(qis, b, g, groups[g]);
        }

        bytes32[] memory digests = b.digests;
        assembly ("memory-safe") {
            batchDigest := keccak256(add(digests, 0x20), shl(5, mload(digests)))
        }
        emit ReceiptBatchAccepted(seller, batchDigest, itemCount, b.claimed, b.counted, b.stakeFactor18);
    }

    // ============================================================
    //                           Views
    // ============================================================

    /**
     * @notice The query/inference pool `epoch`'s nodes share: 0 if no node
     *         counted value in it, otherwise its money plus that of the unbroken
     *         run of epochs before it in which no node counted value, back to
     *         the activation epoch. Final once `epoch` has ended; until then,
     *         what it would be if the epoch ended now.
     * @dev    It walks the run at about 10,000 gas per epoch, and only for an
     *         epoch with value. Nobody can lengthen a run but by selling nothing
     *         for as long, and any counted value ends it.
     */
    function epochPool(uint256 epoch) external view returns (uint256) {
        QueryInferenceStorage qis = queryInferenceStorage;
        return qis.getEpochTotals(epoch).sumR == 0 ? 0 : _poolWithValue(qis, epoch);
    }

    /**
     * @notice Node `identityId`'s gross reward from the query/inference pool
     *         of `epoch`: pool × QIF, as OT-RFC-27 defines it,
     *         floor(pool × (1 − λ) × R / ΣR) + floor(pool × λ × QIS / ΣQIS),
     *         with the λ the epoch took when its first value counted. If ΣQIS is
     *         0 while ΣR is not, which needs every seller's stake factor to be
     *         0, the second term takes the R share. 0 for a node with no counted
     *         value, which walks no rollover run. Over all nodes it sums to at
     *         most the pool, and to more than the pool less 2 wei per node with
     *         value: each term is floored on its own, so a node's gross falls
     *         short of its exact share by less than 1 wei per term (one term at
     *         a λ of 0 or 1). That remainder is never paid out and stays in the
     *         vault, as the floors of `StakingV10`'s split of a node's reward
     *         between its operator fee and its delegators do. Each term is one
     *         `mulDiv`, because one floor over both would divide by
     *         BPS × ΣR × ΣQIS, which does not fit 256 bits. Final once `epoch`
     *         has ended; until then, what it would be if the epoch ended now.
     */
    function queryInferenceGross(uint256 epoch, uint72 identityId) external view returns (uint256 gross) {
        QueryInferenceStorage qis = queryInferenceStorage;
        QueryInferenceStorage.NodeEpoch memory n = qis.getNodeEpoch(identityId, epoch);
        // A node's score never exceeds its value, so no value means no score.
        if (n.r == 0) return 0;
        QueryInferenceStorage.EpochTotals memory t = qis.getEpochTotals(epoch);
        uint256 pool = _poolWithValue(qis, epoch);
        uint256 lambda = t.lambdaBps;

        gross = Math.mulDiv(pool * (_BPS - lambda), n.r, _BPS * uint256(t.sumR));
        if (lambda != 0) {
            gross += t.sumScore == 0
                ? Math.mulDiv(pool * lambda, n.r, _BPS * uint256(t.sumR))
                : Math.mulDiv(pool * lambda, n.score, _BPS * uint256(t.sumScore));
        }
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
     *         snapshot its current proof challenge took, so stake added since
     *         that challenge lifts no factor. `RandomSampling.createChallenge`
     *         retakes the snapshot, so stake added before a new challenge does.
     *         With no snapshot, the live stake is used.
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

    /// @notice What a bucket has left: the most face value further receipts can
    ///         count for, until a top-up adds to it. A seller reads it before it
    ///         serves. 0 for an unknown period or bucket.
    function bucketLeft(bytes32 subscriptionId, uint8 bucketIndex) external view returns (uint256) {
        ConvictionServiceStorage css = convictionServiceStorage;
        if (bucketIndex >= css.getSubscription(subscriptionId).bucketCount) return 0;
        uint256 value = css.getBucket(subscriptionId, bucketIndex).value;
        return value - queryInferenceStorage.bucketFilled(subscriptionId, bucketIndex);
    }

    // ============================================================
    //                         Internal
    // ============================================================

    /// @dev The pool of `epoch`, in which a node counted value; see `epochPool`.
    function _poolWithValue(QueryInferenceStorage qis, uint256 epoch) internal view returns (uint256 pool) {
        pool = _moneyOf(qis, epoch);
        uint256 activation = qis.activationEpoch();
        for (uint256 e = epoch; e > activation; ) {
            e--;
            if (qis.getEpochTotals(e).sumR != 0) break;
            pool += _moneyOf(qis, e);
        }
    }

    /// @dev The money funded for `epoch`. Every source of an epoch's money is
    ///      read here, and only here.
    function _moneyOf(QueryInferenceStorage qis, uint256 epoch) internal view returns (uint256) {
        (uint96 wallet, uint96 conviction) = qis.fundingIn(epoch);
        return uint256(wallet) + conviction;
    }

    /**
     * @dev Check one group and count its value. Used nonces are kept per
     *      group in one cached word of the seller's bitmap, read from the
     *      storage when the word changes and written back, with this group's
     *      bits, before another is read and at the end, so a later group of
     *      the same period and seller reads them.
     */
    function _acceptGroup(QueryInferenceStorage qis, Batch memory b, uint256 g, ReceiptGroup calldata group) internal {
        uint256 n = group.items.length;
        if (n == 0) revert GroupFault(g, Fault.EmptyGroup);
        bytes32 subscriptionId = group.subscriptionId;
        Terms memory t = _termsOf(b, g, subscriptionId, group.bucketIndex);

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
            // 4. Issued within the period, and completed between issue and
            //    expiry, by the time of the batch.
            uint256 completedAt = it.completedAt;
            if (
                issuedAt < t.periodStart ||
                completedAt < issuedAt ||
                completedAt > it.expiry ||
                completedAt > block.timestamp
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

        // What the bucket has left counts, in the order batches land. Its value
        // only grows, so the fill never exceeds it, and each cast below is of at
        // most that uint96: the discount and the stake factor, at most 1, only
        // lower it.
        uint256 left = t.bucketValue - qis.bucketFilled(subscriptionId, group.bucketIndex);
        uint256 counted = value < left ? value : left;
        if (counted == 0 || counted < group.minCounted) revert GroupFault(g, Fault.BelowMinCounted);
        uint256 r = (counted * (_BPS - t.discountBps)) / _BPS;
        qis.countReceipts(
            subscriptionId,
            group.bucketIndex,
            b.seller,
            b.epoch,
            uint96(counted),
            uint96(r),
            uint96((r * b.stakeFactor18) / _SCALE18)
        );
        b.claimed += value;
        b.counted += counted;

        bytes32 groupDigest;
        bytes32[] memory digests = b.digests;
        assembly ("memory-safe") {
            groupDigest := keccak256(add(add(digests, 0x20), shl(5, first)), shl(5, n))
        }
        emit ReceiptsClaimed(
            subscriptionId,
            group.bucketIndex,
            b.seller,
            n,
            value,
            counted,
            b.stakeFactor18,
            groupDigest
        );
    }

    /// @dev A group's period and bucket exist, and the period is of the current
    ///      epoch. Returns what its items are checked against and it counts by:
    ///      for a Conviction Account period, the end of the assignment it was
    ///      funded under.
    function _termsOf(
        Batch memory b,
        uint256 g,
        bytes32 subscriptionId,
        uint8 bucketIndex
    ) internal view returns (Terms memory t) {
        ConvictionServiceStorage css = convictionServiceStorage;
        ConvictionServiceStorage.Subscription memory s = css.getSubscription(subscriptionId);
        if (s.periodStart == 0) revert GroupFault(g, Fault.UnknownPeriod);
        if (bucketIndex >= s.bucketCount) revert GroupFault(g, Fault.UnknownBucket);
        if (s.epoch != b.epoch) revert GroupFault(g, Fault.OutsideEpoch);

        t.sessionKey = s.sessionKey;
        t.periodStart = s.periodStart;
        t.discountBps = s.discountBps;
        t.assignmentEnd = type(uint256).max;
        if (s.accountId != 0) t.assignmentEnd = css.assignmentEnd(s.accountId, s.assignee, s.assignmentNonce);

        ConvictionServiceStorage.Bucket memory bucket = css.getBucket(subscriptionId, bucketIndex);
        t.bucketId = bucket.bucketId;
        t.maxAsk = bucket.maxAskWeiPerUnit;
        t.bucketValue = bucket.value;
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
