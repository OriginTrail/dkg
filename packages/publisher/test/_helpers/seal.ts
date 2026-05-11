/**
 * Test helper: build a `precomputedAttestation` over a publish call.
 *
 * Phase C (commit `d353d6a5`) made the publisher a pure transport for
 * AuthorAttestation seals — it neither signs nor accepts signing
 * material. Every on-chain test that previously relied on the
 * publisher's internal EOA fallback now needs to hand-build the seal,
 * so this helper centralises that ceremony to keep tests focused on
 * what they actually assert (transport, lifecycle, ownership,
 * ACK quorum, etc.).
 *
 * The helper mirrors `DKGAgent._buildPrecomputedAttestationForSelection`
 * (`packages/agent/src/dkg-agent.ts`) so the merkle root the test signs
 * exactly matches what `DKGPublisher.publish` will recompute at
 * publish-time. Notably it handles `privateQuads` per the Round 4
 * review §11 fix: each public root entity's private bag becomes a
 * `computePrivateRootV10` leaf in the KC merkle, in the same insertion
 * order the publisher walks `autoPartition(quads).keys()`.
 */
import { ethers } from 'ethers';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { DKGPublisher } from '../../src/dkg-publisher.js';
import { autoPartition, computeFlatKCRootV10, computePrivateRootV10 } from '../../src/index.js';
import {
  buildAuthorAttestationTypedData,
  AUTHOR_SCHEME_VERSION_V1,
} from '@origintrail-official/dkg-core';

export interface SealCtx {
  provider: ethers.JsonRpcProvider;
  kav10Address: string;
}

export interface BuildSealParams {
  quads: Quad[];
  /** Optional private quads — included in the merkle as private roots
   * per `computeFlatKCRoot(public, privateRoots)`. */
  privateQuads?: Quad[];
  author: ethers.Wallet;
  contextGraphId: string | bigint;
  ctx: SealCtx;
}

export interface PrecomputedAttestation {
  expectedMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
}

/**
 * Build a `precomputedAttestation` payload for `quads` (+ optional
 * `privateQuads`) signed by `author`. The returned object is shaped to
 * be passed verbatim as `PublishOptions.precomputedAttestation`.
 */
export async function buildSeal(
  params: BuildSealParams,
): Promise<PrecomputedAttestation> {
  const { quads, privateQuads = [], author, contextGraphId, ctx } = params;

  const kaMap = autoPartition(quads);
  const allPublic = [...kaMap.values()].flat();
  const privateRoots: Uint8Array[] = [];
  for (const rootEntity of kaMap.keys()) {
    if (privateQuads.length === 0) break;
    const entityPrivateQuads = privateQuads.filter(
      (q) =>
        q.subject === rootEntity ||
        q.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    if (entityPrivateQuads.length === 0) continue;
    const root = computePrivateRootV10(entityPrivateQuads);
    if (root) privateRoots.push(root);
  }
  const merkleRoot = computeFlatKCRootV10(allPublic, privateRoots);

  const chainIdNum = await ctx.provider.getNetwork().then((n) => n.chainId);
  const td = buildAuthorAttestationTypedData({
    chainId: BigInt(chainIdNum),
    kav10Address: ctx.kav10Address,
    contextGraphId: BigInt(contextGraphId),
    merkleRoot,
    authorAddress: author.address,
  });
  const sigHex = await author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedMerkleRoot: merkleRoot,
    authorAddress: author.address,
    signature: {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

export interface PublishSealedArgs {
  contextGraphId: string;
  quads: Quad[];
  privateQuads?: Quad[];
  /**
   * Anything else the caller wants to pass through to
   * `publisher.publish` / `publisher.update` (publisherPeerId,
   * accessPolicy, allowedPeers, isImmutable, epochs, byteSize, etc.).
   */
  [key: string]: unknown;
}

/**
 * Augment a `publisher.publish` / `publisher.update` argument bag with
 * a freshly-minted `precomputedAttestation` so existing tests can stay
 * structurally identical:
 *
 *   await publisher.publish(await withSeal(args, author, ctx))
 *
 * Note this is a TEST-ONLY helper; production callers are expected to
 * mint the seal at agent.assertion.finalize() time, not at publish
 * time, so they always pass a seal explicitly. See Phase C
 * (`d353d6a5`): the publisher is a pure transport for already-built
 * seals.
 */
export async function withSeal<T extends PublishSealedArgs>(
  args: T,
  author: ethers.Wallet,
  ctx: SealCtx,
): Promise<T & { precomputedAttestation: PrecomputedAttestation }> {
  const seal = await buildSeal({
    quads: args.quads,
    privateQuads: args.privateQuads,
    author,
    contextGraphId: args.contextGraphId,
    ctx,
  });
  return { ...args, precomputedAttestation: seal };
}

/**
 * Thin wrapper around `publisher.publish` that mints a CORE_OP-signed
 * seal automatically. Equivalent to `publisher.publish(await withSeal(args, author, ctx))`.
 */
export async function publishSealed(
  publisher: DKGPublisher,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
) {
  return publisher.publish(
    (await withSeal(args, author, ctx)) as unknown as Parameters<DKGPublisher['publish']>[0],
  );
}

/**
 * Thin wrapper around `publisher.update`. Mirror of `publishSealed`.
 */
export async function updateSealed(
  publisher: DKGPublisher,
  kcId: bigint,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
) {
  return publisher.update(
    kcId,
    (await withSeal(args, author, ctx)) as unknown as Parameters<DKGPublisher['update']>[1],
  );
}

/**
 * Wrap a `DKGPublisher` instance so that any `publish()` / `update()`
 * call without a `precomputedAttestation` automatically gets one
 * minted by `author` over the call's `quads` (and any `privateQuads`).
 *
 * Phase C (`d353d6a5`) made the publisher refuse to self-sign — every
 * on-chain publish must arrive with a seal. The agent
 * (`DKGAgent.publishAssertion`) does this in production at
 * `assertion.finalize()` time. For test files that pre-date Phase C
 * and still call `publisher.publish(...)` directly with an unsigned
 * argument bag, this wrapper preserves their existing call sites and
 * lets them stay focused on the behaviour they assert (lifecycle,
 * ACK quorum, access control, etc.) rather than seal ceremony.
 *
 * Calls that already include `precomputedAttestation` pass through
 * untouched, so tests that need explicit seal control (e.g.
 * agent-provenance-e2e.test.ts) keep working.
 *
 * Calls without `quads` (e.g. mocked test paths that just verify
 * argument shape) also pass through untouched, since there's nothing
 * to seal over.
 *
 * `publishFromSharedMemory` is intentionally NOT wrapped here — the
 * quads it publishes are selected via SPARQL from the SWM store, so
 * the test must build the seal over the same selection itself
 * (see `packages/publisher/test/swm-subset-cleanup.test.ts` for
 * the canonical pattern using `sealForRoots`/`sealForAll`).
 */
export interface WrapPublisherOpts {
  author: ethers.Wallet;
  ctx: SealCtx;
}

export function wrapPublisherForTest(
  publisher: DKGPublisher,
  opts: WrapPublisherOpts,
): DKGPublisher {
  return new Proxy(publisher, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      if (prop !== 'publish' && prop !== 'update') {
        return orig.bind(target);
      }
      return async (...args: unknown[]) => {
        const argIdx = prop === 'update' ? 1 : 0;
        const argBag = args[argIdx] as Record<string, unknown> | undefined;
        // Bind the seal to the on-chain CG id the publisher will sign
        // against (`publishContextGraphId` for remap publishes;
        // `contextGraphId` is the local label and may be a non-numeric
        // string like 'access-roundtrip', which would crash
        // `BigInt(...)` inside `buildAuthorAttestationTypedData`). Fall
        // back to the local label when the caller didn't pass an
        // explicit on-chain id.
        const sealCgId =
          (argBag?.['publishContextGraphId'] as string | bigint | undefined) ??
          (argBag?.['contextGraphId'] as string | bigint | undefined);
        if (
          argBag &&
          !argBag['precomputedAttestation'] &&
          Array.isArray(argBag['quads']) &&
          (argBag['quads'] as Quad[]).length > 0 &&
          typeof sealCgId !== 'undefined'
        ) {
          try {
            const seal = await buildSeal({
              quads: argBag['quads'] as Quad[],
              privateQuads: argBag['privateQuads'] as Quad[] | undefined,
              author: opts.author,
              contextGraphId: sealCgId,
              ctx: opts.ctx,
            });
            args[argIdx] = { ...argBag, precomputedAttestation: seal };
          } catch {
            // No chain configured (mock/none) — leave args unchanged
            // and let the publisher's own no-chain path handle it
            // (these tests assert tentative status anyway).
          }
        }
        return (orig as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/**
 * Convenience for the common pattern in publisher tests: take an
 * `EVMChainAdapter` (already wired with `provider` + V10 address) and a
 * private key for the test author, derive the `SealCtx` lazily, and
 * return a wrapped publisher. Lets test files write a single line:
 *
 *   publisher = await wrapPublisherWithChain(new DKGPublisher(...), chain, HARDHAT_KEYS.CORE_OP);
 *
 * Re-uses the chain's provider so tests don't have to spin up their
 * own (avoids extra RPC sockets for hardhat tests that already have
 * chains available).
 */
export async function wrapPublisherWithChain(
  publisher: DKGPublisher,
  chain: { getProvider: () => ethers.JsonRpcProvider; getKnowledgeAssetsV10Address: () => Promise<string> },
  authorKey: string,
): Promise<DKGPublisher> {
  return wrapPublisherForTest(publisher, {
    author: new ethers.Wallet(authorKey),
    ctx: {
      provider: chain.getProvider(),
      kav10Address: await chain.getKnowledgeAssetsV10Address(),
    },
  });
}

/**
 * Build a `SealCtx` against a fake provider for unit tests that use
 * `MockChainAdapter`. The provider stub returns `chainId=31337` from
 * `getNetwork()` — enough to drive `buildAuthorAttestationTypedData`.
 * The mock chain doesn't validate the seal cryptographically, so any
 * deterministic chainId works as long as the test asserts behaviour
 * downstream of `chain.publish()` (status, captured args, etc.) and
 * not seal authenticity.
 */
export function mockSealCtx(opts: {
  chainId?: bigint;
  kav10Address?: string;
} = {}): SealCtx {
  const chainId = opts.chainId ?? 31337n;
  // Must match `MockChainAdapter.getKnowledgeAssetsV10Address()` exactly,
  // otherwise the publisher's `recoverAddress` step in the seal-integrity
  // preflight rebuilds typed data with the chain's address (not ours)
  // and the recovered signer no longer equals the recorded
  // `authorAddress` — yielding a "signer mismatch" hard error.
  const kav10Address = opts.kav10Address ?? '0x000000000000000000000000000000000000c10a';
  return {
    provider: {
      getNetwork: async () => ({ chainId }),
    } as unknown as ethers.JsonRpcProvider,
    kav10Address,
  };
}
