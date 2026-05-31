// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

/**
 * @title V8MigrationEligibility
 * @notice One-shot HubOwner-managed registry of V8 delegators who qualify
 *         for a 2-month V10 conviction-lock credit at migration time.
 *
 * Eligibility model
 * -----------------
 * A V8 delegator on a given node is eligible iff the delegator held a
 * strictly positive `stakeBase` on that node continuously across the
 * 60 days immediately preceding V10 launch — i.e. they never fully
 * unstaked from that node during that window. The qualification is
 * determined off-chain by replaying `StakingStorage.DelegatorBaseStakeUpdated`
 * events; this contract simply records the resulting `(identityId,
 * delegator)` set on-chain so that `StakingV10._convertToNFT` can apply
 * the 60-day credit during migration without re-deriving history.
 *
 * Off-chain pipeline (for context)
 * --------------------------------
 *   1. Off-chain script computes `min(stakeBase)` over the window for every
 *      `(identityId, delegator)` pair on V8 mainnet (Gnosis is the
 *      authoritative source; Base/NeuroWeb were not used in the v10 launch
 *      eligibility set).
 *   2. The pair is eligible iff `min(stakeBase) > 0`.
 *   3. The eligible set is uploaded here via `setEligibleBatch`.
 *   4. HubOwner calls `freeze()` once the upload is complete; subsequent
 *      `setEligibleBatch` calls revert.
 *
 * Bonus model (applied by `StakingV10._convertToNFT`, NOT here)
 * -------------------------------------------------------------
 * If `(identityId, delegator)` is eligible AND the migrant picks lockTier
 * 6 or 12, the V10 NFT's `expiryTimestamp` is set 60 days earlier than
 * the tier default (i.e. `_computeExpiryTimestamp(lockTier) - 2 *
 * chronos.epochLength()`). The credit applies to the FULL migrated
 * balance (`stakeBase + pendingWithdrawal`), not just the historical
 * floor: under the launch policy, qualification is binary and the
 * conviction-tier choice (6m / 12m) is itself the substantive
 * commitment that the credit rewards.
 *
 * Lower tiers (0/1/3) receive no credit. Delegators who first staked
 * inside the 60-day window or fully unstaked at any point in it are
 * not present in this registry and migrate at the default lock.
 *
 * Authorization
 * -------------
 * - `setEligibleBatch` and `freeze` are gated to HubOwner.
 * - `isEligible` and bookkeeping reads are open.
 *
 * Frozen invariant
 * ----------------
 * Once `frozen == true`, no further `setEligibleBatch` mutations are
 * possible. There is no unfreeze path: the design is intentionally
 * one-shot to provide a hard guarantee to migrants that the registry
 * cannot grow or shrink between their decision to migrate and their
 * migration tx landing.
 */
contract V8MigrationEligibility is INamed, IVersioned, HubDependent {
    string private constant _NAME = "V8MigrationEligibility";
    string private constant _VERSION = "10.0.2";

    /// @notice One-shot lock. While `false`, HubOwner may grow the
    ///         registry. Once `true`, the registry is immutable.
    bool public frozen;

    /// @notice Total number of distinct `(identityId, delegator)` pairs
    ///         marked eligible. Useful for upload sanity checks.
    uint256 public eligibleCount;

    /// @dev The eligibility set itself, keyed `identityId => delegator => bool`.
    mapping(uint72 => mapping(address => bool)) internal _isEligible;

    event EligibilitySet(uint72 indexed identityId, address indexed delegator);
    event Frozen();

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /**
     * @notice Mark a list of `(identityId, delegator)` pairs as eligible
     *         in one transaction.
     * @dev    Idempotent on a per-pair basis: re-uploading an already-
     *         eligible pair is a no-op (no event, no counter bump). This
     *         lets the off-chain script split the set across multiple
     *         transactions without bookkeeping for which pairs were
     *         already uploaded.
     *
     *         Reverts if the registry has been frozen, if the input
     *         arrays disagree in length, or if any individual entry has
     *         a zero `identityId` / zero `delegator`.
     */
    function setEligibleBatch(
        uint72[] calldata identityIds,
        address[] calldata delegators
    ) external onlyHubOwner {
        require(!frozen, "Registry frozen");
        require(identityIds.length == delegators.length, "Length mismatch");

        uint256 added = 0;
        uint256 len = identityIds.length;
        for (uint256 i = 0; i < len; ) {
            uint72 id = identityIds[i];
            address d = delegators[i];
            require(id != 0, "Zero identityId");
            require(d != address(0), "Zero delegator");
            if (!_isEligible[id][d]) {
                _isEligible[id][d] = true;
                emit EligibilitySet(id, d);
                unchecked {
                    added++;
                }
            }
            unchecked {
                i++;
            }
        }
        if (added != 0) {
            eligibleCount += added;
        }
    }

    /**
     * @notice Permanently freeze the registry. Reverts if already frozen.
     * @dev    Intentionally one-shot. There is no unfreeze. The HubOwner
     *         is expected to call this immediately after the off-chain
     *         upload completes, before the migration period opens.
     */
    function freeze() external onlyHubOwner {
        require(!frozen, "Already frozen");
        frozen = true;
        emit Frozen();
    }

    /**
     * @notice True iff `delegator` qualifies for the 60-day V10 lock
     *         credit on `identityId` at migration time.
     */
    function isEligible(uint72 identityId, address delegator) external view returns (bool) {
        return _isEligible[identityId][delegator];
    }
}
