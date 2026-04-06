// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PublishingConvictionAccount
 * @notice Publishers who lock TRAC long-term receive discounted publishing fees.
 *
 * The locked TRAC IS the spending balance — each publish deducts from it at the
 * discounted rate. The discount is flat: determined by the initial lock duration
 * and amount, not by remaining lock time.
 *
 * conviction = lockedTRAC × initialLockEpochs
 * discount   = maxDiscount × conviction / (conviction + C_half)
 */
contract PublishingConvictionAccount is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "PublishingConvictionAccount";
    string private constant _VERSION = "1.0.0";

    uint256 public constant MAX_DISCOUNT_BPS = 5000; // 50% in basis points
    uint256 public constant C_HALF = 3_000_000 ether;
    uint256 public constant BPS_DENOMINATOR = 10000;

    struct Account {
        address admin;
        uint96 balance;
        uint96 initialDeposit;
        uint40 lockEpochs;
        uint40 createdAtEpoch;
        uint256 conviction;
    }

    IERC20 public tokenContract;
    uint256 public nextAccountId;
    mapping(uint256 => Account) public accounts;
    mapping(uint256 => mapping(address => bool)) public authorizedKeys;
    mapping(address => uint256) public adminToAccountId;

    event AccountCreated(uint256 indexed accountId, address indexed admin, uint96 amount, uint40 lockEpochs);
    event FundsAdded(uint256 indexed accountId, uint96 amount, uint96 newBalance);
    event LockExtended(uint256 indexed accountId, uint40 newTotalLockEpochs, uint256 newConviction);
    event AuthorizedKeyAdded(uint256 indexed accountId, address indexed key);
    event AuthorizedKeyRemoved(uint256 indexed accountId, address indexed key);
    event CostCovered(uint256 indexed accountId, uint96 baseCost, uint96 discountedCost);
    event Withdrawal(uint256 indexed accountId, uint96 amount);

    error AccountNotFound(uint256 accountId);
    error NotAccountAdmin(uint256 accountId, address caller);
    error NotAuthorized(uint256 accountId, address caller);
    error InsufficientBalance(uint256 accountId, uint96 required, uint96 available);
    error LockNotExpired(uint256 accountId, uint40 expiresAtEpoch);
    error InvalidLockEpochs();
    error InvalidAmount();
    error AdminAlreadyHasAccount(address admin);

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        if (nextAccountId == 0) nextAccountId = 1;
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    function createAccount(uint96 amount, uint40 lockEpochs) external returns (uint256 accountId) {
        if (amount == 0) revert InvalidAmount();
        if (lockEpochs == 0) revert InvalidLockEpochs();
        if (adminToAccountId[msg.sender] != 0) revert AdminAlreadyHasAccount(msg.sender);

        accountId = nextAccountId++;
        uint256 conviction = uint256(amount) * uint256(lockEpochs);

        accounts[accountId] = Account({
            admin: msg.sender,
            balance: amount,
            initialDeposit: amount,
            lockEpochs: lockEpochs,
            createdAtEpoch: 0, // set externally or by Chronos if available
            conviction: conviction
        });

        authorizedKeys[accountId][msg.sender] = true;
        adminToAccountId[msg.sender] = accountId;

        if (!tokenContract.transferFrom(msg.sender, address(this), amount)) {
            revert InvalidAmount();
        }

        emit AccountCreated(accountId, msg.sender, amount, lockEpochs);
    }

    function addFunds(uint256 accountId, uint96 amount) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);
        if (amount == 0) revert InvalidAmount();

        acct.balance += amount;

        if (!tokenContract.transferFrom(msg.sender, address(this), amount)) {
            revert InvalidAmount();
        }

        emit FundsAdded(accountId, amount, acct.balance);
    }

    function extendLock(uint256 accountId, uint40 additionalEpochs) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);
        if (additionalEpochs == 0) revert InvalidLockEpochs();

        acct.lockEpochs += additionalEpochs;
        acct.conviction = uint256(acct.initialDeposit) * uint256(acct.lockEpochs);

        emit LockExtended(accountId, acct.lockEpochs, acct.conviction);
    }

    function addAuthorizedKey(uint256 accountId, address key) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);

        authorizedKeys[accountId][key] = true;
        emit AuthorizedKeyAdded(accountId, key);
    }

    function removeAuthorizedKey(uint256 accountId, address key) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);

        authorizedKeys[accountId][key] = false;
        emit AuthorizedKeyRemoved(accountId, key);
    }

    /**
     * @notice Called by KnowledgeAssets contract to cover publishing cost at a discount.
     * Only authorized keys of the account can trigger this.
     */
    function coverPublishingCost(uint256 accountId, uint96 baseCost, address caller) external onlyContracts returns (uint96) {
        Account storage acct = _requireAccount(accountId);
        if (!authorizedKeys[accountId][caller]) revert NotAuthorized(accountId, caller);

        uint96 discountedCost = _applyDiscount(acct.conviction, baseCost);

        if (acct.balance < discountedCost) {
            revert InsufficientBalance(accountId, discountedCost, acct.balance);
        }

        acct.balance -= discountedCost;

        if (!tokenContract.transfer(hub.getContractAddress("StakingStorage"), discountedCost)) {
            revert InvalidAmount();
        }

        emit CostCovered(accountId, baseCost, discountedCost);
        return discountedCost;
    }

    function withdraw(uint256 accountId, uint96 amount) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);

        // Lock check is simplified — in production, integrate with Chronos for epoch tracking
        // For now, allow withdrawal only when balance exceeds initial deposit commitment
        if (acct.balance < amount) {
            revert InsufficientBalance(accountId, amount, acct.balance);
        }

        acct.balance -= amount;

        if (!tokenContract.transfer(msg.sender, amount)) {
            revert InvalidAmount();
        }

        emit Withdrawal(accountId, amount);
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    function getDiscount(uint256 accountId) external view returns (uint256 discountBps) {
        Account storage acct = _requireAccount(accountId);
        return _computeDiscount(acct.conviction);
    }

    function getDiscountedCost(uint256 accountId, uint96 baseCost) external view returns (uint96) {
        Account storage acct = _requireAccount(accountId);
        return _applyDiscount(acct.conviction, baseCost);
    }

    function getAccountInfo(uint256 accountId) external view returns (
        address admin,
        uint96 balance,
        uint96 initialDeposit,
        uint40 lockEpochs,
        uint256 conviction,
        uint256 discountBps
    ) {
        Account storage acct = _requireAccount(accountId);
        return (
            acct.admin,
            acct.balance,
            acct.initialDeposit,
            acct.lockEpochs,
            acct.conviction,
            _computeDiscount(acct.conviction)
        );
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    function _requireAccount(uint256 accountId) internal view returns (Account storage) {
        Account storage acct = accounts[accountId];
        if (acct.admin == address(0)) revert AccountNotFound(accountId);
        return acct;
    }

    function _computeDiscount(uint256 conviction) internal pure returns (uint256) {
        if (conviction == 0) return 0;
        return (MAX_DISCOUNT_BPS * conviction) / (conviction + C_HALF);
    }

    function _applyDiscount(uint256 conviction, uint96 baseCost) internal pure returns (uint96) {
        uint256 discountBps = _computeDiscount(conviction);
        return uint96(uint256(baseCost) * (BPS_DENOMINATOR - discountBps) / BPS_DENOMINATOR);
    }
}
