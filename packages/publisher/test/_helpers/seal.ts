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
import type { V10ACKProvider } from '../../src/publisher.js';
import { autoPartition, computeFlatKCRootV10, computePrivateRootV10 } from '../../src/index.js';
import {
  buildAuthorAttestationTypedData,
  buildUpdateAuthorAttestationTypedData,
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
  /**
   * §F2 — packed `(author << 96) | number` kaId the seal's typed data binds.
   * `buildSeal` has always returned it (the publisher mints exactly this id);
   * it was just missing from this declared type, which made sealed publish
   * option bags fail tsc against `PublishOptions.precomputedAttestation`.
   */
  reservedKaId: bigint;
}

export interface PrecomputedUpdateAttestation {
  expectedNewMerkleRoot: Uint8Array;
  authorAddress: string;
  signature: { r: Uint8Array; vs: Uint8Array };
  schemeVersion: number;
}

// §F2 — per-author monotonic KA-number for test seals (unique within a chain).
const _sealNumberByAuthor = new Map<string, bigint>();
function nextSealNumber(author: string): bigint {
  const k = author.toLowerCase();
  const n = (_sealNumberByAuthor.get(k) ?? 0n) + 1n;
  _sealNumberByAuthor.set(k, n);
  return n;
}

/**
 * Build a `precomputedAttestation` payload for `quads` (+ optional
 * `privateQuads`) signed by `author`. The returned object is shaped to
 * be passed verbatim as `PublishOptions.precomputedAttestation`.
 */
export async function buildSeal(
  params: BuildSealParams,
): Promise<PrecomputedAttestation> {
  const { quads, privateQuads = [], author, ctx } = params;

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
  // §F2 — the AuthorAttestation digest now binds the packed reservedKaId; the
  // publisher mints with it (carried on the precomputedAttestation). Allocate a
  // per-author monotonic number so repeated seals on one chain don't collide.
  const reservedKaId =
    (BigInt(ethers.getAddress(author.address)) << 96n) | nextSealNumber(author.address);
  const td = buildAuthorAttestationTypedData({
    chainId: BigInt(chainIdNum),
    kav10Address: ctx.kav10Address,
    // #1116: AuthorAttestation no longer binds contextGraphId.
    merkleRoot,
    authorAddress: author.address,
    reservedKaId,
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
    reservedKaId,
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
 * Build `precomputedUpdateAttestation` for `publisher.update(kaId, ...)`.
 */
export async function buildUpdateSeal(params: {
  kaId: bigint;
  quads: Quad[];
  privateQuads?: Quad[];
  author: ethers.Wallet;
  ctx: SealCtx;
}): Promise<PrecomputedUpdateAttestation> {
  const kaMap = autoPartition(params.quads);
  const allPublic = [...kaMap.values()].flat();
  const privateRoots: Uint8Array[] = [];
  for (const rootEntity of kaMap.keys()) {
    const entityPrivateQuads = (params.privateQuads ?? []).filter(
      (q) =>
        q.subject === rootEntity ||
        q.subject.startsWith(rootEntity + '/.well-known/genid/'),
    );
    if (entityPrivateQuads.length === 0) continue;
    const root = computePrivateRootV10(entityPrivateQuads);
    if (root) privateRoots.push(root);
  }
  const newMerkleRoot = computeFlatKCRootV10(allPublic, privateRoots);
  const chainIdNum = await params.ctx.provider.getNetwork().then((n) => n.chainId);
  const td = buildUpdateAuthorAttestationTypedData({
    chainId: BigInt(chainIdNum),
    kav10Address: params.ctx.kav10Address,
    kaId: params.kaId,
    newMerkleRoot,
    authorAddress: params.author.address,
  });
  const sigHex = await params.author.signTypedData(td.domain, td.types, td.message);
  const sig = ethers.Signature.from(sigHex);
  return {
    expectedNewMerkleRoot: newMerkleRoot,
    authorAddress: params.author.address,
    signature: {
      r: ethers.getBytes(sig.r),
      vs: ethers.getBytes(sig.yParityAndS),
    },
    schemeVersion: AUTHOR_SCHEME_VERSION_V1,
  };
}

export async function withUpdateSeal<T extends PublishSealedArgs>(
  kaId: bigint,
  args: T,
  author: ethers.Wallet,
  ctx: SealCtx,
): Promise<T & { precomputedUpdateAttestation: PrecomputedUpdateAttestation }> {
  const seal = await buildUpdateSeal({
    kaId,
    quads: args.quads,
    privateQuads: args.privateQuads,
    author,
    ctx,
  });
  return { ...args, precomputedUpdateAttestation: seal };
}

/**
 * Thin wrapper around `publisher.publish` that mints a CORE_OP-signed
 * seal automatically. Equivalent to `publisher.publish(await withSeal(args, author, ctx))`.
 *
 * RC11 / PR1: a `v10ACKProvider` may be threaded through `extras` so
 * tests that build their publisher directly (no `wrapPublisherForTest`)
 * still satisfy the V10 ACK quorum. Without it, the publish reaches
 * the chain-submit branch with zero ACKs and falls back to
 * `tentative` — fine for tests that assert that, but not for the
 * majority of Hardhat tests that assert `confirmed`. Pass
 * `hardhatACKProvider(kav10Address)` from `./acks.ts` for the
 * common case.
 */
export async function publishSealed(
  publisher: DKGPublisher,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
  extras: { v10ACKProvider?: V10ACKProvider } = {},
) {
  const sealed = await withSeal(args, author, ctx);
  const merged = extras.v10ACKProvider !== undefined
    ? { ...sealed, v10ACKProvider: extras.v10ACKProvider }
    : sealed;
  return publisher.publish(merged as unknown as Parameters<DKGPublisher['publish']>[0]);
}

/**
 * Thin wrapper around `publisher.update`. Mirror of `publishSealed`.
 */
export async function updateSealed(
  publisher: DKGPublisher,
  kaId: bigint,
  args: PublishSealedArgs,
  author: ethers.Wallet,
  ctx: SealCtx,
  extras: { v10ACKProvider?: V10ACKProvider } = {},
) {
  const sealed = await withUpdateSeal(kaId, args, author, ctx);
  const merged = extras.v10ACKProvider !== undefined
    ? { ...sealed, v10ACKProvider: extras.v10ACKProvider }
    : sealed;
  return publisher.update(kaId, merged as unknown as Parameters<DKGPublisher['update']>[1]);
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
 *
 * RC11 / PR1: also injects a default `v10ACKProvider` when one is
 * provided via `opts.v10ACKProvider`. The publisher's self-signed
 * ACK fallback is deleted, so Hardhat tests that go on-chain must
 * supply real ACKs from real (sharding-table-resident) signer
 * identities. Wiring it here keeps existing test bodies unchanged.
 */
export interface WrapPublisherOpts {
  author: ethers.Wallet;
  ctx: SealCtx;
  /**
   * Optional default `V10ACKProvider`. When set, any `publish()` /
   * `update()` call without an explicit `v10ACKProvider` in its
   * argument bag will receive this one. Pass-through is preserved for
   * calls that supply their own provider (e.g. tests asserting ACK
   * collection failure semantics). Build one with
   * `makeInMemoryV10ACKProvider` from `./acks.ts`.
   */
  v10ACKProvider?: V10ACKProvider;
}

export function wrapPublisherForTest(
  publisher: DKGPublisher,
  opts: WrapPublisherOpts,
): DKGPublisher {
  return new Proxy(publisher, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== 'function') return orig;
      if (prop !== 'publish' && prop !== 'update' && prop !== 'publishFromSharedMemory') {
        return orig.bind(target);
      }
      return async (...args: unknown[]) => {
        // PR3 helper-correctness fix: `publishFromSharedMemory` takes
        // `(contextGraphId: string, selection, options)` — the options
        // bag is at index 2, not 0. The previous code assumed argIdx=0
        // for all three call shapes and ended up spreading a plain
        // string into `args[0]` (`{"0": "5"}`) when the wrapper tried
        // to inject `v10ACKProvider`, which then surfaced inside the
        // publisher as `did:dkg:context-graph:[object Object]/...`
        // and a SPARQL parse failure on the next store.query.
        const argIdx = prop === 'update' ? 1 : prop === 'publishFromSharedMemory' ? 2 : 0;
        const kaIdForUpdate = prop === 'update' ? (args[0] as bigint) : undefined;
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
        // Only auto-seal for publish/update — publishFromSharedMemory
        // selects its quads inside the publisher and the caller's args
        // bag has none.
        if (
          prop !== 'publishFromSharedMemory' &&
          argBag &&
          Array.isArray(argBag['quads']) &&
          (argBag['quads'] as Quad[]).length > 0
        ) {
          try {
            if (prop === 'update' && kaIdForUpdate !== undefined && !argBag['precomputedUpdateAttestation']) {
              const updateSeal = await buildUpdateSeal({
                kaId: kaIdForUpdate,
                quads: argBag['quads'] as Quad[],
                privateQuads: argBag['privateQuads'] as Quad[] | undefined,
                author: opts.author,
                ctx: opts.ctx,
              });
              args[argIdx] = { ...argBag, precomputedUpdateAttestation: updateSeal };
            } else if (
              prop !== 'update' &&
              !argBag['precomputedAttestation'] &&
              typeof sealCgId !== 'undefined'
            ) {
              const seal = await buildSeal({
                quads: argBag['quads'] as Quad[],
                privateQuads: argBag['privateQuads'] as Quad[] | undefined,
                author: opts.author,
                contextGraphId: sealCgId,
                ctx: opts.ctx,
              });
              args[argIdx] = { ...argBag, precomputedAttestation: seal };
            }
          } catch {
            // No chain configured (mock/none) — leave args unchanged
            // and let the publisher's own no-chain path handle it
            // (these tests assert tentative status anyway).
          }
        }
        // RC11 / PR3: inject `v10ACKProvider` into the options bag.
        // For `publishFromSharedMemory(contextGraphId, selection, options?)`
        // the options bag at index 2 is OPTIONAL — many existing tests
        // call it as `publishFromSharedMemory(cgId, selection)`. Promote
        // an absent bag to `{}` here so the injection still lands;
        // otherwise the wrapped publisher never sees the ACK provider
        // and the on-chain submit fires the loud "V10 ACKs required"
        // guard. Skip the promotion for `publish` / `update` where
        // index 0/1 is the (required) primary argument bag — an
        // undefined value there is a real test-author bug we want
        // surfaced rather than silently masked.
        if (opts.v10ACKProvider) {
          // Spread the CURRENT args[argIdx] (which may already include
          // the precomputedAttestation from the seal-injection block
          // above) rather than the original `argBag` snapshot —
          // otherwise the ACK injection wipes the seal.
          const currentBag = args[argIdx] as Record<string, unknown> | undefined;
          if (currentBag) {
            if (!currentBag['v10ACKProvider']) {
              args[argIdx] = { ...currentBag, v10ACKProvider: opts.v10ACKProvider };
            }
          } else if (prop === 'publishFromSharedMemory') {
            args[argIdx] = { v10ACKProvider: opts.v10ACKProvider };
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
 *
 * RC11 / PR1: an optional `v10ACKProvider` is forwarded into
 * `wrapPublisherForTest`. Tests that want their wrapped publisher to
 * collect real 3-of-N ACKs from in-memory core signers should build
 * one with `makeInMemoryV10ACKProvider` from `./acks.ts` and pass it
 * here. Tests that go off-chain (mock adapter, no chain) leave it
 * undefined — the publisher's no-chain branch skips ACK collection
 * entirely.
 */
export async function wrapPublisherWithChain(
  publisher: DKGPublisher,
  chain: { getProvider: () => ethers.JsonRpcProvider; getKnowledgeAssetsLifecycleAddress: () => Promise<string> },
  authorKey: string,
  options?: { v10ACKProvider?: V10ACKProvider },
): Promise<DKGPublisher> {
  return wrapPublisherForTest(publisher, {
    author: new ethers.Wallet(authorKey),
    ctx: {
      provider: chain.getProvider(),
      kav10Address: await chain.getKnowledgeAssetsLifecycleAddress(),
    },
    v10ACKProvider: options?.v10ACKProvider,
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
  // Must match `MockChainAdapter.getKnowledgeAssetsLifecycleAddress()` exactly,
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
