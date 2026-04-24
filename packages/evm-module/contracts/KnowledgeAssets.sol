// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {PaymasterManager} from "./storage/PaymasterManager.sol";
import {Chronos} from "./storage/Chronos.sol";
import {KnowledgeAssetsStorage} from "./storage/KnowledgeAssetsStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {TokenLib} from "./libraries/TokenLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IPaymaster} from "./interfaces/IPaymaster.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title KnowledgeAssets
 * @notice V9 logic contract for publishing Knowledge Assets with address-based namespaces.
 *
 * Any EVM address can reserve UAL ranges and publish — no on-chain identity required.
 * Core node identities are only needed for signature verification (storage agreement).
 *
 * UAL format: did:dkg:{chainId}/{publisherAddress}/{localKAId}
 */
contract KnowledgeAssets is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "KnowledgeAssets";
    string private constant _VERSION = "2.1.0";

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    PaymasterManager public paymasterManager;
    KnowledgeAssetsStorage public knowledgeAssetsStorage;
    Chronos public chronos;
    ShardingTableStorage public shardingTableStorage;
    IERC20 public tokenContract;
    ParametersStorage public parametersStorage;
    IdentityStorage public identityStorage;

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        paymasterManager = PaymasterManager(hub.getContractAddress("PaymasterManager"));
        knowledgeAssetsStorage = KnowledgeAssetsStorage(
            hub.getAssetStorageAddress("KnowledgeAssetsStorage")
        );
        chronos = Chronos(hub.getContractAddress("Chronos"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // UAL Range Reservation (permissionless, address-based)
    // ========================================================================

    /**
     * @notice Reserve a block of KA IDs for msg.sender. Gas cost only, no TRAC.
     * @param count Number of IDs to reserve
     * @return startId First reserved ID
     * @return endId Last reserved ID (inclusive)
     */
    function reserveUALRange(
        uint32 count
    ) external returns (uint64 startId, uint64 endId) {
        return knowledgeAssetsStorage.reserveUALRange(msg.sender, count);
    }

    // ========================================================================
    // Single-Transaction Publish (convenience: auto-reserve + mint)
    // ========================================================================

    /**
     * @notice Publish Knowledge Assets in a single transaction.
     * Auto-reserves a UAL range for msg.sender and mints the batch.
     *
     * @param kaCount Number of KAs to publish
     * @param publisherNodeIdentityId Core node identity that stores this data
     * @param merkleRoot KC-level merkle root covering all KAs
     * @param publicByteSize Size of public triples in bytes
     * @param epochs Storage duration in epochs (1 epoch = 30 days)
     * @param tokenAmount TRAC payment for storage
     * @param paymaster Optional paymaster address (zero = direct TRAC transfer)
     * @param publisherNodeR Publisher node signature R
     * @param publisherNodeVS Publisher node signature VS
     * @param identityIds Receiving node identity IDs
     * @param r Receiving node signature R values
     * @param vs Receiving node signature VS values
     * @return batchId The on-chain batch ID
     * @return startKAId First KA ID in the auto-reserved range
     * @return endKAId Last KA ID in the auto-reserved range
     */
    function publishKnowledgeAssets(
        uint32 kaCount,
        uint72 publisherNodeIdentityId,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint40 epochs,
        uint96 tokenAmount,
        address paymaster,
        bytes32 publisherNodeR,
        bytes32 publisherNodeVS,
        uint72[] calldata identityIds,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) external returns (uint256 batchId, uint64 startKAId, uint64 endKAId) {
        (startKAId, endKAId) = knowledgeAssetsStorage.reserveUALRange(msg.sender, kaCount);

        KnowledgeAssetsLib.PublishParams memory params;
        params.publisherNodeIdentityId = publisherNodeIdentityId;
        params.merkleRoot = merkleRoot;
        params.startKAId = startKAId;
        params.endKAId = endKAId;
        params.publicByteSize = publicByteSize;
        params.epochs = epochs;
        params.tokenAmount = tokenAmount;
        params.paymaster = paymaster;
        params.publisherNodeR = publisherNodeR;
        params.publisherNodeVS = publisherNodeVS;
        params.identityIds = identityIds;
        params.r = r;
        params.vs = vs;

        batchId = _mintBatch(params);
    }

    // ========================================================================
    // Batch Minting (for pre-minted UALs)
    // ========================================================================

    /**
     * @notice Batch-mint Knowledge Assets from msg.sender's reserved range.
     *
     * @param publisherNodeIdentityId Core node identity that stores this data
     * @param merkleRoot KC-level merkle root covering all KAs in this batch
     * @param startKAId First KA ID (from msg.sender's reserved range)
     * @param endKAId Last KA ID inclusive
     * @param publicByteSize Size of public triples in bytes
     * @param epochs Storage duration in epochs (1 epoch = 30 days)
     * @param tokenAmount TRAC payment for storage
     * @param paymaster Optional paymaster address (zero = direct TRAC transfer)
     * @param publisherNodeR Publisher node signature R
     * @param publisherNodeVS Publisher node signature VS
     * @param identityIds Receiving node identity IDs (for signature verification)
     * @param r Receiving node signature R values
     * @param vs Receiving node signature VS values
     * @return batchId The on-chain batch ID for this publish operation
     */
    function batchMintKnowledgeAssets(
        uint72 publisherNodeIdentityId,
        bytes32 merkleRoot,
        uint64 startKAId,
        uint64 endKAId,
        uint64 publicByteSize,
        uint40 epochs,
        uint96 tokenAmount,
        address paymaster,
        bytes32 publisherNodeR,
        bytes32 publisherNodeVS,
        uint72[] calldata identityIds,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) external returns (uint256 batchId) {
        if (startKAId > endKAId) {
            revert KnowledgeAssetsLib.InvalidKARange(startKAId, endKAId);
        }

        KnowledgeAssetsLib.PublishParams memory params;
        params.publisherNodeIdentityId = publisherNodeIdentityId;
        params.merkleRoot = merkleRoot;
        params.startKAId = startKAId;
        params.endKAId = endKAId;
        params.publicByteSize = publicByteSize;
        params.epochs = epochs;
        params.tokenAmount = tokenAmount;
        params.paymaster = paymaster;
        params.publisherNodeR = publisherNodeR;
        params.publisherNodeVS = publisherNodeVS;
        params.identityIds = identityIds;
        params.r = r;
        params.vs = vs;

        return _mintBatch(params);
    }

    // ========================================================================
    // Knowledge Updates
    // ========================================================================

    /**
     * @notice Update the merkle root and byte size of an existing batch.
     * Only callable by the original publisher (msg.sender == batch.publisherAddress).
     *
     * Pricing: 10% of original cost if new size <= original, else full rate on excess.
     */
    function updateKnowledgeAssets(
        uint256 batchId,
        bytes32 newMerkleRoot,
        uint64 newPublicByteSize
    ) external {
        KnowledgeAssetsStorage kas = knowledgeAssetsStorage;
        KnowledgeAssetsLib.KnowledgeBatch memory batch = kas.getBatch(batchId);

        if (batch.publisherAddress == address(0)) {
            revert KnowledgeAssetsLib.BatchNotFound(batchId);
        }
        if (batch.publisherAddress != msg.sender) {
            revert KnowledgeAssetsLib.NotBatchPublisher(batchId, msg.sender);
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > batch.endEpoch) {
            revert KnowledgeAssetsLib.BatchExpired(batchId, currentEpoch, batch.endEpoch);
        }

        uint96 updateCost;
        uint256 stakeWeightedAverageAsk = askStorage.getStakeWeightedAverageAsk();
        uint256 remainingEpochs = batch.endEpoch - uint40(currentEpoch);

        if (newPublicByteSize <= batch.publicByteSize) {
            uint96 originalCost = uint96(
                (stakeWeightedAverageAsk * batch.publicByteSize * (batch.endEpoch - batch.startEpoch)) / 1024
            );
            updateCost = originalCost / 10;
        } else {
            uint96 originalCost = uint96(
                (stakeWeightedAverageAsk * batch.publicByteSize * (batch.endEpoch - batch.startEpoch)) / 1024
            );
            uint64 excessBytes = newPublicByteSize - batch.publicByteSize;
            uint96 excessCost = uint96(
                (stakeWeightedAverageAsk * excessBytes * remainingEpochs) / 1024
            );
            updateCost = originalCost / 10 + excessCost;
        }

        kas.updateKnowledgeBatch(batchId, newMerkleRoot, newPublicByteSize, updateCost);

        if (updateCost > 0 && remainingEpochs > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                uint40(currentEpoch),
                batch.endEpoch,
                updateCost
            );
        }

        _addTokens(updateCost, address(0));
    }

    // ========================================================================
    // Storage Extension
    // ========================================================================

    function extendStorage(
        uint256 batchId,
        uint40 additionalEpochs,
        uint96 tokenAmount,
        address paymaster
    ) external {
        KnowledgeAssetsStorage kas = knowledgeAssetsStorage;
        KnowledgeAssetsLib.KnowledgeBatch memory batch = kas.getBatch(batchId);

        if (batch.publisherAddress == address(0)) {
            revert KnowledgeAssetsLib.BatchNotFound(batchId);
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > batch.endEpoch) {
            revert KnowledgeAssetsLib.BatchExpired(batchId, currentEpoch, batch.endEpoch);
        }

        _validateTokenAmount(batch.publicByteSize, additionalEpochs, tokenAmount);

        kas.extendBatchStorage(batchId, additionalEpochs, tokenAmount);

        epochStorage.addTokensToEpochRange(
            1,
            batch.endEpoch,
            batch.endEpoch + additionalEpochs,
            tokenAmount
        );

        _addTokens(tokenAmount, paymaster);
    }

    // ========================================================================
    // Permanent Publishing (Arweave-style endowment)
    // ========================================================================

    uint256 public constant ENDOWMENT_MULTIPLIER = 10;
    uint256 public constant ENDOWMENT_EPOCHS = 100;
    uint256 public constant DECAY_FACTOR_BPS = 9700; // 0.97 in basis points

    /**
     * @notice Publish Knowledge Assets permanently. Cost = annualCost × ENDOWMENT_MULTIPLIER.
     * Tokens are pre-allocated across 100 epochs with geometric decay.
     * After 100 epochs, storage is part of the network's base-layer commitment.
     */
    function batchMintKnowledgeAssetsPermanent(
        uint32 kaCount,
        uint72 publisherNodeIdentityId,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint96 tokenAmount,
        bytes32 publisherNodeR,
        bytes32 publisherNodeVS,
        uint72[] calldata identityIds,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) external returns (uint256 batchId, uint64 startKAId, uint64 endKAId) {
        (startKAId, endKAId) = knowledgeAssetsStorage.reserveUALRange(msg.sender, kaCount);

        _verifySignature(
            publisherNodeIdentityId,
            ECDSA.toEthSignedMessageHash(
                keccak256(abi.encodePacked(publisherNodeIdentityId, merkleRoot))
            ),
            publisherNodeR,
            publisherNodeVS
        );

        _verifyReceiverSignatures(identityIds, merkleRoot, publicByteSize, r, vs);

        KnowledgeAssetsStorage kas = knowledgeAssetsStorage;
        for (uint64 id = startKAId; id <= endKAId; id++) {
            if (kas.isKAIdUsed(msg.sender, id)) {
                revert KnowledgeAssetsLib.KAIdAlreadyUsed(msg.sender, id);
            }
        }

        // Validate permanent publishing cost: annualCost × ENDOWMENT_MULTIPLIER
        uint256 stakeWeightedAverageAsk = askStorage.getStakeWeightedAverageAsk();
        uint96 annualCost = uint96((stakeWeightedAverageAsk * publicByteSize * 12) / 1024); // 12 epochs = 1 year
        uint96 permanentCost = annualCost * uint96(ENDOWMENT_MULTIPLIER);
        if (tokenAmount < permanentCost) {
            revert KnowledgeAssetsLib.InvalidTokenAmount(permanentCost, tokenAmount);
        }

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());

        batchId = kas.createKnowledgeBatch(
            msg.sender,
            merkleRoot,
            publicByteSize,
            kaCount,
            startKAId,
            endKAId,
            currentEpoch,
            currentEpoch + uint40(ENDOWMENT_EPOCHS),
            tokenAmount,
            true // isPermanent
        );

        // Distribute with geometric decay across ENDOWMENT_EPOCHS
        _distributeEndowment(tokenAmount, currentEpoch);

        epochStorage.addEpochProducedKnowledgeValue(
            publisherNodeIdentityId,
            currentEpoch,
            tokenAmount
        );

        _addTokens(tokenAmount, address(0));
    }

    /**
     * @dev Distribute tokens across 100 epochs with 0.97^i decay factor.
     * Early epochs get more, later epochs get less — modeling declining storage costs.
     */
    function _distributeEndowment(uint96 totalAmount, uint40 startEpoch) internal {
        uint256 remaining = totalAmount;
        uint256 weightSum = 0;
        uint256[] memory weights = new uint256[](ENDOWMENT_EPOCHS);

        // Compute geometric weights: weight(i) = 0.97^i scaled to BPS
        weights[0] = 10000; // 1.0 in basis points
        weightSum = 10000;
        for (uint256 i = 1; i < ENDOWMENT_EPOCHS; i++) {
            weights[i] = (weights[i - 1] * DECAY_FACTOR_BPS) / 10000;
            weightSum += weights[i];
        }

        // Allocate proportionally
        for (uint256 i = 0; i < ENDOWMENT_EPOCHS; i++) {
            uint96 epochAmount;
            if (i == ENDOWMENT_EPOCHS - 1) {
                epochAmount = uint96(remaining);
            } else {
                epochAmount = uint96((uint256(totalAmount) * weights[i]) / weightSum);
                if (epochAmount > remaining) epochAmount = uint96(remaining);
                remaining -= epochAmount;
            }

            if (epochAmount > 0) {
                epochStorage.addTokensToEpochRange(
                    1,
                    startEpoch + uint40(i),
                    startEpoch + uint40(i),
                    epochAmount
                );
            }
        }
    }

    // ========================================================================
    // Namespace Transfer
    // ========================================================================

    /**
     * @notice Transfer msg.sender's entire UAL namespace to a new address.
     * All reserved ranges, batch ownership, and future IDs move to the new owner.
     */
    function transferNamespace(address newOwner) external {
        if (newOwner == address(0) || newOwner == msg.sender) {
            revert KnowledgeAssetsLib.NotNamespaceOwner(newOwner, msg.sender);
        }
        knowledgeAssetsStorage.transferNamespace(msg.sender, newOwner);
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    function _mintBatch(
        KnowledgeAssetsLib.PublishParams memory params
    ) internal returns (uint256 batchId) {
        _verifySignature(
            params.publisherNodeIdentityId,
            ECDSA.toEthSignedMessageHash(
                keccak256(abi.encodePacked(params.publisherNodeIdentityId, params.merkleRoot))
            ),
            params.publisherNodeR,
            params.publisherNodeVS
        );

        _verifyReceiverSignatures(
            params.identityIds,
            params.merkleRoot,
            params.publicByteSize,
            params.r,
            params.vs
        );

        KnowledgeAssetsStorage kas = knowledgeAssetsStorage;

        for (uint64 id = params.startKAId; id <= params.endKAId; id++) {
            if (kas.isKAIdUsed(msg.sender, id)) {
                revert KnowledgeAssetsLib.KAIdAlreadyUsed(msg.sender, id);
            }
        }

        uint32 kaCount = uint32(params.endKAId - params.startKAId + 1);
        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());

        if (params.tokenAmount == 0) {
            revert KnowledgeAssetsLib.ZeroTokenAmount();
        }
        _validateTokenAmount(params.publicByteSize, params.epochs, params.tokenAmount);

        batchId = kas.createKnowledgeBatch(
            msg.sender,
            params.merkleRoot,
            params.publicByteSize,
            kaCount,
            params.startKAId,
            params.endKAId,
            currentEpoch,
            currentEpoch + params.epochs,
            params.tokenAmount,
            false
        );

        _distributeTokens(params.tokenAmount, params.epochs, currentEpoch);

        epochStorage.addEpochProducedKnowledgeValue(
            params.publisherNodeIdentityId,
            currentEpoch,
            params.tokenAmount
        );

        _addTokens(params.tokenAmount, params.paymaster);
    }

    function _verifyReceiverSignatures(
        uint72[] memory identityIds,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        bytes32[] memory r,
        bytes32[] memory vs
    ) internal view {
        bytes32 messageHash = ECDSA.toEthSignedMessageHash(
            keccak256(abi.encodePacked(merkleRoot, publicByteSize))
        );
        _verifySignatures(identityIds, messageHash, r, vs);
    }

    function _verifySignatures(
        uint72[] memory identityIds,
        bytes32 messageHash,
        bytes32[] memory r,
        bytes32[] memory vs
    ) internal view {
        if (r.length != identityIds.length || r.length != vs.length) {
            revert KnowledgeAssetsLib.SignaturesSignersMismatch(r.length, vs.length, identityIds.length);
        }

        uint256 minSigs = parametersStorage.minimumRequiredSignatures();

        if (r.length < minSigs) {
            revert KnowledgeAssetsLib.MinSignaturesRequirementNotMet(minSigs, r.length);
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
        bytes32 r,
        bytes32 vs
    ) internal view {
        address signer = ECDSA.tryRecover(messageHash, r, vs);

        if (signer == address(0)) {
            revert KnowledgeAssetsLib.InvalidSignature(identityId, messageHash, r, vs);
        }

        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(signer)),
                IdentityLib.OPERATIONAL_KEY
            )
        ) {
            revert KnowledgeAssetsLib.SignerIsNotNodeOperator(identityId, signer);
        }
    }

    function _validateTokenAmount(
        uint256 byteSize,
        uint256 epochs,
        uint96 tokenAmount
    ) internal view {
        uint256 stakeWeightedAverageAsk = askStorage.getStakeWeightedAverageAsk();
        uint96 expectedTokenAmount = uint96(
            (stakeWeightedAverageAsk * byteSize * epochs) / 1024
        );

        if (tokenAmount < expectedTokenAmount) {
            revert KnowledgeAssetsLib.InvalidTokenAmount(expectedTokenAmount, tokenAmount);
        }
    }

    function _addTokens(uint96 tokenAmount, address paymaster) internal {
        if (tokenAmount == 0) return;

        IERC20 token = tokenContract;

        if (paymaster != address(0) && paymasterManager.validPaymasters(paymaster)) {
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
                revert TokenLib.TooLowBalance(
                    address(token),
                    token.balanceOf(msg.sender),
                    tokenAmount
                );
            }

            if (!token.transferFrom(msg.sender, hub.getContractAddress("StakingStorage"), tokenAmount)) {
                revert TokenLib.TransferFailed();
            }
        }
    }

    function _distributeTokens(
        uint96 tokenAmount,
        uint256 epochs,
        uint40 currentEpoch
    ) internal {
        require(epochs > 0, "epochs must be > 0");

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
