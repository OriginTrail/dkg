// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {HubDependent} from "./abstract/HubDependent.sol";
import {Chronos} from "./storage/Chronos.sol";
import {EpochStorage} from "./storage/EpochStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

/**
 * @title DKGPublishingConvictionNFT
 * @notice Publisher conviction accounts as transferable ERC-721 NFTs.
 *
 * V10 flow-through model:
 *   - At createAccount, `committedTRAC` is moved DIRECTLY from the publisher to
 *     `StakingStorage` (the contract NEVER holds TRAC) and the full 12-epoch
 *     allowance is distributed to the staker reward pool via
 *     `EpochStorage.addTokensToEpochRange`.
 *   - The contract stores accounting only: per-account epoch spend and a
 *     persistent `topUpBalance` buffer.
 *   - Discount tier is fixed by `committedTRAC` at creation (6-tier ladder,
 *     0%-75%). topUp does NOT change the tier or extend expiry.
 *   - `coverPublishingCost` is callable only by `KnowledgeAssetsV10` and
 *     receives the publishing agent (the outer tx's msg.sender) rather than a
 *     caller-supplied accountId. The NFT auto-resolves the paying account via
 *     `agentToAccountId`, which closes N28 (a trusted caller could otherwise
 *     pass a victim's accountId and drain their allowance). It deducts from
 *     the current epoch allowance first, then from `topUpBalance`, and does
 *     NOT move TRAC — TRAC already lives in StakingStorage.
 *   - The legacy unspent-TRAC release function is gone: the flow-through
 *     design eliminates it.
 *   - Agents are tracked per account with a governance-configurable cap, and
 *     the reverse map `agentToAccountId` is public so callers can auto-resolve
 *     the paying account without caller-supplied authorization.
 */
contract DKGPublishingConvictionNFT is INamed, IVersioned, HubDependent, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGPublishingConvictionNFT";
    string private constant _VERSION = "2.0.0";

    uint256 public constant LOCK_DURATION_EPOCHS = 12;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant STAKER_SHARD_ID = 1;

    struct Account {
        uint96 committedTRAC;
        uint40 createdAtEpoch;
        uint40 expiresAtEpoch; // createdAtEpoch + LOCK_DURATION_EPOCHS, never extended
        uint16 discountBps;    // fixed at creation
    }

    IERC20 public tokenContract;
    address public stakingStorageAddress;
    EpochStorage public epochStorage;
    Chronos public chronos;

    uint256 private _nextAccountId;

    mapping(uint256 => Account) public accounts;
    /// @notice Per-epoch spent amount counted against the `committedTRAC / 12`
    /// base allowance. `coverPublishingCost` updates this before touching
    /// `topUpBalance`.
    mapping(uint256 => mapping(uint40 => uint96)) public epochSpent;
    /// @notice Persistent top-up buffer per account (NOT per-epoch). Drained
    /// only after the current-epoch base allowance is exhausted.
    mapping(uint256 => uint96) public topUpBalance;

    mapping(uint256 => address[]) private _registeredAgents;
    /// @dev `accountId == 0` is the "not registered" sentinel (_nextAccountId starts at 1).
    mapping(address => uint256) public agentToAccountId;
    mapping(uint256 => mapping(address => bool)) private _isRegisteredAgent;

    uint256 public maxAgentsPerAccount;

    // --- Events ---

    event AccountCreated(
        uint256 indexed accountId,
        address indexed owner,
        uint96 committedTRAC,
        uint16 discountBps,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch
    );
    event ToppedUp(uint256 indexed accountId, uint96 amount, uint96 newTopUpBalance);
    event CostCovered(
        uint256 indexed accountId,
        uint40 indexed epoch,
        uint96 baseCost,
        uint96 discountedCost,
        uint96 drawnFromEpoch,
        uint96 drawnFromTopUp
    );
    event AgentRegistered(uint256 indexed accountId, address indexed agent);
    event AgentDeregistered(uint256 indexed accountId, address indexed agent);

    // --- Errors ---

    error ZeroAddressDependency(string name);
    error NoConvictionAccount(address publishingAgent);
    error OnlyKnowledgeAssetsV10(address caller);
    error NotAccountOwner(uint256 accountId, address caller);
    error InsufficientAllowance(uint256 accountId, uint40 epoch, uint96 required, uint96 available);
    error AccountExpired(uint256 accountId, uint40 expiresAt);
    error InvalidAmount();
    error ZeroAgentAddress();
    error AgentAlreadyRegistered(address agent, uint256 existingAccountId);
    error AgentNotRegistered(uint256 accountId, address agent);
    error AgentCapReached(uint256 accountId, uint256 cap);
    error TokenTransferFailed();

    constructor(address hubAddress) HubDependent(hubAddress) ERC721("DKG Publishing Conviction", "DKGPC") {}

    function initialize() public onlyHub {
        address token = hub.getContractAddress("Token");
        if (token == address(0)) revert ZeroAddressDependency("Token");
        tokenContract = IERC20(token);

        address ss = hub.getContractAddress("StakingStorage");
        if (ss == address(0)) revert ZeroAddressDependency("StakingStorage");
        stakingStorageAddress = ss;

        address es = hub.getContractAddress("EpochStorageV8");
        if (es == address(0)) revert ZeroAddressDependency("EpochStorageV8");
        epochStorage = EpochStorage(es);

        address ch = hub.getContractAddress("Chronos");
        if (ch == address(0)) revert ZeroAddressDependency("Chronos");
        chronos = Chronos(ch);

        // accountId == 0 is the "not registered" sentinel for agentToAccountId.
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

    /**
     * @notice Create a new publisher conviction account.
     *
     * TRAC flow (fail-closed; any sub-call revert reverts the whole tx):
     *   1. `committedTRAC` is pulled from msg.sender directly into StakingStorage.
     *   2. The full amount is distributed across the next 12 epochs of the
     *      staker reward pool via EpochStorage.addTokensToEpochRange.
     *   3. Accounting state (Account struct) is written.
     *   4. An ERC-721 token is minted to msg.sender.
     *
     * The contract NEVER holds TRAC. Discount tier is fixed at creation.
     */
    function createAccount(uint96 committedTRAC) external returns (uint256 accountId) {
        if (committedTRAC == 0) revert InvalidAmount();

        accountId = _nextAccountId++;
        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        uint40 expiresAtEpoch = currentEpoch + uint40(LOCK_DURATION_EPOCHS);
        uint16 discountBps = uint16(getDiscountBps(committedTRAC));

        accounts[accountId] = Account({
            committedTRAC: committedTRAC,
            createdAtEpoch: currentEpoch,
            expiresAtEpoch: expiresAtEpoch,
            discountBps: discountBps
        });

        _mint(msg.sender, accountId);

        // Direct publisher -> StakingStorage transfer. Contract never holds TRAC.
        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, committedTRAC)) {
            revert TokenTransferFailed();
        }

        // Distribute the full committed amount across the 12-epoch lock window
        // (inclusive) so stakers receive it regardless of publish activity.
        epochStorage.addTokensToEpochRange(
            STAKER_SHARD_ID,
            currentEpoch,
            expiresAtEpoch - 1,
            committedTRAC
        );

        emit AccountCreated(accountId, msg.sender, committedTRAC, discountBps, currentEpoch, expiresAtEpoch);
    }

    /**
     * @notice Add TRAC to an existing account's persistent top-up balance.
     *
     * TRAC flows publisher -> StakingStorage directly, and is distributed across
     * the REMAINING epochs of the original account lifetime (current epoch
     * through expiresAtEpoch-1). Does NOT extend expiry or change the discount
     * tier.
     */
    function topUp(uint256 accountId, uint96 amount) external {
        _requireOwner(accountId);
        if (amount == 0) revert InvalidAmount();

        Account storage acct = accounts[accountId];
        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        if (currentEpoch >= acct.expiresAtEpoch) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        topUpBalance[accountId] += amount;

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, amount)) {
            revert TokenTransferFailed();
        }

        // Distribute across remaining lifetime: [currentEpoch, expiresAtEpoch - 1]
        epochStorage.addTokensToEpochRange(
            STAKER_SHARD_ID,
            currentEpoch,
            acct.expiresAtEpoch - 1,
            amount
        );

        emit ToppedUp(accountId, amount, topUpBalance[accountId]);
    }

    // ========================================================================
    // Publishing Cost Coverage
    // ========================================================================

    /**
     * @notice Deduct the discounted publishing cost from the account bound to
     *         `publishingAgent`. Callable ONLY by KnowledgeAssetsV10.
     *
     * N28 fix: the caller does NOT pass an `accountId`. It passes the outer
     * transaction's `msg.sender` (the publishing agent). The NFT resolves the
     * paying account via the on-chain `agentToAccountId` reverse map. This
     * removes the victim-account-drain vector where a trusted caller could
     * pass any account id.
     *
     * The function is further gated to `KnowledgeAssetsV10` (resolved lazily
     * from Hub on every call). Any other Hub-registered contract reverts with
     * `OnlyKnowledgeAssetsV10`. KAV10 is trusted to pass its own `msg.sender`
     * as the publishing agent, so a malicious EOA going through KAV10 can
     * only drain its own conviction account.
     *
     * Spend order: current-epoch base allowance (committedTRAC / 12) first,
     * then `topUpBalance`. Reverts if the combined balance is insufficient.
     *
     * Does NOT move TRAC — TRAC already lives in StakingStorage from
     * createAccount/topUp. Returns the discounted amount for KAV10's internal
     * accounting.
     */
    function coverPublishingCost(
        address publishingAgent,
        uint96 baseCost
    ) external returns (uint96 discountedCost) {
        address kav10 = hub.getContractAddress("KnowledgeAssetsV10");
        if (msg.sender != kav10) revert OnlyKnowledgeAssetsV10(msg.sender);

        uint256 accountId = agentToAccountId[publishingAgent];
        if (accountId == 0) revert NoConvictionAccount(publishingAgent);

        Account storage acct = accounts[accountId];

        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        if (currentEpoch >= acct.expiresAtEpoch) {
            revert AccountExpired(accountId, acct.expiresAtEpoch);
        }

        discountedCost = uint96(
            (uint256(baseCost) * (BPS_DENOMINATOR - uint256(acct.discountBps))) / BPS_DENOMINATOR
        );

        uint96 baseAllowance = acct.committedTRAC / uint96(LOCK_DURATION_EPOCHS);
        uint96 spent = epochSpent[accountId][currentEpoch];
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;

        uint96 drawnFromEpoch;
        uint96 drawnFromTopUp;

        if (discountedCost <= epochRemaining) {
            drawnFromEpoch = discountedCost;
        } else {
            drawnFromEpoch = epochRemaining;
            uint96 shortfall = discountedCost - epochRemaining;
            uint96 buffer = topUpBalance[accountId];
            if (shortfall > buffer) {
                revert InsufficientAllowance(
                    accountId,
                    currentEpoch,
                    discountedCost,
                    epochRemaining + buffer
                );
            }
            drawnFromTopUp = shortfall;
            topUpBalance[accountId] = buffer - shortfall;
        }

        if (drawnFromEpoch > 0) {
            epochSpent[accountId][currentEpoch] = spent + drawnFromEpoch;
        }

        emit CostCovered(accountId, currentEpoch, baseCost, discountedCost, drawnFromEpoch, drawnFromTopUp);
    }

    // ========================================================================
    // Agent Management
    // ========================================================================

    function registerAgent(uint256 accountId, address agent) external {
        _requireOwner(accountId);
        if (agent == address(0)) revert ZeroAgentAddress();
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
        uint256 len = agents.length;
        for (uint256 i; i < len; i++) {
            if (agents[i] == agent) {
                agents[i] = agents[len - 1];
                agents.pop();
                break;
            }
        }

        emit AgentDeregistered(accountId, agent);
    }

    function getRegisteredAgents(uint256 accountId) external view returns (address[] memory) {
        return _registeredAgents[accountId];
    }

    function isAgent(uint256 accountId, address agent) external view returns (bool) {
        return _isRegisteredAgent[accountId][agent];
    }

    // ========================================================================
    // Governance
    // ========================================================================

    function setMaxAgentsPerAccount(uint256 cap) external onlyHubOwner {
        maxAgentsPerAccount = cap;
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    /// @notice Discrete 6-tier discount ladder (published-docs version).
    ///         Tiers are evaluated highest-first so the largest commit that
    ///         qualifies is selected.
    function getDiscountBps(uint96 committedTRAC) public pure returns (uint256) {
        if (committedTRAC >= 1_000_000 ether) return 7500; // 75%
        if (committedTRAC >= 500_000 ether)   return 5000; // 50%
        if (committedTRAC >= 250_000 ether)   return 4000; // 40%
        if (committedTRAC >= 100_000 ether)   return 3000; // 30%
        if (committedTRAC >= 50_000 ether)    return 2000; // 20%
        if (committedTRAC >= 25_000 ether)    return 1000; // 10%
        return 0;
    }

    function getDiscount(uint256 accountId) external view returns (uint256) {
        _requireExists(accountId);
        return accounts[accountId].discountBps;
    }

    function getDiscountedCost(uint256 accountId, uint96 baseCost) external view returns (uint96) {
        _requireExists(accountId);
        uint256 bps = accounts[accountId].discountBps;
        return uint96((uint256(baseCost) * (BPS_DENOMINATOR - bps)) / BPS_DENOMINATOR);
    }

    function getAccountInfo(uint256 accountId) external view returns (
        address owner_,
        uint96 committedTRAC,
        uint96 baseEpochAllowance,
        uint40 createdAtEpoch,
        uint40 expiresAtEpoch,
        uint16 discountBps,
        uint96 topUpBuffer,
        uint256 agentCount
    ) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        return (
            ownerOf(accountId),
            acct.committedTRAC,
            acct.committedTRAC / uint96(LOCK_DURATION_EPOCHS),
            acct.createdAtEpoch,
            acct.expiresAtEpoch,
            acct.discountBps,
            topUpBalance[accountId],
            _registeredAgents[accountId].length
        );
    }

    function getRemainingAllowance(uint256 accountId, uint40 epoch) external view returns (uint96) {
        _requireExists(accountId);
        Account storage acct = accounts[accountId];
        uint96 baseAllowance = acct.committedTRAC / uint96(LOCK_DURATION_EPOCHS);
        uint96 spent = epochSpent[accountId][epoch];
        uint96 epochRemaining = spent < baseAllowance ? baseAllowance - spent : 0;
        return epochRemaining + topUpBalance[accountId];
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

        // Clear agent registrations on transfer (not mint/burn).
        if (from != address(0) && to != address(0) && from != to) {
            address[] storage agents = _registeredAgents[tokenId];
            uint256 len = agents.length;
            for (uint256 i; i < len; i++) {
                _isRegisteredAgent[tokenId][agents[i]] = false;
                agentToAccountId[agents[i]] = 0;
            }
            delete _registeredAgents[tokenId];
        }

        return from;
    }
}
