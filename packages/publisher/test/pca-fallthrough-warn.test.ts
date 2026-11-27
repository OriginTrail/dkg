/** Post-confirmation PCA observations must be bounded and describe receipt facts.
 * Missing CostCovered alone does not establish PCA failure or wallet spending:
 * registration escrow is consumed before the contract's PCA funding branch. */
import { describe, it, expect, vi } from 'vitest';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { warnPcaFallthrough } from '../src/pca-fallthrough.js';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { TypedEventBus, DKGEvent, generateEd25519Keypair } from '@origintrail-official/dkg-core';
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

async function makePublisher(chain: PcaProbeChain, wallet: ethers.Wallet, eventBus = new TypedEventBus()): Promise<DKGPublisher> {
  const keypair = await generateEd25519Keypair();
  const chainId = await chain.getEvmChainId();
  const kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  return wrapPublisherForTest(
    new DKGPublisher({
      store: new OxigraphStore(),
      chain,
      eventBus,
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
    .filter((m) => m.includes('PCA coverage not reported'));
}

describe('DKGPublisher: bounded PCA receipt observations (#1411)', () => {
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
    expect(warns[0]).toContain('receipt alone does not establish a PCA funding failure');
    expect(warns[0]).not.toContain('does not match'); // generic, not epochs-mismatch
    expect(warns[0]).toContain(`accountId=${accountId}`);
  });

  it('WARNS (generic reason, NOT epochs-mismatch) on the explicit path when the lifetime EQUALS the lock but the PCA cannot cover it', async () => {
    // Guards the `publishEpochs !== pcaLockEpochs` conjunct in the reason ternary:
    // an explicit lifetime that matches the lock but misses the discount
    // (underfunded/expired) must yield the generic reason, never the
    // self-contradictory "publishEpochs=24 does not match lockDurationEpochs=24".
    const wallet = new ethers.Wallet(TEST_KEY);
    const chain = new PcaProbeChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    const { accountId } = await chain.createPublishingConvictionAccount(1n); // underfunded
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makePublisher(chain, wallet);
    const warnSpy = spyPublisherWarn(publisher);

    const result = await publisher.publish({
      contextGraphId: '1',
      quads: quads('pca-explicit-match-underfunded'),
      publishEpochs: 24, // == lock (24), yet no CostCovered → generic reason, not epochs-mismatch
    });

    expect(result.status).toBe('confirmed');
    const warns = pcaFallthroughWarns(warnSpy);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('receipt alone does not establish a PCA funding failure');
    expect(warns[0]).not.toContain('does not match'); // matched epochs → NOT the mismatch branch
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
  it('reuses the selected adapter plan’s PCA evidence without another eligibility read', async () => {
    const wallet = new ethers.Wallet(TEST_KEY);
    class PlannedPcaChain extends PcaProbeChain {
      async resolvePublisherPublishPlan() {
        return { publisherAddress: wallet.address, publishEpochs: 12, tokenAmount: 12n,
          pcaCandidate: { accountId: 77n, lockDurationEpochs: 24 } };
      }
    }
    const chain = new PlannedPcaChain(wallet);
    const eligibility = vi.spyOn(chain, 'getConvictionAgentAccountId').mockRejectedValue(new Error('must reuse plan'));
    const publisher = await makePublisher(chain, wallet);
    const warn = spyPublisherWarn(publisher);
    expect((await publisher.publish({ contextGraphId: '1', quads: quads('planned-pca') })).status).toBe('confirmed');
    expect(eligibility).not.toHaveBeenCalled();
    expect(pcaFallthroughWarns(warn)).toEqual([expect.stringContaining('accountId=77')]);
  });

  it.each(['account', 'lock'] as const)('finishes confirmation and emits KC_PUBLISHED when the diagnostic %s read never settles', async getter => {
    const wallet = new ethers.Wallet(TEST_KEY), chain = new PcaProbeChain(wallet);
    const { accountId } = await chain.createPublishingConvictionAccount(1n);
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const bus = new TypedEventBus(), published = vi.fn();
    bus.on(DKGEvent.KC_PUBLISHED, published);
    const publisher = await makePublisher(chain, wallet, bus);
    const warn = spyPublisherWarn(publisher);
    if (getter === 'account') vi.spyOn(chain, 'getConvictionAgentAccountId').mockImplementation(() => new Promise(() => {}));
    else vi.spyOn(chain, 'getConvictionAccountLockDurationEpochs').mockImplementation(() => new Promise(() => {}));
    const result = await publisher.publish({ contextGraphId: '1', quads: quads(`stalled-${getter}`), publishEpochs: 5 });
    expect(result.status).toBe('confirmed');
    expect(published).toHaveBeenCalledOnce();
    expect(pcaFallthroughWarns(warn)).toEqual([]);
  }, 5_000);

  it('shares one 500ms budget across a slow account lookup and a stalled lock lookup', async () => {
    const wallet = new ethers.Wallet(TEST_KEY), chain = new PcaProbeChain(wallet);
    const account = vi.spyOn(chain, 'getConvictionAgentAccountId')
      .mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(1n), 450)));
    const lock = vi.spyOn(chain, 'getConvictionAccountLockDurationEpochs')
      .mockImplementation(() => new Promise(() => {}));
    const warn = vi.fn();
    let settled = false;
    // Install the clock before the helper creates the production deadline.
    // The full-publisher tests above separately prove confirmation/event delivery.
    vi.useFakeTimers();
    try {
      const result = warnPcaFallthrough(chain, {
        kind: 'on-chain', publisherAddress: wallet.address, publishEpochs: 5, tokenAmount: 1n,
        signer: { address: wallet.address, source: 'chainAdapter',
          signMessage: message => wallet.signMessage(message),
          signTypedData: (domain, types, value) => wallet.signTypedData(domain, types, value) },
      }, 5, { batchId: 1n, txHash: '0x01', blockNumber: 1, blockTimestamp: 1,
        publisherAddress: wallet.address }, warn).then(() => { settled = true; });
      expect(account).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(450);
      expect(lock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(49);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // Assert before awaiting: a longer deadline must fail instead of waiting it out.
      expect(settled).toBe(true);
      await result;
      expect(warn).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it('does not infer wallet spending or failed PCA coverage from an escrow-compatible receipt', async () => {
    const wallet = new ethers.Wallet(TEST_KEY), chain = new PcaProbeChain(wallet);
    chain.pcaLockDurationEpochs = 24;
    const { accountId } = await chain.createPublishingConvictionAccount(ethers.parseEther('10000'));
    await chain.registerPublishingConvictionAgent(accountId, wallet.address);
    const publisher = await makePublisher(chain, wallet), warn = spyPublisherWarn(publisher);
    // The adapter currently exposes only CostCovered. Its absence is also the
    // projection of a fully escrow-funded receipt; no other funding claim is possible.
    expect((await publisher.publish({ contextGraphId: '1', quads: quads('escrow-compatible'), publishEpochs: 24 })).status).toBe('confirmed');
    const message = pcaFallthroughWarns(warn)[0]!;
    expect(message).toContain('registration escrow may have funded');
    expect(message).not.toMatch(/FULL price|direct wallet spend|could not cover|underfunded|expired/);
  });

});
