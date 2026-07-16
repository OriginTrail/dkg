// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IContextGraphWaiverStorage
 * @notice Minimal interface ContextGraphs uses to consume the OT-RFC-53
 *         PCA-backed registration-deposit waiver. Kept minimal (one mutator +
 *         the counter getter) to avoid pulling the full storage contract into
 *         ContextGraphs' compilation unit / bytecode budget.
 */
interface IContextGraphWaiverStorage {
    /// @notice CGs created with the deposit waived against PCA `accountId`.
    function waivedCgCount(uint256 accountId) external view returns (uint256);

    /// @notice Attempt to waive the registration deposit for a CG backed by PCA
    ///         `accountId`, created by `creator`, when the current deposit is
    ///         `deposit`. Returns true (and consumes one per-PCA quota slot)
    ///         only when the PCA is active/backed, meets the governance stake
    ///         floor, `creator` is its owner or a registered agent, and the
    ///         PCA's quota (`committedTRAC / deposit`) is not exhausted.
    ///         ContextGraphs-only.
    function tryConsumeWaiver(
        uint256 accountId,
        address creator,
        uint96 deposit
    ) external returns (bool waived);
}
