// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {Permissions} from "./libraries/Permissions.sol";
import {StakingLib} from "./libraries/StakingLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";

/**
 * @title StakingV10Ledger
 * @notice The balance moves of `StakingV10` that touch no position: the
 *         operator-fee withdrawal (request, finalize, cancel) and the drains
 *         of V8 stake and V8 operator fees into migration credit. They run
 *         here, called by `StakingV10` only, because `StakingV10` with them
 *         inline measured 24,524 bytes, 52 under the EIP-170 limit.
 *
 * `StakingV10` keeps every entry point, its signature and its caller gate
 * (`onlyAdmin(identityId)` for the operator-fee withdrawal,
 * `onlyConvictionNFT` for the drains), and forwards to the function of the
 * same name here, which runs the body it had: the same checks in the same
 * order, the same custom errors, and the same reads and writes of
 * `StakingStorage` and `ConvictionStakingStorage`. A revert here reaches the
 * caller of `StakingV10` unchanged.
 *
 * Architecture: stateless logic, as `MigrationCreditRecovery`. It is
 * registered in the Hub's contract set, so the `onlyContracts` mutators of
 * the storages admit it, and it holds no TRAC: the operator-fee payout and
 * the V8 drain move TRAC between the storages' vaults and to the receiver
 * `StakingV10` names. It emits no events; the storages emit theirs.
 *
 * Gate: every entry point is `onlyStakingV10`, the contract the Hub holds
 * under that name, looked up at the call so a redeployed `StakingV10` is
 * admitted without re-initializing this one.
 */
contract StakingV10Ledger is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "StakingV10Ledger";
    // Version history:
    //   1.0.0 — the operator-fee withdrawal and the V8 drains into migration
    //           credit, moved out of StakingV10 10.0.5 unchanged.
    string private constant _VERSION = "1.0.0";

    // ========================================================================
    // Hub-wired dependencies
    // ========================================================================

    /// @notice V8 archive: the source of the V8 drains.
    StakingStorage public stakingStorage;
    /// @notice The V10 vault: operator-fee balances and withdrawal requests,
    ///         and migration credit.
    ConvictionStakingStorage public convictionStorage;
    /// @notice The admin-key check of the operator-fee drain.
    IdentityStorage public identityStorage;
    /// @notice The operator-fee withdrawal delay (`stakeWithdrawalDelay`).
    ParametersStorage public parametersStorage;

    // ========================================================================
    // Errors
    // ========================================================================

    /// @notice The caller is not the contract the Hub holds as `StakingV10`.
    error OnlyStakingV10();
    /// @notice A drain while the V8 `Staking` logic is still registered; the
    ///         error `StakingV10` declares.
    error V8StakingStillLive();

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    /// @dev Wires every dependency. The Hub reverts `ContractDoesNotExist` for
    ///      a name it does not hold. `StakingV10` is not wired: the gate looks
    ///      it up at each call.
    function initialize() external onlyHub {
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    modifier onlyStakingV10() {
        if (msg.sender != hub.getContractAddress("StakingV10")) revert OnlyStakingV10();
        _;
    }

    // ========================================================================
    // Operator-fee withdrawal
    //
    // `StakingV10` checks the caller holds ADMIN_KEY on `identityId` first.
    // Operators accrue fees in `StakingV10._claim`; the balance lives on CSS
    // (`nodeOperatorFeeBalance`), and withdrawing it to the operator's wallet
    // is a request → cooldown → finalize dance, mirroring V8
    // `Staking.{request,finalize,cancel}OperatorFeeWithdrawal`. The cooldown is
    // `parametersStorage.stakeWithdrawalDelay`.
    // ========================================================================

    /// @notice Request an operator-fee withdrawal of `withdrawalAmount` for
    ///         `identityId`. A request made before the last one is finalized
    ///         or cancelled augments it (combined amount = old + new) and
    ///         restarts the cooldown.
    function requestOperatorFeeWithdrawal(uint72 identityId, uint96 withdrawalAmount) external onlyStakingV10 {
        if (withdrawalAmount == 0) revert TokenLib.ZeroTokenAmount();

        ConvictionStakingStorage cs = convictionStorage;

        uint96 existingRequestAmount = cs.getOperatorFeeWithdrawalRequestAmount(identityId);
        uint96 currentOperatorFeeBalance = cs.getOperatorFeeBalance(identityId);

        // If a request already exists, the requested funds were already
        // moved out of the balance into the queue — restore them before we
        // re-check the cap so the totalRequestAmount comparison is honest.
        if (existingRequestAmount > 0) {
            currentOperatorFeeBalance += existingRequestAmount;
        }

        uint96 totalRequestAmount = existingRequestAmount + withdrawalAmount;
        if (totalRequestAmount > currentOperatorFeeBalance) {
            revert StakingLib.AmountExceedsOperatorFeeBalance(currentOperatorFeeBalance, totalRequestAmount);
        }

        uint256 withdrawalReleaseTimestamp = block.timestamp + parametersStorage.stakeWithdrawalDelay();
        cs.setOperatorFeeBalance(identityId, currentOperatorFeeBalance - totalRequestAmount);
        cs.createOperatorFeeWithdrawalRequest(identityId, totalRequestAmount, /*indexed*/ 0, withdrawalReleaseTimestamp);
    }

    /// @notice Complete `identityId`'s operator-fee withdrawal once the
    ///         cooldown has elapsed, paying it from the CSS vault to
    ///         `receiver`, the admin key that called `StakingV10`.
    function finalizeOperatorFeeWithdrawal(uint72 identityId, address receiver) external onlyStakingV10 {
        ConvictionStakingStorage cs = convictionStorage;

        (uint96 operatorFeeWithdrawalAmount, , uint256 withdrawalReleaseTimestamp) = cs.getOperatorFeeWithdrawalRequest(
            identityId
        );
        if (operatorFeeWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();
        if (block.timestamp < withdrawalReleaseTimestamp) {
            revert StakingLib.WithdrawalPeriodPending(block.timestamp, withdrawalReleaseTimestamp);
        }

        cs.deleteOperatorFeeWithdrawalRequest(identityId);
        cs.transferStake(receiver, operatorFeeWithdrawalAmount);
    }

    /// @notice Cancel `identityId`'s pending operator-fee withdrawal and
    ///         return the queued amount to its operator-fee balance. No
    ///         cooldown applies.
    function cancelOperatorFeeWithdrawal(uint72 identityId) external onlyStakingV10 {
        ConvictionStakingStorage cs = convictionStorage;

        uint96 operatorFeeWithdrawalAmount = cs.getOperatorFeeWithdrawalRequestAmount(identityId);
        if (operatorFeeWithdrawalAmount == 0) revert StakingLib.WithdrawalWasntInitiated();

        cs.deleteOperatorFeeWithdrawalRequest(identityId);
        cs.increaseOperatorFeeBalance(identityId, operatorFeeWithdrawalAmount);
    }

    // ========================================================================
    // V8 → V10 drains into migration credit
    //
    // `StakingV10` admits only `DKGStakingConvictionNFT` first. The wrapper
    // owns the sweep and the self-migration; these drains do the privileged
    // StakingStorage/CSS mutations and mint nothing.
    // ========================================================================

    /// @notice Drain ALL of `delegator`'s V8 stake on `identityId` (active
    ///         stakeBase + any pending withdrawal) into their migration
    ///         credit on CSS. Returns the drained `total` so the wrapper can
    ///         aggregate across nodes and revert if the grand total is zero;
    ///         a node with no V8 stake contributes 0 (no revert here).
    /// @dev    No per-source eligibility: the full drained amount is credited
    ///         to the delegator; the tier-6/12 lock-credit is decided later in
    ///         `StakingV10.allocateFromCredit` from the chosen tier.
    function drainV8ToCredit(address delegator, uint72 identityId) external onlyStakingV10 returns (uint96 total) {
        // Freeze-first invariant (on-chain): the V8 `Staking` logic must be
        // unregistered before ANY drain (admin sweep OR self-migrate). A drain
        // zeroes stakeBase without settling the reward cursor; if V8 `Staking`
        // is still live it keeps computing rewards/sharding off StakingStorage,
        // so draining against live state corrupts it. Gating here covers every
        // drain path through one chokepoint; selfMigrate auto-opens at freeze.
        if (hub.isContract("Staking")) revert V8StakingStillLive();
        bytes32 v8Key = keccak256(abi.encodePacked(delegator));
        StakingStorage ss = stakingStorage;
        uint96 stakeBase = ss.getDelegatorStakeBase(identityId, v8Key);
        uint96 pending = ss.getDelegatorWithdrawalRequestAmount(identityId, v8Key);
        total = stakeBase + pending;
        if (total == 0) return 0;

        // V8 drain. Pending was already excluded from node/total stake at
        // request time, so only the active base is decremented.
        if (stakeBase > 0) {
            ss.setDelegatorStakeBase(identityId, v8Key, 0);
            ss.decreaseNodeStake(identityId, stakeBase);
            ss.decreaseTotalStake(stakeBase);
        }
        if (pending > 0) {
            ss.deleteDelegatorWithdrawalRequest(identityId, v8Key);
        }
        // Move the migrated TRAC SS -> CSS so the credit stays collateralized.
        ss.transferStake(address(convictionStorage), total);

        convictionStorage.addMigrationCredit(delegator, total);
    }

    /// @notice Drain node `identityId`'s V8 operator fee (the resting
    ///         `operatorFeeBalance` PLUS any open fee-withdrawal request) into
    ///         `operator`'s migration credit on CSS. Returns the drained
    ///         `total`; a node with no fee contributes 0 (no revert here), so
    ///         the wrapper can sweep in bulk.
    /// @dev    "One credit": the operator fee folds into the SAME
    ///         `migrationCredit` bucket as delegator stake, so the operator
    ///         recovers it exactly like a delegator — `allocate` at tier 0
    ///         (immediately withdrawable) or 6/12 (conviction).
    ///
    ///         Operator addresses are NOT recoverable on-chain — IdentityStorage
    ///         holds key *hashes*, not addresses — so the off-chain sweep
    ///         supplies `operator` and this function validates it currently
    ///         holds ADMIN_KEY on the node (mirroring who V8
    ///         `finalizeOperatorFeeWithdrawal` would have paid). A stale/wrong
    ///         address REVERTS rather than crediting silently, so a
    ///         mis-resolved operator can never be paid; the sweep hard-fails
    ///         and re-resolves. The check is skipped only when there is nothing
    ///         to drain (`total == 0`), keeping re-runs idempotent and cheap.
    function drainOperatorFeeToCredit(
        uint72 identityId,
        address operator
    ) external onlyStakingV10 returns (uint96 total) {
        // Freeze-first invariant (see drainV8ToCredit) — no fee drain while V8
        // Staking is still live and could finalize/restake the same balance.
        if (hub.isContract("Staking")) revert V8StakingStillLive();
        StakingStorage ss = stakingStorage;
        uint96 feeBalance = ss.getOperatorFeeBalance(identityId);
        uint96 feeRequest = ss.getOperatorFeeWithdrawalRequestAmount(identityId);
        total = feeBalance + feeRequest;
        if (total == 0) return 0;

        // Credit only an address that currently controls the node.
        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(operator)),
                IdentityLib.ADMIN_KEY
            )
        ) {
            revert Permissions.OnlyProfileAdminFunction(operator);
        }

        // Zero the V8 fee slots (idempotent: a re-drain reads 0, returns 0).
        // The open-request amount stayed in the SS vault at request time (no
        // token moved), so deleting it here releases it for the SS->CSS move.
        if (feeBalance > 0) {
            ss.setOperatorFeeBalance(identityId, 0);
        }
        if (feeRequest > 0) {
            ss.deleteOperatorFeeWithdrawalRequest(identityId);
        }
        // Move the migrated TRAC SS -> CSS so the credit stays collateralized.
        ss.transferStake(address(convictionStorage), total);

        convictionStorage.addMigrationCredit(operator, total);
    }
}
