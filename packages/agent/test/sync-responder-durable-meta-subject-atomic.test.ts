import { describe, expect, it } from 'vitest';
import { contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  readDurableMetaPage,
  type SyncRowListMemo,
} from '../src/sync/responder/graph-plan.js';
import { DKG_NS } from './_helpers/sync-responder.js';

/**
 * Regression for #1788: durable sync must never split a graph-scoped assertion
 * seal's `_meta` rows across a page — and therefore across a sync round — or the
 * batch-local control field `dkg:assertionVersion` is admitted alone and dropped
 * (13/14) permanently on curated CGs.
 *
 * The responder now serves durable-meta pages that always END on a `(g, s)`
 * subject boundary: a subject straddling the requested row limit is emitted in
 * full (the page extends past `limit`). Both the cached (session snapshot) and
 * the store-paged (no-session / oversized-fallback) loaders enforce this. Meta
 * uses byte-budget pagination (requester page size 8192 > the 500 legacy cap),
 * so an over-sized page is transparent to the cursor: the requester advances by
 * the actual row count and the next OFFSET lands on the next subject.
 */

type Row = { s: string; p: string; o: string; g: string };

const CG = 'cg-1788';
const META = contextGraphMetaGraphUri(CG);

// A graph-scoped author seal: one subject, 14 `_meta` quads, incl. the control
// field dkg:assertionVersion whose loss is the #1788 symptom.
const SEAL_SUBJECT = `did:dkg:context-graph:${CG}/assertion/0xabcdef0123456789abcdef0123456789abcdef01/report`;
const SEAL_PREDICATES = [
  'assertionVersion',
  'merkleRoot',
  'kaUal',
  'assertionGraph',
  'contentScopeVersion',
  'publicTripleCount',
  'privateTripleCount',
  'privateMerkleRoot',
  'contextGraph',
  'batchId',
  'status',
  'reservedUal',
  'subGraphName',
  'rootEntity',
];
const ASSERTION_VERSION = `${DKG_NS}assertionVersion`;

function sealRows(subject: string, graph: string): Row[] {
  return SEAL_PREDICATES.map((name, index) => ({
    s: subject,
    p: `${DKG_NS}${name}`,
    o: `"seal-${name}-${index}"`,
    g: graph,
  }));
}

/**
 * Drive a durable-meta phase exactly as the requester does: advance the offset
 * by the number of rows actually served each page until an empty page (EOF).
 */
async function pageThrough(
  fetchPage: (offset: number, limit: number) => Promise<readonly Row[]>,
  limit: number,
): Promise<Row[][]> {
  const pages: Row[][] = [];
  let offset = 0;
  // Bounded so a cursor bug (no forward progress) fails loudly instead of hanging.
  for (let guard = 0; guard < 1_000; guard += 1) {
    const page = await fetchPage(offset, limit);
    if (page.length === 0) return pages;
    pages.push([...page]);
    offset += page.length;
  }
  throw new Error('durable-meta paging did not terminate — cursor made no forward progress');
}

function sealRowCount(page: readonly Row[]): number {
  return page.filter((row) => row.s === SEAL_SUBJECT).length;
}

function assertSubjectAtomicAndComplete(pages: Row[][]): void {
  // 0-or-14 invariant: no page may carry a proper subset of the seal's rows.
  for (const page of pages) {
    const count = sealRowCount(page);
    expect([0, SEAL_PREDICATES.length]).toContain(count);
  }
  // The whole seal materialises exactly once, including dkg:assertionVersion.
  const sealRowsSeen = pages.flat().filter((row) => row.s === SEAL_SUBJECT);
  expect(sealRowsSeen).toHaveLength(SEAL_PREDICATES.length);
  expect(sealRowsSeen.some((row) => row.p === ASSERTION_VERSION)).toBe(true);
  // No page is empty before EOF (the loop stops on the first empty page).
  for (const page of pages) expect(page.length).toBeGreaterThan(0);
}

function assertNoDuplicatesOrGaps(pages: Row[][]): void {
  const keys = pages.flat().map((row) => `${row.g}\n${row.s}\n${row.p}\n${row.o}`);
  // Cursor continuity: every served row appears exactly once across all pages
  // (no duplicate from the extension, no gap from the offset advance).
  expect(new Set(keys).size).toBe(keys.length);
}

describe('durable-meta subject-atomic paging (#1788)', () => {
  it('cached path: extends a page across the seal boundary, never splitting it', async () => {
    const limit = 10;
    const fillerA: Row[] = Array.from({ length: 5 }, (_, i) => ({
      s: `urn:fillerA:${i}`, p: `${DKG_NS}label`, o: `"a-${i}"`, g: META,
    }));
    const fillerB: Row[] = Array.from({ length: 5 }, (_, i) => ({
      s: `urn:fillerB:${i}`, p: `${DKG_NS}label`, o: `"b-${i}"`, g: META,
    }));
    // The 14-row seal starts at index 5, so a raw slice(0,10) would tear it
    // 5/14 — exactly the #1788 split.
    const snapshot: Row[] = [...fillerA, ...sealRows(SEAL_SUBJECT, META), ...fillerB];
    const memo: SyncRowListMemo = {
      get: async () => snapshot,
      release: () => {},
    };

    const pages = await pageThrough(
      (offset, pageLimit) => readDurableMetaPage({
        store: {} as OxigraphStore,
        contextGraphId: CG,
        registeredSubGraphNames: [],
        offset,
        limit: pageLimit,
        rowListMemo: memo,
        rowListCacheKey: 'durable-meta:1788:cached',
      }),
      limit,
    );

    assertSubjectAtomicAndComplete(pages);
    assertNoDuplicatesOrGaps(pages);

    // Page 1 extends from index 0 through the whole seal (5 filler + 14 seal),
    // and stops exactly at the subject boundary — it must NOT leak fillerB.
    expect(pages[0]).toHaveLength(fillerA.length + SEAL_PREDICATES.length);
    expect(pages[0].some((row) => row.s.startsWith('urn:fillerB:'))).toBe(false);
    // Page 2 resumes exactly after the seal with the trailing filler.
    expect(sealRowCount(pages[1])).toBe(0);
    expect(pages[1].map((row) => row.s)).toEqual(fillerB.map((row) => row.s));
    // Every snapshot row is delivered exactly once across the two pages.
    expect(pages.flat()).toHaveLength(snapshot.length);
  });

  it('store-paged path: completes a straddling subject from the store', async () => {
    const limit = 10;
    const store = new OxigraphStore();
    // Filler subjects sort before the straddling subject (activity < the
    // seal-carrying `did:dkg:activity:seal-report`), each contributing one row;
    // all are admitted by the `did:dkg:activity:` prefix so the real durable
    // admission filter runs. The 14-row straddling subject carries a literal
    // dkg:assertionVersion, so this exercises the store OFFSET/LIMIT window plus
    // the complete-subject continuation query end to end.
    const straddling = 'did:dkg:activity:seal-report';
    const filler: Quad[] = Array.from({ length: 5 }, (_, i) => ({
      graph: META,
      subject: `did:dkg:activity:f0${i}`,
      predicate: `${DKG_NS}label`,
      object: `"f-${i}"`,
    }));
    const straddlingQuads: Quad[] = SEAL_PREDICATES.map((name, index) => ({
      graph: META,
      subject: straddling,
      predicate: `${DKG_NS}${name}`,
      object: `"seal-${name}-${index}"`,
    }));
    await store.insert([...filler, ...straddlingQuads]);

    const pages = await pageThrough(
      async (offset, pageLimit) => {
        const page = await readDurableMetaPage({
          store,
          contextGraphId: CG,
          registeredSubGraphNames: [],
          offset,
          limit: pageLimit,
        });
        return page.map((row) => ({ s: row.s, p: row.p, o: row.o, g: row.g }));
      },
      limit,
    );

    const straddlingCount = (page: readonly Row[]) =>
      page.filter((row) => row.s === straddling).length;
    // 0-or-14 invariant on the straddling subject across all pages.
    for (const page of pages) expect([0, SEAL_PREDICATES.length]).toContain(straddlingCount(page));
    const straddlingRows = pages.flat().filter((row) => row.s === straddling);
    expect(straddlingRows).toHaveLength(SEAL_PREDICATES.length);
    expect(straddlingRows.some((row) => row.p === ASSERTION_VERSION)).toBe(true);
    // Page 1 extends past the limit to complete the subject (5 filler + 14).
    expect(pages[0]).toHaveLength(filler.length + SEAL_PREDICATES.length);
    assertNoDuplicatesOrGaps(pages);
    // Every admitted row delivered exactly once; the next offset lands on EOF.
    expect(pages.flat()).toHaveLength(filler.length + SEAL_PREDICATES.length);
  });

  it('store-paged path: cuts before a LATER subject when the extended window is not exhausted', async () => {
    // The "completes" case above resolves the straddle at EOF (window shorter
    // than requested). This exercises the OTHER branch: the grown window is FULL
    // and a later subject appears in it, so the cut must drop the later subject's
    // partial rows exactly at the seal boundary — otherwise the page would emit a
    // partial next subject (a #1788-class split of THAT subject). A later
    // multi-row subject (`z…` sorts after `seal-report`) forces this branch.
    const limit = 10;
    const store = new OxigraphStore();
    const straddling = 'did:dkg:activity:seal-report';
    const later = 'did:dkg:activity:zeta-later';
    const filler: Quad[] = Array.from({ length: 5 }, (_, i) => ({
      graph: META,
      subject: `did:dkg:activity:f0${i}`,
      predicate: `${DKG_NS}label`,
      object: `"f-${i}"`,
    }));
    const straddlingQuads: Quad[] = SEAL_PREDICATES.map((name, index) => ({
      graph: META,
      subject: straddling,
      predicate: `${DKG_NS}${name}`,
      object: `"seal-${name}-${index}"`,
    }));
    const laterQuads: Quad[] = Array.from({ length: 8 }, (_, i) => ({
      graph: META,
      subject: later,
      predicate: `${DKG_NS}q${String(i).padStart(2, '0')}`,
      object: `"later-${i}"`,
    }));
    await store.insert([...filler, ...straddlingQuads, ...laterQuads]);

    const pages = await pageThrough(
      async (offset, pageLimit) => {
        const page = await readDurableMetaPage({
          store,
          contextGraphId: CG,
          registeredSubGraphNames: [],
          offset,
          limit: pageLimit,
        });
        return page.map((row) => ({ s: row.s, p: row.p, o: row.o, g: row.g }));
      },
      limit,
    );

    const countFor = (subject: string) => (page: readonly Row[]) =>
      page.filter((row) => row.s === subject).length;
    // Both subjects are 0-or-all per page (never a proper subset).
    for (const page of pages) {
      expect([0, SEAL_PREDICATES.length]).toContain(countFor(straddling)(page));
      expect([0, laterQuads.length]).toContain(countFor(later)(page));
    }
    // Page 1 is exactly 5 filler + 14 seal and cuts BEFORE the later subject.
    expect(pages[0]).toHaveLength(filler.length + SEAL_PREDICATES.length);
    expect(countFor(later)(pages[0])).toBe(0);
    // The later subject resumes intact on the next page.
    expect(countFor(later)(pages[1])).toBe(laterQuads.length);
    assertNoDuplicatesOrGaps(pages);
    expect(pages.flat()).toHaveLength(filler.length + SEAL_PREDICATES.length + laterQuads.length);
  });

  it('store-paged path: a clean subject boundary at the limit is not extended', async () => {
    const limit = 5;
    const store = new OxigraphStore();
    // Five single-row activity subjects: the page boundary at limit=5 falls
    // exactly on a subject boundary, so no extension and no continuation query.
    const quads: Quad[] = Array.from({ length: 12 }, (_, i) => ({
      graph: META,
      subject: `did:dkg:activity:s${String(i).padStart(2, '0')}`,
      predicate: `${DKG_NS}label`,
      object: `"row-${i}"`,
    }));
    await store.insert(quads);

    const pages = await pageThrough(
      async (offset, pageLimit) => {
        const page = await readDurableMetaPage({
          store,
          contextGraphId: CG,
          registeredSubGraphNames: [],
          offset,
          limit: pageLimit,
        });
        return page.map((row) => ({ s: row.s, p: row.p, o: row.o, g: row.g }));
      },
      limit,
    );

    // Pages of exactly 5, 5, 2 — never extended past a clean boundary.
    expect(pages.map((page) => page.length)).toEqual([5, 5, 2]);
    assertNoDuplicatesOrGaps(pages);
    expect(pages.flat()).toHaveLength(12);
  });

  it('store-paged path: keeps a straddling blank-node subject atomic (unverified peer-ingest)', async () => {
    // A blank-node `_meta` subject is not produced by conforming first-party
    // writers (metadata generators emit IRIs; the publisher rejects blank nodes)
    // but IS reachable via the unverified system-CG peer-ingest path. Oxigraph
    // relabels a blank node per query, so a subject-bound re-read or a
    // multi-query paged loop could not re-identify it — but the growing-window
    // extend re-reads ONE query per attempt, within which the label (and thus
    // the `(g, s)` boundary) is self-consistent, so the straddling subject is
    // served WHOLE. 14 rows (incl. a dkg:assertionVersion control field — the
    // row whose loss #1788 is about) > limit ⇒ straddles; admitted via
    // dkg:memoryLayer != WorkingMemory; a few IRI fillers prove the boundary cut.
    const limit = 10;
    const store = new OxigraphStore();
    const BNODE = '_:peerSeal';
    const bnodeQuads: Quad[] = [
      { graph: META, subject: BNODE, predicate: `${DKG_NS}memoryLayer`, object: '"LongTermMemory"' },
      { graph: META, subject: BNODE, predicate: ASSERTION_VERSION, object: '"1"' },
      ...Array.from({ length: 12 }, (_, i) => ({
        graph: META,
        subject: BNODE,
        predicate: `${DKG_NS}p${String(i).padStart(2, '0')}`,
        object: `"v-${i}"`,
      })),
    ];
    const filler: Quad[] = Array.from({ length: 3 }, (_, i) => ({
      graph: META,
      subject: `did:dkg:activity:z${i}`,
      predicate: `${DKG_NS}label`,
      object: `"z-${i}"`,
    }));
    await store.insert([...bnodeQuads, ...filler]);

    // Round-based: pageThrough re-queries the store on each fetch, like
    // successive sync rounds. The blank node may be relabelled per query, so
    // identify it structurally.
    const pages = await pageThrough(
      async (offset, pageLimit) => {
        const page = await readDurableMetaPage({
          store,
          contextGraphId: CG,
          registeredSubGraphNames: [],
          offset,
          limit: pageLimit,
        });
        return page.map((row) => ({ s: row.s, p: row.p, o: row.o, g: row.g }));
      },
      limit,
    );

    const bnodeRowCount = (page: readonly Row[]) => page.filter((row) => row.s.startsWith('_:')).length;
    // 0-or-all invariant: no page carries a proper subset of the blank-node subject.
    for (const page of pages) expect([0, bnodeQuads.length]).toContain(bnodeRowCount(page));
    const allBnode = pages.flat().filter((row) => row.s.startsWith('_:'));
    expect(allBnode).toHaveLength(bnodeQuads.length);
    expect(allBnode.some((row) => row.p === ASSERTION_VERSION)).toBe(true);
    // No throw, subject-atomic, and every admitted row delivered exactly once.
    assertNoDuplicatesOrGaps(pages);
    expect(pages.flat()).toHaveLength(bnodeQuads.length + filler.length);
  });
});
