import { describe, it, expect } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';

const SELLER = '0x' + 'a'.repeat(40);
const KC_ID = 1n;
const KA_ID = 1n;
const PRICE = 10_000n * 10n ** 18n;

describe('FairSwap Judge (MockChainAdapter)', () => {
  it('completes full purchase lifecycle: initiate → fulfill → reveal → claim', async () => {
    const adapter = new MockChainAdapter();

    // Step 1: Buyer initiates purchase
    const { purchaseId, success } = await adapter.initiatePurchase(SELLER, KC_ID, KA_ID, PRICE);
    expect(success).toBe(true);
    expect(purchaseId).toBe(1n);

    const p1 = await adapter.getFairSwapPurchase(purchaseId);
    expect(p1!.state).toBe(1); // Initiated

    // Step 2: Seller fulfills with encrypted data root and key commitment
    const encryptedDataRoot = new Uint8Array(32);
    encryptedDataRoot[0] = 0xaa;
    const keyCommitment = new Uint8Array(32);
    keyCommitment[0] = 0xbb;

    const fulfillResult = await adapter.fulfillPurchase(purchaseId, encryptedDataRoot, keyCommitment);
    expect(fulfillResult.success).toBe(true);

    const p2 = await adapter.getFairSwapPurchase(purchaseId);
    expect(p2!.state).toBe(2); // Fulfilled

    // Step 3: Seller reveals key
    const key = new Uint8Array(32);
    key[0] = 0xcc;
    const revealResult = await adapter.revealKey(purchaseId, key);
    expect(revealResult.success).toBe(true);

    const p3 = await adapter.getFairSwapPurchase(purchaseId);
    expect(p3!.state).toBe(3); // KeyRevealed

    // Step 4: Seller claims payment after timeout
    const claimResult = await adapter.claimPayment(purchaseId);
    expect(claimResult.success).toBe(true);

    const p4 = await adapter.getFairSwapPurchase(purchaseId);
    expect(p4!.state).toBe(4); // Completed
  });

  it('allows buyer to dispute after key reveal', async () => {
    const adapter = new MockChainAdapter();

    const { purchaseId } = await adapter.initiatePurchase(SELLER, KC_ID, KA_ID, PRICE);
    await adapter.fulfillPurchase(purchaseId, new Uint8Array(32), new Uint8Array(32));
    await adapter.revealKey(purchaseId, new Uint8Array(32));

    // Buyer disputes with proof
    const proof = new Uint8Array(64); // merkle proof
    const disputeResult = await adapter.disputeDelivery(purchaseId, proof);
    expect(disputeResult.success).toBe(true);

    const p = await adapter.getFairSwapPurchase(purchaseId);
    expect(p!.state).toBe(5); // Disputed (refunded)
  });

  it('allows buyer to claim refund if seller never fulfills', async () => {
    const adapter = new MockChainAdapter();

    const { purchaseId } = await adapter.initiatePurchase(SELLER, KC_ID, KA_ID, PRICE);

    // Seller never fulfills → buyer claims refund
    const refundResult = await adapter.claimRefund(purchaseId);
    expect(refundResult.success).toBe(true);

    const p = await adapter.getFairSwapPurchase(purchaseId);
    expect(p!.state).toBe(7); // Expired
  });

  it('rejects fulfill on already fulfilled purchase', async () => {
    const adapter = new MockChainAdapter();

    const { purchaseId } = await adapter.initiatePurchase(SELLER, KC_ID, KA_ID, PRICE);
    await adapter.fulfillPurchase(purchaseId, new Uint8Array(32), new Uint8Array(32));

    // Second fulfill should fail
    const result = await adapter.fulfillPurchase(purchaseId, new Uint8Array(32), new Uint8Array(32));
    expect(result.success).toBe(false);
  });

  it('returns null for nonexistent purchase', async () => {
    const adapter = new MockChainAdapter();
    const p = await adapter.getFairSwapPurchase(999n);
    expect(p).toBeNull();
  });

  it('tracks purchase info correctly', async () => {
    const adapter = new MockChainAdapter();

    const { purchaseId } = await adapter.initiatePurchase(SELLER, KC_ID, KA_ID, PRICE);
    const info = await adapter.getFairSwapPurchase(purchaseId);

    expect(info).not.toBeNull();
    expect(info!.buyer).toBe(adapter.signerAddress);
    expect(info!.seller).toBe(SELLER);
    expect(info!.kcId).toBe(KC_ID);
    expect(info!.kaId).toBe(KA_ID);
    expect(info!.price).toBe(PRICE);
  });
});
