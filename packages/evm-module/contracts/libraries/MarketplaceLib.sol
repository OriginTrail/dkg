// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/// @title MarketplaceLib
/// @notice Shared value types for the OT-RFC-27 NeuroSymbolic Marketplace
///         prototype (`Marketplace` + `MarketplaceStorage`).
library MarketplaceLib {
    /// @notice Per-(buyer, epoch) subscription bucket. `funded` is the
    ///         non-refundable TRAC paid in (wei, uint96 to match staking);
    ///         `totalClaimed` / `totalFinalized` accumulate receipt value.
    struct Bucket {
        uint96 funded;
        uint256 totalClaimed;
        uint256 totalFinalized;
        bool finalized;
    }

    /// @notice Per-(buyer, epoch, seller identity) claim accumulator.
    ///         `qiRaw` is Σ claimValue·S18/1e18 with the stake factor S18
    ///         captured at receipt-batch acceptance (NOT at finalization).
    struct SellerClaim {
        uint256 claimed;
        uint256 qiRaw;
    }

    /// @notice One buyer-authorized receipt claim, as submitted on-chain by a
    ///         seller Core Node. The seller identity is NOT a field: it is
    ///         resolved from the submitting operational wallet, and the
    ///         recomputed authorization digest binds it (wrong-seller
    ///         submissions fail signature verification).
    struct ReceiptClaim {
        address buyer;
        uint256 epoch;
        bytes32 offeringId;
        bytes32 callId;
        uint64 maxUnits;
        uint96 askPerUnit;
        uint40 expiry;
        uint64 servedUnits;
        bytes32 resultCommitment;
        bytes authSignature;
    }
}
