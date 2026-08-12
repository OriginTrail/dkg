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
  return { lookup: { lookupAppliedRoots, lookupProjectionMembership }, lookupAppliedRoots };
}

/**
 * One durable-sync run over one page of already-verified data quads.
 *
 * `inserted` collects every quad the seam actually offered the store, which is the
 * observable the property is stated in terms of.
 */
async function runSeam(page: Quad[], gate?: ReturnType<typeof createLegacyAgentProfileGateV1>) {
  const inserted: Quad[][] = [];
  let served = false;
  const result = await runDurableSyncDetailed({
    ctx,
    remotePeerId: 'peer',
    contextGraphIds: ['agents'],
    durableSyncBudget: uniformDurableSyncBudget(() => Date.now() + 1_000),
    fetchSyncPages: async ({ phase }: DurableSyncFetchRequest) => {
      // Serve the page once on the data phase, then run dry so the loop terminates.
      const first = phase === 'data' && !served;
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

  // Without a gate the seam must behave exactly as it did before #53, because
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

    /** Answers the reserved-state join for any claim, and the projection for any subject. */
    function storeWithAppliedRecord() {
      const query = vi.fn(async (sparql: string) => (
        sparql.includes('?claim ?table')
          ? {
            type: 'bindings' as const,
            bindings: [{ claim: /<([^>]*root:[^>]*)>/.exec(sparql)?.[1] ?? '', table: `"[\\"${ROOT}\\"]"^^<urn:json>` }],
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

    it('withholds the conflicting quad when the projection is authoritative', async () => {
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: storeWithAppliedRecord(), networkId: 'otp:2043', mode: 'authoritative',
      }));

      const { offered } = await runSeam([conflicting, uncovered], gate);

      expect(offered).toEqual([uncovered]);
    });

    it('passes the same quad through when the projection is only shadow', async () => {
      const gate = createLegacyAgentProfileGateV1(createLegacyAgentProfileGateLookupV1({
        store: storeWithAppliedRecord(), networkId: 'otp:2043', mode: 'shadow',
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
  });
});
