// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {PaymasterManager} from "./storage/PaymasterManager.sol";
import {Chronos} from "./storage/Chronos.sol";
import {KnowledgeCollectionStorage} from "./storage/KnowledgeCollectionStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ContextGraphs} from "./ContextGraphs.sol";
import {ContextGraphStorage} from "./storage/ContextGraphStorage.sol";
import {ContextGraphValueStorage} from "./storage/ContextGraphValueStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {KnowledgeCollectionLib} from "./libraries/KnowledgeCollectionLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IPaymaster} from "./interfaces/IPaymaster.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {IDKGPublishingConvictionNFT} from "./interfaces/IDKGPublishingConvictionNFT.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title KnowledgeAssetsV10
 * @notice V10 publish + update contract — wires together:
 *   - ContextGraphs facade (3 curator types, atomic KC↔CG bind)
 *   - ContextGraphStorage (direct read for `kcToContextGraph` on update)
 *   - ContextGraphValueStorage (per-CG value ledger for value-weighted challenges)
 *   - DKGPublishingConvictionNFT (publisher discount NFT; auto-resolves agent→account)
 *   - KnowledgeCollectionStorage (V8-compatible data model)
 *
 * Four public entry points (two publish + two update, mirrored design):
 *   - `publish`        — conviction path. NFT covers the cost. TRAC accounting
 *                        was already done at `createAccount` time, so this
 *                        path does NOT touch `_addTokens` or `_distributeTokens`
 *                        (double-count prevention).
 *   - `publishDirect`  — market-rate path. Pulls TRAC from caller/paymaster
 *                        and distributes across the epoch range via
 *                        `_distributeTokens`.
 *   - `update`         — conviction path for UPDATES. Charges only the DELTA
 *                        between `newTokenAmount` and the KC's current
 *                        `tokenAmount` via `coverPublishingCost`. Metadata-only
 *                        updates (`delta == 0`) skip payment entirely.
 *   - `updateDirect`   — market-rate update. Pulls delta TRAC via `_addTokens`
 *                        and distributes it over the REMAINING lifetime via
 *                        `_distributeTokens`.
 *
 * Both publish paths share `_executePublishCore`. Both update paths share
 * `_executeUpdateCore`. Each core runs: sig verification → authorization →
 * validation → KCS mutation → atomic CG value delta write → per-node
 * produced-value bookkeeping. No TRAC movement happens in the cores — the
 * public entries branch on payment path.
 *
 * ACK digest prefix (H5 closure): `block.chainid || address(this)` pins a
 * signed ACK to this contract on this chain. Replay across chains / forks
 * / contract redeployments is rejected at signature verification.
 *
 * Publisher digest field order (N26 closure): `(publisherNodeIdentityId,
 * contextGraphId, merkleRoot)` — matches spec `07_EVM_MODULE.md:164`. For
 * updates the same order is used with the new merkle root.
 *
 * Authorization:
 *   - publish: N17 closure — `isAuthorizedPublisher(msg.sender)` via facade.
 *   - update:  policy-branch gate in `_executeUpdateCore`. Curated CGs
 *              (`publishPolicy == 0`) delegate to
 *              `isAuthorizedPublisher(cgId, msg.sender)` via the facade so
 *              EOA / Safe curators and PCA agents inherit update rights
 *              automatically. Open CGs (`publishPolicy == 1`) have no curator
 *              authority to delegate to, so update auth pins to the ORIGINAL
 *              publisher (`merkleRoots[0].publisher`) — the paying principal
 *              recorded at publish time. Replaces the initial V10 ERC-1155
 *              `balanceOf(msg.sender, kcRange) > 0` gate (which was hijackable
 *              via ERC-1155Delta token transfers) and the V9
 *              `latestPublisher == msg.sender` gate (which gated on
 *              node-operator key, not the paying principal).
 *
 * Byte-size ceiling (decision #4 closure): updates may GROW `newByteSize`
 * beyond the original value, as long as the new `tokenAmount` covers the new
 * size × remaining lifetime at the current stake-weighted ask. The
 * `originalByteSize` ceiling mapping is REMOVED; byte-size audit provenance
 * lives in the KCS `KnowledgeCollectionByteSizeUpdated` event history.
 */
contract KnowledgeAssetsV10 is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "KnowledgeAssetsV10";
    string private constant _VERSION = "10.1.0";

    // --- V10 publish input (grouped to bypass the 16-arg stack limit) ---

    struct PublishParams {
        string publishOperationId;
        uint256 contextGraphId;
        bytes32 merkleRoot;
        uint256 knowledgeAssetsAmount;
        uint88 byteSize;
        uint40 epochs;
        uint96 tokenAmount;
        bool isImmutable;
        uint72 publisherNodeIdentityId;
        bytes32 publisherNodeR;
        bytes32 publisherNodeVS;
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
    }

    /**
     * @notice V10 update input (grouped to bypass the 16-arg stack limit).
     *
     * `newTokenAmount` is the NEW TOTAL `tokenAmount` for the KC (not a delta).
     * KAV10 computes `delta = newTokenAmount - currentTokenAmount` internally
     * and charges the caller only for the delta via the conviction or direct
     * path. Metadata-only updates (`delta == 0`) are free but still require
     * fresh publisher + ACK signatures.
     */
    struct UpdateParams {
        uint256 id;
        string updateOperationId;
        bytes32 newMerkleRoot;
        uint88 newByteSize;
        uint96 newTokenAmount;
        uint256 mintKnowledgeAssetsAmount;
        uint256[] knowledgeAssetsToBurn;
        uint72 publisherNodeIdentityId;
        bytes32 publisherNodeR;
        bytes32 publisherNodeVS;
        uint72[] identityIds;
        bytes32[] r;
        bytes32[] vs;
    }

    // --- Hub-resolved dependencies ---

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    PaymasterManager public paymasterManager;
    KnowledgeCollectionStorage public knowledgeCollectionStorage;
    Chronos public chronos;
    IERC20 public tokenContract;
    ParametersStorage public parametersStorage;
    IdentityStorage public identityStorage;
    StakingStorage public stakingStorage;
    ContextGraphs public contextGraphs;
    ContextGraphStorage public contextGraphStorage;
    ContextGraphValueStorage public contextGraphValueStorage;
    IDKGPublishingConvictionNFT public publishingConvictionNFT;

    // --- Errors ---

    error ZeroAddressDependency(string name);
    error ZeroContextGraphId();
    error ZeroEpochs();

    // --- Update-specific errors (V10 Phase 8 Task 2) ---

    /// @dev Update would reduce the KC's `tokenAmount` below its current
    ///      value. Rebates are not supported — a publisher that wants to
    ///      downsize must let the KC expire and republish. (decision #4)
    error CannotShrinkTokenAmount(uint96 currentTokenAmount, uint96 newTokenAmount);

    /// @dev Caller is attempting a paid update (`newTokenAmount >
    ///      currentTokenAmount`) but the KC has no full epoch of remaining
    ///      lifetime (`currentEpoch == endEpoch`). No distribution vehicle
    ///      exists for the extra tokens — the publisher must extend the
    ///      lifetime via `extendKnowledgeCollectionLifetime` before growing
    ///      byte size or tokenAmount in the final epoch.
    error NoRemainingLifetimeForDelta(uint256 kcId, uint40 currentEpoch, uint40 endEpoch);

    /// @dev KC has no CG binding recorded (`kcToContextGraph[kcId] == 0`).
    ///      This is a corrupt-state assertion: publish atomically binds
    ///      kcId → cgId, so a missing binding indicates a Phase 7 storage
    ///      invariant was violated. Update cannot proceed without knowing
    ///      the CG because the CG value ledger needs the target cgId.
    error MissingContextGraphBinding(uint256 kcId);

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        paymasterManager = PaymasterManager(hub.getContractAddress("PaymasterManager"));
        knowledgeCollectionStorage = KnowledgeCollectionStorage(
            hub.getAssetStorageAddress("KnowledgeCollectionStorage")
        );
        chronos = Chronos(hub.getContractAddress("Chronos"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));

        // V10 new dependencies — fail-fast. Each MUST be Hub-registered at
        // KAV10 initialize() time. The Phase 7 transitional try/catch tolerance
        // is removed: Phase 8 makes ContextGraphs + CG value + NFT mandatory.

        address cgAddr = hub.getContractAddress("ContextGraphs");
        if (cgAddr == address(0)) revert ZeroAddressDependency("ContextGraphs");
        contextGraphs = ContextGraphs(cgAddr);

        // ContextGraphStorage is resolved directly for read-only `kcToContextGraph`
        // lookups on the update path. The facade does not expose a KC→CG view
        // getter, and caching the storage here avoids a double-hop SLOAD via
        // `contextGraphs.contextGraphStorage()` on every update. Writes still
        // go through the facade (auth + atomic bind in `publish`).
        address cgsAddr = hub.getAssetStorageAddress("ContextGraphStorage");
        if (cgsAddr == address(0)) revert ZeroAddressDependency("ContextGraphStorage");
        contextGraphStorage = ContextGraphStorage(cgsAddr);

        address cgvAddr = hub.getContractAddress("ContextGraphValueStorage");
        if (cgvAddr == address(0)) revert ZeroAddressDependency("ContextGraphValueStorage");
        contextGraphValueStorage = ContextGraphValueStorage(cgvAddr);

        address nftAddr = hub.getContractAddress("DKGPublishingConvictionNFT");
        if (nftAddr == address(0)) revert ZeroAddressDependency("DKGPublishingConvictionNFT");
        publishingConvictionNFT = IDKGPublishingConvictionNFT(nftAddr);
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // V10 Publish Entries
    // ========================================================================

    /**
     * @notice Publish via publisher conviction account (discounted path).
     *
     * The publishing agent (`msg.sender`) must be registered under an active
     * conviction NFT account via `DKGPublishingConvictionNFT.registerAgent`.
     * The NFT auto-resolves the paying account from `agentToAccountId[msg.sender]`
     * inside `coverPublishingCost` — KAV10 does NOT accept a caller-supplied
     * account id (N28 closure).
     *
     * Double-count prevention (decision #17 + H critical):
     * The NFT's `createAccount` already wrote the full `committedTRAC` into
     * `EpochStorage.addTokensToEpochRange` across the 12-epoch lock window.
     * This path therefore MUST NOT call `_addTokens` or `_distributeTokens` —
     * doing so would double-count TRAC in the staker reward pool.
     *
     * @param p All publish parameters (see `PublishParams` struct).
     * @return kcId Newly created knowledge collection id.
     */
    function publish(PublishParams calldata p) external returns (uint256 kcId) {
        // `currentEpoch` from the core is unused on this path — TRAC was
        // already written into `EpochStorage.addTokensToEpochRange` at
        // `createAccount` time, so no per-epoch distribution runs here
        // (double-count prevention).
        (, kcId) = _executePublishCore(p);

        // Spend publisher allowance. NFT reverts NoConvictionAccount(msg.sender)
        // if caller is not registered as an agent on any active account.
        // Discounted amount is discarded here — the NFT emits `CostCovered`
        // with full detail for off-chain accounting.
        publishingConvictionNFT.coverPublishingCost(msg.sender, p.tokenAmount);

        return kcId;
    }

    /**
     * @notice Publish at market rate (no conviction discount).
     *
     * Pulls TRAC from `msg.sender` (or `paymaster` if valid) and distributes
     * it across the epoch range via `_distributeTokens`. No conviction NFT
     * involvement — nothing to auto-resolve, nothing to double-count.
     *
     * @param p Publish parameters.
     * @param paymaster Paymaster address for cost coverage, or `address(0)`
     *                  to pull from `msg.sender` directly.
     * @return kcId Newly created knowledge collection id.
     */
    function publishDirect(
        PublishParams calldata p,
        address paymaster
    ) external returns (uint256 kcId) {
        uint40 currentEpoch;
        (currentEpoch, kcId) = _executePublishCore(p);

        // Pull funds + distribute to the reward pool across the epoch range.
        _addTokens(p.tokenAmount, paymaster);
        _distributeTokens(p.tokenAmount, p.epochs, currentEpoch);

        return kcId;
    }

    // ========================================================================
    // Internal: Shared publish core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KCS create +
     *         atomic CG bind + CG value write.
     *
     * Both `publish` and `publishDirect` run this before branching on
     * payment path. No TRAC movement happens here — the caller's path
     * handles that.
     */
    function _executePublishCore(
        PublishParams calldata p
    ) internal returns (uint40 currentEpoch, uint256 kcId) {
        // --- 1. Signature verification ---

        // Publisher digest (N26: field order = publisherNodeIdentityId, contextGraphId, merkleRoot).
        // H5: prefix with (block.chainid, address(this)) to pin replay to this chain + contract.
        bytes32 publisherDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                p.publisherNodeIdentityId,
                p.contextGraphId,
                p.merkleRoot
            )
        );
        bytes32 publisherEthDigest = ECDSA.toEthSignedMessageHash(publisherDigest);
        // The publisher-node signature only attests that a staked operator key of
        // `publisherNodeIdentityId` signed the (chainid, contract, node, cgId, root)
        // tuple — i.e. "this node is willing to host this data". The recovered
        // wallet is NOT the publisher of record. The publisher of record is
        // `msg.sender` (the paying agent), which is what KCS stores on the
        // merkle-root entry and which receives the minted ERC-1155 KA tokens.
        // We still need `_verifySignature` to validate the signature + key
        // purpose + node stake; we discard the returned address.
        _verifySignature(
            p.publisherNodeIdentityId,
            publisherEthDigest,
            p.publisherNodeR,
            p.publisherNodeVS
        );

        // ACK digest. H5 chain/contract prefix mirrors the publisher digest.
        // Field set per PRD (V10 protocol core §9 "Publish Flow — Contract
        // Verification") and decision #25 Option B:
        //   (chainid, address(this), contextGraphId, merkleRoot,
        //    knowledgeAssetsAmount, byteSize, epochs, tokenAmount)
        // The publisher node identity is NOT part of the ACK digest — it lives
        // only in the publisher digest above. ACK signers attest to the
        // publication's economic + content shape; the publishing node is a
        // separate authority verified separately. Mixing the two would break
        // off-chain spec-conformant signers.
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                p.contextGraphId,
                p.merkleRoot,
                p.knowledgeAssetsAmount,
                uint256(p.byteSize),
                uint256(p.epochs),
                uint256(p.tokenAmount)
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        // --- 2. CG existence + validation (revert before any state mutation) ---

        // Decision #3: contextGraphId == 0 is forbidden. No legacy path.
        if (p.contextGraphId == 0) revert ZeroContextGraphId();

        // Same-contract input validation — without this, epochs == 0 would
        // flow through `_validateTokenAmount` (which computes 0), through
        // KCS create, and only revert downstream in
        // `ContextGraphValueStorage.addCGValueForEpochRange` with
        // `ZeroLifetime`. That downstream error hides the real cause from
        // the caller. Fail fast here with a KAV10-local diagnostic.
        if (p.epochs == 0) revert ZeroEpochs();

        // H7: SafeCast guards the uint96 cast in _validateTokenAmount.
        _validateTokenAmount(p.byteSize, p.epochs, p.tokenAmount, false);

        // N17: pass the PAYING PRINCIPAL (msg.sender of this tx — the
        // publishing agent) to `isAuthorizedPublisher`, NOT the recovered
        // node signer. The pre-rewrite implementation authorized against
        // the wrong principal — a paying agent could be rejected if their
        // node ran the signing, and a non-authorized agent could be
        // approved if a node it didn't control signed off.
        if (!contextGraphs.isAuthorizedPublisher(p.contextGraphId, msg.sender)) {
            revert KnowledgeAssetsLib.UnauthorizedPublisher(p.contextGraphId, msg.sender);
        }

        // --- 3. Create KC in storage ---

        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;
        currentEpoch = uint40(chronos.getCurrentEpoch());

        // Publisher of record + ERC-1155 KA token recipient = `msg.sender`
        // (the paying agent). This address is stored as
        // `merkleRoots[0].publisher` in KCS and serves as the update-auth
        // pin for open CGs (which have no curator authority to delegate
        // to). Passing the recovered node signer here would record the
        // node operator wallet as the original publisher and break
        // publish→update coherence for open-CG publishers.
        kcId = kcs.createKnowledgeCollection(
            msg.sender,
            p.publishOperationId,
            p.merkleRoot,
            p.knowledgeAssetsAmount,
            p.byteSize,
            currentEpoch,
            currentEpoch + p.epochs,
            p.tokenAmount,
            p.isImmutable
        );

        // --- 4. N20: atomic CG↔KC binding + CG value diff ---

        // Facade write: kcToContextGraph[kcId] = cgId AND contextGraphKCList[cgId].push(kcId).
        contextGraphs.registerKnowledgeCollection(p.contextGraphId, kcId);

        // Per-CG + global value ledger for value-weighted random challenges.
        // Uses BASE `tokenAmount` — value weighting tracks data value, not
        // publisher economics (discounted cost is irrelevant here).
        contextGraphValueStorage.addCGValueForEpochRange(
            p.contextGraphId,
            uint256(currentEpoch),
            uint256(p.epochs),
            uint256(p.tokenAmount)
        );

        // Per-node produced value for scoring. Shared by both public entry
        // points — uses BASE `tokenAmount`, NOT any discounted effective
        // spend, so a node's produced-value score reflects the data value
        // the publisher declared.
        epochStorage.addEpochProducedKnowledgeValue(p.publisherNodeIdentityId, currentEpoch, p.tokenAmount);
    }

    // ========================================================================
    // Lifetime Extension (V8-compatible, no ACK change needed)
    // ========================================================================

    function extendKnowledgeCollectionLifetime(
        uint256 id,
        uint40 epochs,
        uint96 tokenAmount,
        address paymaster
    ) external {
        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;

        (, , , uint88 byteSize, , uint40 endEpoch, uint96 oldTokenAmount, ) = kcs.getKnowledgeCollectionMetadata(id);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > endEpoch) {
            revert KnowledgeCollectionLib.KnowledgeCollectionExpired(id, currentEpoch, endEpoch);
        }

        kcs.setEndEpoch(id, endEpoch + epochs);
        kcs.setTokenAmount(id, oldTokenAmount + tokenAmount);

        _validateTokenAmount(byteSize, epochs, tokenAmount, false);
        epochStorage.addTokensToEpochRange(1, endEpoch, endEpoch + epochs, tokenAmount);
        _addTokens(tokenAmount, paymaster);

        // Phase 1+8 cross-phase fix: extending a KC's lifetime adds value to
        // the CG it belongs to, so the CG's value-weighted random-sampling
        // contribution must grow accordingly. Without this write the CG would
        // undercount extended KCs at challenge selection time.
        //
        // V10 KCs always have a CG binding (Phase 7 invariant). Legacy V8 KCs
        // — created before atomic CG bind landed — return cgId == 0; in that
        // case we skip the CG value write so the V8 lifetime-extension path
        // keeps working unchanged.
        if (epochs > 0 && tokenAmount > 0) {
            uint256 cgId = contextGraphStorage.kcToContextGraph(id);
            if (cgId != 0) {
                // Pin the diff over the EXTENSION window only, starting at
                // the (old) endEpoch — the original publish window already
                // wrote its own diff at publish time and that contribution
                // retracts at the original endEpoch as designed.
                contextGraphValueStorage.addCGValueForEpochRange(
                    cgId,
                    uint256(endEpoch),
                    uint256(epochs),
                    uint256(tokenAmount)
                );
            }
        }
    }

    // ========================================================================
    // Internal: Signature Verification
    // ========================================================================

    function _verifySignatures(
        uint72[] calldata identityIds,
        bytes32 messageHash,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) internal view {
        if (r.length != identityIds.length || r.length != vs.length) {
            revert KnowledgeCollectionLib.SignaturesSignersMismatch(r.length, vs.length, identityIds.length);
        }

        uint256 minSigs = parametersStorage.minimumRequiredSignatures();

        if (r.length < minSigs) {
            revert KnowledgeCollectionLib.MinSignaturesRequirementNotMet(minSigs, r.length);
        }

        uint256 uniqueCount;
        for (uint256 i; i < identityIds.length; i++) {
            bool isDuplicate = false;
            for (uint256 j; j < i; j++) {
                if (identityIds[i] == identityIds[j]) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) {
                uniqueCount++;
                if (uniqueCount >= minSigs) break;
            }
        }
        require(uniqueCount >= minSigs, "Insufficient unique receiver identities");

        for (uint256 i; i < identityIds.length; i++) {
            _verifySignature(identityIds[i], messageHash, r[i], vs[i]);
        }
    }

    function _verifySignature(
        uint72 identityId,
        bytes32 messageHash,
        bytes32 _r,
        bytes32 _vs
    ) internal view returns (address signer) {
        signer = ECDSA.tryRecover(messageHash, _r, _vs);

        if (signer == address(0)) {
            revert KnowledgeCollectionLib.InvalidSignature(identityId, messageHash, _r, _vs);
        }

        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(signer)), IdentityLib.OPERATIONAL_KEY)
        ) {
            revert KnowledgeCollectionLib.SignerIsNotNodeOperator(identityId, signer);
        }

        // Core nodes must be staked (spec §9.0)
        require(stakingStorage.getNodeStake(identityId) > 0, "ACK signer has no stake");
    }

    // ========================================================================
    // Internal: Payment
    // ========================================================================

    function _validateTokenAmount(
        uint256 byteSize,
        uint256 epochs,
        uint96 tokenAmount,
        bool includeCurrentEpoch
    ) internal view {
        Chronos chron = chronos;

        uint256 stakeWeightedAverageAsk = askStorage.getStakeWeightedAverageAsk();
        // H7: `SafeCast.toUint96` reverts on overflow instead of silently
        // truncating. A publisher sending `stakeWeightedAverageAsk * byteSize
        // * epochs / 1024` > uint96.max (~79 bn TRAC) MUST revert — silent
        // truncation would make a catastrophically underpaid publish look
        // correctly-paid because `tokenAmount` would match the wrapped cost.
        uint96 expectedTokenAmount;
        if (includeCurrentEpoch) {
            uint256 totalStorageTime = (epochs * 1e18) + (chron.timeUntilNextEpoch() * 1e18) / chron.epochLength();
            expectedTokenAmount = SafeCast.toUint96(
                (stakeWeightedAverageAsk * byteSize * totalStorageTime) / 1024 / 1e18
            );
        } else {
            expectedTokenAmount = SafeCast.toUint96((stakeWeightedAverageAsk * byteSize * epochs) / 1024);
        }

        if (tokenAmount < expectedTokenAmount) {
            revert KnowledgeCollectionLib.InvalidTokenAmount(expectedTokenAmount, tokenAmount);
        }
    }

    function _addTokens(uint96 tokenAmount, address paymaster) internal {
        IERC20 token = tokenContract;

        if (paymasterManager.validPaymasters(paymaster)) {
            IPaymaster(paymaster).coverCost(tokenAmount);
        } else {
            if (token.allowance(msg.sender, address(this)) < tokenAmount) {
                revert TokenLib.TooLowAllowance(
                    address(token),
                    token.allowance(msg.sender, address(this)),
                    tokenAmount
                );
            }

            if (token.balanceOf(msg.sender) < tokenAmount) {
                revert TokenLib.TooLowBalance(address(token), token.balanceOf(msg.sender), tokenAmount);
            }

            if (!token.transferFrom(msg.sender, address(stakingStorage), tokenAmount)) {
                revert TokenLib.TransferFailed();
            }
        }
    }

    // ========================================================================
    // V10 Update Entries
    // ========================================================================

    /**
     * @notice Update an existing knowledge collection via publisher conviction
     *         account (discounted path). Closes N16, N19 (local ceiling removal),
     *         and decision #4.
     *
     * Authorization: policy-branch gate in `_executeUpdateCore`. Curated CGs
     * delegate to the facade (`isAuthorizedPublisher`), which handles
     * EOA/Safe direct-equality and PCA live-resolve + agent delegation so
     * the authorized principal set tracks CG NFT transfers and PCA agent
     * cycling without off-chain coordination. Open CGs pin auth to
     * `merkleRoots[0].publisher` (the original paying principal at publish
     * time), because open CGs have no curator to delegate to. Replaces the
     * initial ERC-1155 `balanceOf` gate, which was unsound under
     * ERC-1155Delta transferability: any downstream buyer of a single KA
     * token inherited full update authority.
     *
     * Delta-only payment semantics (decision #4 interpretation): the caller
     * passes `newTokenAmount` as the NEW TOTAL `tokenAmount` for the KC. KAV10
     * charges only `delta = newTokenAmount - currentTokenAmount` via
     * `coverPublishingCost`. Rebates are rejected (`CannotShrinkTokenAmount`).
     * Metadata-only updates (`delta == 0`) bypass `coverPublishingCost`
     * entirely — no conviction spend, no zero-value NFT hop.
     *
     * Double-count prevention (same reasoning as `publish`): conviction-path
     * TRAC was already distributed by the NFT's `createAccount` /`topUp` at
     * lock time, so this path MUST NOT call `_addTokens` / `_distributeTokens`.
     *
     * @param p Update parameters (see `UpdateParams` struct).
     */
    function update(UpdateParams calldata p) external {
        (uint96 deltaTokenAmount, , ) = _executeUpdateCore(p);

        if (deltaTokenAmount > 0) {
            // Spend publisher allowance for the delta only. NFT reverts
            // NoConvictionAccount(msg.sender) if caller is not registered
            // as an agent on any active account.
            publishingConvictionNFT.coverPublishingCost(msg.sender, deltaTokenAmount);
        }
    }

    /**
     * @notice Update an existing knowledge collection at market rate (no
     *         conviction discount).
     *
     * Pulls `delta` TRAC from `msg.sender` (or `paymaster` if valid) and
     * distributes it across the REMAINING lifetime via `_distributeTokens`.
     * Metadata-only updates (`delta == 0`) skip both the token pull and the
     * distribution entirely.
     *
     * @param p Update parameters.
     * @param paymaster Paymaster address for cost coverage, or `address(0)`
     *                  to pull from `msg.sender` directly.
     */
    function updateDirect(UpdateParams calldata p, address paymaster) external {
        (uint96 deltaTokenAmount, uint40 remainingEpochs, uint40 currentEpoch) = _executeUpdateCore(p);

        if (deltaTokenAmount > 0) {
            _addTokens(deltaTokenAmount, paymaster);
            _distributeTokens(deltaTokenAmount, uint256(remainingEpochs), currentEpoch);
        }
    }

    // ========================================================================
    // Internal: Shared update core
    // ========================================================================

    /**
     * @notice Signature verification + auth + validation + KCS mutation +
     *         atomic CG value delta write.
     *
     * Both `update` and `updateDirect` run this before branching on payment
     * path. No TRAC movement happens here — the caller's path handles that.
     *
     * @return deltaTokenAmount Delta between `newTokenAmount` and the KC's
     *         current on-chain tokenAmount. Zero on metadata-only updates.
     * @return remainingEpochs Number of "epoch units" from `currentEpoch` to
     *         `endEpoch`, exclusive on the tail partial. Matches `p.epochs`
     *         semantics from `_executePublishCore` so `_distributeTokens` can
     *         be reused verbatim in `updateDirect`.
     * @return currentEpoch The current epoch (cached for `_distributeTokens`).
     */
    function _executeUpdateCore(
        UpdateParams calldata p
    )
        internal
        returns (uint96 deltaTokenAmount, uint40 remainingEpochs, uint40 currentEpoch)
    {
        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;

        // --- 1. Read current KC metadata (needed for validation + auth) ---
        //
        // `getKnowledgeCollectionUpdateContext` is a scalar-only getter
        // added for the update path specifically. The legacy
        // `getKnowledgeCollectionMetadata` performs a full storage → memory
        // struct copy, which walks every entry of `merkleRoots[]` and
        // `burned[]`. Both grow monotonically on every update, so calling
        // the legacy getter from the update path made gas scale (super-)
        // linearly with history — a KC with enough updates would
        // eventually become un-updatable. Switching to this scalar getter
        // keeps the update cost constant. (Codex round 3 finding 1.)

        // `minted` is intentionally discarded: the old N16 `balanceOf` auth
        // gate needed the KC's minted count to compute the token range, but
        // the policy-branch auth gate below no longer touches token ranges.
        (
            uint256 preUpdateMerkleRootCount,
            ,
            uint88 currentByteSize,
            uint40 endEpoch,
            uint96 currentTokenAmount,
            bool isImmutable
        ) = kcs.getKnowledgeCollectionUpdateContext(p.id);

        if (isImmutable) {
            revert KnowledgeCollectionLib.CannotUpdateImmutableKnowledgeCollection(p.id);
        }

        currentEpoch = uint40(chronos.getCurrentEpoch());
        if (uint256(currentEpoch) > uint256(endEpoch)) {
            revert KnowledgeCollectionLib.KnowledgeCollectionExpired(
                p.id,
                uint256(currentEpoch),
                uint256(endEpoch)
            );
        }

        // Remaining lifetime in "publish epoch units" — matches `p.epochs`
        // semantics in `_executePublishCore`, where `endEpoch = startEpoch +
        // epochs`. `_distributeTokens` consumes this as the partial-current
        // + full-middle + partial-final split, and `addCGValueForEpochRange`
        // pins its diff over `[currentEpoch, currentEpoch + remainingEpochs)`,
        // retracting at `endEpoch`. Matches the publish-time retraction point.
        remainingEpochs = endEpoch - currentEpoch;

        // --- 2. CG binding lookup (required for value delta write) ---

        uint256 contextGraphId = contextGraphStorage.kcToContextGraph(p.id);
        if (contextGraphId == 0) {
            // Post-Phase-7 invariant: publish atomically binds kcId → cgId
            // via `contextGraphs.registerKnowledgeCollection`. Zero here
            // means corrupt state (KC created outside publish, or Phase 7
            // migration gap). Fail loudly — silently authorizing without a
            // CG would orphan the KC from value-weighted challenges.
            revert MissingContextGraphBinding(p.id);
        }

        // --- 3. Signature verification ---

        // Publisher digest (N26 field order: publisherNodeIdentityId,
        // contextGraphId, merkleRoot). Prefixed with block.chainid +
        // address(this) for H5 cross-chain / cross-deployment replay pin.
        // The CG id comes from on-chain state, not from the caller — a
        // signer cannot redirect an update to a different CG by lying about
        // it in the signed payload.
        bytes32 publisherDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                p.publisherNodeIdentityId,
                contextGraphId,
                p.newMerkleRoot
            )
        );
        _verifySignature(
            p.publisherNodeIdentityId,
            ECDSA.toEthSignedMessageHash(publisherDigest),
            p.publisherNodeR,
            p.publisherNodeVS
        );

        // ACK digest — covers EVERY mutable field the update can change so a
        // stale ACK can't be replayed with different byte size, different
        // token amount, different mint/burn counts, or a different kc id. The
        // burn id list is digested by its `keccak256` so an arbitrary-length
        // array folds into a fixed-size `bytes32` without blowing out the
        // packed digest. H5 prefix pins replay to (chain, contract).
        //
        // Replay protection: the digest binds the PRE-UPDATE merkle-root chain
        // length. KCS appends to `merkleRoots[]` on every successful update, so
        // every successful update increments this counter and invalidates any
        // ACK that was signed against an earlier value. Without this binding,
        // a captured update ACK could be replayed against a later state of the
        // same KC — for paid updates the attacker would burn their own TRAC,
        // but a `delta == 0` (metadata-only) ACK could be replayed for free to
        // roll the merkle root back. The pre-update length comes from the
        // scalar metadata getter above — signers read the same value off-chain,
        // so both sides agree on the exact version they're attesting.
        //
        // Same field-set rule as publish: NO `publisherNodeIdentityId` in the
        // ACK digest. The publishing node is verified separately above. The
        // publish ACK shape is defined by the PRD (see `_executePublishCore`
        // comment); the update ACK mirrors the same separation and adds the
        // update-specific fields (`id`, pre-update merkle-root count, mint
        // amount, burn list hash).
        bytes32 ackDigest = keccak256(
            abi.encodePacked(
                block.chainid,
                address(this),
                contextGraphId,
                p.id,
                preUpdateMerkleRootCount,
                p.newMerkleRoot,
                uint256(p.newByteSize),
                uint256(p.newTokenAmount),
                p.mintKnowledgeAssetsAmount,
                keccak256(abi.encodePacked(p.knowledgeAssetsToBurn))
            )
        );
        _verifySignatures(p.identityIds, ECDSA.toEthSignedMessageHash(ackDigest), p.r, p.vs);

        // --- 4. Validate the new total + compute delta ---

        // No rebates: new total must be >= current total. A publisher that
        // wants to "shrink" must let the KC expire and republish.
        if (p.newTokenAmount < currentTokenAmount) {
            revert CannotShrinkTokenAmount(currentTokenAmount, p.newTokenAmount);
        }
        deltaTokenAmount = p.newTokenAmount - currentTokenAmount;

        // Final-epoch economic guard: with zero remaining lifetime there is
        // nothing to amortize a new commitment over. Any new TRAC delta OR
        // any byte-size growth is rejected — both need a future window to
        // land in (`_distributeTokens` would divide by zero on delta > 0,
        // and the byte-size growth validation below would compute an
        // expected cost of ZERO at `remainingEpochs == 0`, silently letting
        // growth through for free).
        if (
            remainingEpochs == 0 &&
            (deltaTokenAmount > 0 || p.newByteSize > currentByteSize)
        ) {
            revert NoRemainingLifetimeForDelta(p.id, currentEpoch, endEpoch);
        }

        // Byte-size growth cost check. Charges `delta` against the MARGINAL
        // cost of the growth (`newByteSize - currentByteSize`) over the
        // REMAINING lifetime, not against the cumulative `newTokenAmount`.
        //
        // Why not validate cumulative `newTokenAmount` vs `remainingEpochs`:
        // `newTokenAmount` is the TOTAL historical commitment, most of
        // which has already been distributed into PAST epoch pools by the
        // time the update lands. Late in a KC's lifetime (say, epoch 9 of
        // 10), ~90% of the cumulative has already been paid out to past
        // stakers. Validating `newTokenAmount` against the remaining
        // window would credit that sunk commitment as future funding,
        // letting a publisher double the byteSize at epoch 9/10 with
        // ZERO new TRAC. The cumulative looks sufficient, but the actual
        // undistributed reward pool for the remaining window would be
        // fractions of the new footprint's cost. Charging only the
        // marginal cost of the GROWTH, payable by `delta` over the
        // REMAINING window, closes that hole.
        //
        // Pure metadata-only updates (`newByteSize <= currentByteSize`,
        // regardless of delta) skip this check entirely — they are
        // re-attestations of existing data (merkle-root rotation) or pure
        // over-funding TRAC top-ups, and the original publish-time
        // validation still governs the underlying economic surface. Gating
        // on `delta > 0` instead would block routine root rotations under
        // a rising stake-weighted ask.
        if (p.newByteSize > currentByteSize) {
            uint256 byteSizeGrowth = uint256(p.newByteSize) - uint256(currentByteSize);
            _validateTokenAmount(
                byteSizeGrowth,
                uint256(remainingEpochs),
                deltaTokenAmount,
                false
            );
        }

        // --- 5. Update authorization (policy-branch) ---

        // Open CGs (`publishPolicy == 1`) have no curator authority, so
        // `isAuthorizedPublisher` returns true for ANY non-zero caller
        // there — using it as the update gate would let random addresses
        // rotate merkle roots on other publishers' KCs. Pin open-CG update
        // auth to `merkleRoots[0].publisher` instead (the original paying
        // principal at publish time).
        //
        // Curated CGs delegate to `isAuthorizedPublisher` via the facade,
        // which handles EOA/Safe direct-equality and PCA live-resolve +
        // agent mapping. This means an EOA/Safe curator transfer (via the
        // CG NFT's storage-rotated `publishAuthority`) and PCA agent
        // cycling both automatically flow through to update rights, with
        // no stale-authority drift.
        //
        // Replaces the initial `balanceOf(msg.sender, kcRange) > 0` gate,
        // which was unsound because ERC-1155Delta KA tokens are
        // transferable via `safeTransferFrom`. Under the old gate, any
        // downstream recipient of a single KA token from a KC gained full
        // update authority — could rotate the merkle root, mint new KAs,
        // burn existing KAs — trivially hijacking KCs whose tokens had
        // moved to a secondary holder.
        (uint8 publishPolicy, ) = contextGraphStorage.getPublishPolicy(contextGraphId);
        if (publishPolicy == 1) {
            address originalPublisher = kcs.getMerkleRootPublisherByIndex(p.id, 0);
            if (msg.sender != originalPublisher) {
                revert KnowledgeAssetsLib.UnauthorizedPublisher(contextGraphId, msg.sender);
            }
        } else if (!contextGraphs.isAuthorizedPublisher(contextGraphId, msg.sender)) {
            revert KnowledgeAssetsLib.UnauthorizedPublisher(contextGraphId, msg.sender);
        }

        // --- 6. Apply KCS mutation (new merkle root, bytes, tokens, mint/burn) ---

        // `msg.sender` (the paying publisher) is recorded as the new merkle
        // root author AND is the recipient of any newly minted KA tokens.
        // `p.updateOperationId` is the off-chain correlation id emitted on
        // `KnowledgeCollectionUpdated`. KCS internally reconciles its
        // `_totalTokenAmount` counter from old → new.
        kcs.updateKnowledgeCollection(
            msg.sender,
            p.id,
            p.updateOperationId,
            p.newMerkleRoot,
            p.mintKnowledgeAssetsAmount,
            p.knowledgeAssetsToBurn,
            p.newByteSize,
            p.newTokenAmount
        );

        // --- 7. CG value delta + per-node produced-value bookkeeping ---

        // Skip on metadata-only updates — the CG value storage reverts on
        // `value == 0` (and `remainingEpochs == 0` was already gated above
        // when delta > 0, so by here either delta > 0 AND remainingEpochs > 0,
        // or delta == 0 and we short-circuit).
        if (deltaTokenAmount > 0) {
            // Write the delta CG value over the REMAINING lifetime so the
            // per-epoch contribution crystallizes into the CG value cumulative
            // the same way a fresh publish does. Retraction diff lands at
            // `endEpoch`, matching publish's retraction point.
            contextGraphValueStorage.addCGValueForEpochRange(
                contextGraphId,
                uint256(currentEpoch),
                uint256(remainingEpochs),
                uint256(deltaTokenAmount)
            );

            // Track per-node produced value for the delta. Uses BASE delta
            // (not discounted effective spend) so the scoring reflects data
            // value added, not publisher economics — identical to publish.
            epochStorage.addEpochProducedKnowledgeValue(
                p.publisherNodeIdentityId,
                currentEpoch,
                deltaTokenAmount
            );
        }
    }

    // ========================================================================
    // Internal: Token Distribution
    // ========================================================================

    function _distributeTokens(uint96 tokenAmount, uint256 epochs, uint40 currentEpoch) internal {
        // `epochs > 0` is guaranteed by every caller:
        //   - `publishDirect` → `_executePublishCore` rejects `p.epochs == 0`
        //     with `ZeroEpochs` before reaching this helper.
        //   - `updateDirect` → `_executeUpdateCore` rejects
        //     `deltaTokenAmount > 0 && remainingEpochs == 0` with
        //     `NoRemainingLifetimeForDelta`, and only calls `_distributeTokens`
        //     inside an `if (deltaTokenAmount > 0)` gate.
        // No defensive re-check needed. `extendKnowledgeCollectionLifetime`
        // does NOT call this helper (it hits `addTokensToEpochRange` directly).

        uint256 epochLengthInSeconds = chronos.epochLength();
        uint256 timeRemainingInCurrentEpoch = chronos.timeUntilNextEpoch();
        uint256 baseTokensPerFullEpoch = tokenAmount / epochs;
        uint256 currentEpochAllocation = (baseTokensPerFullEpoch * timeRemainingInCurrentEpoch) / epochLengthInSeconds;
        uint256 finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation;
        uint256 numberOfFullEpochs = epochs - 1;
        uint256 totalTokensForFullEpochs = baseTokensPerFullEpoch * numberOfFullEpochs;

        uint256 totalAllocated = currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
        if (totalAllocated < tokenAmount) {
            finalEpochAllocation += tokenAmount - totalAllocated;
        }

        if (currentEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(1, currentEpoch, currentEpoch, uint96(currentEpochAllocation));
        }

        if (numberOfFullEpochs > 0 && totalTokensForFullEpochs > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                currentEpoch + 1,
                currentEpoch + uint40(numberOfFullEpochs),
                uint96(totalTokensForFullEpochs)
            );
        }

        if (finalEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                currentEpoch + uint40(epochs),
                currentEpoch + uint40(epochs),
                uint96(finalEpochAllocation)
            );
        }
    }
}
