// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * V9 Paranet Registry: lightweight on-chain creation and discovery of paranets.
 * Paranet identity is bytes32 = keccak256(abi.encodePacked(creator, name)).
 * Does not depend on Knowledge Collection NFTs (unlike V8 Paranet).
 *
 * System paranets: creator = address(0). No one can update or deactivate them
 * (no private key for 0). Created via createSystemParanetV9 by authorizedSystemCreator only.
 */
contract ParanetV9Registry {
    uint8 public constant ACCESS_OPEN = 0;
    uint8 public constant ACCESS_PERMISSIONED = 1;

    /// @dev Only this address may create system paranets (creator = address(0)). Typically the Hub.
    address public authorizedSystemCreator;

    constructor(address authorizedSystemCreator_) {
        authorizedSystemCreator = authorizedSystemCreator_;
    }

    struct ParanetInfo {
        address creator;
        string name;
        string description;
        uint8 accessPolicy;
        uint40 createdAtBlock;
        bool active;
    }

    mapping(bytes32 => ParanetInfo) public paranets;

    event ParanetCreated(
        bytes32 indexed paranetId,
        address indexed creator,
        string name,
        uint8 accessPolicy
    );
    event ParanetDeactivated(bytes32 indexed paranetId);
    event ParanetMetadataUpdated(bytes32 indexed paranetId, string description);

    error ParanetAlreadyExists();
    error ParanetNotFound();
    error OnlyCreator();
    error InvalidAccessPolicy();
    error OnlyAuthorizedSystemCreator();

    function createParanetV9(
        string calldata name_,
        string calldata description_,
        uint8 accessPolicy_
    ) external returns (bytes32 paranetId) {
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        paranetId = keccak256(abi.encodePacked(msg.sender, name_));
        if (paranets[paranetId].createdAtBlock != 0) revert ParanetAlreadyExists();

        paranets[paranetId] = ParanetInfo({
            creator: msg.sender,
            name: name_,
            description: description_,
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true
        });

        emit ParanetCreated(paranetId, msg.sender, name_, accessPolicy_);
        return paranetId;
    }

    /// @notice Create a system paranet with no owner (creator = address(0)). Immutable.
    /// @dev Only authorizedSystemCreator (e.g. Hub) may call. paranetId = keccak256(abi.encodePacked(address(0), name)).
    function createSystemParanetV9(
        string calldata name_,
        string calldata description_,
        uint8 accessPolicy_
    ) external returns (bytes32 paranetId) {
        if (msg.sender != authorizedSystemCreator) revert OnlyAuthorizedSystemCreator();
        if (accessPolicy_ > ACCESS_PERMISSIONED) revert InvalidAccessPolicy();
        paranetId = keccak256(abi.encodePacked(address(0), name_));
        if (paranets[paranetId].createdAtBlock != 0) revert ParanetAlreadyExists();

        paranets[paranetId] = ParanetInfo({
            creator: address(0),
            name: name_,
            description: description_,
            accessPolicy: accessPolicy_,
            createdAtBlock: uint40(block.number),
            active: true
        });

        emit ParanetCreated(paranetId, address(0), name_, accessPolicy_);
        return paranetId;
    }

    function getParanet(bytes32 paranetId)
        external
        view
        returns (
            address creator,
            string memory name,
            string memory description,
            uint8 accessPolicy,
            uint40 createdAtBlock,
            bool active
        )
    {
        ParanetInfo storage p = paranets[paranetId];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        return (
            p.creator,
            p.name,
            p.description,
            p.accessPolicy,
            p.createdAtBlock,
            p.active
        );
    }

    function deactivateParanet(bytes32 paranetId) external {
        ParanetInfo storage p = paranets[paranetId];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        if (p.creator != msg.sender) revert OnlyCreator();
        p.active = false;
        emit ParanetDeactivated(paranetId);
    }

    function updateParanetMetadata(bytes32 paranetId, string calldata description_) external {
        ParanetInfo storage p = paranets[paranetId];
        if (p.createdAtBlock == 0) revert ParanetNotFound();
        if (p.creator != msg.sender) revert OnlyCreator();
        p.description = description_;
        emit ParanetMetadataUpdated(paranetId, description_);
    }
}
