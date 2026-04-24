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

contract KnowledgeCollection is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "KnowledgeCollection";
    string private constant _VERSION = "1.1.0";

    AskStorage public askStorage;
    EpochStorage public epochStorage;
    PaymasterManager public paymasterManager;
    KnowledgeCollectionStorage public knowledgeCollectionStorage;
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
        knowledgeCollectionStorage = KnowledgeCollectionStorage(
            hub.getAssetStorageAddress("KnowledgeCollectionStorage")
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

    function createKnowledgeCollection(
        string calldata publishOperationId,
        bytes32 merkleRoot,
        uint256 knowledgeAssetsAmount,
        uint88 byteSize,
        uint40 epochs,
        uint96 tokenAmount,
        bool isImmutable,
        address paymaster,
        uint72 publisherNodeIdentityId,
        bytes32 publisherNodeR,
        bytes32 publisherNodeVS,
        uint72[] calldata identityIds,
        bytes32[] calldata r,
        bytes32[] calldata vs
    ) external returns (uint256) {
        _verifySignature(
            publisherNodeIdentityId,
            ECDSA.toEthSignedMessageHash(keccak256(abi.encodePacked(publisherNodeIdentityId, merkleRoot))),
            publisherNodeR,
            publisherNodeVS
        );

        _verifySignatures(identityIds, ECDSA.toEthSignedMessageHash(merkleRoot), r, vs);

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

        // Validate that the provided token amount is sufficient
        // false argument suggests that the user who published the KC pays for the number of epochs
        _validateTokenAmount(byteSize, epochs, tokenAmount, false);

        // Distribute time-weight tokenAmount across current, full, and final fractional epochs
        _distributeTokens(tokenAmount, epochs, currentEpoch);

        // Record the knowledge value produced by the publisher in the current epoch
        epochStorage.addEpochProducedKnowledgeValue(publisherNodeIdentityId, currentEpoch, tokenAmount);

        _addTokens(tokenAmount, paymaster);

        return id;
    }

    // function updateKnowledgeCollection(
    //     uint256 id,
    //     string calldata updateOperationId,
    //     bytes32 merkleRoot,
    //     uint256 mintKnowledgeAssetsAmount,
    //     uint256[] calldata knowledgeAssetsToBurn,
    //     uint88 byteSize,
    //     uint96 tokenAmount,
    //     address paymaster,
    //     uint72 publisherNodeIdentityId,
    //     bytes32 publisherNodeR,
    //     bytes32 publisherNodeVS,
    //     uint72[] calldata identityIds,
    //     bytes32[] calldata r,
    //     bytes32[] calldata vs
    // ) external {
    //     KnowledgeCollectionStorage kcs = knowledgeCollectionStorage;
    //     EpochStorage es = epochStorage;

    //     (, , , uint88 oldByteSize, , uint40 endEpoch, uint96 oldTokenAmount, bool isImmutable) = kcs
    //         .getKnowledgeCollectionMetadata(id);

    //     if (isImmutable) {
    //         revert KnowledgeCollectionLib.CannotUpdateImmutableKnowledgeCollection(id);
    //     }

    //     _verifySignature(
    //         publisherNodeIdentityId,
    //         ECDSA.toEthSignedMessageHash(keccak256(abi.encodePacked(publisherNodeIdentityId, merkleRoot))),
    //         publisherNodeR,
    //         publisherNodeVS
    //     );

    //     _verifySignatures(identityIds, ECDSA.toEthSignedMessageHash(merkleRoot), r, vs);

    //     uint256 currentEpoch = chronos.getCurrentEpoch();
    //     if (currentEpoch > endEpoch) {
    //         revert KnowledgeCollectionLib.KnowledgeCollectionExpired(id, currentEpoch, endEpoch);
    //     }

    //     kcs.updateKnowledgeCollection(
    //         msg.sender,
    //         id,
    //         updateOperationId,
    //         merkleRoot,
    //         mintKnowledgeAssetsAmount,
    //         knowledgeAssetsToBurn,
    //         oldByteSize + byteSize,
    //         oldTokenAmount + tokenAmount
    //     );

    //     _validateTokenAmount(byteSize - oldByteSize, endEpoch - currentEpoch, tokenAmount, true);

    //     es.addTokensToEpochRange(1, currentEpoch, endEpoch, tokenAmount);
    //     es.addEpochProducedKnowledgeValue(publisherNodeIdentityId, currentEpoch, tokenAmount);

    //     _addTokens(tokenAmount, paymaster);
    // }

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
    }

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

    function _verifySignature(uint72 identityId, bytes32 messageHash, bytes32 r, bytes32 vs) internal view {
        address signer = ECDSA.tryRecover(messageHash, r, vs);

        if (signer == address(0)) {
            revert KnowledgeCollectionLib.InvalidSignature(identityId, messageHash, r, vs);
        }

        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(signer)), IdentityLib.OPERATIONAL_KEY)
        ) {
            revert KnowledgeCollectionLib.SignerIsNotNodeOperator(identityId, signer);
        }
    }

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

    /**
     * @dev Distributes tokens across epochs using time-weighted allocation
     * Allocates tokens proportionally based on time remaining in current epoch and distributes
     * the remainder across full epochs and final fractional epoch
     * @param tokenAmount Total amount of tokens to distribute across epochs
     * @param epochs Number of epochs to distribute tokens over
     * @param currentEpoch The current epoch number where distribution starts
     */
    function _distributeTokens(uint96 tokenAmount, uint256 epochs, uint40 currentEpoch) internal {
        require(epochs > 0, "epochs must be > 0");

        uint256 epochLengthInSeconds = chronos.epochLength();
        uint256 timeRemainingInCurrentEpoch = chronos.timeUntilNextEpoch(); // seconds remaining in current epoch
        uint256 baseTokensPerFullEpoch = tokenAmount / epochs; // nominal amount for a full epoch
        uint256 currentEpochAllocation = (baseTokensPerFullEpoch * timeRemainingInCurrentEpoch) / epochLengthInSeconds;
        uint256 finalEpochAllocation = baseTokensPerFullEpoch - currentEpochAllocation; // goes to the final fractional epoch
        uint256 numberOfFullEpochs = epochs - 1; // number of full middle epochs
        uint256 totalTokensForFullEpochs = baseTokensPerFullEpoch * numberOfFullEpochs;

        // Add any rounding remainder to the final epoch so total == tokenAmount
        uint256 totalAllocated = currentEpochAllocation + totalTokensForFullEpochs + finalEpochAllocation;
        if (totalAllocated < tokenAmount) {
            finalEpochAllocation += tokenAmount - totalAllocated;
        }

        // 1) Current (fractional) epoch
        if (currentEpochAllocation > 0) {
            epochStorage.addTokensToEpochRange(1, currentEpoch, currentEpoch, uint96(currentEpochAllocation));
        }

        // 2) Full epochs between current and final
        if (numberOfFullEpochs > 0 && totalTokensForFullEpochs > 0) {
            epochStorage.addTokensToEpochRange(
                1,
                currentEpoch + 1,
                currentEpoch + uint40(numberOfFullEpochs),
                uint96(totalTokensForFullEpochs)
            );
        }

        // 3) Final (fractional) epoch
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
