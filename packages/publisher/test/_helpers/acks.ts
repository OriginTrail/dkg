/**
 * Test helper: in-memory V10 ACK provider that signs the ACK digest with
 * a configured set of "core node" wallets.
 *
 * Replaces the self-signed ACK fallback (deleted in RC11 / PR1). Hardhat
 * tests that previously relied on the publisher synthesising a single
 * ACK with `peerId: 'self'` now route through this helper instead, so
 * every test exercises the real V10 ACK quorum code path with N
 * distinct signers backed by N distinct on-chain identities — the same
 * shape production hits when 3 connected core peers each return a
 * StorageACK.
 *
 * The helper is intentionally pure / synchronous-after-setup: it
 * pre-resolves each signer's `nodeIdentityId` at construction time so
 * the returned `V10ACKProvider` closure does not need any RPC during a
 * publish. This keeps test publishes single-RPC (just the publish tx).
 */
import { ethers } from 'ethers';
import { computePublishACKDigest } from '@origintrail-official/dkg-core';
import type { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import type { V10ACKProvider, V10CoreNodeACK, V10UpdateACKProvider } from '../../src/publisher.js';
import { getSharedContext, HARDHAT_KEYS } from '../../../chain/test/evm-test-context.js';

export interface InMemoryACKSigner {
  /** EVM private key (0x-prefixed). Recovers to the operator address registered for `identityId`. */
  privateKey: string;
  /** On-chain `IdentityStorage` id whose operational key recovers to `signerWallet.address`. */
  identityId: bigint;
  /** Synthetic libp2p peer id label. Cosmetic — only surfaces in publisher logs. */
  peerId?: string;
}

export interface InMemoryACKProviderOptions {
  /** Numeric EVM chain id (e.g. 31337n for the Hardhat harness). */
  chainId: bigint;
  /** Deployed address of `KnowledgeAssetsV10`. */
  kav10Address: string;
  /**
   * Resolves the on-chain numeric context graph id the ACK digest signs.
   * The publisher invokes the ACK provider with the CG name as a string,
   * which for `publishContextGraphId` flows IS the numeric id but for
   * direct `publish({ contextGraphId: "my-cg" })` calls in tests is a
   * descriptive label. Tests that publish through descriptive labels
   * must pass a resolver that translates label → numeric id.
   *
   * Defaults to `BigInt(contextGraphIdStr)` which is correct for the
   * numeric-string case and throws for descriptive labels (caller
   * intent: don't try to ACK a non-numeric CG).
   */
  resolveContextGraphId?: (contextGraphIdStr: string) => bigint;
  /**
   * Signers that will produce ACKs. Order is preserved in the returned
   * `V10CoreNodeACK[]`. The publisher requests N ACKs where N is the
   * on-chain `minimumRequiredSignatures`; this helper ALWAYS returns
   * all configured signers and lets the publisher / contract enforce
   * the quorum — keeps the helper symmetric with the production
   * `ACKCollector` which also returns the first N collected.
   */
  signers: InMemoryACKSigner[];
}

/**
 * Build a `V10ACKProvider` that signs the canonical V10 ACK digest with
 * each configured signer and returns the assembled ACK array.
 *
 * The digest construction mirrors `packages/publisher/src/ack-collector.ts:159`
 * verbatim — same `computePublishACKDigest` inputs, same `signMessage`
 * personal-sign prefix (the on-chain `_verifySignature` recovers via
 * `ECDSA.tryRecover` against the already-prefixed hash, see
 * `KnowledgeAssetsV10.sol:759`).
 */
export function makeInMemoryV10ACKProvider(
  opts: InMemoryACKProviderOptions,
): V10ACKProvider {
  const { chainId, kav10Address, signers } = opts;
  if (signers.length === 0) {
    throw new Error('makeInMemoryV10ACKProvider: at least one signer required');
  }
  const resolveCgId = opts.resolveContextGraphId ?? ((s) => BigInt(s));

  const wallets = signers.map((s) => ({
    wallet: new ethers.Wallet(s.privateKey),
    identityId: s.identityId,
    peerId: s.peerId ?? `in-memory-core-${s.identityId}`,
  }));

  return async (
    merkleRoot,
    contextGraphIdStr,
    kaCount,
    _rootEntities,
    publicByteSize,
    _stagingQuads,
    epochs,
    tokenAmount,
    _swmGraphId,
    _subGraphName,
    merkleLeafCount,
    _isEncryptedPayload,
  ): Promise<V10CoreNodeACK[]> => {
    const cgId = resolveCgId(contextGraphIdStr);
    const digest = computePublishACKDigest(
      chainId,
      kav10Address,
      cgId,
      merkleRoot,
      BigInt(kaCount),
      publicByteSize,
      BigInt(epochs ?? 1),
      tokenAmount ?? 0n,
      BigInt(merkleLeafCount),
      new Uint8Array(32),
      0n,
      false,
    );

    return Promise.all(
      wallets.map(async ({ wallet, identityId, peerId }) => {
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        return {
          peerId,
          signatureR: ethers.getBytes(sig.r),
          signatureVS: ethers.getBytes(sig.yParityAndS),
          nodeIdentityId: identityId,
        };
      }),
    );
  };
}

/**
 * Convenience for Hardhat publisher tests: build a 3-of-N in-memory
 * ACK provider wired to the harness's three staked receiver nodes
 * (REC1_OP / REC2_OP / REC3_OP) using their post-spawn
 * `receiverIds[]`. Pair with `wrapPublisherWithChain(..., { v10ACKProvider })`.
 *
 * Example:
 *   const ctx = getSharedContext();
 *   const ackProvider = makeHardhatReceiverACKProvider(
 *     ctx,
 *     await chain.getKnowledgeAssetsLifecycleAddress(),
 *   );
 *   publisher = await wrapPublisherWithChain(
 *     new DKGPublisher(...),
 *     chain,
 *     HARDHAT_KEYS.CORE_OP,
 *     { v10ACKProvider: ackProvider },
 *   );
 */
export function makeHardhatUpdateACKProvider(
  ctx: { receiverIds: number[] },
  chain: EVMChainAdapter,
  signerKeys: readonly [string, string, string],
): V10UpdateACKProvider {
  if (ctx.receiverIds.length < 3) {
    throw new Error(
      `makeHardhatUpdateACKProvider: harness must have 3 receiver ids, got ${ctx.receiverIds.length}`,
    );
  }
  const wallets = signerKeys.map((pk, i) => ({
    wallet: new ethers.Wallet(pk),
    identityId: BigInt(ctx.receiverIds[i]!),
    peerId: `in-memory-rec${i + 1}`,
  }));
  return async (kaId, newMerkleRoot, _contextGraphIdStr, newByteSize, newMerkleLeafCount) => {
    const digest = await chain.computeV10UpdateAckDigest({
      kaId,
      newMerkleRoot,
      newByteSize,
      newMerkleLeafCount,
    });
    return Promise.all(
      wallets.map(async ({ wallet, identityId, peerId }) => {
        const sig = ethers.Signature.from(await wallet.signMessage(digest));
        return {
          peerId,
          signatureR: ethers.getBytes(sig.r),
          signatureVS: ethers.getBytes(sig.yParityAndS),
          nodeIdentityId: identityId,
        };
      }),
    );
  };
}

export function makeHardhatReceiverACKProvider(
  ctx: { receiverIds: number[] },
  kav10Address: string,
  signerKeys: readonly [string, string, string],
  chainId: bigint = 31337n,
): V10ACKProvider {
  if (ctx.receiverIds.length < 3) {
    throw new Error(
      `makeHardhatReceiverACKProvider: harness must have 3 receiver ids, got ${ctx.receiverIds.length}`,
    );
  }
  return makeInMemoryV10ACKProvider({
    chainId,
    kav10Address,
    signers: [
      { privateKey: signerKeys[0], identityId: BigInt(ctx.receiverIds[0]!), peerId: 'in-memory-rec1' },
      { privateKey: signerKeys[1], identityId: BigInt(ctx.receiverIds[1]!), peerId: 'in-memory-rec2' },
      { privateKey: signerKeys[2], identityId: BigInt(ctx.receiverIds[2]!), peerId: 'in-memory-rec3' },
    ],
  });
}

/**
 * Module-level singleton wrapping `makeHardhatReceiverACKProvider` with
 * the shared Hardhat context's receiver ids + the default REC1..REC3
 * operator keys. Lets test files inject the default 3-of-N ACK provider
 * with a single import + a single line at the publish/wrap call site:
 *
 *   import { hardhatACKProvider } from './_helpers/acks.js';
 *   // ...
 *   v10ACKProvider: hardhatACKProvider(kav10Address),
 *
 * Memoised per `kav10Address` so repeated calls in tight loops are
 * cheap. Caller is responsible for ensuring `kav10Address` is
 * resolved before the call (typically: `beforeAll` already awaited
 * `chain.getKnowledgeAssetsLifecycleAddress()` and stashed it).
 */
const _hardhatACKProviderCache = new Map<string, V10ACKProvider>();
export function hardhatACKProvider(kav10Address: string): V10ACKProvider {
  const cached = _hardhatACKProviderCache.get(kav10Address);
  if (cached) return cached;
  const provider = makeHardhatReceiverACKProvider(
    getSharedContext(),
    kav10Address,
    [HARDHAT_KEYS.REC1_OP, HARDHAT_KEYS.REC2_OP, HARDHAT_KEYS.REC3_OP],
  );
  _hardhatACKProviderCache.set(kav10Address, provider);
  return provider;
}

/**
 * PR3 / RC11 — minimal stub V10ACKProvider for mock-chain publisher
 * tests. After PR1 deleted the self-signed ACK fallback, tests that
 * use `MockChainAdapter` (or one of its subclasses) and previously
 * relied on the publisher producing a single `peerId: 'self'` ACK
 * need to supply *some* ACK so the publisher's
 * `V10 ACKs required for on-chain publish` guard doesn't fire and
 * downgrade the result to tentative.
 *
 * The mock chain does NOT verify ACK signatures (it only checks
 * `params.publisherAddress`), so the helper returns a single
 * structurally-valid-but-cryptographically-meaningless ACK signed
 * with a deterministic dummy wallet. This is the same shape the
 * deleted self-sign fallback produced, just emitted from the test
 * helper instead of the publisher itself. Real EVM publish tests
 * MUST use `hardhatACKProvider` — never this stub.
 *
 * Reserved for `*-no-random-wallet.test.ts` and other mock-chain
 * smoke tests where the load-bearing assertion is something other
 * than ACK correctness (e.g. signer reservation, token amount
 * computation, address inference).
 */
const _STUB_ACK_WALLET = new ethers.Wallet(
  '0x0000000000000000000000000000000000000000000000000000000000000001',
);
export function mockChainStubACKProvider(opts?: { identityId?: bigint }): V10ACKProvider {
  const identityId = opts?.identityId ?? 1n;
  return async (): Promise<V10CoreNodeACK[]> => {
    const sig = ethers.Signature.from(
      await _STUB_ACK_WALLET.signMessage('mock-chain-stub-ack'),
    );
    return [
      {
        peerId: 'mock-chain-stub',
        signatureR: ethers.getBytes(sig.r),
        signatureVS: ethers.getBytes(sig.yParityAndS),
        nodeIdentityId: identityId,
      },
    ];
  };
}
