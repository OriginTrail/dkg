// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

library ProfileLib {
    struct OperatorFee {
        uint16 feePercentage;
        uint256 effectiveDate;
    }

    struct ProfileInfo {
        string name;
        bytes nodeId;
        uint96 ask;
        OperatorFee[] operatorFees;
        // Network State Registry (RFC 04 v0.3 / Issue #461). Appended to the
        // tail of the struct so existing storage layouts in mappings stay
        // backwards-compatible at the slot level: old keys read this as
        // false until the operator opts in via Profile.updateRelayCapable.
        // Multiaddrs are deliberately NOT stored on Profile — they live in
        // per-round attestation KCs (RFC 04 §5.2).
        bool relayCapable;
    }

    error IdentityAlreadyExists(uint72 identityId, address wallet);
    error TooManyOperationalWallets(uint16 allowed, uint16 provided);
    error EmptyNodeName();
    error EmptyNodeId();
    error NodeNameAlreadyExists(string nodeName);
    error NodeIdAlreadyExists(bytes nodeId);
    error OperatorFeeOutOfRange(uint16 operatorFee);
    error ZeroAsk();
    error AskUpdateOnCooldown(uint72 identityId, uint256 cooldownEnd);
    error NoOperatorFees(uint72 identityId);
    error ProfileDoesntExist(uint72 identityId);
    error ProfileAlreadyExists(uint72 identityId);
    error NodeIdShardingMismatch(uint72 identityId, bytes expected, bytes provided);
    error NoPendingNodeAsk();
    error NoPendingOperatorFee();
    error InvalidOperatorFee();
}
