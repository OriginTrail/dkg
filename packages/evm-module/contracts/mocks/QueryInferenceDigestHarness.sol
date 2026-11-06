// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {QueryInferenceSettlement} from "../QueryInferenceSettlement.sol";

/// @title QueryInferenceDigestHarness
/// @notice Test-only: exposes the two digests `submitReceiptBatch` hashes in
///         scratch memory, so a test compares them with `hashRequest` and
///         `hashReceipt` at widths no real batch reaches, a seller's identity
///         and a time at the limit of their types. Pure, so it needs neither a
///         Hub registration nor `initialize()`.
contract QueryInferenceDigestHarness is QueryInferenceSettlement {
    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) QueryInferenceSettlement(hubAddress) {}

    function batchRequestDigest(
        bytes32 domain,
        bytes32 subscriptionId,
        bytes32 serviceId,
        uint72 seller,
        ReceiptItem calldata it
    ) external pure returns (bytes32) {
        return _requestDigest(domain, subscriptionId, serviceId, seller, it);
    }

    function batchReceiptDigest(
        bytes32 domain,
        bytes32 requestDigest,
        ReceiptItem calldata it
    ) external pure returns (bytes32) {
        return _receiptDigest(domain, requestDigest, it);
    }
}
