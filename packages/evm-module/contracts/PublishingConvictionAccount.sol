// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Chronos} from "./storage/Chronos.sol";

/**
 * @title PublishingConvictionAccount
 * @notice Publishers who commit TRAC for 12 months receive discounted publishing fees.
 *
 * The locked TRAC IS the spending balance — each publish deducts from it at the
 * discounted rate. The discount is flat: determined by the initial commitment amount
 * via a discrete tier lookup table.
 *
 * conviction = initialCommitment * 12 (immutable after creation)
 *
 * Discount tiers (based on initialCommitment):
 *   25,000 TRAC  -> 10%
 *   50,000 TRAC  -> 20%
 *   100,000 TRAC -> 30%
 *   250,000 TRAC -> 40%
 *   500,000 TRAC -> 50%
 *   1,000,000+   -> 75%
 */
contract PublishingConvictionAccount is INamed, IVersioned, ContractStatus, IInitializable {
    using SafeERC20 for IERC20;

    string private constant _NAME = "PublishingConvictionAccount";
    string private constant _VERSION = "2.0.0";

    uint256 public constant LOCK_DURATION_EPOCHS = 12;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct Account {
        address admin;
        uint256 lockedBalance;
        uint256 topUpBalance;
        uint256 initialCommitment;
        uint256 createdAtEpoch;
        uint256 conviction;
    }

    IERC20 public tokenContract;
    Chronos public chronos;
    uint256 public nextAccountId;

    mapping(uint256 => Account) internal _accounts;
    mapping(uint256 => mapping(address => bool)) public authorizedKeys;
    mapping(address => uint256) public adminToAccountId;

    // Events
    event AccountCreated(uint256 indexed accountId, address indexed admin, uint256 amount, uint256 conviction);
    event AccountClosed(uint256 indexed accountId, address indexed admin);
    event TopUp(uint256 indexed accountId, uint256 amount, uint256 newTopUpBalance);
    event AuthorizedKeyAdded(uint256 indexed accountId, address indexed key);
    event AuthorizedKeyRemoved(uint256 indexed accountId, address indexed key);

    // Errors
    error AccountNotFound(uint256 accountId);
    error NotAccountAdmin(uint256 accountId, address caller);
    error ZeroAmount();
    error AdminAlreadyHasAccount(address admin);
    error LockNotExpired(uint256 accountId, uint256 expiresAtEpoch, uint256 currentEpoch);
    error BalanceNotZero(uint256 accountId, uint256 lockedBalance, uint256 topUpBalance);
    error CannotRemoveOwnKey(uint256 accountId, address admin);

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        if (nextAccountId == 0) nextAccountId = 1;
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // State-Changing Functions
    // ========================================================================

    function createAccount(uint256 amount) external returns (uint256 accountId) {
        if (amount == 0) revert ZeroAmount();
        if (adminToAccountId[msg.sender] != 0) revert AdminAlreadyHasAccount(msg.sender);

        accountId = nextAccountId++;
        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint256 conviction = amount * LOCK_DURATION_EPOCHS;

        _accounts[accountId] = Account({
            admin: msg.sender,
            lockedBalance: amount,
            topUpBalance: 0,
            initialCommitment: amount,
            createdAtEpoch: currentEpoch,
            conviction: conviction
        });

        authorizedKeys[accountId][msg.sender] = true;
        adminToAccountId[msg.sender] = accountId;

        tokenContract.safeTransferFrom(msg.sender, address(this), amount);

        emit AccountCreated(accountId, msg.sender, amount, conviction);
    }

    function topUp(uint256 accountId, uint256 amount) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);
        if (amount == 0) revert ZeroAmount();

        acct.topUpBalance += amount;

        tokenContract.safeTransferFrom(msg.sender, address(this), amount);

        emit TopUp(accountId, amount, acct.topUpBalance);
    }

    function closeAccount(uint256 accountId) external {
        Account storage acct = _requireAccount(accountId);
        if (acct.admin != msg.sender) revert NotAccountAdmin(accountId, msg.sender);

        uint256 currentEpoch = chronos.getCurrentEpoch();
        uint256 expiresAtEpoch = acct.createdAtEpoch + LOCK_DURATION_EPOCHS;
        if (currentEpoch < expiresAtEpoch) {
            revert LockNotExpired(accountId, expiresAtEpoch, currentEpoch);
        }

        if (acct.lockedBalance != 0 || acct.topUpBalance != 0) {
            revert BalanceNotZero(accountId, acct.lockedBalance, acct.topUpBalance);
        }

        address admin = acct.admin;
        delete adminToAccountId[admin];
        delete _accounts[accountId];

        emit AccountClosed(accountId, admin);
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
        if (key == acct.admin) revert CannotRemoveOwnKey(accountId, acct.admin);

        authorizedKeys[accountId][key] = false;
        emit AuthorizedKeyRemoved(accountId, key);
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    function getDiscount(uint256 accountId) external view returns (uint256 discountBps) {
        Account storage acct = _requireAccount(accountId);
        return _computeDiscount(acct.initialCommitment);
    }

    function getDiscountedCost(uint256 accountId, uint256 baseCost) external view returns (uint256) {
        Account storage acct = _requireAccount(accountId);
        uint256 discountBps = _computeDiscount(acct.initialCommitment);
        return baseCost * (BPS_DENOMINATOR - discountBps) / BPS_DENOMINATOR;
    }

    function getAccountInfo(uint256 accountId) external view returns (
        address admin,
        uint256 lockedBalance,
        uint256 topUpBalance,
        uint256 initialCommitment,
        uint256 createdAtEpoch,
        uint256 conviction,
        uint256 discountBps
    ) {
        Account storage acct = _requireAccount(accountId);
        return (
            acct.admin,
            acct.lockedBalance,
            acct.topUpBalance,
            acct.initialCommitment,
            acct.createdAtEpoch,
            acct.conviction,
            _computeDiscount(acct.initialCommitment)
        );
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    function _requireAccount(uint256 accountId) internal view returns (Account storage) {
        Account storage acct = _accounts[accountId];
        if (acct.admin == address(0)) revert AccountNotFound(accountId);
        return acct;
    }

    /**
     * @dev Discrete tier lookup for publisher discount based on initialCommitment.
     *      Returns discount in basis points (bps).
     */
    function _computeDiscount(uint256 commitment) internal pure returns (uint256) {
        if (commitment >= 1_000_000 ether) return 7500;
        if (commitment >= 500_000 ether)   return 5000;
        if (commitment >= 250_000 ether)   return 4000;
        if (commitment >= 100_000 ether)   return 3000;
        if (commitment >= 50_000 ether)    return 2000;
        if (commitment >= 25_000 ether)    return 1000;
        return 0;
    }
}
