// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";

contract ParametersStorage is INamed, IVersioned, HubDependent {
    event ParameterChanged(string parameterName, uint256 parameterValue);
    /// @notice Emitted when the protocol treasury recipient changes. The
    ///         address is carried in its own event (rather than the
    ///         `uint256`-valued `ParameterChanged`) so off-chain indexers get a
    ///         typed `address` field.
    event ProtocolTreasurySet(address indexed treasury);

    error ZeroShardingTableSizeLimit();

    string private constant _NAME = "ParametersStorage";
    // protocol treasury fee (`protocolTreasuryFee`, `protocolTreasury`,
    // `MAX_PROTOCOL_TREASURY_FEE`) skimmed from the staker-bound TRAC on
    // every paid publish / update / lifetime-extension.
    string private constant _VERSION = "10.0.3";

    uint96 public minimumStake;
    uint96 public maximumStake;

    uint256 public stakeWithdrawalDelay;
    uint256 public nodeAskUpdateDelay;
    uint256 public operatorFeeUpdateDelay;

    uint16 public opWalletsLimitOnProfileCreation;
    uint16 public shardingTableSizeLimit;

    uint256 public minimumRequiredSignatures;

    uint256 public askUpperBoundFactor;
    uint256 public askLowerBoundFactor;

    uint16 public maxOperatorFee;

    uint256 public v81ReleaseEpoch;
    uint256 public publishingConvictionEpochs;

    /// @notice Protocol treasury fee in basis points (out of 10_000) skimmed
    ///         from the staker-bound TRAC on every paid publish / update /
    ///         lifetime-extension. The fee is taken out of the amount that
    ///         would otherwise flow to the staker reward pool — it does NOT
    ///         change the price a publisher pays. Default 300 (3%).
    ///
    ///         The fee is a no-op while `protocolTreasury == address(0)`
    ///         (the full amount flows to stakers), so it stays dormant until
    ///         governance wires a treasury recipient via `setProtocolTreasury`.
    uint16 public protocolTreasuryFee;

    /// @notice Recipient of the protocol treasury fee. The zero address
    ///         disables the fee entirely regardless of `protocolTreasuryFee`.
    address public protocolTreasury;

    /// @notice Hard upper bound on `protocolTreasuryFee` (10%). Bounds
    ///         governance so the fee can never be set to an extractive level
    ///         that would starve the staker reward pool.
    uint16 public constant MAX_PROTOCOL_TREASURY_FEE = 1_000;

    /// @notice Hard upper bound on `publishingConvictionEpochs`.
    ///
    /// `DKGPublishingConvictionNFT._settleElapsed` / `_finalSweep` loop
    /// `lockDurationEpochs` times in the worst case (dormant account
    /// settled at expiry). Each iteration costs ~30–50k gas
    /// (`windowSpent` SLOAD + one or two `epochStorage.addTokensToEpochRange`
    /// writes + a `WindowSettled` event), so an unbounded
    /// `publishingConvictionEpochs` (the previous cap was `uint16.max`)
    /// would let governance brick PCAs by setting the parameter past
    /// the block-gas budget. 60 chain epochs ≈ 5 years at a 1-month
    /// epoch length and worst-cases at ~3M gas — comfortably below
    /// the block limit while leaving room for the surrounding
    /// `publish` / `topUp` / NFT-transfer work.
    uint256 public constant MAX_PUBLISHING_CONVICTION_EPOCHS = 60;

    // @dev Only transactions by HubController owner or one of the owners of the MultiSig Wallet
    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    constructor(address hubAddress, uint256 _v81ReleaseEpoch) HubDependent(hubAddress) {
        minimumStake = 50_000 ether;
        maximumStake = 10_000_000 ether;

        stakeWithdrawalDelay = 28 days;
        nodeAskUpdateDelay = 1 days;
        operatorFeeUpdateDelay = 28 days;

        opWalletsLimitOnProfileCreation = 50;
        shardingTableSizeLimit = 500;

        minimumRequiredSignatures = 3;

        askUpperBoundFactor = 1467000000000000000;
        askLowerBoundFactor = 533000000000000000;

        maxOperatorFee = 10_000;

        // Epoch when v8.1 was released on mainnet/testnet
        // Change if you ever redeploy delegatorsInfo contract on either network
        v81ReleaseEpoch = _v81ReleaseEpoch;
        publishingConvictionEpochs = 12;

        // 3% default. Dormant until `protocolTreasury` is set (defaults to
        // the zero address), so a fresh deploy behaves exactly as before
        // until governance opts in.
        protocolTreasuryFee = 300;
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function setAskUpperBoundFactor(uint256 _askUpperBoundFactor) external onlyOwnerOrMultiSigOwner {
        askUpperBoundFactor = _askUpperBoundFactor;
    }

    function setAskLowerBoundFactor(uint256 _askLowerBoundFactor) external onlyOwnerOrMultiSigOwner {
        askLowerBoundFactor = _askLowerBoundFactor;
    }

    function setMinimumRequiredSignatures(uint256 _minimumRequiredSignatures) external onlyOwnerOrMultiSigOwner {
        minimumRequiredSignatures = _minimumRequiredSignatures;

        emit ParameterChanged("minimumRequiredSignatures", _minimumRequiredSignatures);
    }

    function setMinimumStake(uint96 newMinimumStake) external onlyOwnerOrMultiSigOwner {
        minimumStake = newMinimumStake;

        emit ParameterChanged("minimumStake", newMinimumStake);
    }

    function setMaximumStake(uint96 newMaximumStake) external onlyOwnerOrMultiSigOwner {
        maximumStake = newMaximumStake;

        emit ParameterChanged("maximumStake", newMaximumStake);
    }

    function setStakeWithdrawalDelay(uint256 newStakeWithdrawalDelay) external onlyOwnerOrMultiSigOwner {
        stakeWithdrawalDelay = newStakeWithdrawalDelay;

        emit ParameterChanged("stakeWithdrawalDelay", newStakeWithdrawalDelay);
    }

    function setNodeAskUpdateDelay(uint256 newNodeAskUpdateDelay) external onlyOwnerOrMultiSigOwner {
        nodeAskUpdateDelay = newNodeAskUpdateDelay;

        emit ParameterChanged("nodeAskUpdateDelay", newNodeAskUpdateDelay);
    }

    function setOperatorFeeUpdateDelay(uint256 newOperatorFeeUpdateDelay) external onlyOwnerOrMultiSigOwner {
        operatorFeeUpdateDelay = newOperatorFeeUpdateDelay;

        emit ParameterChanged("operatorFeeUpdateDelay", newOperatorFeeUpdateDelay);
    }

    function setOpWalletsLimitOnProfileCreation(
        uint16 opWalletsLimitOnProfileCreation_
    ) external onlyOwnerOrMultiSigOwner {
        opWalletsLimitOnProfileCreation = opWalletsLimitOnProfileCreation_;

        emit ParameterChanged("opWalletsLimitOnProfileCreation", opWalletsLimitOnProfileCreation);
    }

    function setShardingTableSizeLimit(uint16 shardingTableSizeLimit_) external onlyOwnerOrMultiSigOwner {
        // Reject 0: ShardingTable._insertNode now enforces this cap
        // (`nodesCount >= limit` reverts ShardingTableIsFull), so a 0 limit would
        // freeze ALL node admission (even the first insert), bricking staking. 0
        // is never a meaningful table size — reject it rather than let it act as
        // an implicit pause switch.
        if (shardingTableSizeLimit_ == 0) revert ZeroShardingTableSizeLimit();
        shardingTableSizeLimit = shardingTableSizeLimit_;

        emit ParameterChanged("shardingTableSizeLimit", shardingTableSizeLimit);
    }

    function setMaxOperatorFee(uint16 maxOperatorFee_) external onlyOwnerOrMultiSigOwner {
        maxOperatorFee = maxOperatorFee_;

        emit ParameterChanged("maxOperatorFee", maxOperatorFee);
    }

    function setV81ReleaseEpoch(uint256 _v81ReleaseEpoch) external onlyOwnerOrMultiSigOwner {
        v81ReleaseEpoch = _v81ReleaseEpoch;

        emit ParameterChanged("v81ReleaseEpoch", _v81ReleaseEpoch);
    }

    function setPublishingConvictionEpochs(
        uint256 _publishingConvictionEpochs
    ) external onlyOwnerOrMultiSigOwner {
        require(_publishingConvictionEpochs > 0, "publishingConvictionEpochs must be > 0");
        // See `MAX_PUBLISHING_CONVICTION_EPOCHS` for the gas-budget
        // rationale. The previous `<= type(uint16).max` bound permitted
        // values that would gas-out PCA settlement.
        require(
            _publishingConvictionEpochs <= MAX_PUBLISHING_CONVICTION_EPOCHS,
            "publishingConvictionEpochs too large"
        );
        publishingConvictionEpochs = _publishingConvictionEpochs;

        emit ParameterChanged("publishingConvictionEpochs", _publishingConvictionEpochs);
    }

    function setProtocolTreasuryFee(uint16 protocolTreasuryFee_) external onlyOwnerOrMultiSigOwner {
        // See `MAX_PROTOCOL_TREASURY_FEE` for the rationale on the upper
        // bound. 0 is allowed (disables the fee while keeping the recipient
        // wired) — the floor is enforced implicitly by the unsigned type.
        require(protocolTreasuryFee_ <= MAX_PROTOCOL_TREASURY_FEE, "protocolTreasuryFee too large");
        protocolTreasuryFee = protocolTreasuryFee_;

        emit ParameterChanged("protocolTreasuryFee", protocolTreasuryFee_);
    }

    function setProtocolTreasury(address protocolTreasury_) external onlyOwnerOrMultiSigOwner {
        protocolTreasury = protocolTreasury_;

        emit ProtocolTreasurySet(protocolTreasury_);
    }

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
