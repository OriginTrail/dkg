// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {ERC1155Delta} from "../tokens/ERC1155Delta.sol";
import {KnowledgeCollectionLib} from "../libraries/KnowledgeCollectionLib.sol";
import {IERC1155DeltaQueryable} from "../interfaces/IERC1155DeltaQueryable.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {HubDependent} from "../abstract/HubDependent.sol";
import {LibBitmap} from "solady/src/utils/LibBitmap.sol";

contract KnowledgeCollectionStorage is
    INamed,
    IVersioned,
    HubDependent,
    IERC1155DeltaQueryable,
    ERC1155Delta,
    Guardian
{
    using LibBitmap for LibBitmap.Bitmap;

    event KnowledgeCollectionCreated(
        uint256 indexed id,
        string publishOperationId,
        bytes32 merkleRoot,
        uint88 byteSize,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isImmutable
    );
    event KnowledgeCollectionUpdated(
        uint256 indexed id,
        string updateOperationId,
        bytes32 merkleRoot,
        uint256 byteSize,
        uint96 tokenAmount
    );
    event KnowledgeAssetsMinted(uint256 indexed id, address indexed to, uint256 startId, uint256 endId);
    event KnowledgeAssetsBurned(uint256 indexed id, address indexed from, uint256[] tokenIds);
    event KnowledgeCollectionPublisherUpdated(uint256 indexed id, address publisher);
    event KnowledgeCollectionMerkleRootsUpdated(uint256 indexed id, KnowledgeCollectionLib.MerkleRoot[] merkleRoots);
    event KnowledgeCollectionMerkleRootAdded(uint256 indexed id, bytes32 merkleRoot);
    event KnowledgeCollectionMerkleRootRemoved(uint256 indexed id, bytes32 merkleRoot);
    event KnowledgeCollectionMintedUpdated(uint256 indexed id, uint256 minted);
    event KnowledgeCollectionBurnedUpdated(uint256 indexed id, uint256[] burned);
    event KnowledgeCollectionByteSizeUpdated(uint256 indexed id, uint256 byteSize);
    event KnowledgeCollectionChunksAmountUpdated(uint256 indexed id, uint256 chunksAmount);
    event KnowledgeCollectionTokenAmountUpdated(uint256 indexed id, uint256 tokenAmount);
    event KnowledgeCollectionStartEpochUpdated(uint256 indexed id, uint256 startEpoch);
    event KnowledgeCollectionEndEpochUpdated(uint256 indexed id, uint256 endEpoch);
    event URIUpdate(string newURI);

    string private constant _NAME = "KnowledgeCollectionStorage";
    string private constant _VERSION = "1.0.0";

    uint256 public immutable KNOWLEDGE_COLLECTION_MAX_SIZE;

    uint256 private _knowledgeCollectionsCounter;
    uint256 private _totalMintedKnowledgeAssetsCounter;
    uint256 private _totalBurnedKnowledgeAssetsCounter;

    uint96 private _totalTokenAmount;

    mapping(uint256 => KnowledgeCollectionLib.KnowledgeCollection) public knowledgeCollections;
    mapping(uint256 => bool) public isKnowledgeAssetBurned;

    constructor(
        address hubAddress,
        uint256 _knowledgeCollectionMaxSize,
        string memory uri
    ) ERC1155Delta(uri) Guardian(hubAddress) {
        KNOWLEDGE_COLLECTION_MAX_SIZE = _knowledgeCollectionMaxSize;
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function knowledgeCollectionMaxSize() external view returns (uint256) {
        return KNOWLEDGE_COLLECTION_MAX_SIZE;
    }

    function createKnowledgeCollection(
        address publisher,
        string calldata publishOperationId,
        bytes32 merkleRoot,
        uint256 knowledgeAssetsAmount,
        uint88 byteSize,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isImmutable
    ) external onlyContracts returns (uint256) {
        uint256 knowledgeCollectionId = ++_knowledgeCollectionsCounter;

        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[knowledgeCollectionId];

        kc.merkleRoots.push(KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp));
        kc.byteSize = byteSize;
        kc.startEpoch = startEpoch;
        kc.endEpoch = endEpoch;
        kc.tokenAmount = tokenAmount;
        kc.isImmutable = isImmutable;

        unchecked {
            _totalTokenAmount += tokenAmount;
        }

        mintKnowledgeAssetsTokens(knowledgeCollectionId, publisher, knowledgeAssetsAmount);

        emit KnowledgeCollectionCreated(
            knowledgeCollectionId,
            publishOperationId,
            merkleRoot,
            byteSize,
            startEpoch,
            endEpoch,
            tokenAmount,
            isImmutable
        );

        return knowledgeCollectionId;
    }

    function getKnowledgeCollection(
        uint256 id
    ) external view returns (KnowledgeCollectionLib.KnowledgeCollection memory) {
        return knowledgeCollections[id];
    }

    function updateKnowledgeCollection(
        address publisher,
        uint256 id,
        string calldata updateOperationId,
        bytes32 merkleRoot,
        uint256 mintKnowledgeAssetsAmount,
        uint256[] calldata knowledgeAssetsToBurn,
        uint88 byteSize,
        uint96 tokenAmount
    ) external onlyContracts {
        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[id];

        unchecked {
            _totalTokenAmount = _totalTokenAmount - kc.tokenAmount + tokenAmount;
        }

        kc.merkleRoots.push(KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp));
        kc.byteSize = byteSize;
        kc.tokenAmount = tokenAmount;

        burnKnowledgeAssetsTokens(id, publisher, knowledgeAssetsToBurn);
        mintKnowledgeAssetsTokens(id, publisher, mintKnowledgeAssetsAmount);

        emit KnowledgeCollectionUpdated(id, updateOperationId, merkleRoot, byteSize, tokenAmount);
    }

    function getKnowledgeCollectionMetadata(
        uint256 id
    )
        external
        view
        returns (
            KnowledgeCollectionLib.MerkleRoot[] memory,
            uint256[] memory,
            uint256,
            uint88,
            uint40,
            uint40,
            uint96,
            bool
        )
    {
        KnowledgeCollectionLib.KnowledgeCollection memory kc = knowledgeCollections[id];

        return (
            kc.merkleRoots,
            kc.burned,
            kc.minted,
            kc.byteSize,
            kc.startEpoch,
            kc.endEpoch,
            kc.tokenAmount,
            kc.isImmutable
        );
    }

    function mintKnowledgeAssetsTokens(uint256 id, address to, uint256 amount) public onlyContracts {
        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[id];

        if (kc.minted + amount > KNOWLEDGE_COLLECTION_MAX_SIZE) {
            revert KnowledgeCollectionLib.ExceededKnowledgeCollectionMaxSize(
                id,
                kc.minted,
                amount,
                KNOWLEDGE_COLLECTION_MAX_SIZE
            );
        }

        uint256 startTokenId = (id - 1) * KNOWLEDGE_COLLECTION_MAX_SIZE + _startTokenId() + kc.minted;
        _setCurrentIndex(startTokenId);

        kc.minted += amount;

        _totalMintedKnowledgeAssetsCounter += amount;

        _mint(to, amount);

        emit KnowledgeAssetsMinted(id, to, startTokenId, startTokenId + amount);
    }

    function burnKnowledgeAssetsTokens(uint256 id, address from, uint256[] calldata tokenIds) public onlyContracts {
        _burnBatch(id, from, tokenIds);

        emit KnowledgeAssetsBurned(id, from, tokenIds);
    }

    function getMerkleRoots(uint256 id) external view returns (KnowledgeCollectionLib.MerkleRoot[] memory) {
        return knowledgeCollections[id].merkleRoots;
    }

    function setMerkleRoots(
        uint256 id,
        KnowledgeCollectionLib.MerkleRoot[] memory _merkleRoots
    ) external onlyContracts {
        knowledgeCollections[id].merkleRoots = _merkleRoots;

        emit KnowledgeCollectionMerkleRootsUpdated(id, _merkleRoots);
    }

    function getMerkleRootObjectByIndex(
        uint256 id,
        uint256 index
    ) external view returns (KnowledgeCollectionLib.MerkleRoot memory) {
        return knowledgeCollections[id].merkleRoots[index];
    }

    function getMerkleRootByIndex(uint256 id, uint256 index) external view returns (bytes32) {
        return knowledgeCollections[id].merkleRoots[index].merkleRoot;
    }

    function getMerkleRootPublisherByIndex(uint256 id, uint256 index) external view returns (address) {
        return knowledgeCollections[id].merkleRoots[index].publisher;
    }

    function getMerkleRootTimestampByIndex(uint256 id, uint256 index) external view returns (uint256) {
        return knowledgeCollections[id].merkleRoots[index].timestamp;
    }

    function getLatestMerkleRootObject(uint256 id) external view returns (KnowledgeCollectionLib.MerkleRoot memory) {
        return _safeGetLatestMerkleRootObject(id);
    }

    function getLatestMerkleRoot(uint256 id) external view returns (bytes32) {
        return _safeGetLatestMerkleRootObject(id).merkleRoot;
    }

    function getLatestMerkleRootPublisher(uint256 id) external view returns (address) {
        return _safeGetLatestMerkleRootObject(id).publisher;
    }

    function getLatestMerkleRootTimestamp(uint256 id) external view returns (uint256) {
        return _safeGetLatestMerkleRootObject(id).timestamp;
    }

    function pushMerkleRoot(address publisher, uint256 id, bytes32 merkleRoot) external onlyContracts {
        knowledgeCollections[id].merkleRoots.push(
            KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );

        emit KnowledgeCollectionMerkleRootAdded(id, merkleRoot);
    }

    function popMerkleRoot(uint256 id) external onlyContracts {
        bytes32 latestMerkleRoot = _safeGetLatestMerkleRootObject(id).merkleRoot;
        knowledgeCollections[id].merkleRoots.pop();

        emit KnowledgeCollectionMerkleRootRemoved(id, latestMerkleRoot);
    }

    function getMinted(uint256 id) external view returns (uint256) {
        return knowledgeCollections[id].minted;
    }

    function setMinted(uint256 id, uint256 _minted) external onlyContracts {
        knowledgeCollections[id].minted = _minted;

        emit KnowledgeCollectionMintedUpdated(id, _minted);
    }

    function getBurned(uint256 id) external view returns (uint256[] memory) {
        return knowledgeCollections[id].burned;
    }

    function getBurnedAmount(uint256 id) external view returns (uint256) {
        return knowledgeCollections[id].burned.length;
    }

    function setBurned(uint256 id, uint256[] calldata _burned) external onlyContracts {
        knowledgeCollections[id].burned = _burned;

        emit KnowledgeCollectionBurnedUpdated(id, _burned);
    }

    function getByteSize(uint256 id) external view returns (uint88) {
        return knowledgeCollections[id].byteSize;
    }

    function setByteSize(uint256 id, uint88 _byteSize) external onlyContracts {
        knowledgeCollections[id].byteSize = _byteSize;

        emit KnowledgeCollectionByteSizeUpdated(id, _byteSize);
    }

    function getTokenAmount(uint256 id) external view returns (uint96) {
        return knowledgeCollections[id].tokenAmount;
    }

    function setTokenAmount(uint256 id, uint96 _tokenAmount) external onlyContracts {
        _totalTokenAmount = _totalTokenAmount - knowledgeCollections[id].tokenAmount + _tokenAmount;
        knowledgeCollections[id].tokenAmount = _tokenAmount;

        emit KnowledgeCollectionTokenAmountUpdated(id, _tokenAmount);
    }

    function getStartEpoch(uint256 id) external view returns (uint40) {
        return knowledgeCollections[id].startEpoch;
    }

    function setStartEpoch(uint256 id, uint40 _startEpoch) external onlyContracts {
        knowledgeCollections[id].startEpoch = _startEpoch;

        emit KnowledgeCollectionStartEpochUpdated(id, _startEpoch);
    }

    function getEndEpoch(uint256 id) external view returns (uint40) {
        return knowledgeCollections[id].endEpoch;
    }

    function setEndEpoch(uint256 id, uint40 _endEpoch) external onlyContracts {
        knowledgeCollections[id].endEpoch = _endEpoch;

        emit KnowledgeCollectionEndEpochUpdated(id, _endEpoch);
    }

    function getLatestKnowledgeCollectionId() external view returns (uint256) {
        return _knowledgeCollectionsCounter;
    }

    function currentTotalSupply() external view returns (uint256) {
        return _totalMintedKnowledgeAssetsCounter - _totalBurnedKnowledgeAssetsCounter;
    }

    function totalMinted() external view returns (uint256) {
        return _totalMintedKnowledgeAssetsCounter;
    }

    function totalBurned() external view returns (uint256) {
        return _totalBurnedKnowledgeAssetsCounter;
    }

    function getTotalTokenAmount() external view returns (uint96) {
        return _totalTokenAmount;
    }

    function isPartOfKnowledgeCollection(uint256 id, uint256 tokenId) external view returns (bool) {
        uint256 startTokenId = (id - 1) * KNOWLEDGE_COLLECTION_MAX_SIZE + _startTokenId();
        return (!isKnowledgeAssetBurned[tokenId] &&
            startTokenId <= tokenId &&
            tokenId < startTokenId + knowledgeCollections[id].minted);
    }

    function getKnowledgeCollectionId(uint256 tokenId) external view returns (uint256) {
        if (tokenId < _startTokenId() || isKnowledgeAssetBurned[tokenId]) {
            return 0;
        }

        return ((tokenId - _startTokenId()) / KNOWLEDGE_COLLECTION_MAX_SIZE) + 1;
    }

    function getKnowledgeAssetsRange(uint256 id) external view returns (uint256, uint256, uint256[] memory) {
        KnowledgeCollectionLib.KnowledgeCollection memory kc = knowledgeCollections[id];
        uint256 startTokenId = (id - 1) * KNOWLEDGE_COLLECTION_MAX_SIZE + _startTokenId();
        uint256 endTokenId = startTokenId + kc.minted - 1;
        return (startTokenId, endTokenId, kc.burned);
    }

    function getKnowledgeAssetsAmount(uint256 id) external view returns (uint256) {
        KnowledgeCollectionLib.KnowledgeCollection memory kc = knowledgeCollections[id];
        return kc.minted - kc.burned.length;
    }

    function isKnowledgeCollectionOwner(address owner, uint256 id) external view returns (bool) {
        uint256 startTokenId = (id - 1) * KNOWLEDGE_COLLECTION_MAX_SIZE + _startTokenId();
        uint256 endTokenId = startTokenId + knowledgeCollections[id].minted;
        for (uint256 i = startTokenId; i < endTokenId; i++) {
            if (isKnowledgeAssetBurned[i]) {
                continue;
            }

            bool isOwner = isOwnerOf(owner, i);

            if (!isOwner) {
                return false;
            }
        }

        return true;
    }

    function balanceOf(address owner) external view virtual override returns (uint256) {
        uint256 latestTokenId = _latestTokenId();
        if (latestTokenId == 0) {
            return 0;
        }
        return balanceOf(owner, _startTokenId(), latestTokenId);
    }

    function balanceOf(address owner, uint256 start, uint256 stop) public view virtual override returns (uint256) {
        return _owned[owner].popCount(start, stop - start);
    }

    function tokensOfOwnerIn(address owner, uint256 start, uint256 stop) public view returns (uint256[] memory) {
        unchecked {
            if (start >= stop) revert InvalidQueryRange();

            // Set `start = max(start, _startTokenId())`.
            if (start < _startTokenId()) {
                start = _startTokenId();
            }

            // Set `stop = min(stop, stopLimit)`.
            uint256 stopLimit = _latestTokenId();
            if (stop > stopLimit) {
                stop = stopLimit;
            }

            uint256 tokenIdsLength;
            if (start < stop) {
                tokenIdsLength = balanceOf(owner, start, stop);
            } else {
                tokenIdsLength = 0;
            }

            uint256[] memory tokenIds = new uint256[](tokenIdsLength);

            LibBitmap.Bitmap storage bmap = _owned[owner];

            for ((uint256 i, uint256 tokenIdsIdx) = (start, 0); tokenIdsIdx != tokenIdsLength; ++i) {
                if (bmap.get(i)) {
                    tokenIds[tokenIdsIdx++] = i;
                }
            }
            return tokenIds;
        }
    }

    function tokensOfOwner(address owner) external view virtual override returns (uint256[] memory) {
        if (_totalMintedKnowledgeAssetsCounter == 0) {
            return new uint256[](0);
        }
        return tokensOfOwnerIn(owner, _startTokenId(), _latestTokenId());
    }

    function setURI(string memory baseURI) external onlyHub {
        _setURI(baseURI);

        emit URIUpdate(baseURI);
    }

    function _latestTokenId() internal view returns (uint256) {
        if (_knowledgeCollectionsCounter == 0) {
            return 0;
        } else {
            return
                (_knowledgeCollectionsCounter - 1) *
                KNOWLEDGE_COLLECTION_MAX_SIZE +
                knowledgeCollections[_knowledgeCollectionsCounter].minted;
        }
    }

    function _setCurrentIndex(uint256 index) internal virtual {
        _currentIndex = index;
    }

    function _safeGetLatestMerkleRootObject(
        uint256 id
    ) internal view returns (KnowledgeCollectionLib.MerkleRoot memory) {
        KnowledgeCollectionLib.KnowledgeCollection memory kc = knowledgeCollections[id];
        if (kc.merkleRoots.length == 0) {
            return KnowledgeCollectionLib.MerkleRoot(address(0), bytes32(0), 0);
        }
        return kc.merkleRoots[kc.merkleRoots.length - 1];
    }

    function _burnBatch(uint256 id, address from, uint256[] calldata tokenIds) internal virtual {
        if (from == address(0)) {
            revert BurnFromZeroAddress();
        }

        address operator = _msgSender();

        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[id];

        uint256 startTokenId = (id - 1) * KNOWLEDGE_COLLECTION_MAX_SIZE + _startTokenId();

        _beforeTokenTransfer(operator, from, address(0), tokenIds);

        uint256[] memory amounts = new uint256[](tokenIds.length);

        unchecked {
            for (uint256 i = 0; i < tokenIds.length; i++) {
                uint256 tokenId = tokenIds[i];

                if (startTokenId <= tokenId && tokenId < startTokenId + kc.minted) {
                    revert KnowledgeCollectionLib.NotPartOfKnowledgeCollection(id, tokenId);
                }

                amounts[i] = 1;
                if (!_owned[from].get(tokenId)) {
                    revert BurnFromNonOnwerAddress();
                }
                _owned[from].unset(tokenId);

                kc.burned.push(tokenId);
            }

            _totalBurnedKnowledgeAssetsCounter += tokenIds.length;
        }

        emit TransferBatch(operator, from, address(0), tokenIds, amounts);

        _afterTokenTransfer(operator, from, address(0), tokenIds);
    }
}
