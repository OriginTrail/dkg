// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/**
 * @notice Test-only contract caller and EIP-7702 delegate implementation used
 * to prove RandomSampling's EOA boundary. It deliberately bubbles the target
 * revert so the test can assert the protocol error rather than a
 * wrapper-specific failure.
 */
contract MockRandomSamplingWallet {
    function createChallenge(address randomSampling) external {
        (bool ok, bytes memory returndata) = randomSampling.call(
            abi.encodeWithSignature("createChallenge()")
        );
        if (!ok) {
            assembly {
                revert(add(returndata, 0x20), mload(returndata))
            }
        }
    }
}
