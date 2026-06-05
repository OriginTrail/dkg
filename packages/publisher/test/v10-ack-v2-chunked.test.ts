/**
 * V2 chunked StorageACK handler tests — adapter-level coverage for the LU-11
 * / OT-RFC-39 ACK path landed by PR #715/#717 and the canonical-CG-keying
 * fix in PR #729 Bug 4 (`storage-ack-handler.ts` `loadChunk` /
 * `normalizeContextGraphIdForChunkStore`).
 *
 * The existing `v10-ack-edge-cases.test.ts` thoroughly covers the V1
 * (inline staging quads / inline encrypted blob) ACK paths; the chunked
 * V2 path was shipped without an integration test of its own. That gap
 * was flagged during the #716 review-consolidation audit as the closest
 * analogue of the gap PR #735 closed for #720 — helper-level primitives
 * (chunked AEAD, ciphertext Merkle tree, proto wire format) are well
 * tested, but the handler that wires them together at the ACK boundary
 * is not. This file closes that gap.
 *
 * Specifically, this exercises the four V2 invariants:
 *
 *   1. Happy path with `swmGraphId` + a canonicalising normalizer:
 *      chunks looked up under `ciphertextChunkStoreGraph(canonical)`
 *      and the ACK is signed.
 *
 *   2. **#729 Bug 4 regression**: a V2 intent that omits `swmGraphId`
 *      (the wire field is optional) with a normalizer that returns
 *      `null` for non-canonical inputs — the handler MUST widen to a
 *      `GRAPH ?g` wildcard scan and still find the chunks. The pre-fix
 *      behaviour was to fall through to `gossipWireIdFor(cgId)` on a
 *      decimal-numeric string (e.g. keccak("42")) and miss every
 *      persisted chunk — the V2 ACK then declined with
 *      `MISSING_CIPHERTEXT_CHUNKS` even though the bytes were on disk.
 *
 *   3. Per-CG named-graph isolation: two CGs publishing identical V10
 *      KCs share a `batchId` (it's plaintext-derived) but persist
 *      chunks under different canonical named graphs; an ACK for CG-A
 *      must only see CG-A's chunks. This pins the "Codex review on
 *      PR #715" multi-CG collision Codex called out at
 *      `ciphertext-chunk-store.ts:28-44`.
 *
 *   4. Decline shapes: `MISSING_CIPHERTEXT_CHUNKS` when chunks are
 *      partially present and `CIPHERTEXT_ROOT_MISMATCH` when the
 *      recomputed root differs from the publisher's claim.
 *
 * `sendContractTransaction`, libp2p, and the chunked-AEAD encryption
 * are not in scope — the handler operates on already-persisted bytes
 * and a pre-encoded `PublishIntent` envelope. We seed the store with
 * synthetic chunk literals to keep the test surface narrow.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  ACK_PROTOCOL_VERSION_V2_LU11,
  buildCiphertextChunksRoot,
  ciphertextChunkStoreGraph,
  ciphertextChunkStoreSubject,
  CIPHERTEXT_CHUNK_PREDICATE,
  decodeStorageACK,
  encodePublishIntent,
  STORAGE_ACK_DECLINE_CODES,
  isStorageACKDecline,
} from '@origintrail-official/dkg-core';
import {
  StorageACKHandler,
  type StorageACKHandlerConfig,
} from '../src/storage-ack-handler.js';

const TEST_CHAIN_ID = 31337n;
const TEST_KAV10_ADDR = '0x000000000000000000000000000000000000c10a';

// Numeric on-chain CG id surface — V10 publish/digest path requires this
// shape. The wire form (curator nameHash) is whatever
// `gossipWireIdFor` would compute; we hard-code a fake one here so the
// normalizer-canonicalises-cleartext path is deterministic and doesn't
// have to reach into agent internals.
const NUMERIC_CG_ID = '42';
// A second distinct on-chain numeric CG id for tests that need to
// exercise per-CG isolation. The `+ 1n` shape used previously
// silently produced `"421"` (string concat with a BigInt coerces to
// string) — functionally fine but misleading vs the "next numeric
// id" intent. A literal makes the test's data crystal clear.
const NUMERIC_CG_ID_B = '43';
const CLEARTEXT_CG_ID = 'my-cg-cleartext-name';
const CANONICAL_WIRE_FOR_CLEARTEXT =
  '0x' + ethers.keccak256(ethers.toUtf8Bytes(CLEARTEXT_CG_ID)).slice(2);

function makeEventBus(): { emit: () => void; on: () => void; off: () => void; once: () => void } {
  return { emit: () => {}, on: () => {}, off: () => {}, once: () => {} };
}

interface BuildIntentOpts {
  cgId?: string;
  swmGraphId?: string;
  merkleRoot: Uint8Array;
  /**
   * The chunks the publisher claims to have persisted. The helper
   * derives `ciphertextChunksRoot`, `ciphertextChunkCount`, and
   * `publicByteSize` (sum of chunk lengths) from this list — matching
   * what the production chunked publisher would emit and what the V2
   * ACK handler validates at lines 431-436 of `storage-ack-handler.ts`.
   */
  chunks: Uint8Array[];
  /**
   * Optional overrides for fields the test wants to *lie* about
   * (e.g. flip the root to provoke `CIPHERTEXT_ROOT_MISMATCH`, or
   * inflate the count to provoke `MISSING_CIPHERTEXT_CHUNKS`).
   */
  override?: {
    ciphertextChunksRoot?: Uint8Array;
    ciphertextChunkCount?: number;
    publicByteSize?: number;
  };
  kaCount?: number;
  merkleLeafCount?: number;
}

/**
 * Build a V2-shaped PublishIntent byte-buffer. Mirrors what the chunked
 * publisher emits: `ackProtocolVersion = 2`, empty `stagingQuads`, the
 * ciphertext commitment fields populated, optional `swmGraphId`. All
 * three derived fields (`ciphertextChunksRoot`, `ciphertextChunkCount`,
 * `publicByteSize`) come from the chunks unless explicitly overridden
 * by the test.
 */
function buildV2IntentBytes(opts: BuildIntentOpts): Uint8Array {
  const totalBytes = opts.chunks.reduce((acc, c) => acc + c.length, 0);
  const trueRoot = buildCiphertextChunksRoot(opts.chunks).root;
  return encodePublishIntent({
    merkleRoot: opts.merkleRoot,
    contextGraphId: opts.cgId ?? NUMERIC_CG_ID,
    publisherPeerId: 'publisher-v2',
    publicByteSize: opts.override?.publicByteSize ?? totalBytes,
    isPrivate: false,
    // OT-RFC-43 / V10: a publish mints exactly one KA; rootEntities may still
    // list multiple member entities.
    kaCount: opts.kaCount ?? 1,
    merkleLeafCount: opts.merkleLeafCount ?? 4,
    rootEntities: ['urn:a', 'urn:b'],
    stagingQuads: new Uint8Array(0),
    ackProtocolVersion: ACK_PROTOCOL_VERSION_V2_LU11,
    ciphertextChunksRoot: opts.override?.ciphertextChunksRoot ?? trueRoot,
    ciphertextChunkCount: opts.override?.ciphertextChunkCount ?? opts.chunks.length,
    ...(opts.swmGraphId ? { swmGraphId: opts.swmGraphId } : {}),
  });
}

/**
 * Insert chunked-AEAD bytes into the store under the same shape the
 * production ingest path (`ingestSwmCiphertextChunkEnvelope` in
 * `dkg-agent.ts`) writes:
 *
 *   GRAPH <ciphertextChunkStoreGraph(canonicalCgId)> {
 *     <ciphertextChunkStoreSubject(batchId, i)>
 *       <CIPHERTEXT_CHUNK_PREDICATE>
 *       "<base64(chunk_bytes)>"
 *   }
 */
async function seedChunks(
  store: OxigraphStore,
  opts: {
    canonicalCgId: string;
    batchId: Uint8Array;
    chunks: Uint8Array[];
    /** Optional: omit some indexes to simulate partial loss. */
    skipIndexes?: number[];
  },
): Promise<void> {
  const skip = new Set(opts.skipIndexes ?? []);
  const graph = ciphertextChunkStoreGraph(opts.canonicalCgId);
  const quads: Quad[] = [];
  for (let i = 0; i < opts.chunks.length; i++) {
    if (skip.has(i)) continue;
    quads.push({
      subject: ciphertextChunkStoreSubject(opts.batchId, i),
      predicate: CIPHERTEXT_CHUNK_PREDICATE,
      object: `"${Buffer.from(opts.chunks[i]).toString('base64')}"`,
      graph,
    });
  }
  await store.insert(quads);
}

/**
 * Build a `StorageACKHandlerConfig` with the V2 dependencies wired —
 * `isCgCurated` returning true (V2 is curated-only), no signer-
 * registration gate by default, optional normalizer for the test under
 * scope.
 */
function createV2Config(
  signerWallet: ethers.Wallet,
  overrides: Partial<StorageACKHandlerConfig> = {},
): StorageACKHandlerConfig {
  return {
    nodeRole: 'core',
    nodeIdentityId: 7n,
    signerWallet,
    contextGraphSharedMemoryUri: (cgId: string) => `did:dkg:context-graph:${cgId}/_shared_memory`,
    chainId: TEST_CHAIN_ID,
    kav10Address: TEST_KAV10_ADDR,
    isCgCurated: async () => true,
    ...overrides,
  };
}

const fakePeerId = { toString: () => 'publisher-peer-v2' };

describe('StorageACKHandler V2 chunked ACK — canonical CG keying (#729 Bug 4 regression)', () => {
  let coreWallet: ethers.Wallet;

  afterEach(() => { /* no-op — Oxigraph stores are GC'd with locals. */ });

  it('signs the V2 ACK when chunks are present under canonical(swmGraphId) — happy path with a cleartext CG and canonicalising normalizer', async () => {
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    // Three deterministic chunk payloads (the bytes themselves don't
    // need to be valid AEAD — the V2 verifier only checks the Merkle
    // root over keccak256(ct_i) leaves and the byte-sum.).
    const chunks = [
      new Uint8Array([0x01, 0x11]),
      new Uint8Array([0x02, 0x22, 0x22]),
      new Uint8Array([0x03, 0x33, 0x33, 0x33]),
    ];
    // Use a fake but-realistic V10 KC merkleRoot — only the byte length
    // matters for the subject URI; the value doesn't have to be
    // cryptographically tied to the chunk root.
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-happy-path-batch'));

    // Seed chunks under the CANONICAL graph — the test's normalizer
    // turns the cleartext CG name into a wire-hash form, exactly the
    // production canonicalisation `DKGAgent.gossipWireIdFor` does.
    await seedChunks(store, {
      canonicalCgId: CANONICAL_WIRE_FOR_CLEARTEXT,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: (raw: string) => {
          // Production-shaped normalizer: cleartext → keccak wire hash,
          // anything else (e.g. numeric on-chain ids) → null so the
          // handler widens to a wildcard `GRAPH ?g` scan.
          if (/^[0-9]+$/.test(raw)) return null;
          return CANONICAL_WIRE_FOR_CLEARTEXT;
        },
      }),
      makeEventBus() as any,
    );

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: CLEARTEXT_CG_ID,
      merkleRoot: kcMerkleRoot,
      chunks,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ack.contextGraphId).toBe(NUMERIC_CG_ID);
    const ackRoot = ack.merkleRoot instanceof Uint8Array
      ? ack.merkleRoot
      : new Uint8Array(ack.merkleRoot);
    expect(Buffer.from(ackRoot).equals(Buffer.from(kcMerkleRoot))).toBe(true);
  });

  it('#729 Bug 4 regression: signs the V2 ACK even when swmGraphId is omitted and the normalizer returns null (widens to GRAPH ?g)', async () => {
    // This is the exact failure mode #729 Bug 4 fixed. Pre-fix:
    //   - intent.swmGraphId absent → falls through to cgId (= "42")
    //   - unconditional `gossipWireIdFor("42")` keccak'd the decimal
    //     string instead of recognising it wasn't a cleartext name
    //   - lookup graph = ciphertextChunkStoreGraph(keccak("42"))
    //   - chunks were persisted under the SAME numeric `42` cgId by the
    //     ingest path (which also went through gossipWireIdFor), so
    //     they happen to match — UNTIL one side keccak'd a decimal
    //     string while the other side resolved through the local CG
    //     map. The fix makes the normalizer return `null` for inputs
    //     it can't canonicalise, and the handler widens to `GRAPH ?g`.
    //
    // We exercise the widened-fallback path here: the normalizer
    // returns null, the handler must still find chunks under whatever
    // graph they were persisted to.
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [
      new Uint8Array([0xAA]),
      new Uint8Array([0xBB, 0xCC]),
    ];
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-no-swmgraphid'));

    // Chunks persisted under an arbitrary canonical graph that the
    // normalizer returning `null` cannot reconstruct from the inputs
    // the handler has.
    const persistedUnder = '0x' + ethers.keccak256(ethers.toUtf8Bytes('persisted-elsewhere')).slice(2);
    await seedChunks(store, {
      canonicalCgId: persistedUnder,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: (_raw: string) => null,
      }),
      makeEventBus() as any,
    );

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      // NB: no swmGraphId on the wire — the handler will fall back to
      // cgId for the SWM URI, which is fine for V2 (it doesn't load
      // SWM quads — only the persisted chunks).
      merkleRoot: kcMerkleRoot,
      chunks,
    });

    const response = await handler.handler(intent, fakePeerId);
    const ack = decodeStorageACK(response);

    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ack.contextGraphId).toBe(NUMERIC_CG_ID);
  });

  it('declines V2 ACK requests that still declare a batch-style kaCount > 1', async () => {
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [new Uint8Array([0x44]), new Uint8Array([0x55, 0x66])];
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-batch-ka-count-rejected'));

    await seedChunks(store, {
      canonicalCgId: CANONICAL_WIRE_FOR_CLEARTEXT,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: () => CANONICAL_WIRE_FOR_CLEARTEXT,
      }),
      makeEventBus() as any,
    );

    const ack = decodeStorageACK(await handler.handler(
      buildV2IntentBytes({
        cgId: NUMERIC_CG_ID,
        swmGraphId: CLEARTEXT_CG_ID,
        merkleRoot: kcMerkleRoot,
        chunks,
        kaCount: 2,
      }),
      fakePeerId,
    ));

    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toMatch(/kaCount must be exactly 1/);
  });

  it('falls back to the raw swmGraphId when no normalizer is wired (legacy callers / pre-#729 shim)', async () => {
    // Callers that don't expose `normalizeContextGraphIdForChunkStore`
    // (e.g. older agent fixtures) keep the pre-fix behaviour: use the
    // raw `swmGraphId` literally as the canonical key. That's the
    // explicit shim left in for backwards-compat — confirm it still
    // works so we don't break legacy hosts.
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [new Uint8Array([0xDE, 0xAD]), new Uint8Array([0xBE, 0xEF])];
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-legacy-no-normalizer'));

    const rawSwmGraphId = 'legacy-raw-graph-key';
    await seedChunks(store, {
      canonicalCgId: rawSwmGraphId,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      // No `normalizeContextGraphIdForChunkStore` — the legacy shim
      // path.
      createV2Config(coreWallet),
      makeEventBus() as any,
    );

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: rawSwmGraphId,
      merkleRoot: kcMerkleRoot,
      chunks,
    });

    const ack = decodeStorageACK(await handler.handler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(false);
    expect(ack.contextGraphId).toBe(NUMERIC_CG_ID);
  });

  it('multi-CG isolation: identical (batchId, chunkIndex) under two CGs do not cross-read (PR #715 / ciphertext-chunk-store.ts:28-44)', async () => {
    // Two CGs publish V10 KCs with the SAME `merkleRoot` (batchId is
    // plaintext-derived, so a collision is possible if both CGs
    // happen to bundle identical leaves). The fix is that each CG's
    // chunks live under their own per-CG named graph
    // (`ciphertextChunkStoreGraph(canonical(cgIdA))` vs
    // `(canonical(cgIdB))`). The scoped lookup must only see CG-A's
    // chunks when ACKing for CG-A — otherwise a malicious or
    // colliding CG-B could trick CG-A into ACKing the wrong byte
    // stream.
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    // Same byte length intentionally so the byteSize check (`local
    // chunks sum to N bytes vs publisher claim`) passes identically
    // for both CGs — that way the only thing distinguishing the two
    // cases is the *content* of the chunks, which is what the
    // per-named-graph isolation is supposed to disambiguate.
    const chunksA = [new Uint8Array([0xA1]), new Uint8Array([0xA2, 0xA2])];
    const chunksB = [new Uint8Array([0xB1]), new Uint8Array([0xB2, 0xB2])];
    expect(Buffer.from(chunksA[0])).not.toEqual(Buffer.from(chunksB[0]));

    const rootA = buildCiphertextChunksRoot(chunksA).root;
    const rootB = buildCiphertextChunksRoot(chunksB).root;
    expect(Buffer.from(rootA)).not.toEqual(Buffer.from(rootB));

    // Same batchId for both CGs — the collision scenario.
    const sharedBatchId = ethers.getBytes(ethers.id('v2-multi-cg-collision'));

    const canonicalA = '0x' + ethers.keccak256(ethers.toUtf8Bytes('cg-A')).slice(2);
    const canonicalB = '0x' + ethers.keccak256(ethers.toUtf8Bytes('cg-B')).slice(2);

    await seedChunks(store, { canonicalCgId: canonicalA, batchId: sharedBatchId, chunks: chunksA });
    await seedChunks(store, { canonicalCgId: canonicalB, batchId: sharedBatchId, chunks: chunksB });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: (raw: string) => {
          if (raw === 'cg-A') return canonicalA;
          if (raw === 'cg-B') return canonicalB;
          return null;
        },
      }),
      makeEventBus() as any,
    );

    // Codex review feedback: the original test used the SAME
    // numeric `cgId` for both ACK calls and asserted only
    // (A→accept, A-with-B-claim→decline). Under a buggy `GRAPH ?g`
    // wildcard regression that ignored `swmGraphId` entirely, the
    // `LIMIT 1` could happen to return CG-A's chunks first → ackA
    // still accepts AND the cross-claim still declines (rootB ≠
    // rootA) → the buggy implementation passes silently.
    //
    // Strengthen the test with FOUR assertions covering both CGs
    // symmetrically — a wildcard regression would now have to make
    // both CG-A's and CG-B's lookups return the OTHER CG's chunks
    // depending on which `swmGraphId` was passed, which a
    // non-scoped query cannot do (LIMIT 1 is deterministic for a
    // given store state). Both positive cases (A→chunksA AND
    // B→chunksB succeed) plus the cross-claim declines pin the
    // per-CG scoping unambiguously.
    const intentA_ok = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: 'cg-A',
      merkleRoot: sharedBatchId,
      chunks: chunksA,
    });
    const intentB_ok = buildV2IntentBytes({
      // Distinct on-chain cgId for CG-B reinforces the isolation
      // (production publishers always pair `cgId` with `swmGraphId`
      // 1:1; the test now exercises both pairings).
      cgId: NUMERIC_CG_ID_B,
      swmGraphId: 'cg-B',
      merkleRoot: sharedBatchId,
      chunks: chunksB,
    });

    const ackA = decodeStorageACK(await handler.handler(intentA_ok, fakePeerId));
    expect(isStorageACKDecline(ackA)).toBe(false);
    expect(ackA.contextGraphId).toBe(NUMERIC_CG_ID);

    // Symmetric positive case — under a wildcard-regression bug,
    // this would either accept-the-wrong-chunks (computed root
    // would equal rootA, not rootB → DECLINE) or accept with the
    // wrong chunk content. Pinning a successful ACK here pins
    // proper per-CG scoping.
    const ackB = decodeStorageACK(await handler.handler(intentB_ok, fakePeerId));
    expect(isStorageACKDecline(ackB)).toBe(false);
    expect(ackB.contextGraphId).toBe(NUMERIC_CG_ID_B);

    // ACK for CG-A but claiming CG-B's root — must DECLINE with root
    // mismatch (proves the lookup didn't cross-pull chunksB even
    // though both CGs have chunks under the same batchId).
    const ackACrossClaim = decodeStorageACK(await handler.handler(
      buildV2IntentBytes({
        cgId: NUMERIC_CG_ID,
        swmGraphId: 'cg-A',
        merkleRoot: sharedBatchId,
        chunks: chunksB,
        override: { ciphertextChunksRoot: rootB, ciphertextChunkCount: chunksB.length },
      }),
      fakePeerId,
    ));
    expect(isStorageACKDecline(ackACrossClaim)).toBe(true);
    expect(ackACrossClaim.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CIPHERTEXT_ROOT_MISMATCH);

    // Symmetric cross-claim: ACK for CG-B but claiming CG-A's root —
    // must also decline. Without this, a regression to a wildcard
    // scan could quietly serve CG-A's chunks under a CG-B request.
    const ackBCrossClaim = decodeStorageACK(await handler.handler(
      buildV2IntentBytes({
        cgId: NUMERIC_CG_ID_B,
        swmGraphId: 'cg-B',
        merkleRoot: sharedBatchId,
        chunks: chunksA,
        override: { ciphertextChunksRoot: rootA, ciphertextChunkCount: chunksA.length },
      }),
      fakePeerId,
    ));
    expect(isStorageACKDecline(ackBCrossClaim)).toBe(true);
    expect(ackBCrossClaim.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CIPHERTEXT_ROOT_MISMATCH);
  });

  it('declines with MISSING_CIPHERTEXT_CHUNKS when only some claimed chunks are persisted', async () => {
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [
      new Uint8Array([0x10]),
      new Uint8Array([0x20, 0x20]),
      new Uint8Array([0x30, 0x30, 0x30]),
      new Uint8Array([0x40, 0x40, 0x40, 0x40]),
    ];
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-missing-chunks'));

    // Persist only 0 and 2 — leave 1 and 3 missing. The handler
    // retries for ~10s in production to absorb the SWM ingest race
    // window; for this DETERMINISTIC missing-chunks test there's
    // no race to wait for, so wire the test-only retry knob to
    // collapse the wait budget to 0 retries × 0ms. Codex review
    // feedback on PR #738 — the prior test paid the full ~10s
    // budget on every run, slowing CI and making timing fragile.
    await seedChunks(store, {
      canonicalCgId: CANONICAL_WIRE_FOR_CLEARTEXT,
      batchId: kcMerkleRoot,
      chunks,
      skipIndexes: [1, 3],
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: () => CANONICAL_WIRE_FOR_CLEARTEXT,
        _v2ChunkLookupRetryPolicyForTests: { maxRetries: 0, delayMs: 0 },
      }),
      makeEventBus() as any,
    );

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: CLEARTEXT_CG_ID,
      merkleRoot: kcMerkleRoot,
      chunks,
    });

    const ack = decodeStorageACK(await handler.handler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MISSING_CIPHERTEXT_CHUNKS);
    // The decline message includes the missing indexes so the publisher
    // knows which chunks to re-broadcast on retry.
    expect(ack.declineMessage).toMatch(/missing 2\/4/);
    expect(ack.declineMessage).toMatch(/1,3/);
  });

  it('declines with CIPHERTEXT_ROOT_MISMATCH when all chunks present but the recomputed root differs from the publisher claim', async () => {
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [new Uint8Array([0xC1]), new Uint8Array([0xC2, 0xC2])];
    const { root: trueRoot } = buildCiphertextChunksRoot(chunks);
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-root-mismatch'));

    await seedChunks(store, {
      canonicalCgId: CANONICAL_WIRE_FOR_CLEARTEXT,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: () => CANONICAL_WIRE_FOR_CLEARTEXT,
      }),
      makeEventBus() as any,
    );

    // Lie about the root — flip a bit so it definitely doesn't match.
    const liedRoot = new Uint8Array(trueRoot);
    liedRoot[0] = liedRoot[0] ^ 0xFF;

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: CLEARTEXT_CG_ID,
      merkleRoot: kcMerkleRoot,
      chunks,
      override: { ciphertextChunksRoot: liedRoot },
    });

    const ack = decodeStorageACK(await handler.handler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.CIPHERTEXT_ROOT_MISMATCH);
  });

  it('declines as not-curated when the V2 intent arrives for a CG that the local curation oracle reports as public', async () => {
    // Cures the bypass concern called out in the comment at
    // `storage-ack-handler.ts:284-288`: even if a publisher omits the
    // `isEncryptedPayload` flag on a V2 intent, the V2 path itself
    // gates on `isCgCurated === true` before signing.
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [new Uint8Array([0xFE])];
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-not-curated'));

    await seedChunks(store, {
      canonicalCgId: CANONICAL_WIRE_FOR_CLEARTEXT,
      batchId: kcMerkleRoot,
      chunks,
    });

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        isCgCurated: async () => false, // <-- the relevant override
        normalizeContextGraphIdForChunkStore: () => CANONICAL_WIRE_FOR_CLEARTEXT,
      }),
      makeEventBus() as any,
    );

    const intent = buildV2IntentBytes({
      cgId: NUMERIC_CG_ID,
      swmGraphId: CLEARTEXT_CG_ID,
      merkleRoot: kcMerkleRoot,
      chunks,
    });

    const ack = decodeStorageACK(await handler.handler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.SIGNER_NOT_REGISTERED);
    expect(ack.declineMessage).toMatch(/curated-only|PUBLIC|not curated/i);
  });

  it('declines when V2 intent illegally carries stagingQuads (Bug 4-adjacent: the chunked path forbids inline staging)', async () => {
    coreWallet = ethers.Wallet.createRandom();
    const store = new OxigraphStore();

    const chunks = [new Uint8Array([0xAB])];
    const { root } = buildCiphertextChunksRoot(chunks);
    const kcMerkleRoot = ethers.getBytes(ethers.id('v2-staging-quads-disallowed'));

    const handler = new StorageACKHandler(
      store,
      createV2Config(coreWallet, {
        normalizeContextGraphIdForChunkStore: () => CANONICAL_WIRE_FOR_CLEARTEXT,
      }),
      makeEventBus() as any,
    );

    // Hand-craft the intent to violate the V2 invariant:
    // `ackProtocolVersion: 2` AND non-empty `stagingQuads`.
    const intent = encodePublishIntent({
      merkleRoot: kcMerkleRoot,
      contextGraphId: NUMERIC_CG_ID,
      publisherPeerId: 'publisher-v2',
      publicByteSize: 256,
      isPrivate: false,
      kaCount: 1,
      merkleLeafCount: 2,
      rootEntities: ['urn:a'],
      ackProtocolVersion: ACK_PROTOCOL_VERSION_V2_LU11,
      ciphertextChunksRoot: root,
      ciphertextChunkCount: chunks.length,
      // VIOLATION:
      stagingQuads: new TextEncoder().encode('<urn:s> <urn:p> <urn:o> .'),
    });

    const ack = decodeStorageACK(await handler.handler(intent, fakePeerId));
    expect(isStorageACKDecline(ack)).toBe(true);
    expect(ack.declineCode).toBe(STORAGE_ACK_DECLINE_CODES.MERKLE_MISMATCH_IN_SWM);
    expect(ack.declineMessage).toMatch(/stagingQuads/);
  });
});
