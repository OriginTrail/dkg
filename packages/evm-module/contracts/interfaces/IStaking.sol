// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IStaking
 * @notice Narrow interface for the Staking contract — exposes only the
 *         externally-visible surface that other V10 contracts need to call
 *         cross-contract. Currently scoped to the two-layer staking wire
 *         entry point used by `DKGStakingConvictionNFT`; extend as Phase 5
 *         and Phase 11 add more call sites.
 */
interface IStaking {
    /// @notice V10 permissioned entry for recording NFT-backed stake into
    ///         `StakingStorage`. See `Staking._recordStake` for the full
    ///         NatSpec, gate semantics, and trust model.
    function _recordStake(
        uint256 tokenId,
        uint72 identityId,
        uint96 amount,
        uint40 lockEpochs
    ) external;
}
