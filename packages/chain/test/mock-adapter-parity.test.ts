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
 *                 returns 32-byte r/vs; `createKnowledgeAssets`
 *                 tolerates `cgId === 0n` on the mock even though the
 *                 real adapter rejects).
 *
 * Per QA policy: if the parity check fails, production code has drifted
 * — the mock adapter no longer faithfully emulates the real adapter and
 * offline-mode users will hit surprises on chain switch. The test stays
 * red until parity is restored or a documented exemption is added.
 */
import { describe, it, expect } from 'vitest';
import { EVMChainAdapter, type EVMAdapterConfig } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES, SERVED_EVENT_TYPES } from '../src/evm-adapter-events.js';
import { MockChainAdapter } from '../src/mock-adapter.js';
import { NoChainAdapter } from '../src/no-chain-adapter.js';
import { ethers } from 'ethers';

/**
 * The EVM adapter with its FIVE owning contracts bound offline from the
 * SHIPPED client ABIs — so `supportsEventTypes` below is the REAL probe over
 * the real fragments, not a stub (review r8). Nothing dials: the probe only
 * inspects `contract.interface`.
 */
function makeOfflineEvmAdapter(): EVMChainAdapter {
  const config: EVMAdapterConfig = {
    rpcUrl: 'http://127.0.0.1:59998',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'evm:31337',
    staticNetwork: false,
  };
  const adapter = new EVMChainAdapter(config);
  const priv = adapter as unknown as { init: () => Promise<void>; contracts: Record<string, unknown> };
  priv.init = async () => { /* offline */ };
  const bind = (abiName: string, fill: string): ethers.Contract =>
    new ethers.Contract('0x' + fill.repeat(20), loadAbi(abiName));
  priv.contracts = {
    knowledgeAssetStorage: bind('DKGKnowledgeAssets', '11'),
    knowledgeAssetsStorage: bind('KnowledgeAssetsStorage', '12'),
    contextGraphStorage: bind('ContextGraphStorage', '13'),
    contextGraphNameRegistry: bind('ContextGraphNameRegistry', '14'),
    profileStorage: bind('ProfileStorage', '15'),
  };
  return adapter;
}

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

// Normal protected prototype methods that are deliberately outside the
// ChainAdapter API. Keeping this boundary explicit prevents production method
// shape from being chosen merely to evade the runtime parity audit.
const EVM_INTERNAL_METHODS = new Set<string>([
  'getContextGraphNameHashResolver',
  // KA root-mutation lane (PR #2436) — TS-private members of the events
  // mixin, visible to runtime reflection like every erased `private`. Both
  // take EVM-only inputs (an ethers `Contract`; an `EventFilter` routed
  // through `queryFilterWithFailover`) and are reachable from the outside
  // only through `listenForEvents` / `supportsEventTypes`, which ARE parity
  // surfaces and are implemented on the mock.
  'contractHasEvent',
  'yieldKnowledgeAssetRootMutationLogs',
]);

// Methods that are *intentionally* absent from the mock or from NoChainAdapter.
// These are not parity violations. Additions here require a code-review
// because each one is a silent divergence from the production adapter.
const MOCK_EXEMPT_FROM_EVM = new Set<string>([
  // Pure EVM bookkeeping surfaces that the mock has no reason to emulate.
  'getContract',            // resolves a Contract from the Hub — not applicable off-chain
  'getBlockNumber',         // the mock exposes its own block counter differently (advanceBlock)
  'getProvider',            // returns a JsonRpcProvider; mock has none
  'getReadProvider',        // @deprecated bare-primary accessor; mock has no RPC provider
  'getSignerAddress',       // mock exposes `signerAddress` as a field
  'getSignerAddresses',     // pool not applicable to mock
  'getAuthorizedPublisherAddress', // pool-specific signer selection; mock has one signerAddress
  'resolvePublisherPublishPlan', // EVM signer-pool planning; mock has one signerAddress
  'signMessageAs',          // pool-specific wallet-key signing; mock has no adapter-held private keys
  'getOperationalPrivateKey', // mock has no wallet keys
  'getRequiredPublishTokenAmount', // TODO: missing on mock, cross-check below
  // TypeScript `private` is erased at runtime; these are adapter-internal
  // helpers that survived into the prototype and are not part of the
  // ChainAdapter contract. They must remain EVM-only.
  'nextSigner',
  'nextAuthorizedSigner',
  'findSignerByAddress',
  // PR #2300 r2 — isReceiptBlockFinalAndCanonical is a REAL ChainAdapter capability now (update
  // recognition consumes it), and the mock implements it from its finality seam: no exemption.
  'resolvePinnedPublisherSigner', // EVM signer-pool authorization/funding helper; mock has no wallet pool
  'selectFundedSignerOrThrow', // strict funding diagnostic used by EVM publish planning
  'quoteRequiredPublishTokenAmount', // shared protected AskStorage quote behind EVM reads/planning
  // Protected EVM contract-read boundary shared by storage and publish mixins.
  // The public ChainAdapter method remains `getKnowledgeAssetUpdateContext`,
  // which MockChainAdapter implements and the parity suite still requires.
  'readKnowledgeAssetUpdateContext',
  'resolveFundedPublisherPublishPlan', // protected EVM pool/PCA planning state machine
  'publisherConvictionPlanReader', // protected typed bridge from publish planning to the conviction mixin
  // Dispatcher Phase 3/4 selector seam + RS send plumbing — TS-protected
  // internals (the generalized wallet selector, the funding predicate behind
  // it, the RS-specific selector wrapper, and the serialized RS send). Not
  // ChainAdapter interface methods; the mock has no wallet pool, funding, or
  // nonce surface to mirror — same category as the neighbours in this list.
  'selectSigner',
  'isWalletFundable',
  'nextRandomSamplingSigner',
  'sendRandomSamplingTx',
  // Funding-aware publish wallet selection internals (native+TRAC balance
  // reads, the fundability gate, the cache, and the insufficient-funds error
  // enrichment). EVM-only — the mock has no provider/ERC-20 balance surface
  // and selects from its single signerAddress, so there is nothing to mirror.
  'selectFundedSigner',
  'isWalletPublishFundable',
  'isConvictionFundedAgent',
  'getWalletFunding',
  'readNativeBalance',
  'readTracBalance',
  'snapshotPublisherWalletBalances',
  'poolHasFundableSigner',
  'enrichInsufficientPublisherFundsError',
  'looksLikeFundsRevert',
  'walletKeyHash',
  'hasAdminPurpose',
  'hasOperationalPurpose',
  'resolveContract',
  'resolveAssetStorage',
  // #1583 resolved-address memo internals: `resolveContract` delegates address
  // resolution to `resolveContractAddress` (memo lookup) → `readHubContractAddress`
  // (the raw `Hub.getContractAddress` read). EVM-only Hub plumbing — the mock has
  // no Hub — same category as `resolveContract` / `resolveAssetStorage` above.
  'resolveContractAddress',
  'readHubContractAddress',
  'init',
  'initContracts',          // TS-private: init() body extracted so RPC-exhaustion can be wrapped as RPC_ENDPOINTS_EXHAUSTED
  'requireV9',
  'getBlockTimestamp',
  // TS-private half of the EVM sign/broadcast/receipt split. The mock has no
  // raw RPC transport or signed-transaction acceptance boundary to emulate.
  'broadcastSignedTransactionWithRetries',
  'broadcastSignedTransactionWithFailover',
  'getTransactionReceiptWithFailover',
  'getTransactionWithFailover',
  'waitForReceiptWithFailover',
  'signPopulatedTransaction',
  // #1336 read-facade + populate plumbing: the chain-concept read facades over
  // the `RpcFailoverClient` transport — `readContract` (string-method point read),
  // `readContractWithOptions` (the cancellable string-method variant),
  // `readContractWith` (policy/classifier-bearing contract read), and the raw
  // `readProvider` — plus the event-log scan wrapper, the contract rebind helper,
  // and the populate+sign-across-providers delegator. Protected EVM-only helpers
  // over `this.providers[]` (the mock has no RPC provider pool), not ChainAdapter
  // contract methods — same category as the write-failover helpers above.
  'readContract',
  'readContractWithOptions',
  'readContractWith',
  'readProvider',
  'readTipProvider',
  'readProviderRetryingNull',
  'queryFilterWithFailover',
  'rebindContract',
  'populateAndSignAcrossProviders',
  'sendSignedTransactionAndWait',
  'sendPopulatedTransaction',
  'sendContractTransaction',
  // TS-private / protected write-serialization plumbing. The EVM adapter uses
  // this scope to expose an unlocked sender only while the per-wallet serializer
  // is held; the mock has no nonce-sign-broadcast window to mirror.
  'withSerializedSignerWrite',
  'sendContractTransactionUnlocked',
  'parseV10PublishReceipt',
  'parseV9PublishReceipt',
  // GH#2270 — TS-private single receipt read the three publish-resolution surfaces project from
  // (`resolvePublishByTxHash`, `resolvePublishTransaction`, `resolveCanonicalFinalizationReceipt`).
  // All three PUBLIC surfaces are mirrored on the mock; this is EVM receipt plumbing over
  // `getTransactionReceiptWithFailover` — same category as the two parse helpers above.
  'readPublishReceipt',
  // TS-private V10 TRAC-allowance helper backing publish/update. Encodes
  // the `chain.approvalPolicy` dispatch and the `transferFrom(..., 1n)`
  // floor; the mock has no ERC-20 allowance surface to mirror.
  'ensureV10ApproveTrac',
  // TS-private post-approve allowance visibility poll (#888). Backs the
  // forced re-approve retry on a stale-RPC `TooLowAllowance` revert; the
  // mock has no ERC-20 allowance surface to mirror.
  'confirmAllowanceVisible',
  // TS-private populate+sign helper with shared stale-allowance recovery
  // (#888) backing both V10 write paths (publish + update); the mock has no
  // populate/gas-estimation surface to mirror.
  'populateAndSignV10WithAllowanceRecovery',
  // TS-private shared dispatch for the two V10 write paths (#953). Serializes
  // the populate→sign→broadcast→confirm nonce window per operational wallet
  // via KeyedSerializer. The mock has no nonce/broadcast surface to mirror —
  // its writes return typed results directly without populating a tx.
  'dispatchSerializedV10Write',
  // Lazy-cache helpers for frequently-resolved contracts — TS-private,
  // not part of the ChainAdapter interface.
  'getIdentityStorage',
  'getConvictionStakingStorage',
  'getStakingStorage',
  // Random Sampling (Slice 1) — TS-private helpers that survive into
  // the runtime prototype. The five public methods (createChallenge,
  // submitProof, getActiveProofPeriodStatus, getNodeChallenge,
  // getNodeEpochProofPeriodScore) ARE mirrored on MockChainAdapter; only
  // these internal helpers stay EVM-only.
  'getRandomSampling',
  'translateRandomSamplingError',
  'toNodeChallenge',
  // Hub-rotation handling — adapter-internal plumbing that backs the
  // self-refreshing RS resolution and the generic boot-bound contract
  // self-refresh (rc.12 PR `feat/chain-hub-rotation-auto-recovery`).
  // The mock has no Hub, so no live rotation surface to mirror.
  'withHubStaleRetry',
  'withHubStaleRetryAny',
  'invalidateAllBoundContracts',
  'startHubRotationListener',
  'applyHubRotationEventName',
  'invalidateHubBindingOnRotation',
  'invalidateHubBinding',
  'finalizeKnownHubRotation',
  'invalidateRandomSamplingPair',
  'resolveAndAssignRandomSamplingPair',
  'isContractMissingRevert',
  // KC views (Phase 1) — TS-private helpers; the five public methods
  // (getLatestMerkleRoot, getMerkleLeafCount, getLatestMerkleRootPublisher,
  // getLatestMerkleRootAuthor, getKAContextGraphId) ARE mirrored on
  // MockChainAdapter.
  'requireKCStorage',
  'requireContextGraphStorage',
  // TS-private EVM-only helpers backing the V10 PCA write surface
  // (no mock equivalent — mock raises typed reverts directly).
  'requireConvictionNFT',
  'pcaWrite',
  'pcaWriteAndInvalidate',
  // Identity read-cache helpers are EVM-only: the mock's identity registry is
  // in-memory and its writes are already immediately visible.
  'invalidateIdentityStorageBinding',
  'identityStorageAddressChanged',
  'readIdentityIdFromStorage',
  'readIdentityIdForAddress',
  'refreshIdentityIdForAddress',
  'clearIdentityIdForAddress',
  'seedIdentityIdForAddress',
  // The seven V10 Publishing Conviction NFT methods (issue #519 /
  // TB-0002) are now mirrored on MockChainAdapter (in-memory account
  // map + agent reverse map + owner gating) — no longer exempt.
  // PR3 (honest-ack cleanup): publish-preflight cache invalidator is
  // EVM-only. The mock has no chainId/KAV10/minRequiredSignatures
  // round-trips to cache in the first place; a no-op shim would just
  // pad parity for no behavioural reason.
  'invalidatePublishPreflightCache',
  'ensureConfiguredStaticChainIdValidated',
  // #820 (RFC-39 ciphertext/immutable ACK binding): EVM-only surfaces.
  //  - `computeV10UpdateAckDigest` mirrors the on-chain
  //    `KnowledgeAssetsLifecycle._executeUpdateCore` ACK-digest packing for
  //    test helpers / ACK collectors. The mock performs no real signature
  //    recovery (its `updateKnowledgeCollectionV10` accepts any ack), so there
  //    is no on-chain digest to reproduce.
  //  - `computeUpdateNewTokenAmount` (issue #831) is a private helper that
  //    chains together `getKnowledgeCollectionUpdateContext`, `Chronos.getCurrentEpoch`,
  //    and `AskStorage.getStakeWeightedAverageAsk` to mirror the contract's
  //    growth-cost validator. The mock skips on-chain validation entirely, so
  //    there's nothing to reproduce here.
  // NOTE: `isContextGraphActiveOnChain` was previously EVM-only here. It now
  // has a second upstream caller — the #884 SWM-plaintext liveness gate
  // (`isContextGraphPublicOnChain`) — so the mock MUST mirror it (otherwise
  // mock-backed flows silently strand on-chain-public CGs on the encrypted
  // path). MockChainAdapter now implements it (CG present in registry ⇒ live),
  // so it is no longer exempt from parity.
  'computeV10UpdateAckDigest',
  'resolveCurrentTokenAmount',
  'computeUpdateNewTokenAmount',
  // V10 UPDATE StorageACK: `getUpdateAckDigestFields` resolves the
  // on-chain-derived digest fields (contextGraphId via kaToContextGraph,
  // preUpdateMerkleRootCount via getMerkleRoots().length, floored
  // newTokenAmount via computeUpdateNewTokenAmount) so the off-chain ACK
  // collector signs a digest byte-identical to the on-chain verify. Same
  // family as `computeV10UpdateAckDigest` above — it mirrors real on-chain
  // reads the mock has no chain for, and the mock's
  // `updateKnowledgeCollectionV10` accepts any ack without recovery, so
  // there is no on-chain digest to reproduce here.
  'getUpdateAckDigestFields',
  // #1080 follow-up: `resolveKaStorageDeployBlock` binary-searches the deployed
  // DKGKnowledgeAssets contract's birth block to anchor the pre-10.0.4
  // KnowledgeAssetCreated fallback scan (avoids a from-genesis crawl under a
  // 2,000-block eth_getLogs cap). EVM-only — the mock's getMaxKaNumberForAuthor
  // is an in-memory scan with no chain, deploy block, or eth_getCode to resolve.
  'resolveKaStorageDeployBlock',
  'resolveContractDeployBlock',
  'resolveLogScanHead',
  // companion retry-wrapper for the deploy-block binary search's historical
  // eth_getCode probes — EVM-only, same rationale as resolveKaStorageDeployBlock.
  'getContractCodeAtBlock',
  // per-page KnowledgeAssetCreated log-scan with cross-backend failover — EVM-only
  // (the mock's getMaxKaNumberForAuthor is an in-memory scan, no providers).
  'queryKaCreatedPage',
  'queryEventLogsPage',
  // EIP-1271 `isValidSignature(bytes32,bytes)` on-chain view call against a
  // deployed smart-contract wallet. Its sole production caller
  // (dkg-publisher.ts contract-author update authorization) is gated by
  // `hasContractCode(author)`, which the mock hardcodes to false — so the
  // contract-author branch is structurally unreachable on the mock. A `true`
  // shim would be a false-accept on a security-sensitive auth path and a
  // `false` shim would be dead code; a faithful impl would have to model
  // deployed 1271 bytecode + the 0x1626ba7e magic value, which is out of the
  // mock's remit. The two tests that exercise the contract-author branch stub
  // both methods per-test. EVM-only — same family as the on-chain-derived
  // helpers above.
  'verifyContractSignature',
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
  'createOnChainContextGraph',
  'verify',
  'publishToContextGraph',
  'signMessage',
  'signACKDigest',
  'getACKSignerKey',
  'getMinimumRequiredSignatures',
  'isShardingTableMember',
  'verifyACKIdentity',
  'verifySyncIdentity',
  'ensureOperationalWalletsRegistered',
  'isOperationalWalletRegistered',
  'updateKnowledgeCollectionV10',
  // V8 staking + V9 PCA family + V9 permanent publish were archived from
  // EVMChainAdapter in `archive-non-v10-contracts`; both mock and EVM
  // dropped the surface, so they don't need parity-list entries.
  'createKnowledgeAsset',
  'updateKnowledgeAsset',
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
      if (EVM_INTERNAL_METHODS.has(name)) continue;
      if (MOCK_EXEMPT_FROM_EVM.has(name)) continue;
      if (!MOCK_METHODS.has(name)) missing.push(name);
    }
    // If this fires, a method was added to EVMChainAdapter without being
    // mirrored on MockChainAdapter. Either add it to the mock or put it in
    // MOCK_EXEMPT_FROM_EVM with a comment explaining why.
    expect(missing).toEqual([]);
  });

  it('classifies the reverse name-hash resolver accessor as adapter-internal', () => {
    const evm = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x0000000000000000000000000000000000000001',
      privateKey: '0x' + '1'.repeat(64),
      allowNoAdminSigner: true,
    });

    expect(EVM_METHODS.has('getContextGraphNameHashResolver')).toBe(true);
    expect(EVM_INTERNAL_METHODS.has('getContextGraphNameHashResolver')).toBe(true);
    expect(MOCK_METHODS.has('getContextGraphNameHashResolver')).toBe(false);
    expect(Object.hasOwn(evm, 'getContextGraphNameHashResolver')).toBe(false);
    expect(typeof (evm as any).getContextGraphNameHashResolver).toBe('function');
  });

  it('mock supportsEventTypes answers the root-mutation vocabulary like the EVM ABI probe', async () => {
    // The offline-mode gate in the agent awaits `chain.supportsEventTypes?.(…)`
    // and enables the kaRootMutations feature only on `[]` missing. A mock
    // that lacked the method (optional-chained `undefined`) or reported the
    // four names missing would silently disable the feature for every
    // offline developer — the exact CH-8 surprise this suite exists to catch.
    const mock = new MockChainAdapter();
    await expect(
      mock.supportsEventTypes(KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES),
    ).resolves.toEqual([]);
    // The full-vocabulary comparison lives in the cross-adapter row below
    // (review r8): asserting the mock against the very list its declared set
    // derives from was a tautology — `new Set(X)` holds all of X.
    // Unknown names must come back as missing, not be absorbed: a caller that
    // probes for a typo'd event name needs to see the typo, and an
    // all-supported stub would make this row impossible to fail.
    await expect(
      mock.supportsEventTypes(['KnowledgeAssetUpdated', 'NoSuchEventOnAnyAbi']),
    ).resolves.toEqual(['NoSuchEventOnAnyAbi']);
  });

  it('the REAL EVM ABI probe and the mock probe agree over the full served vocabulary (review r8)', async () => {
    // Both probes MEASURED, neither derived: the EVM adapter is bound offline
    // with the shipped client ABIs, the mock answers from its declared set.
    const evm = makeOfflineEvmAdapter();
    const mock = new MockChainAdapter();

    const evmMissing = await evm.supportsEventTypes(SERVED_EVENT_TYPES);
    const mockMissing = await mock.supportsEventTypes(SERVED_EVENT_TYPES);
    expect(evmMissing).toEqual(mockMissing);

    // The one name the parity currently rests on an exception for:
    // `ContextGraphExpanded` is served by a scan branch and emitted by the
    // mock's legacy simulations, but NO shipped client ABI declares the
    // fragment — so the real probe fails closed and the mock mirrors that
    // judgement. This literal pin is what forces the mock's exception list
    // to be revisited if the fragment ever ships (the row above would then
    // fail on `evmMissing = []` vs `mockMissing = ['ContextGraphExpanded']`).
    expect(evmMissing).toEqual(['ContextGraphExpanded']);

    // The four names the kaRootMutations feature gates on are supported by
    // the MEASURED probe on both adapters.
    await expect(
      evm.supportsEventTypes(KNOWLEDGE_ASSET_ROOT_MUTATION_EVENT_TYPES),
    ).resolves.toEqual([]);
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
      allowNoAdminSigner: true,
    });
    expect(mock.chainType).toBe(evm.chainType);
  });

  it('isV10Ready is a capability gate — mock returns true (used to exercise V10 unit tests)', () => {
    const mock = new MockChainAdapter();
    expect(mock.isV10Ready()).toBe(true);
  });

  // Codex PR #595 round-4: isShardingTableMember gates VM ACK eligibility.
  // The mock can't model a real sharding table, so it treats every
  // registered (non-zero) identity as a member; tests needing
  // non-membership behaviour spy/monkey-patch the method.
  it('isShardingTableMember returns true for any non-zero identityId and false for 0n', async () => {
    const mock = new MockChainAdapter();
    expect(await mock.isShardingTableMember(0n)).toBe(false);
    expect(await mock.isShardingTableMember(1n)).toBe(true);
    expect(await mock.isShardingTableMember(99999n)).toBe(true);
  });

  // Codex PR #595 round-5: EVMChainAdapter.getMinimumRequiredSignatures
  // previously returned a hardcoded 3 when ParametersStorage couldn't be
  // resolved. The agent + publisher verify paths trust this value, so a
  // silent fallback meant verify could enforce the wrong quorum without
  // anyone noticing. The adapter now throws so the upstream fail-closed
  // guards actually fire.
  it('EVMChainAdapter.getMinimumRequiredSignatures throws when ParametersStorage is unresolvable', async () => {
    const evm = new EVMChainAdapter({
      rpcUrl: 'http://127.0.0.1:1',
      hubAddress: '0x0000000000000000000000000000000000000001',
      privateKey: '0x' + '1'.repeat(64),
      allowNoAdminSigner: true,
    });
    // Force the contracts cache into a state where parametersStorage is
    // missing without touching the network — mirrors the adapter
    // misconfiguration / network-outage case that previously fell back
    // to a hardcoded 3.
    (evm as any).contracts = { parametersStorage: undefined };
    (evm as any).initialized = true;
    await expect(evm.getMinimumRequiredSignatures()).rejects.toThrow(
      /ParametersStorage contract is not resolvable/,
    );
  });

  it('getEvmChainId returns a bigint (not a namespaced string like "mock:31337")', async () => {
    const mock = new MockChainAdapter();
    const id = await mock.getEvmChainId();
    expect(typeof id).toBe('bigint');
    expect(id).toBeGreaterThan(0n);
  });

  it('getKnowledgeAssetsLifecycleAddress returns a 20-byte hex address', async () => {
    const mock = new MockChainAdapter();
    const addr = await mock.getKnowledgeAssetsLifecycleAddress();
    expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('rejects participant agent configs that would revert on-chain', async () => {
    const mock = new MockChainAdapter();

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      participantAgents: ['0x0000000000000000000000000000000000000000'],
    })).rejects.toThrow(/zero participant agent/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      participantAgents: [
        '0x1111111111111111111111111111111111111111',
        '0x1111111111111111111111111111111111111111',
      ],
    })).rejects.toThrow(/duplicate participant agent/);
  });

  it('requires explicit accessPolicy and publishPolicy (no silent public/open default)', async () => {
    // Codex PR #595 round-5: making the policy fields optional with
    // permissive defaults (accessPolicy=0, publishPolicy=1) silently
    // created public + open CGs for any caller that didn't pass them.
    // Both fields are now required at the type level AND enforced at
    // runtime so out-of-tree callers can't accidentally widen perms.
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');
    await expect(
      mock.createOnChainContextGraph({} as any),
    ).rejects.toThrow(/accessPolicy.*publishPolicy.*required/);
    await expect(
      mock.createOnChainContextGraph({ accessPolicy: 1 } as any),
    ).rejects.toThrow(/accessPolicy.*publishPolicy.*required/);
    await expect(
      mock.createOnChainContextGraph({ publishPolicy: 0 } as any),
    ).rejects.toThrow(/accessPolicy.*publishPolicy.*required/);
  });

  it('normalizes and rejects publish-policy configs like the EVM facade', async () => {
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 2,
      publishPolicy: 1,
    })).rejects.toThrow(/invalid accessPolicy/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 2,
    })).rejects.toThrow(/invalid publishPolicy/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthority: '0x2222222222222222222222222222222222222222',
    })).rejects.toThrow(/open policy requires zero publishAuthority/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      publishAuthorityAccountId: 1n,
    })).rejects.toThrow(/open policy requires zero publishAuthorityAccountId/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthorityAccountId: 1n,
    })).rejects.toThrow(/PCA account 1 does not exist/);

    // `createPublishingConvictionAccount` was archived in `archive-non-v10-contracts`;
    // seed the mock's PCA-owner map directly so the publish-policy branch
    // that requires `ownerOf(accountId)` can still be exercised.
    const accountId = mock.seedConvictionAccount('0x1111111111111111111111111111111111111111');

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: '0x2222222222222222222222222222222222222222',
      publishAuthorityAccountId: accountId,
    })).rejects.toThrow(/PCA publishAuthority must match account owner/);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: '0x1111111111111111111111111111111111111111',
      publishAuthorityAccountId: accountId,
    })).resolves.toMatchObject({ contextGraphId: 1n });

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthorityAccountId: accountId,
    })).resolves.toMatchObject({ contextGraphId: 2n });

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 1,
      publishPolicy: 0,
    })).resolves.toMatchObject({ contextGraphId: 3n });
  });

  it('mirrors exact name-hash reverse-resolution behavior', async () => {
    const mock = new MockChainAdapter();
    const nameHash = `0x${'ab'.repeat(32)}`;
    const upperCaseHash = `0x${nameHash.slice(2).toUpperCase()}`;
    const unknownHash = `0x${'cd'.repeat(32)}`;

    await expect(mock.resolveContextGraphIdByNameHash('not-a-hash')).rejects.toThrow(
      /bytes32 nameHash/,
    );
    await expect(mock.resolveContextGraphIdByNameHash(ethers.ZeroHash)).resolves.toBeNull();
    await expect(mock.resolveContextGraphIdByNameHash(unknownHash)).resolves.toBeNull();

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash,
    })).resolves.toMatchObject({ contextGraphId: 1n });
    await expect(mock.resolveContextGraphIdByNameHash(upperCaseHash)).resolves.toBe(1n);

    await expect(mock.createOnChainContextGraph({
      accessPolicy: 0,
      publishPolicy: 1,
      nameHash: upperCaseHash,
    })).resolves.toMatchObject({ contextGraphId: 2n });
    await expect(mock.resolveContextGraphIdByNameHash(nameHash)).rejects.toThrow(
      /ambiguous.*2 numeric ids/i,
    );
  });

  it('requires explicit mock support for address-specific V10 publishing', async () => {
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');
    mock.minimumRequiredSignatures = 0;
    const otherPublisher = '0x2222222222222222222222222222222222222222';
    const params = {
      publishOperationId: 'mock-v10-publisher-address',
      contextGraphId: 1n,
      publisherAddress: otherPublisher,
      merkleRoot: new Uint8Array(32),
      knowledgeAssetsAmount: 1,
      byteSize: 1n,
      epochs: 1,
      tokenAmount: 1n,
      isImmutable: false,
      merkleLeafCount: 1,
      publisherNodeIdentityId: 1n,
      author: {
        address: otherPublisher,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
      },
      ackSignatures: [],
    };

    await expect(mock.createKnowledgeAssets(params)).rejects.toThrow(/not allowed/);

    mock.allowPublisherAddress(otherPublisher);
    await expect(mock.createKnowledgeAssets(params)).resolves.toMatchObject({
      publisherAddress: otherPublisher,
    });
  });

  it('preserves delegated V10 publisher attribution across mock updates', async () => {
    const mock = new MockChainAdapter('mock:31337', '0x1111111111111111111111111111111111111111');
    mock.minimumRequiredSignatures = 0;
    const delegatedPublisher = '0x2222222222222222222222222222222222222222';
    mock.allowPublisherAddress(delegatedPublisher);

    const created = await mock.createKnowledgeAssets({
      publishOperationId: 'mock-v10-delegated-update',
      contextGraphId: 1n,
      publisherAddress: delegatedPublisher,
      merkleRoot: new Uint8Array(32),
      knowledgeAssetsAmount: 1,
      byteSize: 1n,
      epochs: 1,
      tokenAmount: 1n,
      isImmutable: false,
      merkleLeafCount: 1,
      publisherNodeIdentityId: 1n,
      author: {
        address: delegatedPublisher,
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
      },
      ackSignatures: [],
    });

    const newMerkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('mock-v10-update')));
    const update = await mock.updateKnowledgeCollectionV10({
      kaId: created.batchId,
      newMerkleRoot,
      newByteSize: 2n,
      newMerkleLeafCount: 1,
      authorAddress: delegatedPublisher,
      authorR: new Uint8Array(32),
      authorVS: new Uint8Array(32),
    });

    expect(update.publisherAddress?.toLowerCase()).toBe(delegatedPublisher.toLowerCase());
    await expect(mock.getLatestMerkleRootPublisher(created.batchId)).resolves.toBe(delegatedPublisher);
    await expect(mock.getLatestMerkleRoot(created.batchId)).resolves.toEqual(newMerkleRoot);
  });

  // The "V9 mock update path" parity test was archived alongside
  // `mock.updateKnowledgeAssets` itself (issue 0004 of
  // `archive-non-v10-contracts`); V10 update attribution is covered by
  // the `updateKnowledgeCollectionV10` test above.
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
      // V9 `publishKnowledgeAssets` / `updateKnowledgeAssets` /
      // `extendStorage` / `transferNamespace` were archived in
      // `archive-non-v10-contracts` — no longer required surface.
      'listenForEvents',
      'createContextGraph',
      'submitToContextGraph',
      'createKnowledgeAssets',
      'getKnowledgeAssetsLifecycleAddress',
      'getEvmChainId',
      'isV10Ready',
    ];
    const missing = required.filter((n) => !NO_CHAIN_METHODS.has(n));
    expect(missing).toEqual([]);
  });
});
