// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "../interfaces/INamed.sol";
import {IVersioned} from "../interfaces/IVersioned.sol";
import {IInitializable} from "../interfaces/IInitializable.sol";
import {RandomSamplingLib} from "../libraries/RandomSamplingLib.sol";
import {Chronos} from "../storage/Chronos.sol";
import {ContractStatus} from "../abstract/ContractStatus.sol";
import {ICustodian} from "../interfaces/ICustodian.sol";
import {HubLib} from "../libraries/HubLib.sol";

contract RandomSamplingStorage is INamed, IVersioned, IInitializable, ContractStatus {
    string private constant _NAME = "RandomSamplingStorage";
    // 1.0.0 — original scalar nodeEpochScorePerStake.
    // 2.0.0 — D26 C.2 shape: per-(identityId, epoch) EpochIndex with
    //         firstScorePerStake36 / lastScorePerStake36 sentinels plus a
    //         timestamped Checkpoint[] mid array appended by submitProof.
    //         Legacy `getNodeEpochScorePerStake` / `addToNodeEpochScorePerStake`
    //         / `setNodeEpochScorePerStake` preserved as adapters over the
    //         new structure. Scalar mapping removed.
    // 3.0.0 — D26 code-review follow-ups (M6/M7/L6):
    //         * `EpochIndex.firstScorePerStake36` removed. Under D26
    //           `scorePerStake36` is epoch-local (accumulates from 0 per
    //           epoch), so the sentinel was always 0 — one SSTORE slot
    //           reclaimed per epoch first-write.
    //         * `EpochIndex.firstInitialized` removed. It was set on first
    //           write and never read for correctness; `isEpochFirstInitialized`
    //           view is retired.
    //         * `setLastScorePerStake` removed — test-only path that
    //           could desynchronize `mid[tail]` from `lastScorePerStake36`
    //           and silently corrupt claim math. Tests now drive state
    //           through `appendCheckpoint`.
    //         * `getEpochFirstScorePerStake` retired (always 0 under D26).
    string private constant _VERSION = "3.0.0";
    uint8 public constant CHUNK_BYTE_SIZE = 32;
    Chronos public chronos;

    uint256 public w1;
    uint256 public w2;

    RandomSamplingLib.ProofingPeriodDuration[] public proofingPeriodDurations;

    uint256 private activeProofPeriodStartBlock;
    // identityId => Challenge - used in proof to verify the challenge is within proofing period
    mapping(uint72 => RandomSamplingLib.Challenge) public nodesChallenges;
    // epoch => identityId => successful proofs count
    mapping(uint256 => mapping(uint72 => uint256)) public epochNodeValidProofsCount;
    // identityId => epoch => proofPeriodStartBlock => score
    mapping(uint72 => mapping(uint256 => mapping(uint256 => uint256))) public nodeEpochProofPeriodScore;
    // identityId => epoch => score
    mapping(uint72 => mapping(uint256 => uint256)) public nodeEpochScore;
    // epoch => score
    mapping(uint256 => uint256) public allNodesEpochScore;
    // epoch => identityId => delegatorKey => score
    mapping(uint256 => mapping(uint72 => mapping(bytes32 => uint256))) public epochNodeDelegatorScore;

    // ============================================================
    //     D26 — C.2 per-(identityId, epoch) score-per-stake index
    // ============================================================
    //
    // `lastScorePerStake36` is the epoch-end cumulative score-per-stake
    // (strictly monotonic across the epoch). `mid` is appended once per
    // proof (timestamped) so claim can binary-search for the scorePerStake
    // at an arbitrary `ts` in the epoch (used when a delegator's boost
    // expires mid-epoch).
    //
    // M6/M7 — the pre-3.0.0 layout carried a `firstScorePerStake36` +
    // `firstInitialized` pair. Under D26, scorePerStake36 is epoch-local
    // (accumulates from 0), so the "first" sentinel was always 0 and the
    // "initialized" flag was set but never consulted. Both fields are
    // removed; `findScorePerStakeAt` now returns 0 for timestamps before
    // the first checkpoint (the natural default).
    struct Checkpoint {
        uint40 timestamp;
        uint216 scorePerStake36;
    }
    struct EpochIndex {
        uint256 lastScorePerStake36;
        Checkpoint[] mid;
    }
    // identityId => epoch => EpochIndex
    mapping(uint72 => mapping(uint256 => EpochIndex)) internal nodeEpochIndex;

    // epoch => identityId => delegatorKey => last settled scorePerStake36
    //
    // (The legacy name is preserved; this value is now the delegator's
    // cursor into the new EpochIndex.lastScorePerStake36 stream.)
    mapping(uint256 => mapping(uint72 => mapping(bytes32 => uint256)))
        public delegatorLastSettledNodeEpochScorePerStake;

    event W1Set(uint256 oldW1, uint256 newW1);
    event W2Set(uint256 oldW2, uint256 newW2);
    event ProofingPeriodDurationAdded(uint16 durationInBlocks, uint256 indexed effectiveEpoch);
    event PendingProofingPeriodDurationReplaced(
        uint16 oldDurationInBlocks,
        uint16 newDurationInBlocks,
        uint256 indexed effectiveEpoch
    );
    event NodeEpochScoreAdded(uint256 indexed epoch, uint72 indexed identityId, uint256 scoreAdded, uint256 totalScore);
    event AllNodesEpochScoreAdded(uint256 indexed epoch, uint256 scoreAdded, uint256 totalScore);
    event NodeEpochProofPeriodScoreAdded(
        uint256 indexed epoch,
        uint256 indexed proofPeriodStartBlock,
        uint72 indexed identityId,
        uint256 scoreAdded,
        uint256 totalScore
    );
    event NodeEpochProofPeriodScoreSet(
        uint256 indexed epoch,
        uint256 indexed proofPeriodStartBlock,
        uint72 indexed identityId,
        uint256 newScore
    );
    event NodeEpochScorePerStakeAdded(
        uint256 indexed epoch,
        uint72 indexed identityId,
        uint256 scorePerStakeToAdd,
        uint256 totalNodeEpochScorePerStake
    );
    event NodeEpochScorePerStakeSet(uint256 indexed epoch, uint72 indexed identityId, uint256 newScorePerStake);
    // D26 — C.2 EpochIndex events.
    event EpochCheckpointAppended(
        uint72 indexed identityId,
        uint256 indexed epoch,
        uint40 timestamp,
        uint256 scorePerStake36
    );
    event EpochNodeDelegatorScoreAdded(
        uint256 indexed epoch,
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint256 scoreAdded,
        uint256 totalScore
    );
    event DelegatorLastSettledNodeEpochScorePerStakeSet(
        uint256 indexed epoch,
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint256 newDelegatorLastSettledNodeEpochScorePerStake
    );
    event NodeChallengeSet(uint72 indexed identityId, RandomSamplingLib.Challenge challenge);
    event ActiveProofPeriodStartBlockSet(uint256 indexed activeProofPeriodStartBlock);
    event EpochNodeValidProofsCountIncremented(uint256 indexed epoch, uint72 indexed identityId, uint256 newCount);
    event EpochNodeValidProofsCountSet(uint256 indexed epoch, uint72 indexed identityId, uint256 newCount);
    event NodeEpochScoreSet(uint256 indexed epoch, uint72 indexed identityId, uint256 newScore);
    event AllNodesEpochScoreSet(uint256 indexed epoch, uint256 newScore);
    event EpochNodeDelegatorScoreSet(
        uint256 indexed epoch,
        uint72 indexed identityId,
        bytes32 indexed delegatorKey,
        uint256 newScore
    );

    /**
     * @dev Initializes the RandomSamplingStorage contract with initial parameters
     * Sets up proofing period duration, block time, and weight parameters for random sampling
     * @param hubAddress Address of the Hub contract for access control and contract dependencies
     * @param _proofingPeriodDurationInBlocks Initial duration of proofing periods in blocks
     * @param _w1 First weight parameter used in rewards calculations
     * @param _w2 Second weight parameter used in rewards calculations
     */
    constructor(
        address hubAddress,
        uint16 _proofingPeriodDurationInBlocks,
        uint256 _w1,
        uint256 _w2
    ) ContractStatus(hubAddress) {
        require(_proofingPeriodDurationInBlocks > 0, "Proofing period duration in blocks must be greater than 0");

        Chronos c = Chronos(hub.getContractAddress("Chronos"));

        proofingPeriodDurations.push(
            RandomSamplingLib.ProofingPeriodDuration({
                durationInBlocks: _proofingPeriodDurationInBlocks,
                effectiveEpoch: c.getCurrentEpoch()
            })
        );
        w1 = _w1;
        w2 = _w2;

        emit ProofingPeriodDurationAdded(_proofingPeriodDurationInBlocks, c.getCurrentEpoch());
        emit W1Set(0, _w1);
        emit W2Set(0, _w2);
    }

    // @dev Only transactions by HubController owner or one of the owners of the MultiSig Wallet
    modifier onlyOwnerOrMultiSigOwner() {
        _checkOwnerOrMultiSigOwner();
        _;
    }

    /**
     * @dev Initializes the contract by setting up the Chronos reference from the hub
     * Called once after deployment to complete contract setup
     */
    function initialize() external onlyHub {
        chronos = Chronos(hub.getContractAddress("Chronos"));
    }

    /**
     * @dev Returns the name of this contract for identification purposes
     * @return Contract name as a string
     */
    function name() external pure virtual override returns (string memory) {
        return _NAME;
    }

    /**
     * @dev Returns the version of this contract for compatibility tracking
     * @return Contract version as a string
     */
    function version() external pure virtual override returns (string memory) {
        return _VERSION;
    }

    /**
     * @dev Updates the w1 parameter used in rewards calculations
     * Can only be called by the hub owner or multisig owners
     * @param _w1 New w1 parameter value
     */
    function setW1(uint256 _w1) external onlyOwnerOrMultiSigOwner {
        uint256 oldW1 = w1;
        w1 = _w1;
        emit W1Set(oldW1, w1);
    }

    /**
     * @dev Returns the current w1 parameter value
     * @return Current w1 parameter used in rewards calculations
     */
    function getW1() external view returns (uint256) {
        return w1;
    }

    /**
     * @dev Updates the w2 parameter used in rewards calculations
     * Can only be called by the hub owner or multisig owners
     * @param _w2 New w2 parameter value
     */
    function setW2(uint256 _w2) external onlyOwnerOrMultiSigOwner {
        uint256 oldW2 = w2;
        w2 = _w2;
        emit W2Set(oldW2, w2);
    }

    /**
     * @dev Returns the current w2 parameter value
     * @return Current w2 parameter used in rewards calculations
     */
    function getW2() external view returns (uint256) {
        return w2;
    }

    /**
     * @dev Returns the current active proof period start block
     * @return Current active proof period start block number
     */
    function getActiveProofPeriodStartBlock() external view returns (uint256) {
        return activeProofPeriodStartBlock;
    }

    /**
     * @dev Sets the active proof period start block
     * Can only be called by contracts registered in the Hub
     * @param newActiveProofPeriodStartBlock New active proof period start block
     */
    function setActiveProofPeriodStartBlock(uint256 newActiveProofPeriodStartBlock) external onlyContracts {
        activeProofPeriodStartBlock = newActiveProofPeriodStartBlock;
        emit ActiveProofPeriodStartBlockSet(newActiveProofPeriodStartBlock);
    }

    /**
     * @dev Replaces a pending proofing period duration with new values before it becomes active
     * Can only be called by contracts registered in the Hub
     * @param durationInBlocks New duration in blocks for the proofing period
     * @param effectiveEpoch Epoch when the new duration will take effect
     */
    function replacePendingProofingPeriodDuration(
        uint16 durationInBlocks,
        uint256 effectiveEpoch
    ) external onlyContracts {
        uint16 oldDurationInBlocks = proofingPeriodDurations[proofingPeriodDurations.length - 1].durationInBlocks;
        proofingPeriodDurations[proofingPeriodDurations.length - 1] = RandomSamplingLib.ProofingPeriodDuration({
            durationInBlocks: durationInBlocks,
            effectiveEpoch: effectiveEpoch
        });

        emit PendingProofingPeriodDurationReplaced(oldDurationInBlocks, durationInBlocks, effectiveEpoch);
    }

    /**
     * @dev Adds a new proofing period duration to take effect at a future epoch
     * Can only be called by contracts registered in the Hub
     * @param durationInBlocks Duration in blocks for the new proofing period
     * @param effectiveEpoch Epoch when the new duration will take effect
     */
    function addProofingPeriodDuration(uint16 durationInBlocks, uint256 effectiveEpoch) external onlyContracts {
        proofingPeriodDurations.push(
            RandomSamplingLib.ProofingPeriodDuration({
                durationInBlocks: durationInBlocks,
                effectiveEpoch: effectiveEpoch
            })
        );

        emit ProofingPeriodDurationAdded(durationInBlocks, effectiveEpoch);
    }

    /**
     * @dev Returns the proofing period duration for a specific epoch
     * @param epoch The epoch to get the duration for
     * @return Duration in blocks for the specified epoch
     */
    function getEpochProofingPeriodDurationInBlocks(uint256 epoch) external view returns (uint16) {
        // Find the most recent duration that was effective before or at the specified epoch
        for (uint256 i = proofingPeriodDurations.length; i > 0; ) {
            if (epoch >= proofingPeriodDurations[i - 1].effectiveEpoch) {
                return proofingPeriodDurations[i - 1].durationInBlocks;
            }

            unchecked {
                i--;
            }
        }

        // If no applicable duration found, revert
        revert("No applicable duration found");
    }

    /**
     * @dev Returns the length of the proofing period durations array
     * @return Length of the proofing period durations array
     */
    function getProofingPeriodDurationsLength() external view returns (uint256) {
        return proofingPeriodDurations.length;
    }

    /**
     * @dev Returns the effective epoch of the latest proofing period duration
     * @return Effective epoch of the latest duration
     */
    function getLatestProofingPeriodDurationEffectiveEpoch() external view returns (uint256) {
        return proofingPeriodDurations[proofingPeriodDurations.length - 1].effectiveEpoch;
    }

    /**
     * @dev Returns the duration in blocks of the latest proofing period duration
     * @return Duration in blocks of the latest proofing period duration
     */
    function getLatestProofingPeriodDurationInBlocks() external view returns (uint16) {
        return proofingPeriodDurations[proofingPeriodDurations.length - 1].durationInBlocks;
    }

    /**
     * @dev Returns the proofing period duration struct for a specific index
     * @param index The index to get the duration for
     * @return Proofing period duration struct for the specified index
     */
    function getProofingPeriodDurationFromIndex(
        uint256 index
    ) external view returns (RandomSamplingLib.ProofingPeriodDuration memory) {
        return proofingPeriodDurations[index];
    }

    /**
     * @dev Returns the current challenge assigned to a specific node
     * Challenges are used to verify proofs during random sampling
     * @param identityId The node identity ID to get the challenge for
     * @return Challenge struct containing all challenge details
     */
    function getNodeChallenge(uint72 identityId) external view returns (RandomSamplingLib.Challenge memory) {
        return nodesChallenges[identityId];
    }

    /**
     * @dev Sets a new challenge for a specific node
     * Can only be called by contracts registered in the Hub
     * @param identityId The node identity ID to set the challenge for
     * @param challenge The challenge struct containing all challenge details
     */
    function setNodeChallenge(
        uint72 identityId,
        RandomSamplingLib.Challenge calldata challenge
    ) external onlyContracts {
        nodesChallenges[identityId] = challenge;
        emit NodeChallengeSet(identityId, challenge);
    }

    /**
     * @dev Returns the score earned by a node during a specific epoch and proof period
     * @param identityId The node identity ID to get the score for
     * @param epoch The epoch to get the score for
     * @param proofPeriodStartBlock The start block of the proof period
     * @return Score earned by the node in the specified epoch and proof period, scaled by 10^18
     */
    function getNodeEpochProofPeriodScore(
        uint72 identityId,
        uint256 epoch,
        uint256 proofPeriodStartBlock
    ) external view returns (uint256) {
        return nodeEpochProofPeriodScore[identityId][epoch][proofPeriodStartBlock];
    }

    /**
     * @dev Increments the count of valid proofs submitted by a node in an epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to increment the count for
     * @param identityId The node identity ID to increment the count for
     */
    function incrementEpochNodeValidProofsCount(uint256 epoch, uint72 identityId) external onlyContracts {
        epochNodeValidProofsCount[epoch][identityId] += 1;
        emit EpochNodeValidProofsCountIncremented(epoch, identityId, epochNodeValidProofsCount[epoch][identityId]);
    }

    function setEpochNodeValidProofsCount(uint256 epoch, uint72 identityId, uint256 count) external onlyContracts {
        epochNodeValidProofsCount[epoch][identityId] = count;
        emit EpochNodeValidProofsCountSet(epoch, identityId, count);
    }

    /**
     * @dev Returns the number of valid proofs submitted by a node in a specific epoch
     * @param epoch The epoch to get the count for
     * @param identityId The node identity ID to get the count for
     * @return Number of valid proofs submitted by the node in the specified epoch
     */
    function getEpochNodeValidProofsCount(uint256 epoch, uint72 identityId) external view returns (uint256) {
        return epochNodeValidProofsCount[epoch][identityId];
    }

    /**
     * @dev Adds to the total score earned by a node in a specific epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to add the score to
     * @param identityId The node identity ID to add the score for
     * @param score The score amount to add, scaled by 10^18
     */
    function addToNodeEpochScore(uint256 epoch, uint72 identityId, uint256 score) external onlyContracts {
        nodeEpochScore[identityId][epoch] += score;
        emit NodeEpochScoreAdded(epoch, identityId, score, nodeEpochScore[identityId][epoch]);
    }

    /**
     * @dev Sets a node's score for a specific epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to set the score for
     * @param identityId The node identity ID to set the score for
     * @param score The score amount to set, scaled by 10^18
     */
    function setNodeEpochScore(uint256 epoch, uint72 identityId, uint256 score) external onlyContracts {
        nodeEpochScore[identityId][epoch] = score;
        emit NodeEpochScoreSet(epoch, identityId, score);
    }

    /**
     * @dev Returns the total score earned by a node in a specific epoch
     * @param epoch The epoch to get the score for
     * @param identityId The node identity ID to get the score for
     * @return Total score earned by the node in the specified epoch, scaled by 10^18
     */
    function getNodeEpochScore(uint256 epoch, uint72 identityId) external view returns (uint256) {
        return nodeEpochScore[identityId][epoch];
    }

    /**
     * @dev Adds to the total score of all nodes in a specific epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to add the score to
     * @param score The score amount to add to the total, scaled by 10^18
     */
    function addToAllNodesEpochScore(uint256 epoch, uint256 score) external onlyContracts {
        allNodesEpochScore[epoch] += score;
        emit AllNodesEpochScoreAdded(epoch, score, allNodesEpochScore[epoch]);
    }

    /**
     * @dev Sets the total score of all nodes in a specific epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to set the score for
     * @param score The score amount to set, scaled by 10^18
     */
    function setAllNodesEpochScore(uint256 epoch, uint256 score) external onlyContracts {
        allNodesEpochScore[epoch] = score;
        emit AllNodesEpochScoreSet(epoch, score);
    }

    /**
     * @dev Returns the total score of all nodes in a specific epoch
     * @param epoch The epoch to get the total score for
     * @return Total score of all nodes in the specified epoch, scaled by 10^18
     */
    function getAllNodesEpochScore(uint256 epoch) external view returns (uint256) {
        return allNodesEpochScore[epoch];
    }

    /**
     * @dev Adds to a node's score for a specific epoch and proof period
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to add the score to
     * @param proofPeriodStartBlock The start block of the proof period
     * @param identityId The node identity ID to add the score for
     * @param score The score amount to add, scaled by 10^18
     */
    function addToNodeEpochProofPeriodScore(
        uint256 epoch,
        uint256 proofPeriodStartBlock,
        uint72 identityId,
        uint256 score
    ) external onlyContracts {
        nodeEpochProofPeriodScore[identityId][epoch][proofPeriodStartBlock] += score;
        emit NodeEpochProofPeriodScoreAdded(
            epoch,
            proofPeriodStartBlock,
            identityId,
            score,
            nodeEpochProofPeriodScore[identityId][epoch][proofPeriodStartBlock]
        );
    }

    /**
     * @dev Sets a node's score for a specific epoch and proof period
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to set the score for
     * @param proofPeriodStartBlock The start block of the proof period
     * @param identityId The node identity ID to set the score for
     * @param score The score amount to set, scaled by 10^18
     */
    function setNodeEpochProofPeriodScore(
        uint256 epoch,
        uint256 proofPeriodStartBlock,
        uint72 identityId,
        uint256 score
    ) external onlyContracts {
        nodeEpochProofPeriodScore[identityId][epoch][proofPeriodStartBlock] = score;
        emit NodeEpochProofPeriodScoreSet(epoch, proofPeriodStartBlock, identityId, score);
    }

    /**
     * @dev Returns the score earned by a specific node's delegator in an epoch
     * Used for calculating delegator rewards
     * @param epoch The epoch to get the score for
     * @param identityId The node identity ID the delegator is delegating to
     * @param delegatorKey The unique key identifying the delegator
     * @return Score earned by the delegator for the specified node in the epoch, scaled by 10^18
     */
    function getEpochNodeDelegatorScore(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint256) {
        return epochNodeDelegatorScore[epoch][identityId][delegatorKey];
    }

    /**
     * @dev Adds to the score earned by a node's delegator in an epoch
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to add the score to
     * @param identityId The node identity ID the delegator is delegating to
     * @param delegatorKey The unique key identifying the delegator
     * @param score The score amount to add, scaled by 10^18
     */
    function addToEpochNodeDelegatorScore(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey,
        uint256 score
    ) external onlyContracts {
        epochNodeDelegatorScore[epoch][identityId][delegatorKey] += score;
        emit EpochNodeDelegatorScoreAdded(
            epoch,
            identityId,
            delegatorKey,
            score,
            epochNodeDelegatorScore[epoch][identityId][delegatorKey]
        );
    }

    function setEpochNodeDelegatorScore(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey,
        uint256 score
    ) external onlyContracts {
        epochNodeDelegatorScore[epoch][identityId][delegatorKey] = score;
        emit EpochNodeDelegatorScoreSet(epoch, identityId, delegatorKey, score);
    }

    /**
     * @dev Adapter for the pre-D26 read signature. Returns
     *      `lastScorePerStake36` for `(identityId, epoch)` — semantically
     *      identical to the pre-D26 scalar for past (fully-settled) epochs,
     *      which is all V8 call sites ever read.
     */
    function getNodeEpochScorePerStake(uint256 epoch, uint72 identityId) external view returns (uint256) {
        return nodeEpochIndex[identityId][epoch].lastScorePerStake36;
    }

    /**
     * @dev Legacy adapter retained for test harnesses (and any V8 emergency
     *      path) that used to write the per-epoch score-per-stake scalar
     *      directly. Routes through the new EpochIndex: bumps
     *      `lastScorePerStake36` by `scorePerStakeToAdd`, and appends /
     *      updates a `Checkpoint` at `block.timestamp` so claim-time
     *      binary search sees the new value.
     */
    function addToNodeEpochScorePerStake(
        uint256 epoch,
        uint72 identityId,
        uint256 scorePerStakeToAdd
    ) external onlyContracts {
        EpochIndex storage ei = nodeEpochIndex[identityId][epoch];
        uint256 newLast = ei.lastScorePerStake36 + scorePerStakeToAdd;
        ei.lastScorePerStake36 = newLast;
        _upsertCheckpoint(ei, uint40(block.timestamp), newLast);
        emit NodeEpochScorePerStakeAdded(epoch, identityId, scorePerStakeToAdd, newLast);
    }

    /**
     * @dev Legacy adapter. Overwrites `lastScorePerStake36` to `scorePerStake`
     *      and appends/updates a Checkpoint at `block.timestamp`.
     */
    function setNodeEpochScorePerStake(uint256 epoch, uint72 identityId, uint256 scorePerStake) external onlyContracts {
        EpochIndex storage ei = nodeEpochIndex[identityId][epoch];
        ei.lastScorePerStake36 = scorePerStake;
        _upsertCheckpoint(ei, uint40(block.timestamp), scorePerStake);
        emit NodeEpochScorePerStakeSet(epoch, identityId, scorePerStake);
    }

    // ============================================================
    //          D26 — EpochIndex mutators (submitProof)
    // ============================================================

    /// @notice Append a timestamped checkpoint (or overwrite the last one if
    ///         its timestamp equals `ts`) and set
    ///         `lastScorePerStake36 = scorePerStake36`.
    ///
    ///         `scorePerStake36` is **epoch-local** (accumulates from 0 per
    ///         epoch).
    function appendCheckpoint(
        uint72 identityId,
        uint256 epoch,
        uint40 ts,
        uint256 scorePerStake36
    ) external onlyContracts {
        EpochIndex storage ei = nodeEpochIndex[identityId][epoch];
        require(scorePerStake36 <= type(uint216).max, "Checkpoint overflow");
        ei.lastScorePerStake36 = scorePerStake36;
        _upsertCheckpoint(ei, ts, scorePerStake36);
        emit EpochCheckpointAppended(identityId, epoch, ts, scorePerStake36);
    }

    // L6 — `setLastScorePerStake` removed. It could desynchronize the
    //      `mid[tail]` checkpoint from the `lastScorePerStake36` scalar
    //      (breaking the `findScorePerStakeAt` monotonicity contract).
    //      Tests that need to set state must go through `appendCheckpoint`
    //      or `addToNodeEpochScorePerStake`, which keep both sides
    //      consistent.

    function _upsertCheckpoint(EpochIndex storage ei, uint40 ts, uint256 value) internal {
        require(value <= type(uint216).max, "Checkpoint overflow");
        uint256 n = ei.mid.length;
        if (n > 0) {
            Checkpoint storage tail = ei.mid[n - 1];
            require(tail.timestamp <= ts, "Non-monotonic ts");
            if (tail.timestamp == ts) {
                tail.scorePerStake36 = uint216(value);
                return;
            }
        }
        ei.mid.push(Checkpoint({timestamp: ts, scorePerStake36: uint216(value)}));
    }

    // ============================================================
    //          D26 — EpochIndex views (claim-time)
    // ============================================================

    function getEpochLastScorePerStake(uint72 identityId, uint256 epoch) external view returns (uint256) {
        return nodeEpochIndex[identityId][epoch].lastScorePerStake36;
    }

    function getEpochCheckpointCount(uint72 identityId, uint256 epoch) external view returns (uint256) {
        return nodeEpochIndex[identityId][epoch].mid.length;
    }

    function getEpochCheckpoint(
        uint72 identityId,
        uint256 epoch,
        uint256 index
    ) external view returns (uint40 timestamp, uint256 scorePerStake36) {
        Checkpoint storage c = nodeEpochIndex[identityId][epoch].mid[index];
        return (c.timestamp, c.scorePerStake36);
    }

    /**
     * @notice Binary-search the per-(identityId, epoch) checkpoint array for
     *         the scorePerStake36 at timestamp `ts`. Returns the first
     *         sentinel if `ts` precedes every checkpoint (including when
     *         there are none). The returned value is monotonic in `ts`.
     */
    function findScorePerStakeAt(uint72 identityId, uint256 epoch, uint40 ts) external view returns (uint256) {
        EpochIndex storage ei = nodeEpochIndex[identityId][epoch];
        uint256 n = ei.mid.length;
        // M6 — no first-sentinel anymore; absent checkpoint → 0 (natural
        //      pre-any-proof default under D26's epoch-local accumulator).
        if (n == 0) {
            return 0;
        }
        // Largest i with mid[i].timestamp <= ts via binary search.
        uint256 lo = 0;
        uint256 hi = n;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (ei.mid[mid].timestamp <= ts) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if (lo == 0) {
            return 0;
        }
        return ei.mid[lo - 1].scorePerStake36;
    }

    /**
     * @dev Returns the last settled score per stake value for a delegator
     * Used to track reward settlement state for delegators
     * @param epoch The epoch to get the last settled score per stake for
     * @param identityId The node identity ID the delegator is delegating to
     * @param delegatorKey The unique key identifying the delegator
     * @return Last settled score per stake value for the delegator, scaled by 10^36
     */
    function getDelegatorLastSettledNodeEpochScorePerStake(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey
    ) external view returns (uint256) {
        return delegatorLastSettledNodeEpochScorePerStake[epoch][identityId][delegatorKey];
    }

    /**
     * @dev Updates the last settled score per stake value for a delegator
     * Can only be called by contracts registered in the Hub
     * @param epoch The epoch to update the last settled score per stake for
     * @param identityId The node identity ID the delegator is delegating to
     * @param delegatorKey The unique key identifying the delegator
     * @param newNodeEpochScorePerStake The new score per stake value to set as last settled, scaled by 10^36
     */
    function setDelegatorLastSettledNodeEpochScorePerStake(
        uint256 epoch,
        uint72 identityId,
        bytes32 delegatorKey,
        uint256 newNodeEpochScorePerStake
    ) external onlyContracts {
        delegatorLastSettledNodeEpochScorePerStake[epoch][identityId][delegatorKey] = newNodeEpochScorePerStake;
        emit DelegatorLastSettledNodeEpochScorePerStakeSet(epoch, identityId, delegatorKey, newNodeEpochScorePerStake);
    }

    /**
     * @dev Internal function to check if an address is an owner of the multisig wallet
     * Used for access control in administrative functions
     * @param multiSigAddress Address of the multisig wallet to check ownership of
     * @return True if the caller is an owner of the multisig, false otherwise
     */
    function _isMultiSigOwner(address multiSigAddress) internal view returns (bool) {
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

    /**
     * @dev Internal function to verify that the caller is either the hub owner or a multisig owner
     * Used by the onlyOwnerOrMultiSigOwner modifier for access control
     */
    function _checkOwnerOrMultiSigOwner() internal view virtual {
        address hubOwner = hub.owner();
        if (msg.sender != hubOwner && !_isMultiSigOwner(hubOwner)) {
            revert HubLib.UnauthorizedAccess("Only Hub Owner or Multisig Owner");
        }
    }
}
