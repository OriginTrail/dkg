// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {AskStorage} from "./storage/AskStorage.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {PaymasterManager} from "./storage/PaymasterManager.sol";
import {Chronos} from "./storage/Chronos.sol";
import {KnowledgeCollectionStorage} from "./storage/KnowledgeCollectionStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {PublishingConvictionAccount} from "./PublishingConvictionAccount.sol";
import {ContextGraphs} from "./ContextGraphs.sol";
import {KnowledgeAssetsLib} from "./libraries/KnowledgeAssetsLib.sol";
import {ParanetKnowledgeCollectionsRegistry} from "./storage/paranets/ParanetKnowledgeCollectionsRegistry.sol";
import {ParanetKnowledgeMinersRegistry} from "./storage/paranets/ParanetKnowledgeMinersRegistry.sol";
import {ParanetsRegistry} from "./storage/paranets/ParanetsRegistry.sol";
import {KnowledgeCollectionLib} from "./libraries/KnowledgeCollectionLib.sol";
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
 * @title KnowledgeAssetsV10
 * @notice V10 publish contract — evolves V8 KnowledgeCollection with:
 *   - V10 ACK digest: EIP-191(keccak256(abi.encodePacked(contextGraphId, merkleRoot, kaAmount, byteSize, epochs, tokenAmount)))
 *   - Dynamic signature count from ParametersStorage.minimumRequiredSignatures()
 *   - Conviction account payment (PublishingConvictionAccount integration)
 *   - Writes to KnowledgeCollectionStorage for V8 RandomSampling compatibility
 */
contract KnowledgeAssetsV10 is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "KnowledgeAssetsV10";
    string private constant _VERSION = "10.0.0";

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    PaymasterManager public paymasterManager;
    ParanetKnowledgeCollectionsRegistry public paranetKnowledgeCollectionsRegistry;
    ParanetKnowledgeMinersRegistry public paranetKnowledgeMinersRegistry;
    ParanetsRegistry public paranetsRegistry;
    KnowledgeCollectionStorage public knowledgeCollectionStorage;
    Chronos public chronos;
    ShardingTableStorage public shardingTableStorage;
    IERC20 public tokenContract;
    ParametersStorage public parametersStorage;
    IdentityStorage public identityStorage;
    PublishingConvictionAccount public convictionAccount;
    ContextGraphs public contextGraphs;

    // Tracks the original (maximum) byte size paid for at creation time.
    // Updates can shrink below this but never exceed it without additional payment.
    mapping(uint256 => uint88) public originalByteSize;

    error ConvictionAccountNotConfigured();

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        askStorage = AskStorage(hub.getContractAddress("AskStorage"));
        epochStorage = EpochStorage(hub.getContractAddress("EpochStorageV8"));
        paymasterManager = PaymasterManager(hub.getContractAddress("PaymasterManager"));
        paranetKnowledgeCollectionsRegistry = ParanetKnowledgeCollectionsRegistry(
            hub.getContractAddress("ParanetKnowledgeCollectionsRegistry")
        );
        paranetKnowledgeMinersRegistry = ParanetKnowledgeMinersRegistry(
            hub.getContractAddress("ParanetKnowledgeMinersRegistry")
        );
        paranetsRegistry = ParanetsRegistry(hub.getContractAddress("ParanetsRegistry"));
        knowledgeCollectionStorage = KnowledgeCollectionStorage(
            hub.getAssetStorageAddress("KnowledgeCollectionStorage")
        );
        chronos = Chronos(hub.getContractAddress("Chronos"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        tokenContract = IERC20(hub.getContractAddress("Token"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));

        try hub.getContractAddress("PublishingConvictionAccount") returns (address addr) {
            convictionAccount = PublishingConvictionAccount(addr);
        } catch {
            // conviction not yet deployed — convictionAccountId > 0 will revert
        }

        try hub.getContractAddress("ContextGraphs") returns (address addr) {
            contextGraphs = ContextGraphs(addr);
        } catch {
            // ContextGraphs not yet deployed
        }
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // V10 Publish
    // ========================================================================

    /**
     * @notice Publish Knowledge Assets using V10 ACK verification.
     *
     * Core nodes sign: EIP-191(keccak256(abi.encodePacked(contextGraphId, merkleRoot, kaAmount, byteSize, epochs, tokenAmount))).
     * Signature count is read from ParametersStorage.minimumRequiredSignatures().
     * Payment via conviction account (discounted) or market rate (V8 path).
     * Writes to KnowledgeCollectionStorage for V8 RandomSampling compatibility.
     *
     * @param publishOperationId Off-chain correlation ID (emitted in event)
     * @param contextGraphId On-chain context graph ID (used in ACK digest)
     * @param merkleRoot Canonical merkle root of the published triples
     * @param knowledgeAssetsAmount Number of KA tokens to mint
     * @param byteSize Public byte size of the dataset
     * @param epochs Storage duration in epochs
     * @param tokenAmount TRAC payment (base cost before any conviction discount)
     * @param isImmutable If true, this collection cannot be updated
     * @param paymaster Paymaster address (ignored when convictionAccountId > 0)
     * @param convictionAccountId 0 = market rate, N = use conviction account N
     * @param publisherNodeIdentityId Core node identity hosting this data
     * @param publisherNodeR Publisher node signature R
     * @param publisherNodeVS Publisher node signature compact VS
     * @param identityIds ACK signer identity IDs (variable length, >= minimumRequiredSignatures)
     * @param r ACK signature R values
     * @param vs ACK signature compact VS values
     * @return Knowledge collection ID
     */
    function createKnowledgeAssets(
        string calldata publishOperationId,
        uint256 contextGraphId,
        bytes32 merkleRoot,
        uint256 knowledgeAssetsAmount,
        uint88 byteSize,
        uint40 epochs,
        uint96 tokenAmount,
        bool isImmutable,
        address paymaster,
        uint256 convictionAccountId,
        uint72 publisherNodeIdentityId,
        bytes32 publisherNodeR,
        bytes32 publisherNodeVS,
        uint72[] calldata identityIds,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) external returns (uint256) {
        _verifySignature(
            publisherNodeIdentityId,
            ECDSA.toEthSignedMessageHash(
                keccak256(abi.encodePacked(contextGraphId, publisherNodeIdentityId, merkleRoot))
            ),
            publisherNodeR,
            publisherNodeVS
        );

        bytes32 ackDigest = keccak256(abi.encodePacked(
            contextGraphId,
            merkleRoot,
            knowledgeAssetsAmount,
            uint256(byteSize),
            uint256(epochs),
            uint256(tokenAmount)
        ));
        _verifySignatures(identityIds, ECDSA.toEthSignedMessageHash(ackDigest), r, vs);

        if (address(contextGraphs) != address(0) && contextGraphId > 0) {
            // Recover the publisher's wallet from the publisher signature — not msg.sender,
            // because the tx may be submitted by a different operational wallet (round-robin).
            address publisherWallet = ECDSA.recover(
                ECDSA.toEthSignedMessageHash(
                    keccak256(abi.encodePacked(contextGraphId, publisherNodeIdentityId, merkleRoot))
                ),
                publisherNodeR,
                publisherNodeVS
            );
            if (!contextGraphs.isAuthorizedPublisher(contextGraphId, publisherWallet)) {
                revert KnowledgeAssetsLib.UnauthorizedPublisher(contextGraphId, publisherWallet);
            }
        }

        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;
        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());

        uint256 id = kcs.createKnowledgeCollection(
            msg.sender,
            publishOperationId,
            merkleRoot,
            knowledgeAssetsAmount,
            byteSize,
            currentEpoch,
            currentEpoch + epochs,
            tokenAmount,
            isImmutable
        );

        originalByteSize[id] = byteSize;

        _validateTokenAmount(byteSize, epochs, tokenAmount, false);

        uint96 effectiveAmount = tokenAmount;
        if (convictionAccountId > 0) {
            if (address(convictionAccount) == address(0)) {
                revert ConvictionAccountNotConfigured();
            }
            effectiveAmount = convictionAccount.coverPublishingCost(convictionAccountId, tokenAmount, msg.sender);
        } else {
            _addTokens(tokenAmount, paymaster);
        }

        _distributeTokens(effectiveAmount, epochs, currentEpoch);
        epochStorage.addEpochProducedKnowledgeValue(publisherNodeIdentityId, currentEpoch, effectiveAmount);

        return id;
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

        ParanetKnowledgeCollectionsRegistry pkar = paranetKnowledgeCollectionsRegistry;

        bytes32 knowledgeCollectionId = pkar.getParanetId(keccak256(abi.encodePacked(address(kcs), id)));
        if (pkar.isParanetKnowledgeCollection(knowledgeCollectionId)) {
            ParanetKnowledgeMinersRegistry pkmr = paranetKnowledgeMinersRegistry;
            bytes32 paranetId = paranetKnowledgeCollectionsRegistry.getParanetId(knowledgeCollectionId);

            paranetsRegistry.addCumulativeKnowledgeValue(paranetId, tokenAmount);

            pkmr.addCumulativeTracSpent(msg.sender, paranetId, tokenAmount);
            pkmr.addUnrewardedTracSpent(msg.sender, paranetId, tokenAmount);
            pkmr.addTotalTracSpent(msg.sender, tokenAmount);
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

    function _verifySignature(uint72 identityId, bytes32 messageHash, bytes32 _r, bytes32 _vs) internal view {
        address signer = ECDSA.tryRecover(messageHash, _r, _vs);

        if (signer == address(0)) {
            revert KnowledgeCollectionLib.InvalidSignature(identityId, messageHash, _r, _vs);
        }

        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(signer)), IdentityLib.OPERATIONAL_KEY)
        ) {
            revert KnowledgeCollectionLib.SignerIsNotNodeOperator(identityId, signer);
        }

        // Core nodes must be staked (spec §9.0)
        StakingStorage ss = StakingStorage(hub.getContractAddress("StakingStorage"));
        require(ss.getNodeStake(identityId) > 0, "ACK signer has no stake");
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
        uint96 expectedTokenAmount;
        if (includeCurrentEpoch) {
            uint256 totalStorageTime = (epochs * 1e18) + (chron.timeUntilNextEpoch() * 1e18) / chron.epochLength();
            expectedTokenAmount = uint96((stakeWeightedAverageAsk * byteSize * totalStorageTime) / 1024 / 1e18);
        } else {
            expectedTokenAmount = uint96((stakeWeightedAverageAsk * byteSize * epochs) / 1024);
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

            if (!token.transferFrom(msg.sender, address(hub.getContractAddress("StakingStorage")), tokenAmount)) {
                revert TokenLib.TransferFailed();
            }
        }
    }

    // ========================================================================
    // V10 Update (works with KnowledgeCollectionStorage, not V9 KnowledgeAssetsStorage)
    // ========================================================================

    /**
     * @notice Update an existing knowledge collection. Only the latest publisher
     *         (the address that pushed the most recent merkle root) may call this.
     *
     * NOTE: This function currently does not charge an update fee. The V9 update
     * fee model (10% + excess-byte cost) is tightly coupled to V9 epoch/reward
     * accounting. A V10-native fee model will be added before mainnet launch.
     *
     * @param id Knowledge collection ID (from createKnowledgeAssets)
     * @param newMerkleRoot New merkle root for the updated data
     * @param newByteSize Updated byte size (must not exceed original)
     * @param mintAmount Number of new KA tokens to mint (0 if unchanged)
     * @param burnTokenIds Token IDs to burn (empty if unchanged)
     */
    function updateKnowledgeCollection(
        uint256 id,
        bytes32 newMerkleRoot,
        uint88 newByteSize,
        uint256 mintAmount,
        uint256[] calldata burnTokenIds
    ) external {
        KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;

        address latestPublisher = kcs.getLatestMerkleRootPublisher(id);
        require(latestPublisher != address(0), "Knowledge collection does not exist");
        if (latestPublisher != msg.sender) {
            revert KnowledgeAssetsLib.NotBatchPublisher(id, msg.sender);
        }

        (, , , uint88 oldByteSize, , uint40 endEpoch, uint96 existingTokenAmount, bool isImmutable) =
            kcs.getKnowledgeCollectionMetadata(id);

        if (isImmutable) {
            revert KnowledgeCollectionLib.CannotUpdateImmutableKnowledgeCollection(id);
        }

        uint256 currentEpoch = chronos.getCurrentEpoch();
        if (currentEpoch > endEpoch) {
            revert KnowledgeCollectionLib.KnowledgeCollectionExpired(id, currentEpoch, endEpoch);
        }

        uint88 ceiling = originalByteSize[id];
        if (ceiling == 0) ceiling = oldByteSize; // Fallback for pre-tracking collections
        require(newByteSize <= ceiling, "Cannot increase byte size without additional payment");

        kcs.updateKnowledgeCollection(
            msg.sender,
            id,
            "",
            newMerkleRoot,
            mintAmount,
            burnTokenIds,
            newByteSize,
            existingTokenAmount
        );
    }

    // ========================================================================
    // Internal: Token Distribution
    // ========================================================================

    function _distributeTokens(uint96 tokenAmount, uint256 epochs, uint40 currentEpoch) internal {
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
