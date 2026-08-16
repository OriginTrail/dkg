import { describe, it, expect, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  StoreResponseTooLargeError,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { createSyncResponderSnapshotBudget } from '../src/sync/responder/snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../src/sync/memory-telemetry.js';
import {
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
  SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
} from '../src/sync/responder/snapshot-cache.js';
import {
  createResponderFreshSwmMetaPlanMemo,
  FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE,
  FRESH_SWM_META_PLAN_MAX_SUBJECTS,
  FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS,
} from '../src/sync/responder/graph-plan.js';
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
 * the legacy 64,000-row snapshot build limit became permanently
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

const PLAN_FORCED_SNAPSHOT_BUDGET = {
  maxRows: 1_000_000,
  maxBytesEstimate: Number.MAX_SAFE_INTEGER,
  maxSnapshotRows: 60_000,
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

describe('SWM meta lane above the legacy 64,000-row snapshot ceiling (#1847)', () => {
  it('uses the bounded fresh-subject plan for an ordinary TTL-filtered manifest', async () => {
    const cgId = 'meta-bounded-plan-path';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const store = new OxigraphStore();
    const quads: Quad[] = [];
    for (let index = 0; index < 40; index += 1) {
      quads.push(...workspaceOpQuads(cgId, `fresh-${index}`, `urn:fresh:root:${index}`, metaGraph, freshIso()));
      quads.push(...workspaceOpQuads(cgId, `stale-${index}`, `urn:stale:root:${index}`, metaGraph, staleIso()));
    }
    await store.insert(quads);

    const sources: string[] = [];
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: unknown) => {
      const source = (options as { source?: string } | undefined)?.source;
      if (source) sources.push(source);
      return originalQuery(sparql, options as never);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 500 });
    const request = {
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta' as const,
      offset: 0,
      limit: 500,
      syncSessionId: 'bounded-plan-session',
    };
    const first = await cap.invoke(request);
    expect(linesFromNquads(first)).toHaveLength(40 * 5);
    expect(sources).not.toContain('sync.responder.readSwmMetaGraphSnapshot');
    expect(sources).toContain('sync.responder.readFreshSwmMetaSubjects');
    expect(sources).toContain('sync.responder.countFreshSwmMetaSubjectRows');
    expect(sources).toContain('sync.responder.readFreshSwmMetaSubjectRows');

    const subjectDiscoveryAfterFirst = sources.filter(
      (source) => source === 'sync.responder.readFreshSwmMetaSubjects',
    ).length;
    const subjectCountAfterFirst = sources.filter(
      (source) => source === 'sync.responder.countFreshSwmMetaSubjectRows',
    ).length;
    expect(await cap.invoke(request)).toBe(first);
    expect(sources.filter(
      (source) => source === 'sync.responder.readFreshSwmMetaSubjects',
    )).toHaveLength(subjectDiscoveryAfterFirst);
    expect(sources.filter(
      (source) => source === 'sync.responder.countFreshSwmMetaSubjectRows',
    )).toHaveLength(subjectCountAfterFirst);
    await store.close();
  });

  it('keeps plan-only ceilings pinned below the snapshot materialization caps', () => {
    expect(FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS).toBe(64_000);
    expect(FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE).toBe(32 * 1024 * 1024);
    expect(FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS)
      .toBeLessThan(SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS);
    expect(FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE)
      .toBeLessThan(SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE);
  });

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

    // The point of this test is the DEGRADATION path — an admitted set larger
    // than the per-snapshot ceiling must still be served, page by page, rather
    // than refused. Express that ceiling EXPLICITLY instead of relying on the
    // global build cap: snapshotLoadLimits is min(BUILD_CAP, configured), so a
    // 60,000-row session limit forces degradation no matter what the build cap
    // is. Relying on the constant is how this test would silently stop
    // exercising the degradation path the next time the cap moves.
    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 5000,
      snapshotBudget: {
        maxRows: 1_000_000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 60_000,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
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

  it('fails the session when an already-served subject is replaced with the SAME row count (content binding, not just cardinality)', async () => {
    const cgId = 'meta-ceiling-samecount';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    const opIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const opId of opIds) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:m:${opId}`, metaGraph, fresh));
    }

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      // Page size 2 splits the 5-row subject `a` across pages, so page 1 must
      // REREAD `a` and slice it at the plan's prefix sums — the exact shape
      // that used to accept a same-count replacement and serve a hybrid
      // row-group assembled from two versions of one subject.
      syncPageSize: 2,
      snapshotBudget: TINY_SNAPSHOT_BUDGET, // forces plan-paged mode
    });
    const base = { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta' as const, limit: 2 };

    const page0 = linesFromNquads(await cap.invoke({ ...base, offset: 0, syncSessionId: 'SC1' }));
    expect(page0).toHaveLength(2);

    // Same-count replacement of the split subject: 5 rows before, 5 rows after.
    const splitSubject = `urn:dkg:share:${cgId}:a`;
    await store.delete([
      { graph: metaGraph, subject: splitSubject, predicate: `${DKG_NS}rootEntity`, object: 'urn:m:a' },
    ]);
    await store.insert([
      { graph: metaGraph, subject: splitSubject, predicate: `${DKG_NS}note`, object: '"swapped"' },
    ]);

    await expect(cap.invoke({ ...base, offset: 2, syncSessionId: 'SC1' }))
      .rejects.toThrow(/Shared-memory meta sync plan changed while reading/);

    // A fresh session rebuilds the plan and serves the replaced content whole.
    const recovered = await collectAllPages(cap, { ...base, syncSessionId: 'SC2' }, 2);
    expect(recovered.lines.size).toBe(6 * 5);
    const joined = [...recovered.lines].join('\n');
    expect(joined).toContain('"swapped"');
    expect(joined).not.toContain(`<${splitSubject}> <${DKG_NS}rootEntity>`);
    await store.close();
  });

  it('serves a coherent NEW row-group when a NOT-yet-read subject mutates same-count (bounded freshness skew, never a tear)', async () => {
    // Guarantee boundary, made explicit per review: whole-subject row-groups
    // are the consistency unit. A subject read exactly once is served whole
    // from a single query, so a same-count change BEFORE its only read serves
    // the newer coherent group — the bounded skew any keyset pager has. Only a
    // REREAD of a split subject binds (and verifies) content.
    const cgId = 'meta-ceiling-skew';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    const opIds = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const opId of opIds) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:m:${opId}`, metaGraph, fresh));
    }

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 5, // window = exactly one whole 5-row subject
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });
    const base = { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta' as const, limit: 5 };

    const page0 = linesFromNquads(await cap.invoke({ ...base, offset: 0, syncSessionId: 'SK1' }));
    expect(page0).toHaveLength(5);

    // Same-count mutation of subject `b`, which page 1 will read for the FIRST time.
    const nextSubject = `urn:dkg:share:${cgId}:b`;
    await store.delete([
      { graph: metaGraph, subject: nextSubject, predicate: `${DKG_NS}rootEntity`, object: 'urn:m:b' },
    ]);
    await store.insert([
      { graph: metaGraph, subject: nextSubject, predicate: `${DKG_NS}note`, object: '"swapped-whole"' },
    ]);

    const page1 = linesFromNquads(await cap.invoke({ ...base, offset: 5, syncSessionId: 'SK1' }));
    expect(page1).toHaveLength(5);
    const joined = page1.join('\n');
    // The NEW group, whole: replacement present, replaced row absent — no hybrid.
    expect(joined).toContain('"swapped-whole"');
    expect(joined).not.toContain(`<${nextSubject}> <${DKG_NS}rootEntity>`);
    expect(page1.every((line) => line.startsWith(`<${nextSubject}>`))).toBe(true);
    await store.close();
  });

  it('fails the session on a compensating cross-subject count mutation within one window (per-subject counts, not the window aggregate)', async () => {
    const cgId = 'meta-ceiling-compensate';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    for (const opId of ['a', 'b', 'c', 'd']) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:m:${opId}`, metaGraph, fresh));
    }

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 10,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });
    const base = { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta' as const, limit: 10 };

    // Page 0 = subjects a+b whole. Page 1's window will be subjects c+d.
    const page0 = linesFromNquads(await cap.invoke({ ...base, offset: 0, syncSessionId: 'CP1' }));
    expect(page0).toHaveLength(10);

    // c loses a row, d gains one: the WINDOW aggregate still totals 10, but the
    // plan's prefix sums for c/d are now both wrong — an aggregate-count guard
    // passes and misaligns every later slice (duplicate/skip at page seams).
    await store.delete([
      { graph: metaGraph, subject: `urn:dkg:share:${cgId}:c`, predicate: `${DKG_NS}rootEntity`, object: 'urn:m:c' },
    ]);
    await store.insert([
      { graph: metaGraph, subject: `urn:dkg:share:${cgId}:d`, predicate: `${DKG_NS}note`, object: '"extra"' },
    ]);

    await expect(cap.invoke({ ...base, offset: 10, syncSessionId: 'CP1' }))
      .rejects.toThrow(/Shared-memory meta sync plan changed while reading/);
    await store.close();
  });

  it('serves directly through bounded plan paging without attempting an oversized whole-subject snapshot', async () => {
    const cgId = 'meta-ceiling-storecap';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    const quads: Quad[] = [];
    for (let index = 0; index < 40; index += 1) {
      quads.push(...workspaceOpQuads(cgId, `op-${String(index).padStart(2, '0')}`, `urn:sc:${index}`, metaGraph, fresh));
    }
    await store.insert(quads);

    // Emulate the storage layer's 32 MiB response cap: any whole-subject
    // window query addressing MANY subjects at once (the snapshot
    // materialization) throws StoreResponseTooLargeError, while the paged
    // lane's small windows stay under the cap. Before the fix this error
    // escaped untyped past the per-snapshot budget accounting and failed the
    // phase outright instead of falling back.
    let capThrows = 0;
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: unknown) => {
      const normalized = sparql.replace(/\s+/g, ' ');
      if (normalized.includes('VALUES ?s') && !normalized.includes('COUNT(')) {
        const subjectCount = (normalized.match(/<urn:dkg:share:/g) ?? []).length;
        if (subjectCount > 10) {
          capThrows += 1;
          throw new StoreResponseTooLargeError(1024, 2048);
        }
      }
      return originalQuery(sparql, options as never);
    }) as OxigraphStore['query'];

    // DEFAULT budgets: the bounded subject plan is now the primary TTL lane,
    // so it must never attempt the old whole-subject snapshot query.
    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 7 });
    const { lines } = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta', limit: 7, syncSessionId: 'storecap-session' },
      7,
    );
    expect(lines.size).toBe(200);
    expect(capThrows).toBe(0);
    await store.close();
  });

  it('degrades to plan paging when the fresh snapshot crosses only the per-snapshot BYTE estimate budget', async () => {
    const cgId = 'meta-ceiling-bytebudget';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    for (const opId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      await store.insert(workspaceOpQuads(cgId, opId, `urn:m:${opId}`, metaGraph, fresh));
    }

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 4,
      snapshotBudget: {
        maxRows: 1_000_000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1_000_000,
        // Well below one row's ~200-byte heap estimate: the snapshot path must
        // throw the per-snapshot BYTES error (row budget never binds) and the
        // session must still complete through the plan-paged reader.
        maxSnapshotBytesEstimate: 64,
      },
    });
    const watch = forbidSwmMetaSortOrOffsetQueries(store);
    const { lines } = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: true, phase: 'meta', limit: 4, syncSessionId: 'bytebudget-session' },
      4,
    );
    expect(lines.size).toBe(30);
    watch.assertWindowQueriesObserved();
    await store.close();
  });

  it('refuses fresh-SWM plan scalar growth at the plan byte cap, independent of snapshot caps', async () => {
    const cgId = `plan-bytes-${'g'.repeat(2_048)}`;
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const subjects = Array.from(
      { length: 16_000 },
      (_, index) => `urn:plan-subject:${String(index).padStart(5, '0')}`,
    );
    const planBytesEstimate = subjects.reduce(
      (sum, subject) => sum + estimateStringRowHeapBytes(subject, '', '', metaGraph),
      0,
    );
    expect(planBytesEstimate).toBeGreaterThan(FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE);
    expect(planBytesEstimate).toBeLessThan(SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE);

    const store = new OxigraphStore();
    await store.insert([{
      graph: metaGraph,
      subject: 'urn:plan-seed',
      predicate: `${DKG_NS}publishedAt`,
      object: `"${freshIso()}"^^<${XSD_DT}>`,
    }]);
    const originalQuery = store.query.bind(store);
    const planResponseCaps: number[] = [];
    let failPlanResponse = false;
    store.query = (async (sparql: string, options?: unknown) => {
      const queryOptions = options as { source?: string; maxResponseBytes?: number } | undefined;
      const source = queryOptions?.source;
      if (
        source === 'sync.responder.readFreshSwmMetaSubjects' ||
        source === 'sync.responder.readFreshSwmMetaHeadSubjects'
      ) {
        planResponseCaps.push(queryOptions?.maxResponseBytes ?? 0);
        if (failPlanResponse) {
          throw new StoreResponseTooLargeError(
            FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE * 2,
            FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE * 2 + 1,
          );
        }
        return {
          type: 'bindings' as const,
          bindings: source === 'sync.responder.readFreshSwmMetaSubjects'
            ? subjects.map((subject) => ({ s: subject }))
            : [],
        };
      }
      if (source === 'sync.responder.countFreshSwmMetaSubjectRows') {
        planResponseCaps.push(queryOptions?.maxResponseBytes ?? 0);
        const requestedSubjects = [...sparql.matchAll(/<(urn:plan-subject:[^>]+)>/g)]
          .map((match) => match[1] as string);
        return {
          type: 'bindings' as const,
          bindings: requestedSubjects.map((subject) => ({ s: subject, count: '1' })),
        };
      }
      return originalQuery(sparql, options as never);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 500 });
    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 500,
      syncSessionId: 'plan-byte-cap-session',
    })).rejects.toMatchObject({
      name: 'QuietRetryableHandlerError',
      message: expect.stringContaining(`limit=${FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE}`),
    });
    expect(planResponseCaps.length).toBeGreaterThan(2);
    expect(new Set(planResponseCaps)).toEqual(new Set([
      FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE * 2,
    ]));

    // The store-cap translation must report the same PLAN heap ceiling, not
    // the larger snapshot materialization ceiling.
    failPlanResponse = true;
    const storeCapHandler = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 500,
    });
    await expect(storeCapHandler.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 500,
      syncSessionId: 'plan-byte-store-cap-session',
    })).rejects.toMatchObject({
      name: 'QuietRetryableHandlerError',
      message: expect.stringContaining(`limit=${FRESH_SWM_META_PLAN_MAX_BYTES_ESTIMATE}`),
    });
    await store.close();
  }, 120_000);

  it('refuses a fresh subject set beyond the plan cardinality cap as a TYPED bounded refusal, via LIMIT-bounded discovery', async () => {
    const cgId = 'meta-ceiling-cardinality';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    // One row per subject: cap + 1 admitted subjects. The plan would retain a
    // subject entry for every one of them — this is the reviewed unbounded
    // control-plane growth (#1868), so it must refuse, bounded and typed,
    // BEFORE materializing an unbounded discovery result.
    const quads: Quad[] = [];
    for (let index = 0; index <= FRESH_SWM_META_PLAN_MAX_SUBJECTS; index += 1) {
      quads.push({
        graph: metaGraph,
        subject: `urn:card:${String(index).padStart(6, '0')}`,
        predicate: `${DKG_NS}publishedAt`,
        object: `"${fresh}"^^<${XSD_DT}>`,
      });
    }
    await insertChunked(store, quads);

    // Bounded-by-construction: every TTL discovery query over the meta graph
    // must carry the cap-derived LIMIT so the store can never stream an
    // unbounded subject set into the plan builder.
    let discoveryLimitQueries = 0;
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: unknown) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (normalized.includes('SELECT DISTINCT ?s') && normalized.includes('_shared_memory_meta')) {
        expect(normalized).toMatch(/LIMIT \d+$/);
        if (normalized.endsWith(`LIMIT ${FRESH_SWM_META_PLAN_MAX_SUBJECTS + 1}`)) {
          discoveryLimitQueries += 1;
        }
      }
      return originalQuery(sparql, options as never);
    }) as OxigraphStore['query'];

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 500 });
    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 500,
      syncSessionId: 'cardinality-session',
    })).rejects.toThrow(/per-snapshot rows budget/);
    expect(discoveryLimitQueries).toBeGreaterThan(0);
    await store.close();
  }, 120_000);

  it('applies the plan cardinality cap in AGGREGATE across root and subgraph meta graphs, not per graph (#1868 review)', async () => {
    const cgId = 'meta-ceiling-aggregate';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const rootMeta = `${cgPrefix}/_shared_memory_meta`;
    const subMeta = `${cgPrefix}/subagg/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    // Exactly the cap in the ROOT bucket plus ONE more fresh subject in a
    // registered subgraph bucket. The subject allowance is cumulative across
    // the phase's candidate graphs; a regression that reset it per graph would
    // happily admit both buckets (retaining up to #graphs x cap plan entries)
    // and serve this session — so it must fail this test, which demands the
    // same typed bounded refusal as the single-graph overflow.
    const quads: Quad[] = [...subGraphRegistrationQuads(cgId, 'subagg')];
    for (let index = 0; index < FRESH_SWM_META_PLAN_MAX_SUBJECTS; index += 1) {
      quads.push({
        graph: rootMeta,
        subject: `urn:agg:${String(index).padStart(6, '0')}`,
        predicate: `${DKG_NS}publishedAt`,
        object: `"${fresh}"^^<${XSD_DT}>`,
      });
    }
    quads.push({
      graph: subMeta,
      subject: 'urn:agg:one-over-in-the-subgraph',
      predicate: `${DKG_NS}publishedAt`,
      object: `"${fresh}"^^<${XSD_DT}>`,
    });
    await insertChunked(store, quads);

    const cap = registerTestSyncHandler(store, { sharedMemoryTtlMs: TTL_MS, syncPageSize: 500 });
    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 500,
      syncSessionId: 'aggregate-cap-session',
    })).rejects.toThrow(/per-snapshot rows budget/);
    await store.close();
  }, 120_000);

  it('keeps a bounded refusal for a single subject above the independent row-group cap', async () => {
    const cgId = 'meta-ceiling-monster';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    // ONE fresh subject carrying the plan lane's subject-window cap + 1 rows.
    // Whole-subject windows are the consistency unit of the plan lane (they are
    // what keeps a seal/head row-group atomic per #1788), so this single
    // row-group can never be served coherently. A local 60,000-row snapshot
    // budget forces plan mode independently of the production build cap, so a
    // future snapshot-cap change cannot make this regression test expensive or
    // silently stop exercising the row-group refusal.
    const subject = 'urn:monster';
    const monsterQuads: Quad[] = [
      { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${fresh}"^^<${XSD_DT}>` },
    ];
    for (let index = 1; index <= FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS; index += 1) {
      monsterQuads.push({
        graph: metaGraph, subject, predicate: `${DKG_NS}note`, object: `"filler-${index}"`,
      });
    }
    await insertChunked(store, monsterQuads);

    for (const [sessionSuffix, snapshotBudget] of [
      ['default', undefined],
      ['forced-plan', PLAN_FORCED_SNAPSHOT_BUDGET],
    ] as const) {
      const cap = registerTestSyncHandler(store, {
        sharedMemoryTtlMs: TTL_MS,
        syncPageSize: 500,
        ...(snapshotBudget ? { snapshotBudget } : {}),
      });
      await expect(cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: true,
        phase: 'meta',
        offset: 0,
        limit: 500,
        syncSessionId: `monster-session-${sessionSuffix}`,
      })).rejects.toMatchObject({
        // The protocol boundary deliberately converts the internal
        // SyncRowSnapshotBudgetError into a quiet retryable response while
        // preserving its typed budget details in the message.
        name: 'QuietRetryableHandlerError',
        message: expect.stringContaining(
          `actual=${FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS + 1}, ` +
          `limit=${FRESH_SWM_META_SUBJECT_WINDOW_MAX_ROWS}`,
        ),
      });
    }
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

describe('TTL meta session plans are charged to the responder snapshot budget (#1868 review)', () => {
  const plan = (bytesEstimate: number) => ({ entries: [], totalRows: 0, bytesEstimate });

  it('admits, LRU-evicts and rejects plans via the GLOBAL budget while exempting them from per-snapshot caps', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 1_000,
      maxBytesEstimate: 10_000,
      // Deliberately tiny per-snapshot caps: plans are control-plane entries
      // bounded by their own fixed construction caps, so per-snapshot limits
      // must NOT reject them (shrinking those limits is how a session is
      // forced into the plan-paged mode that NEEDS the plan).
      maxSnapshotRows: 1,
      maxSnapshotBytesEstimate: 1,
    });
    const memo = createResponderFreshSwmMetaPlanMemo(60_000, 8, budget);

    await memo.get('k1', async () => plan(4_000));
    expect(budget.stats().snapshots).toBe(1);
    expect(budget.stats().bytesEstimate).toBe(4_000);

    await memo.get('k2', async () => plan(4_000));
    expect(budget.stats().snapshots).toBe(2);

    // Global pressure: admitting k3 must evict the least-recently-used idle
    // plan (k1) rather than growing past the global byte budget.
    await memo.get('k3', async () => plan(4_000));
    expect(budget.stats().bytesEstimate).toBe(8_000);
    expect(await memo.get('k1', async () => plan(1), { requireExisting: true })).toBeNull();

    // A plan that cannot fit even after draining evictables is a typed
    // global rejection (the requester's quiet retryable limit), never an
    // uncharged retention.
    await expect(memo.get('kX', async () => plan(50_000)))
      .rejects.toThrow(/global estimated bytes budget/);
  });

  it('memo eviction and TTL expiry release the charged bytes', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 1_000,
      maxBytesEstimate: 100_000,
      maxSnapshotRows: 1,
      maxSnapshotBytesEstimate: 1,
    });
    const memo = createResponderFreshSwmMetaPlanMemo(60_000, 2, budget);
    await memo.get('a', async () => plan(1_000));
    await memo.get('b', async () => plan(1_000));
    expect(budget.stats().bytesEstimate).toBe(2_000);
    // maxEntries=2: inserting c evicts the memo's oldest entry AND its charge.
    await memo.get('c', async () => plan(1_000));
    expect(budget.stats().snapshots).toBe(2);
    expect(budget.stats().bytesEstimate).toBe(2_000);
  });

  it('time-based TTL expiry prunes a plan AND releases its global charge, distinct from maxEntries eviction (#1868 review)', async () => {
    const budget = createSyncResponderSnapshotBudget({
      maxRows: 1_000,
      maxBytesEstimate: 100_000,
      maxSnapshotRows: 1,
      maxSnapshotBytesEstimate: 1,
    });
    // maxEntries is deliberately roomy so ONLY the clock can remove entries: a
    // regression in the time-based prune path ('expired') cannot hide behind
    // the LRU/maxEntries eviction the previous test already proves.
    const memo = createResponderFreshSwmMetaPlanMemo(60_000, 8, budget);
    const nowSpy = vi.spyOn(Date, 'now');
    const epoch = 1_800_000_000_000;
    try {
      nowSpy.mockReturnValue(epoch);
      await memo.get('a', async () => plan(1_000));
      expect(budget.stats().bytesEstimate).toBe(1_000);

      // One tick BEFORE the TTL boundary an unrelated get must NOT prune 'a'.
      nowSpy.mockReturnValue(epoch + 59_999);
      await memo.get('b', async () => plan(2_000));
      expect(budget.stats().snapshots).toBe(2);
      expect(budget.stats().bytesEstimate).toBe(3_000);

      // AT the TTL boundary 'a' (still cached at epoch) must be pruned AND its
      // global charge released; 'b' (age 1ms) must survive with its charge.
      nowSpy.mockReturnValue(epoch + 60_000);
      await memo.get('c', async () => plan(4_000));
      expect(budget.stats().snapshots).toBe(2);
      expect(budget.stats().bytesEstimate).toBe(6_000);
      expect(await memo.get('a', async () => plan(1), { requireExisting: true })).toBeNull();
      expect(await memo.get('b', async () => plan(1), { requireExisting: true })).not.toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('the sync handler wires the responder budget through to plan admission', async () => {
    const cgId = 'meta-plan-budget-wire';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    await store.insert(workspaceOpQuads(cgId, 'a', 'urn:w:a', metaGraph, fresh));

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 5,
      snapshotBudget: {
        maxRows: 1_000_000,
        // Global byte budget below even one plan's scalar estimate: PLAN
        // admission must fail typed through the handler (proving
        // registerSyncHandler passes its budget into the meta plan memo, not
        // an uncharged default). maxSnapshotRows=1 keeps the ROW snapshot on
        // its memoized per-snapshot refusal so it never reaches the global
        // budget itself — the plan memo is the only global-budget client here.
        maxBytesEstimate: 100,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    await expect(cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'meta',
      offset: 0,
      limit: 5,
      syncSessionId: 'plan-budget-wire',
    })).rejects.toThrow(/global estimated bytes budget/);
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
    afterPage?: (pagesServed: number) => Promise<void>,
  ) {
    let pagesServed = 0;
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
        const out = await cap.invoke(envelope);
        pagesServed += 1;
        await afterPage?.(pagesServed);
        return new TextEncoder().encode(out);
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

  it('never completes with a hybrid row-group when a split subject is replaced same-count mid-session (#1868 review repro)', async () => {
    // lupuszr's reproduction shape: ONE five-row operation, page size 1, a
    // same-count replacement between pages. A count-only guard accepted the
    // reread and assembled a five-row hybrid of both versions (omitting
    // publishedAt); the content binding must fail the session instead, and the
    // requester must never report a completed phase carrying the hybrid.
    const cgId = 'meta-samecount-requester';
    const metaGraph = `did:dkg:context-graph:${cgId}/_shared_memory_meta`;
    const fresh = freshIso();
    const store = new OxigraphStore();
    await store.insert(workspaceOpQuads(cgId, 'solo', 'urn:sq:solo', metaGraph, fresh));
    const subject = `urn:dkg:share:${cgId}:solo`;

    const cap = registerTestSyncHandler(store, {
      sharedMemoryTtlMs: TTL_MS,
      syncPageSize: 1,
      snapshotBudget: TINY_SNAPSHOT_BUDGET, // plan-paged mode: every page rereads the subject
    });

    const mutateAfterFirstPage = async (pagesServed: number) => {
      if (pagesServed !== 1) return;
      await store.delete([
        { graph: metaGraph, subject, predicate: `${DKG_NS}publishedAt`, object: `"${fresh}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` },
      ]);
      await store.insert([
        { graph: metaGraph, subject, predicate: `${DKG_NS}note`, object: '"replacement"' },
      ]);
    };

    let threw = false;
    let result: Awaited<ReturnType<typeof fetchAllMeta>> | undefined;
    try {
      result = await fetchAllMeta(cap, cgId, 1, mutateAfterFirstPage);
    } catch {
      threw = true;
    }
    if (!threw) {
      expect(result!.completed).toBe(false);
    }
    // Whatever partial rows the requester holds, they must not mix versions:
    // the pre-mutation publishedAt row and the post-mutation replacement row
    // can never coexist in one assembled row-group.
    const objects = (result?.quads ?? []).map((quad) => quad.object).join('\n');
    expect(objects.includes('"replacement"') && objects.includes(fresh)).toBe(false);
    await store.close();
  });
});
