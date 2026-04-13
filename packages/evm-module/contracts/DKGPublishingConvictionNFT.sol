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
        uint40 expiresAtEpoch;    // may be extended by topUp
        uint40 originalExpiresAtEpoch; // createdAtEpoch + 12, never extended
    }

    IERC20 public tokenContract;
    address public stakingStorageAddress;
    address public chronosAddress;

    uint256 private _nextAccountId;

    mapping(uint256 => Account) public accounts;
    mapping(uint256 => mapping(uint40 => uint96)) public epochSpent;
    mapping(uint256 => mapping(uint40 => uint96)) public topUpCredits;
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

    constructor(address hubAddress) ContractStatus(hubAddress) ERC721("DKG Publishing Conviction", "DKGPC") {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        try hub.getContractAddress("StakingStorage") returns (address addr) {
            stakingStorageAddress = addr;
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
        uint96 remainder = amount - (allowance * uint96(LOCK_DURATION_EPOCHS));
        uint40 currentEpoch = _getCurrentEpoch();

        uint40 expiry = currentEpoch + uint40(LOCK_DURATION_EPOCHS);
        accounts[accountId] = Account({
            committedTRAC: amount,
            epochAllowance: allowance,
            createdAtEpoch: currentEpoch,
            expiresAtEpoch: expiry,
            originalExpiresAtEpoch: expiry
        });

        // Credit truncation remainder to the first epoch so no TRAC is stranded
        if (remainder > 0) {
            topUpCredits[accountId][currentEpoch] += remainder;
        }

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

        Account storage acct = accounts[accountId];
        uint40 currentEpoch = _getCurrentEpoch();
        if (currentEpoch >= acct.expiresAtEpoch) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        // Top-ups do NOT increase committedTRAC (discount tier) — they only add
        // spending capacity. The top-up amount is distributed over the remaining
        // epochs, not the global epochAllowance, to avoid over-allocating
        // on old epochs.
        //
        // Extend expiry by 12 epochs from now so top-up funds have a full window.
        uint40 newExpiry = currentEpoch + uint40(LOCK_DURATION_EPOCHS);
        if (newExpiry > acct.expiresAtEpoch) {
            acct.expiresAtEpoch = newExpiry;
        }

        uint40 remainingEpochs = acct.expiresAtEpoch > currentEpoch
            ? acct.expiresAtEpoch - currentEpoch
            : 1;
        uint96 perEpochTopUp = amount / uint96(remainingEpochs);
        uint96 topUpRemainder = amount - (perEpochTopUp * uint96(remainingEpochs));
        // Credit each remaining epoch individually so historical epochs aren't inflated
        for (uint40 e = currentEpoch; e < acct.expiresAtEpoch; e++) {
            topUpCredits[accountId][e] += perEpochTopUp;
        }
        // Credit truncation remainder to the current epoch so no TRAC is stranded
        if (topUpRemainder > 0) {
            topUpCredits[accountId][currentEpoch] += topUpRemainder;
        }

        if (!tokenContract.transferFrom(msg.sender, address(this), amount)) {
            revert InvalidAmount();
        }

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
        // Base allowance only applies within the original commitment window
        uint96 baseForEpoch = currentEpoch < acct.originalExpiresAtEpoch ? acct.epochAllowance : 0;
        uint96 epochCap = baseForEpoch + topUpCredits[accountId][currentEpoch];
        uint96 available = epochCap > spent ? epochCap - spent : 0;

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
        uint96 baseForEpoch = epoch < acct.originalExpiresAtEpoch ? acct.epochAllowance : 0;
        uint96 epochCap = baseForEpoch + topUpCredits[accountId][epoch];
        return epochCap > spent ? epochCap - spent : 0;
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
        address from = super._update(to, tokenId, auth);

        // Clear agent registrations on transfer (not mint/burn)
        if (from != address(0) && to != address(0) && from != to) {
            address[] storage agents = _registeredAgents[tokenId];
            for (uint256 i; i < agents.length; i++) {
                _isRegisteredAgent[tokenId][agents[i]] = false;
                agentToAccountId[agents[i]] = 0;
            }
            delete _registeredAgents[tokenId];
        }

        return from;
    }
}
