// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {DelegatorsInfo} from "../storage/DelegatorsInfo.sol";
import {IdentityStorage} from "../storage/IdentityStorage.sol";
import {ProfileStorage} from "../storage/ProfileStorage.sol";
import {StakingStorage} from "../storage/StakingStorage.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title MigratorV10Staking
 * @notice Zero-token V8 → V10 delegator state migrator (BUGS_FOUND.md E-11).
 *
 * Background
 * ----------
 * The V8 staking model held delegations in legacy `StakingStorage` indexed by
 * a per-node ERC20 "shares" contract. V10 retires the shares contracts and
 * keeps the same delegation amounts directly under
 * `StakingStorage.setDelegatorStakeBase` keyed by `keccak256(delegatorAddress)`.
 *
 * The migration is *zero-token*: no ERC20 transfer, no balance change, no
 * mint/burn. The contract simply replays the snapshot of V8 per-delegator
 * stakes into V10 storage so each delegator keeps the exact stake base they
 * had at the freeze block, expressed in the V10 delegator-key format.
 *
 * Trust model
 * -----------
 *  - Restricted to the Hub owner / multisig owner. The Hub itself can also
 *    invoke (matches sibling migrators and the Hub upgrade path).
 *  - All write surfaces (StakingStorage / DelegatorsInfo / ProfileStorage)
 *    are `onlyContracts`-gated, so the migrator MUST be registered in the
 *    Hub via `setAndReinitializeContracts` before any write is accepted.
 *  - Idempotent per (identityId, delegator). Re-running a migration is a
 *    no-op so it is safe to retry on partial failure.
 *
 * @dev Spec reference: scripts/epoch-snapshot.ts (V8 freeze block snapshot)
 *      + scripts/publisher-epoch-snapshot.ts (per-publisher refund pipeline).
 */
contract MigratorV10Staking is ContractStatus, INamed, IVersioned, IInitializable {
    string private constant _NAME = "MigratorV10Staking";
    string private constant _VERSION = "1.0.0";

    error MigrationNotInitiated();
    error MigrationAlreadyFinalized();
    error DelegatorAlreadyMigrated(uint72 identityId, address delegator);
    error NodeAlreadyMigrated(uint72 identityId);
    error InvalidIdentityId();
    /// PR #229 bot review round 10 (MigratorV10Staking.sol:137).
    /// Raised when the supplied `identityId` is non-zero but does not
    /// correspond to an existing profile in `ProfileStorage`. Until
    /// round 10 a fat-fingered snapshot row (e.g. a typo in the
    /// generated CSV) would slip past the `identityId != 0` check
    /// and permanently inflate `stakingStorage.totalStake` plus
    /// pollute `DelegatorsInfo` under a bogus id. The downstream
    /// write surfaces (`addDelegator`, `setDelegatorStakeBase`,
    /// `increaseNodeStake`, `increaseTotalStake`) accept arbitrary
    /// ids so this guard is the first integrity gate.
    error UnknownIdentityId(uint72 identityId);
    error InvalidDelegator();
    error TotalStakeMismatch(uint72 identityId, uint96 expected, uint96 received);

    event MigrationInitiated();
    event MigrationFinalized();
    event NodeStakeMigrated(uint72 indexed identityId, uint96 totalStake);
    event DelegatorStakeMigrated(
        uint72 indexed identityId,
        address indexed delegator,
        uint96 stakeBase
    );

    StakingStorage public stakingStorage;
    DelegatorsInfo public delegatorsInfo;
    IdentityStorage public identityStorage;
    ProfileStorage public profileStorage;

    bool public migrationInitiated;
    bool public migrationFinalized;

    uint72 public migratedNodes;
    uint96 public migratedTotalStake;

    mapping(uint72 => bool) public nodeMigrated;
    mapping(uint72 => mapping(address => bool)) public delegatorMigrated;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function name() external pure returns (string memory) {
        return _NAME;
    }

    function version() external pure returns (string memory) {
        return _VERSION;
    }

    /// @dev Hub-driven initializer (called via setAndReinitializeContracts).
    function initialize() external onlyHub {
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        delegatorsInfo = DelegatorsInfo(hub.getContractAddress("DelegatorsInfo"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
    }

    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    modifier whenInitiated() {
        if (!migrationInitiated) revert MigrationNotInitiated();
        if (migrationFinalized) revert MigrationAlreadyFinalized();
        _;
    }

    function initiateMigration() external onlyOwnerOrMultiSigOwner {
        if (migrationFinalized) revert MigrationAlreadyFinalized();
        migrationInitiated = true;
        emit MigrationInitiated();
    }

    function finalizeMigration() external onlyOwnerOrMultiSigOwner {
        migrationInitiated = false;
        migrationFinalized = true;
        emit MigrationFinalized();
    }

    /**
     * @notice Replay a single delegator's V8 stake-base into V10 storage.
     *
     * @dev Zero-token: the delegator's V10 `stakeBase` is set to the snapshot
     *      value verbatim. No Token.transfer is invoked, no balance changes.
     *      The corresponding node-stake bucket is grown by the same amount so
     *      the per-node aggregate matches the sum of its delegators.
     *
     * Re-running with the same `(identityId, delegator)` reverts with
     * `DelegatorAlreadyMigrated` to prevent double-bookings.
     */
    function migrateDelegator(
        uint72 identityId,
        address delegator,
        uint96 stakeBase
    ) external onlyOwnerOrMultiSigOwner whenInitiated {
        if (identityId == 0) revert InvalidIdentityId();
        // PR #229 bot review round 10 (MigratorV10Staking.sol:137).
        // `identityId != 0` alone does NOT prove the id belongs to a
        // real profile — `DelegatorsInfo.addDelegator`,
        // `StakingStorage.setDelegatorStakeBase`,
        // `StakingStorage.increaseNodeStake`, and `increaseTotalStake`
        // all accept arbitrary ids, so one fat-fingered snapshot row
        // would permanently inflate `totalStake` and pollute
        // `DelegatorsInfo` under a nonexistent identity. Gate every
        // write behind `profileStorage.profileExists(identityId)`.
        if (!profileStorage.profileExists(identityId)) {
            revert UnknownIdentityId(identityId);
        }
        if (delegator == address(0)) revert InvalidDelegator();
        if (delegatorMigrated[identityId][delegator]) {
            revert DelegatorAlreadyMigrated(identityId, delegator);
        }

        bytes32 delegatorKey = keccak256(abi.encodePacked(delegator));

        delegatorsInfo.addDelegator(identityId, delegator);
        stakingStorage.setDelegatorStakeBase(identityId, delegatorKey, stakeBase);
        stakingStorage.increaseNodeStake(identityId, stakeBase);
        stakingStorage.increaseTotalStake(stakeBase);

        delegatorMigrated[identityId][delegator] = true;
        migratedTotalStake += stakeBase;

        emit DelegatorStakeMigrated(identityId, delegator, stakeBase);
    }

    /**
     * @notice Mark a node as fully migrated and assert the V10 per-node
     *         aggregate equals the V8 snapshot value.
     *
     * @dev Operator MUST call `migrateDelegator(...)` for every snapshot
     *      delegator first. This is the integrity gate: the recorded
     *      `expectedTotalStake` (from `epoch-snapshot.ts`) must equal the
     *      live V10 aggregate or the call reverts and the operator must
     *      reconcile before proceeding.
     */
    function markNodeMigrated(
        uint72 identityId,
        uint96 expectedTotalStake
    ) external onlyOwnerOrMultiSigOwner whenInitiated {
        if (identityId == 0) revert InvalidIdentityId();
        // Same guard as `migrateDelegator`: reject ids that do not
        // correspond to a registered profile so a typo can never
        // mark a nonexistent node as migrated (which would also
        // cause `markNodeMigrated` to "succeed" on a non-zero
        // expectedTotalStake via the default zero `getNodeStake`
        // only when expectedTotalStake is 0, but even the zero case
        // should not be reachable for unknown ids).
        if (!profileStorage.profileExists(identityId)) {
            revert UnknownIdentityId(identityId);
        }
        if (nodeMigrated[identityId]) revert NodeAlreadyMigrated(identityId);

        uint96 onChain = stakingStorage.getNodeStake(identityId);
        if (onChain != expectedTotalStake) {
            revert TotalStakeMismatch(identityId, expectedTotalStake, onChain);
        }

        nodeMigrated[identityId] = true;
        migratedNodes += 1;

        emit NodeStakeMigrated(identityId, expectedTotalStake);
    }

    /// @dev Read-only sanity helper for off-chain verification scripts.
    function isFullyMigrated(uint72 identityId) external view returns (bool) {
        return nodeMigrated[identityId];
    }

    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
        if (multiSigAddress.code.length == 0) return false;
        try ICustodian(multiSigAddress).getOwners() returns (address[] memory owners) {
            for (uint256 i = 0; i < owners.length; i++) {
                if (msg.sender == owners[i]) return true;
            } // solhint-disable-next-line no-empty-blocks
        } catch {
            // Not a multisig or call reverted — treat as not owner.
        }
        return false;
    }

    function _checkOwnerOrMultiSigOwner() internal view {
        address hubOwner = hub.owner();
        if (msg.sender != hubOwner && msg.sender != address(hub) && !_isMultiSigOwner(hubOwner)) {
            revert("Only Hub Owner, Hub, or Multisig Owner can call");
        }
    }
}
