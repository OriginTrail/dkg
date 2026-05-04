// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";

contract Identity is INamed, IVersioned, ContractStatus, IInitializable {
    event IdentityCreated(uint72 indexed identityId, bytes32 indexed operationalKey, bytes32 indexed adminKey);
    event IdentityDeleted(uint72 indexed identityId);

    string private constant _NAME = "Identity";
    string private constant _VERSION = "1.0.0";

    IdentityStorage public identityStorage;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier onlyAdmin(uint72 identityId) {
        _checkAdmin(identityId);
        _;
    }

    function initialize() public onlyHub {
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function createIdentity(address operational, address admin) external onlyContracts returns (uint72) {
        if (operational == address(0)) {
            revert IdentityLib.OperationalAddressZero();
        }
        if (admin == address(0)) {
            revert IdentityLib.AdminAddressZero();
        }
        if (admin == operational) {
            revert IdentityLib.AdminEqualsOperational();
        }

        IdentityStorage ids = identityStorage;

        uint72 identityId = ids.generateIdentityId();

        bytes32 adminKey = keccak256(abi.encodePacked(admin));
        ids.addKey(identityId, adminKey, IdentityLib.ADMIN_KEY, IdentityLib.ECDSA);

        bytes32 operationalKey = keccak256(abi.encodePacked(operational));
        ids.addKey(identityId, operationalKey, IdentityLib.OPERATIONAL_KEY, IdentityLib.ECDSA);

        ids.setOperationalKeyIdentityId(operationalKey, identityId);

        emit IdentityCreated(identityId, operationalKey, adminKey);

        return identityId;
    }

    function deleteIdentity(uint72 identityId) external onlyContracts {
        identityStorage.deleteIdentity(identityId);

        emit IdentityDeleted(identityId);
    }

    function addKey(
        uint72 identityId,
        bytes32 key,
        uint256 keyPurpose,
        uint256 keyType
    ) external onlyAdmin(identityId) {
        if (key == bytes32(0)) {
            revert IdentityLib.KeyIsEmpty();
        }

        IdentityStorage ids = identityStorage;

        if (keyPurpose == IdentityLib.OPERATIONAL_KEY) {
            if (ids.identityIds(key) != 0) {
                revert IdentityLib.OperationalKeyTaken(key);
            }
            ids.setOperationalKeyIdentityId(key, identityId);
        }

        bytes32 attachedKey;
        (, , attachedKey) = ids.getKey(identityId, key);
        if (attachedKey == key) {
            revert IdentityLib.KeyAlreadyAttached(key);
        }

        ids.addKey(identityId, key, keyPurpose, keyType);
    }

    function removeKey(uint72 identityId, bytes32 key) external onlyAdmin(identityId) {
        if (key == bytes32(0)) {
            revert IdentityLib.KeyIsEmpty();
        }

        IdentityStorage ids = identityStorage;

        uint256 purpose;
        bytes32 attachedKey;
        (purpose, , attachedKey) = ids.getKey(identityId, key);
        if (attachedKey != key) {
            revert IdentityLib.KeyNotAttached(key);
        }

        if (
            ids.getKeysByPurpose(identityId, IdentityLib.ADMIN_KEY).length == 1 &&
            ids.keyHasPurpose(identityId, key, IdentityLib.ADMIN_KEY)
        ) {
            revert IdentityLib.CannotDeleteOnlyAdminKey(identityId);
        }

        if (
            ids.getKeysByPurpose(identityId, IdentityLib.OPERATIONAL_KEY).length == 1 &&
            ids.keyHasPurpose(identityId, key, IdentityLib.OPERATIONAL_KEY)
        ) {
            revert IdentityLib.CannotDeleteOnlyOperationalKey(identityId);
        }

        ids.removeKey(identityId, key);

        if (purpose == IdentityLib.OPERATIONAL_KEY) {
            ids.removeOperationalKeyIdentityId(key);
        }
    }

    function addOperationalWallets(uint72 identityId, address[] calldata operationalWallets) external onlyContracts {
        IdentityStorage ids = identityStorage;

        bytes32 operationalKey;
        bytes32 attachedKey;

        for (uint256 i; i < operationalWallets.length; ) {
            if (operationalWallets[i] == address(0)) {
                revert IdentityLib.OperationalAddressZero();
            }

            operationalKey = keccak256(abi.encodePacked(operationalWallets[i]));

            if (operationalKey == bytes32(0)) {
                revert IdentityLib.KeyIsEmpty();
            }
            if (ids.identityIds(operationalKey) != 0) {
                revert IdentityLib.OperationalKeyTaken(operationalKey);
            }

            ids.setOperationalKeyIdentityId(operationalKey, identityId);

            (, , attachedKey) = ids.getKey(identityId, operationalKey);
            if (attachedKey == operationalKey) {
                revert IdentityLib.KeyAlreadyAttached(operationalKey);
            }

            ids.addKey(identityId, operationalKey, IdentityLib.OPERATIONAL_KEY, IdentityLib.ECDSA);

            unchecked {
                i++;
            }
        }
    }

    function _checkAdmin(uint72 identityId) internal view virtual {
        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(msg.sender)), IdentityLib.ADMIN_KEY)
        ) {
            revert IdentityLib.AdminFunctionOnly(identityId, msg.sender);
        }
    }
}
