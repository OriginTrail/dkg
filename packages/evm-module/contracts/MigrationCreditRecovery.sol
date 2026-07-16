// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";

/**
 * @title MigrationCreditRecovery
 * @notice Standalone, node-INDEPENDENT recovery path for V8→V10 migration
 *         credit. Lets a delegator (or operator) reclaim their UNALLOCATED
 *         migration credit straight to their wallet, with no node, no V10
 *         profile, and no position involved.
 *
 * @dev WHY A SEPARATE CONTRACT.
 *      The admin V8→V10 drain writes per-wallet `migrationCredit` on
 *      `ConvictionStakingStorage` (CSS), backed 1:1 by TRAC moved into the CSS
 *      vault. Until now the ONLY sink for that credit was
 *      `DKGStakingConvictionNFT.allocate` → `StakingV10.allocateFromCredit`,
 *      whose first statement reverts `ProfileDoesNotExist` when the target node
 *      has no V10 profile. On a freshly-deployed chain with zero profiles
 *      (e.g. NeuroWeb immediately post-cutover) that strands every migrant's
 *      credit — neither allocatable (no profile to allocate against) nor
 *      withdrawable (no position can have been created), recoverable only via
 *      the Hub-owner god-key.
 *
 *      We cannot add this function to an existing contract without breaking the
 *      "same contract set on every chain" invariant:
 *        - `StakingV10` is already within ~500 bytes of the 24,576-byte EIP-170
 *          limit, so it has no room.
 *        - `DKGStakingConvictionNFT` is a plain (non-proxy) ERC-721; redeploying
 *          it on a live chain would orphan every existing position NFT and reset
 *          the tokenId counter.
 *        - `ConvictionStakingStorage` is THE vault + position store; redeploying
 *          it would destroy all staking state.
 *      A brand-new, stateless contract sidesteps all three: it is deployed and
 *      Hub-registered identically on EVERY chain (Base, Gnosis, NeuroWeb),
 *      leaving the live contracts untouched.
 *
 *      WHY IT WORKS ON ALREADY-LIVE CHAINS WITHOUT REDEPLOYING CSS.
 *      CSS's `spendMigrationCredit` and `transferStake` are `onlyContracts`,
 *      which checks `hub.isContract(msg.sender)` against the LIVE Hub registry
 *      at call time. Once this contract is registered in the Hub, the existing
 *      deployed CSS admits it — no CSS/wrapper redeploy needed. This is the
 *      exact same gate `StakingV10` already uses to call `transferStake` in
 *      `withdraw`, so the trust model is unchanged.
 *
 *      SAFETY.
 *      The contract holds no funds and has no admin surface. Each entry point
 *      forwards `msg.sender` as the credit owner and follows checks-effects-
 *      interactions: `spendMigrationCredit` (which reverts on `amount == 0` or
 *      `amount > migrationCredit[msg.sender]`) debits FIRST, then `transferStake`
 *      moves exactly `amount` TRAC out of the vault to the caller. TRAC has no
 *      transfer hooks, so there is no reentrancy vector and no need for a guard
 *      (matching the house convention). A caller can therefore only ever move
 *      their own credit, in an amount they actually hold — it cannot be used to
 *      drain the vault. Unallocated credit has no position / node-stake / score
 *      / sharding-table state, so this is a pure ledger debit + vault outflow
 *      with no downstream accounting to disturb. It does not weaken the
 *      economic model: a tier-0 `allocate → withdraw` already cashed credit out
 *      fully once a profile existed; this only removes the node-existence
 *      precondition.
 */
contract MigrationCreditRecovery is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "MigrationCreditRecovery";
    string private constant _VERSION = "1.0.0";

    ConvictionStakingStorage public convictionStorage;

    error ZeroAmount();

    /// @notice Emitted when a delegator/operator reclaims unallocated migration
    ///         credit straight to their wallet. Reconciliation: a wallet's
    ///         outstanding credit = Σ(`MigrationStarted` + `OperatorFeeMigrated`)
    ///         − Σ(`Allocated.amount`) − Σ(`MigrationCreditWithdrawn.amount`).
    /// @param staker The wallet whose credit was refunded.
    /// @param amount TRAC refunded out of the CSS vault.
    event MigrationCreditWithdrawn(address indexed staker, uint96 amount);

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires the single Hub-registered dependency (CSS). Called by the Hub
    ///      via `forwardCall` at deploy time, so `msg.sender == hub` → `onlyHub`.
    function initialize() external onlyHub {
        convictionStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /// @notice Reclaim `amount` of the caller's unallocated migration credit
    ///         directly to their wallet. Repeatable; pass
    ///         `convictionStorage.migrationCredit(msg.sender)` (or use
    ///         `withdrawMigrationCreditAll`) to drain it fully. No node, no
    ///         profile, no position required.
    /// @param amount TRAC amount of credit to refund; must be > 0 and <= the
    ///        caller's current `migrationCredit`.
    function withdrawMigrationCredit(uint96 amount) external {
        if (amount == 0) revert ZeroAmount();
        ConvictionStakingStorage cs = convictionStorage;
        cs.spendMigrationCredit(msg.sender, amount);
        cs.transferStake(msg.sender, amount);
        // CSS is a trusted Hub-registered contract (no untrusted callback) and the
        // credit debit committed before the transfer, so emitting after the calls
        // is safe — slither reentrancy-events false positive.
        // slither-disable-next-line reentrancy-events
        emit MigrationCreditWithdrawn(msg.sender, amount);
    }

    /// @notice Convenience: reclaim the caller's ENTIRE remaining migration
    ///         credit in one call. Reverts `ZeroAmount` if the caller holds no
    ///         credit. No race — only the owner can spend their own credit and
    ///         the admin drain can only ADD to it, so the read-then-spend is
    ///         safe.
    /// @return amount TRAC refunded (the caller's full credit at call time).
    function withdrawMigrationCreditAll() external returns (uint96 amount) {
        ConvictionStakingStorage cs = convictionStorage;
        amount = cs.migrationCredit(msg.sender);
        if (amount == 0) revert ZeroAmount();
        cs.spendMigrationCredit(msg.sender, amount);
        cs.transferStake(msg.sender, amount);
        // CSS is a trusted Hub-registered contract (no untrusted callback) and the
        // credit debit committed before the transfer, so emitting after the calls
        // is safe — slither reentrancy-events false positive.
        // slither-disable-next-line reentrancy-events
        emit MigrationCreditWithdrawn(msg.sender, amount);
    }
}
