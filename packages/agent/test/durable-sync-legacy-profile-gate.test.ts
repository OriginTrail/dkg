/**
 * #2052 D-8 — the legacy `agents` gate at the durable-sync ingest seam (plan :924, :1505).
 *
 * These are SEAM tests, not gate tests: `system-record-legacy-gate-v1.test.ts` already
 * pins what the gate decides, and repeating that here would prove the gate twice and the
 * wiring never. What is under test is the composition — that a page really travels through
 * the gate on its way to `storeInsert`, that what the store is offered is the gate's
 * `insert` set rather than the page, and that the accounting describes the former.
 *
 * The REAL gate is used, driven by a fake lookup. A stub gate would let the seam pass
 * while the composition was wrong in any way the stub happened to mirror.
 */
import { describe, expect, it, vi } from 'vitest';
import { SYSTEM_RECORD_V1_JSON_DATATYPE } from '@origintrail-official/dkg-storage/internal/system-record-legacy-gate-read-v1';
import { createOperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

import {
  runDurableSyncDetailed,
  type DurableSyncFetchRequest,
} from '../src/sync/requester/durable-sync.js';
import {
  createLegacyAgentProfileGateV1,
  type LegacyAgentProfileAppliedRootV1,
} from '../src/system-records/legacy-profile-gate-v1.js';
import { createLegacyAgentProfileGateLookupV1 } from '../src/system-records/legacy-profile-gate-lookup-v1.js';
import { uniformDurableSyncBudget } from './durable-sync-test-helpers.js';

const ctx = createOperationContext('sync');
const noop = () => {};

const ROOT = `did:dkg:agent:0x${'1'.repeat(40)}`;
const AGENTS_GRAPH = 'did:dkg:context-graph:agents';

/** An inbound legacy quad: carries the aggregate agents graph. */
function quad(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: AGENTS_GRAPH };
}

/** An applied-projection row as the store really holds it: graphless. */
function projectionRow(subject: string, predicate: string, object: string): Quad {
  return { subject, predicate, object, graph: '' };
}

function fakeLookup(
  records: readonly LegacyAgentProfileAppliedRootV1[],
  projection: readonly Quad[],
) {
  const lookupAppliedRoots = vi.fn(async (roots: readonly string[]) => ({
    records: records.filter((record) => roots.includes(record.root)),
    unclassifiedRoots: [] as readonly string[],
  }));
  const lookupProjectionMembership = vi.fn(async (subjects: readonly string[]) => ({
    rows: projection.filter((row) => subjects.includes(row.subject)),
    truncated: false,
  }));
  return {
    lookup: { projectionGraph: AGENTS_GRAPH, lookupAppliedRoots, lookupProjectionMembership },
    lookupAppliedRoots,
  };
}

/** A quad bound for a context graph that is NOT where the applied projection lives. */
function quadInGraph(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

/**
 * One durable-sync run over one page of already-verified data quads.
 *
 * `inserted` collects every quad the seam actually offered the store, which is the
 * observable the property is stated in terms of.
 */
async function runSeam(
  page: Quad[],
  gate?: ReturnType<typeof createLegacyAgentProfileGateV1>,
  servePhase: 'data' | 'meta' = 'data',
  contextGraphId = 'agents',
  signal?: AbortSignal,
) {
  const inserted: Quad[][] = [];
  let served = false;
  const result = await runDurableSyncDetailed({
    ctx,
    remotePeerId: 'peer',
    contextGraphIds: [contextGraphId],
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 1_000),
    fetchSyncPages: async ({ phase }: DurableSyncFetchRequest) => {
      // Serve the page once on the requested phase, then run dry so the loop terminates.
      const first = phase === servePhase && !served;
      if (first) served = true;
      return {
        quads: first ? page : [],
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: 0,
        checkpointKey: `agents:${phase}`,
        completed: true,
        timedOut: false,
      };
    },
    processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metaQuads.length,
      rejectedKcs: 0,
      emptyResponses: dataQuads.length === 0 && metaQuads.length === 0 ? 1 : 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    storeInsert: async ({ quads }) => {
      inserted.push([...quads]);
    },
    legacyAgentProfileGate: gate,
    signal,
    deleteCheckpoint: noop,
    setCheckpoint: noop,
    logInfo: noop,
    logWarn: noop,
    logDebug: noop,
  });
  return { inserted, offered: inserted.flat(), result };
}

describe('durable-sync legacy agent-profile gate seam (#2052 D-8)', () => {
  // The load-bearing seam test. The page carries two quads whose ONLY difference is
  // whether an applied signed record covers their root, so a seam that forwarded the page
  // unfiltered and a seam that dropped everything both fail: exactly one quad must survive.
  it('offers the store the gate\'s insert set, not the page', async () => {
    const { lookup } = fakeLookup(
      [{ root: ROOT, ownedSubjects: [ROOT] }],
      [projectionRow(ROOT, 'urn:p', 'signed')],
    );
    const conflicting = quad(ROOT, 'urn:p', 'rewritten-by-legacy');
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    const { offered } = await runSeam(
      [conflicting, uncovered],
      createLegacyAgentProfileGateV1(lookup),
    );

    expect(offered).toEqual([uncovered]);
    expect(offered).not.toContainEqual(conflicting);
  });

  // Adopted from review, the seam half of the cancellation finding. The reader half lives
  // in the storage suite; this proves the signal actually REACHES the gate from durable
  // sync. Threading it through production without a test meant a regression calling
  // `filterPage(quads)` would leave every case here green while an aborted sync waited on
  // the gate's store reads.
  //
  // Identity again, not presence: a seam handing the gate SOME signal is not the same as
  // handing it the operation's own.
  it('hands the gate the operation abort signal', async () => {
    const { lookup } = fakeLookup([], []);
    const seen: Array<AbortSignal | undefined> = [];
    const real = createLegacyAgentProfileGateV1(lookup);
    const recording = {
      filterPage: (quads: Quad[], signal?: AbortSignal) => {
        seen.push(signal);
        return real.filterPage(quads, signal);
      },
    } as ReturnType<typeof createLegacyAgentProfileGateV1>;
    const controller = new AbortController();

    await runSeam([quad(ROOT, 'urn:p', 'o')], recording, 'data', 'agents', controller.signal);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });

  // Adopted from review. The gate keeps a quad out of the store TWO ways -- `withheld`
  // (conflict or undecidable) and exact-duplicate DISCARD -- and every seam case here
  // proved only the first. The reviewer's regression is the point: a seam rewritten as
  // `quads.filter((q) => !gated.withheld.includes(q))` passes every other case in this
  // file while forwarding exact duplicates back into the store, re-inserting rows the
  // signed projection already holds.
  //
  // The seam contract is "offer exactly `gated.insert`", and only a duplicate can tell
  // that apart from "offer everything the gate did not withhold".
  it('does not offer an exact duplicate of the signed projection to the store', async () => {
    const { lookup } = fakeLookup(
      [{ root: ROOT, ownedSubjects: [ROOT] }],
      [projectionRow(ROOT, 'urn:p', 'signed')],
    );
    // Byte-for-byte what the projection already holds.
    const duplicate = quad(ROOT, 'urn:p', 'signed');
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    const { offered, result } = await runSeam(
      [duplicate, uncovered],
      createLegacyAgentProfileGateV1(lookup),
    );

    expect(offered).toEqual([uncovered]);
    expect(offered).not.toContainEqual(duplicate);
    // And it must not be counted as progress the store never took.
    expect(result.result.insertedTriples).toBe(1);
  });

  // Adopted from review. Awaiting the gate opens an abort WINDOW: the operation can be
  // cancelled while `filterPage` is in flight, and the post-gate `throwIfOperationAborted`
  // is what stops the page reaching the store afterwards. Every signal case so far proved
  // the signal is HANDED OVER; none proved the guard that acts on it, so deleting that
  // guard left them all green while durable sync wrote quads after cancellation.
  it('does not insert when the operation is aborted while the gate is running', async () => {
    const controller = new AbortController();
    const page = [quad('urn:ordinary-subject', 'urn:p', 'o')];
    // Cancels mid-gate, then returns the page untouched — the gate itself withholds
    // nothing, so only the post-gate abort check can keep this out of the store.
    const aborting = {
      filterPage: async (quads: Quad[]) => {
        controller.abort();
        return {
          insert: quads,
          withheld: [],
          discardedDuplicates: 0,
          conflictedRoots: 0,
          unclassifiedRoots: 0,
          storeRequests: 0,
        };
      },
    } as unknown as ReturnType<typeof createLegacyAgentProfileGateV1>;

    const { offered, result } = await runSeam(page, aborting, 'data', 'agents', controller.signal);

    expect(offered).toEqual([]);
    expect(result.result.insertedTriples).toBe(0);
  });

  // The metadata branch gates through the same helper behind its OWN post-gate abort
  // check, and the case above cannot reach it: served on the data phase, it leaves the
  // meta guard deletable with this file green. Found by auditing the guard's siblings
  // rather than by waiting for the abort window to be re-derived one branch over.
  it('does not insert metadata when the operation is aborted while the gate is running', async () => {
    const controller = new AbortController();
    const page = [quad('urn:ordinary-subject', 'urn:p', 'o')];
    const aborting = {
      filterPage: async (quads: Quad[]) => {
        controller.abort();
        return {
          insert: quads,
          withheld: [],
          discardedDuplicates: 0,
          conflictedRoots: 0,
          unclassifiedRoots: 0,
          storeRequests: 0,
        };
      },
    } as unknown as ReturnType<typeof createLegacyAgentProfileGateV1>;

    const { offered, result } = await runSeam(page, aborting, 'meta', 'agents', controller.signal);

    expect(offered).toEqual([]);
    expect(result.result.insertedMetaTriples).toBe(0);
  });

  // T1, half A — the half that scoping by the page's context-graph id would get WRONG.
  // The page is served under `project-x`, but the quad it carries is bound for the
  // aggregate graph where the applied projection lives, so the collision is real and the
  // quad must be withheld. A lane-scoped gate (`pid === 'agents'`) would insert it, which
  // is failing toward insertion — the direction :1505 forbids.
  it('withholds an aggregate-graph quad even when the page is not the agents lane', async () => {
    const { lookup } = fakeLookup(
      [{ root: ROOT, ownedSubjects: [ROOT] }],
      [projectionRow(ROOT, 'urn:p', 'signed')],
    );
    const conflicting = quad(ROOT, 'urn:p', 'rewritten-by-legacy');
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    const { offered } = await runSeam(
      [conflicting, uncovered],
      createLegacyAgentProfileGateV1(lookup),
      'data',
      'project-x',
    );

    expect(offered).toEqual([uncovered]);
    expect(offered).not.toContainEqual(conflicting);
  });

  // The meta branch is a SECOND insertion path with its own gate call, its own
  // skip-when-empty and its own diagnostic field, and every other test here serves the
  // page on the data phase only. So a regression that reverted `remainingMeta` to
  // `storeInsert({ quads: partitioned.remainingMeta })` would leave this whole file
  // green — the fixture would simply never route a quad through the branch it broke.
  //
  // The count is asserted as well as the offer, because those are two different
  // failures: forwarding the raw page breaks the offer, while gating correctly but
  // still counting `partitioned.remainingMeta.length` would report progress the store
  // never took and no offer-only assertion could see it.
  it('gates the metadata branch, and counts insertedMetaTriples from what was offered', async () => {
    const { lookup } = fakeLookup(
      [{ root: ROOT, ownedSubjects: [ROOT] }],
      [projectionRow(ROOT, 'urn:p', 'signed')],
    );
    const conflicting = quad(ROOT, 'urn:p', 'rewritten-by-legacy');
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    const { offered, result } = await runSeam(
      [conflicting, uncovered],
      createLegacyAgentProfileGateV1(lookup),
      'meta',
    );

    expect(offered).toEqual([uncovered]);
    expect(offered).not.toContainEqual(conflicting);
    expect(result.result.insertedMetaTriples).toBe(1);
  });

  // Without a gate the seam must behave exactly as it did before this slice, because
  // `runDurableSync` is reachable outside this package and the port is optional.
  it('offers the page unchanged when no gate is supplied', async () => {
    const conflicting = quad(ROOT, 'urn:p', 'rewritten-by-legacy');
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    const { offered } = await runSeam([conflicting, uncovered]);

    expect(offered).toEqual([conflicting, uncovered]);
  });

  // The always-wired posture (ruled option A, no config flag) is only defensible if it
  // costs nothing when there is nothing to protect. A page deriving no agent root must
  // issue NO store read at all — not a cheap one.
  it('performs no store read for a page that derives no agent root', async () => {
    const { lookup, lookupAppliedRoots } = fakeLookup([], []);
    const page = [
      quad('urn:ordinary-subject', 'urn:p', 'o'),
      quad('https://example.com/thing', 'urn:p', 'o'),
    ];

    const { offered } = await runSeam(page, createLegacyAgentProfileGateV1(lookup));

    expect(lookupAppliedRoots).not.toHaveBeenCalled();
    expect(offered).toEqual(page);
  });

  // The seam half of the mode counterfactual (the read layer carries the other half in
  // packages/storage). This composes the REAL adapter, the REAL storage reads and the REAL
  // gate over one store, and flips ONLY the mode — so it covers the case a controller-
  // presence inference would have missed: an authoritative projection persisted by an
  // earlier process, on a node whose lane is not currently open.
  describe('end to end, only the mode differs', () => {
    const conflicting = quad(ROOT, 'urn:p', 'rewritten-by-legacy');

    const NETWORK_ID = 'otp:2043';

    /**
     * The claim IRI a correctly-configured adapter actually asks for, RECORDED from a live
     * run rather than restated.
     *
     * This fixture used to echo back whichever claim the query happened to name, so it
     * answered for ANY network identity — an adapter that dropped or hard-coded the wrong
     * one still looked covered, on the path where being wrong means unsigned legacy quads
     * land on top of signed state. Recording the real question keeps the identity
     * load-bearing without restating its derivation: the id is base64url-encoded into the
     * claim subject, and restating that encoding here would just be testing the fixture.
     */
    async function claimAskedFor(networkId: string): Promise<string> {
      const seen: string[] = [];
      const recorder = {
        query: async (sparql: string) => {
          seen.push(sparql);
          return { type: 'bindings' as const, bindings: [] };
        },
      } as never;
      const probe = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: recorder, networkId, mode: 'authoritative',
      }));
      await probe.filterPage([conflicting]);
      return /<([^>]*root:[^>]*)>/.exec(seen[0] ?? '')?.[1] ?? '';
    }

    /** Answers the reserved-state join ONLY for the exact claim it was built for. */
    function storeWithAppliedRecord(claim: string) {
      const query = vi.fn(async (sparql: string) => (
        sparql.includes('?claim ?table')
          ? {
            type: 'bindings' as const,
            bindings: sparql.includes(`<${claim}>`)
              ? [{ claim, table: `"[\\"${ROOT}\\"]"^^<${SYSTEM_RECORD_V1_JSON_DATATYPE}>` }]
              : [],
          }
          : {
            type: 'bindings' as const,
            bindings: [{ s: ROOT, p: 'urn:p', o: '"signed"' }],
          }
      ));
      return { query } as never;
    }

    // The uncovered quad rides along in BOTH runs on purpose. Asserting only that the
    // conflicting quad disappears would also pass if `filterPage` THREW — the per-CG catch
    // would drop the whole page and the page would look withheld. Requiring the uncovered
    // quad to survive means the gate ran to completion and discriminated, so a thrown
    // lookup can no longer wear a withhold's clothes.
    const uncovered = quad('urn:ordinary-subject', 'urn:p', 'o');

    // Adopted from review: the MIDDLE link of the cancellation chain. Durable-sync -> gate
    // is proven at the seam, and reader -> store.query is proven in the storage suite, but
    // the adapter between them is the code this PR adds and nothing covered it.
    //
    // CORRECTED after a second review round: the first version of this case used a store
    // that answered nothing, so `lookupAppliedRoots` found no records, no subjects were
    // collected, and `lookupProjectionMembership` WAS NEVER CALLED. It asserted "every
    // options object carries the signal" over a set of exactly one — proving one link
    // while its name claimed two. The store now returns a covered root AND a projection
    // row, so both adapter calls actually run, and the count is asserted so the case
    // cannot quietly go back to proving half of itself.
    it('forwards the abort signal through the adapter into both store reads', async () => {
      const options: Array<Record<string, unknown>> = [];
      const store = {
        query: async (sparql: string, opts?: Record<string, unknown>) => {
          options.push(opts ?? {});
          if (sparql.includes('?claim ?table')) {
            const claim = /<([^>]*root:[^>]*)>/.exec(sparql)?.[1] ?? '';
            return {
              type: 'bindings' as const,
              bindings: [{ claim, table: `"[\\"${ROOT}\\"]"^^<${SYSTEM_RECORD_V1_JSON_DATATYPE}>` }],
            };
          }
          return { type: 'bindings' as const, bindings: [{ s: ROOT, p: 'urn:p', o: '"signed"' }] };
        },
      } as never;
      const controller = new AbortController();
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store, networkId: NETWORK_ID, mode: 'authoritative',
      }));

      await gate.filterPage([conflicting], controller.signal);

      // BOTH bounded reads must have run — one alone would prove only half the adapter.
      expect(options).toHaveLength(2);
      for (const opts of options) expect(opts.signal).toBe(controller.signal);
    });

    it('withholds the conflicting quad when the projection is authoritative', async () => {
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: storeWithAppliedRecord(await claimAskedFor(NETWORK_ID)),
        networkId: NETWORK_ID,
        mode: 'authoritative',
      }));

      const { offered } = await runSeam([conflicting, uncovered], gate);

      expect(offered).toEqual([uncovered]);
    });

    // The identity half. Same store, same mode, same page — only the adapter's network
    // identity is wrong, so it asks about a claim the store does not hold and the root is
    // uncovered. Without this, an adapter that dropped or hard-coded `networkId` would
    // still pass the case above, and in production would miss applied roots and insert
    // unsigned legacy quads over signed state.
    it('does not cover the root when the adapter carries the wrong network identity', async () => {
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: storeWithAppliedRecord(await claimAskedFor(NETWORK_ID)),
        networkId: 'otp:20430',
        mode: 'authoritative',
      }));

      const { offered } = await runSeam([conflicting, uncovered], gate);

      expect(offered).toEqual([conflicting, uncovered]);
    });

    it('passes the same quad through when the projection is only shadow', async () => {
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: storeWithAppliedRecord(await claimAskedFor(NETWORK_ID)),
        networkId: NETWORK_ID,
        mode: 'shadow',
      }));

      const { offered } = await runSeam([conflicting, uncovered], gate);

      expect(offered).toEqual([conflicting, uncovered]);
    });
  });

  // Withheld quads never reached the store, so counting them as inserted would report
  // progress the store never took.
  it('counts inserted triples from what the store was offered', async () => {
    const { lookup } = fakeLookup(
      [{ root: ROOT, ownedSubjects: [ROOT] }],
      [projectionRow(ROOT, 'urn:p', 'signed')],
    );
    const page = [
      quad(ROOT, 'urn:p', 'rewritten-by-legacy'),
      quad('urn:ordinary-subject', 'urn:p', 'o'),
    ];

    const { offered, result } = await runSeam(page, createLegacyAgentProfileGateV1(lookup));

    expect(offered).toHaveLength(1);
    expect(result.result.insertedTriples).toBe(1);
    expect(result.result.insertedTriples).not.toBe(page.length);
    // The data branch writes TWO counters from the gate's insert set, and the aggregate
    // one alone cannot see a regression in the other: changing only `insertedDataTriples`
    // back to the page length leaves `insertedTriples` correct and this test green. The
    // meta branch already asserts its own counter; this is the matching half.
    expect(result.result.insertedDataTriples).toBe(1);
    expect(result.result.insertedDataTriples).not.toBe(page.length);
  });
});
