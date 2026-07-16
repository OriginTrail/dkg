// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {IERC734Extended} from "../interfaces/IERC734Extended.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {ByteArr} from "../libraries/ByteArr.sol";
import {IdentityLib} from "../libraries/IdentityLib.sol";
import {IdentityStorage} from "../storage/IdentityStorage.sol";

contract IdentityStorage is IERC734Extended, INamed, IVersioned, HubDependent {
    using ByteArr for bytes32[];

    string private constant _NAME = "IdentityStorage";
    string private constant _VERSION = "10.0.2";

    uint72 public lastIdentityId;

    struct Identity {
        mapping(bytes32 => Key) keys;
        mapping(uint256 => bytes32[]) keysByPurpose;
    }

    // operationalKey => identityId
    mapping(bytes32 => uint72) public identityIds;
    // identityId => Identity
    mapping(uint72 => Identity) internal identities;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function deleteIdentity(uint72 identityId) external virtual onlyContracts {
        bytes32[] memory operationalKeys = identities[identityId].keysByPurpose[IdentityLib.OPERATIONAL_KEY];
        uint256 operationalKeysNumber = operationalKeys.length;

        for (uint256 i; i < operationalKeysNumber; ) {
            delete identityIds[operationalKeys[i]];
            unchecked {
                i++;
            }
        }

        delete identities[identityId];
    }

    function addKey(
        uint72 identityId,
        bytes32 _key,
        uint256 _purpose,
        uint256 _type
    ) external virtual override onlyContracts {
        Identity storage identity = identities[identityId];
        identity.keys[_key].purpose = _purpose;
        identity.keys[_key].keyType = _type;
        identity.keys[_key].key = _key;
        identity.keysByPurpose[_purpose].push(_key);

        emit KeyAdded(identityId, _key, _purpose, _type);
    }

    function removeKey(uint72 identityId, bytes32 _key) external virtual override onlyContracts {
        IdentityStorage.Identity storage identity = identities[identityId];

        uint256 index;
        (index, ) = identity.keysByPurpose[identity.keys[_key].purpose].indexOf(_key);
        identity.keysByPurpose[identity.keys[_key].purpose].removeByIndex(index);

        emit KeyRemoved(identityId, identity.keys[_key].key, identity.keys[_key].purpose, identity.keys[_key].keyType);

        delete identity.keys[_key];
    }

    function keyHasPurpose(
        uint72 identityId,
        bytes32 _key,
        uint256 _purpose
    ) external view virtual override returns (bool) {
        return identities[identityId].keys[_key].purpose == _purpose;
    }

    function getKey(
        uint72 identityId,
        bytes32 _key
    ) external view virtual override returns (uint256, uint256, bytes32) {
        return (
            identities[identityId].keys[_key].purpose,
            identities[identityId].keys[_key].keyType,
            identities[identityId].keys[_key].key
        );
    }

    function getKeysByPurpose(
        uint72 identityId,
        uint256 _purpose
    ) external view virtual override returns (bytes32[] memory) {
        return identities[identityId].keysByPurpose[_purpose];
    }

    function getIdentityId(address operational) external view returns (uint72) {
        return identityIds[keccak256(abi.encodePacked(operational))];
    }

    function setOperationalKeyIdentityId(bytes32 operationalKey, uint72 identityId) external virtual onlyContracts {
        identityIds[operationalKey] = identityId;
    }

    function removeOperationalKeyIdentityId(bytes32 operationalKey) external virtual onlyContracts {
        delete identityIds[operationalKey];
    }

    function setLastIdentityId(uint72 identityId) external virtual onlyContracts {
        lastIdentityId = identityId;
    }

    function generateIdentityId() external virtual onlyContracts returns (uint72) {
        unchecked {
            return ++lastIdentityId;
        }
    }
}
