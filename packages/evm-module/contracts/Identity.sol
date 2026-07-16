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
    // Version history:
    //   1.0.0 — initial release.
    //   1.1.0 — `addOperationalWallets` now disambiguates same-identity
    //           collisions (primary added by `createIdentity` OR intra-
    //           array duplicate within the same call) from cross-identity
    //           collisions via the new `OperationalWalletDuplicate(wallet)`
    //           error. `OperationalKeyTaken(key)` remains reserved for
    //           the cross-identity case. Dropped the dead `KeyIsEmpty()`
    //           pre-check (impossible after the zero-address check).
    string private constant _VERSION = "10.0.2";

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
        uint72 existingId;

        for (uint256 i; i < operationalWallets.length; ) {
            if (operationalWallets[i] == address(0)) {
                revert IdentityLib.OperationalAddressZero();
            }

            operationalKey = keccak256(abi.encodePacked(operationalWallets[i]));

            existingId = ids.identityIds(operationalKey);
            // Same-identity collision: either the wallet was attached as
            // the primary op key by `createIdentity` (the createProfile
            // entrypoint passes `msg.sender` to that, then the same
            // address inside `operationalWallets` reaches us here), or
            // it was added by an earlier iteration of this same loop
            // (intra-array duplicate). Both surface as
            // `OperationalWalletDuplicate(wallet)` so callers don't
            // confuse them with the cross-identity collision below.
            if (existingId == identityId) {
                revert IdentityLib.OperationalWalletDuplicate(operationalWallets[i]);
            }
            if (existingId != 0) {
                revert IdentityLib.OperationalKeyTaken(operationalKey);
            }

            ids.setOperationalKeyIdentityId(operationalKey, identityId);

            (, , attachedKey) = ids.getKey(identityId, operationalKey);
            // Defensive: the key is already attached with some purpose
            // (admin OR operational). On the createProfile path this
            // fires when an op-wallet entry equals `adminWallet` — the
            // key was attached as `ADMIN_KEY` by `createIdentity` and
            // would now be attached again as `OPERATIONAL_KEY`. The
            // surfaced error is `KeyAlreadyAttached(key)`; admin/
            // operational wallet reuse is a deliberate operator choice
            // and stays un-policed beyond this attachment check.
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
