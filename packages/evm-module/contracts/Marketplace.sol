// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {MarketplaceStorage} from "./storage/MarketplaceStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {MarketplaceLib} from "./libraries/MarketplaceLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Marketplace (OT-RFC-27 NeuroSymbolic Marketplace prototype)
/// @notice Protocol-level query/inference marketplace settlement:
///         1. Buyers fund non-refundable period subscriptions into a network
///            epoch reward pool and register a session key (no seller named).
///         2. Seller Core Nodes submit buyer-authorized receipt batches; every
///            authorization is verified against the buyer's registered session
///            key (EIP-191 over the shared `DKG_MKT_AUTH_V1` digest), replay-,
///            expiry-, unit- and seller-bound. The node's stake factor S18 is
///            captured at acceptance.
///         3. After the settlement deadline, buckets are finalized: claims are
///            capped to the buyer's funded bucket pro-rata, with no
///            submission-order priority (floor semantics, residue stays in
///            the pool).
///         4. Nodes claim `G_i = pool(e) · QIF_i(e)` where
///            `QIF = (1−λ)·R_i/ΣR + λ·Q_i/ΣQ`.
///         Funded pools with no finalized receipt value roll forward.
/// @dev    Prototype scope (documented RFC "works in progress"): no Conviction
///         Account funding, no attested-execution profile, gross node reward
///         paid to the claiming operational wallet (operator-fee/delegator
///         split via StakingKPI is a follow-up).
contract Marketplace is INamed, IVersioned, ContractStatus, IInitializable {
    using SafeERC20 for IERC20;

    event SubscriptionFunded(address indexed buyer, uint256 indexed epoch, uint96 amount, address sessionKey);
    event SessionKeyRotated(address indexed buyer, address indexed sessionKey);
    event ReceiptClaimed(
        address indexed buyer,
        uint256 indexed epoch,
        uint72 indexed identityId,
        bytes32 offeringId,
        bytes32 callId,
        uint64 servedUnits,
        uint256 value,
        bytes32 resultCommitment
    );
    event BucketFinalized(
        address indexed buyer,
        uint256 indexed epoch,
        uint96 funded,
        uint256 totalClaimed,
        uint256 totalFinalized
    );
    event EpochRewardClaimed(uint256 indexed epoch, uint72 indexed identityId, address indexed operational, uint256 reward);
    event EpochPoolRolled(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);

    error ZeroTokenAmount();
    error InvalidSubscriptionEpoch(uint256 epoch, uint256 currentEpoch);
    error NoActiveSessionKey(address buyer);
    error SessionKeyAlreadyBound(address sessionKey, address owner);
    error NotACoreNode(address operationalWallet);
    error EmptyReceiptBatch();
    error ReceiptBatchTooLarge(uint256 length);
    error BucketNotFunded(address buyer, uint256 epoch);
    error SettlementClosed(uint256 epoch, uint256 deadline);
    error SettlementStillOpen(uint256 epoch, uint256 deadline);
    error AuthorizationExpired(bytes32 callId, uint40 expiry);
    error ZeroServedUnits(bytes32 callId);
    error ServedOverMaxUnits(bytes32 callId, uint64 servedUnits, uint64 maxUnits);
    error AuthorizationAlreadyConsumed(bytes32 authDigest);
    error InvalidAuthorizationSignature(bytes32 authDigest, address recovered, address sessionKey);
    error BucketAlreadyFinalized(address buyer, uint256 epoch);
    error OpenBucketsRemaining(uint256 epoch, uint256 remaining);
    error NothingFinalizedForEpoch(uint256 epoch);
    error RewardAlreadyClaimed(uint256 epoch, uint72 identityId);
    error NotOperationalWallet(uint72 identityId, address caller);
    error EpochHasFinalizedValue(uint256 epoch);
    error EmptyEpochPool(uint256 epoch);

    string private constant _NAME = "Marketplace";
    string private constant _VERSION = "1.0.0";

    /// @notice Domain separator for buyer session-key authorizations. Packed
    ///         as raw ASCII (no length prefix) — MUST match the TS side
    ///         byte-for-byte (`packages/marketplace` digests).
    string public constant AUTH_DOMAIN = "DKG_MKT_AUTH_V1";

    uint256 public constant SCALE18 = 1e18;

    /// @notice Objective-fault rejection is per batch (any bad claim reverts
    ///         the whole submission), so the batch size is bounded.
    uint256 public constant MAX_RECEIPT_BATCH = 100;

    IERC20 public token;
    IdentityStorage public identityStorage;
    ShardingTableStorage public shardingTableStorage;
    ParametersStorage public parametersStorage;
    ConvictionStakingStorage public convictionStakingStorage;
    Chronos public chronos;
    MarketplaceStorage public marketplaceStorage;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        token = IERC20(hub.getContractAddress("Token"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        marketplaceStorage = MarketplaceStorage(hub.getContractAddress("MarketplaceStorage"));
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                    Buyer: subscriptions
    // ============================================================

    /// @notice Funds a non-refundable period subscription for `epoch` (current
    ///         or next) and registers/rotates the buyer's session key.
    ///         `sessionKey == address(0)` keeps the current key (rejected if
    ///         the buyer has none — the bucket would be unspendable). There is
    ///         no withdrawal path by construction.
    function fundSubscription(uint96 amount, address sessionKey, uint256 epoch) external {
        if (amount == 0) {
            revert ZeroTokenAmount();
        }
        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (epoch != currentEpoch && epoch != currentEpoch + 1) {
            revert InvalidSubscriptionEpoch(epoch, currentEpoch);
        }

        MarketplaceStorage ms = marketplaceStorage;

        if (sessionKey == address(0)) {
            if (ms.activeSessionKey(msg.sender) == address(0)) {
                revert NoActiveSessionKey(msg.sender);
            }
        } else {
            address keyOwner = ms.sessionKeyOwner(sessionKey);
            if (keyOwner != address(0) && keyOwner != msg.sender) {
                revert SessionKeyAlreadyBound(sessionKey, keyOwner);
            }
            if (ms.activeSessionKey(msg.sender) != sessionKey) {
                ms.setSessionKey(msg.sender, sessionKey);
                emit SessionKeyRotated(msg.sender, sessionKey);
            }
        }

        bool firstFunding = ms.getBucket(msg.sender, epoch).funded == 0;

        token.safeTransferFrom(msg.sender, address(this), amount);

        ms.increaseBucketFunded(msg.sender, epoch, amount);
        ms.increaseEpochPool(epoch, amount);
        if (firstFunding) {
            ms.pushEpochBuyer(epoch, msg.sender);
            ms.incrementOpenBuckets(epoch);
        }

        emit SubscriptionFunded(msg.sender, epoch, amount, ms.activeSessionKey(msg.sender));
    }

    // ============================================================
    //                 Seller: receipt batches
    // ============================================================

    /// @notice Submits a batch of buyer-authorized receipt claims. The seller
    ///         identity is resolved from `msg.sender` (must be an operational
    ///         wallet of a Core Node in the sharding table) — the recomputed
    ///         authorization digest binds it, so a receipt authorized for
    ///         another seller fails signature verification. Any objective
    ///         fault rejects the whole batch.
    // Slither: per-claim external reads/writes are calls-in-loop by design
    // (bounded by MAX_RECEIPT_BATCH); settlement-window checks use
    // block.timestamp like the rest of the protocol.
    // slither-disable-start calls-loop,timestamp
    function submitReceiptBatch(MarketplaceLib.ReceiptClaim[] calldata claims) external {
        if (claims.length == 0) {
            revert EmptyReceiptBatch();
        }
        if (claims.length > MAX_RECEIPT_BATCH) {
            revert ReceiptBatchTooLarge(claims.length);
        }

        uint72 identityId = identityStorage.getIdentityId(msg.sender);
        if (identityId == 0 || !shardingTableStorage.nodeExists(identityId)) {
            revert NotACoreNode(msg.sender);
        }

        // Stake factor at acceptance — one read per batch (same seller).
        uint256 stakeFactor18 = getStakeFactor18(identityId);

        MarketplaceStorage ms = marketplaceStorage;
        for (uint256 i; i < claims.length; i++) {
            _acceptClaim(ms, claims[i], identityId, stakeFactor18);
        }
    }

    function _acceptClaim(
        MarketplaceStorage ms,
        MarketplaceLib.ReceiptClaim calldata claim,
        uint72 identityId,
        uint256 stakeFactor18
    ) internal {
        if (ms.getBucket(claim.buyer, claim.epoch).funded == 0) {
            revert BucketNotFunded(claim.buyer, claim.epoch);
        }
        uint256 deadline = settlementDeadline(claim.epoch);
        if (block.timestamp > deadline) {
            revert SettlementClosed(claim.epoch, deadline);
        }
        if (block.timestamp > claim.expiry) {
            revert AuthorizationExpired(claim.callId, claim.expiry);
        }
        if (claim.servedUnits == 0) {
            revert ZeroServedUnits(claim.callId);
        }
        if (claim.servedUnits > claim.maxUnits) {
            revert ServedOverMaxUnits(claim.callId, claim.servedUnits, claim.maxUnits);
        }

        bytes32 authDigest = computeAuthDigest(
            claim.buyer,
            identityId,
            claim.offeringId,
            claim.callId,
            claim.epoch,
            claim.maxUnits,
            claim.askPerUnit,
            claim.expiry
        );
        if (ms.consumedAuth(authDigest)) {
            revert AuthorizationAlreadyConsumed(authDigest);
        }
        ms.markAuthConsumed(authDigest);

        address sessionKey = ms.activeSessionKey(claim.buyer);
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(authDigest), claim.authSignature);
        if (sessionKey == address(0) || recovered != sessionKey) {
            revert InvalidAuthorizationSignature(authDigest, recovered, sessionKey);
        }

        uint256 value = uint256(claim.servedUnits) * claim.askPerUnit;
        ms.addSellerClaim(claim.buyer, claim.epoch, identityId, value, (value * stakeFactor18) / SCALE18);

        emit ReceiptClaimed(
            claim.buyer,
            claim.epoch,
            identityId,
            claim.offeringId,
            claim.callId,
            claim.servedUnits,
            value,
            claim.resultCommitment
        );
    }

    // ============================================================
    //              Settlement: finalization & rewards
    // ============================================================

    /// @notice Finalizes a (buyer, epoch) bucket after the settlement
    ///         deadline. Claims within funding finalize 1:1; over-claimed
    ///         buckets pro-rate `claimed_i · funded / totalClaimed` with no
    ///         submission-order priority (floor; the residue stays in the
    ///         epoch pool and is redistributed through QIF). Permissionless.
    function finalizeBucket(address buyer, uint256 epoch) external {
        uint256 deadline = settlementDeadline(epoch);
        if (block.timestamp <= deadline) {
            revert SettlementStillOpen(epoch, deadline);
        }

        MarketplaceStorage ms = marketplaceStorage;
        MarketplaceLib.Bucket memory bucket = ms.getBucket(buyer, epoch);
        if (bucket.funded == 0) {
            revert BucketNotFunded(buyer, epoch);
        }
        if (bucket.finalized) {
            revert BucketAlreadyFinalized(buyer, epoch);
        }

        uint72[] memory sellers = ms.getBucketSellers(buyer, epoch);
        bool proRata = bucket.totalClaimed > bucket.funded;
        uint256 totalFinalized;
        for (uint256 i; i < sellers.length; i++) {
            MarketplaceLib.SellerClaim memory sellerClaim = ms.getSellerClaim(buyer, epoch, sellers[i]);
            uint256 finalizedValue = proRata
                ? (sellerClaim.claimed * bucket.funded) / bucket.totalClaimed
                : sellerClaim.claimed;
            // Q_i accrues proportionally to the finalized share so the stake
            // factor captured at acceptance survives pro-rating.
            uint256 qiScore = (sellerClaim.qiRaw * finalizedValue) / sellerClaim.claimed;
            ms.addNodeFinalized(epoch, sellers[i], finalizedValue, qiScore);
            totalFinalized += finalizedValue;
        }

        ms.setBucketFinalized(buyer, epoch, totalFinalized);
        ms.decrementOpenBuckets(epoch);

        emit BucketFinalized(buyer, epoch, bucket.funded, bucket.totalClaimed, totalFinalized);
    }

    /// @notice Pays a node's epoch reward `pool(e) · QIF_i(e)` to the calling
    ///         operational wallet, once every bucket of the epoch is
    ///         finalized. Prototype pays the gross node reward (operator-fee /
    ///         delegator split via StakingKPI is a documented follow-up).
    function claimEpochReward(uint72 identityId, uint256 epoch) external {
        uint256 deadline = settlementDeadline(epoch);
        if (block.timestamp <= deadline) {
            revert SettlementStillOpen(epoch, deadline);
        }

        MarketplaceStorage ms = marketplaceStorage;
        uint256 remaining = ms.openBuckets(epoch);
        if (remaining != 0) {
            revert OpenBucketsRemaining(epoch, remaining);
        }
        if (ms.epochTotalFinalizedValue(epoch) == 0) {
            revert NothingFinalizedForEpoch(epoch);
        }
        if (ms.rewardClaimed(epoch, identityId)) {
            revert RewardAlreadyClaimed(epoch, identityId);
        }
        if (identityId == 0 || identityStorage.getIdentityId(msg.sender) != identityId) {
            revert NotOperationalWallet(identityId, msg.sender);
        }

        uint256 reward = (ms.epochPool(epoch) * getQif18(epoch, identityId)) / SCALE18;
        ms.markRewardClaimed(epoch, identityId);

        token.safeTransfer(msg.sender, reward);

        emit EpochRewardClaimed(epoch, identityId, msg.sender, reward);
    }

    /// @notice Rolls a settled epoch pool with zero finalized receipt value
    ///         forward into the current epoch (RFC: a funded period with no
    ///         finalized usage rolls forward). Permissionless.
    function rollEpochPool(uint256 epoch) external {
        uint256 deadline = settlementDeadline(epoch);
        if (block.timestamp <= deadline) {
            revert SettlementStillOpen(epoch, deadline);
        }

        MarketplaceStorage ms = marketplaceStorage;
        uint256 remaining = ms.openBuckets(epoch);
        if (remaining != 0) {
            revert OpenBucketsRemaining(epoch, remaining);
        }
        if (ms.epochTotalFinalizedValue(epoch) != 0) {
            revert EpochHasFinalizedValue(epoch);
        }
        uint256 amount = ms.epochPool(epoch);
        if (amount == 0) {
            revert EmptyEpochPool(epoch);
        }

        // The deadline is strictly after epoch end, so currentEpoch > epoch.
        uint256 currentEpoch = chronos.getCurrentEpoch();
        ms.setEpochPool(epoch, 0);
        ms.increaseEpochPool(currentEpoch, amount);

        emit EpochPoolRolled(epoch, currentEpoch, amount);
    }
    // slither-disable-end calls-loop,timestamp

    // ============================================================
    //                          Views
    // ============================================================

    /// @notice The shared `DKG_MKT_AUTH_V1` authorization digest. MUST match
    ///         the TS mirror byte-for-byte:
    ///         `ethers.solidityPackedKeccak256(["string","uint256","address",
    ///         "address","uint72","bytes32","bytes32","uint256","uint64",
    ///         "uint96","uint40"], ...)` (`uint72` packs as 9 bytes).
    function computeAuthDigest(
        address buyer,
        uint72 sellerIdentityId,
        bytes32 offeringId,
        bytes32 callId,
        uint256 epoch,
        uint64 maxUnits,
        uint96 askPerUnit,
        uint40 expiry
    ) public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    AUTH_DOMAIN,
                    block.chainid,
                    address(this),
                    buyer,
                    sellerIdentityId,
                    offeringId,
                    callId,
                    epoch,
                    maxUnits,
                    askPerUnit,
                    expiry
                )
            );
    }

    /// @notice Stake factor S18 = sqrt(min(effStake, maximumStake)/maximumStake)
    ///         in 18-decimal fixed point — the exact step-1 math of
    ///         `RandomSampling._calculateNodeScore`, fed by V10 effective stake.
    function getStakeFactor18(uint72 identityId) public view returns (uint256) {
        uint256 stakeCap = uint256(parametersStorage.maximumStake());
        uint256 nodeEffectiveStake = convictionStakingStorage.getNodeEffectiveStake(identityId);
        nodeEffectiveStake = nodeEffectiveStake > stakeCap ? stakeCap : nodeEffectiveStake;
        // S18 = sqrt((nodeEffectiveStake / stakeCap) * SCALE18) * sqrt(SCALE18)
        uint256 stakeRatio18 = (nodeEffectiveStake * SCALE18) / stakeCap;
        return Math.sqrt(stakeRatio18 * SCALE18);
    }

    /// @notice QIF_i(e) = (1−λ)·R_i/ΣR + λ·Q_i/ΣQ, 18-decimal fixed point.
    ///         A zero ΣR or ΣQ contributes 0 for its term (ΣQ can be zero when
    ///         every claimant had zero effective stake; that λ-share of the
    ///         pool is then undistributed — accepted prototype behavior).
    function getQif18(uint256 epoch, uint72 identityId) public view returns (uint256) {
        MarketplaceStorage ms = marketplaceStorage;
        uint256 totalR = ms.epochTotalFinalizedValue(epoch);
        uint256 totalQ = ms.epochTotalQiScore(epoch);
        uint256 lambda18 = ms.lambdaQif18();

        uint256 rTerm18 = totalR > 0 ? ((SCALE18 - lambda18) * ms.nodeFinalizedValue(epoch, identityId)) / totalR : 0;
        uint256 qTerm18 = totalQ > 0 ? (lambda18 * ms.nodeQiScore(epoch, identityId)) / totalQ : 0;

        return rTerm18 + qTerm18;
    }

    /// @notice Receipts for `epoch` are accepted until this timestamp
    ///         (inclusive); finalization and reward claims open after it.
    function settlementDeadline(uint256 epoch) public view returns (uint256) {
        return chronos.timestampForEpoch(epoch + 1) + marketplaceStorage.settlementGraceSeconds();
    }

    function getBucket(address buyer, uint256 epoch) external view returns (MarketplaceLib.Bucket memory) {
        return marketplaceStorage.getBucket(buyer, epoch);
    }

    function getSellerClaim(
        address buyer,
        uint256 epoch,
        uint72 identityId
    ) external view returns (MarketplaceLib.SellerClaim memory) {
        return marketplaceStorage.getSellerClaim(buyer, epoch, identityId);
    }

    function getNodeEpochAccounting(
        uint256 epoch,
        uint72 identityId
    )
        external
        view
        returns (
            uint256 finalizedValue,
            uint256 qiScore,
            uint256 totalFinalizedValue,
            uint256 totalQiScore,
            uint256 pool,
            bool claimed
        )
    {
        MarketplaceStorage ms = marketplaceStorage;
        return (
            ms.nodeFinalizedValue(epoch, identityId),
            ms.nodeQiScore(epoch, identityId),
            ms.epochTotalFinalizedValue(epoch),
            ms.epochTotalQiScore(epoch),
            ms.epochPool(epoch),
            ms.rewardClaimed(epoch, identityId)
        );
    }

    function activeSessionKey(address buyer) external view returns (address) {
        return marketplaceStorage.activeSessionKey(buyer);
    }

    function getParams()
        external
        view
        returns (uint256 lambdaQif18, uint256 settlementGraceSeconds, uint16 softCeilingBps)
    {
        MarketplaceStorage ms = marketplaceStorage;
        return (ms.lambdaQif18(), ms.settlementGraceSeconds(), ms.softCeilingBps());
    }
}
