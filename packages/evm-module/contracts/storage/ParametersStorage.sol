// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";

contract ParametersStorage is INamed, IVersioned, HubDependent {
    event ParameterChanged(string parameterName, uint256 parameterValue);

    string private constant _NAME = "ParametersStorage";
    string private constant _VERSION = "1.0.0";

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
