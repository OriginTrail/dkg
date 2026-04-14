// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Chronos} from "./Chronos.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";

contract ConvictionStakingStorage is INamed, IVersioned, HubDependent {
    string private constant _NAME = "ConvictionStakingStorage";
    string private constant _VERSION = "1.0.0";

    // Multiplier scale, matches Staking.convictionMultiplier /
    // DKGStakingConvictionNFT._convictionMultiplier (both return 1e18-scaled
    // values so fractional tiers like 1.5x and 3.5x are representable).
    uint256 internal constant SCALE18 = 1e18;

    // Position layout (two storage slots):
    //   slot 1: raw(96) + lockEpochs(40) + expiryEpoch(40) + identityId(72) = 248 bits
    //   slot 2: multiplier18(64) + lastClaimedEpoch(64)                    = 128 bits
    // `multiplier18` is 1e18-scaled; max tier 6e18 fits comfortably in uint64.
    // `lastClaimedEpoch` is a Chronos epoch number; uint64 holds ~5.8e11 years.
    struct Position {
        uint96 raw;
        uint40 lockEpochs;
        uint40 expiryEpoch;
        uint72 identityId;
        uint64 multiplier18;
        uint64 lastClaimedEpoch;
    }

    event PositionCreated(
        uint256 indexed tokenId,
        uint72 indexed identityId,
        uint96 raw,
        uint40 lockEpochs,
        uint40 expiryEpoch,
        uint64 multiplier18
    );
    event PositionRelocked(
        uint256 indexed tokenId,
        uint40 newLockEpochs,
        uint40 newExpiryEpoch,
        uint64 newMultiplier18
    );
    event PositionRedelegated(
        uint256 indexed tokenId,
        uint72 indexed oldIdentityId,
        uint72 indexed newIdentityId
    );
    event PositionDeleted(uint256 indexed tokenId);
    event LastClaimedEpochUpdated(uint256 indexed tokenId, uint64 epoch);
    event EffectiveStakeFinalized(uint256 startEpoch, uint256 endEpoch);
    event NodeEffectiveStakeFinalized(uint72 indexed identityId, uint256 startEpoch, uint256 endEpoch);

    Chronos public chronos;

    mapping(uint256 => Position) public positions;

    mapping(uint256 => int256) public effectiveStakeDiff;
    mapping(uint256 => uint256) public totalEffectiveStakeAtEpoch;
    uint256 public lastFinalizedEpoch;
    // First epoch at which any diff has ever been written. Used by the finalize
    // loops to skip the all-zero prefix on a long-dormant deployment (avoids
    // the "first mutator on epoch N burns N iterations" gas bomb).
    uint256 public firstDirtyEpoch;

    mapping(uint72 => mapping(uint256 => int256)) public nodeEffectiveStakeDiff;
    mapping(uint72 => mapping(uint256 => uint256)) public nodeEffectiveStakeAtEpoch;
    mapping(uint72 => uint256) public nodeLastFinalizedEpoch;
    mapping(uint72 => uint256) public nodeFirstDirtyEpoch;

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function initialize() public onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    // ============================================================
    //                 Conviction tier ladder
    // ============================================================

    // Mirrors `Staking.convictionMultiplier` and
    // `DKGStakingConvictionNFT._convictionMultiplier`. Stored here (rather
    // than imported) so storage has no dependency on the logic contracts; any
    // future tier change must be applied symmetrically across all three.
    // `lockEpochs == 0` is a storage-level sentinel for the permanent 1x rest
    // state (post-expiry positions and V8-compat defaults both land here).
    function expectedMultiplier18(uint40 lockEpochs) public pure returns (uint64) {
        if (lockEpochs == 0) return uint64(SCALE18);            // permanent 1.0x
        if (lockEpochs >= 12) return uint64(6 * SCALE18);       // 6.0x
        if (lockEpochs >= 6)  return uint64((35 * SCALE18) / 10); // 3.5x
        if (lockEpochs >= 3)  return uint64(2 * SCALE18);       // 2.0x
        if (lockEpochs >= 2)  return uint64((15 * SCALE18) / 10); // 1.5x
        return uint64(SCALE18);                                 // lock == 1 → 1.0x
    }

    // ============================================================
    //                        Mutators
    // ============================================================

    function createPosition(
        uint256 tokenId,
        uint72 identityId,
        uint96 raw,
        uint40 lockEpochs,
        uint64 multiplier18
    ) external onlyContracts {
        require(identityId != 0, "Zero node");
        require(positions[tokenId].raw == 0, "Position exists");
        require(raw > 0, "Zero raw");
        // Tier check subsumes "Bad multiplier" and "Lock0 must be 1x": the
        // ladder defines exactly one valid multiplier for every lock value
        // (including lock == 0 → 1x), so any deviation is a tier mismatch.
        require(multiplier18 == expectedMultiplier18(lockEpochs), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint40 expiryEpoch = lockEpochs == 0 ? 0 : uint40(currentEpoch) + lockEpochs;

        positions[tokenId] = Position({
            raw: raw,
            lockEpochs: lockEpochs,
            expiryEpoch: expiryEpoch,
            identityId: identityId,
            multiplier18: multiplier18,
            lastClaimedEpoch: uint64(currentEpoch - 1)
        });

        // Apply diff: full effective stake (raw * multiplier18 / 1e18) enters at currentEpoch
        int256 initialEffective = (int256(uint256(raw)) * int256(uint256(multiplier18))) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += initialEffective;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += initialEffective;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // On expiry, the multiplier boost drops away; principal remains at 1x.
        // boost = raw * (multiplier18 - 1e18) / 1e18
        if (lockEpochs > 0 && multiplier18 > SCALE18) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] -= expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] -= expiryDelta;
        }

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionCreated(tokenId, identityId, raw, lockEpochs, expiryEpoch, multiplier18);
    }

    function updateOnRelock(
        uint256 tokenId,
        uint40 newLockEpochs,
        uint64 newMultiplier18
    ) external onlyContracts {
        Position storage pos = positions[tokenId];
        require(pos.raw > 0, "No position");
        // Relock must carry an actual boost — lock 0 and lock 1 both map to
        // 1x under the tier ladder and are the post-expiry rest state, not a
        // valid re-commit target.
        require(newLockEpochs >= 2, "Lock too short");
        require(newMultiplier18 == expectedMultiplier18(newLockEpochs), "Tier mismatch");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        // Relock is a post-expiry re-commit: prior lock must be done (or never existed)
        require(pos.expiryEpoch == 0 || currentEpoch >= pos.expiryEpoch, "Not expired");

        uint96 raw = pos.raw;
        uint72 identityId = pos.identityId;

        // Position is currently at raw*1 (permanent, post-expiry). Lift to raw*newMultiplier18.
        // boost = raw * (newMultiplier18 - SCALE18) / SCALE18
        int256 boost = (int256(uint256(raw)) * int256(uint256(newMultiplier18) - SCALE18)) / int256(SCALE18);
        effectiveStakeDiff[currentEpoch] += boost;
        nodeEffectiveStakeDiff[identityId][currentEpoch] += boost;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        uint40 newExpiry = uint40(currentEpoch) + newLockEpochs;
        effectiveStakeDiff[newExpiry] -= boost;
        nodeEffectiveStakeDiff[identityId][newExpiry] -= boost;

        pos.expiryEpoch = newExpiry;
        pos.lockEpochs = newLockEpochs;
        pos.multiplier18 = newMultiplier18;

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionRelocked(tokenId, newLockEpochs, pos.expiryEpoch, newMultiplier18);
    }

    function updateOnRedelegate(uint256 tokenId, uint72 newIdentityId) external onlyContracts {
        require(newIdentityId != 0, "Zero node");
        Position storage pos = positions[tokenId];
        require(pos.raw > 0, "No position");
        uint72 oldIdentityId = pos.identityId;
        require(oldIdentityId != newIdentityId, "Same node");

        uint256 currentEpoch = chronos.getCurrentEpoch();

        uint96 raw = pos.raw;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;

        // Effective stake contribution that must transfer per-node RIGHT NOW
        // = raw * (boosted ? multiplier18 : SCALE18) / SCALE18
        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);

        // Per-node diff move only; global totals unchanged
        int256 signedEffectiveNow = int256(effectiveNow);
        nodeEffectiveStakeDiff[oldIdentityId][currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[newIdentityId][currentEpoch] += signedEffectiveNow;
        _markNodeDirty(oldIdentityId, currentEpoch);
        _markNodeDirty(newIdentityId, currentEpoch);

        // Pending expiry drop must also follow the position
        if (stillBoosted) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            // cancel old subtraction
            nodeEffectiveStakeDiff[oldIdentityId][expiryEpoch] += expiryDelta;
            // install on new node
            nodeEffectiveStakeDiff[newIdentityId][expiryEpoch] -= expiryDelta;
        }

        pos.identityId = newIdentityId;

        if (currentEpoch > 1) {
            _finalizeNodeEffectiveStakeUpTo(oldIdentityId, currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(newIdentityId, currentEpoch - 1);
        }

        emit PositionRedelegated(tokenId, oldIdentityId, newIdentityId);
    }

    function setLastClaimedEpoch(uint256 tokenId, uint64 epoch) external onlyContracts {
        require(positions[tokenId].raw > 0, "No position");
        positions[tokenId].lastClaimedEpoch = epoch;
        emit LastClaimedEpochUpdated(tokenId, epoch);
    }

    function deletePosition(uint256 tokenId) external onlyContracts {
        Position memory pos = positions[tokenId];
        require(pos.raw > 0, "No position");

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint96 raw = pos.raw;
        uint72 identityId = pos.identityId;
        uint40 expiryEpoch = pos.expiryEpoch;
        uint64 multiplier18 = pos.multiplier18;
        bool stillBoosted = expiryEpoch != 0 && currentEpoch < expiryEpoch;
        uint256 effectiveNow = stillBoosted
            ? (uint256(raw) * uint256(multiplier18)) / SCALE18
            : uint256(raw);

        // Remove contribution from currentEpoch onward
        int256 signedEffectiveNow = int256(effectiveNow);
        effectiveStakeDiff[currentEpoch] -= signedEffectiveNow;
        nodeEffectiveStakeDiff[identityId][currentEpoch] -= signedEffectiveNow;
        _markGlobalDirty(currentEpoch);
        _markNodeDirty(identityId, currentEpoch);

        // Cancel the pending expiry subtraction so it does not fire after delete
        if (stillBoosted) {
            int256 expiryDelta = (int256(uint256(raw)) * int256(uint256(multiplier18) - SCALE18)) / int256(SCALE18);
            effectiveStakeDiff[expiryEpoch] += expiryDelta;
            nodeEffectiveStakeDiff[identityId][expiryEpoch] += expiryDelta;
        }

        delete positions[tokenId];

        if (currentEpoch > 1) {
            _finalizeEffectiveStakeUpTo(currentEpoch - 1);
            _finalizeNodeEffectiveStakeUpTo(identityId, currentEpoch - 1);
        }

        emit PositionDeleted(tokenId);
    }

    // ============================================================
    //                          Reads
    // ============================================================

    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }

    function getTotalEffectiveStakeAtEpoch(uint256 epoch) public view returns (uint256) {
        if (epoch <= lastFinalizedEpoch) {
            return totalEffectiveStakeAtEpoch[epoch];
        }
        int256 simulated = lastFinalizedEpoch > 0
            ? int256(totalEffectiveStakeAtEpoch[lastFinalizedEpoch])
            : int256(0);
        for (uint256 e = lastFinalizedEpoch + 1; e <= epoch; e++) {
            simulated += effectiveStakeDiff[e];
            // Unify policy with the mutate path: an intermediate negative
            // cumulative signals ledger corruption. Even if a later diff
            // restores it, the mutate path would have reverted at the first
            // bad epoch — so the view path must too.
            require(simulated >= 0, "Negative total");
        }
        return uint256(simulated);
    }

    function getNodeEffectiveStakeAtEpoch(uint72 identityId, uint256 epoch) public view returns (uint256) {
        uint256 lastFinalized = nodeLastFinalizedEpoch[identityId];
        if (epoch <= lastFinalized) {
            return nodeEffectiveStakeAtEpoch[identityId][epoch];
        }
        int256 simulated = lastFinalized > 0
            ? int256(nodeEffectiveStakeAtEpoch[identityId][lastFinalized])
            : int256(0);
        for (uint256 e = lastFinalized + 1; e <= epoch; e++) {
            simulated += nodeEffectiveStakeDiff[identityId][e];
            require(simulated >= 0, "Negative node total");
        }
        return uint256(simulated);
    }

    function getLastFinalizedEpoch() external view returns (uint256) {
        return lastFinalizedEpoch;
    }

    function getNodeLastFinalizedEpoch(uint72 identityId) external view returns (uint256) {
        return nodeLastFinalizedEpoch[identityId];
    }

    // ============================================================
    //                     External finalizers
    // ============================================================

    // Hub contracts (notably Phase 11 reward math) can amortize the
    // O(currentEpoch - lastFinalizedEpoch) simulate path into a single
    // write by calling these before reading getTotalEffectiveStakeAtEpoch /
    // getNodeEffectiveStakeAtEpoch across a long dormant window.
    //
    // Only past epochs may be finalized: finalizing the current or a future
    // epoch would crystallize diff[currentEpoch] before in-flight mutators
    // finished writing to it, leaving every subsequent read stuck on a stale
    // cached value. Mirrors `ContextGraphValueStorage.finalizeCGValueUpTo`.

    function finalizeEffectiveStakeUpTo(uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeEffectiveStakeUpTo(epoch);
    }

    function finalizeNodeEffectiveStakeUpTo(uint72 identityId, uint256 epoch) external onlyContracts {
        require(epoch < chronos.getCurrentEpoch(), "Future or current epoch");
        _finalizeNodeEffectiveStakeUpTo(identityId, epoch);
    }

    // ============================================================
    //                       Internal finalize
    // ============================================================

    function _finalizeEffectiveStakeUpTo(uint256 epoch) internal {
        uint256 last = lastFinalizedEpoch;
        if (last >= epoch) return;

        uint256 firstDirty = firstDirtyEpoch;
        if (firstDirty == 0) {
            // No diff has ever been written. Whole range is default zero —
            // advance the cursor without touching any mapping slot.
            lastFinalizedEpoch = epoch;
            emit EffectiveStakeFinalized(last + 1, epoch);
            return;
        }

        // Skip the all-zero prefix before the first dirty epoch.
        uint256 startEpoch = last + 1;
        if (startEpoch < firstDirty) startEpoch = firstDirty;
        if (startEpoch > epoch) {
            // Entire [last+1, epoch] range is in the zero prefix.
            lastFinalizedEpoch = epoch;
            emit EffectiveStakeFinalized(last + 1, epoch);
            return;
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            int256 prev = 0;
            if (e > 1) {
                prev = int256(totalEffectiveStakeAtEpoch[e - 1]);
            }
            int256 result = prev + effectiveStakeDiff[e];
            require(result >= 0, "Negative total");
            totalEffectiveStakeAtEpoch[e] = uint256(result);
        }
        lastFinalizedEpoch = epoch;

        emit EffectiveStakeFinalized(startEpoch, epoch);
    }

    function _finalizeNodeEffectiveStakeUpTo(uint72 identityId, uint256 epoch) internal {
        uint256 last = nodeLastFinalizedEpoch[identityId];
        if (last >= epoch) return;

        uint256 firstDirty = nodeFirstDirtyEpoch[identityId];
        if (firstDirty == 0) {
            nodeLastFinalizedEpoch[identityId] = epoch;
            emit NodeEffectiveStakeFinalized(identityId, last + 1, epoch);
            return;
        }

        uint256 startEpoch = last + 1;
        if (startEpoch < firstDirty) startEpoch = firstDirty;
        if (startEpoch > epoch) {
            nodeLastFinalizedEpoch[identityId] = epoch;
            emit NodeEffectiveStakeFinalized(identityId, last + 1, epoch);
            return;
        }

        for (uint256 e = startEpoch; e <= epoch; e++) {
            int256 prev = 0;
            if (e > 1) {
                prev = int256(nodeEffectiveStakeAtEpoch[identityId][e - 1]);
            }
            int256 result = prev + nodeEffectiveStakeDiff[identityId][e];
            require(result >= 0, "Negative node total");
            nodeEffectiveStakeAtEpoch[identityId][e] = uint256(result);
        }
        nodeLastFinalizedEpoch[identityId] = epoch;

        emit NodeEffectiveStakeFinalized(identityId, startEpoch, epoch);
    }

    // ============================================================
    //                Dirty-epoch bookkeeping
    // ============================================================

    function _markGlobalDirty(uint256 epoch) internal {
        uint256 current = firstDirtyEpoch;
        if (current == 0 || epoch < current) {
            firstDirtyEpoch = epoch;
        }
    }

    function _markNodeDirty(uint72 identityId, uint256 epoch) internal {
        uint256 current = nodeFirstDirtyEpoch[identityId];
        if (current == 0 || epoch < current) {
            nodeFirstDirtyEpoch[identityId] = epoch;
        }
    }
}
