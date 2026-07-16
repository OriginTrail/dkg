/**
 * GH #373 — DKGPublisher must support adapter-backed signing.
 *
 * When no local publisher private key is configured but the ChainAdapter
 * exposes `signMessageAs`, `getPublisherSigner` must fall back to a
 * 'chainAdapter'-sourced signer (rather than returning undefined / forcing a
 * local key). Fix: `packages/publisher/src/dkg-publisher.ts` `getPublisherSigner`
 * — reverting that fallback branch makes this test go red.
 *
 * This drives the fallback directly (the publish-path tests in
 * publisher-no-random-wallet.test.ts use a precomputed seal + mock ACK, so they
 * do not exercise this branch).
 */
import { describe, it, expect } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// Minimal adapter that signs via `signMessageAs` (the adapter-backed path) and
// carries NO local publisher private key on the publisher itself.
class AdapterOnlySigningChain {
  readonly chainId = 'mock:31337';
  lastSignAddress?: string; // capture the address the publisher forwards
  constructor(private readonly wallet: ethers.Wallet) {}
  isV10Ready(): boolean {
    return true;
  }
  async signMessageAs(address: string, messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    this.lastSignAddress = address;
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return { r: ethers.getBytes(sig.r), vs: ethers.getBytes(sig.yParityAndS) };
  }
}

describe('GH #373 — adapter-backed publisher signing', () => {
  it('getPublisherSigner falls back to a chainAdapter-sourced signer when no local key is set', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new AdapterOnlySigningChain(wallet);
    const publisher = new DKGPublisher({
      store: new OxigraphStore(),
      chain: chain as unknown as ChainAdapter,
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherNodeIdentityId: 1n,
    });

    // `getPublisherSigner` is private — exercise the fallback directly.
    const signer = await (publisher as unknown as {
      getPublisherSigner(a: string): Promise<{ source: string; signMessage(m: Uint8Array): Promise<string> } | undefined>;
    }).getPublisherSigner(wallet.address);

    // Pre-fix: this branch was absent and the call returned `undefined`.
    expect(signer).toBeDefined();
    expect(signer!.source).toBe('chainAdapter');

    // The returned signer signs through the adapter and recovers to the address.
    const msg = ethers.toUtf8Bytes('gh-373-adapter-signing');
    const sig = await signer!.signMessage(msg);
    expect(ethers.verifyMessage(msg, sig).toLowerCase()).toBe(wallet.address.toLowerCase());

    // getPublisherSigner must forward the SELECTED publisher address to the adapter
    // (a regression passing `undefined` / `this.publisherAddress` / a pool address
    // could still produce a valid sig here but fail against the real address-keyed adapter).
    expect(chain.lastSignAddress?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
