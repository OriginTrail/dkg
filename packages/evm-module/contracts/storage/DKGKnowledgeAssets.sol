// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Guardian} from "../Guardian.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {KnowledgeAssetLib} from "../libraries/KnowledgeAssetLib.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {HubDependent} from "../abstract/HubDependent.sol";

/**
 * @title DKGKnowledgeAssets
 * @notice Greenfield KA storage: one ERC-721 per Knowledge Asset (`tokenId == kaId`),
 *         merkle-root history, economics, and ciphertext commitments. No ERC-1155.
 */
contract DKGKnowledgeAssets is INamed, IVersioned, HubDependent, ERC721, Guardian {

    /// @dev `author` is the verified agent identity from the V10.1+
    ///      author-attestation EIP-712 envelope, or `address(0)` for legacy
    ///      callers (`KnowledgeAsset (V10.1 active path)`) that do not perform author
    ///      attestation. Indexers SHOULD prefer this `indexed` field over
    ///      walking storage when filtering KAs by author.
    event KnowledgeAssetCreated(
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
    event KnowledgeAssetUpdated(
        uint256 indexed id,
        address indexed author,
        string updateOperationId,
        bytes32 merkleRoot,
        uint256 byteSize,
        uint96 tokenAmount
    );
    event KnowledgeAssetsMinted(uint256 indexed id, address indexed to, uint256 startId, uint256 endId);
    event KnowledgeAssetsBurned(uint256 indexed id, address indexed from, uint256[] tokenIds);
    event KnowledgeAssetPublisherUpdated(uint256 indexed id, address publisher);
    event KnowledgeAssetMerkleRootsUpdated(uint256 indexed id, KnowledgeAssetLib.MerkleRoot[] merkleRoots);
    event KnowledgeAssetMerkleRootAdded(uint256 indexed id, bytes32 merkleRoot);
    event KnowledgeAssetMerkleRootRemoved(uint256 indexed id, bytes32 merkleRoot);
    event KnowledgeAssetMintedUpdated(uint256 indexed id, uint256 minted);
    event KnowledgeAssetBurnedUpdated(uint256 indexed id, uint256[] burned);
    event KnowledgeAssetByteSizeUpdated(uint256 indexed id, uint256 byteSize);
    event KnowledgeAssetChunksAmountUpdated(uint256 indexed id, uint256 chunksAmount);
    event KnowledgeAssetTokenAmountUpdated(uint256 indexed id, uint256 tokenAmount);
    event KnowledgeAssetStartEpochUpdated(uint256 indexed id, uint256 startEpoch);
    event KnowledgeAssetEndEpochUpdated(uint256 indexed id, uint256 endEpoch);
    event URIUpdate(string newURI);

    /// @notice OT-RFC-49 / WS-B: a per-KA PUBLIC `_catalog` commitment was set for
    ///         curated random sampling. Emitted by `setCatalogCommitment`, called by
    ///         `KnowledgeAssetsLifecycle._executePublishCore` immediately after
    ///         `createKnowledgeAsset` when the publish input carries a non-zero
    ///         `(catalogRoot, catalogLeafCount)` pair AND the owning CG is curated.
    ///         Off-chain indexers consume this to know which KAs participate in the
    ///         curated-CG sampling lottery (the picker treats missing commitments as
    ///         "skip this KA").
    event KnowledgeAssetCatalogCommitmentSet(
        uint256 indexed id,
        bytes32 catalogRoot,
        uint32 catalogLeafCount
    );

    // --- OT-RFC-43 Option 1 (variant 1a) errors ---
    /// @notice The supplied packed `kaId`'s high 160 bits (`kaId >> 96`) do not
    ///         equal the attested author. A wallet may only mint KAs within its
    ///         own namespace (OT-RFC-43 §4).
    error KaIdNamespaceMismatch(uint256 kaId, address author);
    /// @notice The supplied (author, number) packs to a `kaId` that is already
    ///         minted — a re-used reservation. Never a silent clobber.
    error KaIdAlreadyMinted(uint256 kaId);
    /// @notice `getLatestKnowledgeAssetId` is deprecated under Option 1 — ids
    ///         are packed (author<<96)|number and not globally sequential, so a
    ///         single "latest id" is meaningless.
    error GetLatestKnowledgeAssetIdDeprecated();

    string private constant _NAME = "DKGKnowledgeAssets";
    string private constant _VERSION = "10.1.0";

    string private _tokenURI;

    uint256 public immutable KNOWLEDGE_ASSET_BATCH_MAX_SIZE;

    // OT-RFC-43 Option 1 (variant 1a): the global auto-increment id counter is
    // retired — KA ids are now caller-supplied packed (author<<96)|number values
    // minted in `createKnowledgeAsset`. This storage SLOT is retained (renamed,
    // never written) so the layout of every field below is unchanged whether
    // this contract is freshly deployed OR upgraded in place (R3 — proxy-vs-
    // redeploy is unresolved; keeping the gap is safe under both). Do not
    // repurpose without resolving R3.
    // slither-disable-next-line unused-state,constable-states
    uint256 private _deprecatedKnowledgeAssetsCounter;
    uint256 private _totalMintedKnowledgeAssetsCounter;
    // V10 retired burn semantics — `burnKnowledgeAssetsTokens` is a
    // `pure` revert stub — so this counter is intentionally never
    // written. Solidity zero-initializes it, and `totalBurned()`
    // correctly returns 0 for legacy ABI consumers. The Slither
    // directive silences the rule WITHOUT changing storage layout;
    // making this `constant` would shift every slot declared below
    // and is out of scope for an ABI-only legacy field.
    // slither-disable-next-line uninitialized-state
    uint256 private _totalBurnedKnowledgeAssetsCounter;

    uint96 private _totalTokenAmount;

    mapping(uint256 => KnowledgeAssetLib.KnowledgeAsset) public knowledgeAssets;
    mapping(uint256 => bool) public isKnowledgeAssetBurned;

    /// @dev Parallel mapping for V10.1+ author attestation.
    ///
    /// Why a parallel map and not a struct field on `MerkleRoot`:
    /// `KnowledgeAsset.merkleRoots` is a dynamic array, so
    /// extending its element struct from 3 to 4 storage slots would
    /// shift the slot stride of every prior root entry — already-
    /// deployed KAs would decode their historical
    /// `publisher`/`merkleRoot`/`timestamp` from the wrong offsets.
    /// Layout-preserving fix: keep `MerkleRoot` at 3 slots and store
    /// the EIP-712-recovered author identity at
    /// `merkleRootAuthors[kaId][rootIndex]`. Both the publish AND the
    /// update path persist a verified EIP-712 author here (OT-RFC-45
    /// owner-only update). `address(0)` means the state change at
    /// `rootIndex` did not carry an attestation — i.e. legacy V8/V9
    /// mutations and admin paths (`setMerkleRoots` / `pushMerkleRoot`,
    /// which zero the slot by design).
    /// Indexers SHOULD prefer the indexed `author` topic on
    /// `KnowledgeAssetCreated` / `KnowledgeAssetUpdated`
    /// events; this on-chain mapping is the canonical lookup for
    /// `/api/knowledge-assets/:id/author` and SPARQL author-filter queries.
    mapping(uint256 => mapping(uint256 => address)) public merkleRootAuthors;

    /// @notice OT-RFC-49: DEAD — slot preserved for storage-layout stability.
    ///
    /// Formerly `ciphertextChunksRoots` (RFC-39 Phase A.5 curated ciphertext
    /// commitment). RFC-49 ("hosting follows access") strips private ciphertext
    /// from cores entirely, so cores can no longer prove a ciphertext chunk —
    /// the curated random-sampling commitment is now the PUBLIC `_catalog` root
    /// (`catalogRoots` below). This slot is intentionally retained (not deleted)
    /// so that removing it cannot shift the base slot of `_authorKaNumberHighWater`
    /// or any later mapping; same discipline as `_deprecatedKnowledgeAssetsCounter`.
    /// Never read or written after RFC-49.
    mapping(uint256 => bytes32) private _deprecatedCiphertextChunksRoots;

    /// @notice OT-RFC-49: DEAD — slot preserved. Formerly `ciphertextChunkCounts`.
    /// See `_deprecatedCiphertextChunksRoots`. Superseded by `catalogLeafCounts`.
    mapping(uint256 => uint32) private _deprecatedCiphertextChunkCounts;

    /// @notice OT-RFC-43 Option 1 (variant 1a): per-author high-water KA `number`
    ///         (the low 96 bits of the packed kaId), stored as `maxNumber + 1` so
    ///         the default `0` unambiguously means "this author has never minted".
    ///         Lets the off-chain allocator reconcile its cold-start floor with a
    ///         single O(1) `getMaxKaNumberForAuthor` view instead of an unbounded
    ///         `KnowledgeAssetCreated` log scan (which overflows the `eth_getLogs`
    ///         block-range cap on networks with deep history). Appended at the END
    ///         of storage to preserve the slot layout of every field above (see the
    ///         layout note on `_deprecatedKnowledgeAssetsCounter`).
    mapping(address => uint256) private _authorKaNumberHighWater;

    /// @notice OT-RFC-49 / WS-B: per-KA PUBLIC `_catalog` Merkle root — the curated
    ///         random-sampling commitment that replaces the stripped ciphertext one.
    ///
    /// Used by `RandomSampling._pickWeightedChallenge` (eligibility + leaf draw) and
    /// `RandomSampling.submitProof` for curated CGs in place of the ciphertext root.
    /// The root commits ONLY to the public `_catalog` leaves of the latest publish —
    /// the same plaintext triples cores host and serve under
    /// `did:dkg:context-graph:<cgId>/_catalog`. Computed off-chain by
    /// `computeCatalogRoot` (a dedicated `V10MerkleTree` over the catalog quads only;
    /// the private sub-roots stay in `merkleRoots[]` for proof-of-existence but are
    /// NEVER drawn). Set by `KnowledgeAssetsLifecycle._executePublishCore` for curated
    /// CGs. Default `bytes32(0)` is the "no catalog commitment" sentinel that
    /// `RandomSampling` uses to skip this KA in the curated draw (legacy KAs read 0 →
    /// grandfathered out until they re-publish post-RFC-49).
    ///
    /// Appended at the END of storage (after `_authorKaNumberHighWater`) to preserve
    /// every existing slot; new slot space cannot masquerade old ciphertext roots as
    /// catalog roots.
    mapping(uint256 => bytes32) public catalogRoots;

    /// @notice OT-RFC-49 / WS-B: per-KA PUBLIC `_catalog` leaf count (POST sort+dedupe,
    ///         == `V10MerkleTree.leafCount`, NOT the raw catalog-quad count).
    ///
    /// The leaf-count input for the `chunkId = uint256(seed) % count` draw in
    /// `RandomSampling._pickWeightedChallenge` step 3 for curated CGs, and the bounds
    /// check in `submitProof`. Must equal the off-chain tree's `leafCount` exactly or
    /// an honest prover cannot build a proof for a drawn `chunkId`.
    mapping(uint256 => uint32) public catalogLeafCounts;

    constructor(
        address hubAddress,
        uint256 _knowledgeAssetBatchMaxSize,
        string memory uri
    ) ERC721("DKG Knowledge Asset", "DKA") Guardian(hubAddress) {
        KNOWLEDGE_ASSET_BATCH_MAX_SIZE = _knowledgeAssetBatchMaxSize;
        _tokenURI = uri;
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function knowledgeAssetBatchMaxSize() external view returns (uint256) {
        return KNOWLEDGE_ASSET_BATCH_MAX_SIZE;
    }

    function createKnowledgeAsset(
        address publisher,
        address author,
        uint256 kaId,
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
        if (knowledgeAssetsAmount != 1) {
            revert KnowledgeAssetLib.ExceededKnowledgeAssetBatchSize(0, 0, knowledgeAssetsAmount, 1);
        }

        // OT-RFC-43 Option 1 (variant 1a): the KA id is supplied by the caller
        // (the off-chain allocator) as a deterministic packed value
        // kaId = (uint160(author) << 96) | uint96(number). The high 160 bits
        // MUST equal the attested author, so a wallet can only mint within its
        // own namespace. Unforgeable: `author` is proven by the EIP-712
        // attestation in `KnowledgeAssetsLifecycle._verifyAuthorAttestation`
        // before this call. NB: the namespace binds to the attested AUTHOR
        // (EIP-712 signer / initial NFT owner), a deliberate divergence from
        // OT-RFC-43 §7's `msg.sender`/publisher diagram — the two coincide in
        // the dominant self-publish case. The global `++_knowledgeAssetsCounter`
        // is removed under 1a (packed-only; no post-tx canonical id).
        if ((kaId >> 96) != uint256(uint160(author))) {
            revert KaIdNamespaceMismatch(kaId, author);
        }
        // Fail fast on a re-used (author, number): the id must not already be
        // minted. `_safeMint` below would also revert, but checking here keeps
        // checks-effects-interactions ordering (no state mutation before the
        // guard) and surfaces a precise error. `kaId` is guaranteed non-zero
        // because `author != address(0)` (enforced upstream), so the `0`
        // sentinel used by `getKnowledgeAssetId` / `isPartOfKnowledgeAsset` is
        // never produced here.
        if (_ownerOf(kaId) != address(0)) {
            revert KaIdAlreadyMinted(kaId);
        }
        // Defense-in-depth (audit hardening): assert the KA struct slot is
        // pristine, not merely unowned. `_ownerOf` proves the token was never
        // minted, but `onlyContracts` setters (`setMerkleRoots` / `pushMerkleRoot`)
        // could in principle pre-seed `knowledgeAssets[kaId]` for an unminted id,
        // which would make the index-0 `merkleRootAuthors` write below land at the
        // wrong index. Under the retired `++_knowledgeAssetsCounter` scheme a fresh
        // id was structurally never-touched; with caller-supplied ids we assert it.
        if (knowledgeAssets[kaId].merkleRoots.length != 0) {
            revert KaIdAlreadyMinted(kaId);
        }

        uint256 knowledgeAssetId = kaId;

        KnowledgeAssetLib.KnowledgeAsset storage ka = knowledgeAssets[knowledgeAssetId];

        ka.merkleRoots.push(
            KnowledgeAssetLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // First root of a fresh KA — index 0. `kaId` was just proven unminted
        // above (and `_safeMint` re-enforces it), so this parallel slot is
        // empty; the unconditional shape is kept for parity with
        // `updateKnowledgeAsset` below, where the index can have been
        // previously used (post-pop).
        merkleRootAuthors[knowledgeAssetId][ka.merkleRoots.length - 1] = author;
        ka.byteSize = byteSize;
        ka.startEpoch = startEpoch;
        ka.endEpoch = endEpoch;
        ka.tokenAmount = tokenAmount;
        ka.isImmutable = isImmutable;
        ka.merkleLeafCount = merkleLeafCount;

        unchecked {
            _totalTokenAmount += tokenAmount;
        }

        ka.minted = 1;
        _totalMintedKnowledgeAssetsCounter += 1;

        // OT-RFC-43 Option 1: record the per-author high-water `number` BEFORE the
        // `_safeMint` interaction (checks-effects-interactions — `_safeMint` calls
        // `onERC721Received` on a contract recipient). Stored as `number + 1` so the
        // default 0 means "never minted"; only ever raised, never lowered, so a
        // gap-filling mint of a lower number can never regress the floor. Backs the
        // O(1) `getMaxKaNumberForAuthor` allocator reconcile.
        uint256 mintedNumber = uint96(knowledgeAssetId); // low 96 bits = per-author number
        if (mintedNumber + 1 > _authorKaNumberHighWater[author]) {
            _authorKaNumberHighWater[author] = mintedNumber + 1;
        }

        _safeMint(author, knowledgeAssetId);

        emit KnowledgeAssetCreated(
            knowledgeAssetId,
            author,
            publishOperationId,
            merkleRoot,
            byteSize,
            startEpoch,
            endEpoch,
            tokenAmount,
            isImmutable
        );

        return knowledgeAssetId;
    }

    /// @notice OT-RFC-43 Option 1 (variant 1a): the highest KA `number` already
    ///         minted under `author` (the low 96 bits of its packed kaId), or `-1`
    ///         if `author` has never minted a KA.
    /// @dev    O(1) replacement for enumerating `KnowledgeAssetCreated(id, author)`
    ///         logs. The off-chain allocator's next number for `author` is
    ///         `getMaxKaNumberForAuthor(author) + 1`, so a brand-new author (result
    ///         `-1`) correctly starts at number 0. Returns `int256` so "never minted"
    ///         is a true sentinel rather than colliding with a legitimately-minted
    ///         number 0.
    ///
    ///         PRECONDITION — not backfilled across an in-place storage upgrade.
    ///         `_authorKaNumberHighWater` is only populated by `createKnowledgeAsset`
    ///         from this version (10.0.4) onward. On a fresh deploy or redeploy — the
    ///         expected path, where every KA is minted under this contract — it is
    ///         authoritative for ALL of an author's KAs. But if this storage is
    ///         upgraded IN PLACE over a pre-10.0.4 deployment that already minted KAs,
    ///         those historical authors read `-1` until their next mint. Such an
    ///         in-place upgrade is not supported unless the mapping is backfilled or
    ///         the allocator is explicitly configured to reconcile historical mints by
    ///         another source. The repository deployment flow is a fresh asset-storage
    ///         redeploy/Hub rotation, not bytecode replacement over existing storage.
    /// @param  author The attested author address (the high 160 bits of a packed kaId).
    /// @return The highest KA `number` already minted under `author`, or `-1` if none.
    function getMaxKaNumberForAuthor(address author) external view returns (int256) {
        uint256 highWater = _authorKaNumberHighWater[author];
        return highWater == 0 ? int256(-1) : int256(highWater) - 1;
    }

    function getKnowledgeAsset(
        uint256 id
    ) external view returns (KnowledgeAssetLib.KnowledgeAsset memory) {
        return knowledgeAssets[id];
    }

    /// @dev `author` is the verified author identity for this update. The
    ///      V10.1 update path attests the author (EIP-712) and enforces
    ///      owner-only in `KnowledgeAssetsLifecycle._executeUpdateCore`
    ///      (OT-RFC-45), so callers on that path pass a non-zero, verified
    ///      author. `address(0)` only on admin/legacy paths that carry no
    ///      attestation.
    function updateKnowledgeAsset(
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
        KnowledgeAssetLib.KnowledgeAsset storage ka = knowledgeAssets[id];

        unchecked {
            _totalTokenAmount = _totalTokenAmount - ka.tokenAmount + tokenAmount;
        }

        ka.merkleRoots.push(
            KnowledgeAssetLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // Unconditional overwrite — this index may have been written by
        // a previous create/update and then popped via `popMerkleRoot`,
        // leaving the stale author in the parallel slot. Always write
        // the current `author` (the verified EIP-712 author the V10.1
        // lifecycle update path supplies; `address(0)` only on admin/legacy
        // paths) to make the canonical mapping monotonic with the
        // merkleRoots array.
        merkleRootAuthors[id][ka.merkleRoots.length - 1] = author;
        ka.byteSize = byteSize;
        ka.tokenAmount = tokenAmount;
        ka.merkleLeafCount = merkleLeafCount;

        // Burn with an empty list is a no-op (the inner for-loop over
        // tokenIds skips when length == 0). Mint with amount == 0 was
        // previously unconditionally dispatched to `_mintWithoutCheck`,
        // which reverts `MintZeroQuantity` on zero — blocking true
        // metadata-only updates (delta == 0, no mint, no burn) that the
        // KnowledgeAssetsV10 update flow explicitly documents as
        // supported. Guard the mint call so metadata-only rotations work
        // end-to-end. See Codex review round 2, finding 6.
        if (mintKnowledgeAssetsAmount != 0 || knowledgeAssetsToBurn.length != 0) {
            revert KnowledgeAssetLib.ExceededKnowledgeAssetBatchSize(
                id,
                ka.minted,
                mintKnowledgeAssetsAmount,
                0
            );
        }

        emit KnowledgeAssetUpdated(id, author, updateOperationId, merkleRoot, byteSize, tokenAmount);
    }

    /// @notice Lightweight update-path metadata — scalar fields only + the
    /// pre-update merkle-root count. Intended for callers (e.g.
    /// `KnowledgeAssetsV10._executeUpdateCore`) that need the state
    /// summary but NOT the full history arrays.
    ///
    /// Problem: `getKnowledgeAssetMetadata` performs a full
    /// storage → memory struct copy, which walks every entry of
    /// `merkleRoots[]` and `burned[]`. Because both arrays grow
    /// monotonically on every update, the memory cost (and thus gas
    /// cost) of calling that getter from the update path itself scales
    /// linearly — actually super-linearly due to EVM memory-expansion
    /// quadratic term — with the number of prior updates. A KA with
    /// thousands of historical entries eventually becomes un-updatable.
    ///
    /// This getter returns only the scalar slots and the merkle-root
    /// chain length (as a plain `uint256`), so the update path's gas
    /// cost is constant regardless of history.
    ///
    /// Codex review round 3 finding 1.
    function getKnowledgeAssetUpdateContext(
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
        KnowledgeAssetLib.KnowledgeAsset storage ka = knowledgeAssets[id];
        return (
            ka.merkleRoots.length,
            ka.minted,
            ka.byteSize,
            ka.endEpoch,
            ka.tokenAmount,
            ka.isImmutable,
            ka.merkleLeafCount
        );
    }

    /// @notice Leaf count for the V10 flat-KA Merkle tree at latest root
    ///         (see `merkleLeafCount` on `KnowledgeAsset`).
    function getMerkleLeafCount(uint256 id) external view returns (uint32) {
        return knowledgeAssets[id].merkleLeafCount;
    }

    /// @notice OT-RFC-49 / WS-B: write the curated PUBLIC `_catalog` commitment for
    ///         a freshly-created (or updated) KA. Caller must enforce the curated-CG
    ///         gate — KAS does not look at `ContextGraphStorage` to keep the storage
    ///         layer policy-free.
    ///
    ///         Both fields must be non-zero — partial commitments (a non-zero root
    ///         with zero count, or vice versa) are forbidden because they would
    ///         silently de-rail the picker (zero count → divide-by-zero in the
    ///         catalog-leaf draw, zero root → proof verification against an empty
    ///         tree). `KnowledgeAssetsLifecycle` normalises "no commitment" to a
    ///         literal no-call (no event emitted, both slots stay at default zero).
    ///         Unlike the stripped ciphertext commitment, the catalog commitment is
    ///         re-set on every curated update so the random-sampling surface tracks
    ///         the latest published `_catalog`.
    function setCatalogCommitment(
        uint256 id,
        bytes32 catalogRoot,
        uint32 catalogLeafCount
    ) external onlyContracts {
        require(
            catalogRoot != bytes32(0) && catalogLeafCount > 0,
            "Invalid catalog commitment"
        );
        catalogRoots[id] = catalogRoot;
        catalogLeafCounts[id] = catalogLeafCount;

        emit KnowledgeAssetCatalogCommitmentSet(id, catalogRoot, catalogLeafCount);
    }

    /// @notice OT-RFC-49 / WS-B: latest PUBLIC `_catalog` Merkle root for a curated
    ///         KA, or `bytes32(0)` if no commitment was ever set (public KA, or a
    ///         legacy curated KA that has not re-published since RFC-49).
    ///         `RandomSampling` treats the zero sentinel as "skip this KA in the
    ///         curated draw".
    function getCatalogRoot(uint256 id) external view returns (bytes32) {
        return catalogRoots[id];
    }

    /// @notice OT-RFC-49 / WS-B: PUBLIC `_catalog` leaf count for a curated KA, or
    ///         `0` if no commitment was ever set. Used as the leaf-count input for
    ///         the curated picker's `chunkId = seed % count` draw and as the bounds
    ///         check in `submitProof`. Equals the off-chain `V10MerkleTree.leafCount`
    ///         (post sort+dedupe), never the raw catalog-quad count.
    function getCatalogLeafCount(uint256 id) external view returns (uint32) {
        return catalogLeafCounts[id];
    }

    function getKnowledgeAssetMetadata(
        uint256 id
    )
        external
        view
        returns (
            KnowledgeAssetLib.MerkleRoot[] memory,
            uint256[] memory,
            uint256,
            uint88,
            uint40,
            uint40,
            uint96,
            bool
        )
    {
        KnowledgeAssetLib.KnowledgeAsset memory ka = knowledgeAssets[id];

        return (
            ka.merkleRoots,
            ka.burned,
            ka.minted,
            ka.byteSize,
            ka.startEpoch,
            ka.endEpoch,
            ka.tokenAmount,
            ka.isImmutable
        );
    }

    /// @dev Greenfield: batch mint/burn removed. Updates rotate merkle state only.
    function mintKnowledgeAssetsTokens(uint256, address, uint256) public pure {
        revert KnowledgeAssetLib.ExceededKnowledgeAssetBatchSize(0, 0, 1, 0);
    }

    function burnKnowledgeAssetsTokens(uint256, address, uint256[] calldata) public pure {
        revert KnowledgeAssetLib.ExceededKnowledgeAssetBatchSize(0, 0, 1, 0);
    }

    function getMerkleRoots(uint256 id) external view returns (KnowledgeAssetLib.MerkleRoot[] memory) {
        return knowledgeAssets[id].merkleRoots;
    }

    function setMerkleRoots(
        uint256 id,
        KnowledgeAssetLib.MerkleRoot[] memory _merkleRoots
    ) external onlyContracts {
        // Wholesale replacement — clear the parallel author mapping for
        // the union of old and new index ranges so stale authors from
        // either side cannot leak through. The MerkleRoot struct itself
        // carries no author field (parallel-mapping design), so callers
        // of this admin path cannot supply authors here; effective
        // post-condition is "all entries unauthenticated until a
        // subsequent create/update writes them". Loop bounded by the
        // larger of the two lengths.
        uint256 oldLen = knowledgeAssets[id].merkleRoots.length;
        uint256 newLen = _merkleRoots.length;
        uint256 maxLen = oldLen > newLen ? oldLen : newLen;
        for (uint256 i = 0; i < maxLen; i++) {
            delete merkleRootAuthors[id][i];
        }
        knowledgeAssets[id].merkleRoots = _merkleRoots;

        emit KnowledgeAssetMerkleRootsUpdated(id, _merkleRoots);
    }

    function getMerkleRootObjectByIndex(
        uint256 id,
        uint256 index
    ) external view returns (KnowledgeAssetLib.MerkleRoot memory) {
        return knowledgeAssets[id].merkleRoots[index];
    }

    function getMerkleRootByIndex(uint256 id, uint256 index) external view returns (bytes32) {
        return knowledgeAssets[id].merkleRoots[index].merkleRoot;
    }

    function getMerkleRootPublisherByIndex(uint256 id, uint256 index) external view returns (address) {
        return knowledgeAssets[id].merkleRoots[index].publisher;
    }

    function getMerkleRootTimestampByIndex(uint256 id, uint256 index) external view returns (uint256) {
        return knowledgeAssets[id].merkleRoots[index].timestamp;
    }

    function getLatestMerkleRootObject(uint256 id) external view returns (KnowledgeAssetLib.MerkleRoot memory) {
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
        require(index < knowledgeAssets[id].merkleRoots.length, "Index out of bounds");
        return merkleRootAuthors[id][index];
    }

    /// @notice Verified author identity for the latest merkle-root entry
    /// of `id`. Returns `address(0)` if the latest state change did not
    /// carry an author attestation (legacy/admin path only; both the publish
    /// and the V10.1 update path now attest the author — OT-RFC-45). Used by
    /// `/api/get` and other off-chain readers as the
    /// canonical "who authored this KA" lookup — chain wins over any
    /// off-chain `dkg:authoredBy` triple.
    function getLatestMerkleRootAuthor(uint256 id) external view returns (address) {
        uint256 len = knowledgeAssets[id].merkleRoots.length;
        if (len == 0) return address(0);
        return merkleRootAuthors[id][len - 1];
    }

    function pushMerkleRoot(address publisher, uint256 id, bytes32 merkleRoot) external onlyContracts {
        knowledgeAssets[id].merkleRoots.push(
            KnowledgeAssetLib.MerkleRoot(publisher, merkleRoot, block.timestamp)
        );
        // Defensive clear: this index may have been used by a previously
        // popped author entry (`merkleRoots.length` cycles via push/pop).
        // Without the explicit `delete`, an unauthenticated push after a
        // pop would inherit the popped entry's author and `getLatestMerkleRootAuthor`
        // would lie. Legacy `pushMerkleRoot` carries no author by design —
        // always zero the parallel slot.
        delete merkleRootAuthors[id][knowledgeAssets[id].merkleRoots.length - 1];

        emit KnowledgeAssetMerkleRootAdded(id, merkleRoot);
    }

    function popMerkleRoot(uint256 id) external onlyContracts {
        uint256 oldLen = knowledgeAssets[id].merkleRoots.length;
        bytes32 latestMerkleRoot = _safeGetLatestMerkleRootObject(id).merkleRoot;
        knowledgeAssets[id].merkleRoots.pop();
        // Clear the parallel author slot for the popped index. Without
        // this, the slot survives and a later push at the same index can
        // resurrect a stale author. `oldLen > 0` guards the empty-array
        // case (pop on empty would have reverted on the line above; the
        // `_safeGetLatestMerkleRootObject` returns a zero-tuple but the
        // pop itself reverts on length 0 — kept defensive).
        if (oldLen > 0) {
            delete merkleRootAuthors[id][oldLen - 1];
        }

        emit KnowledgeAssetMerkleRootRemoved(id, latestMerkleRoot);
    }

    function getMinted(uint256 id) external view returns (uint256) {
        return knowledgeAssets[id].minted;
    }

    function setMinted(uint256 id, uint256 _minted) external onlyContracts {
        knowledgeAssets[id].minted = _minted;

        emit KnowledgeAssetMintedUpdated(id, _minted);
    }

    function getBurned(uint256 id) external view returns (uint256[] memory) {
        return knowledgeAssets[id].burned;
    }

    function getBurnedAmount(uint256 id) external view returns (uint256) {
        return knowledgeAssets[id].burned.length;
    }

    function setBurned(uint256 id, uint256[] calldata _burned) external onlyContracts {
        knowledgeAssets[id].burned = _burned;

        emit KnowledgeAssetBurnedUpdated(id, _burned);
    }

    function getByteSize(uint256 id) external view returns (uint88) {
        return knowledgeAssets[id].byteSize;
    }

    function setByteSize(uint256 id, uint88 _byteSize) external onlyContracts {
        knowledgeAssets[id].byteSize = _byteSize;

        emit KnowledgeAssetByteSizeUpdated(id, _byteSize);
    }

    function getTokenAmount(uint256 id) external view returns (uint96) {
        return knowledgeAssets[id].tokenAmount;
    }

    function setTokenAmount(uint256 id, uint96 _tokenAmount) external onlyContracts {
        _totalTokenAmount = _totalTokenAmount - knowledgeAssets[id].tokenAmount + _tokenAmount;
        knowledgeAssets[id].tokenAmount = _tokenAmount;

        emit KnowledgeAssetTokenAmountUpdated(id, _tokenAmount);
    }

    function getStartEpoch(uint256 id) external view returns (uint40) {
        return knowledgeAssets[id].startEpoch;
    }

    function setStartEpoch(uint256 id, uint40 _startEpoch) external onlyContracts {
        knowledgeAssets[id].startEpoch = _startEpoch;

        emit KnowledgeAssetStartEpochUpdated(id, _startEpoch);
    }

    function getEndEpoch(uint256 id) external view returns (uint40) {
        return knowledgeAssets[id].endEpoch;
    }

    function setEndEpoch(uint256 id, uint40 _endEpoch) external onlyContracts {
        knowledgeAssets[id].endEpoch = _endEpoch;

        emit KnowledgeAssetEndEpochUpdated(id, _endEpoch);
    }

    /// @notice DEPRECATED under OT-RFC-43 Option 1 (variant 1a). KA ids are
    ///         packed (author<<96)|number values, not globally sequential, so a
    ///         single "latest id" is meaningless. Always reverts — enumerate
    ///         KAs via the `KnowledgeAssetCreated` event (or per-CG lists).
    function getLatestKnowledgeAssetId() external pure returns (uint256) {
        revert GetLatestKnowledgeAssetIdDeprecated();
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

    function isPartOfKnowledgeAsset(uint256 id, uint256 tokenId) external view returns (bool) {
        return id == tokenId && _ownerOf(tokenId) != address(0);
    }

    function getKnowledgeAssetId(uint256 tokenId) external view returns (uint256) {
        if (_ownerOf(tokenId) == address(0)) {
            return 0;
        }
        return tokenId;
    }

    function getKnowledgeAssetsRange(uint256 id) external view returns (uint256, uint256, uint256[] memory) {
        KnowledgeAssetLib.KnowledgeAsset memory ka = knowledgeAssets[id];
        if (ka.minted == 0) {
            return (0, 0, ka.burned);
        }
        return (id, id, ka.burned);
    }

    function getKnowledgeAssetsAmount(uint256 id) external view returns (uint256) {
        KnowledgeAssetLib.KnowledgeAsset memory ka = knowledgeAssets[id];
        return ka.minted - ka.burned.length;
    }

    function isKnowledgeAssetOwner(address owner, uint256 id) external view returns (bool) {
        return ownerOf(id) == owner;
    }

    function setURI(string memory baseURI) external onlyHub {
        _tokenURI = baseURI;
        emit URIUpdate(baseURI);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURI;
    }

    function _safeGetLatestMerkleRootObject(
        uint256 id
    ) internal view returns (KnowledgeAssetLib.MerkleRoot memory) {
        KnowledgeAssetLib.KnowledgeAsset memory ka = knowledgeAssets[id];
        if (ka.merkleRoots.length == 0) {
            return KnowledgeAssetLib.MerkleRoot(address(0), bytes32(0), 0);
        }
        return ka.merkleRoots[ka.merkleRoots.length - 1];
    }

}
