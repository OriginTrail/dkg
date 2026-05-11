// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "solady/src/utils/ECDSA.sol";

/**
 * @title MockERC1271Wallet
 * @notice Minimal smart-contract wallet for testing the RFC-001 author
 *         attestation EIP-1271 dispatch in `KnowledgeAssetsV10`.
 *
 * The wallet has a single configured EOA "signer". `isValidSignature` recovers
 * the signer from `(hash, signature)` (65-byte `(r, s, v)` form, as expected
 * by `KnowledgeAssetsV10._verifyAuthorAttestation`) and returns the EIP-1271
 * magic value `0x1626ba7e` if the recovered address equals the configured
 * signer. A `forceFailure` flag lets tests exercise the negative branch
 * without forging an invalid signature.
 *
 * Test-only — not deployed in production. Lives outside the staked contract
 * set so it never participates in real ACK quorums.
 */
contract MockERC1271Wallet is IERC1271 {
    bytes4 internal constant _MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant _INVALID_VALUE = 0xffffffff;

    address public signer;
    bool public forceFailure;

    constructor(address _signer) {
        signer = _signer;
    }

    function setSigner(address _signer) external {
        signer = _signer;
    }

    function setForceFailure(bool _force) external {
        forceFailure = _force;
    }

    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view override returns (bytes4) {
        if (forceFailure) {
            return _INVALID_VALUE;
        }
        if (signature.length != 65) {
            return _INVALID_VALUE;
        }
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        address recovered = ECDSA.tryRecover(hash, v, r, s);
        if (recovered != address(0) && recovered == signer) {
            return _MAGIC_VALUE;
        }
        return _INVALID_VALUE;
    }
}
