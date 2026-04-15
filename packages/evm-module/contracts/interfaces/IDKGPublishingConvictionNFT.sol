// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @title IDKGPublishingConvictionNFT
 * @notice Minimal interface over DKGPublishingConvictionNFT for dependency inversion.
 *
 * @dev ContextGraphs resolves a PCA agent -> account mapping when checking
 *      publish authorization for PCA curator type, and validates that a
 *      (publishAuthority, publishAuthorityAccountId) pair is coherent on
 *      create / update paths. Using a minimal interface (two view getters)
 *      instead of importing the full contract avoids a cross-module circular
 *      import risk and keeps the facade replaceable.
 *
 *      `agentToAccountId` is declared `public` in DKGPublishingConvictionNFT,
 *      so the auto-generated getter returns the account id for a registered
 *      agent (zero if the agent is not registered).
 *
 *      `ownerOf` is inherited from ERC-721: DKGPublishingConvictionNFT is an
 *      `ERC721Enumerable`, and its token IDs mirror account IDs. The CG
 *      coherence check requires the publishAuthority (account-owner marker)
 *      to equal the current owner of the account's NFT — this locks the
 *      interface to an ERC-721-backed NFT implementation and blocks drop-in
 *      replacements that don't expose `ownerOf`.
 *
 *      NOTE on revert behavior: OZ's ERC721 `ownerOf` reverts with
 *      `ERC721NonexistentToken` when the token has never been minted (i.e.
 *      the account does not exist). Callers MUST wrap in try/catch.
 */
interface IDKGPublishingConvictionNFT {
    /// @notice Returns the account id a given agent is registered under, or 0.
    function agentToAccountId(address agent) external view returns (uint256);

    /// @notice Returns the current owner of an account's ERC-721 token.
    /// @dev Reverts for non-existent tokens (no such account). Callers MUST
    ///      use try/catch to distinguish "no such account" from a live miss.
    function ownerOf(uint256 accountId) external view returns (address);

    /// @notice Spend a publishing agent's conviction allowance for a base cost.
    /// @dev Caller MUST be `KnowledgeAssetsV10` — the NFT gates this via Hub
    ///      lookup. The NFT resolves the paying account internally from
    ///      `agentToAccountId[publishingAgent]`, so KAV10 MUST NOT supply an
    ///      account id (N28 closure: removes victim-account-drain vector).
    ///
    ///      Reverts:
    ///      - `NoConvictionAccount(publishingAgent)` if agent has no account.
    ///      - `AccountExpired(accountId, expiresAt)` if account is past lock.
    ///      - `InsufficientAllowance(...)` if epoch + top-up cannot cover cost.
    ///      - `OnlyKnowledgeAssetsV10(caller)` if msg.sender is not KAV10.
    ///
    ///      Does NOT move TRAC — TRAC is already in StakingStorage from the
    ///      NFT's `createAccount`/`topUp` paths. This call only updates the
    ///      per-epoch spent ledger and returns the discounted amount for
    ///      caller-side accounting.
    function coverPublishingCost(
        address publishingAgent,
        uint96 baseCost
    ) external returns (uint96 discountedCost);
}
