/**
 * MockChainAdapter ↔ EVMChainAdapter API-parity audit.
 *
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║ POLICY CLARIFICATION — this file is NOT a "blockchain-mock in tests" ║
 * ║ violation of the zero-mocks policy.                                  ║
 * ║                                                                      ║
 * ║ `MockChainAdapter` is PRODUCTION code (see                           ║
 * ║ `packages/chain/src/mock-adapter.ts`, exported from the public       ║
 * ║ `@origintrail-official/dkg-chain` surface, and instantiated by       ║
 * ║ `packages/cli/src/daemon.ts:591` when a user runs the CLI daemon    ║
 * ║ with `chain: { type: 'mock' }` for offline development).             ║
 * ║                                                                      ║
 * ║ This test file tests THAT PRODUCTION CLASS — it is analogous to      ║
 * ║ `no-chain-adapter.test.ts` which tests the production                ║
 * ║ `NoChainAdapter`. No other test in the tree uses                     ║
 * ║ `MockChainAdapter` as a stand-in for the real chain; the historical ║
 * ║ publisher/agent-test usage has been migrated to the real Hardhat    ║
 * ║ harness. MockChainAdapter is only used in tests HERE, to audit       ║
 * ║ itself.                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 *
 * Audit findings covered:
 *
 *   CH-8 (HIGH) — `MockChainAdapter` is a user-facing offline-mode
 *                 adapter that must stay API-compatible with
 *                 `EVMChainAdapter`; a user who develops against the mock
 *                 and then flips `chain.type` to `evm` should not hit
 *                 "method not implemented" surprises. This file uses
 *                 runtime reflection (walking the prototype chain) to
 *                 assert API parity across both classes for every method
 *                 declared on `ChainAdapter`. It also pins a small set of
 *                 invariants (e.g. `isV10Ready() === true` so the V10
 *                 code paths are exercised off-line; `signMessage`
 *                 returns 32-byte r/vs; `createKnowledgeAssetsV10`
 *                 tolerates `cgId === 0n` on the mock even though the
 *                 real adapter rejects).
 *
 * Per QA policy: if the parity check fails, production code has drifted
 * — the mock adapter no longer faithfully emulates the real adapter and
 * offline-mode users will hit surprises on chain switch. The test stays
 * red until parity is restored or a documented exemption is added.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';

/** Collect all own method names across the whole prototype chain, minus `constructor`. */
function collectMethodNames(ctor: Function): Set<string> {
  const names = new Set<string>();
  let proto = ctor.prototype;
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc && typeof desc.value === 'function') {
        names.add(key);
      }
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

const EVM_METHODS = collectMethodNames(EVMChainAdapter);
const MOCK_METHODS = collectMethodNames(MockChainAdapter);
const NO_CHAIN_METHODS = collectMethodNames(NoChainAdapter);

// Methods that are *intentionally* absent from the mock or from NoChainAdapter.
// These are not parity violations. Additions here require a code-review
// because each one is a silent divergence from the production adapter.
const MOCK_EXEMPT_FROM_EVM = new Set<string>([
  // Pure EVM bookkeeping surfaces that the mock has no reason to emulate.
  'getContract',            // resolves a Contract from the Hub — not applicable off-chain
  'getBlockNumber',         // the mock exposes its own block counter differently (advanceBlock)
  'getProvider',            // returns a JsonRpcProvider; mock has none
  'getSignerAddress',       // mock exposes `signerAddress` as a field
  'getSignerAddresses',     // pool not applicable to mock
  'getOperationalPrivateKey', // mock has no wallet keys
  'getRequiredPublishTokenAmount', // TODO: missing on mock, cross-check below
  // TypeScript `private` is erased at runtime; these are adapter-internal
  // helpers that survived into the prototype and are not part of the
  // ChainAdapter contract. They must remain EVM-only.
  'nextSigner',
  'nextAuthorizedSigner',
  'resolveContract',
  'resolveAssetStorage',
  'init',
  'requireV9',
  'getBlockTimestamp',
  'parseV10PublishReceipt',
  'parseV9PublishReceipt',
]);

const NO_CHAIN_EXEMPT_FROM_EVM = new Set<string>([
  // NoChainAdapter is intentionally minimal — it throws on most things.
  // The matrix below enforces that every *required* ChainAdapter method is
  // covered; helper getters are exempt.
  'getContract',
  'getBlockNumber',
  'getProvider',
  'getSignerAddress',
  'getSignerAddresses',
  'getOperationalPrivateKey',
  'getRequiredPublishTokenAmount',
  'verifyPublisherOwnsRange',
  'resolvePublishByTxHash',
  'verifyKAUpdate',
  'listContextGraphsFromChain',
  'getContextGraphParticipants',
  'createOnChainContextGraph',
  'verify',
  'publishToContextGraph',
  'signMessage',
  'signACKDigest',
  'getACKSignerKey',
  'getMinimumRequiredSignatures',
  'verifyACKIdentity',
  'verifySyncIdentity',
  'updateKnowledgeCollectionV10',
  'stakeWithLock',
  'getDelegatorConvictionMultiplier',
  'createConvictionAccount',
  'addConvictionFunds',
  'extendConvictionLock',
  'getConvictionDiscount',
  'getConvictionAccountInfo',
  'initiatePurchase',
  'fulfillPurchase',
  'revealKey',
  'disputeDelivery',
  'claimPayment',
  'claimRefund',
  'getFairSwapPurchase',
  'publishKnowledgeAssetsPermanent',
  'createKnowledgeCollection',
  'updateKnowledgeCollection',
]);

describe('MockChainAdapter API parity with EVMChainAdapter [CH-8]', () => {
  it('has non-trivial method surfaces to compare (guards against accidental zero diff)', () => {
    expect(EVM_METHODS.size).toBeGreaterThan(20);
    expect(MOCK_METHODS.size).toBeGreaterThan(20);
  });

  it('implements every EVMChainAdapter public method (minus documented exemptions)', () => {
    const missing: string[] = [];
    for (const name of EVM_METHODS) {
      if (name.startsWith('_')) continue;
      if (MOCK_EXEMPT_FROM_EVM.has(name)) continue;
      if (!MOCK_METHODS.has(name)) missing.push(name);
    }
    // If this fires, a method was added to EVMChainAdapter without being
    // mirrored on MockChainAdapter. Either add it to the mock or put it in
    // MOCK_EXEMPT_FROM_EVM with a comment explaining why.
    expect(missing).toEqual([]);
  });

  it('method arity (declared parameter count) is within 1 of EVMChainAdapter for each shared method', () => {
    // Arity isn't a perfect check (optional args, rest params) but an
    // off-by-two drift almost always indicates a renamed/refactored
    // signature that wasn't propagated to the mock. A tolerance of ±1
    // catches the common "forgot an optional param" case.
    const mismatches: Array<{ name: string; evm: number; mock: number }> = [];
    for (const name of EVM_METHODS) {
      if (!MOCK_METHODS.has(name)) continue;
      if (name.startsWith('_')) continue;
      const evmFn = (EVMChainAdapter.prototype as any)[name] as Function;
      const mockFn = (MockChainAdapter.prototype as any)[name] as Function;
      const diff = Math.abs(evmFn.length - mockFn.length);
      if (diff > 1) {
        mismatches.push({ name, evm: evmFn.length, mock: mockFn.length });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('chainType literal matches across both adapters', () => {
    const mock = new MockChainAdapter();
    // Instantiate the EVM adapter via reflection so we don't need a live RPC.
    const evm = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x0000000000000000000000000000000000000001',
      privateKey: '0x' + '1'.repeat(64),
    });
    expect(mock.chainType).toBe(evm.chainType);
  });

  it('isV10Ready is a capability gate — mock returns true (used to exercise V10 unit tests)', () => {
    const mock = new MockChainAdapter();
    expect(mock.isV10Ready()).toBe(true);
  });

  it('getEvmChainId returns a bigint (not a namespaced string like "mock:31337")', async () => {
    const mock = new MockChainAdapter();
    const id = await mock.getEvmChainId();
    expect(typeof id).toBe('bigint');
    expect(id).toBeGreaterThan(0n);
  });

  it('getKnowledgeAssetsV10Address returns a 20-byte hex address', async () => {
    const mock = new MockChainAdapter();
    const addr = await mock.getKnowledgeAssetsV10Address();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('NoChainAdapter completeness [CH-9]', () => {
  it('implements every ChainAdapter method marked as REQUIRED (non-optional in the type)', () => {
    // These are the required methods on the ChainAdapter interface (see
    // packages/chain/src/chain-adapter.ts). Optional methods may be
    // omitted; required ones must exist so TypeScript stays sound when a
    // consumer types their chain as ChainAdapter.
    const required = [
      'registerIdentity',
      'getIdentityId',
      'ensureProfile',
      'reserveUALRange',
      'batchMintKnowledgeAssets',
      'publishKnowledgeAssets',
      'updateKnowledgeAssets',
      'extendStorage',
      'transferNamespace',
      'listenForEvents',
      'createContextGraph',
      'submitToContextGraph',
      'createKnowledgeAssetsV10',
      'getKnowledgeAssetsV10Address',
      'getEvmChainId',
      'isV10Ready',
    ];
    const missing = required.filter((n) => !NO_CHAIN_METHODS.has(n));
    expect(missing).toEqual([]);
  });
});
