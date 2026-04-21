// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {IContractStatus} from "../interfaces/IContractStatus.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {HubLib} from "../libraries/HubLib.sol";
import {UnorderedNamedContractDynamicSet} from "../libraries/UnorderedNamedContractDynamicSet.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract Hub is INamed, IVersioned, Ownable {
    using UnorderedNamedContractDynamicSet for UnorderedNamedContractDynamicSet.Set;

    /// @dev Re-declared here purely so the error selector appears in Hub's ABI.
    /// All HubDependent contracts revert with `HubLib.UnauthorizedAccess(...)`.
    /// Tests historically pin `revertedWithCustomError(HubContract, 'UnauthorizedAccess')`
    /// even when the actual revert originates in HubDependent. Without this
    /// declaration, hardhat-chai-matchers cannot resolve the selector from
    /// the Hub ABI and tests blow up with
    /// "The given contract doesn't have a custom error named 'UnauthorizedAccess'".
    /// This is a pure ABI-surface declaration; Hub itself never emits it
    /// (it uses `OwnableUnauthorizedAccount` from OZ Ownable v5 — see
    /// `_checkOwnerOrMultiSigOwner`).
    error UnauthorizedAccess(string msg);

    event NewContract(string contractName, address newContractAddress);
    event ContractChanged(string contractName, address newContractAddress);
    event NewAssetStorage(string contractName, address newContractAddress);
    event AssetStorageChanged(string contractName, address newContractAddress);
    event ContractRemoved(string contractName, address contractAddress);
    event AssetStorageRemoved(string contractName, address contractAddress);

    string private constant _NAME = "Hub";
    string private constant _VERSION = "1.0.0";

    UnorderedNamedContractDynamicSet.Set internal contractSet;
    UnorderedNamedContractDynamicSet.Set internal assetStorageSet;

    constructor() Ownable(msg.sender) {}

    // @dev Only transactions by HubController owner or one of the owners of the MultiSig Wallet
    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function setContractAddress(
        string calldata contractName,
        address newContractAddress
    ) external onlyOwnerOrMultiSigOwner {
        _setContractAddress(contractName, newContractAddress);
    }

    function setAssetStorageAddress(string calldata assetStorageName, address assetStorageAddress) external onlyOwner {
        _setAssetStorageAddress(assetStorageName, assetStorageAddress);
    }

    function removeContractByName(string calldata contractName) external onlyOwner {
        if (contractSet.exists(contractName)) {
            address contractAddress = contractSet.get(contractName).addr;

            contractSet.remove(contractName);

            emit ContractRemoved(contractName, contractAddress);
        }
    }

    function removeContractByAddress(address contractAddress) external onlyOwner {
        if (contractSet.exists(contractAddress)) {
            string memory contractName = contractSet.get(contractAddress).name;

            contractSet.remove(contractAddress);

            emit ContractRemoved(contractName, contractAddress);
        }
    }

    function removeAssetStorageByName(string calldata assetStorageName) external onlyOwner {
        if (assetStorageSet.exists(assetStorageName)) {
            address assetStorageAddress = assetStorageSet.get(assetStorageName).addr;

            assetStorageSet.remove(assetStorageName);

            emit AssetStorageRemoved(assetStorageName, assetStorageAddress);
        }
    }

    function removeAssetStorageByAddress(address assetStorageAddress) external onlyOwner {
        if (assetStorageSet.exists(assetStorageAddress)) {
            string memory assetStorageName = assetStorageSet.get(assetStorageAddress).name;

            assetStorageSet.remove(assetStorageAddress);

            emit AssetStorageRemoved(assetStorageName, assetStorageAddress);
        }
    }

    function getContractAddress(string calldata contractName) external view returns (address) {
        return contractSet.get(contractName).addr;
    }

    function getAssetStorageAddress(string calldata assetStorageName) external view returns (address) {
        return assetStorageSet.get(assetStorageName).addr;
    }

    function getAllContracts() external view returns (UnorderedNamedContractDynamicSet.Contract[] memory) {
        return contractSet.getAll();
    }

    function getAllAssetStorages() external view returns (UnorderedNamedContractDynamicSet.Contract[] memory) {
        return assetStorageSet.getAll();
    }

    function isContract(string calldata contractName) external view returns (bool) {
        return contractSet.exists(contractName);
    }

    function isContract(address selectedContractAddress) external view returns (bool) {
        return contractSet.exists(selectedContractAddress);
    }

    function isAssetStorage(string calldata assetStorageName) external view returns (bool) {
        return assetStorageSet.exists(assetStorageName);
    }

    function isAssetStorage(address assetStorageAddress) external view returns (bool) {
        return assetStorageSet.exists(assetStorageAddress);
    }

    /**
     * @dev Forwards a function call to a specified target contract.
     * @notice This function can only be called by the contract owner or a multisig owner.
     * @param target The address of the target contract.
     * @param data The calldata containing the function signature and arguments for the target contract's function.
     * @return result The return data of the target contract's function call.
     */
    function forwardCall(address target, bytes calldata data) public onlyOwnerOrMultiSigOwner returns (bytes memory) {
        // Check if the target contract is registered in the Hub
        if (!contractSet.exists(target) && !assetStorageSet.exists(target)) {
            revert HubLib.InvalidTargetContract(target);
        }

        // Perform the function call to the target contract with the specified calldata
        (bool success, bytes memory result) = target.call{value: 0}(data);

        // If the call is unsuccessful, revert the transaction with the original revert reason
        if (!success) {
            assembly {
                // Load the free memory pointer from memory slot 0x40
                // Memory slot 0x40 is conventionally used to store the free memory pointer in Solidity, which points
                // to the next available memory slot for storing data during the execution of a contract function.
                let ptr := mload(0x40)
                // Get the size of the return data from the unsuccessful call
                let size := returndatasize()
                // Copy the return data to the memory location pointed to by ptr
                returndatacopy(ptr, 0, size)
                // Revert the transaction with the return data as the revert reason
                revert(ptr, size)
            }
        }

        return result;
    }

    function setAndReinitializeContracts(
        HubLib.Contract[] calldata newContracts,
        HubLib.Contract[] calldata newAssetStorageContracts,
        address[] calldata contractsToReinitialize,
        HubLib.ForwardCallInputArgs[] calldata forwardCallsData
    ) external onlyOwnerOrMultiSigOwner {
        _setContracts(newContracts);
        _setAssetStorageContracts(newAssetStorageContracts);
        _reinitializeContracts(contractsToReinitialize);
        _forwardCalls(forwardCallsData);
    }

    function _setContractAddress(string calldata contractName, address newContractAddress) internal {
        if (contractSet.exists(contractName)) {
            contractSet.update(contractName, newContractAddress);

            address oldContractAddress = contractSet.get(contractName).addr;
            if (_isContract(oldContractAddress)) {
                try IContractStatus(oldContractAddress).setStatus(false) {
                    // success
                } catch {
                    // Best-effort: contract may not implement IContractStatus; ignore.
                }
            }

            emit ContractChanged(contractName, newContractAddress);
        } else {
            contractSet.append(contractName, newContractAddress);

            emit NewContract(contractName, newContractAddress);
        }

        if (_isContract(newContractAddress)) {
            try IContractStatus(newContractAddress).setStatus(true) {
                // success
            } catch {
                // Best-effort: contract may not implement IContractStatus; ignore.
            }
        }
    }

    function _setContracts(HubLib.Contract[] calldata newContracts) internal {
        for (uint256 i; i < newContracts.length; ) {
            _setContractAddress(newContracts[i].name, newContracts[i].addr);

            unchecked {
                i++;
            }
        }
    }

    function _setAssetStorageAddress(string calldata assetStorageName, address assetStorageAddress) internal {
        if (assetStorageSet.exists(assetStorageName)) {
            emit AssetStorageChanged(assetStorageName, assetStorageAddress);
            assetStorageSet.update(assetStorageName, assetStorageAddress);
        } else {
            emit NewAssetStorage(assetStorageName, assetStorageAddress);
            assetStorageSet.append(assetStorageName, assetStorageAddress);
        }
    }

    function _setAssetStorageContracts(HubLib.Contract[] calldata newAssetStorageContracts) internal {
        for (uint256 i; i < newAssetStorageContracts.length; ) {
            _setAssetStorageAddress(newAssetStorageContracts[i].name, newAssetStorageContracts[i].addr);

            unchecked {
                i++;
            }
        }
    }

    function _reinitializeContracts(address[] calldata contractsToReinitialize) internal {
        for (uint256 i; i < contractsToReinitialize.length; ) {
            IInitializable(contractsToReinitialize[i]).initialize();
            unchecked {
                i++;
            }
        }
    }

    function _forwardCalls(HubLib.ForwardCallInputArgs[] calldata forwardCallsData) internal {
        for (uint256 i; i < forwardCallsData.length; ) {
            address contractAddress;

            // Try to get the contract address using getContractAddress
            try this.getContractAddress(forwardCallsData[i].contractName) returns (address addr) {
                contractAddress = addr;
            } catch {
                // If getContractAddress fails, try getAssetStorageAddress
                try this.getAssetStorageAddress(forwardCallsData[i].contractName) returns (address addr) {
                    contractAddress = addr;
                } catch {
                    revert HubLib.ContractNotRegistered(forwardCallsData[i].contractName);
                }
            }
            for (uint256 j; j < forwardCallsData[i].encodedData.length; ) {
                forwardCall(contractAddress, forwardCallsData[i].encodedData[j]);
                unchecked {
                    j++;
                }
            }
            unchecked {
                i++;
            }
        }
    }

    function _isContract(address addr) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(addr)
        }
        return size > 0;
    }

    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
        // EOA-safe: without this short-circuit the compiler-inserted
        // extcodesize guard on the try-external call reverts with empty
        // data instead of falling through to the caller's typed revert.
        if (multiSigAddress.code.length == 0) {
            return false;
        }
        try ICustodian(multiSigAddress).getOwners() returns (address[] memory multiSigOwners) {
            for (uint256 i = 0; i < multiSigOwners.length; i++) {
                if (msg.sender == multiSigOwners[i]) {
                    return true;
                }
            }
        } catch {
            // Not a multisig or call reverted; treat as not owner.
        }

        return false;
    }

    function _checkOwnerOrMultiSigOwner() internal view virtual {
        address hubOwner = owner();
        // Spec: align with OZ Ownable v5 — privileged-call rejection raises
        // `OwnableUnauthorizedAccount(msg.sender)` so indexers + clients can
        // route on the same selector that `_checkOwner` produces.
        // See BUGS_FOUND.md "OwnableUnauthorizedAccount vs UnauthorizedAccess"
        // (Solidity coverage shards 3/4 + 4/4).
        if (msg.sender != hubOwner && !_isMultiSigOwner(hubOwner)) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }
}
