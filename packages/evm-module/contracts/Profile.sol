// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {Identity} from "./Identity.sol";
import {Ask} from "./Ask.sol";
import {IdentityStorage} from "./storage/IdentityStorage.sol";
import {ParametersStorage} from "./storage/ParametersStorage.sol";
import {ProfileStorage} from "./storage/ProfileStorage.sol";
import {WhitelistStorage} from "./storage/WhitelistStorage.sol";
import {Chronos} from "./storage/Chronos.sol";
import {ConvictionStakingStorage} from "./storage/ConvictionStakingStorage.sol";
import {ShardingTableStorage} from "./storage/ShardingTableStorage.sol";
import {ShardingTableLib} from "./libraries/ShardingTableLib.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {ProfileLib} from "./libraries/ProfileLib.sol";
import {IdentityLib} from "./libraries/IdentityLib.sol";
import {Permissions} from "./libraries/Permissions.sol";

contract Profile is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "Profile";
    // Bumped 1.1.0 -> 1.2.0: adds updateRelayCapable entry point for the
    // Network State Registry (RFC 04 v0.3 / Issue #461). Multiaddrs were
    // briefly added on a prior revision but are not stored on Profile —
    // they live in per-round attestation KCs instead (RFC 04 §5.2).
    // Bumped 1.2.0 -> 1.3.0: adds recreateProfile, an admin-only recovery
    // entry point that re-attaches a Profile to an existing identityId
    // (testnet ProfileStorage-redeploy recovery). The id is reused so the
    // surviving staking/conviction/sharding state stays addressable. See
    // docs/adr/0001-recreate-profile-admin-only.md.
    string private constant _VERSION = "1.3.0";

    Ask public askContract;
    Identity public identityContract;
    IdentityStorage public identityStorage;
    ParametersStorage public parametersStorage;
    ProfileStorage public profileStorage;
    WhitelistStorage public whitelistStorage;
    Chronos public chronos;
    // D3+D13 — `DelegatorsInfo` is unregistered in V10. The two per-node-
    // per-epoch flags it used to expose (`isOperatorFeeClaimedForEpoch`,
    // `netNodeEpochRewards`) were absorbed by `ConvictionStakingStorage`.
    // Profile reads `isOperatorFeeClaimedForEpoch` in `updateOperatorFee`
    // to gate fee changes on prior-epoch fee claims being fully settled.
    ConvictionStakingStorage public convictionStakingStorage;
    // recreate-profile-recovery 0001 — read-only: recreateProfile checks the
    // recovered nodeId against any surviving sharding-table entry.
    ShardingTableStorage public shardingTableStorage;

    // solhint-disable-next-line no-empty-blocks
    constructor(address hubAddress) ContractStatus(hubAddress) {}

    modifier onlyIdentityOwner(uint72 identityId) {
        _checkIdentityOwner(identityId);
        _;
    }

    modifier onlyAdmin(uint72 identityId) {
        _checkAdmin(identityId);
        _;
    }

    modifier onlyOperational(uint72 identityId) {
        _checkOperational(identityId);
        _;
    }

    modifier onlyWhitelisted() {
        _checkWhitelist();
        _;
    }

    function initialize() public onlyHub {
        askContract = Ask(hub.getContractAddress("Ask"));
        identityContract = Identity(hub.getContractAddress("Identity"));
        identityStorage = IdentityStorage(hub.getContractAddress("IdentityStorage"));
        parametersStorage = ParametersStorage(hub.getContractAddress("ParametersStorage"));
        profileStorage = ProfileStorage(hub.getContractAddress("ProfileStorage"));
        whitelistStorage = WhitelistStorage(hub.getContractAddress("WhitelistStorage"));
        chronos = Chronos(hub.getContractAddress("Chronos"));
        convictionStakingStorage = ConvictionStakingStorage(hub.getContractAddress("ConvictionStakingStorage"));
        shardingTableStorage = ShardingTableStorage(hub.getContractAddress("ShardingTableStorage"));
    }

    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    function createProfile(
        address adminWallet,
        address[] calldata operationalWallets,
        string calldata nodeName,
        bytes calldata nodeId,
        uint16 initialOperatorFee
    ) external onlyWhitelisted {
        IdentityStorage ids = identityStorage;
        ProfileStorage ps = profileStorage;
        Identity id = identityContract;

        if (ids.getIdentityId(msg.sender) != 0) {
            revert ProfileLib.IdentityAlreadyExists(ids.getIdentityId(msg.sender), msg.sender);
        }
        if (operationalWallets.length > parametersStorage.opWalletsLimitOnProfileCreation()) {
            revert ProfileLib.TooManyOperationalWallets(
                parametersStorage.opWalletsLimitOnProfileCreation(),
                uint16(operationalWallets.length)
            );
        }
        if (bytes(nodeName).length == 0) {
            revert ProfileLib.EmptyNodeName();
        }
        if (ps.isNameTaken(nodeName)) {
            revert ProfileLib.NodeNameAlreadyExists(nodeName);
        }
        if (nodeId.length == 0) {
            revert ProfileLib.EmptyNodeId();
        }
        if (ps.nodeIdsList(nodeId)) {
            revert ProfileLib.NodeIdAlreadyExists(nodeId);
        }
        if (initialOperatorFee > parametersStorage.maxOperatorFee()) {
            revert ProfileLib.OperatorFeeOutOfRange(initialOperatorFee);
        }
        uint72 identityId = id.createIdentity(msg.sender, adminWallet);
        id.addOperationalWallets(identityId, operationalWallets);

        ps.createProfile(identityId, nodeName, nodeId, initialOperatorFee);
    }

    // recreate-profile-recovery 0001 — re-attach a Profile to an Identity
    // that survived a ProfileStorage redeploy. The caller passes the node
    // operational wallet (operators know this; the numeric identityId is
    // internal and often unknown), and the contract resolves the id via
    // IdentityStorage. Admin-only (ADR 0001): unlike genesis createProfile,
    // the resolved identityId may already carry third-party delegated
    // stake, so an operational key must not be able to re-price the
    // operator fee — _checkAdmin enforces the admin key after resolution
    // (a zero/unknown wallet resolves to id 0, which has no admin and
    // reverts). The identityId is reused — no new identity is minted — so
    // id-keyed staking/conviction/sharding state stays addressable.
    function recreateProfile(
        address operationalWallet,
        string calldata nodeName,
        bytes calldata nodeId,
        uint16 initialOperatorFee
    ) external onlyWhitelisted {
        uint72 identityId = identityStorage.getIdentityId(operationalWallet);
        _checkAdmin(identityId);

        // ShardingTableStorage survived the ProfileStorage redeploy and
        // caches nodeId per identityId. If this node is still in the ring,
        // the recovered nodeId MUST match the surviving entry — otherwise
        // ProfileStorage and the sharding table would disagree about the
        // same identityId (consumers would see a stale ring node). Read-only:
        // ring state is not rewritten here (out of scope — ADR 0001).
        ShardingTableStorage sts = shardingTableStorage;
        if (sts.nodeExists(identityId)) {
            bytes memory ringNodeId = sts.getNode(identityId).nodeId;
            if (keccak256(nodeId) != keccak256(ringNodeId)) {
                revert ProfileLib.NodeIdShardingMismatch(identityId, ringNodeId, nodeId);
            }
        }

        ProfileStorage ps = profileStorage;

        if (ps.profileExists(identityId)) {
            revert ProfileLib.ProfileAlreadyExists(identityId);
        }
        if (bytes(nodeName).length == 0) {
            revert ProfileLib.EmptyNodeName();
        }
        if (ps.isNameTaken(nodeName)) {
            revert ProfileLib.NodeNameAlreadyExists(nodeName);
        }
        if (nodeId.length == 0) {
            revert ProfileLib.EmptyNodeId();
        }
        if (ps.nodeIdsList(nodeId)) {
            revert ProfileLib.NodeIdAlreadyExists(nodeId);
        }
        if (initialOperatorFee > parametersStorage.maxOperatorFee()) {
            revert ProfileLib.OperatorFeeOutOfRange(initialOperatorFee);
        }

        ps.createProfile(identityId, nodeName, nodeId, initialOperatorFee);

        // ShardingTable survived a ProfileStorage-only redeploy: if this
        // node is already in the ring, Ask's active-set / pricing
        // aggregates (recomputed from ProfileStorage.getAsk per ring node)
        // are stale until something recomputes. Trigger it now so the
        // recovered node's contribution is consistent. Genesis
        // createProfile has no ring entry, so it never needs this.
        if (sts.nodeExists(identityId)) {
            askContract.recalculateActiveSet();
        }
    }

    function addOperationalWallets(
        uint72 identityId,
        address[] calldata operationalWallets
    ) external onlyAdmin(identityId) {
        if (profileStorage.getNodeId(identityId).length == 0) {
            revert ProfileLib.ProfileDoesntExist(identityId);
        }

        address[] memory walletsToAdd = new address[](operationalWallets.length);
        uint256 walletsToAddCount;
        IdentityStorage ids = identityStorage;

        for (uint256 i; i < operationalWallets.length; ) {
            address operationalWallet = operationalWallets[i];
            if (operationalWallet == address(0)) {
                revert IdentityLib.OperationalAddressZero();
            }

            bytes32 operationalKey = keccak256(abi.encodePacked(operationalWallet));
            if (ids.keyHasPurpose(identityId, operationalKey, IdentityLib.ADMIN_KEY)) {
                revert IdentityLib.AdminEqualsOperational();
            }
            uint72 existingIdentityId = ids.identityIds(operationalKey);

            if (existingIdentityId == identityId) {
                unchecked {
                    i++;
                }
                continue;
            }
            if (existingIdentityId != 0) {
                revert IdentityLib.OperationalKeyTaken(operationalKey);
            }

            bool duplicate;
            for (uint256 j; j < walletsToAddCount; ) {
                if (walletsToAdd[j] == operationalWallet) {
                    duplicate = true;
                    break;
                }
                unchecked {
                    j++;
                }
            }

            if (!duplicate) {
                walletsToAdd[walletsToAddCount] = operationalWallet;
                unchecked {
                    walletsToAddCount++;
                }
            }

            unchecked {
                i++;
            }
        }

        if (walletsToAddCount == 0) {
            return;
        }

        uint256 totalOperationalWallets = ids.getKeysByPurpose(identityId, IdentityLib.OPERATIONAL_KEY).length +
            walletsToAddCount;
        uint256 additionalOperationalWallets = totalOperationalWallets == 0 ? 0 : totalOperationalWallets - 1;
        uint16 operationalWalletLimit = parametersStorage.opWalletsLimitOnProfileCreation();
        if (additionalOperationalWallets > operationalWalletLimit) {
            revert ProfileLib.TooManyOperationalWallets(
                operationalWalletLimit,
                additionalOperationalWallets > type(uint16).max
                    ? type(uint16).max
                    : uint16(additionalOperationalWallets)
            );
        }

        address[] memory compactWalletsToAdd = new address[](walletsToAddCount);
        for (uint256 i; i < walletsToAddCount; ) {
            compactWalletsToAdd[i] = walletsToAdd[i];
            unchecked {
                i++;
            }
        }

        identityContract.addOperationalWallets(identityId, compactWalletsToAdd);
    }

    function updateAsk(uint72 identityId, uint96 ask) external onlyIdentityOwner(identityId) {
        if (ask == 0) {
            revert ProfileLib.ZeroAsk();
        }

        ProfileStorage ps = profileStorage;

        if (block.timestamp < ps.askUpdateCooldown(identityId)) {
            revert ProfileLib.AskUpdateOnCooldown(identityId, ps.askUpdateCooldown(identityId));
        }

        ps.setAsk(identityId, ask);
        ps.setAskUpdateCooldown(identityId, block.timestamp + parametersStorage.nodeAskUpdateDelay());
        askContract.recalculateActiveSet();
    }

    function updateOperatorFee(uint72 identityId, uint16 newOperatorFee) external onlyAdmin(identityId) {
        uint256 currentEpoch = chronos.getCurrentEpoch();

        if (currentEpoch > 1 && currentEpoch > parametersStorage.v81ReleaseEpoch()) {
            // All operator fees for previous epochs must be calculated and claimed before updating the operator fee
            if (!convictionStakingStorage.isOperatorFeeClaimedForEpoch(identityId, currentEpoch - 1)) {
                revert(
                    "Cannot update operatorFee if operatorFee has not been calculated and claimed for previous epochs"
                );
            }
        }

        if (newOperatorFee > parametersStorage.maxOperatorFee()) {
            revert ProfileLib.InvalidOperatorFee();
        }

        ProfileStorage ps = profileStorage;

        uint256 epochStart = chronos.timestampForEpoch(currentEpoch);
        uint256 epochLength = chronos.epochLength();
        uint256 nextEpochStart = epochStart + epochLength;

        uint256 effectiveStart = block.timestamp <= epochStart + epochLength / 2
            ? nextEpochStart
            : nextEpochStart + epochLength;

        if (ps.isOperatorFeeChangePending(identityId)) {
            ps.replacePendingOperatorFee(identityId, newOperatorFee, effectiveStart);
        } else {
            ps.addOperatorFee(identityId, newOperatorFee, effectiveStart);
        }
    }

    // =====================================================================
    // RFC 04 v0.3 / Issue #461 — relay-capability flag.
    //
    // onlyIdentityOwner (admin OR operational): operators typically toggle
    // this from the running daemon (operational key) on startup; admin
    // override is supported. Multiaddrs are NOT stored here — see
    // RFC 04 §5.2 for the rationale.
    // =====================================================================

    function updateRelayCapable(
        uint72 identityId,
        bool relayCapable
    ) external onlyIdentityOwner(identityId) {
        if (profileStorage.getNodeId(identityId).length == 0) {
            revert ProfileLib.ProfileDoesntExist(identityId);
        }
        profileStorage.setRelayCapable(identityId, relayCapable);
    }

    function _checkIdentityOwner(uint72 identityId) internal view virtual {
        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(msg.sender)),
                IdentityLib.ADMIN_KEY
            ) &&
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(msg.sender)),
                IdentityLib.OPERATIONAL_KEY
            )
        ) {
            revert Permissions.OnlyProfileAdminOrOperationalAddressesFunction(msg.sender);
        }
    }

    function _checkAdmin(uint72 identityId) internal view virtual {
        if (
            !identityStorage.keyHasPurpose(identityId, keccak256(abi.encodePacked(msg.sender)), IdentityLib.ADMIN_KEY)
        ) {
            revert Permissions.OnlyProfileAdminFunction(msg.sender);
        }
    }

    function _checkOperational(uint72 identityId) internal view virtual {
        if (
            !identityStorage.keyHasPurpose(
                identityId,
                keccak256(abi.encodePacked(msg.sender)),
                IdentityLib.OPERATIONAL_KEY
            )
        ) {
            revert Permissions.OnlyProfileOperationalWalletFunction(msg.sender);
        }
    }

    function _checkWhitelist() internal view virtual {
        WhitelistStorage ws = whitelistStorage;
        if (ws.whitelistingEnabled() && !ws.whitelisted(msg.sender)) {
            revert Permissions.OnlyWhitelistedAddressesFunction(msg.sender);
        }
    }
}
