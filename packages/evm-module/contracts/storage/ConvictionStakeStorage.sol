// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";

contract ConvictionStakeStorage is INamed, IVersioned, ContractStatus {
    string private constant _NAME = "ConvictionStakeStorage";
    string private constant _VERSION = "1.0.0";

    // identityId => effective (multiplied) node stake: sum of (principal * multiplier) per node
    mapping(uint72 => uint256) public effectiveNodeStake;
    // network-wide sum of all effective stake
    uint256 public effectiveTotalStake;

    event EffectiveNodeStakeUpdated(uint72 indexed identityId, uint256 effectiveStake);
    event EffectiveTotalStakeUpdated(uint256 effectiveTotalStake);

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function getEffectiveNodeStake(uint72 identityId) external view returns (uint256) {
        return effectiveNodeStake[identityId];
    }

    function setEffectiveNodeStake(uint72 identityId, uint256 amount) external onlyContracts {
        effectiveNodeStake[identityId] = amount;
        emit EffectiveNodeStakeUpdated(identityId, amount);
    }

    function increaseEffectiveNodeStake(uint72 identityId, uint256 addedStake) external onlyContracts {
        effectiveNodeStake[identityId] += addedStake;
        emit EffectiveNodeStakeUpdated(identityId, effectiveNodeStake[identityId]);
    }

    function decreaseEffectiveNodeStake(uint72 identityId, uint256 removedStake) external onlyContracts {
        effectiveNodeStake[identityId] -= removedStake;
        emit EffectiveNodeStakeUpdated(identityId, effectiveNodeStake[identityId]);
    }

    function getEffectiveTotalStake() external view returns (uint256) {
        return effectiveTotalStake;
    }

    function setEffectiveTotalStake(uint256 amount) external onlyContracts {
        effectiveTotalStake = amount;
        emit EffectiveTotalStakeUpdated(amount);
    }

    function increaseEffectiveTotalStake(uint256 addedStake) external onlyContracts {
        effectiveTotalStake += addedStake;
        emit EffectiveTotalStakeUpdated(effectiveTotalStake);
    }

    function decreaseEffectiveTotalStake(uint256 removedStake) external onlyContracts {
        effectiveTotalStake -= removedStake;
        emit EffectiveTotalStakeUpdated(effectiveTotalStake);
    }
}
