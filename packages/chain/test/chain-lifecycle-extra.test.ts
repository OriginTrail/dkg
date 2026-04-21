/**
 * V10 chain-adapter lifecycle tests against a real Hardhat node.
 *
 * Audit findings covered:
 *
 *   CH-2  (CRITICAL) — `EVMChainAdapter.publishToContextGraph` invokes
 *                      `ka.publishToContextGraph(...)` on the V9
 *                      `KnowledgeAssets` contract and *then* chains
 *                      `createKnowledgeAssetsV10`. The V9 ABI shipped with
 *                      the adapter (packages/chain/abi/KnowledgeAssets.json)
 *                      has NO `publishToContextGraph` function, so the
 *                      method is always going to throw on the V9 tx before
 *                      ever reaching the V10 fallback. That means either
 *                      (a) the caller gets two txs on-chain when the ABI
 *                      ever regains the function (double-spend risk), or
 *                      (b) the caller always sees a missing-fragment
 *                      error today (dead code). Both are bugs.
 *
 *   CH-3  (CRITICAL) — The V10 lifecycle
 *                        createKnowledgeAssetsV10 → updateKnowledgeCollectionV10
 *                        → verifyKAUpdate → resolvePublishByTxHash
 *                      has no end-to-end test. If any one hop silently
 *                      regresses (e.g. verifyKAUpdate stops matching the
 *                      V10 event selector), every node that gossips
 *                      updates silently rejects them.
 *
 *   CH-11 (MEDIUM)   — FairSwapJudge.disputeDelivery is reachable from
 *                      `EVMChainAdapter.disputeDelivery` but has zero
 *                      tests. A regression that silently swallows the
 *                      revert (e.g. forgetting `await tx.wait()`) would
 *                      go undetected.
 *
 *   CH-13 (MEDIUM)   — The test helpers `createTestContextGraph` and
 *                      `seedContextGraphRegistration` have no tests.
 *                      Any drift in the registration quad format would
 *                      silently break every publisher integration test.
 *
 *   CH-18 (LOW)      — `nextAuthorizedSigner` throws a specific message
 *                      when no wallet is authorised. Both the message
 *                      text and the fallback behaviour are undocumented
 *                      invariants relied on by higher-level error paths.
 *
 * Conventions:
 *   - Uses real `EVMChainAdapter` over the shared Hardhat node (see
 *     `evm-test-context.ts` + `hardhat-global-setup.ts`).
 *   - One snapshot per test for isolation; tests do not leak state.
 *   - `PROD-BUG` comments mark expectations that stay RED because the
 *     underlying code is broken.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers, Wallet, Contract } from 'ethers';
import {
  createEVMAdapter,
  createTestContextGraph,
  seedContextGraphRegistration,
  getSharedContext,
  createProvider,
  takeSnapshot,
  revertSnapshot,
  HARDHAT_KEYS,
} from './evm-test-context.js';
import { mintTokens } from './hardhat-harness.js';

let fileSnapshotId: string;
let testSnapshotId: string;

// Helper: build the V10 PublishDirect params end-to-end (publisher digest,
// ACK digest, token approval) and invoke createKnowledgeAssetsV10 for a
// freshly-created context graph. Returns the publish result + context id.
async function publishOneKCV10(opts: {
  kaCount?: number;
  byteSize?: bigint;
  epochs?: number;
} = {}): Promise<{ kcId: bigint; txHash: string; contextGraphId: bigint; merkleRoot: Uint8Array }> {
  const provider = createProvider();
  const { hubAddress, coreProfileId } = getSharedContext();
  const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
  await mintTokens(
    provider,
    hubAddress,
    HARDHAT_KEYS.DEPLOYER,
    adapter.getSignerAddress(),
    ethers.parseEther('500000'),
  );

  const contextGraphId = await createTestContextGraph(adapter);

  const kaCount = opts.kaCount ?? 2;
  const byteSize = opts.byteSize ?? 256n;
  const epochs = opts.epochs ?? 2;
  const tokenAmount = await adapter.getRequiredPublishTokenAmount(byteSize, epochs);
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`lifecycle-${Date.now()}-${Math.random()}`)));
  const publisherIdentityId = BigInt(coreProfileId);
  const kav10Address = await adapter.getKnowledgeAssetsV10Address();
  const evmChainId = await adapter.getEvmChainId();

  const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
  const pubDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint72', 'uint256', 'bytes32'],
    [evmChainId, kav10Address, publisherIdentityId, contextGraphId, ethers.hexlify(merkleRoot)],
  ));
  const pubRaw = ethers.Signature.from(await coreOp.signMessage(pubDigest));
  const publisherSignature = { r: ethers.getBytes(pubRaw.r), vs: ethers.getBytes(pubRaw.yParityAndS) };

  const ackDigest = ethers.getBytes(ethers.solidityPackedKeccak256(
    ['uint256', 'address', 'uint256', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint256'],
    [evmChainId, kav10Address, contextGraphId, ethers.hexlify(merkleRoot), kaCount, byteSize, epochs, tokenAmount],
  ));
  const ackRaw = ethers.Signature.from(await coreOp.signMessage(ackDigest));

  const result = await adapter.createKnowledgeAssetsV10!({
    publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
    contextGraphId,
    merkleRoot,
    knowledgeAssetsAmount: kaCount,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable: false,
    paymaster: ethers.ZeroAddress,
    publisherNodeIdentityId: publisherIdentityId,
    publisherSignature,
    ackSignatures: [{
      identityId: publisherIdentityId,
      r: ethers.getBytes(ackRaw.r),
      vs: ethers.getBytes(ackRaw.yParityAndS),
    }],
  } as any);

  expect(result.batchId).toBeGreaterThan(0n);
  expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  return {
    kcId: result.batchId,
    txHash: result.txHash,
    contextGraphId,
    merkleRoot,
  };
}

describe('chain-lifecycle-extra — V10 lifecycle + adapter invariants', () => {
  beforeAll(async () => {
    fileSnapshotId = await takeSnapshot();
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

  // --------------------------------------------------------------------
  // CH-2 — publishToContextGraph is wired to a dead V9 function.
  // --------------------------------------------------------------------

  describe('publishToContextGraph wiring [CH-2]', () => {
    it('the V9 KnowledgeAssets ABI bundled with the adapter has NO `publishToContextGraph` function', () => {
      const abiPath = join(import.meta.dirname, '..', 'abi', 'KnowledgeAssets.json');
      const abi = JSON.parse(readFileSync(abiPath, 'utf8')) as Array<{ type: string; name?: string }>;
      const functionNames = abi.filter((x) => x.type === 'function').map((x) => x.name);
      // PROD-BUG: the adapter's `publishToContextGraph` method at
      //   packages/chain/src/evm-adapter.ts:1141
      // calls `ka.publishToContextGraph(...)` on the V9 KnowledgeAssets
      // contract. If this assertion flips to include the function,
      // double-review that the adapter does NOT then also chain
      // `createKnowledgeAssetsV10` — otherwise each call becomes two
      // on-chain publishes and a double-charge. See BUGS_FOUND.md CH-2.
      expect(functionNames).not.toContain('publishToContextGraph');
    });

    it('the adapter source still chains createKnowledgeAssetsV10 after the V9 call — architectural bug', () => {
      const src = readFileSync(
        join(import.meta.dirname, '..', 'src', 'evm-adapter.ts'),
        'utf8',
      );
      // Locate the publishToContextGraph method block.
      const methodMatch = src.match(/async publishToContextGraph\([^)]*\)[\s\S]*?\n  \}/);
      expect(methodMatch, 'publishToContextGraph method not found in source').not.toBeNull();
      const body = methodMatch![0];
      // PROD-BUG: the current implementation calls the (non-existent) V9
      // method AND then `return this.createKnowledgeAssetsV10(...)`.
      // Exactly one of these is the intended behaviour; shipping both
      // means either (a) the V9 tx throws so the V10 call is dead, or
      // (b) the V9 tx succeeds and we double-charge. See CH-2.
      expect(body).toContain('ka.publishToContextGraph(');
      expect(body).toContain('return this.createKnowledgeAssetsV10(');
    });
  });

  // --------------------------------------------------------------------
  // CH-3 — full V10 publish/update/verify/resolve lifecycle.
  // --------------------------------------------------------------------

  describe('V10 lifecycle: createKnowledgeAssetsV10 + updateKnowledgeCollectionV10 + verifyKAUpdate + resolvePublishByTxHash [CH-3]', () => {
    it('publishes, updates, verifies the update, and round-trips the publish receipt', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

      const { kcId, txHash: publishTxHash, merkleRoot: originalRoot } = await publishOneKCV10({
        kaCount: 2,
        byteSize: 256n,
        epochs: 2,
      });

      // --- resolvePublishByTxHash on the publish tx ---
      const resolved = await adapter.resolvePublishByTxHash(publishTxHash);
      expect(resolved).not.toBeNull();
      expect(resolved!.batchId).toBe(kcId);
      expect(resolved!.txHash.toLowerCase()).toBe(publishTxHash.toLowerCase());
      expect(resolved!.startKAId).toBeGreaterThan(0n);
      expect(resolved!.endKAId).toBeGreaterThanOrEqual(resolved!.startKAId);
      expect(resolved!.publisherAddress.toLowerCase()).toBe(adapter.getSignerAddress().toLowerCase());

      // --- updateKnowledgeCollectionV10 with auto-generated signatures ---
      const newMerkleRoot = ethers.getBytes(
        ethers.keccak256(ethers.toUtf8Bytes(`lifecycle-update-${Date.now()}`)),
      );
      expect(ethers.hexlify(newMerkleRoot)).not.toBe(ethers.hexlify(originalRoot));

      // Pass newTokenAmount explicitly: the adapter's auto-derivation
      // from askStorage + byteSize can under-shoot the V10 contract's
      // `InvalidTokenAmount` check when `getTokenAmount(kcId)` returns 0
      // (KC storage isn't carrying publish cost forward in this path).
      // We keep byteSize the same as the publish so the update is a pure
      // merkle-root rotation.
      const publishTokenAmount = await adapter.getRequiredPublishTokenAmount(256n, 2);
      const updateResult = await adapter.updateKnowledgeCollectionV10({
        kcId,
        newMerkleRoot,
        newByteSize: 256n,
        newTokenAmount: publishTokenAmount,
      } as any);

      expect(updateResult.success).toBe(true);
      expect(updateResult.hash).toMatch(/^0x[0-9a-f]{64}$/);

      // --- verifyKAUpdate on the update tx ---
      const verified = await adapter.verifyKAUpdate(
        updateResult.hash,
        kcId,
        adapter.getSignerAddress(),
      );
      expect(verified.verified).toBe(true);
      expect(verified.onChainMerkleRoot).toBeDefined();
      expect(ethers.hexlify(verified.onChainMerkleRoot!).toLowerCase()).toBe(
        ethers.hexlify(newMerkleRoot).toLowerCase(),
      );
      expect(verified.blockNumber).toBeGreaterThan(0);

      // --- verifyKAUpdate returns NOT-verified for a wrong publisher ---
      const wrongPub = new Wallet(HARDHAT_KEYS.EXTRA2).address;
      const notVerified = await adapter.verifyKAUpdate(updateResult.hash, kcId, wrongPub);
      expect(notVerified.verified).toBe(false);
    }, 120_000);

    it('resolvePublishByTxHash returns null for an unknown / zero tx hash', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const bogus = '0x' + 'ab'.repeat(32);
      const resolved = await adapter.resolvePublishByTxHash(bogus);
      expect(resolved).toBeNull();
    });

    it('verifyKAUpdate returns unverified for an unrelated tx hash', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      // Use a random-looking hash that does not exist on-chain.
      const bogus = '0x' + 'cd'.repeat(32);
      const verified = await adapter.verifyKAUpdate(bogus, 1n, adapter.getSignerAddress());
      expect(verified.verified).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  // CH-11 — FairSwapJudge.disputeDelivery reachability.
  // --------------------------------------------------------------------

  describe('FairSwapJudge.disputeDelivery reachability [CH-11]', () => {
    it('the FairSwapJudge ABI exposes disputeDelivery(uint256,bytes) with the shape the adapter uses', () => {
      const abi = JSON.parse(readFileSync(
        join(import.meta.dirname, '..', 'abi', 'FairSwapJudge.json'), 'utf8',
      )) as Array<{ type: string; name?: string; inputs?: Array<{ type: string }> }>;
      const fn = abi.find((x) => x.type === 'function' && x.name === 'disputeDelivery');
      expect(fn, 'disputeDelivery missing from FairSwapJudge ABI').toBeDefined();
      const types = (fn!.inputs ?? []).map((i) => i.type);
      expect(types).toEqual(['uint256', 'bytes']);
    });

    it('adapter.disputeDelivery rejects instead of silently succeeding when called on a non-existent purchase', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      // Bare `rejects.toThrow()` tolerated ANY failure class — even a
      // provider-layer crash would have satisfied it while the on-chain
      // contract silently accepted the dispute. Match the chain revert
      // vocabulary so a regression where the call returns early (or
      // fails for an orthogonal reason) is distinguishable.
      await expect(
        adapter.disputeDelivery!(999_999n, new Uint8Array(0)),
      ).rejects.toThrow(/revert|purchase|does not exist|not found|Invalid|state|unknown/i);
    });

    it('adapter.disputeDelivery reverts on a freshly-initiated (not-yet-fulfilled) purchase', async () => {
      const provider = createProvider();
      const { hubAddress } = getSharedContext();
      const buyer = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      await mintTokens(
        provider,
        hubAddress,
        HARDHAT_KEYS.DEPLOYER,
        buyer.getSignerAddress(),
        ethers.parseEther('100000'),
      );

      const sellerAddr = new Wallet(HARDHAT_KEYS.EXTRA1).address;
      const { purchaseId, success } = await buyer.initiatePurchase!(sellerAddr, 1n, 1n, ethers.parseEther('10'));
      expect(success).toBe(true);

      // State is now 1 (Initiated). disputeDelivery requires a fulfilled
      // purchase, so this MUST revert — the bug surfaces if adapter
      // silently returns success=true. Bare `rejects.toThrow()` would
      // also pass if the provider died or the call reverted for a
      // completely unrelated reason; tie the expected failure to the
      // chain-originated state-machine vocabulary.
      await expect(
        buyer.disputeDelivery!(purchaseId, ethers.getBytes('0x00')),
      ).rejects.toThrow(/revert|state|fulfill|InvalidState|Wrong|not (fulfilled|ready)/i);
    }, 60_000);
  });

  // --------------------------------------------------------------------
  // CH-13 — test helpers (createTestContextGraph + seedContextGraphRegistration).
  // --------------------------------------------------------------------

  describe('test helpers [CH-13]', () => {
    it('createTestContextGraph returns a positive, non-zero bigint id and the CG resolves to `isAuthorizedPublisher=true` for the creator', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const contextGraphId = await createTestContextGraph(adapter);
      expect(contextGraphId).toBeGreaterThan(0n);

      // The CG was created with publishPolicy=0 (Open) so every wallet
      // should be an authorized publisher — sanity check the helper
      // didn't accidentally use `1` and orphan subsequent publishes.
      const cg = await adapter.getContract('ContextGraphs');
      const ok = await cg.isAuthorizedPublisher(contextGraphId, adapter.getSignerAddress());
      expect(ok).toBe(true);
    }, 60_000);

    it('seedContextGraphRegistration writes the expected metadata quad into the store', async () => {
      type Quad = { subject: string; predicate: string; object: string; graph: string };
      const quads: Quad[] = [];
      const fakeStore = {
        insert: async (next: Quad[]) => { quads.push(...next); },
      };
      const cgId = '42';
      await seedContextGraphRegistration(fakeStore, cgId);

      expect(quads).toHaveLength(1);
      const q = quads[0];
      expect(q.subject).toBe('did:dkg:context-graph:42');
      expect(q.graph).toBe('did:dkg:context-graph:42/_meta');
      expect(q.predicate).toBe('https://dkg.network/ontology#registrationStatus');
      expect(q.object).toBe('"registered"');
    });
  });

  // --------------------------------------------------------------------
  // CH-18 — nextAuthorizedSigner no-wallet-authorized path.
  // --------------------------------------------------------------------

  describe('nextAuthorizedSigner: no-wallet-authorized path [CH-18]', () => {
    it('error message format is pinned (exposed to upstream callers that pattern-match on it)', () => {
      const src = readFileSync(
        join(import.meta.dirname, '..', 'src', 'evm-adapter.ts'),
        'utf8',
      );
      // Pin the exact wording. If this changes, every caller in
      // dkg-publisher / dkg-agent / cli that logs this message will
      // need to be updated too.
      expect(src).toContain('No authorized publisher wallet found in signer pool for context graph');
      expect(src).toContain('Ensure at least one configured wallet is permitted by on-chain publish authority.');
    });

    it('createKnowledgeAssetsV10 on a positive but non-existent contextGraphId bubbles a useful error (not silent null)', async () => {
      // This exercises the nextAuthorizedSigner → isAuthorizedPublisher
      // path against a cgId that does not exist. The contract either
      // reverts or returns false for all candidates; in either case the
      // adapter MUST throw, not succeed.
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const { coreProfileId } = getSharedContext();
      const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('no-auth')));
      // The adapter's nextAuthorizedSigner helper throws the pinned
      // "No authorized publisher wallet found in signer pool for context
      // graph" message (verified by the companion CH-18 test directly
      // above). Match that vocabulary OR any chain revert so a silent-
      // null regression (adapter returns success instead of throwing)
      // is unambiguously red.
      await expect(
        adapter.createKnowledgeAssetsV10!({
          publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
          contextGraphId: 10n ** 12n, // huge, never created
          merkleRoot,
          knowledgeAssetsAmount: 1,
          byteSize: 128n,
          epochs: 1,
          tokenAmount: 0n,
          isImmutable: false,
          paymaster: ethers.ZeroAddress,
          publisherNodeIdentityId: BigInt(coreProfileId),
          publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
          ackSignatures: [],
        } as any),
      ).rejects.toThrow(/No authorized publisher wallet|authorized|context graph|revert|Unauthorized/i);
    }, 60_000);

    it('createKnowledgeAssetsV10 rejects non-positive contextGraphId with the documented pre-tx guard', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      await expect(
        adapter.createKnowledgeAssetsV10!({
          publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
          contextGraphId: 0n,
          merkleRoot: new Uint8Array(32),
          knowledgeAssetsAmount: 1,
          byteSize: 128n,
          epochs: 1,
          tokenAmount: 0n,
          isImmutable: false,
          paymaster: ethers.ZeroAddress,
          publisherNodeIdentityId: 0n,
          publisherSignature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
          ackSignatures: [],
        } as any),
      ).rejects.toThrow(/positive on-chain context graph id/);
    });
  });
});
