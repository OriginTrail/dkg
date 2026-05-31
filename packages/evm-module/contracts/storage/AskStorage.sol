// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ParametersStorage} from "../storage/ParametersStorage.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";

contract AskStorage is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "AskStorage";
    string private constant _VERSION = "10.0.2";

    ParametersStorage public parametersStorage;

    uint256 public prevWeightedActiveAskSum;
    uint256 public weightedActiveAskSum;

    uint96 public prevTotalActiveStake;
    uint96 public totalActiveStake;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function getPricePerKbEpoch() external view returns (uint256) {
        return getStakeWeightedAverageAsk();
    }

    function getPrevPricePerKbEpoch() external view returns (uint256) {
        return getPrevStakeWeightedAverageAsk();
    }

    function getStakeWeightedAverageAsk() public view returns (uint256) {
        return totalActiveStake > 0 ? weightedActiveAskSum / totalActiveStake : 0;
    }

    function getPrevStakeWeightedAverageAsk() public view returns (uint256) {
        return prevTotalActiveStake > 0 ? prevWeightedActiveAskSum / prevTotalActiveStake : 0;
    }

    function getAskLowerBound() external view returns (uint256) {
        return (prevWeightedActiveAskSum * parametersStorage.askLowerBoundFactor()) / prevTotalActiveStake;
    }

    function getAskUpperBound() external view returns (uint256) {
        return (prevWeightedActiveAskSum * parametersStorage.askUpperBoundFactor()) / prevTotalActiveStake;
    }

    function getAskBounds() external view returns (uint256, uint256) {
        ParametersStorage params = parametersStorage;

        return (
            (prevWeightedActiveAskSum * params.askLowerBoundFactor()) / prevTotalActiveStake,
            (prevWeightedActiveAskSum * params.askUpperBoundFactor()) / prevTotalActiveStake
        );
    }

    function setWeightedActiveAskSum(uint256 _weightedActiveAskSum) external onlyContracts {
        weightedActiveAskSum = _weightedActiveAskSum;
    }

    function increaseWeightedActiveAskSum(uint256 amount) external onlyContracts {
        weightedActiveAskSum += amount;
    }

    function decreaseWeightedActiveAskSum(uint256 amount) external onlyContracts {
        weightedActiveAskSum -= amount;
    }

    function setPrevWeightedActiveAskSum(uint256 _prevWeightedActiveAskSum) external onlyContracts {
        prevWeightedActiveAskSum = _prevWeightedActiveAskSum;
    }

    function setTotalActiveStake(uint96 _totalActiveStake) external onlyContracts {
        totalActiveStake = _totalActiveStake;
    }

    function increaseTotalActiveStake(uint96 amount) external onlyContracts {
        totalActiveStake += amount;
    }

    function decreaseTotalActiveStake(uint96 amount) external onlyContracts {
        totalActiveStake -= amount;
    }

    function setPrevTotalActiveStake(uint96 _prevTotalActiveStake) external onlyContracts {
        prevTotalActiveStake = _prevTotalActiveStake;
    }
}
