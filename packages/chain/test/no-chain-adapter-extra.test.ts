/**
 * NoChainAdapter exhaustive "every method throws with stable message" matrix.
 *
 * Audit findings covered:
 *
 *   CH-9 (HIGH) — Existing `no-chain-adapter.test.ts` exercises a hand-picked
 *                subset of methods (registerIdentity, ensureProfile, etc.)
 *                but OMITS the V10 surface (`createKnowledgeAssets`,
 *                `getKnowledgeAssetsLifecycleAddress`, `getEvmChainId`) plus
 *                `isV10Ready` and the V10 update path. A future refactor
 *                that accidentally returns a placeholder from one of these
 *                will silently pass.
 *
 *                This file pins the FULL surface: every optional and
 *                required `ChainAdapter` method either throws the stable
 *                "No blockchain configured" message or returns the
 *                documented safe value (`0n` for `getIdentityId`, `false`
 *                for `isV10Ready`, chainId constants).
 *
 * Per QA policy: if a real gap is exposed (e.g. a new V10 method is added
 * to ChainAdapter but NoChainAdapter does not implement it), the
 * TypeScript compiler + this matrix together surface it.
 */
import { describe, it, expect } from 'vitest';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

const STABLE_MSG = 'No blockchain configured';

describe('NoChainAdapter — stable identity and capability gate [CH-9]', () => {
  const adapter = new NoChainAdapter();

  it('exposes chainType "evm" (matches ChainAdapter literal)', () => {
    expect(adapter.chainType).toBe('evm');
  });

  it('exposes chainId "none" (sentinel — callers rely on this string for capability checks)', () => {
    expect(adapter.chainId).toBe('none');
  });

  it('getIdentityId returns 0n (NOT a throw — callers use 0n as "no identity")', async () => {
    await expect(adapter.getIdentityId()).resolves.toBe(0n);
  });

  it('isV10Ready returns false (capability gate — must never be truthy without a chain)', () => {
    expect(adapter.isV10Ready()).toBe(false);
  });
});

describe('NoChainAdapter — every write method throws with stable message [CH-9]', () => {
  const adapter = new NoChainAdapter();

  const zeroBytes = new Uint8Array();
  const zeroSig = { r: zeroBytes, vs: zeroBytes };

  const matrix: Array<[string, () => Promise<unknown>]> = [
    ['registerIdentity', () => adapter.registerIdentity({ publicKey: zeroBytes, signature: zeroBytes })],
    ['ensureProfile', () => adapter.ensureProfile()],
    ['ensureProfile(with options)', () => adapter.ensureProfile({ nodeName: 'x', stakeAmount: 0n })],
    // V10 staking consolidation: ensureProfile accepts an optional lockTier
    // (passed through to DKGStakingConvictionNFT.createConviction by the
    // EVM adapter). Asserting it stays in the no-chain rejection surface
    // catches accidental signature regressions from either side.
    ['ensureProfile(with lockTier)', () => adapter.ensureProfile({ stakeAmount: 1n, lockTier: 1 })],
    ['reserveUALRange', () => adapter.reserveUALRange(1)],
    ['batchMintKnowledgeAssets', () =>
      adapter.batchMintKnowledgeAssets({
        publisherNodeIdentityId: 0n,
        merkleRoot: zeroBytes,
        startKAId: 0n,
        endKAId: 0n,
        publicByteSize: 0n,
        epochs: 1,
        tokenAmount: 0n,
        publisherSignature: zeroSig,
        receiverSignatures: [],
      })],
    // V9 publishKnowledgeAssets / updateKnowledgeAssets / extendStorage /
    // transferNamespace stubs were archived in `archive-non-v10-contracts`.
    ['createContextGraph', () => adapter.createContextGraph({})],
    ['submitToContextGraph', () => adapter.submitToContextGraph('kc1', 'cg1')],
    ['revealContextGraphMetadata', () => adapter.revealContextGraphMetadata('cg1', 'n', 'd')],
    // V10 surface — the audit finding CH-9 specifically calls out that
    // these are NOT exercised today. They are required on ChainAdapter and
    // must throw consistently here.
    ['createKnowledgeAssets', () =>
      adapter.createKnowledgeAssets({
        publishOperationId: '0x' + '0'.repeat(64),
        contextGraphId: 1n,
        merkleRoot: zeroBytes,
        knowledgeAssetsAmount: 1,
        byteSize: 0n,
        epochs: 1,
        tokenAmount: 0n,
        isImmutable: false,
        merkleLeafCount: 1,
        publisherNodeIdentityId: 0n,
        author: {
          address: '0x0000000000000000000000000000000000000001',
          signature: zeroSig,
          schemeVersion: 1,
        },
        ackSignatures: [],
      })],
    ['getKnowledgeAssetsLifecycleAddress', () => adapter.getKnowledgeAssetsLifecycleAddress()],
    ['getEvmChainId', () => adapter.getEvmChainId()],
    // The 7 #519 PCA write+read methods are deliberately NOT in this
    // throw-matrix: NoChainAdapter omits them so the DKGAgent facade's
    // `typeof guard` returns the documented `null` (feature-unavailable)
    // instead of throwing. See the "facade contract" describe block below.
  ];

  it.each(matrix)('%s throws %s', async (_name, fn) => {
    await expect(fn()).rejects.toThrow(STABLE_MSG);
  });

  it('listenForEvents async iterator throws when iterated (not on construction)', async () => {
    const iter = adapter.listenForEvents({ eventTypes: ['any'] });
    await expect(async () => {
      for await (const _evt of iter) { /* consume */ }
    }).rejects.toThrow(STABLE_MSG);
  });

  it('error message mentions DKG_PRIVATE_KEY / chainConfig hint (ops guidance is stable)', async () => {
    await expect(adapter.ensureProfile()).rejects.toThrow(/chainConfig|DKG_PRIVATE_KEY/);
  });
});

describe('NoChainAdapter — #519 PCA facade contract (must return null, not throw)', () => {
  const adapter = new NoChainAdapter();

  // The 7 PCA methods are OPTIONAL on ChainAdapter. The DKGAgent facade
  // guards each with `if (typeof this.chain.X !== 'function') return null`.
  // NoChainAdapter MUST omit them so a direct SDK caller in no-chain mode
  // gets the documented `null` (feature-unavailable) instead of a throw.
  const facade = (name: keyof NoChainAdapter) => {
    const fn = (adapter as Record<string, unknown>)[name as string];
    if (typeof fn !== 'function') return null;
    return (fn as (...a: unknown[]) => unknown).call(adapter, 1n, 0n);
  };

  const pcaMethods = [
    'createPublishingConvictionAccount',
    'topUpPublishingConvictionAccount',
    'registerPublishingConvictionAgent',
    'deregisterPublishingConvictionAgent',
    'isPublishingConvictionAgent',
    'settlePublishingConvictionAccount',
    'getPublishingConvictionAccountInfo',
  ] as const;

  it.each(pcaMethods)('facade over NoChainAdapter.%s returns null (does NOT throw)', (name) => {
    expect(() => facade(name)).not.toThrow();
    expect(facade(name)).toBeNull();
  });

  it('getPublishingConvictionAccountOwner stays (pre-existing, out of scope) and still throws', async () => {
    await expect(adapter.getPublishingConvictionAccountOwner(1n)).rejects.toThrow(STABLE_MSG);
  });
});
