// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * Context Graph Name Registry: privacy-preserving on-chain name claims
 * for context graphs and other DKG resources.
 *
 * A `nameHash` is a caller-provided bytes32, typically keccak256(bytes(name))
 * computed off-chain. No cleartext metadata is stored or emitted by default —
 * the chain only records the hash, the claimer address, and an access policy.
 *
 * Claimers may optionally reveal metadata on-chain via `revealMetadata()`, which
 * verifies the name matches the nameHash commitment before storing it.
 *
 * System name claims: creator = address(0). Created via `claimSystemName` by
 * `authorizedSystemCreator` only. Cannot be updated or deactivated.
 *
 * Scope note (V10): this contract is a thin name-commitment registry, kept as
 * a transitional affordance. It does NOT participate in context-graph
 * governance (hosting nodes, publish policy, participant allow-lists, quorum
 * signatures) — all of that lives in `ContextGraphs` / `ContextGraphStorage`,
 * which is the authoritative V10 CG contract stack. A future on-chain
 * name-ownership model (NFT-backed, transferable, with economics) is tracked
 * as a separate design task; see
 * `docs/plans/DKG_RESOLVER_AND_NAME_REGISTRY_PROPOSAL.md`.
 */
contract ContextGraphNameRegistry {
    uint8 public constant ACCESS_OPEN = 0;
    uint8 public constant ACCESS_PERMISSIONED = 1;

    /// @dev Only this address may create system name claims (creator = address(0)).
    address public authorizedSystemCreator;

    constructor(address authorizedSystemCreator_) {
        authorizedSystemCreator = authorizedSystemCreator_;
    }

    struct NameClaim {
        address creator;
        uint8 accessPolicy;
        uint40 createdAtBlock;
        bool active;
        bool metadataRevealed;
        string name;
        string description;
    }

    mapping(bytes32 => NameClaim) public nameClaims;

    event NameClaimed(
        bytes32 indexed nameHash,
        address indexed creator,
        uint8 accessPolicy
    );
    event NameMetadataRevealed(
        bytes32 indexed nameHash,
        string name,
        string description
    );
    event NameClaimDeactivated(bytes32 indexed nameHash);

    error NameAlreadyClaimed();
    error NameClaimNotFound();
    error OnlyCreator();
    error InvalidAccessPolicy();
    error OnlyAuthorizedSystemCreator();
    error NameHashMismatch();

    /// @notice Register a name claim with only a hash commitment — no cleartext on chain.
    /// @param nameHash_ Caller-provided bytes32, typically keccak256(bytes(name)).
    /// @param accessPolicy_ 0 = open, 1 = permissioned.
    function claimName(
        bytes32 nameHash_,
        uint8 accessPolicy_
    ) external returns (bytes32) {
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        if (nameClaims[nameHash_].createdAtBlock != 0) revert NameAlreadyClaimed();

        nameClaims[nameHash_] = NameClaim({
            creator: msg.sender,
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true,
            metadataRevealed: false,
            name: "",
            description: ""
        });

        emit NameClaimed(nameHash_, msg.sender, accessPolicy_);
        return nameHash_;
    }

    /// @notice Create a system name claim (creator = address(0)). Only authorizedSystemCreator.
    function claimSystemName(
        bytes32 nameHash_,
        uint8 accessPolicy_
    ) external returns (bytes32) {
        if (msg.sender != authorizedSystemCreator) revert OnlyAuthorizedSystemCreator();
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        if (nameClaims[nameHash_].createdAtBlock != 0) revert NameAlreadyClaimed();

        nameClaims[nameHash_] = NameClaim({
            creator: address(0),
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true,
            metadataRevealed: false,
            name: "",
            description: ""
        });

        emit NameClaimed(nameHash_, address(0), accessPolicy_);
        return nameHash_;
    }

    /// @notice Optionally reveal cleartext metadata on-chain.
    /// @dev Verifies keccak256(bytes(name_)) == nameHash_ to prevent misattribution.
    ///      Only the original creator may reveal. Can only be called once.
    function revealMetadata(
        bytes32 nameHash_,
        string calldata name_,
        string calldata description_
    ) external {
        NameClaim storage c = nameClaims[nameHash_];
        if (c.createdAtBlock == 0) revert NameClaimNotFound();
        if (c.creator != msg.sender) revert OnlyCreator();
        if (keccak256(bytes(name_)) != nameHash_) revert NameHashMismatch();

        c.metadataRevealed = true;
        c.name = name_;
        c.description = description_;

        emit NameMetadataRevealed(nameHash_, name_, description_);
    }

    function getNameClaim(bytes32 nameHash_)
        external
        view
        returns (
            address creator,
            uint8 accessPolicy,
            uint40 createdAtBlock,
            bool active,
            bool metadataRevealed,
            string memory name,
            string memory description
        )
    {
        NameClaim storage c = nameClaims[nameHash_];
        if (c.createdAtBlock == 0) revert NameClaimNotFound();
        return (
            c.creator,
            c.accessPolicy,
            c.createdAtBlock,
            c.active,
            c.metadataRevealed,
            c.name,
            c.description
        );
    }

    function deactivateNameClaim(bytes32 nameHash_) external {
        NameClaim storage c = nameClaims[nameHash_];
        if (c.createdAtBlock == 0) revert NameClaimNotFound();
        if (c.creator != msg.sender) revert OnlyCreator();
        c.active = false;
        emit NameClaimDeactivated(nameHash_);
    }

    /// @notice Update revealed description. Reverts if metadata hasn't been revealed.
    function updateNameMetadata(bytes32 nameHash_, string calldata description_) external {
        NameClaim storage c = nameClaims[nameHash_];
        if (c.createdAtBlock == 0) revert NameClaimNotFound();
        if (c.creator != msg.sender) revert OnlyCreator();

        c.description = description_;
        emit NameMetadataRevealed(nameHash_, c.name, description_);
    }
}
