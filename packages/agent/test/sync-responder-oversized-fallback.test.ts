import { describe, it, expect } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, MemoryLayer } from '@origintrail-official/dkg-core';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
  subGraphRegistrationQuads,
  workspaceOpQuads,
  type CapturedSyncHandler,
} from './_helpers/sync-responder.js';
import { estimateStringRowHeapBytes } from '../src/sync/memory-telemetry.js';
import { readDurableDataPage, serializeResponderRows } from '../src/sync/responder/graph-plan.js';
import { SyncRowSnapshotBudgetError } from '../src/sync/responder/snapshot-budget.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

/**
 * The oversized-snapshot fallbacks for durable-meta and TTL-cutoff SWM-data now
 * use store-bounded paged SPARQL (readDurableMetaRowsPage / readFreshSwmDataRowsPage)
 * instead of re-materializing the complete filtered set per page. These tests
 * prove the paged path returns the SAME SET of rows as the canonical in-memory
 * filter, and that it issues bounded ORDER BY/OFFSET/LIMIT store queries.
 *
 * The canonical result is produced by the SAME handler with a generous budget
 * (cached path → readDurableMetaRows / readFreshSwmDataRows); the paged result
 * is produced with a tiny per-snapshot budget that forces the fallback.
 */

const TINY_SNAPSHOT_BUDGET = {
  maxRows: 1_000_000,
  maxBytesEstimate: Number.MAX_SAFE_INTEGER,
  maxSnapshotRows: 1,
  maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
} as const;

async function collectAllPages(
  cap: CapturedSyncHandler,
  base: Omit<SyncRequestEnvelope, 'offset'>,
  pageSize: number,
): Promise<Set<string>> {
  const lines = new Set<string>();
  for (let offset = 0, page = 0; page < 200; page += 1, offset += pageSize) {
    const out = await cap.invoke({ ...base, offset });
    const pageLines = linesFromNquads(out);
    for (const line of pageLines) lines.add(line);
    if (pageLines.length < pageSize) break;
  }
  return lines;
}

describe('oversized responder fallback is store-bounded and set-equivalent', () => {
  it('durable-meta paged fallback matches the canonical filter across every branch', async () => {
    const cgId = 'oversized-meta-equiv';
    const cgEntity = `did:dkg:context-graph:${cgId}`;
    const meta = `${cgEntity}/_meta`;
    const WM = `"${MemoryLayer.WorkingMemory}"`; // "WM"
    const VM = `"${MemoryLayer.VerifiableMemory}"`; // "VM"
    const activeDelegation = `did:dkg:agent-delegation:${cgId}:0xactive`;
    const orphanedDelegation = `did:dkg:agent-delegation:${cgId}:0xorphaned`;
    const revokedDelegation = `did:dkg:agent-delegation:${cgId}:0xrevoked`;
    const confirmedV2 = 'did:dkg:base:8453/0x00000000000000000000000000000000000000ab/7';
    const tentativeV2 = 'did:dkg:base:8453/0x00000000000000000000000000000000000000ab/8';

    const quads: Quad[] = [
      // A: the CG entity subject
      { graph: meta, subject: cgEntity, predicate: 'http://schema.org/name', object: '"cg-root"' },
      // A2: only an allowed, non-revoked agent's delegation is durable meta.
      { graph: meta, subject: cgEntity, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: '"0xAcTiVe"' },
      { graph: meta, subject: activeDelegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: '"0xactive"' },
      { graph: meta, subject: activeDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"peer-active"' },
      { graph: meta, subject: orphanedDelegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: '"0xorphaned"' },
      { graph: meta, subject: orphanedDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"peer-orphaned"' },
      { graph: meta, subject: cgEntity, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: '"0xrevoked"' },
      { graph: meta, subject: cgEntity, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: '"0xReVoKeD"' },
      { graph: meta, subject: revokedDelegation, predicate: DKG_ONTOLOGY.DKG_DELEGATION_AGENT, object: '"0xrevoked"' },
      { graph: meta, subject: revokedDelegation, predicate: DKG_ONTOLOGY.DKG_ALLOWED_DELEGATEE_PEER, object: '"peer-revoked"' },
      // B: a registered sub-graph subject (registration rows are keyed on it)
      ...subGraphRegistrationQuads(cgId, 'sub1'),
      // C: activity is durable member metadata. Pending join requests are
      // curator-only moderation records and must not be replicated.
      { graph: meta, subject: 'did:dkg:activity:act1', predicate: `${DKG_NS}note`, object: '"act"' },
      { graph: meta, subject: 'did:dkg:join-request:jr1', predicate: `${DKG_NS}note`, object: '"jr"' },
      { graph: meta, subject: 'did:dkg:join-request:jr1', predicate: `${DKG_NS}memoryLayer`, object: VM },
      // E: a non-working lifecycle (kept); its own rows are kept
      { graph: meta, subject: 'urn:lc:vm', predicate: `${DKG_NS}memoryLayer`, object: VM },
      { graph: meta, subject: 'urn:lc:vm', predicate: `${DKG_NS}assertionGraph`, object: 'urn:ag:1' },
      { graph: meta, subject: 'urn:lc:vm', predicate: `${DKG_NS}assertionName`, object: '"myassert"' },
      // E dual: a subject carrying BOTH a WM and a non-WM layer must be kept
      { graph: meta, subject: 'urn:lc:dual', predicate: `${DKG_NS}memoryLayer`, object: WM },
      { graph: meta, subject: 'urn:lc:dual', predicate: `${DKG_NS}memoryLayer`, object: VM },
      // F: assertion graph object of a non-working lifecycle → its rows kept
      { graph: meta, subject: 'urn:ag:1', predicate: `${DKG_NS}label`, object: '"assertion-graph-row"' },
      // G: event subjects referencing the non-working lifecycle (generated + used)
      { graph: meta, subject: 'urn:event:gen', predicate: `${DKG_NS}generated`, object: 'urn:lc:vm' },
      { graph: meta, subject: 'urn:event:gen', predicate: 'http://www.w3.org/ns/prov#generated', object: 'urn:lc:vm' },
      { graph: meta, subject: 'urn:event:used', predicate: 'http://www.w3.org/ns/prov#used', object: 'urn:lc:vm' },
      // H: an /assertion/ subject ending with a non-working lifecycle's assertion name
      { graph: meta, subject: `${cgEntity}/assertion/0xabc/myassert`, predicate: `${DKG_NS}label`, object: '"assertion-name-hit"' },
      // I: rootless descriptors do not carry legacy memoryLayer. Confirmed V2
      // metadata is durable; tentative V2 metadata remains workspace-local.
      { graph: meta, subject: confirmedV2, predicate: `${DKG_NS}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { graph: meta, subject: confirmedV2, predicate: `${DKG_NS}status`, object: '"confirmed"' },
      { graph: meta, subject: confirmedV2, predicate: `${DKG_NS}label`, object: '"confirmed-v2-row"' },
      { graph: meta, subject: tentativeV2, predicate: `${DKG_NS}contentScopeVersion`, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' },
      { graph: meta, subject: tentativeV2, predicate: `${DKG_NS}status`, object: '"tentative"' },
      { graph: meta, subject: tentativeV2, predicate: `${DKG_NS}label`, object: '"tentative-v2-row"' },

      // ---- negatives that MUST be excluded by both paths ----
      // working-only lifecycle, matches no other branch
      { graph: meta, subject: 'urn:lc:wm', predicate: `${DKG_NS}memoryLayer`, object: WM },
      // event referencing a WORKING lifecycle → not an admitted event subject
      { graph: meta, subject: 'urn:event:wm', predicate: 'http://www.w3.org/ns/prov#generated', object: 'urn:lc:wm' },
      // working lifecycle's assertion name must NOT admit a matching /assertion/ subject
      { graph: meta, subject: 'urn:lc:wmname', predicate: `${DKG_NS}memoryLayer`, object: WM },
      { graph: meta, subject: 'urn:lc:wmname', predicate: `${DKG_NS}assertionName`, object: '"wmname"' },
      { graph: meta, subject: `${cgEntity}/assertion/0xghi/wmname`, predicate: `${DKG_NS}label`, object: '"working-name-should-be-excluded"' },
      // empty-name guard: /assertion/ subject ending in "/" must not be admitted
      { graph: meta, subject: 'urn:lc:emptyname', predicate: `${DKG_NS}memoryLayer`, object: VM },
      { graph: meta, subject: 'urn:lc:emptyname', predicate: `${DKG_NS}assertionName`, object: '""' },
      { graph: meta, subject: `${cgEntity}/assertion/0xdef/`, predicate: `${DKG_NS}label`, object: '"empty-name-should-be-excluded"' },
      // pure noise
      { graph: meta, subject: 'urn:noise', predicate: `${DKG_NS}label`, object: '"noise-should-be-excluded"' },
    ];

    const canonicalStore = new OxigraphStore();
    await canonicalStore.insert(quads);
    const paged = new OxigraphStore();
    await paged.insert(quads);

    const canonicalCap = registerTestSyncHandler(canonicalStore, { syncPageSize: 5000 });
    const pagedCap = registerTestSyncHandler(paged, {
      syncPageSize: 3,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });

    const canonical = await collectAllPages(
      canonicalCap,
      { contextGraphId: cgId, includeSharedMemory: false, phase: 'meta', limit: 5000, syncSessionId: 'canon' },
      5000,
    );
    const boundedQuery = watchBoundedMetaPageQuery(paged, meta);
    const pagedResult = await collectAllPages(
      pagedCap,
      { contextGraphId: cgId, includeSharedMemory: false, phase: 'meta', limit: 3, syncSessionId: 'paged' },
      3,
    );

    // The paged fallback is set-equivalent to the canonical in-memory filter.
    expect(pagedResult).toEqual(canonical);
    // …and it actually paged in the store (bounded ORDER BY/OFFSET/LIMIT).
    boundedQuery.assertObserved();

    // Sanity: the fixture really exercised the branches we think it did.
    const has = (subject: string) => [...canonical].some((line) => line.startsWith(`<${subject}>`));
    expect(has(cgEntity)).toBe(true); // A
    expect(has(activeDelegation)).toBe(true); // A2 active delegation
    expect(has(orphanedDelegation)).toBe(false);
    expect(has(revokedDelegation)).toBe(false);
    expect(has(`${cgEntity}/sub1`)).toBe(true); // B
    expect(has('did:dkg:activity:act1')).toBe(true); // C
    expect(has('did:dkg:join-request:jr1')).toBe(false);
    expect(has('urn:lc:vm')).toBe(true); // E
    expect(has('urn:lc:dual')).toBe(true); // E dual
    expect(has('urn:ag:1')).toBe(true); // F
    expect(has('urn:event:gen')).toBe(true); // G generated
    expect(has('urn:event:used')).toBe(true); // G used
    expect(has(`${cgEntity}/assertion/0xabc/myassert`)).toBe(true); // H
    expect(has(confirmedV2)).toBe(true); // I confirmed V2
    expect(has(tentativeV2)).toBe(false);
    // negatives
    expect([...canonical].join('\n')).not.toContain('noise-should-be-excluded');
    expect([...canonical].join('\n')).not.toContain('working-name-should-be-excluded');
    expect([...canonical].join('\n')).not.toContain('empty-name-should-be-excluded');
    expect(has('urn:event:wm')).toBe(false);
  });

  it('TTL-cutoff SWM-data paged fallback matches the canonical filter and stays bounded', async () => {
    const cgId = 'oversized-swm-data-equiv';
    const cgPrefix = `did:dkg:context-graph:${cgId}`;
    const now = Date.now();
    const recent = new Date(now - 1_000).toISOString();
    const stale = new Date(now - 10 * 60_000).toISOString(); // older than the 60s cutoff

    // Two SWM sub-graph buckets, each with its own _meta workspace operations.
    const bucketA = `${cgPrefix}/_shared_memory`;
    const bucketAData = `${bucketA}/0xaaa/1`;
    const bucketAMeta = `${bucketA}_meta`;
    const bucketB = `${cgPrefix}/subb/_shared_memory`;
    const bucketBData = `${bucketB}/0xbbb/1`;
    const bucketBMeta = `${bucketB}_meta`;

    const quads: Quad[] = [
      // register subb so it is an admitted SWM sub-graph
      ...subGraphRegistrationQuads(cgId, 'subb'),

      // bucket A: a recent root with a direct row and a skolem child (both kept)
      ...workspaceOpQuads(cgId, 'opA', 'urn:root:A', bucketAMeta, recent),
      { graph: bucketAData, subject: 'urn:root:A', predicate: `${DKG_NS}label`, object: '"A-root-row"' },
      { graph: bucketAData, subject: 'urn:root:A/.well-known/genid/child', predicate: `${DKG_NS}label`, object: '"A-skolem-row"' },
      // bucket A: a STALE root (older than cutoff) whose row must be excluded
      ...workspaceOpQuads(cgId, 'opAold', 'urn:root:Aold', bucketAMeta, stale),
      { graph: bucketAData, subject: 'urn:root:Aold', predicate: `${DKG_NS}label`, object: '"A-stale-should-be-excluded"' },
      // bucket A: a data subject with no matching root at all → excluded
      { graph: bucketAData, subject: 'urn:orphan', predicate: `${DKG_NS}label`, object: '"orphan-should-be-excluded"' },

      // bucket B: a recent root with a row (kept)
      ...workspaceOpQuads(cgId, 'opB', 'urn:root:B', bucketBMeta, recent),
      { graph: bucketBData, subject: 'urn:root:B', predicate: `${DKG_NS}label`, object: '"B-root-row"' },
      // bucket B: a recent root with NO data rows (contributes nothing, must not error)
      ...workspaceOpQuads(cgId, 'opBempty', 'urn:root:Bempty', bucketBMeta, recent),
    ];

    const canonicalStore = new OxigraphStore();
    await canonicalStore.insert(quads);
    const paged = new OxigraphStore();
    await paged.insert(quads);

    const base = {
      contextGraphId: cgId,
      includeSharedMemory: true,
      phase: 'data' as const,
    };
    const canonicalCap = registerTestSyncHandler(canonicalStore, { sharedMemoryTtlMs: 60_000, syncPageSize: 5000 });
    const pagedCap = registerTestSyncHandler(paged, {
      sharedMemoryTtlMs: 60_000,
      syncPageSize: 2,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });

    const canonical = await collectAllPages(
      canonicalCap,
      { ...base, limit: 5000, syncSessionId: 'canon-swm' },
      5000,
    );
    const boundedQuery = watchBoundedSwmDataPageQuery(paged);
    const pagedResult = await collectAllPages(
      pagedCap,
      { ...base, limit: 2, syncSessionId: 'paged-swm' },
      2,
    );

    expect(pagedResult).toEqual(canonical);
    boundedQuery.assertObserved();

    const joined = [...canonical].join('\n');
    expect(joined).toContain('"A-root-row"');
    expect(joined).toContain('"A-skolem-row"');
    expect(joined).toContain('"B-root-row"');
    expect(joined).not.toContain('A-stale-should-be-excluded');
    expect(joined).not.toContain('orphan-should-be-excluded');
  });

  it('does not mix a stale cached snapshot into a superseding over-budget session', async () => {
    const store = new OxigraphStore();
    const cgId = 'refresh-over-budget';
    const dataGraph = `did:dkg:context-graph:${cgId}/context/1`;
    const row = (index: number): Quad => ({
      graph: dataGraph,
      subject: `urn:rob:${index.toString().padStart(3, '0')}`,
      predicate: `${DKG_NS}label`,
      object: `"row-${index.toString().padStart(3, '0')}"`,
    });
    await store.insert([row(0), row(1)]);

    const cap = registerTestSyncHandler(store, {
      syncPageSize: 2,
      snapshotBudget: {
        maxRows: 1000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 2, // the 2-row snapshot fits; a later 3-row snapshot does not
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = { contextGraphId: cgId, includeSharedMemory: false, phase: 'data' as const, limit: 2 };

    // Session T1 caches the stable 2-row snapshot.
    expect(linesFromNquads(await cap.invoke({ ...base, offset: 0, syncSessionId: 'T1' }))).toHaveLength(2);

    // The graph grows past the per-snapshot cap.
    await store.insert([row(2)]);

    // Session T2 supersedes T1 at offset 0 (refresh): over cap → fresh fallback page.
    const t2page0 = await cap.invoke({ ...base, offset: 0, syncSessionId: 'T2' });
    // A later page of T2 must fall back too — never resume T1's stale 2-row snapshot.
    const t2page1 = await cap.invoke({ ...base, offset: 2, syncSessionId: 'T2' });

    const t2 = new Set(linesFromNquads(`${t2page0}\n${t2page1}`));
    // All three CURRENT rows, no stale mix and no dropped grown row (row-002).
    expect(t2.size).toBe(3);
    expect([...t2].join('\n')).toContain('"row-002"');
  });

  it('falls back to store-bounded paging for a BYTE-oversized durable snapshot', async () => {
    // Byte limits are a separate production budget from the row cap and fire
    // first for long RDF terms. Exercise the handler path under a low
    // maxSnapshotBytesEstimate with a high row cap, so the rejection is
    // snapshot_bytes (not snapshot_rows), and prove the graph still syncs.
    const store = new OxigraphStore();
    const cgId = 'byte-oversized';
    const dataGraph = `did:dkg:context-graph:${cgId}/context/1`;
    const rows: Quad[] = [0, 1].map((index) => ({
      graph: dataGraph,
      subject: `urn:byte:${index}`,
      predicate: `${DKG_NS}label`,
      object: `"${'x'.repeat(600)}-${index}"`,
    }));
    await store.insert(rows);
    const perRowBytes = estimateStringRowHeapBytes(
      rows[0].subject,
      rows[0].predicate,
      rows[0].object,
      rows[0].graph,
    );

    const cap = registerTestSyncHandler(store, {
      syncPageSize: 1,
      snapshotBudget: {
        maxRows: 1_000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 100, // the row cap does NOT bind (2 rows)
        maxSnapshotBytesEstimate: perRowBytes + 10, // one row fits; the 2-row snapshot does not
      },
    });
    const boundedQuery = watchBoundedDataPageQuery(store, dataGraph);
    const collected = await collectAllPages(
      cap,
      { contextGraphId: cgId, includeSharedMemory: false, phase: 'data', limit: 1, syncSessionId: 'byte-oversized-session' },
      1,
    );

    // Both rows are served through the store-bounded fallback, not a limit error.
    expect(collected.size).toBe(2);
    boundedQuery.assertObserved();
  });

  it('uses a session cursor after the first oversized exact-graph page', async () => {
    const cgId = 'exact-graph-keyset';
    const graph = `did:dkg:context-graph:${cgId}/context/1`;
    const rows: Quad[] = [];
    for (let subjectIndex = 0; subjectIndex < 300; subjectIndex += 1) {
      const subject = `urn:keyset:${subjectIndex.toString().padStart(4, '0')}`;
      rows.push(
        { graph, subject, predicate: `${DKG_NS}label`, object: `urn:object:${subjectIndex}` },
        { graph, subject, predicate: `${DKG_NS}label`, object: `"value-${subjectIndex}"` },
        { graph, subject, predicate: `${DKG_NS}label`, object: `"value-${subjectIndex}"@en` },
        {
          graph,
          subject,
          predicate: `${DKG_NS}label`,
          object: `"${subjectIndex}"^^<http://www.w3.org/2001/XMLSchema#integer>`,
        },
      );
    }

    const store = new OxigraphStore();
    await store.insert(rows);
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 37,
      snapshotBudget: {
        maxRows: 10_000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });

    const pageQueryOffsets: number[] = [];
    let seekPageQueries = 0;
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: Parameters<OxigraphStore['query']>[1]) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (
        normalized.includes(`GRAPH <${graph}>`)
        && normalized.includes('ORDER BY ?s ?p ?o')
        && normalized.includes('SELECT ?s ?p ?o WHERE')
        && normalized.includes('LIMIT')
      ) {
        const offsetMatch = normalized.match(/OFFSET (\d+)/);
        if (offsetMatch) pageQueryOffsets.push(Number(offsetMatch[1]));
        else if (normalized.includes('FILTER(')) seekPageQueries += 1;
      }
      return originalQuery(sparql, options);
    }) as OxigraphStore['query'];

    const actual: string[] = [];
    for (let offset = 0; offset < rows.length; offset += 37) {
      const page = await cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: false,
        phase: 'data',
        limit: 37,
        offset,
        syncSessionId: 'exact-graph-keyset-session',
      });
      const pageLines = linesFromNquads(page);
      actual.push(...pageLines);
      if (pageLines.length < 37) break;
    }

    const expectedResult = await originalQuery(`
      SELECT ?s ?p ?o WHERE {
        GRAPH <${graph}> { ?s ?p ?o }
      }
      ORDER BY ?s ?p ?o
    `);
    if (expectedResult.type !== 'bindings') throw new Error('expected bindings');
    const expected = serializeResponderRows(expectedResult.bindings.map((row) => ({
      s: row.s!,
      p: row.p!,
      o: row.o!,
      g: graph,
    })));

    expect(actual).toEqual(expected.split('\n'));
    expect(actual).toHaveLength(rows.length);
    expect(new Set(actual)).toHaveLength(rows.length);
    // The first page retains the compatibility OFFSET 0 query. Every later
    // page seeks from the session cursor and therefore has no growing OFFSET.
    expect(pageQueryOffsets).toEqual([0]);
    expect(seekPageQueries).toBeGreaterThan(1);
  });

  it('uses OFFSET compatibility paging when a cursor contains a blank node', async () => {
    const cgId = 'exact-graph-blank-cursor';
    const graph = `did:dkg:context-graph:${cgId}/context/1`;
    const store = new OxigraphStore();
    await store.insert([
      { graph, subject: '_:blank', predicate: 'urn:test:p', object: '"blank"' },
      { graph, subject: 'urn:after', predicate: 'urn:test:p', object: '"after"' },
    ]);
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 1,
      snapshotBudget: {
        maxRows: 100,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const offsets: number[] = [];
    const originalQuery = store.query.bind(store);
    store.query = (async (sparql: string, options?: Parameters<OxigraphStore['query']>[1]) => {
      const normalized = sparql.replace(/\s+/g, ' ').trim();
      if (normalized.includes(`GRAPH <${graph}>`) && normalized.includes('ORDER BY ?s ?p ?o')) {
        const match = normalized.match(/OFFSET (\d+)/);
        if (match) offsets.push(Number(match[1]));
      }
      return originalQuery(sparql, options);
    }) as OxigraphStore['query'];

    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 1,
      syncSessionId: 'blank-cursor-session',
    };
    const first = linesFromNquads(await cap.invoke({ ...base, offset: 0 }));
    const second = linesFromNquads(await cap.invoke({ ...base, offset: 1 }));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).toContain('_:');
    expect(new Set([...first, ...second])).toHaveLength(2);
    // Blank-node ordering is backend-local, so the second page must retain
    // the deterministic numeric OFFSET path rather than emit a keyset filter.
    expect(offsets).toContain(1);
  });

  it('keeps exact-graph cursor memory bounded while serving many pages', async () => {
    const cgId = 'exact-graph-cursor-eviction';
    const graph = `did:dkg:context-graph:${cgId}/context/1`;
    const store = new OxigraphStore();
    const rowCount = 513;
    await store.insert(Array.from({ length: rowCount }, (_, index) => ({
      graph,
      subject: `urn:evict:${index.toString().padStart(4, '0')}`,
      predicate: 'urn:test:p',
      object: `"row-${index}"`,
    })));
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 1,
      snapshotBudget: {
        maxRows: 1000,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        maxSnapshotRows: 1,
        maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
      },
    });
    const base = {
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'data' as const,
      limit: 1,
      syncSessionId: 'cursor-eviction-session',
    };
    for (let offset = 0; offset < rowCount; offset += 1) {
      expect(linesFromNquads(await cap.invoke({ ...base, offset }))).toHaveLength(1);
    }
  });

  it('fails closed on cursor boundaries and preserves graph transitions', async () => {
    const cgId = 'exact-graph-cursor-invariants';
    const graphA = `did:dkg:context-graph:${cgId}/a`;
    const graphB = `did:dkg:context-graph:${cgId}/b`;
    const store = new OxigraphStore();
    const row = (graph: string, subject: string, object = '"value"') => ({
      graph,
      subject,
      predicate: 'urn:test:p',
      object,
    });
    await store.insert([
      row(graphA, 'urn:a:0'),
      row(graphA, 'urn:a:1'),
      row(graphB, 'urn:b:0'),
      row(graphB, 'urn:b:1'),
    ]);

    type Plan = {
      entries: readonly { graph: string; rowCount: number }[];
      totalRows: number;
      pagedGraphs: Set<string>;
      cursors: Map<number, {
        graph: string;
        graphOffset: number;
        s: string;
        p: string;
        o: string;
      } | null>;
    };
    const pageMemo = {
      snapshotLoadLimits: {
        maxRows: 1,
        maxBytesEstimate: Number.MAX_SAFE_INTEGER,
        pageRows: 1,
      },
      get: async () => {
        throw new SyncRowSnapshotBudgetError({
          key: 'cursor-invariants',
          reason: 'snapshot_rows',
          rows: 2,
          bytesEstimate: 0,
          limit: 1,
        });
      },
      release: () => {},
    };
    const use = async (plan: Plan, offset: number, limit: number) => {
      const exactMemo = { get: async () => plan };
      return readDurableDataPage({
        store,
        graphMembership: {} as never,
        contextGraphId: cgId,
        sinceBatchId: null,
        offset,
        limit,
        rowListMemo: pageMemo,
        rowListCacheScope: 'cursor-invariants',
        exactGraphPlanMemo: exactMemo,
      });
    };

    const basePlan = (cursors: Plan['cursors'], totalRows = 4): Plan => ({
      entries: [
        { graph: graphA, rowCount: 2 },
        { graph: graphB, rowCount: 2 },
      ],
      totalRows,
      pagedGraphs: new Set([graphA, graphB]),
      cursors,
    });
    const cursorA0 = {
      graph: graphA,
      graphOffset: 1,
      s: 'urn:a:0',
      p: 'urn:test:p',
      o: '"value"',
    };
    const crossGraph = basePlan(new Map([[1, cursorA0]]));
    // The cursor is in graph A, but the requested page continues into graph B.
    expect(await use(crossGraph, 1, 2)).toHaveLength(2);

    const cursorInLaterGraph = basePlan(new Map([[2, {
      graph: graphB,
      graphOffset: 1,
      s: 'urn:b:0',
      p: 'urn:test:p',
      o: '"value"',
    }]]));
    // Earlier plan entries are skipped while the cursor's graph is found.
    expect(await use(cursorInLaterGraph, 2, 1)).toHaveLength(1);

    const cursorBeforePlan = {
      entries: [{ graph: graphB, rowCount: 2 }],
      totalRows: 2,
      pagedGraphs: new Set([graphB]),
      cursors: new Map([[0, {
        graph: graphA,
        graphOffset: 1,
        s: 'urn:a:0',
        p: 'urn:test:p',
        o: '"value"',
      }]]),
    } satisfies Plan;
    // A retained cursor can outlive a narrowed graph inventory; later graphs
    // still begin at row zero and remain readable.
    expect(await use(cursorBeforePlan, 0, 1)).toHaveLength(1);

    const offsetSkip = basePlan(new Map([[0, null]]));
    expect(await use(offsetSkip, 2, 1)).toHaveLength(1);

    const changing: Plan = {
      entries: [{ graph: graphA, rowCount: 2 }],
      totalRows: 2,
      pagedGraphs: new Set([graphA]),
      cursors: new Map([[0, null]]),
    };
    await use(changing, 0, 1);
    await use(changing, 1, 1);
    await store.delete([row(graphA, 'urn:a:1')]);
    await store.insert([row(graphA, 'urn:a:2')]);
    // Replaying the same numeric page after a same-count replacement must not
    // overwrite the session boundary with a different cursor.
    await expect(use(changing, 1, 1)).rejects.toThrow(/cursor changed at offset 2/);

    const boundary = basePlan(new Map([[2, {
      ...cursorA0,
      graphOffset: 2,
    }]]));
    // A cursor exactly at graph A's end skips its zero-row slice and starts B.
    expect(await use(boundary, 2, 1)).toHaveLength(1);

    const pastCount = basePlan(new Map([[1, {
      ...cursorA0,
      graphOffset: 3,
    }]]));
    await expect(use(pastCount, 1, 1)).rejects.toThrow(/past the committed row count/);

    const inconsistentTotal: Plan = {
      entries: [{ graph: graphA, rowCount: 2 }],
      totalRows: 3,
      pagedGraphs: new Set([graphA]),
      cursors: new Map([[0, null]]),
    };
    await expect(use(inconsistentTotal, 0, 3)).rejects.toThrow(/plan changed at offset 0/);
  });
});

/** Assert the durable-data fallback addressed one exact graph per bounded page query. */
function watchBoundedDataPageQuery(store: OxigraphStore, graph: string) {
  const originalQuery = store.query.bind(store);
  let observed = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (
      /^SELECT \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`GRAPH <${graph}>`) &&
      normalized.includes('ORDER BY ?s ?p ?o') &&
      /OFFSET \d+/.test(normalized) &&
      /LIMIT \d+/.test(normalized)
    ) {
      expect(normalized).not.toContain('VALUES ?g');
      observed += 1;
    }
    return originalQuery(sparql);
  }) as OxigraphStore['query'];
  return { assertObserved: () => expect(observed).toBeGreaterThan(0) };
}

/** Assert the durable-meta fallback issued a bounded, single-graph paged query. */
function watchBoundedMetaPageQuery(store: OxigraphStore, metaGraph: string) {
  const originalQuery = store.query.bind(store);
  let observed = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (
      /^SELECT \?g \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes(`VALUES ?g { <${metaGraph}> }`) &&
      normalized.includes('ORDER BY ?g ?s ?p ?o') &&
      /OFFSET \d+/.test(normalized) &&
      /LIMIT \d+/.test(normalized)
    ) {
      observed += 1;
    }
    return originalQuery(sparql);
  }) as OxigraphStore['query'];
  return { assertObserved: () => expect(observed).toBeGreaterThan(0) };
}

/** Assert the SWM-data fallback issued a concrete-graph, mapped-root paged query. */
function watchBoundedSwmDataPageQuery(store: OxigraphStore) {
  const originalQuery = store.query.bind(store);
  let observed = 0;
  store.query = (async (sparql: string) => {
    const normalized = sparql.replace(/\s+/g, ' ').trim();
    if (
      /^SELECT DISTINCT \?s \?p \?o WHERE \{/.test(normalized) &&
      normalized.includes('VALUES ?root') &&
      normalized.includes('GRAPH <') &&
      normalized.includes('ORDER BY ?s ?p ?o') &&
      /OFFSET \d+/.test(normalized) &&
      /LIMIT \d+/.test(normalized)
    ) {
      observed += 1;
    }
    return originalQuery(sparql);
  }) as OxigraphStore['query'];
  return { assertObserved: () => expect(observed).toBeGreaterThan(0) };
}
