import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { ethers, Wallet } from 'ethers';
import {
  createEVMAdapter,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

let fileSnapshotId: string;
let testSnapshotId: string;
const SELLER_KEY = HARDHAT_KEYS.EXTRA1;
const KC_ID = 1n;
const KA_ID = 1n;
const PRICE = ethers.parseEther('100');

describe('FairSwap Judge (EVMChainAdapter)', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const buyerAdapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, buyerAdapter.getSignerAddress(), ethers.parseEther('100000'));
  });

  afterAll(async () => {
    await revertSnapshot(fileSnapshotId);
  });

  beforeEach(async () => {
    testSnapshotId = await takeSnapshot();
  });

  afterEach(async () => {
    await revertSnapshot(testSnapshotId);
  });

  it('completes full purchase lifecycle: initiate → fulfill → reveal → claim', async () => {
    const sellerAddr = new Wallet(SELLER_KEY).address;
    const buyer = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const seller = createEVMAdapter(SELLER_KEY);

    const { purchaseId, success } = await buyer.initiatePurchase!(sellerAddr, KC_ID, KA_ID, PRICE);
    expect(success).toBe(true);
    expect(purchaseId).toBeGreaterThanOrEqual(1n);

    const p1 = await buyer.getFairSwapPurchase!(purchaseId);
    expect(p1!.state).toBe(1);

    const encryptedDataRoot = new Uint8Array(32);
    encryptedDataRoot[0] = 0xaa;

    const key = ethers.getBytes(ethers.hexlify(new Uint8Array(32).fill(0xcc)));
    const keyCommitment = ethers.getBytes(ethers.keccak256(key));

    const fulfillResult = await seller.fulfillPurchase!(purchaseId, encryptedDataRoot, keyCommitment);
    expect(fulfillResult.success).toBe(true);

    const p2 = await buyer.getFairSwapPurchase!(purchaseId);
    expect(p2!.state).toBe(2);

    const revealResult = await seller.revealKey!(purchaseId, key);
    expect(revealResult.success).toBe(true);

    const p3 = await buyer.getFairSwapPurchase!(purchaseId);
    expect(p3!.state).toBe(3);

    const provider = createProvider();
    await provider.send('evm_increaseTime', [86400 + 1]);
    await provider.send('evm_mine', []);

    const claimResult = await seller.claimPayment!(purchaseId);
    expect(claimResult.success).toBe(true);

    const p4 = await buyer.getFairSwapPurchase!(purchaseId);
    expect(p4!.state).toBe(4);
  });

  it('allows buyer to claim refund if seller never fulfills', async () => {
    const sellerAddr = new Wallet(SELLER_KEY).address;
    const buyer = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    const { purchaseId } = await buyer.initiatePurchase!(sellerAddr, KC_ID, KA_ID, PRICE);

    const provider = createProvider();
    await provider.send('evm_increaseTime', [86400 + 1]);
    await provider.send('evm_mine', []);

    const refundResult = await buyer.claimRefund!(purchaseId);
    expect(refundResult.success).toBe(true);

    const p = await buyer.getFairSwapPurchase!(purchaseId);
    expect(p!.state).toBe(7);
  });

  it('rejects fulfill from non-seller', async () => {
    const sellerAddr = new Wallet(SELLER_KEY).address;
    const buyer = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    const { purchaseId } = await buyer.initiatePurchase!(sellerAddr, KC_ID, KA_ID, PRICE);

    await expect(
      buyer.fulfillPurchase!(purchaseId, new Uint8Array(32), new Uint8Array(32)),
    ).rejects.toThrow();
  });

  it('returns null for nonexistent purchase', async () => {
    const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    const p = await adapter.getFairSwapPurchase!(999n);
    expect(p).toBeNull();
  });

  it('tracks purchase info correctly', async () => {
    const sellerAddr = new Wallet(SELLER_KEY).address;
    const buyer = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

    const { purchaseId } = await buyer.initiatePurchase!(sellerAddr, KC_ID, KA_ID, PRICE);
    const info = await buyer.getFairSwapPurchase!(purchaseId);

    expect(info).not.toBeNull();
    expect(info!.buyer.toLowerCase()).toBe(buyer.getSignerAddress().toLowerCase());
    expect(info!.seller.toLowerCase()).toBe(sellerAddr.toLowerCase());
    expect(info!.kcId).toBe(KC_ID);
    expect(info!.kaId).toBe(KA_ID);
    expect(info!.price).toBe(PRICE);
  });
});
