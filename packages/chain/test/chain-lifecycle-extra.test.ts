/**
 * V10 chain-adapter lifecycle tests against a real Hardhat node.
 *
 * Audit findings covered:
 *
 *   CH-3  (CRITICAL) — The V10 lifecycle
 *                        createKnowledgeAssets → updateKnowledgeCollectionV10
 *                        → verifyKAUpdate → resolvePublishByTxHash
 *                      has no end-to-end test. If any one hop silently
 *                      regresses (e.g. verifyKAUpdate stops matching the
 *                      V10 event selector), every node that gossips
 *                      updates silently rejects them.
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
import {
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
  computePublishACKDigest,
} from '@origintrail-official/dkg-core';

let fileSnapshotId: string;
let testSnapshotId: string;

// ---------------------------------------------------------------------------
// OT-RFC-43 Option-1 (variant 1a) — packed reservedKaId helpers.
//
// The real EVM adapter now REQUIRES a packed
//   reservedKaId = (uint160(author) << 96) | number
// and the on-chain contract reverts `KaIdNamespaceMismatch` unless the high
// 160 bits equal the author address, and `KaIdAlreadyMinted` on replay of the
// same (author, number). Tests that hit the real adapter must therefore mint
// into the author's namespace with a fresh per-author `number`.
//
// `kaNumberCounters` is a per-author monotonic counter. Because each test
// snapshots + reverts the chain, the on-chain mint of (author, number) is
// undone between tests, so a globally-monotonic number never actually collides
// on-chain — but keeping it monotonic also keeps every concurrent test in a
// single run unambiguous and makes the deterministic-mint assertions readable.
const kaNumberCounters = new Map<string, bigint>();

function nextKaNumber(author: string): bigint {
  const key = ethers.getAddress(author);
  const current = kaNumberCounters.get(key) ?? 0n;
  const next = current + 1n;
  kaNumberCounters.set(key, next);
  return next;
}

function packReservedKaId(author: string, n: bigint): bigint {
  return (BigInt(ethers.getAddress(author)) << 96n) | n;
}

// Helper: build the V10 PublishDirect params end-to-end (publisher digest,
// ACK digest, token approval) and invoke createKnowledgeAssets for a
// freshly-created context graph. Returns the publish result + context id.
async function publishOneKCV10(opts: {
  kaCount?: number;
  byteSize?: bigint;
  epochs?: number;
  // OT-RFC-43 Option-1: explicit packed reservedKaId. When omitted the helper
  // allocates a fresh `(author<<96)|number` for the CORE_OP author.
  reservedKaId?: bigint;
} = {}): Promise<{ kaId: bigint; txHash: string; contextGraphId: bigint; merkleRoot: Uint8Array; reservedKaId: bigint }> {
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

  // Public CG (accessPolicy 0): publishOneKCV10 exercises §F2 mint / replay /
  // byte-size lifecycle mechanics with PLAINTEXT, not curated ciphertext. A
  // curated CG would (correctly) require a ciphertext commitment the plaintext
  // path never carries, reverting with CuratedCGRequiresCiphertextCommitment.
  const contextGraphId = await createTestContextGraph(adapter, undefined, 0);

  const kaCount = opts.kaCount ?? 1;
  const byteSize = opts.byteSize ?? 256n;
  const epochs = opts.epochs ?? 2;
  const tokenAmount = await adapter.getRequiredPublishTokenAmount(byteSize, epochs);
  const merkleRoot = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`lifecycle-${Date.now()}-${Math.random()}`)));
  const publisherIdentityId = BigInt(coreProfileId);
  const kav10Address = await adapter.getKnowledgeAssetsLifecycleAddress();
  const evmChainId = await adapter.getEvmChainId();

  const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);

  // OT-RFC-43 Option-1 (variant 1a): the real adapter + contract require a
  // packed reservedKaId in the author's namespace. Use the caller-provided id
  // when given (deterministic-mint / replay tests), otherwise allocate a fresh
  // per-author number for CORE_OP. Computed BEFORE the author attestation
  // because the §F2 author digest now binds reservedKaId as its 5th field.
  const reservedKaId = opts.reservedKaId ?? packReservedKaId(coreOp.address, nextKaNumber(coreOp.address));

  // RFC-001 §3 author attestation. EIP-712 typed data over
  // (cgId, merkleRoot, authorAddress, schemeVersion=1, reservedKaId) bound to
  // KAV10. §F2: reservedKaId is the 5th bound field and must equal the value
  // placed in PublishParams or on-chain recovery reverts InvalidAuthorSignature.
  const authorTyped = buildAuthorAttestationTypedData({
    chainId: evmChainId,
    kav10Address,
    merkleRoot,
    authorAddress: coreOp.address,
    reservedKaId,
  });
  const authorRaw = ethers.Signature.from(
    await coreOp.signTypedData(authorTyped.domain, authorTyped.types, authorTyped.message),
  );

  // OT-RFC-49 / WS-B Trap 3: the publish ACK digest is prefixed with
  // `ACK_DIGEST_VERSION` and binds the trailing (catalogRoot, catalogLeafCount,
  // isImmutable) triple — see KnowledgeAssetsLifecycle._executePublishCore. Use
  // the canonical off-chain helper so the test digest is byte-identical to the
  // contract's (hand-rolling it dropped the version prefix and reverted
  // SignerIsNotNodeOperator). This publish is plaintext + mutable, so the
  // catalog pair + isImmutable are zero.
  const merkleLeafCount = 1;
  const ackDigest = computePublishACKDigest(
    evmChainId,
    kav10Address,
    contextGraphId,
    merkleRoot,
    BigInt(kaCount),
    BigInt(byteSize),
    BigInt(epochs),
    BigInt(tokenAmount),
    BigInt(merkleLeafCount),
    new Uint8Array(32),
    0n,
    false,
  );
  const ackRaw = ethers.Signature.from(await coreOp.signMessage(ackDigest));

  const result = await adapter.createKnowledgeAssets!({
    publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
    contextGraphId,
    merkleRoot,
    knowledgeAssetsAmount: kaCount,
    byteSize,
    epochs,
    tokenAmount,
    isImmutable: false,
    merkleLeafCount,
    reservedKaId,
    publisherNodeIdentityId: publisherIdentityId,
    author: {
      address: coreOp.address,
      signature: {
        r: ethers.getBytes(authorRaw.r),
        vs: ethers.getBytes(authorRaw.yParityAndS),
      },
      schemeVersion: 1,
    },
    ackSignatures: [{
      identityId: publisherIdentityId,
      r: ethers.getBytes(ackRaw.r),
      vs: ethers.getBytes(ackRaw.yParityAndS),
    }],
  });

  expect(result.batchId).toBeGreaterThan(0n);
  expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  return {
    kaId: result.batchId,
    txHash: result.txHash,
    contextGraphId,
    merkleRoot,
    reservedKaId,
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
  // CH-3 — full V10 publish/update/verify/resolve lifecycle.
  // --------------------------------------------------------------------

  describe('V10 lifecycle: createKnowledgeAssets + updateKnowledgeCollectionV10 + verifyKAUpdate + resolvePublishByTxHash [CH-3]', () => {
    it('publishes, updates, verifies the update, and round-trips the publish receipt', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

      const { kaId, txHash: publishTxHash, merkleRoot: originalRoot } = await publishOneKCV10({
        kaCount: 1,
        byteSize: 256n,
        epochs: 2,
      });

      // --- resolvePublishByTxHash on the publish tx ---
      const resolved = await adapter.resolvePublishByTxHash(publishTxHash);
      expect(resolved).not.toBeNull();
      expect(resolved!.batchId).toBe(kaId);
      expect(resolved!.txHash.toLowerCase()).toBe(publishTxHash.toLowerCase());
      expect(resolved!.startKAId).toBeGreaterThan(0n);
      expect(resolved!.endKAId).toBe(resolved!.startKAId);
      expect(resolved!.publisherAddress.toLowerCase()).toBe(adapter.getSignerAddress().toLowerCase());
      expect(ethers.hexlify(resolved!.merkleRoot!)).toBe(ethers.hexlify(originalRoot));
      expect(resolved!.authorAddress?.toLowerCase()).toBe(adapter.getSignerAddress().toLowerCase());

      // --- updateKnowledgeCollectionV10 (publisher ACK + owner EIP-712 seal) ---
      const newMerkleRoot = ethers.getBytes(
        ethers.keccak256(ethers.toUtf8Bytes(`lifecycle-update-${Date.now()}`)),
      );
      expect(ethers.hexlify(newMerkleRoot)).not.toBe(ethers.hexlify(originalRoot));

      const provider = createProvider();
      const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
      const kav10Address = await adapter.getKnowledgeAssetsLifecycleAddress();
      const evmChainId = await adapter.getEvmChainId();
      const updateAuthorTyped = buildUpdateAuthorAttestationTypedData({
        chainId: evmChainId,
        kav10Address,
        kaId: kaId,
        newMerkleRoot,
        authorAddress: coreOp.address,
      });
      const updateAuthorRaw = ethers.Signature.from(
        await coreOp.signTypedData(
          updateAuthorTyped.domain,
          updateAuthorTyped.types,
          updateAuthorTyped.message,
        ),
      );

      // Pass newTokenAmount explicitly: the adapter's auto-derivation
      // from askStorage + byteSize can under-shoot the V10 contract's
      // `InvalidTokenAmount` check when `getTokenAmount(kaId)` returns 0
      // (KC storage isn't carrying publish cost forward in this path).
      // We keep byteSize the same as the publish so the update is a pure
      // merkle-root rotation.
      const publishTokenAmount = await adapter.getRequiredPublishTokenAmount(256n, 2);
      const updateResult = await adapter.updateKnowledgeCollectionV10({
        kaId,
        newMerkleRoot,
        newByteSize: 256n,
        newTokenAmount: publishTokenAmount,
        newMerkleLeafCount: 1,
        authorAddress: coreOp.address,
        authorR: ethers.getBytes(updateAuthorRaw.r),
        authorVS: ethers.getBytes(updateAuthorRaw.yParityAndS),
        authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.hash).toMatch(/^0x[0-9a-f]{64}$/);

      // --- verifyKAUpdate on the update tx ---
      const verified = await adapter.verifyKAUpdate(
        updateResult.hash,
        kaId,
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
      const notVerified = await adapter.verifyKAUpdate(updateResult.hash, kaId, wrongPub);
      expect(notVerified.verified).toBe(false);
    }, 120_000);

    // #831 regression test: a metadata update with `newByteSize > currentByteSize`
    // MUST land on-chain without the caller specifying `newTokenAmount`. The
    // adapter's `computeUpdateNewTokenAmount` helper is responsible for paying
    // the exact marginal growth cost so `KnowledgeAssetsLifecycle._validateTokenAmount`
    // sees a non-zero `deltaTokenAmount` and accepts the update. Pre-#831 this
    // reverted with `InvalidTokenAmount(1, 0)` whenever the daemon carried the
    // current tokenAmount forward (delta=0).
    it('updates with a larger newByteSize and no caller-provided newTokenAmount (#831)', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);

      const { kaId, merkleRoot: originalRoot } = await publishOneKCV10({
        kaCount: 1,
        byteSize: 256n,
        epochs: 2,
      });

      const newMerkleRoot = ethers.getBytes(
        ethers.keccak256(ethers.toUtf8Bytes(`growth-update-${Date.now()}`)),
      );
      expect(ethers.hexlify(newMerkleRoot)).not.toBe(ethers.hexlify(originalRoot));

      const provider = createProvider();
      const coreOp = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
      const kalAddress = await adapter.getKnowledgeAssetsLifecycleAddress();
      const evmChainId = await adapter.getEvmChainId();
      const updateAuthorTyped = buildUpdateAuthorAttestationTypedData({
        chainId: evmChainId,
        kav10Address: kalAddress,
        kaId,
        newMerkleRoot,
        authorAddress: coreOp.address,
      });
      const updateAuthorRaw = ethers.Signature.from(
        await coreOp.signTypedData(
          updateAuthorTyped.domain,
          updateAuthorTyped.types,
          updateAuthorTyped.message,
        ),
      );

      // Grow byteSize from 256 -> 1024. Critically: DO NOT pass `newTokenAmount` —
      // the adapter must derive it from the contract's growth-cost formula.
      const updateResult = await adapter.updateKnowledgeCollectionV10({
        kaId,
        newMerkleRoot,
        newByteSize: 1024n,
        newMerkleLeafCount: 1,
        authorAddress: coreOp.address,
        authorR: ethers.getBytes(updateAuthorRaw.r),
        authorVS: ethers.getBytes(updateAuthorRaw.yParityAndS),
        authorSchemeVersion: AUTHOR_SCHEME_VERSION_V1,
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.hash).toMatch(/^0x[0-9a-f]{64}$/);

      const verified = await adapter.verifyKAUpdate(
        updateResult.hash,
        kaId,
        adapter.getSignerAddress(),
      );
      expect(verified.verified).toBe(true);
      expect(ethers.hexlify(verified.onChainMerkleRoot!).toLowerCase()).toBe(
        ethers.hexlify(newMerkleRoot).toLowerCase(),
      );
    }, 120_000);

    it('resolvePublishByTxHash returns null for an unknown / zero tx hash', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const bogus = '0x' + 'ab'.repeat(32);
      const resolved = await adapter.resolvePublishByTxHash(bogus);
      expect(resolved).toBeNull();
    });

    // GH#2270 — `resolvePublishByTxHash` answers `null` for a mined-and-reverted
    // tx, a mined non-publish tx, a tx still in the mempool, and a tx the node
    // has never seen. Recovery read that `null` as "the publish did not happen"
    // and resent. These pin that `resolvePublishTransaction` tells them apart
    // against a real node, and specifically that `pending` comes from asking for
    // the TRANSACTION — not from inferring anything out of a missing receipt.
    describe('resolvePublishTransaction separates pending from absent [GH#2270]', () => {
      it('reports not-found for a hash the node has never seen', async () => {
        const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
        const bogus = '0x' + 'ab'.repeat(32);

        expect(await adapter.resolvePublishTransaction(bogus)).toEqual({ status: 'not-found' });
      });

      it('reports pending while unmined and unrecognized once mined — same hash', async () => {
        // One transaction, two verdicts. The only thing that changes between
        // them is whether it has been mined, so a resolver that derived its
        // answer from the absent receipt could not produce both.
        const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
        const provider = createProvider();
        const wallet = new Wallet(HARDHAT_KEYS.CORE_OP, provider);

        await provider.send('evm_setAutomine', [false]);
        let txHash: string;
        try {
          const sent = await wallet.sendTransaction({ to: wallet.address, value: 0n });
          txHash = sent.hash;
          expect(await adapter.resolvePublishTransaction(txHash)).toEqual({ status: 'pending' });
        } finally {
          await provider.send('evm_setAutomine', [true]);
        }
        await provider.send('evm_mine', []);

        // Mined and successful, but a plain transfer carries no publish event.
        expect(await adapter.resolvePublishTransaction(txHash)).toEqual({ status: 'unrecognized' });
        // The legacy surface collapses that and the pending case to one `null`.
        expect(await adapter.resolvePublishByTxHash(txHash)).toBeNull();
      });

      it('reports reverted for a mined failure receipt', async () => {
        const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
        const provider = createProvider();
        const wallet = new Wallet(HARDHAT_KEYS.CORE_OP, provider);
        const { hubAddress } = getSharedContext();

        // Unknown selector against a deployed contract with no fallback. The
        // explicit gasLimit skips estimateGas, and automine has to be off for
        // the send itself: Hardhat simulates on eth_sendRawTransaction while
        // automining and would reject the tx instead of mining a status-0
        // receipt. Mining it separately produces the failure receipt.
        await provider.send('evm_setAutomine', [false]);
        let txHash: string;
        try {
          const sent = await wallet.sendTransaction({
            to: hubAddress,
            data: '0xdeadbeef',
            gasLimit: 100_000,
          });
          txHash = sent.hash;
        } finally {
          await provider.send('evm_setAutomine', [true]);
        }
        await provider.send('evm_mine', []).catch(() => undefined);

        expect(await adapter.resolvePublishTransaction(txHash)).toEqual({ status: 'reverted' });
        // The legacy surface reports this the same way it reports a tx that
        // never existed — the fusion this whole tri-state exists to undo.
        expect(await adapter.resolvePublishByTxHash(txHash)).toBeNull();
      });
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
  // OT-RFC-43 Option-1 (variant 1a) — deterministic author-namespaced
  // KA identity. The publish carries a packed
  //   reservedKaId = (uint160(author) << 96) | number
  // and the contract mints EXACTLY that token id to the author, reverting
  // KaIdNamespaceMismatch for an out-of-namespace id and KaIdAlreadyMinted
  // on replay of the same (author, number).
  // --------------------------------------------------------------------
  describe('OT-RFC-43 Option-1: deterministic reservedKaId mint + replay/namespace guards', () => {
    it('deterministic-mint: a known packed reservedKaId is the minted kaId and the author owns it on-chain', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const author = new Wallet(HARDHAT_KEYS.CORE_OP).address;

      // A known, fixed number in CORE_OP's namespace.
      const number = nextKaNumber(author);
      const reservedKaId = packReservedKaId(author, number);

      const { kaId, reservedKaId: usedReservedKaId } = await publishOneKCV10({ reservedKaId });

      // The minted kaId equals exactly the supplied packed reservedKaId.
      expect(usedReservedKaId).toBe(reservedKaId);
      expect(kaId).toBe(reservedKaId);
      // Sanity: the high 160 bits decode back to the author address.
      expect(kaId >> 96n).toBe(BigInt(ethers.getAddress(author)));
      // Sanity: the low 96 bits decode back to the per-author number.
      expect(kaId & ((1n << 96n) - 1n)).toBe(number);

      // On-chain ownership: DKGKnowledgeAssets.ownerOf(kaId) === author.
      // DKGKnowledgeAssets is an asset-storage (resolved via the Hub's
      // getAssetStorageAddress, not getContractAddress), so read its address
      // through the adapter accessor and bind a minimal ERC-721 ownerOf ABI.
      // Touch a V10 accessor first so the adapter resolves its contracts
      // (getDKGKnowledgeAssetsAddress itself does not lazily init).
      await adapter.getKnowledgeAssetsLifecycleAddress();
      const dkgKaAddress = await adapter.getDKGKnowledgeAssetsAddress();
      const dkgKa = new Contract(
        dkgKaAddress,
        ['function ownerOf(uint256 tokenId) view returns (address)'],
        createProvider(),
      );
      const owner: string = await dkgKa.ownerOf(kaId);
      expect(owner.toLowerCase()).toBe(author.toLowerCase());
    }, 120_000);

    it('replay-revert: re-publishing the SAME (author, number) reservedKaId rejects (KaIdAlreadyMinted)', async () => {
      const author = new Wallet(HARDHAT_KEYS.CORE_OP).address;
      const number = nextKaNumber(author);
      const reservedKaId = packReservedKaId(author, number);

      // First mint succeeds.
      const first = await publishOneKCV10({ reservedKaId });
      expect(first.kaId).toBe(reservedKaId);

      // Second mint of the same packed id must reject. The contract reverts
      // KaIdAlreadyMinted; accept that name OR any generic revert marker so
      // the test stays green across ethers error-decoding differences while
      // still proving the supply-chain dedupe is enforced.
      await expect(
        publishOneKCV10({ reservedKaId }),
      ).rejects.toThrow(/KaIdAlreadyMinted|already minted|already been minted|revert|execution reverted|ERC721/i);
    }, 120_000);

    it('namespace-guard: a reservedKaId whose high bits != author is rejected by the adapter pre-tx guard', async () => {
      // High bits belong to a DIFFERENT address than the author (CORE_OP).
      const author = new Wallet(HARDHAT_KEYS.CORE_OP).address;
      const foreign = new Wallet(HARDHAT_KEYS.EXTRA2).address;
      expect(foreign.toLowerCase()).not.toBe(author.toLowerCase());

      // Pack the id into the FOREIGN namespace but publish as CORE_OP. The
      // adapter's pre-tx namespace guard must throw before spending gas; it
      // surfaces the word "namespace" / "KaIdNamespaceMismatch".
      const badReservedKaId = packReservedKaId(foreign, nextKaNumber(foreign));
      await expect(
        publishOneKCV10({ reservedKaId: badReservedKaId }),
      ).rejects.toThrow(/namespace|KaIdNamespaceMismatch/i);
    }, 120_000);
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

    it('resolves a funded publish plan through the concrete EVM publish mixin', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      const { hubAddress } = getSharedContext();
      await mintTokens(
        createProvider(),
        hubAddress,
        HARDHAT_KEYS.DEPLOYER,
        adapter.getSignerAddress(),
        ethers.parseEther('1000'),
      );
      const contextGraphId = await createTestContextGraph(adapter, undefined, 0);

      const plan = await adapter.resolvePublisherPublishPlan!({
        contextGraphId,
        effectiveByteSize: 256n,
        explicitPublishEpochs: 2,
        defaultPublishEpochs: 12,
      });

      expect(plan.publisherAddress.toLowerCase()).toBe(adapter.getSignerAddress().toLowerCase());
      expect(plan.publishEpochs).toBe(2);
      expect(plan.tokenAmount).toBeGreaterThanOrEqual(2n);
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
      // `nextAuthorizedSigner` lives in the EVMChainAdapterBase mixin base
      // after the structural split of evm-adapter.ts; the error wording is
      // unchanged, only its file moved.
      const src = readFileSync(
        join(import.meta.dirname, '..', 'src', 'evm-adapter-base.ts'),
        'utf8',
      );
      // Pin the exact wording. If this changes, every caller in
      // dkg-publisher / dkg-agent / cli that logs this message will
      // need to be updated too.
      expect(src).toContain('No authorized publisher wallet found in signer pool for context graph');
      expect(src).toContain('Ensure at least one configured wallet is permitted by on-chain publish authority.');
    });

    it('createKnowledgeAssets on a positive but non-existent contextGraphId bubbles a useful error (not silent null)', async () => {
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
      const dummyAuthor = {
        address: '0x0000000000000000000000000000000000000001',
        signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
        schemeVersion: 1,
      };
      await expect(
        adapter.createKnowledgeAssets!({
          publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
          contextGraphId: 10n ** 12n, // huge, never created
          merkleRoot,
          knowledgeAssetsAmount: 1,
          byteSize: 128n,
          epochs: 1,
          tokenAmount: 0n,
          isImmutable: false,
          merkleLeafCount: 1,
          publisherNodeIdentityId: BigInt(coreProfileId),
          author: dummyAuthor,
          ackSignatures: [],
        }),
      ).rejects.toThrow(/No authorized publisher wallet|authorized|context graph|revert|Unauthorized/i);
    }, 60_000);

    it('createKnowledgeAssets rejects non-positive contextGraphId with the documented pre-tx guard', async () => {
      const adapter = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
      await expect(
        adapter.createKnowledgeAssets!({
          publishOperationId: ethers.hexlify(ethers.randomBytes(32)),
          contextGraphId: 0n,
          merkleRoot: new Uint8Array(32),
          knowledgeAssetsAmount: 1,
          byteSize: 128n,
          epochs: 1,
          tokenAmount: 0n,
          isImmutable: false,
          merkleLeafCount: 1,
          publisherNodeIdentityId: 0n,
          author: {
            address: '0x0000000000000000000000000000000000000001',
            signature: { r: new Uint8Array(32), vs: new Uint8Array(32) },
            schemeVersion: 1,
          },
          ackSignatures: [],
        }),
      ).rejects.toThrow(/positive on-chain context graph id/);
    });
  });
});
