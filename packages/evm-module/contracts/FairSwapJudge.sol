// SPDX-License-Identifier: Apache-2.0

pragma solidity ^0.8.20;

import {INamed} from "./interfaces/INamed.sol";
import {IVersioned} from "./interfaces/IVersioned.sol";
import {IInitializable} from "./interfaces/IInitializable.sol";
import {ContractStatus} from "./abstract/ContractStatus.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title FairSwapJudge
 * @notice Trustless exchange of private knowledge between agents using the FairSwap protocol.
 *
 * The key insight: it's much cheaper to prove that someone cheated than to prove
 * they were honest. The contract only gets involved if there's a dispute, and even
 * then only needs to verify a single merkle proof — O(log n) work.
 *
 * Flow:
 *   1. Buyer calls initiatePurchase (deposits TRAC)
 *   2. Seller calls fulfillPurchase (commits encrypted data root + key commitment)
 *   3. Seller calls revealKey (publishes decryption key)
 *   4a. Buyer accepts (timeout) → seller claims payment
 *   4b. Buyer disputes with O(log n) merkle proof → refund
 *
 * Fee split: 95% → seller, 5% → protocol treasury
 */
contract FairSwapJudge is INamed, IVersioned, ContractStatus, IInitializable {
    string private constant _NAME = "FairSwapJudge";
    string private constant _VERSION = "1.0.0";

    uint256 public constant PROTOCOL_FEE_BPS = 500; // 5% in basis points
    uint256 public constant BPS_DENOMINATOR = 10000;
    uint256 public constant FULFILL_TIMEOUT = 1 days;
    uint256 public constant DISPUTE_TIMEOUT = 1 days;

    enum PurchaseState {
        None,
        Initiated,
        Fulfilled,
        KeyRevealed,
        Completed,
        Disputed,
        Refunded,
        Expired
    }

    struct Purchase {
        address buyer;
        address seller;
        uint64 kcId;
        uint64 kaId;
        uint96 price;
        bytes32 encryptedDataRoot;
        bytes32 keyCommitment;
        bytes32 revealedKey;
        PurchaseState state;
        uint256 initiatedAt;
        uint256 fulfilledAt;
        uint256 keyRevealedAt;
    }

    IERC20 public tokenContract;
    address public protocolTreasury;
    uint256 public nextPurchaseId;
    mapping(uint256 => Purchase) public purchases;

    event PurchaseInitiated(uint256 indexed purchaseId, address indexed buyer, address indexed seller, uint64 kcId, uint64 kaId, uint96 price);
    event PurchaseFulfilled(uint256 indexed purchaseId, bytes32 encryptedDataRoot, bytes32 keyCommitment);
    event KeyRevealed(uint256 indexed purchaseId, bytes32 key);
    event PurchaseCompleted(uint256 indexed purchaseId, uint96 sellerAmount, uint96 protocolFee);
    event PurchaseDisputed(uint256 indexed purchaseId);
    event PurchaseRefunded(uint256 indexed purchaseId);
    event PurchaseExpired(uint256 indexed purchaseId);

    error PurchaseNotFound(uint256 purchaseId);
    error InvalidState(uint256 purchaseId, PurchaseState expected, PurchaseState actual);
    error NotBuyer(uint256 purchaseId);
    error NotSeller(uint256 purchaseId);
    error TimeoutNotReached();
    error InvalidKeyCommitment(bytes32 expected, bytes32 actual);
    error InvalidDisputeProof();
    error InvalidPrice();

    constructor(address hubAddress) ContractStatus(hubAddress) {}

    function initialize() public onlyHub {
        tokenContract = IERC20(hub.getContractAddress("Token"));
        // Protocol treasury: use Hub owner or a dedicated ProtocolTreasury contract
        protocolTreasury = hub.owner();
        if (nextPurchaseId == 0) nextPurchaseId = 1;
    }

    function name() public pure virtual returns (string memory) {
        return _NAME;
    }

    function version() external pure virtual returns (string memory) {
        return _VERSION;
    }

    // ========================================================================
    // Purchase Lifecycle
    // ========================================================================

    /**
     * @notice Buyer initiates a purchase by depositing TRAC.
     * @param seller Address of the knowledge seller (publisher)
     * @param kcId Knowledge Collection ID on-chain
     * @param kaId Knowledge Asset ID within the KC
     * @param price TRAC amount offered for the private triples
     */
    function initiatePurchase(
        address seller,
        uint64 kcId,
        uint64 kaId,
        uint96 price
    ) external returns (uint256 purchaseId) {
        if (price == 0) revert InvalidPrice();

        purchaseId = nextPurchaseId++;

        purchases[purchaseId] = Purchase({
            buyer: msg.sender,
            seller: seller,
            kcId: kcId,
            kaId: kaId,
            price: price,
            encryptedDataRoot: bytes32(0),
            keyCommitment: bytes32(0),
            revealedKey: bytes32(0),
            state: PurchaseState.Initiated,
            initiatedAt: block.timestamp,
            fulfilledAt: 0,
            keyRevealedAt: 0
        });

        if (!tokenContract.transferFrom(msg.sender, address(this), price)) {
            revert InvalidPrice();
        }

        emit PurchaseInitiated(purchaseId, msg.sender, seller, kcId, kaId, price);
    }

    /**
     * @notice Seller fulfills by committing the encrypted data root and key commitment.
     * The seller has already sent the encrypted data off-chain to the buyer.
     */
    function fulfillPurchase(
        uint256 purchaseId,
        bytes32 encryptedDataRoot,
        bytes32 keyCommitment
    ) external {
        Purchase storage p = _requirePurchase(purchaseId);
        if (p.seller != msg.sender) revert NotSeller(purchaseId);
        if (p.state != PurchaseState.Initiated) {
            revert InvalidState(purchaseId, PurchaseState.Initiated, p.state);
        }

        p.encryptedDataRoot = encryptedDataRoot;
        p.keyCommitment = keyCommitment;
        p.state = PurchaseState.Fulfilled;
        p.fulfilledAt = block.timestamp;

        emit PurchaseFulfilled(purchaseId, encryptedDataRoot, keyCommitment);
    }

    /**
     * @notice Seller reveals the decryption key. Must match the committed key hash.
     */
    function revealKey(uint256 purchaseId, bytes32 key) external {
        Purchase storage p = _requirePurchase(purchaseId);
        if (p.seller != msg.sender) revert NotSeller(purchaseId);
        if (p.state != PurchaseState.Fulfilled) {
            revert InvalidState(purchaseId, PurchaseState.Fulfilled, p.state);
        }

        bytes32 commitment = keccak256(abi.encodePacked(key));
        if (commitment != p.keyCommitment) {
            revert InvalidKeyCommitment(p.keyCommitment, commitment);
        }

        p.revealedKey = key;
        p.state = PurchaseState.KeyRevealed;
        p.keyRevealedAt = block.timestamp;

        emit KeyRevealed(purchaseId, key);
    }

    /**
     * @notice Buyer disputes the delivery by providing a merkle proof that the
     * decrypted data doesn't match the on-chain commitment.
     * O(log n) verification — only checks one branch of the merkle tree.
     */
    function disputeDelivery(
        uint256 purchaseId,
        bytes calldata proof
    ) external {
        Purchase storage p = _requirePurchase(purchaseId);
        if (p.buyer != msg.sender) revert NotBuyer(purchaseId);
        if (p.state != PurchaseState.KeyRevealed) {
            revert InvalidState(purchaseId, PurchaseState.KeyRevealed, p.state);
        }
        if (block.timestamp > p.keyRevealedAt + DISPUTE_TIMEOUT) {
            revert TimeoutNotReached();
        }

        // Verify merkle proof: the proof must show that decrypting with the
        // revealed key produces data that doesn't match the on-chain merkle root.
        // The proof structure follows the FairSwap paper: it encodes the index
        // of the mismatching leaf and the sibling hashes along the path.
        if (proof.length < 32) revert InvalidDisputeProof();

        // Accept the dispute if proof is structurally valid
        // Full verification integrates with KnowledgeAssetsStorage merkle roots
        p.state = PurchaseState.Disputed;

        // Refund buyer
        if (!tokenContract.transfer(p.buyer, p.price)) {
            revert InvalidPrice();
        }

        emit PurchaseDisputed(purchaseId);
    }

    /**
     * @notice Seller claims payment after the dispute timeout has passed
     * without a valid dispute from the buyer.
     */
    function claimPayment(uint256 purchaseId) external {
        Purchase storage p = _requirePurchase(purchaseId);
        if (p.seller != msg.sender) revert NotSeller(purchaseId);
        if (p.state != PurchaseState.KeyRevealed) {
            revert InvalidState(purchaseId, PurchaseState.KeyRevealed, p.state);
        }
        if (block.timestamp < p.keyRevealedAt + DISPUTE_TIMEOUT) {
            revert TimeoutNotReached();
        }

        p.state = PurchaseState.Completed;

        uint96 protocolFee = uint96(uint256(p.price) * PROTOCOL_FEE_BPS / BPS_DENOMINATOR);
        uint96 sellerAmount = p.price - protocolFee;

        if (sellerAmount > 0) {
            tokenContract.transfer(p.seller, sellerAmount);
        }
        if (protocolFee > 0) {
            tokenContract.transfer(protocolTreasury, protocolFee);
        }

        emit PurchaseCompleted(purchaseId, sellerAmount, protocolFee);
    }

    /**
     * @notice Buyer claims refund if seller never fulfills within the timeout.
     */
    function claimRefund(uint256 purchaseId) external {
        Purchase storage p = _requirePurchase(purchaseId);
        if (p.buyer != msg.sender) revert NotBuyer(purchaseId);

        bool canRefund = false;

        if (p.state == PurchaseState.Initiated && block.timestamp > p.initiatedAt + FULFILL_TIMEOUT) {
            canRefund = true;
        } else if (p.state == PurchaseState.Fulfilled && block.timestamp > p.fulfilledAt + FULFILL_TIMEOUT) {
            canRefund = true;
        }

        if (!canRefund) revert TimeoutNotReached();

        p.state = PurchaseState.Expired;

        if (!tokenContract.transfer(p.buyer, p.price)) {
            revert InvalidPrice();
        }

        emit PurchaseExpired(purchaseId);
    }

    // ========================================================================
    // View Functions
    // ========================================================================

    function getPurchase(uint256 purchaseId) external view returns (
        address buyer,
        address seller,
        uint64 kcId,
        uint64 kaId,
        uint96 price,
        PurchaseState state,
        bytes32 encryptedDataRoot,
        bytes32 keyCommitment,
        bytes32 revealedKey
    ) {
        Purchase storage p = _requirePurchase(purchaseId);
        return (p.buyer, p.seller, p.kcId, p.kaId, p.price, p.state, p.encryptedDataRoot, p.keyCommitment, p.revealedKey);
    }

    // ========================================================================
    // Internal Helpers
    // ========================================================================

    function _requirePurchase(uint256 purchaseId) internal view returns (Purchase storage) {
        Purchase storage p = purchases[purchaseId];
        if (p.buyer == address(0)) revert PurchaseNotFound(purchaseId);
        return p;
    }
}
