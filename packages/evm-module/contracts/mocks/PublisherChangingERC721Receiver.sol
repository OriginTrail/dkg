// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IPublisherHistory {
    function pushMerkleRoot(address publisher, uint256 id, bytes32 root) external;
}

/// @dev Test-only receiver: a Hub-authorized callback changes the latest root.
contract PublisherChangingERC721Receiver is IERC721Receiver {
    address private immutable _storage;
    address private immutable _publisher;

    constructor(address storageAddress, address publisher) {
        _storage = storageAddress;
        _publisher = publisher;
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == _storage, "Unexpected token");
        IPublisherHistory(_storage).pushMerkleRoot(_publisher, id, keccak256("callback-root"));
        return IERC721Receiver.onERC721Received.selector;
    }
}
