import { describe, it, expect, afterEach } from 'vitest';
import {
  OxigraphStore,
  loadSelectedSharedMemoryQuads,
  type SwmKaGraphBound,
  type Quad,
} from '@origintrail-official/dkg-storage';
import {
  encodeFinalizationMessage,
  contextGraphWorkspaceGraphUri,
  contextGraphLayerUri,
  MemoryLayer,
  Logger,
  type FinalizationMessageMsg,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { computeFlatKCRootV10 } from '@origintrail-official/dkg-publisher';
import { FinalizationHandler, deriveSwmKaGraphBound } from '../src/finalization-handler.js';
import { packKnowledgeAssetIdFromIdentity } from '../src/ka-identity.js';
import { ethers } from 'ethers';

// #1549 SWM-slice bound (plan 2026-07-10-swm-slice-ka-bound §6, tests T4/T5/T6).
//
// The bound is a PURE ACCELERATOR derived from the finalization message's
// PACKED `startKAId`/`endKAId`. The trap (§3): those are `(author << 96) |
// number`, but the SWM under-graph URI's last segment is only the LOW-96
// per-author number — so a bound must UNPACK before comparing, or every real
// graph is excluded. The bound must also WIDEN to the unbounded read on
// empty-or-mismatch before it defers. The widen is what makes correctness
// independent of INV-1: a bounded miss re-reads exactly what today reads, so
// nothing that today ACCEPTS can now DEFER. T6 pins the mismatch widen and T6b
// the empty widen — each fails if its widen is removed — and T6c pins that a
// widen which still mismatches defers exactly as today, exactly once.

const CG = 'swm-bound-cg';
// Two distinct, checksummed authors (Hardhat #0 / #1). The SWM URI segment is
// written CHECKSUM-cased on purpose so the tests exercise the case-insensitive
// address compare (the bound's `agentAddress` unpacks LOWERcase).
const AUTHOR_A = ethers.getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
const AUTHOR_B = ethers.getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
const AUTHOR_A_LOWER = AUTHOR_A.toLowerCase();

const SLICE = 'agent.finalization.sharedMemorySlice';
const SLICE_BOUNDED = `${SLICE}.bounded`;
const SLICE_WIDENED = `${SLICE}.fallbackUnbounded`;

const swmGraph = (author: string, kaNumber: number): string =>
  contextGraphLayerUri(CG, MemoryLayer.SharedWorkingMemory, author, kaNumber);

const tripleKey = (q: Quad): string => `${q.subject}|${q.predicate}|${q.object}`;
const tripleKeys = (qs: Quad[]): string[] => qs.map(tripleKey).sort();

function makeMsg(overrides: Partial<FinalizationMessageMsg> = {}): FinalizationMessageMsg {
  return {
    ual: 'did:dkg:evm:31337/0xABC/1',
    contextGraphId: CG,
    kcMerkleRoot: new Uint8Array(32),
    txHash: '0x' + 'ab'.repeat(32),
    blockNumber: 100,
    batchId: 1,
    startKAId: 1,
    endKAId: 1,
    publisherAddress: AUTHOR_A,
    rootEntities: ['urn:test:root'],
    timestampMs: Date.now(),
    operationId: 'op-swm-bound',
    ...overrides,
  };
}

/**
 * Wrap `store.query` to record the `source` tag on every issued query. The
 * SWM-slice read tags distinguish the three lanes:
 *   - `${SLICE}`           — no bound was derived (today's unbounded read),
 *   - `${SLICE}.bounded`   — a bound WAS derived; first read is narrowed,
 *   - `${SLICE}.fallbackUnbounded` — the bound widened on empty-or-mismatch.
 */
function captureQuerySources(store: OxigraphStore): string[] {
  const sources: string[] = [];
  const orig = store.query.bind(store);
  store.query = (async (sparql: string, opts?: { source?: string }) => {
    if (opts?.source) sources.push(opts.source);
    return (orig as (s: string, o?: unknown) => unknown)(sparql, opts);
  }) as typeof store.query;
  return sources;
}

/** A minimal chain whose KCCreated event verifies the given finalization. */
function makeVerifyingChain(opts: {
  blockNumber: number;
  txHash: string;
  merkleRoot: Uint8Array;
  publisher: string;
  startKAId: bigint;
  endKAId: bigint;
}): ChainAdapter {
  return {
    chainId: 'evm:31337',
    isV10Ready: () => true,
    listenForEvents: async function* (filter: { eventTypes: string[] }) {
      if (
        !filter.eventTypes.includes('KCCreated') &&
        !filter.eventTypes.includes('KnowledgeBatchCreated')
      ) {
        return;
      }
      yield {
        blockNumber: opts.blockNumber,
        data: {
          txHash: opts.txHash,
          merkleRoot: ethers.hexlify(opts.merkleRoot),
          publisherAddress: opts.publisher,
          startKAId: opts.startKAId.toString(),
          endKAId: opts.endKAId.toString(),
          author: opts.publisher,
          txIndex: 0,
        },
      };
    },
  } as unknown as ChainAdapter;
}

const promotedTo = async (store: OxigraphStore, root: string): Promise<boolean> => {
  const res = await store.query(
    `ASK { GRAPH <did:dkg:context-graph:${CG}> { <${root}> ?p ?o } }`,
  );
  return res.type === 'boolean' && res.value === true;
};

// ─────────────────────────────────────────────────────────────────────────
// T4 — deriveSwmKaGraphBound, tested directly. Every assertion here is about
// arithmetic on the PACKED id, so it must not be inferred from a telemetry tag.
// The one wiring assertion (a derived bound reaches the read as `.bounded`)
// lives in its own test at the bottom.
// ─────────────────────────────────────────────────────────────────────────
describe('deriveSwmKaGraphBound (T4)', () => {
  afterEach(() => {
    delete process.env.DKG_DISABLE_SWM_KA_BOUND;
  });

  const packA = (n: number): bigint =>
    packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber: n });

  it('unpacks a single-KA id to a lowercase author and the LOW-96 number', () => {
    // The trap: `packed` is (author << 96) | 7, a 256-bit value. A bound that
    // compared the URI's low-96 `kaNumber` against `packed` would match nothing.
    const packed = packA(7);
    expect(packed).toBeGreaterThan(2n ** 96n);

    expect(deriveSwmKaGraphBound(packed, packed)).toEqual({
      agentAddress: AUTHOR_A_LOWER,
      startNumber: 7n,
      endNumber: 7n,
    });
  });

  it('spans a same-author batch range', () => {
    expect(deriveSwmKaGraphBound(packA(5), packA(9))).toEqual({
      agentAddress: AUTHOR_A_LOWER,
      startNumber: 5n,
      endNumber: 9n,
    });
  });

  it('does NOT bound a cross-author packed range', () => {
    // start=(B,7) < end=(A,7) numerically, so `start <= end` holds — this
    // exercises the AUTHOR-inequality reject, not the range reject. The low-96
    // numbers wrap independently of the high-160 address, so no single bound
    // can describe this range.
    const start = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_B, kaNumber: 7 });
    const end = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber: 7 });
    expect(start < end).toBe(true);
    expect(deriveSwmKaGraphBound(start, end)).toBeUndefined();
  });

  it('does NOT bound a non-positive or inverted range', () => {
    expect(deriveSwmKaGraphBound(0n, 0n)).toBeUndefined();
    expect(deriveSwmKaGraphBound(packA(9), packA(5))).toBeUndefined();
  });

  it('does NOT bound when the DKG_DISABLE_SWM_KA_BOUND kill-switch is set', () => {
    process.env.DKG_DISABLE_SWM_KA_BOUND = '1';
    expect(deriveSwmKaGraphBound(packA(7), packA(7))).toBeUndefined();
  });

  it('wires a derived bound through to the SWM read (and no bound leaves it plain)', async () => {
    const sliceSourcesFor = async (msg: FinalizationMessageMsg): Promise<string[]> => {
      const store = new OxigraphStore();
      const sources = captureQuerySources(store);
      const handler = new FinalizationHandler(store, undefined);
      await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CG);
      return sources.filter((s) => s.startsWith(SLICE));
    };

    const bounded = await sliceSourcesFor(makeMsg({ startKAId: packA(7), endKAId: packA(7) }));
    expect(bounded).toContain(SLICE_BOUNDED);

    const unbounded = await sliceSourcesFor(makeMsg({ startKAId: 0, endKAId: 0 }));
    expect(unbounded).not.toContain(SLICE_BOUNDED);
    expect(unbounded).toContain(SLICE);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T5b — bounded read ≡ unbounded read when INV-1 holds (all of a root's quads
// live inside the bound). Storage-level: the bound is passed directly, so this
// pins the graph-admission filter. A mis-derived bound (packed-vs-low96, or an
// author-blind range) that dropped the in-range graph would make the two reads
// diverge and fail the equal-key / equal-root assertions.
// ─────────────────────────────────────────────────────────────────────────
describe('bounded SWM read is merkle-equivalent to the unbounded read (T5b)', () => {
  it('returns a key-identical quad set and an equal flat-KC root', async () => {
    const store = new OxigraphStore();
    const bucket = contextGraphWorkspaceGraphUri(CG);
    const root = 'urn:test:t5b:root';
    const genidChild = `${root}/.well-known/genid/child-1`;

    const inRange = swmGraph(AUTHOR_A, 7);
    // Decoys the bound must exclude. They carry OTHER subjects so the root
    // filter alone can't be what excludes them — only the graph-set bound can.
    const sameAuthorOutOfRange = swmGraph(AUTHOR_A, 12);
    const otherAuthorInRange = swmGraph(AUTHOR_B, 7);
    const nonLayer = `${bucket}/not-a-layer`;

    await store.insert([
      // All of root r's quads live in bucket ∪ inRange(AUTHOR_A/7).
      { subject: root, predicate: 'http://schema.org/name', object: '"Alice"', graph: bucket },
      { subject: root, predicate: 'http://schema.org/version', object: '"7"', graph: inRange },
      { subject: genidChild, predicate: 'http://schema.org/value', object: '"child"', graph: inRange },
      // Decoy sibling KAs — must appear in NEITHER read.
      { subject: 'urn:test:t5b:sib-a', predicate: 'http://schema.org/name', object: '"Bob"', graph: sameAuthorOutOfRange },
      { subject: 'urn:test:t5b:sib-b', predicate: 'http://schema.org/name', object: '"Carol"', graph: otherAuthorInRange },
      { subject: 'urn:test:t5b:sib-c', predicate: 'http://schema.org/name', object: '"Dave"', graph: nonLayer },
    ]);

    const bound: SwmKaGraphBound = { agentAddress: AUTHOR_A_LOWER, startNumber: 7n, endNumber: 7n };
    const bounded = await loadSelectedSharedMemoryQuads(store, bucket, { rootEntities: [root] }, { kaGraphBound: bound });
    const unbounded = await loadSelectedSharedMemoryQuads(store, bucket, { rootEntities: [root] });

    // Both reads must return exactly r's three quads (proves the bound did NOT
    // drop the legitimate in-range graph, and DID drop the sibling decoys).
    expect(new Set(tripleKeys(bounded))).toEqual(
      new Set([
        `${genidChild}|http://schema.org/value|"child"`,
        `${root}|http://schema.org/name|"Alice"`,
        `${root}|http://schema.org/version|"7"`,
      ]),
    );
    expect(tripleKeys(bounded)).toEqual(tripleKeys(unbounded));
    expect(ethers.hexlify(computeFlatKCRootV10(bounded, []))).toBe(
      ethers.hexlify(computeFlatKCRootV10(unbounded, [])),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T5 (finalization path) — bounded read alone MATCHES when INV-1 holds, so the
// KA promotes WITHOUT widening. This is the behavioural kill for the §3 trap on
// the finalization side: a bound derived from the PACKED number (instead of the
// low-96) would empty the read of graph #9 and force a `.fallbackUnbounded`
// widen — which this test forbids.
// ─────────────────────────────────────────────────────────────────────────
describe('finalization bounded read alone promotes when INV-1 holds (T5, no widen)', () => {
  afterEach(() => Logger.setSink(null));

  it('promotes from the bounded read with no fallbackUnbounded', async () => {
    const store = new OxigraphStore();
    const kaNumber = 9;
    const root = 'urn:test:t5fin:root';
    const inBound = swmGraph(AUTHOR_A, kaNumber);
    // A sibling decoy that the bound excludes and that is NOT needed for the match.
    const decoy = swmGraph(AUTHOR_A, 12);

    await store.insert([
      { subject: root, predicate: 'http://schema.org/name', object: '"Current"', graph: inBound },
      { subject: root, predicate: 'http://schema.org/version', object: '"9"', graph: inBound },
      { subject: 'urn:test:t5fin:sib', predicate: 'http://schema.org/name', object: '"Ignore"', graph: decoy },
    ]);

    const committedRoot = computeFlatKCRootV10(
      [
        { subject: root, predicate: 'http://schema.org/name', object: '"Current"', graph: '' },
        { subject: root, predicate: 'http://schema.org/version', object: '"9"', graph: '' },
      ],
      [],
    );

    const packed = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber });
    const msg = makeMsg({
      startKAId: packed,
      endKAId: packed,
      kcMerkleRoot: committedRoot,
      rootEntities: [root],
    });

    const logs: string[] = [];
    Logger.setSink((r: LogRecord) => logs.push(r.message));
    const sources = captureQuerySources(store);
    const handler = new FinalizationHandler(
      store,
      makeVerifyingChain({
        blockNumber: 100,
        txHash: msg.txHash,
        merkleRoot: committedRoot,
        publisher: AUTHOR_A,
        startKAId: packed,
        endKAId: packed,
      }),
    );

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CG);

    expect(await promotedTo(store, root)).toBe(true);
    expect(logs.some((m) => m.includes('event=finalization_applied'))).toBe(true);
    const sliceSources = sources.filter((s) => s.startsWith(SLICE));
    expect(sliceSources).toContain(SLICE_BOUNDED);
    // The whole point: the low-96 bound admitted graph #9, so no widen fired.
    expect(sliceSources).not.toContain(SLICE_WIDENED);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// T6 — recurrence widen / liveness. A root recurs across per-KA graphs: its
// committed quads span graph #5 (residual, out of bound) AND graph #9 (current,
// in bound). The on-chain root is over bucket ∪ #5 ∪ #9. Driving finalization
// for kaId=pack(author,9): the bounded read (#9 only) MISMATCHES, the widen
// fires, and the KA materialises in the SAME tick with NO merkle-mismatch
// record. A bound-WITHOUT-widen implementation would record
// `finalization_merkle_mismatch` and never promote — so both the promoted
// assertion and the no-mismatch assertion below would fail against it.
// ─────────────────────────────────────────────────────────────────────────
describe('finalization widens on recurrence mismatch and stays live (T6)', () => {
  afterEach(() => Logger.setSink(null));

  it('bounded read mismatches, widen fires, KA materialises with no mismatch record', async () => {
    const store = new OxigraphStore();
    const root = 'urn:test:t6:root';
    const residual = swmGraph(AUTHOR_A, 5); // earlier publish under an older kaId — lingers
    const current = swmGraph(AUTHOR_A, 9); // this finalization's kaId

    await store.insert([
      { subject: root, predicate: 'http://schema.org/legacyName', object: '"V1"', graph: residual },
      { subject: root, predicate: 'http://schema.org/name', object: '"V2"', graph: current },
      { subject: root, predicate: 'http://schema.org/version', object: '"9"', graph: current },
    ]);

    // On-chain root is committed over the UNION #5 ∪ #9 (the publisher's read is
    // unbounded), so a tight [9,9] bounded read is a strict subset → mismatch.
    const committedRoot = computeFlatKCRootV10(
      [
        { subject: root, predicate: 'http://schema.org/legacyName', object: '"V1"', graph: '' },
        { subject: root, predicate: 'http://schema.org/name', object: '"V2"', graph: '' },
        { subject: root, predicate: 'http://schema.org/version', object: '"9"', graph: '' },
      ],
      [],
    );

    const packed = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber: 9 });
    const msg = makeMsg({
      startKAId: packed,
      endKAId: packed,
      kcMerkleRoot: committedRoot,
      rootEntities: [root],
    });

    const logs: string[] = [];
    Logger.setSink((r: LogRecord) => logs.push(r.message));
    const sources = captureQuerySources(store);
    const handler = new FinalizationHandler(
      store,
      makeVerifyingChain({
        blockNumber: 100,
        txHash: msg.txHash,
        merkleRoot: committedRoot,
        publisher: AUTHOR_A,
        startKAId: packed,
        endKAId: packed,
      }),
    );

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CG);

    // Liveness: the KA materialised to VM in this same tick.
    expect(await promotedTo(store, root)).toBe(true);
    expect(logs.some((m) => m.includes('event=finalization_applied'))).toBe(true);
    // No false mismatch was recorded (the widen absorbed the recurrence).
    expect(logs.some((m) => m.includes('event=finalization_merkle_mismatch'))).toBe(false);

    const sliceSources = sources.filter((s) => s.startsWith(SLICE));
    expect(sliceSources).toContain(SLICE_BOUNDED);
    expect(sliceSources).toContain(SLICE_WIDENED);
  });
});

describe('finalization widens on an empty bounded read and stays live (T6b)', () => {
  afterEach(() => Logger.setSink(null));

  // The bound is derived from `unpack(kaId).agentAddress`, but the share was
  // stored under the graph the SENDER chose. When those disagree — a remap, or a
  // PCA publish where the operational wallet packed into `kaId` is not the graph's
  // author — the bounded read comes back EMPTY even though the data is resident.
  // Without the empty widen this records `finalization_no_data` and the KA never
  // materialises, though an unbounded read would have promoted it.
  it('empty bounded read widens, finds the out-of-range graph, and promotes', async () => {
    const store = new OxigraphStore();
    const root = 'urn:test:t6b:root';
    const stored = swmGraph(AUTHOR_A, 5); // the share actually landed here
    const quads: Quad[] = [
      { subject: root, predicate: 'http://schema.org/name', object: '"only-copy"', graph: stored },
      { subject: root, predicate: 'http://schema.org/version', object: '"5"', graph: stored },
    ];
    await store.insert(quads);

    // The publisher hashed exactly these quads, so the unbounded read MATCHES.
    const committedRoot = computeFlatKCRootV10(
      quads.map((q) => ({ ...q, graph: '' })),
      [],
    );

    // ...but finalization arrives keyed to kaNumber 9, so the bound is [9,9] and
    // excludes the only graph holding the root.
    const packed = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber: 9 });
    const msg = makeMsg({
      startKAId: packed,
      endKAId: packed,
      kcMerkleRoot: committedRoot,
      rootEntities: [root],
    });

    const logs: string[] = [];
    Logger.setSink((r: LogRecord) => logs.push(r.message));
    const sources = captureQuerySources(store);
    const handler = new FinalizationHandler(
      store,
      makeVerifyingChain({
        blockNumber: 100,
        txHash: msg.txHash,
        merkleRoot: committedRoot,
        publisher: AUTHOR_A,
        startKAId: packed,
        endKAId: packed,
      }),
    );

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CG);

    expect(await promotedTo(store, root)).toBe(true);
    expect(logs.some((m) => m.includes('event=finalization_applied'))).toBe(true);
    // The empty bounded read must NOT be reported as "no data".
    expect(logs.some((m) => m.includes('event=finalization_no_data'))).toBe(false);

    const sliceSources = sources.filter((s) => s.startsWith(SLICE));
    expect(sliceSources).toContain(SLICE_BOUNDED);
    expect(sliceSources).toContain(SLICE_WIDENED);
  });
});

describe('a widen that still mismatches defers exactly as today (T6c)', () => {
  afterEach(() => Logger.setSink(null));

  // The bound must not change the mismatch outcome, only reach it later. This also
  // pins that the widen fires at most ONCE: the empty-widen and the mismatch-widen
  // are mutually exclusive via `widenedToUnbounded`.
  it('records finalization_merkle_mismatch, does not promote, and widens exactly once', async () => {
    const store = new OxigraphStore();
    const root = 'urn:test:t6c:root';
    await store.insert([
      { subject: root, predicate: 'http://schema.org/name', object: '"data"', graph: swmGraph(AUTHOR_A, 9) },
    ]);

    // A root the resident quads cannot hash to, so bounded AND unbounded both miss.
    const wrongRoot = new Uint8Array(32).fill(7);
    const packed = packKnowledgeAssetIdFromIdentity({ agentAddress: AUTHOR_A, kaNumber: 9 });
    const msg = makeMsg({
      startKAId: packed,
      endKAId: packed,
      kcMerkleRoot: wrongRoot,
      rootEntities: [root],
    });

    const logs: string[] = [];
    Logger.setSink((r: LogRecord) => logs.push(r.message));
    const sources = captureQuerySources(store);
    const handler = new FinalizationHandler(
      store,
      makeVerifyingChain({
        blockNumber: 100,
        txHash: msg.txHash,
        merkleRoot: wrongRoot,
        publisher: AUTHOR_A,
        startKAId: packed,
        endKAId: packed,
      }),
    );

    await handler.handleFinalizationMessage(encodeFinalizationMessage(msg), CG);

    expect(await promotedTo(store, root)).toBe(false);
    expect(logs.some((m) => m.includes('event=finalization_merkle_mismatch'))).toBe(true);
    expect(logs.some((m) => m.includes('event=finalization_applied'))).toBe(false);
    // Bounded read, then exactly one widen — never two.
    const sliceSources = sources.filter((s) => s.startsWith(SLICE));
    expect(sliceSources).toContain(SLICE_BOUNDED);
    expect(sliceSources.filter((s) => s === SLICE_WIDENED)).toHaveLength(1);
  });
});
