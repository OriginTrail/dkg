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
 * @title DKGStakingConvictionNFT
 * @notice Wraps DKG staking positions as transferable ERC-721 NFTs.
 *
 * Each NFT represents a staking position on a specific node with a conviction
 * lock tier. The position can be transferred to another address (secondary
 * market), and the new owner inherits the stake, lock, and multiplier.
 *
 * Delegates to the underlying Staking contract for actual stake/unstake logic.
 */
contract DKGStakingConvictionNFT is INamed, IVersioned, ContractStatus, IInitializable, ERC721Enumerable {
    string private constant _NAME = "DKGStakingConvictionNFT";
    string private constant _VERSION = "1.0.0";
    uint256 public constant SCALE18 = 1e18;

    struct Position {
        uint72 identityId;  // node being staked on
        uint96 stakedAmount;
        uint40 lockEpochs;
        uint40 createdAtEpoch;
    }

    IERC20 public tokenContract;
    address public stakingStorageAddress;
    address public chronosAddress;

    uint256 private _nextPositionId;
    mapping(uint256 => Position) public positions;

    // --- Events ---

    event PositionCreated(uint256 indexed positionId, address indexed owner, uint72 identityId, uint96 amount, uint40 lockEpochs);
    event PositionIncreased(uint256 indexed positionId, uint96 addedAmount, uint96 newTotal);
    event PositionUnstaked(uint256 indexed positionId, uint96 amount);

    // --- Errors ---

    error PositionNotFound(uint256 positionId);
    error NotPositionOwner(uint256 positionId, address caller);
    error InvalidAmount();
    error InvalidLockEpochs();
    error LockNotExpired(uint256 positionId, uint40 expiresAtEpoch);
    error InsufficientStake(uint256 positionId, uint96 requested, uint96 available);

    constructor(address hubAddress) ContractStatus(hubAddress) ERC721("DKG Staking Conviction", "DKGSC") {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        try hub.getContractAddress("StakingStorage") returns (address addr) {
            stakingStorageAddress = addr;
        } catch {}
        try hub.getContractAddress("Chronos") returns (address addr) {
            chronosAddress = addr;
        } catch {}

        if (_nextPositionId == 0) _nextPositionId = 1;
    }

    function name() public pure virtual override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Staking
    // ========================================================================

    /**
     * @notice Create a new staking position NFT.
     * Locks `amount` TRAC for `lockEpochs` on node `identityId`.
     * The TRAC is transferred to StakingStorage.
     *
     * TODO: Integrate with Staking.stakeWithLock() instead of direct transfer.
     * Currently this only transfers TRAC to StakingStorage without registering
     * the position in the Staking protocol (no rewards/slashing tracking).
     * Requires a stakeOnBehalf() function in Staking.sol since stakeWithLock
     * uses msg.sender as delegator, which would be this contract's address.
     */
    function stake(
        uint72 identityId,
        uint96 amount,
        uint40 lockEpochs
    ) external returns (uint256 positionId) {
        if (amount == 0) revert InvalidAmount();
        if (lockEpochs == 0) revert InvalidLockEpochs();

        positionId = _nextPositionId++;
        uint40 currentEpoch = _getCurrentEpoch();

        positions[positionId] = Position({
            identityId: identityId,
            stakedAmount: amount,
            lockEpochs: lockEpochs,
            createdAtEpoch: currentEpoch
        });

        _mint(msg.sender, positionId);

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, amount)) {
            revert InvalidAmount();
        }

        emit PositionCreated(positionId, msg.sender, identityId, amount, lockEpochs);
    }

    /**
     * @notice Add more TRAC to an existing position.
     */
    function increaseStake(uint256 positionId, uint96 addedAmount) external {
        _requireOwner(positionId);
        if (addedAmount == 0) revert InvalidAmount();

        positions[positionId].stakedAmount += addedAmount;

        if (!tokenContract.transferFrom(msg.sender, stakingStorageAddress, addedAmount)) {
            revert InvalidAmount();
        }

        emit PositionIncreased(positionId, addedAmount, positions[positionId].stakedAmount);
    }

    /**
     * @notice Unstake (withdraw) from a position after the lock has expired.
     *         Burns the NFT if the full amount is withdrawn.
     */
    function unstake(uint256 positionId, uint96 amount) external {
        _requireOwner(positionId);
        Position storage pos = positions[positionId];

        uint40 currentEpoch = _getCurrentEpoch();
        uint40 expiresAt = pos.createdAtEpoch + pos.lockEpochs;
        if (currentEpoch < expiresAt) {
            revert LockNotExpired(positionId, expiresAt);
        }

        if (amount > pos.stakedAmount) {
            revert InsufficientStake(positionId, amount, pos.stakedAmount);
        }

        pos.stakedAmount -= amount;

        if (pos.stakedAmount == 0) {
            _burn(positionId);
            delete positions[positionId];
        }

        if (!tokenContract.transferFrom(stakingStorageAddress, msg.sender, amount)) {
            revert InvalidAmount();
        }

        emit PositionUnstaked(positionId, amount);
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    function getConviction(uint256 positionId) external view returns (uint256) {
        _requireExists(positionId);
        Position storage pos = positions[positionId];
        return uint256(pos.stakedAmount) * uint256(pos.lockEpochs);
    }

    function getMultiplier(uint256 positionId) external view returns (uint256) {
        _requireExists(positionId);
        return _convictionMultiplier(positions[positionId].lockEpochs);
    }

    function getPosition(uint256 positionId) external view returns (
        address owner_,
        uint72 identityId,
        uint96 stakedAmount,
        uint40 lockEpochs,
        uint40 createdAtEpoch,
        uint256 conviction,
        uint256 multiplier
    ) {
        _requireExists(positionId);
        Position storage pos = positions[positionId];
        return (
            ownerOf(positionId),
            pos.identityId,
            pos.stakedAmount,
            pos.lockEpochs,
            pos.createdAtEpoch,
            uint256(pos.stakedAmount) * uint256(pos.lockEpochs),
            _convictionMultiplier(pos.lockEpochs)
        );
    }

    function isLockExpired(uint256 positionId) external view returns (bool) {
        _requireExists(positionId);
        Position storage pos = positions[positionId];
        return _getCurrentEpoch() >= pos.createdAtEpoch + pos.lockEpochs;
    }

    // ========================================================================
    // Internal
    // ========================================================================

    function _requireExists(uint256 positionId) internal view {
        _requireOwned(positionId);
    }

    function _requireOwner(uint256 positionId) internal view {
        _requireExists(positionId);
        if (ownerOf(positionId) != msg.sender) {
            revert NotPositionOwner(positionId, msg.sender);
        }
    }

    function _getCurrentEpoch() internal view returns (uint40) {
        if (chronosAddress == address(0)) return 1;
        (bool ok, bytes memory ret) = chronosAddress.staticcall(
            abi.encodeWithSignature("getCurrentEpoch()")
        );
        if (!ok || ret.length < 32) return 1;
        return uint40(abi.decode(ret, (uint256)));
    }

    function _convictionMultiplier(uint40 lockEpochs) internal pure returns (uint256) {
        if (lockEpochs == 0) return 0;
        if (lockEpochs >= 12) return 6 * SCALE18;
        if (lockEpochs >= 6) return 35 * SCALE18 / 10;
        if (lockEpochs >= 3) return 2 * SCALE18;
        if (lockEpochs >= 2) return 15 * SCALE18 / 10;
        return SCALE18;
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
