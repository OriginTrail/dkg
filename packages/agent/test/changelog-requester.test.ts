import { describe, expect, it } from 'vitest';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  runChangelogSync, planPageApply, type ChangelogSyncDeps, type ResyncOutcome,
} from '../src/sync/requester/changelog-sync.js';
import {
  encodeChangelogResponse, decodeChangelogRequest, decodeChangelogResponse,
  type ChangelogDeltaRecord, type ChangelogSyncRequest, type ChangelogSyncResponse,
} from '../src/sync/changelog/wire.js';
import {
  DURABLE_INTEGRITY_META_PREDICATES,
  classifyDurableMetaGraph,
} from '../src/sync/durable-integrity.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const qd = (graph: string, n: number): Quad => ({ subject: `s${n}`, predicate: 'p', object: `o${n}`, graph });

// ── planPageApply (pure verified-apply planner) ─────────────────────────────

/**
 * Build records + the verify maps planPageApply consumes. Each spec is a graph with `count`
 * parsed quads of which `verified` survived; a meta graph is added to metaGraphsWithRoot
 * unless `noRoot` (a rootless meta cannot bind data).
 */
function buildPage(specs: Array<{
  seq: number;
  graph: string;
  op?: 'upsert' | 'drop';
  count?: number;
  verified?: number;
  noRoot?: boolean;
  parsedQuads?: Quad[];
}>) {
  const records: ChangelogDeltaRecord[] = [];
  const verifiedByGraph = new Map<string, Quad[]>();
  const recordQuadCountByGraph = new Map<string, number>();
  const metaGraphsWithRoot = new Set<string>();
  for (const s of specs) {
    const op = s.op ?? 'upsert';
    if (op === 'drop') { records.push({ seq: s.seq, graph: s.graph, op }); continue; }
    const count = s.count ?? s.parsedQuads?.length ?? 1;
    const verified = s.verified ?? count;
    records.push({ seq: s.seq, graph: s.graph, op, quads: `nq:${s.graph}` });
    recordQuadCountByGraph.set(s.graph, count);
    const recordQuads = s.parsedQuads ?? Array.from({ length: count }, (_, i) => qd(s.graph, i));
    verifiedByGraph.set(s.graph, recordQuads.slice(0, verified));
    if (s.graph.endsWith('/_meta')) {
      if (s.parsedQuads) {
        if (classifyDurableMetaGraph(s.parsedQuads).hasMerkleRoot) metaGraphsWithRoot.add(s.graph);
      } else if (!s.noRoot) {
        metaGraphsWithRoot.add(s.graph);
      }
    }
  }
  return {
    records,
    verifiedByGraph,
    recordQuadCountByGraph,
    metaGraphsWithRoot,
  };
}

const plan = (page: ReturnType<typeof buildPage>, extra: {
  nextSeq: number;
  priorSeq?: number;
  isForeign?: (g: string) => boolean;
  batchClean?: boolean;
  verifiedGraphScopedDataGraphs?: Set<string>;
}) =>
  planPageApply({
    records: page.records,
    nextSeq: extra.nextSeq,
    priorSeq: extra.priorSeq ?? 0,
    isForeignGraph: extra.isForeign ?? (() => false),
    verifiedByGraph: page.verifiedByGraph,
    recordQuadCountByGraph: page.recordQuadCountByGraph,
    metaGraphsWithRoot: page.metaGraphsWithRoot,
    verifiedGraphScopedDataGraphs: extra.verifiedGraphScopedDataGraphs ?? new Set(),
    batchVerifiedCleanly: extra.batchClean ?? true,
  });

const DATA = 'did:dkg:context-graph:cg/context/1';
const META = `${DATA}/_meta`;

describe('planPageApply — verified-apply planner', () => {
  it('defers a paired data+meta page instead of whole-replacing shared metadata', () => {
    const page = buildPage([
      { seq: 2, graph: DATA, count: 3 },
      { seq: 3, graph: META, count: 1 },
    ]);
    const p = plan(page, { nextSeq: 3 });
    expect(p).toMatchObject({ deferred: true, advanceTo: 1, applied: 0 });
    expect(p.ops).toEqual([]);
  });

  it('DEFERS orphan data (no sibling meta in page)', () => {
    const page = buildPage([{ seq: 5, graph: DATA, count: 3 }]);
    const p = plan(page, { nextSeq: 5, priorSeq: 4 });
    expect(p.deferred).toBe(true);
    expect(p.applied).toBe(0);
    expect(p.advanceTo).toBe(4);
  });

  it('DEFERS when the batch did not verify cleanly (a KC was rejected)', () => {
    const page = buildPage([{ seq: 2, graph: DATA, count: 3 }, { seq: 3, graph: META, count: 1 }]);
    const p = plan(page, { nextSeq: 3, batchClean: false });
    expect(p.deferred).toBe(true);
    expect(p.ops).toHaveLength(0);
    expect(p.advanceTo).toBe(1);
  });

  it('does not replace a merkle-bearing meta graph with a rejected partial subset', () => {
    const page = buildPage([
      { seq: 2, graph: META, count: 4, verified: 3 },
      { seq: 3, graph: DATA, count: 3 },
    ]);
    const p = plan(page, { nextSeq: 3, priorSeq: 1, batchClean: false });
    expect(p.deferred).toBe(true);
    expect(p.ops).toEqual([]);
    expect(p.advanceTo).toBe(1);
  });

  it('defers a fully verified metadata subset because omitted live KAs are not provable', () => {
    const page = buildPage([{ seq: 8, graph: META, count: 4, verified: 4 }]);

    const p = plan(page, { nextSeq: 8, priorSeq: 7, batchClean: true });

    expect(p).toMatchObject({ deferred: true, advanceTo: 7, applied: 0 });
    expect(p.ops).toEqual([]);
  });

  it.each(DURABLE_INTEGRITY_META_PREDICATES.filter(
    (predicate) => predicate !== 'http://dkg.io/ontology/merkleRoot',
  ))('does not acknowledge rejected V2 metadata containing %s without a merkle root', (predicate) => {
    const topMeta = 'did:dkg:context-graph:cg/_meta';
    const subject = 'did:dkg:31337/0x00000000000000000000000000000000000000aa/7';
    const page = buildPage([
      {
        seq: 7,
        graph: topMeta,
        verified: 0,
        parsedQuads: [{
          subject,
          predicate,
          object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>',
          graph: topMeta,
        }],
      },
    ]);
    const p = plan(page, { nextSeq: 7, priorSeq: 6, batchClean: false });
    expect(p.deferred).toBe(true);
    expect(p.ops).toEqual([]);
    expect(p.advanceTo).toBe(6);
  });

  it('defers duplicate graph records before an empty tail can hide non-empty metadata', () => {
    const graph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/8';
    const page = buildPage([
      { seq: 1, graph, count: 1 },
      { seq: 2, graph: META, count: 2, verified: 2 },
      { seq: 3, graph: META, count: 0, verified: 0 },
    ]);

    const p = plan(page, {
      nextSeq: 3,
      verifiedGraphScopedDataGraphs: new Set([graph]),
    });

    expect(p).toMatchObject({ deferred: true, advanceTo: 0, applied: 0 });
    expect(p.ops).toEqual([]);
  });

  it.each(DURABLE_INTEGRITY_META_PREDICATES)(
    'classifies %s as part of the durable integrity envelope',
    (predicate) => {
      expect(classifyDurableMetaGraph([{
        subject: 'did:dkg:31337/0x00000000000000000000000000000000000000aa/7',
        predicate,
        object: '"value"',
        graph: 'urn:meta',
      }]).hasIntegrityEnvelope).toBe(true);
    },
  );

  it('classifies ordinary CG metadata as non-integrity configuration', () => {
    const topMeta = 'did:dkg:context-graph:cg/_meta';
    expect(classifyDurableMetaGraph([{
      subject: 'did:dkg:context-graph:cg',
      predicate: 'http://schema.org/name',
      object: '"Context graph"',
      graph: topMeta,
    }])).toEqual({ hasMerkleRoot: false, hasIntegrityEnvelope: false });
  });

  it('defers rootless data paired with a whole shared metadata snapshot', () => {
    const graph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/7';
    const topMeta = 'did:dkg:context-graph:cg/_meta';
    const page = buildPage([
      { seq: 2, graph, count: 3 },
      { seq: 3, graph: topMeta, count: 9 },
    ]);
    const p = plan(page, {
      nextSeq: 3,
      verifiedGraphScopedDataGraphs: new Set([graph]),
    });
    expect(p).toMatchObject({ deferred: true, advanceTo: 1, applied: 0 });
    expect(p.ops).toEqual([]);
  });

  it('DEFERS when the sibling meta carries no merkle root (rootless meta cannot bind data)', () => {
    const page = buildPage([{ seq: 2, graph: DATA, count: 3 }, { seq: 3, graph: META, count: 1, noRoot: true }]);
    const p = plan(page, { nextSeq: 3 });
    expect(p.deferred).toBe(true);
    expect(p.ops).toHaveLength(0);
  });

  it('does not acknowledge rejected V2 metadata whose Merkle root is missing', () => {
    const topMeta = 'did:dkg:context-graph:cg/_meta';
    const page = buildPage([{
      seq: 8,
      graph: topMeta,
      count: 8,
      verified: 0,
      noRoot: true,
    }]);

    const p = plan(page, { nextSeq: 8, priorSeq: 7, batchClean: false });

    expect(p).toMatchObject({ deferred: true, advanceTo: 7, applied: 0 });
    expect(p.ops).toEqual([]);
  });

  it('DEFERS a partially-rejected data graph (not all quads survived)', () => {
    const page = buildPage([{ seq: 2, graph: DATA, count: 3, verified: 2 }, { seq: 3, graph: META, count: 1 }]);
    const p = plan(page, { nextSeq: 3 });
    expect(p.deferred).toBe(true);
    expect(p.advanceTo).toBe(1);
  });

  it('an EMPTY-content upsert is a resolved NO-OP — never a delete (regression: silent hard-delete)', () => {
    // Data + meta records that both parsed to ZERO quads (empty/malformed page).
    const page = buildPage([{ seq: 4, graph: DATA, count: 0 }, { seq: 5, graph: META, count: 0 }]);
    const p = plan(page, { nextSeq: 5 });
    expect(p.deferred).toBe(false);   // consumed, not stalled
    expect(p.ops).toHaveLength(0);    // NO dropGraph op emitted → no deletion
    expect(p.advanceTo).toBe(5);
  });

  it('stops at the FIRST unresolved record (contiguous prefix)', () => {
    const G2 = 'did:dkg:context-graph:cg/context/2';
    const FIRST_DATA = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/1';
    const page = buildPage([
      { seq: 1, graph: FIRST_DATA, count: 1 },
      { seq: 4, graph: G2, count: 1 },          // orphan (no meta) ⇒ defer here
      { seq: 6, graph: DATA, count: 1 },
    ]);
    const p = plan(page, {
      nextSeq: 7,
      verifiedGraphScopedDataGraphs: new Set([FIRST_DATA]),
    });
    expect(p.deferred).toBe(true);
    expect(p.ops.map((o) => o.graph)).toEqual([FIRST_DATA]);
    expect(p.advanceTo).toBe(3);
  });

  it('skips a leaked foreign graph but consumes its seq', () => {
    const graph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/2';
    const page = buildPage([
      { seq: 1, graph: 'urn:dkg:changelog', count: 1 },
      { seq: 2, graph, count: 1 },
    ]);
    const p = plan(page, {
      nextSeq: 2,
      isForeign: (g) => g.startsWith('urn:dkg:changelog'),
      verifiedGraphScopedDataGraphs: new Set([graph]),
    });
    expect(p.deferred).toBe(false);
    expect(p.ops.map((o) => o.graph)).toEqual([graph]);
    expect(p.advanceTo).toBe(2);
  });

  it.each([
    ['live V2 assertion graph', DATA],
    ['top-level metadata graph', 'did:dkg:context-graph:cg/_meta'],
  ])('DEFERS an unauthenticated drop of a %s', (_label, graph) => {
    const page = buildPage([{ seq: 9, graph, op: 'drop' }]);
    const p = plan(page, { nextSeq: 9, priorSeq: 8 });

    expect(p.ops).toEqual([]);
    expect(p.deferred).toBe(true);
    expect(p.advanceTo).toBe(8);
  });

  it('DEFERS markerless metadata so it cannot erase live KA descriptors by replacement', () => {
    // A non-empty markerless snapshot can look like harmless CG config while
    // omitting every live KA descriptor. Replacing the shared graph would be
    // an unauthenticated bulk delete.
    const TOP_META = 'did:dkg:context-graph:cg/_meta';
    const page = buildPage([{ seq: 7, graph: TOP_META, count: 2, noRoot: true }]);
    const p = plan(page, { nextSeq: 7, priorSeq: 6 });

    expect(p).toMatchObject({ deferred: true, advanceTo: 6, applied: 0 });
    expect(p.ops).toEqual([]);
  });
});

// ── runChangelogSync (transport/cursor loop + resync backstop) ──────────────

function loopHarness(
  responses: ChangelogSyncResponse[],
  applyPage: ChangelogSyncDeps['applyPage'],
  resync: () => Promise<ResyncOutcome> = async () => ({ complete: true, insertedTriples: 0 }),
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
    runResync: async () => { resyncs += 1; return resync(); },
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
  });

  it('loops across pages, threading the cursor via advanceTo', async () => {
    const h = loopHarness([delta(4, 2), delta(4, 4)], async (p) => ({ advanceTo: p.nextSeq, applied: 1, deferred: false }));
    const out = await runChangelogSync(h.deps);
    expect(out.applied).toBe(2);
    expect(h.requests[1]).toMatchObject({ sinceSeq: 2 });
    expect(h.cursor()).toEqual({ era: 'e1', seq: 4 });
  });

  it('resync: COMPLETE bootstrap advances the cursor to headSeq and folds inserts', async () => {
    const h = loopHarness(
      [{ kind: 'resync', era: 'e2', headSeq: 9 }],
      async () => ({ advanceTo: 0, applied: 0, deferred: false }),
      async () => ({ complete: true, insertedTriples: 42 }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out).toEqual({ kind: 'resync', applied: 42, complete: true });
    expect(h.resyncs()).toBe(1);
    expect(h.cursor()).toEqual({ era: 'e2', seq: 9 });
  });

  it('resync: PARTIAL bootstrap does NOT advance the cursor (no gap below headSeq)', async () => {
    const h = loopHarness(
      [{ kind: 'resync', era: 'e2', headSeq: 9 }],
      async () => ({ advanceTo: 0, applied: 0, deferred: false }),
      async () => ({ complete: false, insertedTriples: 5 }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out).toEqual({ kind: 'resync', applied: 5, complete: false });
    expect(h.cursor()).toBeUndefined(); // cursor left untouched — next cycle retries the resync
  });

  it('stops on denied without advancing', async () => {
    const h = loopHarness([{ kind: 'denied' }], async () => ({ advanceTo: 5, applied: 1, deferred: false }));
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('denied');
    expect(h.cursor()).toBeUndefined();
  });

  it('falls back to resync after RESYNC_AFTER_STALLED_ROUNDS no-progress rounds', async () => {
    const h = loopHarness(
      [delta(9, 9), delta(9, 9), delta(9, 9), delta(9, 9)],
      async (p) => ({ advanceTo: p.priorSeq, applied: 0, deferred: true }),
      async () => ({ complete: true, insertedTriples: 0 }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('resync');
    expect(h.resyncs()).toBe(1);
    expect(h.requests.length).toBe(3);
    expect(h.cursor()).toEqual({ era: 'e1', seq: 9 });
  });

  it('keeps looping (no resync) while a deferred page still makes forward progress', async () => {
    const h = loopHarness(
      [delta(4, 4), delta(4, 4)],
      async (p) => p.priorSeq === 0
        ? ({ advanceTo: 2, applied: 1, deferred: true })
        : ({ advanceTo: 4, applied: 1, deferred: false }),
    );
    const out = await runChangelogSync(h.deps);
    expect(out.kind).toBe('delta');
    expect(h.resyncs()).toBe(0);
    expect(h.cursor()).toEqual({ era: 'e1', seq: 4 });
  });
});

describe('changelog drop resync reconciliation', () => {
  it('removes only graphs absent from the complete verified snapshot before advancing the cursor', async () => {
    const presentGraph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/8';
    const staleGraph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/9';
    const response = encodeChangelogResponse(delta(9, 9, [
      { seq: 8, graph: presentGraph, op: 'drop' },
      { seq: 9, graph: staleGraph, op: 'drop' },
    ]));
    let cursor: { era: string; seq: number } | undefined;
    const dropped: string[] = [];
    const forceFreshSessionFlags: boolean[] = [];
    const agent = {
      config: { syncAgentsMeta: true },
      changelogCursors: {
        get: () => cursor,
        set: (_peer: string, _cg: string, era: string, seq: number) => { cursor = { era, seq }; },
      },
      messenger: { sendToPeer: async () => response },
      node: { stopSignal: null },
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
        _graphUri: string,
        _deadline: number,
        _snapshotRef?: string,
        _sinceBatchId?: string,
        _signal?: AbortSignal,
        _recovery?: boolean,
        forceFreshSession?: boolean,
      ) => {
        forceFreshSessionFlags.push(forceFreshSession === true);
        return {
          quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 0,
          checkpointKey: `${contextGraphId}:${phase}`, completed: true, timedOut: false,
        };
      },
      syncCheckpoints: new Map(),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      getOrCreateSyncVerifyWorker: () => ({
        parseAndFilter: async () => ({ quads: [] }),
      }),
      processDurableBatchInWorker: async (
        _data: Quad[], _meta: Quad[], _ctx: unknown, _accept: boolean,
        mode: { kind: string },
      ) => mode.kind === 'fullSnapshot'
        ? {
            verifiedData: [qd(presentGraph, 1)], verifiedMeta: [],
            verifiedGraphScopedDataGraphs: [], totalFetchedDataQuads: 1,
            totalFetchedMetaQuads: 0, rejectedKcs: 0, emptyResponses: 0,
            metaOnlyResponses: 0, verifiedPrivateOnlyResponses: 0,
            dataRejectedMissingMeta: 0,
          }
        : {
            verifiedData: [], verifiedMeta: [], verifiedGraphScopedDataGraphs: [],
            totalFetchedDataQuads: 0, totalFetchedMetaQuads: 0, rejectedKcs: 0,
            emptyResponses: 1, metaOnlyResponses: 0, verifiedPrivateOnlyResponses: 0,
            dataRejectedMissingMeta: 0,
          },
      runLegacyDurableSyncForContextGraph:
        LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph,
      resolveCuratorPeerIdsForCg: async () => ({
        peerIds: ['peer'], curatorIsLocal: false, legacyTripleResolved: false,
      }),
      store: { dropGraph: async (graph: string) => { dropped.push(graph); } },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    await (LifecycleSyncMethods.prototype.runChangelogSyncForCg as any).call(
      agent,
      { kind: 'system', id: 'test', startedAt: 0 },
      'peer',
      'cg',
    );

    expect(dropped).toEqual([staleGraph]);
    expect(forceFreshSessionFlags).toEqual([true, true]);
    expect(cursor).toEqual({ era: 'e1', seq: 9 });
  });

  it('keeps the graph and cursor pending when the responder is not the unique structural curator', async () => {
    const staleGraph = 'did:dkg:context-graph:cg/_verifiable_memory/0xabc/9';
    const response = encodeChangelogResponse(delta(9, 9, [
      { seq: 9, graph: staleGraph, op: 'drop' },
    ]));
    let cursor: { era: string; seq: number } | undefined;
    const dropped: string[] = [];
    const forceFreshSessionFlags: boolean[] = [];
    const agent = {
      config: { syncAgentsMeta: true },
      changelogCursors: {
        get: () => cursor,
        set: (_peer: string, _cg: string, era: string, seq: number) => { cursor = { era, seq }; },
      },
      messenger: { sendToPeer: async () => response },
      node: { stopSignal: null },
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
        _graphUri: string,
        _deadline: number,
        _snapshotRef?: string,
        _sinceBatchId?: string,
        _signal?: AbortSignal,
        _recovery?: boolean,
        forceFreshSession?: boolean,
      ) => {
        forceFreshSessionFlags.push(forceFreshSession === true);
        return {
          quads: [], bytesReceived: 0, resumedFromOffset: 0, nextOffset: 1,
          checkpointKey: `${contextGraphId}:${phase}`, completed: true, timedOut: false,
        };
      },
      syncCheckpoints: new Map(),
      insertSyncedQuadsAndInvalidateListCache: async () => {},
      getOrCreateSyncVerifyWorker: () => ({ parseAndFilter: async () => ({ quads: [] }) }),
      processDurableBatchInWorker: async () => ({
        verifiedData: [qd('did:dkg:context-graph:cg/_verifiable_memory/0xabc/8', 1)],
        verifiedMeta: [], verifiedGraphScopedDataGraphs: [],
        totalFetchedDataQuads: 1, totalFetchedMetaQuads: 0, rejectedKcs: 0,
        emptyResponses: 0, metaOnlyResponses: 0, verifiedPrivateOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      runLegacyDurableSyncForContextGraph:
        LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph,
      resolveCuratorPeerIdsForCg: async () => ({
        peerIds: ['different-peer'], curatorIsLocal: false, legacyTripleResolved: false,
      }),
      store: { dropGraph: async (graph: string) => { dropped.push(graph); } },
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    };

    const result = await (LifecycleSyncMethods.prototype.runChangelogSyncForCg as any).call(
      agent,
      { kind: 'system', id: 'test', startedAt: 0 },
      'peer',
      'cg',
    );

    expect(dropped).toEqual([]);
    expect(forceFreshSessionFlags).toEqual([false, false]);
    expect(cursor).toEqual({ era: 'e1', seq: 8 });
    expect(result.insertedDataTriples).toBe(1);
    expect(result.completedPhases).toBe(0);
  });
});
// ── decodeChangelogResponse cursor invariants (wire hardening) ──────────────

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
