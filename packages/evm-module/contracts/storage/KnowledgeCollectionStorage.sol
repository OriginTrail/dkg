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

    /// @dev `author` is the verified agent identity from the V10.1+
    ///      author-attestation EIP-712 envelope, or `address(0)` for legacy
    ///      callers (`KnowledgeCollection.sol`) that do not perform author
    ///      attestation. Indexers SHOULD prefer this `indexed` field over
    ///      walking storage when filtering KCs by author.
    event KnowledgeCollectionCreated(
        uint256 indexed id,
        address indexed author,
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
        address indexed author,
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

    /// @dev Parallel mapping for V10.1+ author attestation.
    ///
    /// Why a parallel map and not a struct field on `MerkleRoot`:
    /// `KnowledgeCollection.merkleRoots` is a dynamic array, so
    /// extending its element struct from 3 to 4 storage slots would
    /// shift the slot stride of every prior root entry — already-
    /// deployed KCs would decode their historical
    /// `publisher`/`merkleRoot`/`timestamp` from the wrong offsets.
    /// Layout-preserving fix: keep `MerkleRoot` at 3 slots and store
    /// the EIP-712-recovered author identity at
    /// `merkleRootAuthors[kcId][rootIndex]`. `address(0)` means the
    /// state change at `rootIndex` did not carry an attestation
    /// (legacy V8/V9 mutations, V10.1 update path until vNext, etc).
    /// Indexers SHOULD prefer the indexed `author` topic on
    /// `KnowledgeCollectionCreated` / `KnowledgeCollectionUpdated`
    /// events; this on-chain mapping is the canonical lookup for
    /// `/api/kc/:id/author` and SPARQL author-filter queries.
    mapping(uint256 => mapping(uint256 => address)) public merkleRootAuthors;

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
        address author,
        string calldata publishOperationId,
        bytes32 merkleRoot,
        uint256 knowledgeAssetsAmount,
        uint88 byteSize,
        uint40 startEpoch,
        uint40 endEpoch,
        uint96 tokenAmount,
        bool isImmutable,
        uint32 merkleLeafCount
    ) external onlyContracts returns (uint256) {
        uint256 knowledgeCollectionId = ++_knowledgeCollectionsCounter;

        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[knowledgeCollectionId];

        kc.merkleRoots.push(
            KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // Unconditional write to overwrite any value at this slot.
        // For `createKnowledgeCollection` the kcId is freshly minted so
        // the slot is guaranteed empty; the unconditional shape is kept
        // for parity with `updateKnowledgeCollection` below, where the
        // index can have been previously used (post-pop).
        merkleRootAuthors[knowledgeCollectionId][kc.merkleRoots.length - 1] = author;
        kc.byteSize = byteSize;
        kc.startEpoch = startEpoch;
        kc.endEpoch = endEpoch;
        kc.tokenAmount = tokenAmount;
        kc.isImmutable = isImmutable;
        kc.merkleLeafCount = merkleLeafCount;

        unchecked {
            _totalTokenAmount += tokenAmount;
        }

        mintKnowledgeAssetsTokens(knowledgeCollectionId, publisher, knowledgeAssetsAmount);

        emit KnowledgeCollectionCreated(
            knowledgeCollectionId,
            author,
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

    /// @dev `author` is the verified author identity for this update or
    ///      `address(0)` when the update path doesn't carry an attestation
    ///      (current V10.1 update path emits zero; vNext will sign updates
    ///      against the same EIP-712 envelope as publish).
    function updateKnowledgeCollection(
        address publisher,
        address author,
        uint256 id,
        string calldata updateOperationId,
        bytes32 merkleRoot,
        uint256 mintKnowledgeAssetsAmount,
        uint256[] calldata knowledgeAssetsToBurn,
        uint88 byteSize,
        uint96 tokenAmount,
        uint32 merkleLeafCount
    ) external onlyContracts {
        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[id];

        unchecked {
            _totalTokenAmount = _totalTokenAmount - kc.tokenAmount + tokenAmount;
        }

        kc.merkleRoots.push(
            KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // Unconditional overwrite — this index may have been written by
        // a previous create/update and then popped via `popMerkleRoot`,
        // leaving the stale author in the parallel slot. Always write
        // the current `author` (which is `address(0)` for the V10.1
        // update path that doesn't yet sign updates) to make the
        // canonical mapping monotonic with the merkleRoots array.
        merkleRootAuthors[id][kc.merkleRoots.length - 1] = author;
        kc.byteSize = byteSize;
        kc.tokenAmount = tokenAmount;
        kc.merkleLeafCount = merkleLeafCount;

        // Burn with an empty list is a no-op (the inner for-loop over
        // tokenIds skips when length == 0). Mint with amount == 0 was
        // previously unconditionally dispatched to `_mintWithoutCheck`,
        // which reverts `MintZeroQuantity` on zero — blocking true
        // metadata-only updates (delta == 0, no mint, no burn) that the
        // KnowledgeAssetsV10 update flow explicitly documents as
        // supported. Guard the mint call so metadata-only rotations work
        // end-to-end. See Codex review round 2, finding 6.
        burnKnowledgeAssetsTokens(id, publisher, knowledgeAssetsToBurn);
        if (mintKnowledgeAssetsAmount > 0) {
            mintKnowledgeAssetsTokens(id, publisher, mintKnowledgeAssetsAmount);
        }

        emit KnowledgeCollectionUpdated(id, author, updateOperationId, merkleRoot, byteSize, tokenAmount);
    }

    /// @notice Lightweight update-path metadata — scalar fields only + the
    /// pre-update merkle-root count. Intended for callers (e.g.
    /// `KnowledgeAssetsV10._executeUpdateCore`) that need the state
    /// summary but NOT the full history arrays.
    ///
    /// Problem: `getKnowledgeCollectionMetadata` performs a full
    /// storage → memory struct copy, which walks every entry of
    /// `merkleRoots[]` and `burned[]`. Because both arrays grow
    /// monotonically on every update, the memory cost (and thus gas
    /// cost) of calling that getter from the update path itself scales
    /// linearly — actually super-linearly due to EVM memory-expansion
    /// quadratic term — with the number of prior updates. A KC with
    /// thousands of historical entries eventually becomes un-updatable.
    ///
    /// This getter returns only the scalar slots and the merkle-root
    /// chain length (as a plain `uint256`), so the update path's gas
    /// cost is constant regardless of history.
    ///
    /// Codex review round 3 finding 1.
    function getKnowledgeCollectionUpdateContext(
        uint256 id
    )
        external
        view
        returns (
            uint256 merkleRootsCount,
            uint256 minted,
            uint88 byteSize,
            uint40 endEpoch,
            uint96 tokenAmount,
            bool isImmutable,
            uint32 merkleLeafCount
        )
    {
        KnowledgeCollectionLib.KnowledgeCollection storage kc = knowledgeCollections[id];
        return (
            kc.merkleRoots.length,
            kc.minted,
            kc.byteSize,
            kc.endEpoch,
            kc.tokenAmount,
            kc.isImmutable,
            kc.merkleLeafCount
        );
    }

    /// @notice Leaf count for the V10 flat-KC Merkle tree at latest root
    ///         (see `merkleLeafCount` on `KnowledgeCollection`).
    function getMerkleLeafCount(uint256 id) external view returns (uint32) {
        return knowledgeCollections[id].merkleLeafCount;
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
        // Wholesale replacement — clear the parallel author mapping for
        // the union of old and new index ranges so stale authors from
        // either side cannot leak through. The MerkleRoot struct itself
        // carries no author field (parallel-mapping design), so callers
        // of this admin path cannot supply authors here; effective
        // post-condition is "all entries unauthenticated until a
        // subsequent create/update writes them". Loop bounded by the
        // larger of the two lengths.
        uint256 oldLen = knowledgeCollections[id].merkleRoots.length;
        uint256 newLen = _merkleRoots.length;
        uint256 maxLen = oldLen > newLen ? oldLen : newLen;
        for (uint256 i = 0; i < maxLen; i++) {
            delete merkleRootAuthors[id][i];
        }
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

    function getMerkleRootAuthorByIndex(uint256 id, uint256 index) external view returns (address) {
        // Bounds-check via the canonical merkleRoots array so out-of-range
        // queries revert the same way as the other index-based getters,
        // rather than silently returning address(0) from the parallel
        // mapping (which has no concept of "valid index").
        require(index < knowledgeCollections[id].merkleRoots.length, "Index out of bounds");
        return merkleRootAuthors[id][index];
    }

    /// @notice Verified author identity for the latest merkle-root entry
    /// of `id`. Returns `address(0)` if the latest state change did not
    /// carry an author attestation (legacy publish path or a pre-vNext
    /// update). Used by `/api/get` and other off-chain readers as the
    /// canonical "who authored this KC" lookup — chain wins over any
    /// off-chain `dkg:authoredBy` triple.
    function getLatestMerkleRootAuthor(uint256 id) external view returns (address) {
        uint256 len = knowledgeCollections[id].merkleRoots.length;
        if (len == 0) return address(0);
        return merkleRootAuthors[id][len - 1];
    }

    function pushMerkleRoot(address publisher, uint256 id, bytes32 merkleRoot) external onlyContracts {
        knowledgeCollections[id].merkleRoots.push(
            KnowledgeCollectionLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // Defensive clear: this index may have been used by a previously
        // popped author entry (`merkleRoots.length` cycles via push/pop).
        // Without the explicit `delete`, an unauthenticated push after a
        // pop would inherit the popped entry's author and `getLatestMerkleRootAuthor`
        // would lie. Legacy `pushMerkleRoot` carries no author by design —
        // always zero the parallel slot.
        delete merkleRootAuthors[id][knowledgeCollections[id].merkleRoots.length - 1];

        emit KnowledgeCollectionMerkleRootAdded(id, merkleRoot);
    }

    function popMerkleRoot(uint256 id) external onlyContracts {
        uint256 oldLen = knowledgeCollections[id].merkleRoots.length;
        bytes32 latestMerkleRoot = _safeGetLatestMerkleRootObject(id).merkleRoot;
        knowledgeCollections[id].merkleRoots.pop();
        // Clear the parallel author slot for the popped index. Without
        // this, the slot survives and a later push at the same index can
        // resurrect a stale author. `oldLen > 0` guards the empty-array
        // case (pop on empty would have reverted on the line above; the
        // `_safeGetLatestMerkleRootObject` returns a zero-tuple but the
        // pop itself reverts on length 0 — kept defensive).
        if (oldLen > 0) {
            delete merkleRootAuthors[id][oldLen - 1];
        }

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

                // Burn-range gate. The valid range for KC `id` is
                // [startTokenId, startTokenId + kc.minted). Revert when the
                // caller passes a token OUTSIDE that range — otherwise an
                // update on KC X with a burn list that names token IDs
                // belonging to KC Y would burn KC Y's tokens against KC X's
                // burn counter (cross-KC accounting corruption). The
                // condition was previously inverted, causing both legitimate
                // same-KC burns to revert and cross-KC burns to sneak
                // through. See Codex review round 2, finding 7.
                if (tokenId < startTokenId || tokenId >= startTokenId + kc.minted) {
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
