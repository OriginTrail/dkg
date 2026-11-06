// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

/// @title MockQueryInferenceReader
/// @notice Test-only stand-in for a contract that reads the query/inference
///         pool, as `QueryInferenceSettlement` and `StakingV10` 10.1.0 do: it
///         answers `queryInferenceStorage()` with the storage it is given, so a
///         test can register it in the Hub under either name.
contract MockQueryInferenceReader {
    address public queryInferenceStorage;

    constructor(address storageAddress) {
        queryInferenceStorage = storageAddress;
    }
}
