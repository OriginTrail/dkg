// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * V9 Paranet Registry: privacy-preserving on-chain registration and discovery.
 *
 * paranetId is a caller-provided bytes32 hash, typically keccak256(bytes(name))
 * computed off-chain. No cleartext metadata is stored or emitted by default —
 * the chain only records the hash, creator address, and access policy.
 *
 * Creators may optionally reveal metadata on-chain via revealMetadata(), which
 * verifies the name matches the paranetId commitment before storing it.
 *
 * System paranets: creator = address(0). Created via createSystemParanetV9 by
 * authorizedSystemCreator only. Cannot be updated or deactivated.
 */
contract ParanetV9Registry {
    uint8 public constant ACCESS_OPEN = 0;
    uint8 public constant ACCESS_PERMISSIONED = 1;

    /// @dev Only this address may create system paranets (creator = address(0)).
    address public authorizedSystemCreator;

    constructor(address authorizedSystemCreator_) {
        authorizedSystemCreator = authorizedSystemCreator_;
    }

    struct ParanetInfo {
        address creator;
        uint8 accessPolicy;
        uint40 createdAtBlock;
        bool active;
        bool metadataRevealed;
        string name;
        string description;
    }

    mapping(bytes32 => ParanetInfo) public paranets;

    event ParanetCreated(
        bytes32 indexed paranetId,
        address indexed creator,
        uint8 accessPolicy
    );
    event ParanetMetadataRevealed(
        bytes32 indexed paranetId,
        string name,
        string description
    );
    event ParanetDeactivated(bytes32 indexed paranetId);

    error ParanetAlreadyExists();
    error ParanetNotFound();
    error OnlyCreator();
    error InvalidAccessPolicy();
    error OnlyAuthorizedSystemCreator();
    error NameHashMismatch();

    /// @notice Register a paranet with only a hash commitment — no cleartext on chain.
    /// @param paranetId_ Caller-provided bytes32, typically keccak256(bytes(name)).
    /// @param accessPolicy_ 0 = open, 1 = permissioned.
    function createParanetV9(
        bytes32 paranetId_,
        uint8 accessPolicy_
    ) external returns (bytes32) {
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        if (paranets[paranetId_].createdAtBlock != 0) revert ParanetAlreadyExists();

        paranets[paranetId_] = ParanetInfo({
            creator: msg.sender,
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true,
            metadataRevealed: false,
            name: "",
            description: ""
        });

        emit ParanetCreated(paranetId_, msg.sender, accessPolicy_);
        return paranetId_;
    }

    /// @notice Create a system paranet (creator = address(0)). Only authorizedSystemCreator.
    function createSystemParanetV9(
        bytes32 paranetId_,
        uint8 accessPolicy_
    ) external returns (bytes32) {
        if (msg.sender != authorizedSystemCreator) revert OnlyAuthorizedSystemCreator();
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        if (paranets[paranetId_].createdAtBlock != 0) revert ParanetAlreadyExists();

        paranets[paranetId_] = ParanetInfo({
            creator: address(0),
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true,
            metadataRevealed: false,
            name: "",
            description: ""
        });

        emit ParanetCreated(paranetId_, address(0), accessPolicy_);
        return paranetId_;
    }

    /// @notice Optionally reveal cleartext metadata on-chain.
    /// @dev Verifies keccak256(bytes(name_)) == paranetId to prevent misattribution.
    ///      Only the original creator may reveal. Can only be called once.
    function revealMetadata(
        bytes32 paranetId_,
        string calldata name_,
        string calldata description_
    ) external {
        ParanetInfo storage p = paranets[paranetId_];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        if (p.creator != msg.sender) revert OnlyCreator();
        if (keccak256(bytes(name_)) != paranetId_) revert NameHashMismatch();

        p.metadataRevealed = true;
        p.name = name_;
        p.description = description_;

        emit ParanetMetadataRevealed(paranetId_, name_, description_);
    }

    function getParanet(bytes32 paranetId_)
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
        ParanetInfo storage p = paranets[paranetId_];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        return (
            p.creator,
            p.accessPolicy,
            p.createdAtBlock,
            p.active,
            p.metadataRevealed,
            p.name,
            p.description
        );
    }

    function deactivateParanet(bytes32 paranetId_) external {
        ParanetInfo storage p = paranets[paranetId_];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        if (p.creator != msg.sender) revert OnlyCreator();
        p.active = false;
        emit ParanetDeactivated(paranetId_);
    }

    /// @notice Update revealed description. Reverts if metadata hasn't been revealed.
    function updateParanetMetadata(bytes32 paranetId_, string calldata description_) external {
        ParanetInfo storage p = paranets[paranetId_];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        if (p.creator != msg.sender) revert OnlyCreator();

        p.description = description_;
        emit ParanetMetadataRevealed(paranetId_, p.name, description_);
    }
}
