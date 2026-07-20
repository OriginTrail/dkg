import { describe, it, expect } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  DKG_NS,
  RDF_TYPE,
  linesFromNquads,
  registerTestSyncHandler,
  subGraphRegistrationQuads,
  workspaceOpQuads,
  type CapturedSyncHandler,
} from './_helpers/sync-responder.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { fetchSyncPages } from '../src/sync/requester/page-fetch.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

/**
 * #1847 — SWM meta lane ceiling. A CG whose `_meta` crossed
 * SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS (64,000) raw rows became permanently
 * unsyncable for TTL-filtered sessions: the bounded snapshot applied its budget
 * to the RAW graph before the TTL filter, and `readSwmMetaPage` passed
 * `params.cutoffIso == null` POSITIONALLY as `fallbackOnPerSnapshotBudget`, so
 * the refusal had no fallback. These tests seed real >64,000-row stores and
 * prove the lane now serves them completely, page by page, within the DEFAULT
 * production budgets — and that the deleted global-sort TTL query never runs.
 */

const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
const TTL_MS = 60_000;

const TINY_SNAPSHOT_BUDGET = {
  maxRows: 1_000_000,
  maxBytesEstimate: Number.MAX_SAFE_INTEGER,
  maxSnapshotRows: 1,
  maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
} as const;

function freshIso(): string {
  return new Date(Date.now() - 1_000).toISOString();
}

function staleIso(): string {
  return new Date(Date.now() - 10 * TTL_MS).toISOString();
}

/** Graph-scoped head + selected WorkspaceOperation (11 rows), per swm-recovery shape. */
function graphScopedHeadQuads(
  cgId: string,
  metaGraph: string,
  ual: string,
  opId: string,
  timestamp: string,
): Quad[] {
  const op = `urn:dkg:share:${cgId}:${opId}`;
  const head = `${ual}#dkg-swm-head`;
  return [
    { graph: metaGraph, subject: op, predicate: RDF_TYPE, object: `${DKG_NS}WorkspaceOperation` },
    { graph: metaGraph, subject: op, predicate: `${DKG_NS}publishedAt`, object: `"${timestamp}"^^<${XSD_DT}>` },
    { graph: metaGraph, subject: op, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
    { graph: metaGraph, subject: op, predicate: `${DKG_NS}contentScopeVersion`, object: `"2"^^<${XSD_INT}>` },
    { graph: metaGraph, subject: op, predicate: `${DKG_NS}kaUal`, object: ual },
    { graph: metaGraph, subject: op, predicate: `${DKG_NS}assertionVersion`, object: `"1"^^<${XSD_INT}>` },
    { graph: metaGraph, subject: head, predicate: `${DKG_NS}contentScopeVersion`, object: `"2"^^<${XSD_INT}>` },
    { graph: metaGraph, subject: head, predicate: `${DKG_NS}kaUal`, object: ual },
    { graph: metaGraph, subject: head, predicate: `${DKG_NS}assertionVersion`, object: `"1"^^<${XSD_INT}>` },
    { graph: metaGraph, subject: head, predicate: `${DKG_NS}shareOperationId`, object: `"${opId}"` },
    { graph: metaGraph, subject: head, predicate: `${DKG_NS}assertionGraph`, object: `${metaGraph.replace(/_meta$/, '')}/0x00000000000000000000000000000000000000ab/1` },
  ];
}

async function insertChunked(store: OxigraphStore, quads: Quad[]): Promise<void> {
  for (let offset = 0; offset < quads.length; offset += 8_000) {
    await store.insert(quads.slice(offset, offset + 8_000));
  }
}

async function collectAllPages(
  cap: CapturedSyncHandler,
  base: Omit<SyncRequestEnvelope, 'offset'>,
  pageSize: number,
  maxPages = 300,
): Promise<{ lines: Set<string>; pages: number }> {
  const lines = new Set<string>();
  let pages = 0;
  for (let offset = 0, page = 0; page < maxPages; page += 1, offset += pageSize) {
    const out = await cap.invoke({ ...base, offset });
    const pageLines = linesFromNquads(out);
    pages += 1;
    for (const line of pageLines) lines.add(line);
    if (pageLines.length < pageSize) break;
  }
  return { lines, pages };
}

/** Fails the test if the deleted TTL global-sort shape — or ANY OFFSET/ORDER BY
 * query over an SWM meta graph — reaches the store during a TTL session. */
function forbidSwmMetaSortOrOffsetQueries(store: OxigraphStore) {
  const originalQuery = store.query.bind(store);
  let windowQueries = 0;
  store.query = (async (sparql: string, options?: unknown) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (normalized.includes('_shared_memory_meta')) {
      expect(normalized).not.toMatch(/OFFSET \d/);
      expect(normalized).not.toContain('ORDER BY');
      if (normalized.includes('VALUES ?s')) windowQueries += 1;
    }
    return originalQuery(sparql, options as never);
  }) as OxigraphStore['query'];
  return {
    assertWindowQueriesObserved: () => expect(windowQueries).toBeGreaterThan(0),
  };
}

describe('SWM meta lane above the 64,000-row snapshot ceiling (#1847)', () => {
  it('serves a 64,000+-row _meta with a small fresh subset completely at DEFAULT budgets (the fifa-world-cup-2026 shape)', async () => {
    const cgId = 'meta-ceiling-fifa';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const stale = staleIso();
    const fresh = freshIso();

    const quads: Quad[] = [];
    // 12,800 stale operations x 5 rows = 64,000 raw rows: over the build cap.
    for (let index = 0; index < 12_800; index += 1) {
      quads.push(...workspaceOpQuads(cgId, `stale-${index}`, `urn:stale:root:${index}`, metaGraph, stale));
    }
    // The small fresh subset that TTL sessions actually need.
    const freshOpIds = ['fresh-a', 'fresh-b', 'fresh-c'];
    for (const opId of freshOpIds) {
      quads.push(...workspaceOpQuads(cgId, opId, `urn:fresh:root:${opId}`, metaGraph, fresh));
    }
    const freshUal = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/1';
    quads.push(...graphScopedHeadQuads(cgId, metaGraph, freshUal, 'fresh-head-op', fresh));
    expect(quads.length).toBeGreaterThan(64_000);

    const store = new OxigraphStore();
    const seedStartedAt = Date.now();
    await insertChunked(store, quads);
    const seedDurationMs = Date.now() - seedStartedAt;

    // DEFAULT production budgets: no snapshotBudget override.
    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 7 });
    const watch = forbidSwmMetaSortOrOffsetQueries(store);

    const serveStartedAt = Date.now();
    const { lines, pages } = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta', limit: 7, syncSessionId: 'fifa-session' },
      7,
    );
    const serveDurationMs = Date.now() - serveStartedAt;

    // Every fresh row is served — the lane is no longer refused.
    // 3 ops x 5 rows + head group 11 rows = 26.
    expect(lines.size).toBe(26);
    const joined = [...lines].join('\n');
    for (const opId of freshOpIds) {
      expect(joined).toContain(`urn:dkg:share:${cgId}:${opId}`);
    }
    expect(joined).toContain(`${freshUal}#dkg-swm-head`);
    expect(joined).toContain('assertionVersion');
    expect(joined).not.toContain('urn:stale:root');
    watch.assertWindowQueriesObserved();

    // eslint-disable-next-line no-console
    console.info(
      `#1847 fifa-shape: raw=${quads.length} rows, fresh=26 rows, pages=${pages}, ` +
      `seed=${seedDurationMs}ms, serve=${serveDurationMs}ms`,
    );
    await store.close();
  }, 120_000);

  it('serves an INTRINSICALLY oversized fresh set (>64,000 admitted rows) via bounded plan paging at DEFAULT budgets', async () => {
    const cgId = 'meta-ceiling-allfresh';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();

    const quads: Quad[] = [];
    // 13,000 FRESH operations x 5 rows = 65,000 admitted rows: even the
    // filtered set exceeds the per-snapshot cap, so the session must degrade
    // to plan-paged serving instead of refusing. This test is the direct
    // mutation-kill for the positional `params.cutoffIso == null` defect:
    // reintroduce it and this session throws the per-snapshot budget error.
    for (let index = 0; index < 13_000; index += 1) {
      quads.push(...workspaceOpQuads(cgId, `f${index}`, `urn:fresh:root:${index}`, metaGraph, fresh));
    }
    expect(quads.length).toBe(65_000);

    const store = new OxigraphStore();
    const seedStartedAt = Date.now();
    await insertChunked(store, quads);
    const seedDurationMs = Date.now() - seedStartedAt;

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 5000 });
    const watch = forbidSwmMetaSortOrOffsetQueries(store);

    const serveStartedAt = Date.now();
    const { lines, pages } = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta', limit: 5000, syncSessionId: 'allfresh-session' },
      5000,
    );
    const serveDurationMs = Date.now() - serveStartedAt;

    // The complete oversized fresh set is served, page by page, no refusal.
    expect(lines.size).toBe(65_000);
    watch.assertWindowQueriesObserved();

    // eslint-disable-next-line no-console
    console.info(
      `#1847 oversized-fresh: rows=65000, pages=${pages}, seed=${seedDurationMs}ms, serve=${serveDurationMs}ms`,
    );
    await store.close();
  }, 120_000);

  it('plan-paged serving is set-equivalent to the snapshot lane across buckets, heads and stale exclusion', async () => {
    const cgId = 'meta-ceiling-equiv';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const rootMeta = `${cgPrefix}/_shared_memory_meta`;
    const subMeta = `${cgPrefix}/subx/_shared_memory_meta`;
    const fresh = freshIso();
    const stale = staleIso();

    const quads: Quad[] = [
      ...subGraphRegistrationQuads(cgId, 'subx'),
      ...workspaceOpQuads(cgId, 'root-fresh', 'urn:r:fresh', rootMeta, fresh),
      ...workspaceOpQuads(cgId, 'root-stale', 'urn:r:stale', rootMeta, stale),
      ...workspaceOpQuads(cgId, 'sub-fresh', 'urn:s:fresh', subMeta, fresh),
      ...workspaceOpQuads(cgId, 'sub-stale', 'urn:s:stale', subMeta, stale),
      ...graphScopedHeadQuads(cgId, rootMeta, 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7', 'head-fresh', fresh),
      ...graphScopedHeadQuads(cgId, rootMeta, 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8', 'head-stale', stale),
    ];

    const canonicalStore = new OxigraphStore();
    await canonicalStore.insert(quads);
    const pagedStore = new OxigraphStore();
    await pagedStore.insert(quads);

    const canonicalCap = registerTestSyncHandler(canonicalStore, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 5000 });
    const pagedCap = registerTestSyncHandler(pagedStore, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 3,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });
    const base = { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta' as const };

    const canonical = (await collectAllPages(
      canonicalCap, { ...base, limit: 5000, syncSessionId: 'canon' }, 5000,
    )).lines;
    const paged = (await collectAllPages(
      pagedCap, { ...base, limit: 3, syncSessionId: 'paged' }, 3,
    )).lines;

    expect(paged).toEqual(canonical);
    const joined = [...canonical].join('\n');
    expect(joined).toContain('urn:dkg:share:meta-ceiling-equiv:root-fresh');
    expect(joined).toContain('urn:dkg:share:meta-ceiling-equiv:sub-fresh');
    expect(joined).toContain('#dkg-swm-head');
    expect(joined).toContain('/7#dkg-swm-head');
    expect(joined).not.toContain('/8#dkg-swm-head');
    expect(joined).not.toContain('root-stale');
    expect(joined).not.toContain('sub-stale');
    // Both buckets appear in the graph position.
    expect(joined).toContain(`<${rootMeta}> .`);
    expect(joined).toContain(`<${subMeta}> .`);
    await canonicalStore.close();
    await pagedStore.close();
  });

  it('fails the session (not silently skips/duplicates) when an admitted subject mutates between plan pages, and a fresh session recovers', async () => {
    const cgId = 'meta-ceiling-mutate';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    // Deterministic subject order: op ids sort a < b < c...
    const opIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const opId of opIds) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:m:${opId}`, metaGraph, fresh));
    }

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 5,
      snapshotBudget: TINY_SNAPSHOT_BUDGET, // forces plan-paged mode
    });
    const base = { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta' as const, limit: 5 };

    const page0 = linesFromNquads(await cap.invoke({ ...base, offset: 0, syncSessionId: 'M1' }));
    expect(page0).toHaveLength(5);

    // Grow a subject the NEXT page's window must read.
    const grownSubject = `urn:dkg:share:${cgId}:${opIds[1]}`;
    await store.insert([{ graph: metaGraph, subject: grownSubject, predicate: `${DKG_NS}note`, object: '"grown"' }]);

    await expect(cap.invoke({ ...base, offset: 5, syncSessionId: 'M1' }))
      .rejects.toThrow(/Shared-memory meta sync plan changed while reading/);

    // A fresh session rebuilds the plan and serves the grown store completely.
    const recovered = await collectAllPages(
      cap, { ...base, syncSessionId: 'M2' }, 5,
    );
    expect(recovered.lines.size).toBe(6 * 5 + 1);
    expect([...recovered.lines].join('\n')).toContain('"grown"');
    await store.close();
  });

  it('keeps a bounded refusal ONLY for a single pathological subject exceeding the hard 64,000-row build cap', async () => {
    const cgId = 'meta-ceiling-monster';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    // ONE fresh subject carrying 64,001 rows. Whole-subject windows are the
    // consistency unit of the plan lane (they are what keeps a seal/head
    // row-group atomic per #1788), so this single row-group can never be
    // served coherently within the hard build cap — a bounded refusal, at
    // DEFAULT budgets, is the correct answer. Ordinary multi-row subjects
    // under a shrunken session budget are covered by the paged tests above.
    const subject = 'urn:monster';
    const monsterQuads: Quad[] = [
      { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${fresh}"^^<${XSD_DT}>` },
    ];
    for (let index = 1; index <= 64_000; index += 1) {
      monsterQuads.push({
        graph: metaGraph, subject, predicate: `${DKG_NS}note`, object: `"filler-${index}"`,
      });
    }
    await insertChunked(store, monsterQuads);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 500 });

    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 500,
      syncSessionId: 'monster-session',
    })).rejects.toThrow(/per-snapshot rows budget/);
    await store.close();
  }, 120_000);

  it('legacy cutoff-less sessions keep the unfiltered store-paged compatibility fallback', async () => {
    const cgId = 'meta-ceiling-legacy';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const store = new OxigraphStore();
    const iso = '2026-06-01T00:00:00.000Z';
    for (const opId of ['x', 'y', 'z']) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:l:${opId}`, metaGraph, iso));
    }

    let legacyPagedQueries = 0;
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: unknown) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (
        normalized.includes('VALUES ?g') &&
        normalized.includes('_shared_memory_meta') &&
        normalized.includes('ORDER BY ?g ?s ?p ?o') &&
        /OFFSET \d+/.test(normalized)
      ) {
        // The legacy paged query must never carry the TTL join.
        expect(normalized).not.toContain('publishedAt');
        expect(normalized).not.toContain('FILTER');
        legacyPagedQueries += 1;
      }
      return originalQuery(sparql, options as never);
    }) as OxigraphStore['query'];

    // sharedMemoryTtlMs: 0 => cutoffIso == null (legacy lane), tiny budget
    // forces the fallback.
    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: 0,
      syncPageSize: 4,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });
    const { lines } = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta', limit: 4, syncSessionId: 'legacy' },
      4,
    );
    expect(lines.size).toBe(15);
    expect(legacyPagedQueries).toBeGreaterThan(0);
    await store.close();
  });
});

describe('requester reassembly of the plan-paged SWM meta lane (#1847 x #1788)', () => {
  function makeCtx(): OperationContext {
    return { kind: 'system', id: 'meta-ceiling-requester', startedAt: Date.now() } as never;
  }
  const noop = () => {};

  /** Minimal N-Quads line parser for the fixture vocabulary (IRIs + literals). */
  function parseNquads(text: string): Quad[] {
    const quads: Quad[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = trimmed.match(/^<([^>]+)> <([^>]+)> (.+) <([^>]+)> \.$/);
      if (!match) throw new Error(`unparseable line: ${trimmed}`);
      quads.push({ subject: match[1], predicate: match[2], object: match[3], graph: match[4] });
    }
    return quads;
  }

  async function fetchAllMeta(
    cap: CapturedSyncHandler,
    cgId: string,
    pageSize: number,
  ) {
    return fetchSyncPages({
      ctx: makeCtx(),
      remotePeerId: '12D3KooWMetaCeilingRemote',
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      graphUri: `did:dkg:context-graph:${cgId}/_shared_memory_meta`,
      deadline: Date.now() + 60_000,
      syncPageTimeoutMs: 10_000,
      syncRouterAttempts: 1,
      syncPageRetryAttempts: 1,
      syncPageSize: pageSize,
      syncDeniedResponse: 'sync-denied',
      debugSyncProgress: false,
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      checkpointStore: new MemorySyncCheckpointStore(),
      buildSyncRequest: async (contextGraphId, offset, limit, includeSharedMemory, _peer, phase, _snap, _since, syncSessionId) =>
        new TextEncoder().encode(JSON.stringify({
          contextGraphId, offset, limit, includeSharedMemory, phase, syncSessionId,
        })),
      parseAndFilter: async (nquadsText) => {
        const quads = parseNquads(nquadsText);
        return { quads, totalQuads: quads.length };
      },
      send: async (_peerId, _protocolId, data) => {
        const envelope = JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope;
        return new TextEncoder().encode(await cap.invoke(envelope));
      },
      logWarn: noop,
      logInfo: noop,
      logDebug: noop,
    });
  }

  /** Assert no subject group lost a field to a page boundary (#1788 class). */
  function assertNoStrippedFields(quads: readonly Quad[], expectedGroups: ReadonlyMap<string, readonly string[]>) {
    const bySubject = new Map<string, Set<string>>();
    for (const quad of quads) {
      const predicates = bySubject.get(quad.subject) ?? new Set<string>();
      predicates.add(quad.predicate);
      bySubject.set(quad.subject, predicates);
    }
    for (const [subject, expectedPredicates] of expectedGroups) {
      const predicates = bySubject.get(subject);
      expect(predicates, `subject ${subject} missing entirely`).toBeDefined();
      for (const predicate of expectedPredicates) {
        expect(
          predicates!.has(predicate),
          `subject ${subject} lost <${predicate}> across a page boundary`,
        ).toBe(true);
      }
    }
  }

  const OP_PREDICATES = [
    RDF_TYPE,
    `${DKG_NS}publishedAt`,
    `${DKG_NS}rootEntity`,
    `${DKG_NS}contextGraphId`,
    `${DKG_NS}shareOperationId`,
  ] as const;
  const HEAD_PREDICATES = [
    `${DKG_NS}contentScopeVersion`,
    `${DKG_NS}kaUal`,
    `${DKG_NS}assertionVersion`,
    `${DKG_NS}shareOperationId`,
    `${DKG_NS}assertionGraph`,
  ] as const;

  for (const [label, snapshotBudget] of [
    ['session snapshot lane (default budgets)', undefined],
    ['plan-paged lane (oversized snapshot)', TINY_SNAPSHOT_BUDGET],
  ] as const) {
    it(`reassembles every seal/head row-group with no stripped fields via the ${label}`, async () => {
      const cgId = `meta-reassembly-${snapshotBudget ? 'paged' : 'snap'}`;
      const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
      const fresh = freshIso();
      const store = new OxigraphStore();

      const expectedGroups = new Map<string, readonly string[]>();
      const quads: Quad[] = [];
      for (let index = 0; index < 30; index += 1) {
        const opId = `op-${String(index).padStart(2, '0')}`;
        quads.push(...workspaceOpQuads(cgId, opId, `urn:re:${opId}`, metaGraph, fresh));
        expectedGroups.set(`urn:dkg:share:${cgId}:${opId}`, OP_PREDICATES);
      }
      for (let index = 0; index < 4; index += 1) {
        const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${index + 1}`;
        quads.push(...graphScopedHeadQuads(cgId, metaGraph, ual, `head-${index}`, fresh));
        expectedGroups.set(`${ual}#dkg-swm-head`, HEAD_PREDICATES);
      }
      await store.insert(quads);

      // Page size 4 vs 5- and 11-row groups: every group straddles a boundary.
      const cap = registerTestSyncHandler(store, {
        sharedMemoryTtlMs: TTL_MS,
        syncPageSize: 4,
        ...(snapshotBudget ? { snapshotBudget } : {}),
      });
      const result = await fetchAllMeta(cap, cgId, 4);

      expect(result.completed).toBe(true);
      expect(result.timedOut).toBe(false);
      expect(result.quads.length).toBe(quads.length);
      assertNoStrippedFields(result.quads, expectedGroups);
      await store.close();
    });
  }
});
