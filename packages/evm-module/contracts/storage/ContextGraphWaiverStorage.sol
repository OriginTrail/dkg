// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {HubDependent} from "../abstract/HubDependent.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IContextGraphWaiverStorage} from "../interfaces/IContextGraphWaiverStorage.sol";
import {IDKGPublishingConvictionNFT} from "../interfaces/IDKGPublishingConvictionNFT.sol";

/// @dev Minimal view over ParametersStorage for the one governance knob this
///      contract reads (avoids importing the full ParametersStorage).
interface IParamsMinPcaCommitment {
    function minPcaCommitmentForCgWaiver() external view returns (uint96);
}

/**
 * @title ContextGraphWaiverStorage
 * @notice OT-RFC-53 spam-cap for the PCA-backed CG registration-deposit waiver.
 *
 *         A CG whose publish authority is a PCA the creator owns (or is a
 *         registered agent of) can be created WITHOUT the 100-TRAC registration
 *         deposit — but only up to a per-PCA quota of `committedTRAC / deposit`
 *         CGs. That keeps the original per-CG anti-spam cost (N deposit-free CGs
 *         require N×deposit of LOCKED PCA commitment), paid by the PCA's locked
 *         TRAC instead of separate liquid TRAC. A governance stake floor
 *         (ParametersStorage.minPcaCommitmentForCgWaiver) gates the perk to
 *         serious PCAs and is the reason a 1-wei PCA can't unlock free CGs.
 *
 *         This is a NEW standalone contract because ContextGraphStorage is
 *         already deployed (frozen) and the per-PCA waived-count is new data.
 *         The eligibility logic lives here (co-located with its counter and
 *         off ContextGraphs' bytecode budget); ContextGraphs calls
 *         `tryConsumeWaiver` once and charges the deposit if it returns false.
 *
 *         `tryConsumeWaiver` mutates (it consumes a quota slot), so it is gated
 *         to the live ContextGraphs contract only.
 */
contract ContextGraphWaiverStorage is INamed, IVersioned, IContextGraphWaiverStorage, HubDependent {
    string private constant _NAME = "ContextGraphWaiverStorage";
    string private constant _VERSION = "1.0.0";

    /// @inheritdoc IContextGraphWaiverStorage
    mapping(uint256 => uint256) public waivedCgCount;

    /// @notice Emitted when a CG registration deposit is waived against a PCA.
    event RegistrationDepositWaived(
        uint256 indexed accountId,
        address indexed creator,
        uint256 newWaivedCount,
        uint256 quota
    );

    /// @notice Only the live ContextGraphs contract may consume the waiver.
    error OnlyContextGraphs(address caller);

    constructor(address hubAddress) HubDependent(hubAddress) {}

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /// @inheritdoc IContextGraphWaiverStorage
    function tryConsumeWaiver(
        uint256 accountId,
        address creator,
        uint96 deposit
    ) external override returns (bool) {
        if (msg.sender != hub.getContractAddress("ContextGraphs")) {
            revert OnlyContextGraphs(msg.sender);
        }
        if (accountId == 0 || deposit == 0) return false;

        address nftAddr = hub.getContractAddress("DKGPublishingConvictionNFT");
        if (nftAddr == address(0)) return false;
        IDKGPublishingConvictionNFT nft = IDKGPublishingConvictionNFT(nftAddr);

        // Gate 1: the PCA is a LIVE, backed account. accounts() returns zeros
        // for a never-minted id (committedTRAC == 0 ⇒ rejected). Expiry is
        // timestamp-based, matching coverPublishingCost. Tuple idx: 0=committed,
        // 4=expiresAtTimestamp, 8=fullySwept.
        uint96 committedTRAC = 0;
        // We read 3 of the 11 account-tuple fields on purpose.
        // slither-disable-next-line unused-return
        try nft.accounts(accountId) returns (
            uint96 committed,
            uint40,
            uint40,
            uint40,
            uint40 expiresAtTimestamp,
            uint16,
            uint16,
            uint16,
            bool fullySwept,
            uint72,
            uint40
        ) {
            if (committed == 0 || fullySwept) return false;
            // Timestamp expiry is intentional — mirrors coverPublishingCost.
            // slither-disable-next-line timestamp
            if (expiresAtTimestamp != 0 && block.timestamp >= expiresAtTimestamp) return false;
            committedTRAC = committed;
        } catch {
            return false;
        }

        // Gate 2: governance stake floor — keeps the waiver a perk for real
        // PCAs (and blocks the dust-PCA bypass). If ParametersStorage is
        // unresolvable, fail closed (floor = max ⇒ not waived).
        address psAddr = hub.getContractAddress("ParametersStorage");
        if (psAddr == address(0)) return false;
        if (committedTRAC < IParamsMinPcaCommitment(psAddr).minPcaCommitmentForCgWaiver()) {
            return false;
        }

        // Gate 3: the CG creator is the PCA owner or a currently registered
        // agent. EXPLICIT caller check — ContextGraphs' coherence gate only ties
        // the stored authority to the owner, not the creator.
        bool authorized = false;
        try nft.ownerOf(accountId) returns (address owner_) {
            if (owner_ == creator) authorized = true;
        } catch {
            return false; // nonexistent account
        }
        if (!authorized) {
            try nft.agentToAccountId(creator) returns (uint256 boundAccount) {
                if (boundAccount == accountId) authorized = true;
            } catch {
                /* not authorized */
            }
        }
        if (!authorized) return false;

        // Gate 4: per-PCA quota — at most committedTRAC / deposit deposit-free
        // CGs, so N free CGs cost N×deposit of LOCKED commitment.
        uint256 quota = uint256(committedTRAC) / uint256(deposit);
        uint256 used = waivedCgCount[accountId];
        if (used >= quota) return false;

        unchecked {
            waivedCgCount[accountId] = used + 1;
        }
        emit RegistrationDepositWaived(accountId, creator, used + 1, quota);
        return true;
    }
}
