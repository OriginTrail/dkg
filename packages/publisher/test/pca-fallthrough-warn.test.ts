/**
 * #1411 — silent PCA full-price fall-through warning.
 *
 * The on-chain PCA discount (`KnowledgeAssetsV10.publish`) applies only when
 * the signer is a registered, non-expired PCA agent AND
 * `p.epochs == lockDurationEpochs`. Any miss silently falls through to a
 * FULL-price direct wallet spend with no revert — historically with no signal
 * at all. `DKGPublisher.publish()` now emits a post-confirmation `log.warn`
 * whenever a registered PCA agent's publish did NOT draw on the PCA
 * (`onChainResult.convictionCostCovered` absent). This is LOG-ONLY — no
 * publish behavior changes.
 *
 * These cases pin that warning:
 *   1. Explicit lifetime ≠ lock → WARN (epochs-mismatch reason).
 *   2. Default-path underfunded PCA → WARN (generic reason).
 *   3. Covered publish (`convictionCostCovered` present) → NO warn.
 *   4. Non-PCA signer on the explicit path → NO warn.
 *   5. Eligibility probe throws on the explicit path → NO warn, publish succeeds.
 *
 * Self-contained harness (mirrors `publisher-no-random-wallet.test.ts`): the
 * shared seal/ACK ceremony comes from `./_helpers/*`, the chain doubles are
 * local so this regression file runs standalone in the unit lane
 * (`vitest.unit.config.ts`).
 */
import { describe, it, expect, vi } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import {
  MockChainAdapter,
  type OnChainPublishResult,
  type V10PublishDirectParams,
} from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { wrapPublisherForTest, mockSealCtx } from './_helpers/seal.js';
import { mockChainStubACKProvider } from './_helpers/acks.js';

const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// Signs publish/ACK/seal material with `wallet` (mirrors the
// `AdapterSigningChain` in publisher-no-random-wallet.test.ts).
class AdapterSigningChain extends MockChainAdapter {
  constructor(private readonly wallet: ethers.Wallet) {
    super('mock:31337', wallet.address);
    this.seedIdentity(wallet.address, 1n);
    this.minimumRequiredSignatures = 1;
  }

  override async signMessage(messageHash: Uint8Array): Promise<{ r: Uint8Array; vs: Uint8Array }> {
    const sig = ethers.Signature.from(await this.wallet.signMessage(messageHash));
    return {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    };
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<{ name: string; type: string }>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    return this.wallet.signTypedData(domain, types, value);
  }
}

// A single conviction double with three test-controlled seams:
//  - `pcaLockDurationEpochs`  → what the SDK sees as the account lock.
//  - `injectConvictionCovered` → attach a `CostCovered` result (a discounted
//    publish) that the real adapter would decode from the receipt (B1 — the
//    stock mock never emits it).
//  - `throwOnAgentLookup`     → model an eligibility-probe RPC failure.
class PcaProbeChain extends AdapterSigningChain {
  pcaLockDurationEpochs?: number;
  injectConvictionCovered = false;
  throwOnAgentLookup = false;

  override async getConvictionAccountLockDurationEpochs(accountId: bigint): Promise<number> {
    return this.pcaLockDurationEpochs ?? super.getConvictionAccountLockDurationEpochs(accountId);
  }

  override async getConvictionAgentAccountId(agent: string): Promise<bigint> {
    if (this.throwOnAgentLookup) throw new Error('mock: conviction eligibility RPC unavailable');
    return super.getConvictionAgentAccountId(agent);
  }

  override async createKnowledgeAssets(params: V10PublishDirectParams): Promise<OnChainPublishResult> {
    const base = await super.createKnowledgeAssets(params);
    if (!this.injectConvictionCovered) return base;
    // Shape mirrors `chain-adapter.ts` `OnChainPublishResult.convictionCostCovered`
    // (the B8 badge signal) — its mere presence means the publish drew on the PCA.
    return {
      ...base,
      convictionCostCovered: {
        accountId: 1n,
        epoch: 0,
        baseCost: 100n,
        discountedCost: 80n,
        drawnFromEpoch: 80n,
        drawnFromTopUp: 0n,
      },
    };
  }
}

async function makePublisher(chain: PcaProbeChain, wallet: ethers.Wallet): Promise<DKGPublisher> {
  const keypair = await generateEd25519Keypair();
  const chainId = await chain.getEvmChainId();
  const kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  return wrapPublisherForTest(
    new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus: new TypedEventBus(),
      keypair,
      publisherNodeIdentityId: 1n,
    }),
    {
      author: wallet,
      ctx: mockSealCtx({ chainId, kav10Address }),
      v10ACKProvider: mockChainStubACKProvider(),
    },
  );
}

function quads(label: string) {
  return [{
    subject: `urn:test:${label}`,
    predicate: 'http://schema.org/name',
    object: `"${label}"`,
    graph: 'did:dkg:context-graph:1',
  }];
}

// The publisher logs several unrelated warnings on the publish hot path
// (RS scoped-promote, token-amount pricing, etc.), so we filter to the
// specific full-price fall-through warning rather than asserting "no warn".
function spyPublisherWarn(publisher: DKGPublisher) {
  return vi.spyOn((publisher as unknown as { log: { warn: (...a: unknown[]) => void } }).log, 'warn');
}
function pcaFallthroughWarns(warnSpy: ReturnType<typeof spyPublisherWarn>): string[] {
  return warnSpy.mock.calls
    .map((c) => String(c[1]))
    .filter((m) => m.includes('PCA discount NOT applied'));
}

describe('DKGPublisher: warns on silent PCA full-price fall-through (#1411)', () => {
  it('WARNS (epochs-mismatch reason) when an explicit lifetime does not match the PCA lock', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('pca-explicit-mismatch-warn'),
      publishEpochs: 5, // ≠ lock (24) → discount silently lost
    });

    expect(result.status).toBe('confirmed');
    const warns = pcaFallthroughWarns(warnSpy);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('does not match the account');
    expect(warns[0]).toContain('publishEpochs=5');
    expect(warns[0]).toContain('lockDurationEpochs=24');
    expect(warns[0]).toContain(`accountId=${accountId}`);
  });

  it('WARNS (generic reason) when a default-path publish falls through on an underfunded PCA', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    // 1-wei commit → baseEpochAllowance floors to 0 → cannot cover this
    // publish's cost → no coercion → direct full-price spend on the default path.
    const { accountId } = await chain.createPublishingConvictionAccount(1n);
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    expect(await chain.convictionAccountCanCover(accountId, ethers.parseEther('1'))).toBe(false);
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('pca-default-underfunded-warn'), // no explicit epochs
    });

    expect(result.status).toBe('confirmed');
    const warns = pcaFallthroughWarns(warnSpy);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('could not cover this publish');
    expect(warns[0]).not.toContain('does not match'); // generic, not epochs-mismatch
    expect(warns[0]).toContain(`accountId=${accountId}`);
  });

  it('does NOT warn when the publish actually drew on the PCA (CostCovered present)', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    chain.injectConvictionCovered = true; // covered publish → discount applied
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('pca-covered-no-warn'), // default lifetime → coerced + covered
    });

    expect(result.status).toBe('confirmed');
    expect(pcaFallthroughWarns(warnSpy)).toHaveLength(0);
  });

  it('does NOT warn when the explicit-path signer is not a PCA agent', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet); // no PCA registered → agent lookup returns 0n
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('non-pca-explicit-no-warn'),
      publishEpochs: 5,
    });

    expect(result.status).toBe('confirmed');
    expect(pcaFallthroughWarns(warnSpy)).toHaveLength(0);
  });

  it('does NOT warn and still publishes when the eligibility probe throws on the explicit path', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet);
    chain.throwOnAgentLookup = true; // best-effort probe fails
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('pca-probe-throws-no-warn'),
      publishEpochs: 5,
    });

    expect(result.status).toBe('confirmed');
    expect(pcaFallthroughWarns(warnSpy)).toHaveLength(0);
  });
});
