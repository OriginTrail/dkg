// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StakingStorage} from "./storage/StakingStorage.sol";
import {ConvictionStakeStorage} from "./storage/ConvictionStakeStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ShardingTable} from "./ShardingTable.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {Ask} from "./Ask.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {StakingLib} from "./libraries/StakingLib.sol";

contract ConvictionStaking is INamed, IVersioned, ContractStatus, IInitializable, ERC721Enumerable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    string private constant _NAME = "ConvictionStaking";
    string private constant _VERSION = "1.0.0";

    struct Position {
        uint96 principal;
        uint8 lockTier; // {0, 1, 3, 6, 12}
        uint40 startEpoch;
        uint72 nodeId;
        uint96 claimableRewards;
        uint40 lastClaimedEpoch;
        uint256 lastSettledScorePerStake;
        uint96 withdrawalAmount;
        uint256 withdrawalTimestamp;
    }

    uint256 private _nextTokenId;
    mapping(uint256 => Position) public positions;

    IERC20 public tokenContract;
    StakingStorage public stakingStorage;
    ConvictionStakeStorage public convictionStakeStorage;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    IdentityStorage public identityStorage;
    ShardingTable public shardingTableContract;
    ShardingTableStorage public shardingTableStorage;
    Ask public askContract;
    Chronos public chronos;

    event Staked(
        uint256 indexed tokenId,
        address indexed staker,
        uint72 indexed nodeId,
        uint96 amount,
        uint8 lockTier
    );

    error InvalidLockTier(uint8 tier);
    error ZeroStakeAmount();
    error MaximumStakeExceeded(uint96 maximum);

    constructor(address hubAddress) ContractStatus(hubAddress) ERC721("ConvictionStaking", "CSTAKE") {}

    function initialize() external onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        stakingStorage = StakingStorage(hub.getContractAddress("StakingStorage"));
        convictionStakeStorage = ConvictionStakeStorage(hub.getContractAddress("ConvictionStakeStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        shardingTableContract = ShardingTable(hub.getContractAddress("ShardingTable"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
        askContract = Ask(hub.getContractAddress("Ask"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    function name() public pure override(INamed, ERC721) returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _update(address to, uint256 tokenId, address auth) internal override(ERC721Enumerable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    /**
     * @notice Stake TRAC to a node and receive an NFT position.
     * @param nodeId Identity ID of the node to delegate to
     * @param amount Amount of TRAC to stake
     * @param lockTier Lock tier (only 0 supported in this version)
     */
    function stake(uint72 nodeId, uint96 amount, uint8 lockTier) external nonReentrant {
        if (amount == 0) revert ZeroStakeAmount();
        if (lockTier != 0) revert InvalidLockTier(lockTier);
        if (!profileStorage.profileExists(nodeId)) revert ProfileLib.ProfileDoesntExist(nodeId);

        // Check maximum stake on raw principal
        uint96 currentNodeStake = stakingStorage.getNodeStake(nodeId);
        uint96 maximumStake = parametersStorage.maximumStake();
        if (currentNodeStake + amount > maximumStake) {
            revert MaximumStakeExceeded(maximumStake);
        }

        // Mint NFT
        uint256 tokenId = _nextTokenId++;
        _mint(msg.sender, tokenId);

        // Store position
        uint40 currentEpoch = uint40(chronos.getCurrentEpoch());
        positions[tokenId] = Position({
            principal: amount,
            lockTier: lockTier,
            startEpoch: currentEpoch,
            nodeId: nodeId,
            claimableRewards: 0,
            lastClaimedEpoch: currentEpoch,
            lastSettledScorePerStake: 0,
            withdrawalAmount: 0,
            withdrawalTimestamp: 0
        });

        // Update raw stake in StakingStorage
        stakingStorage.increaseNodeStake(nodeId, amount);
        stakingStorage.increaseTotalStake(amount);

        // Update effective stake in ConvictionStakeStorage (1x for tier 0)
        convictionStakeStorage.increaseEffectiveNodeStake(nodeId, uint256(amount));
        convictionStakeStorage.increaseEffectiveTotalStake(uint256(amount));

        // Add to sharding table if not already present
        if (!shardingTableStorage.nodeExists(nodeId)) {
            shardingTableContract.insertNode(nodeId);
        }

        // Recalculate active set
        askContract.recalculateActiveSet();

        // Transfer TRAC from staker to StakingStorage (SafeERC20)
        tokenContract.safeTransferFrom(msg.sender, address(stakingStorage), amount);

        emit Staked(tokenId, msg.sender, nodeId, amount, lockTier);
    }

    /**
     * @notice Get full position data for a token.
     * @param tokenId The NFT token ID
     * @return position The position struct
     */
    function getPosition(uint256 tokenId) external view returns (Position memory) {
        return positions[tokenId];
    }
}
