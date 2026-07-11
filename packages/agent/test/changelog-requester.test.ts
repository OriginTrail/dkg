import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  runChangelogSync, planPageApply, type ChangelogSyncDeps,
} from '../src/sync/requester/changelog-sync.js';
import {
  encodeChangelogResponse, decodeChangelogRequest, decodeChangelogResponse,
  type ChangelogDeltaRecord, type ChangelogSyncRequest, type ChangelogSyncResponse,
} from '../src/sync/changelog/wire.js';

const qd = (graph: string, n: number): Quad => ({ subject: `s${n}`, predicate: 'p', object: `o${n}`, graph });

// ── planPageApply (pure verified-apply planner) ─────────────────────────────

/**
 * Build records + the verify-result maps planPageApply consumes. Each spec is a graph
 * with `count` parsed quads of which `verified` survived; a data graph is "paired" iff
 * its `<graph>/_meta` also appears as a spec in the same page.
 */
function buildPage(specs: Array<{ seq: number; graph: string; op?: 'upsert' | 'drop'; count?: number; verified?: number }>) {
  const records: ChangelogDeltaRecord[] = [];
  const verifiedByGraph = new Map<string, Quad[]>();
  const recordQuadCountByGraph = new Map<string, number>();
  const metaGraphsInPage = new Set<string>();
  for (const s of specs) {
    const op = s.op ?? 'upsert';
    if (op === 'drop') { records.push({ seq: s.seq, graph: s.graph, op }); continue; }
    const count = s.count ?? 1;
    const verified = s.verified ?? count;
    records.push({ seq: s.seq, graph: s.graph, op, quads: `nq:${s.graph}` });
    recordQuadCountByGraph.set(s.graph, count);
    verifiedByGraph.set(s.graph, Array.from({ length: verified }, (_, i) => qd(s.graph, i)));
    if (s.graph.endsWith('/_meta')) metaGraphsInPage.add(s.graph);
  }
  return { records, verifiedByGraph, recordQuadCountByGraph, metaGraphsInPage };
}

const plan = (page: ReturnType<typeof buildPage>, extra: { nextSeq: number; priorSeq?: number; isForeign?: (g: string) => boolean }) =>
  planPageApply({
    records: page.records,
    nextSeq: extra.nextSeq,
    priorSeq: extra.priorSeq ?? 0,
    isForeignGraph: extra.isForeign ?? (() => false),
    verifiedByGraph: page.verifiedByGraph,
    recordQuadCountByGraph: page.recordQuadCountByGraph,
    metaGraphsInPage: page.metaGraphsInPage,
  });

const DATA = 'did:dkg:context-graph:cg/context/1';
const META = `${DATA}/_meta`;

describe('planPageApply — verified-apply planner', () => {
  it('applies a paired data+meta page and advances to nextSeq', () => {
    const page = buildPage([
      { seq: 2, graph: DATA, count: 3 },   // data (lower seq — written first)
      { seq: 3, graph: META, count: 1 },   // its sibling meta (verifies the data)
    ]);
    const p = plan(page, { nextSeq: 3 });
    expect(p.deferred).toBe(false);
    expect(p.advanceTo).toBe(3);
    expect(p.applied).toBe(2);
    expect(p.ops.map((o) => o.graph)).toEqual([DATA, META]);
    expect(p.ops[0].quads).toHaveLength(3); // the VERIFIED snapshot
  });

  it('DEFERS orphan data (no sibling meta in page) — cursor stays before it', () => {
    const page = buildPage([{ seq: 5, graph: DATA, count: 3 }]); // data only, meta absent
    const p = plan(page, { nextSeq: 5, priorSeq: 4 });
    expect(p.deferred).toBe(true);
    expect(p.applied).toBe(0);
    expect(p.ops).toHaveLength(0);
    expect(p.advanceTo).toBe(4); // earliestUnresolved(5) - 1, clamped to priorSeq
  });

  it('DEFERS a partially-rejected data graph (not all quads survived verification)', () => {
    const page = buildPage([
      { seq: 2, graph: DATA, count: 3, verified: 2 }, // one KC quad rejected
      { seq: 3, graph: META, count: 1 },
    ]);
    const p = plan(page, { nextSeq: 3 });
    expect(p.deferred).toBe(true);
    expect(p.advanceTo).toBe(1); // stop before the data record at seq 2
    expect(p.ops).toHaveLength(0);
  });

  it('stops at the FIRST unresolved record (contiguous prefix)', () => {
    const G2 = 'did:dkg:context-graph:cg/context/2';
    const page = buildPage([
      { seq: 1, graph: 'did:dkg:context-graph:cg/x', op: 'drop' }, // resolves
      { seq: 4, graph: G2, count: 1 },                              // orphan (no meta) ⇒ defer here
      { seq: 6, graph: DATA, count: 1 },                            // paired, but AFTER the unresolved
      { seq: 7, graph: META, count: 1 },
    ]);
    const p = plan(page, { nextSeq: 7 });
    expect(p.deferred).toBe(true);
    expect(p.ops.map((o) => o.graph)).toEqual(['did:dkg:context-graph:cg/x']); // only the drop before seq 4
    expect(p.advanceTo).toBe(3); // 4 - 1
  });

  it('skips a leaked foreign graph but consumes its seq', () => {
    const page = buildPage([
      { seq: 1, graph: 'urn:dkg:changelog', count: 1 },
      { seq: 2, graph: DATA, count: 1 }, { seq: 3, graph: META, count: 1 },
    ]);
    const p = plan(page, { nextSeq: 3, isForeign: (g) => g.startsWith('urn:dkg:changelog') });
    expect(p.deferred).toBe(false);
    expect(p.ops.map((o) => o.graph)).toEqual([DATA, META]);
    expect(p.advanceTo).toBe(3);
  });

  it('applies drops without pairing', () => {
    const page = buildPage([{ seq: 9, graph: DATA, op: 'drop' }]);
    const p = plan(page, { nextSeq: 9 });
    expect(p.ops).toEqual([{ seq: 9, graph: DATA, op: 'drop', quads: [] }]);
    expect(p.advanceTo).toBe(9);
  });
});

// ── runChangelogSync (transport/cursor loop + resync backstop) ──────────────

function loopHarness(
  responses: ChangelogSyncResponse[],
  applyPage: ChangelogSyncDeps['applyPage'],
) {
  let cursor: { era: string; seq: number } | undefined;
  const requests: ChangelogSyncRequest[] = [];
  let resyncs = 0; let i = 0;
  const deps: ChangelogSyncDeps = {
    contextGraphId: 'cg', limit: 100,
    getCursor: () => cursor,
    setCursor: (era, seq) => { cursor = { era, seq }; },
    send: async (bytes) => {
      requests.push(decodeChangelogRequest(bytes));
      const r = responses[i++];
      if (!r) throw new Error(`scripted responses exhausted at request ${i}`);
      return encodeChangelogResponse(r);
    },
    applyPage,
    runResync: async () => { resyncs += 1; },
    logWarn: () => {},
  };
  return { deps, requests, resyncs: () => resyncs, cursor: () => cursor };
}

const delta = (headSeq: number, nextSeq: number, records: ChangelogDeltaRecord[] = []): ChangelogSyncResponse =>
  ({ kind: 'delta', era: 'e1', headSeq, nextSeq, records });

describe('runChangelogSync — driver loop', () => {
  it('completes when a page resolves through headSeq', async () => {
    const h = loopHarness([delta(3, 3)], async (p) => ({ advanceTo: p.nextSeq, applied: 2, deferred: false }));
    const out = await runChangelogSync(h.deps);
    expect(out).toEqual({ kind: 'delta', applied: 2 });
    expect(h.cursor()).toEqual({ era: 'e1', seq: 3 });
    expect(h.requests[0]).toMatchObject({ sinceSeq: 0, era: null });
  });

  it('loops across pages, threading the cursor via advanceTo', async () => {
    const h = loopHarness(
      [delta(4, 2), delta(4, 4)],
      async (p) => ({ advanceTo: p.nextSeq, applied: 1, deferred: false }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out.applied).toBe(2);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toMatchObject({ sinceSeq: 2 });
    expect(h.cursor()).toEqual({ era: 'e1', seq: 4 });
  });

  it('resync bootstraps and pins the cursor to (era, headSeq)', async () => {
    const h = loopHarness([{ kind: 'resync', era: 'e2', headSeq: 9 }], async () => ({ advanceTo: 0, applied: 0, deferred: false }));
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('resync');
    expect(h.resyncs()).toBe(1);
    expect(h.cursor()).toEqual({ era: 'e2', seq: 9 });
  });

  it('stops on denied without advancing', async () => {
    const h = loopHarness([{ kind: 'denied' }], async () => ({ advanceTo: 5, applied: 1, deferred: false }));
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('denied');
    expect(h.cursor()).toBeUndefined();
  });

  it('falls back to resync after RESYNC_AFTER_STALLED_ROUNDS no-progress rounds', async () => {
    // applyPage always defers with no forward progress (advanceTo == priorSeq).
    const h = loopHarness(
      [delta(9, 9), delta(9, 9), delta(9, 9), delta(9, 9)],
      async (p) => ({ advanceTo: p.priorSeq, applied: 0, deferred: true }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('resync');
    expect(h.resyncs()).toBe(1);
    expect(h.requests.length).toBe(3); // stalls after 3 rounds, then resyncs
    expect(h.cursor()).toEqual({ era: 'e1', seq: 9 });
  });

  it('keeps looping (no resync) while a deferred page still makes forward progress', async () => {
    // Round 1 applies a prefix (advanceTo 2 > prior 0) but defers the rest; round 2 completes.
    const h = loopHarness(
      [delta(4, 4), delta(4, 4)],
      async (p) => p.priorSeq === 0
        ? ({ advanceTo: 2, applied: 1, deferred: true })
        : ({ advanceTo: 4, applied: 1, deferred: false }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('delta');
    expect(h.resyncs()).toBe(0);
    expect(h.requests[1]).toMatchObject({ sinceSeq: 2 });
    expect(h.cursor()).toEqual({ era: 'e1', seq: 4 });
  });
});

// ── decodeChangelogResponse cursor invariants (unchanged wire hardening) ─────

describe('decodeChangelogResponse cursor invariants', () => {
  const bad = (resp: unknown) => encodeChangelogResponse(resp as ChangelogSyncResponse);
  it('rejects nextSeq > headSeq', () => {
    expect(() => decodeChangelogResponse(bad({ kind: 'delta', era: 'e', headSeq: 2, nextSeq: 3, records: [] })))
      .toThrow(/nextSeq 3 > headSeq 2/);
  });
  it('rejects a record seq beyond headSeq', () => {
    expect(() => decodeChangelogResponse(bad({ kind: 'delta', era: 'e', headSeq: 2, nextSeq: 2,
      records: [{ seq: 5, graph: 'g', op: 'drop' }] }))).toThrow(/record seq 5 > headSeq 2/);
  });
  it('rejects non-ascending record seqs', () => {
    expect(() => decodeChangelogResponse(bad({ kind: 'delta', era: 'e', headSeq: 9, nextSeq: 9,
      records: [{ seq: 3, graph: 'a', op: 'drop' }, { seq: 2, graph: 'b', op: 'drop' }] })))
      .toThrow(/not strictly ascending/);
  });
  it('rejects nextSeq below the last emitted record seq', () => {
    expect(() => decodeChangelogResponse(bad({ kind: 'delta', era: 'e', headSeq: 9, nextSeq: 2,
      records: [{ seq: 4, graph: 'a', op: 'drop' }] }))).toThrow(/nextSeq 2 < last record seq 4/);
  });
});
