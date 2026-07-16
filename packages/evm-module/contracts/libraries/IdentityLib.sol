// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library IdentityLib {
    uint256 public constant ADMIN_KEY = 1;
    uint256 public constant OPERATIONAL_KEY = 2;
    uint256 public constant ECDSA = 1;
    uint256 public constant RSA = 2;

    error OperationalAddressZero();
    error AdminAddressZero();
    error AdminEqualsOperational();
    error KeyIsEmpty();
    error OperationalKeyTaken(bytes32 key);
    error KeyAlreadyAttached(bytes32 key);
    error KeyNotAttached(bytes32 key);
    error CannotDeleteOnlyAdminKey(uint72 identityId);
    error CannotDeleteOnlyOperationalKey(uint72 identityId);
    error AdminFunctionOnly(uint72 identityId, address sender);

    // Distinct diagnostic for the `Identity.addOperationalWallets`
    // same-identity collision case. `existingId == identityId` covers
    // both "wallet was added as the primary by `createIdentity`" and
    // "wallet was added by an earlier iteration of the same
    // `addOperationalWallets` call" — both are duplicate attachments
    // to the SAME identity from the caller's perspective.
    // `OperationalKeyTaken(bytes32)` remains in use for the
    // cross-identity (`identityIds[k] != 0 && != identityId`) case.
    error OperationalWalletDuplicate(address wallet);
}
