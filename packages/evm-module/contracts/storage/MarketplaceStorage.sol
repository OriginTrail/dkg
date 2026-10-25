// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";
import {MarketplaceLib} from "../libraries/MarketplaceLib.sol";

/// @title MarketplaceStorage
/// @notice State for the OT-RFC-27 NeuroSymbolic Marketplace prototype:
///         period-subscription buckets, buyer session keys, authorization
///         replay guards, and per-epoch reward-pool accounting. All writes are
///         `onlyContracts` (driven by `Marketplace`); protocol parameters are
///         governed Hub-owner-side, following ParametersStorage conventions
///         but scoped here so the prototype does not touch ParametersStorage.
contract MarketplaceStorage is INamed, IVersioned, ContractStatus, IInitializable {
    event ParameterChanged(string parameterName, uint256 parameterValue);

    error LambdaTooLarge(uint256 lambda18);
    error InvalidBps(uint16 bps);

    string private constant _NAME = "MarketplaceStorage";
    string private constant _VERSION = "1.0.0";

    uint256 private constant SCALE18 = 1e18;

    // ============================================================
    //                    Protocol parameters
    // ============================================================

    /// @notice λ_QIF, 18-decimal fixed point in [0, 1e18]. Blends finalized
    ///         receipt value (R) with stake-weighted QueryInferenceScore (Q):
    ///         QIF = (1−λ)·R_i/ΣR + λ·Q_i/ΣQ. Default 0.4e18.
    uint256 public lambdaQif18;

    /// @notice Receipts for epoch `e` are accepted until
    ///         `epochEnd(e) + settlementGraceSeconds`; finalization and reward
    ///         claims open after that deadline. Defaults to epochLength/4,
    ///         set in `initialize()` (first initialization only — a later
    ///         reinitialize keeps the governed value).
    uint256 public settlementGraceSeconds;

    /// @notice Node-side serving guidance (basis points of a bucket, default
    ///         9500 = 95%). Stored for discoverability only — the contract
    ///         does not enforce it; buyers/sellers stop serving at the soft
    ///         ceiling off-chain.
    uint16 public softCeilingBps;

    // ============================================================
    //                 Buckets, claims, session keys
    // ============================================================

    /// @dev bucket[buyer][epoch].
    mapping(address => mapping(uint256 => MarketplaceLib.Bucket)) internal buckets;
    /// @dev Identity ids that claimed against bucket[buyer][epoch] (first
    ///      accepted claim pushes).
    mapping(address => mapping(uint256 => uint72[])) internal bucketSellers;
    /// @dev sellerClaims[buyer][epoch][identityId].
    mapping(address => mapping(uint256 => mapping(uint72 => MarketplaceLib.SellerClaim))) internal sellerClaims;

    /// @notice Buyer that registered a given session key (anti-hijack: a key
    ///         can only ever belong to one buyer).
    mapping(address => address) public sessionKeyOwner;
    /// @notice Current authorization-signing key for a buyer.
    mapping(address => address) public activeSessionKey;

    /// @notice Replay guard: consumed authorization digests.
    mapping(bytes32 => bool) public consumedAuth;

    // ============================================================
    //                    Epoch accounting
    // ============================================================

    /// @notice Network reward pool for an epoch (Σ funded subscriptions,
    ///         plus rolled-forward pools).
    mapping(uint256 => uint256) public epochPool;
    /// @dev Buyers whose first funding landed in an epoch.
    mapping(uint256 => address[]) internal epochBuyers;
    /// @notice Funded-but-not-yet-finalized bucket counter per epoch; reward
    ///         claims are gated on it reaching zero.
    mapping(uint256 => uint256) public openBuckets;

    /// @notice R_i(e) — finalized receipt value per node per epoch.
    mapping(uint256 => mapping(uint72 => uint256)) public nodeFinalizedValue;
    /// @notice Q_i(e) — finalized stake-weighted QueryInferenceScore.
    mapping(uint256 => mapping(uint72 => uint256)) public nodeQiScore;
    /// @notice ΣR over all nodes for an epoch.
    mapping(uint256 => uint256) public epochTotalFinalizedValue;
    /// @notice ΣQ over all nodes for an epoch.
    mapping(uint256 => uint256) public epochTotalQiScore;
    /// @notice Epoch reward already paid out to a node.
    mapping(uint256 => mapping(uint72 => bool)) public rewardClaimed;

    // @dev Only transactions by HubController owner or one of the owners of
    //      the MultiSig Wallet (ParametersStorage convention).
    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    constructor(address hubAddress) ContractStatus(hubAddress) {
        lambdaQif18 = 4e17; // 0.4
        softCeilingBps = 9_500;
        // settlementGraceSeconds defaults to epochLength/4 in initialize(),
        // once Chronos is resolvable through the Hub.
    }

    function initialize() public onlyHub {
        if (settlementGraceSeconds == 0) {
            settlementGraceSeconds = Chronos(hub.getContractAddress("Chronos")).epochLength() / 4;
        }
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                    Parameter setters
    // ============================================================

    function setLambdaQif18(uint256 lambda18) external onlyOwnerOrMultiSigOwner {
        if (lambda18 > SCALE18) {
            revert LambdaTooLarge(lambda18);
        }
        lambdaQif18 = lambda18;

        emit ParameterChanged("lambdaQif18", lambda18);
    }

    function setSettlementGraceSeconds(uint256 graceSeconds) external onlyOwnerOrMultiSigOwner {
        settlementGraceSeconds = graceSeconds;

        emit ParameterChanged("settlementGraceSeconds", graceSeconds);
    }

    function setSoftCeilingBps(uint16 bps) external onlyOwnerOrMultiSigOwner {
        if (bps > 10_000) {
            revert InvalidBps(bps);
        }
        softCeilingBps = bps;

        emit ParameterChanged("softCeilingBps", bps);
    }

    // ============================================================
    //                          Writes
    // ============================================================

    function increaseBucketFunded(address buyer, uint256 epoch, uint96 amount) external onlyContracts {
        buckets[buyer][epoch].funded += amount;
    }

    /// @notice Registers/rotates a buyer's session key. The caller
    ///         (`Marketplace`) enforces non-zero keys and single ownership.
    function setSessionKey(address buyer, address sessionKey) external onlyContracts {
        activeSessionKey[buyer] = sessionKey;
        sessionKeyOwner[sessionKey] = buyer;
    }

    function markAuthConsumed(bytes32 authDigest) external onlyContracts {
        consumedAuth[authDigest] = true;
    }

    /// @notice Accrues one accepted receipt claim: pushes the seller onto the
    ///         bucket's claimant list on its first claim, then bumps the
    ///         seller accumulators and the bucket's `totalClaimed`.
    function addSellerClaim(
        address buyer,
        uint256 epoch,
        uint72 identityId,
        uint256 value,
        uint256 qiRaw
    ) external onlyContracts {
        MarketplaceLib.SellerClaim storage sellerClaim = sellerClaims[buyer][epoch][identityId];
        if (sellerClaim.claimed == 0) {
            bucketSellers[buyer][epoch].push(identityId);
        }
        sellerClaim.claimed += value;
        sellerClaim.qiRaw += qiRaw;
        buckets[buyer][epoch].totalClaimed += value;
    }

    function setBucketFinalized(address buyer, uint256 epoch, uint256 totalFinalized) external onlyContracts {
        buckets[buyer][epoch].totalFinalized = totalFinalized;
        buckets[buyer][epoch].finalized = true;
    }

    function increaseEpochPool(uint256 epoch, uint256 amount) external onlyContracts {
        epochPool[epoch] += amount;
    }

    function setEpochPool(uint256 epoch, uint256 amount) external onlyContracts {
        epochPool[epoch] = amount;
    }

    function pushEpochBuyer(uint256 epoch, address buyer) external onlyContracts {
        epochBuyers[epoch].push(buyer);
    }

    function incrementOpenBuckets(uint256 epoch) external onlyContracts {
        openBuckets[epoch] += 1;
    }

    function decrementOpenBuckets(uint256 epoch) external onlyContracts {
        openBuckets[epoch] -= 1;
    }

    /// @notice Accrues a bucket's finalized share into the per-node and
    ///         per-epoch R/Q totals.
    function addNodeFinalized(
        uint256 epoch,
        uint72 identityId,
        uint256 finalizedValue,
        uint256 qiScore
    ) external onlyContracts {
        nodeFinalizedValue[epoch][identityId] += finalizedValue;
        nodeQiScore[epoch][identityId] += qiScore;
        epochTotalFinalizedValue[epoch] += finalizedValue;
        epochTotalQiScore[epoch] += qiScore;
    }

    function markRewardClaimed(uint256 epoch, uint72 identityId) external onlyContracts {
        rewardClaimed[epoch][identityId] = true;
    }

    // ============================================================
    //                          Reads
    // ============================================================

    function getBucket(address buyer, uint256 epoch) external view returns (MarketplaceLib.Bucket memory) {
        return buckets[buyer][epoch];
    }

    function getSellerClaim(
        address buyer,
        uint256 epoch,
        uint72 identityId
    ) external view returns (MarketplaceLib.SellerClaim memory) {
        return sellerClaims[buyer][epoch][identityId];
    }

    function getBucketSellers(address buyer, uint256 epoch) external view returns (uint72[] memory) {
        return bucketSellers[buyer][epoch];
    }

    function getEpochBuyers(uint256 epoch) external view returns (address[] memory) {
        return epochBuyers[epoch];
    }

    // ============================================================
    //         Governance gate (ParametersStorage convention)
    // ============================================================

    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
        // First check if the address has contract code
        uint256 size;
        assembly {
            size := extcodesize(multiSigAddress)
        }

        // If no contract code, it's an EOA, not a multisig
        if (size == 0) {
            return false;
        }

        try ICustodian(multiSigAddress).getOwners() returns (address[] memory multiSigOwners) {
            for (uint256 i = 0; i < multiSigOwners.length; i++) {
                if (msg.sender == multiSigOwners[i]) {
                    return true;
                }
            }
        } catch {
            // Not a multisig or call reverted; treat as not owner.
        }

        return false;
    }

    function _checkOwnerOrMultiSigOwner() internal view virtual {
        address hubOwner = hub.owner();
        if (msg.sender != hubOwner && msg.sender != address(hub) && !_isMultiSigOwner(hubOwner)) {
            revert("Only Hub Owner, Hub, or Multisig Owner can call");
        }
    }
}
