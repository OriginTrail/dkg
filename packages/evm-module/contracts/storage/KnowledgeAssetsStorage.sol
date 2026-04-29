// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {ERC1155Delta} from "../tokens/ERC1155Delta.sol";
import {IERC1155DeltaQueryable} from "../interfaces/IERC1155DeltaQueryable.sol";
import {KnowledgeAssetsLib} from "../libraries/KnowledgeAssetsLib.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {LibBitmap} from "solady/src/utils/LibBitmap.sol";
import {HubLib} from "../libraries/HubLib.sol";

/**
 * @title KnowledgeAssetsStorage
 * @notice V9 storage contract for Knowledge Assets with address-based publisher namespaces.
 * Mints one ERC1155 token per Knowledge Asset (like V8 KnowledgeCollectionStorage).
 *
 * UAL format: did:dkg:{chainId}/{publisherAddress}/{localKAId}
 *
 * Any address can reserve ID ranges and batch-mint KAs — no on-chain identity required.
 * The legacy KnowledgeCollectionStorage remains read-only for V8 data.
 */
contract KnowledgeAssetsStorage is INamed, IVersioned, IERC1155DeltaQueryable, ERC1155Delta, Guardian {
    using LibBitmap for LibBitmap.Bitmap;

    /// @notice Max KAs per batch; token IDs are (batchId - 1) * V9_KA_MAX_PER_BATCH + offset
    uint256 public constant V9_KA_MAX_PER_BATCH = 1e12;
    event UALRangeReserved(
        address indexed publisher,
        uint64 startId,
        uint64 endId
    );

    event KnowledgeBatchCreated(
        uint256 indexed batchId,
        address indexed publisher,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint32 knowledgeAssetsCount,
        uint64 startKAId,
        uint64 endKAId,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isPermanent
    );

    /// @notice `KnowledgeBatchCreated` is the V8/V9 batch-creation signal
    /// and legacy indexers subscribe to its topic under the assumption
    /// that `knowledgeBatches[batchId]`,
    /// `kaIdToBatch[publisher][id]`, `getBatchPublisher(batchId)`, and
    /// `_totalTokenAmount` / `_totalKnowledgeAssets` were also mutated.
    /// V10 publishes go through `KnowledgeCollectionStorage`, NOT this
    /// contract, so reusing `KnowledgeBatchCreated` for a V10 shim emit
    /// would tell legacy indexers "a batch exists" while every legacy
    /// getter returns zero/default data or `BatchNotFound` — a silent
    /// data-integrity bug. The V10 emit-shim now uses a dedicated event
    /// with the SAME payload shape but a DISTINCT topic hash so legacy
    /// indexers ignore it, and V10-aware consumers that want the legacy-
    /// shaped projection can subscribe to this event explicitly. The
    /// payload intentionally mirrors `KnowledgeBatchCreated` so v10
    /// adapters can share the decoding path — only the topic differs.
    event V10KnowledgeBatchEmitted(
        uint256 indexed batchId,
        address indexed publisher,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint32 knowledgeAssetsCount,
        uint64 startKAId,
        uint64 endKAId,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isPermanent
    );

    event KnowledgeBatchUpdated(
        uint256 indexed batchId,
        bytes32 newMerkleRoot,
        uint64 newPublicByteSize,
        uint96 updateCost
    );

    event StorageExtended(
        uint256 indexed batchId,
        uint40 additionalEpochs,
        uint40 newEndEpoch,
        uint96 additionalTokens
    );

    event NamespaceTransferred(
        address indexed from,
        address indexed to
    );

    string private constant _NAME = "KnowledgeAssetsStorage";
    string private constant _VERSION = "2.0.0";

    // --- Publisher Namespace State (keyed by address) ---

    mapping(address => KnowledgeAssetsLib.PublisherRange[]) public publisherRanges;
    mapping(address => uint64) public publisherNextId;

    // --- Knowledge Batch State ---

    uint256 private _batchCounter;
    mapping(uint256 => KnowledgeAssetsLib.KnowledgeBatch) public knowledgeBatches;

    // publisher address => localKAId => batchId (0 = unused)
    mapping(address => mapping(uint64 => uint256)) public kaIdToBatch;

    // --- Aggregate Counters ---

    uint96 private _totalTokenAmount;
    uint256 private _totalKnowledgeAssets;

    event KnowledgeAssetsMinted(uint256 indexed batchId, address indexed to, uint256 startTokenId, uint256 endTokenId);
    event URIUpdate(string newURI);

    constructor(address hubAddress, string memory uri) ERC1155Delta(uri) Guardian(hubAddress) {}

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // --- Publisher Namespace ---

    function reserveUALRange(
        address publisher,
        uint32 count
    ) external onlyContracts returns (uint64 startId, uint64 endId) {
        uint64 nextId = publisherNextId[publisher];
        if (nextId == 0) {
            nextId = 1;
        }

        startId = nextId;
        endId = nextId + uint64(count) - 1;

        publisherRanges[publisher].push(
            KnowledgeAssetsLib.PublisherRange(startId, endId)
        );
        publisherNextId[publisher] = endId + 1;

        emit UALRangeReserved(publisher, startId, endId);
    }

    function isIdInReservedRange(
        address publisher,
        uint64 kaId
    ) external view returns (bool) {
        KnowledgeAssetsLib.PublisherRange[] storage ranges = publisherRanges[publisher];
        for (uint256 i; i < ranges.length; i++) {
            if (kaId >= ranges[i].startId && kaId <= ranges[i].endId) {
                return true;
            }
        }
        return false;
    }

    function getPublisherRangesCount(address publisher) external view returns (uint256) {
        return publisherRanges[publisher].length;
    }

    function getPublisherRange(
        address publisher,
        uint256 index
    ) external view returns (uint64 startId, uint64 endId) {
        KnowledgeAssetsLib.PublisherRange storage r = publisherRanges[publisher][index];
        return (r.startId, r.endId);
    }

    /// @notice Spec §07_EVM_MODULE — V10 publish surfaces a
    /// batch-shaped audit record from this contract's address so
    /// V10-aware consumers that want a legacy-shaped projection
    /// can subscribe to it without having to join
    /// `KnowledgeCollectionCreated` + `KnowledgeAssetsMinted`. The
    /// event was renamed from `KnowledgeBatchCreated` to
    /// `V10KnowledgeBatchEmitted` so legacy V8/V9 indexers — which call
    /// `getBatchPublisher(batchId)` and expect `knowledgeBatches[batchId]`
    /// / `kaIdToBatch` to be populated — do not mistake a V10 shim emit
    /// for a real V8/V9 batch. This function performs no state mutation,
    /// no minting, and no counter advance: the V10 source of truth lives
    /// in `KnowledgeCollectionStorage`. KAV10 calls it from
    /// `_executePublishCore` after the KCS create succeeds.
    function emitV10KnowledgeBatchCreated(
        uint256 batchId,
        address publisherAddress,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint32 knowledgeAssetsCount,
        uint64 startKAId,
        uint64 endKAId,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isPermanent
    ) external {
        // `onlyContracts` allows every Hub-registered contract to emit
        // `V10KnowledgeBatchEmitted` — a buggy or compromised registered
        // contract could then forge batch-audit events that look like
        // real V10 publishes, and indexers have no state change in this
        // contract to cross-check. Lock the caller to the one contract
        // that owns the V10 publish pipeline: `KnowledgeAssetsV10`.
        //
        // The earlier revision kept `hub.owner()` as a break-glass on
        // the emitter itself, but this contract stores no state that
        // indexers can reconcile against the audit event — a single
        // owner call could forge an arbitrary `V10KnowledgeBatchEmitted`
        // that downstream tooling treats as a real V10 publish. We
        // remove the owner bypass so the audit event is now strictly
        // 1:1 with `KnowledgeAssetsV10`-driven publishes. Operators
        // who need to emit a synthetic record (migrations, recovery,
        // index rebuilds) must do so via a separate admin-only
        // pipeline that emits a DISTINCT event — not by laundering
        // the call through the production audit channel.
        address v10 = hub.getContractAddress("KnowledgeAssetsV10");
        if (msg.sender != v10) {
            revert HubLib.UnauthorizedAccess("Only KnowledgeAssetsV10");
        }
        emit V10KnowledgeBatchEmitted(
            batchId,
            publisherAddress,
            merkleRoot,
            publicByteSize,
            knowledgeAssetsCount,
            startKAId,
            endKAId,
            startEpoch,
            endEpoch,
            tokenAmount,
            isPermanent
        );
    }

    // --- Knowledge Batch CRUD ---

    function createKnowledgeBatch(
        address publisherAddress,
        bytes32 merkleRoot,
        uint64 publicByteSize,
        uint32 knowledgeAssetsCount,
        uint64 startKAId,
        uint64 endKAId,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isPermanent
    ) external onlyContracts returns (uint256 batchId) {
        batchId = ++_batchCounter;

        knowledgeBatches[batchId] = KnowledgeAssetsLib.KnowledgeBatch({
            publisherAddress: publisherAddress,
            merkleRoot: merkleRoot,
            publicByteSize: publicByteSize,
            knowledgeAssetsCount: knowledgeAssetsCount,
            startKAId: startKAId,
            endKAId: endKAId,
            startEpoch: startEpoch,
            endEpoch: endEpoch,
            tokenAmount: tokenAmount,
            isPermanent: isPermanent,
            createdAt: block.timestamp
        });

        for (uint64 id = startKAId; id <= endKAId; id++) {
            kaIdToBatch[publisherAddress][id] = batchId;
        }

        unchecked {
            _totalTokenAmount += tokenAmount;
            _totalKnowledgeAssets += knowledgeAssetsCount;
        }

        emit KnowledgeBatchCreated(
            batchId,
            publisherAddress,
            merkleRoot,
            publicByteSize,
            knowledgeAssetsCount,
            startKAId,
            endKAId,
            startEpoch,
            endEpoch,
            tokenAmount,
            isPermanent
        );

        _mintKnowledgeAssetsTokens(publisherAddress, batchId, startKAId, endKAId);
    }

    function _mintKnowledgeAssetsTokens(
        address publisher,
        uint256 batchId,
        uint64 startKAId,
        uint64 endKAId
    ) internal {
        uint32 kaCount = uint32(endKAId - startKAId + 1);
        uint256 startTokenId = (batchId - 1) * V9_KA_MAX_PER_BATCH + _startTokenId();
        _setCurrentIndex(startTokenId);
        _mint(publisher, kaCount);
        emit KnowledgeAssetsMinted(batchId, publisher, startTokenId, startTokenId + kaCount - 1);
    }

    function _setCurrentIndex(uint256 index) internal virtual {
        _currentIndex = index;
    }

    function _latestTokenId() internal view returns (uint256) {
        if (_batchCounter == 0) return 0;
        KnowledgeAssetsLib.KnowledgeBatch storage b = knowledgeBatches[_batchCounter];
        return ((_batchCounter - 1) * V9_KA_MAX_PER_BATCH + _startTokenId() + b.knowledgeAssetsCount) - 1;
    }

    function updateKnowledgeBatch(
        uint256 batchId,
        bytes32 newMerkleRoot,
        uint64 newPublicByteSize,
        uint96 updateCost
    ) external onlyContracts {
        KnowledgeAssetsLib.KnowledgeBatch storage batch = knowledgeBatches[batchId];

        batch.merkleRoot = newMerkleRoot;
        batch.publicByteSize = newPublicByteSize;

        unchecked {
            _totalTokenAmount += updateCost;
            batch.tokenAmount += updateCost;
        }

        emit KnowledgeBatchUpdated(batchId, newMerkleRoot, newPublicByteSize, updateCost);
    }

    function extendBatchStorage(
        uint256 batchId,
        uint40 additionalEpochs,
        uint96 additionalTokens
    ) external onlyContracts {
        KnowledgeAssetsLib.KnowledgeBatch storage batch = knowledgeBatches[batchId];

        batch.endEpoch += additionalEpochs;

        unchecked {
            _totalTokenAmount += additionalTokens;
            batch.tokenAmount += additionalTokens;
        }

        emit StorageExtended(batchId, additionalEpochs, batch.endEpoch, additionalTokens);
    }

    // --- Namespace Transfer ---

    /**
     * @notice Transfer an entire publisher namespace (ranges, nextId, batch ownership)
     * from one address to another. Only callable by Hub-registered contracts.
     */
    function transferNamespace(address from, address to) external onlyContracts {
        if (publisherNextId[to] != 0 || publisherRanges[to].length != 0) {
            revert KnowledgeAssetsLib.NamespaceAlreadyExists(to);
        }

        // Transfer reserved ranges
        KnowledgeAssetsLib.PublisherRange[] storage fromRanges = publisherRanges[from];
        for (uint256 i; i < fromRanges.length; i++) {
            publisherRanges[to].push(fromRanges[i]);
        }
        delete publisherRanges[from];

        // Transfer nextId counter
        publisherNextId[to] = publisherNextId[from];
        delete publisherNextId[from];

        // Transfer kaIdToBatch mappings — iterate over all ranges and remap
        KnowledgeAssetsLib.PublisherRange[] storage toRanges = publisherRanges[to];
        for (uint256 i; i < toRanges.length; i++) {
            for (uint64 id = toRanges[i].startId; id <= toRanges[i].endId; id++) {
                uint256 bid = kaIdToBatch[from][id];
                if (bid != 0) {
                    kaIdToBatch[to][id] = bid;
                    delete kaIdToBatch[from][id];

                    // Update batch publisher address
                    knowledgeBatches[bid].publisherAddress = to;
                }
            }
        }

        emit NamespaceTransferred(from, to);
    }

    // --- Getters ---

    function getBatch(uint256 batchId) external view returns (KnowledgeAssetsLib.KnowledgeBatch memory) {
        return knowledgeBatches[batchId];
    }

    function getBatchMerkleRoot(uint256 batchId) external view returns (bytes32) {
        return knowledgeBatches[batchId].merkleRoot;
    }

    function getBatchPublisher(uint256 batchId) external view returns (address) {
        return knowledgeBatches[batchId].publisherAddress;
    }

    function getBatchEpochs(uint256 batchId) external view returns (uint40 startEpoch, uint40 endEpoch) {
        KnowledgeAssetsLib.KnowledgeBatch storage b = knowledgeBatches[batchId];
        return (b.startEpoch, b.endEpoch);
    }

    function getLatestBatchId() external view returns (uint256) {
        return _batchCounter;
    }

    function getTotalTokenAmount() external view returns (uint96) {
        return _totalTokenAmount;
    }

    function getTotalKnowledgeAssets() external view returns (uint256) {
        return _totalKnowledgeAssets;
    }

    function isKAIdUsed(address publisher, uint64 kaId) external view returns (bool) {
        return kaIdToBatch[publisher][kaId] != 0;
    }

    function getBatchForKAId(address publisher, uint64 kaId) external view returns (uint256) {
        return kaIdToBatch[publisher][kaId];
    }

    function getBatchIdForTokenId(uint256 tokenId) external view returns (uint256) {
        if (tokenId < _startTokenId()) return 0;
        return ((tokenId - _startTokenId()) / V9_KA_MAX_PER_BATCH) + 1;
    }

    function isPartOfBatch(uint256 batchId, uint256 tokenId) external view returns (bool) {
        KnowledgeAssetsLib.KnowledgeBatch storage b = knowledgeBatches[batchId];
        if (b.publisherAddress == address(0)) return false;
        uint256 startTokenId = (batchId - 1) * V9_KA_MAX_PER_BATCH + _startTokenId();
        return tokenId >= startTokenId && tokenId < startTokenId + b.knowledgeAssetsCount;
    }

    function getKnowledgeAssetsRange(uint256 batchId) external view returns (uint256 startTokenId, uint256 endTokenId) {
        KnowledgeAssetsLib.KnowledgeBatch storage b = knowledgeBatches[batchId];
        startTokenId = (batchId - 1) * V9_KA_MAX_PER_BATCH + _startTokenId();
        endTokenId = startTokenId + b.knowledgeAssetsCount - 1;
    }

    function balanceOf(address owner) external view virtual override returns (uint256) {
        uint256 latest = _latestTokenId();
        if (latest == 0) return 0;
        return balanceOf(owner, _startTokenId(), latest + 1);
    }

    function balanceOf(address owner, uint256 start, uint256 stop) public view virtual override returns (uint256) {
        return _owned[owner].popCount(start, stop - start);
    }

    function tokensOfOwnerIn(address owner, uint256 start, uint256 stop) public view returns (uint256[] memory) {
        unchecked {
            if (start >= stop) revert InvalidQueryRange();
            if (start < _startTokenId()) start = _startTokenId();
            uint256 stopLimit = _latestTokenId() + 1;
            if (stop > stopLimit) stop = stopLimit;
            uint256 tokenIdsLength = start < stop ? balanceOf(owner, start, stop) : 0;
            uint256[] memory tokenIds = new uint256[](tokenIdsLength);
            LibBitmap.Bitmap storage bmap = _owned[owner];
            uint256 tokenIdsIdx;
            for (uint256 i = start; tokenIdsIdx != tokenIdsLength; ++i) {
                if (bmap.get(i)) tokenIds[tokenIdsIdx++] = i;
            }
            return tokenIds;
        }
    }

    function tokensOfOwner(address owner) external view virtual override returns (uint256[] memory) {
        if (_totalKnowledgeAssets == 0) return new uint256[](0);
        return tokensOfOwnerIn(owner, _startTokenId(), _latestTokenId() + 1);
    }

    function setURI(string memory baseURI) external onlyHub {
        _setURI(baseURI);
        emit URIUpdate(baseURI);
    }
}
