// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title DKGPublishingConvictionNFT
 * @notice Publisher conviction positions as ERC-721 NFTs.
 *
 * Model:
 *   - Publisher locks `committedTRAC` for 12 epochs.
 *   - Per-epoch allowance = committedTRAC / 12.
 *   - Discount is based on discrete commitment tiers (6 tiers, 0%-50%).
 *   - On publish, discounted cost is deducted from the current epoch's allowance.
 *   - topUp() sends TRAC directly to StakingStorage and distributes across next 12 epochs.
 *   - releaseUnspentTRAC() distributes unspent epoch allowance across the next 12 epochs.
 *   - Agents are tracked per account with a governance-configurable cap.
 */
contract DKGPublishingConvictionNFT is INamed, IVersioned, ContractStatus, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGPublishingConvictionNFT";
    string private constant _VERSION = "1.0.0";

    uint256 public constant LOCK_DURATION_EPOCHS = 12;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct Account {
        uint96 committedTRAC;
        uint96 epochAllowance;    // committedTRAC / 12
        uint40 createdAtEpoch;
        uint40 expiresAtEpoch;    // createdAtEpoch + 12
    }

    IERC20 public tokenContract;
    address public stakingStorageAddress;
    address public epochStorageAddress;
    address public chronosAddress;

    uint256 private _nextAccountId;

    mapping(uint256 => Account) public accounts;
    mapping(uint256 => mapping(uint40 => uint96)) public epochSpent;
    mapping(uint256 => address[]) private _registeredAgents;
    mapping(address => uint256) public agentToAccountId;
    mapping(uint256 => mapping(address => bool)) private _isRegisteredAgent;

    uint256 public maxAgentsPerAccount;

    // --- Events ---

    event AccountCreated(uint256 indexed accountId, address indexed owner, uint96 committedTRAC, uint96 epochAllowance);
    event TopUp(uint256 indexed accountId, uint96 amount);
    event CostCovered(uint256 indexed accountId, uint40 epoch, uint96 baseCost, uint96 discountedCost);
    event AgentRegistered(uint256 indexed accountId, address indexed agent);
    event AgentDeregistered(uint256 indexed accountId, address indexed agent);
    event AllowanceThresholdReached(uint256 indexed accountId, uint40 epoch, uint8 thresholdPercent);
    event UnspentTRACReleased(uint256 indexed accountId, uint40 epoch, uint96 amount);

    // --- Errors ---

    error AccountNotFound(uint256 accountId);
    error NotAccountOwner(uint256 accountId, address caller);
    error NotAuthorizedAgent(uint256 accountId, address caller);
    error InsufficientAllowance(uint256 accountId, uint40 epoch, uint96 required, uint96 available);
    error AccountExpired(uint256 accountId, uint40 expiresAt);
    error InvalidAmount();
    error AgentAlreadyRegistered(address agent, uint256 existingAccountId);
    error AgentNotRegistered(uint256 accountId, address agent);
    error AgentCapReached(uint256 accountId, uint256 cap);
    error EpochAlreadyReleased(uint256 accountId, uint40 epoch);

    constructor(address hubAddress) ContractStatus(hubAddress) ERC721("DKG Publishing Conviction", "DKGPC") {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        try hub.getContractAddress("StakingStorage") returns (address addr) {
            stakingStorageAddress = addr;
        } catch {}
        try hub.getContractAddress("EpochStorageV8") returns (address addr) {
            epochStorageAddress = addr;
        } catch {}
        try hub.getContractAddress("Chronos") returns (address addr) {
            chronosAddress = addr;
        } catch {}

        if (_nextAccountId == 0) _nextAccountId = 1;
        if (maxAgentsPerAccount == 0) maxAgentsPerAccount = 100;
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Account Lifecycle
    // ========================================================================

    function createAccount(uint96 amount) external returns (uint256 accountId) {
        if (amount == 0) revert InvalidAmount();

        accountId = _nextAccountId++;
        uint96 allowance = amount / uint96(LOCK_DURATION_EPOCHS);
        uint40 currentEpoch = _getCurrentEpoch();

        accounts[accountId] = Account({
            committedTRAC: amount,
            epochAllowance: allowance,
            createdAtEpoch: currentEpoch,
            expiresAtEpoch: currentEpoch + uint40(LOCK_DURATION_EPOCHS)
        });

        _mint(msg.sender, accountId);

        if (!tokenContract.transferFrom(msg.sender, address(this), amount)) {
            revert InvalidAmount();
        }

        emit AccountCreated(accountId, msg.sender, amount, allowance);
    }

    /**
     * @notice Add more TRAC — transferred directly to StakingStorage and distributed
     *         across the next 12 epochs. Does not increase the PCA locked pool.
     */
    function topUp(uint256 accountId, uint96 amount) external {
        _requireOwner(accountId);
        if (amount == 0) revert InvalidAmount();

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, amount)) {
            revert InvalidAmount();
        }

        _distributeToEpochs(amount);

        emit TopUp(accountId, amount);
    }

    // ========================================================================
    // Publishing Cost Coverage
    // ========================================================================

    function coverPublishingCost(
        uint256 accountId,
        uint96 baseCost,
        address caller
    ) external onlyContracts returns (uint96) {
        _requireExists(accountId);

        if (!_isRegisteredAgent[accountId][caller] && ownerOf(accountId) != caller) {
            revert NotAuthorizedAgent(accountId, caller);
        }

        Account storage acct = accounts[accountId];
        uint40 currentEpoch = _getCurrentEpoch();

        if (currentEpoch >= acct.expiresAtEpoch) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        uint96 discountedCost = _applyDiscount(acct.committedTRAC, baseCost);
        uint96 spent = epochSpent[accountId][currentEpoch];
        uint96 available = acct.epochAllowance > spent ? acct.epochAllowance - spent : 0;

        if (discountedCost > available) {
            revert InsufficientAllowance(accountId, currentEpoch, discountedCost, available);
        }

        epochSpent[accountId][currentEpoch] = spent + discountedCost;

        if (!tokenContract.transfer(stakingStorageAddress, discountedCost)) {
            revert InvalidAmount();
        }

        _checkThresholds(accountId, currentEpoch, spent + discountedCost, acct.epochAllowance);

        emit CostCovered(accountId, currentEpoch, baseCost, discountedCost);
        return discountedCost;
    }

    // ========================================================================
    // Agent Management
    // ========================================================================

    function registerAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        if (agentToAccountId[agent] != 0) {
            revert AgentAlreadyRegistered(agent, agentToAccountId[agent]);
        }
        if (_registeredAgents[accountId].length >= maxAgentsPerAccount) {
            revert AgentCapReached(accountId, maxAgentsPerAccount);
        }

        _registeredAgents[accountId].push(agent);
        _isRegisteredAgent[accountId][agent] = true;
        agentToAccountId[agent] = accountId;

        emit AgentRegistered(accountId, agent);
    }

    function deregisterAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        if (!_isRegisteredAgent[accountId][agent]) {
            revert AgentNotRegistered(accountId, agent);
        }

        _isRegisteredAgent[accountId][agent] = false;
        agentToAccountId[agent] = 0;

        address[] storage agents = _registeredAgents[accountId];
        for (uint256 i; i < agents.length; i++) {
            if (agents[i] == agent) {
                agents[i] = agents[agents.length - 1];
                agents.pop();
                break;
            }
        }

        emit AgentDeregistered(accountId, agent);
    }

    function getRegisteredAgents(uint256 accountId) external view returns (address[] memory) {
        return _registeredAgents[accountId];
    }

    // ========================================================================
    // Unspent TRAC Release
    // ========================================================================

    /**
     * @notice Release unspent allowance from a past epoch. The unspent amount is
     *         distributed equally across the next 12 epochs via EpochStorage.
     */
    function releaseUnspentTRAC(uint256 accountId, uint40 epoch) external {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        uint40 currentEpoch = _getCurrentEpoch();

        require(epoch < currentEpoch, "Epoch not yet complete");
        require(epoch >= acct.createdAtEpoch && epoch < acct.expiresAtEpoch, "Epoch out of account range");

        uint96 spent = epochSpent[accountId][epoch];
        uint96 unspent = acct.epochAllowance > spent ? acct.epochAllowance - spent : 0;

        if (unspent == 0) revert EpochAlreadyReleased(accountId, epoch);

        epochSpent[accountId][epoch] = acct.epochAllowance;

        if (!tokenContract.transfer(stakingStorageAddress, unspent)) {
            revert InvalidAmount();
        }

        _distributeToEpochs(unspent);

        emit UnspentTRACReleased(accountId, epoch, unspent);
    }

    // ========================================================================
    // Governance
    // ========================================================================

    function setMaxAgentsPerAccount(uint256 cap) external {
        require(
            msg.sender == hub.owner() || msg.sender == address(hub),
            "Only Hub Owner or Hub"
        );
        maxAgentsPerAccount = cap;
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    function getDiscountBps(uint96 committedTRAC) public pure returns (uint256) {
        if (committedTRAC >= 1_000_000 ether) return 5000;  // 50%
        if (committedTRAC >= 500_000 ether)   return 4000;  // 40%
        if (committedTRAC >= 250_000 ether)   return 3000;  // 30%
        if (committedTRAC >= 100_000 ether)   return 2000;  // 20%
        if (committedTRAC >= 50_000 ether)    return 1000;  // 10%
        return 0;
    }

    function getDiscount(uint256 accountId) external view returns (uint256) {
        _requireExists(accountId);
        return getDiscountBps(accounts[accountId].committedTRAC);
    }

    function getDiscountedCost(uint256 accountId, uint96 baseCost) external view returns (uint96) {
        _requireExists(accountId);
        return _applyDiscount(accounts[accountId].committedTRAC, baseCost);
    }

    function getAccountInfo(uint256 accountId) external view returns (
        address owner_,
        uint96 committedTRAC,
        uint96 epochAllowance,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch,
        uint256 discountBps,
        uint256 agentCount
    ) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        return (
            ownerOf(accountId),
            acct.committedTRAC,
            acct.epochAllowance,
            acct.createdAtEpoch,
            acct.expiresAtEpoch,
            getDiscountBps(acct.committedTRAC),
            _registeredAgents[accountId].length
        );
    }

    function getEpochSpent(uint256 accountId, uint40 epoch) external view returns (uint96) {
        return epochSpent[accountId][epoch];
    }

    function getRemainingAllowance(uint256 accountId, uint40 epoch) external view returns (uint96) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        uint96 spent = epochSpent[accountId][epoch];
        return acct.epochAllowance > spent ? acct.epochAllowance - spent : 0;
    }

    // ========================================================================
    // Internal
    // ========================================================================

    function _requireExists(uint256 accountId) internal view {
        _requireOwned(accountId);
    }

    function _requireOwner(uint256 accountId) internal view {
        _requireExists(accountId);
        if (ownerOf(accountId) != msg.sender) {
            revert NotAccountOwner(accountId, msg.sender);
        }
    }

    function _applyDiscount(uint96 committedTRAC, uint96 baseCost) internal pure returns (uint96) {
        uint256 discountBps = getDiscountBps(committedTRAC);
        return uint96(uint256(baseCost) * (BPS_DENOMINATOR - discountBps) / BPS_DENOMINATOR);
    }

    function _getCurrentEpoch() internal view returns (uint40) {
        if (chronosAddress == address(0)) return 1;
        (bool ok, bytes memory ret) = chronosAddress.staticcall(
            abi.encodeWithSignature("getCurrentEpoch()")
        );
        if (!ok || ret.length < 32) return 1;
        return uint40(abi.decode(ret, (uint256)));
    }

    function _distributeToEpochs(uint96 amount) internal {
        if (epochStorageAddress == address(0)) return;
        uint40 currentEpoch = _getCurrentEpoch();
        uint40 startEpoch = currentEpoch + 1;
        uint40 endEpoch = currentEpoch + uint40(LOCK_DURATION_EPOCHS);

        (bool ok,) = epochStorageAddress.call(
            abi.encodeWithSignature(
                "addTokensToEpochRange(uint256,uint256,uint256,uint96)",
                uint256(1),
                uint256(startEpoch),
                uint256(endEpoch),
                amount
            )
        );
        require(ok, "EpochStorage distribution failed");
    }

    function _checkThresholds(
        uint256 accountId,
        uint40 epoch,
        uint96 totalSpent,
        uint96 allowance
    ) internal {
        if (allowance == 0) return;
        uint256 pct = (uint256(totalSpent) * 100) / uint256(allowance);
        uint96 prevSpent = totalSpent > allowance ? allowance : totalSpent;
        uint256 prevPct = prevSpent > 0 ? ((uint256(prevSpent) - 1) * 100) / uint256(allowance) : 0;

        if (pct >= 100 && prevPct < 100) {
            emit AllowanceThresholdReached(accountId, epoch, 100);
        } else if (pct >= 80 && prevPct < 80) {
            emit AllowanceThresholdReached(accountId, epoch, 80);
        } else if (pct >= 50 && prevPct < 50) {
            emit AllowanceThresholdReached(accountId, epoch, 50);
        }
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view virtual override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal virtual override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal virtual override(ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }
}
