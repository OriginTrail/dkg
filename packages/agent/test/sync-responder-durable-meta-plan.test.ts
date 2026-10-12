import { describe, expect, it } from 'vitest';
import { contextGraphMetaGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import {
  OxigraphStore,
  StoreResponseTooLargeError,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  buildDurableMetaPlan,
  createResponderDurableMetaPlanMemo,
  readDurableMetaPlanWindow,
} from '../src/sync/responder/durable-meta-plan.js';
import { readDurableMetaPage } from '../src/sync/responder/graph-plan.js';
import { SyncRowSnapshotBudgetError } from '../src/sync/responder/snapshot-budget.js';
import {
  DKG_NS,
  linesFromNquads,
  registerTestSyncHandler,
} from './_helpers/sync-responder.js';

/**
 * A metadata graph too large for a session snapshot is paged from a plan: the
 * admitted subjects with their row counts, read once per session without a
 * sort, and pages that look up exactly the subjects they cover. These tests
 * pin what that buys (the store is never asked to sort or skip the graph) and
 * what it must keep (the admitted set, whole subjects per page, one cursor per
 * session).
 */

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';
const VM = `"${MemoryLayer.VerifiableMemory}"`;
const WM = `"${MemoryLayer.WorkingMemory}"`;

/** Rows per synthetic asset descriptor; the publisher writes sixteen. */
const DESCRIPTOR_ROWS = 6;

function descriptorQuads(cgId: string, index: number): Quad[] {
  const graph = contextGraphMetaGraphUri(cgId);
  const subject = `did:dkg:base:84532/0x${'ab'.repeat(20)}/${index + 1}`;
  return [
    { graph, subject, predicate: `${DKG_NS}contentScopeVersion`, object: `"2"^^<${XSD_INTEGER}>` },
    { graph, subject, predicate: `${DKG_NS}status`, object: '"confirmed"' },
    { graph, subject, predicate: `${DKG_NS}kaUal`, object: subject },
    { graph, subject, predicate: `${DKG_NS}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>` },
    { graph, subject, predicate: `${DKG_NS}publicTripleCount`, object: `"${index + 1}"^^<${XSD_INTEGER}>` },
    { graph, subject, predicate: `${DKG_NS}merkleRoot`, object: `"root-${index}"` },
  ];
}

async function storeWithDescriptors(cgId: string, descriptors: number): Promise<OxigraphStore> {
  const store = new OxigraphStore();
  const graph = contextGraphMetaGraphUri(cgId);
  const quads: Quad[] = [
    { graph, subject: `did:dkg:context-graph:${cgId}`, predicate: 'http://schema.org/name', object: '"root"' },
    // Not durable metadata: a working-memory lifecycle and plain noise.
    { graph, subject: 'urn:lifecycle:working', predicate: `${DKG_NS}memoryLayer`, object: WM },
    { graph, subject: 'urn:noise', predicate: `${DKG_NS}label`, object: '"noise"' },
  ];
  for (let index = 0; index < descriptors; index += 1) quads.push(...descriptorQuads(cgId, index));
  await store.insert(quads);
  return store;
}

interface ObservedQuery { sparql: string; source: string; rows: number }

/** Record every store query without changing it. */
function observeQueries(store: TripleStore): ObservedQuery[] {
  const observed: ObservedQuery[] = [];
  const original = store.query.bind(store);
  (store as { query: TripleStore['query'] }).query = async (sparql, options) => {
    const result = await original(sparql, options);
    observed.push({
      sparql: sparql.replace(/\s+/g, ' ').trim(),
      source: options?.source ?? 'unknown',
      rows: result.type === 'bindings' ? result.bindings.length : 0,
    });
    return result;
  };
  return observed;
}

const TINY_SNAPSHOT_BUDGET = {
  maxRows: 1_000_000,
  maxBytesEstimate: Number.MAX_SAFE_INTEGER,
  maxSnapshotRows: 1,
  maxSnapshotBytesEstimate: Number.MAX_SAFE_INTEGER,
} as const;

function subjectOf(line: string): string {
  return line.slice(0, line.indexOf('>') + 1);
}

describe('durable-meta session plan', () => {
  it('serves an oversized session from one plan, with page reads that follow the page', async () => {
    const cgId = 'meta-plan-session';
    const descriptors = 40;
    const store = await storeWithDescriptors(cgId, descriptors);
    const metaGraph = contextGraphMetaGraphUri(cgId);
    const queries = observeQueries(store);
    const cap = registerTestSyncHandler(store, {
      syncPageSize: 8192,
      snapshotBudget: TINY_SNAPSHOT_BUDGET,
    });
    const pageRows = 4 * DESCRIPTOR_ROWS;

    const pages: string[][] = [];
    for (let offset = 0, guard = 0; guard < 100; guard += 1) {
      const lines = linesFromNquads(await cap.invoke({
        contextGraphId: cgId,
        includeSharedMemory: false,
        phase: 'meta',
        offset,
        limit: 500,
        pageMode: 'byte-budget-v1',
        pageRowsHint: pageRows,
        syncSessionId: 'one-session',
      }));
      if (lines.length === 0) break;
      pages.push(lines);
      offset += lines.length;
    }

    // Every admitted row exactly once, and nothing else.
    const served = pages.flat();
    expect(served).toHaveLength(1 + descriptors * DESCRIPTOR_ROWS);
    expect(new Set(served).size).toBe(served.length);
    expect(served.join('\n')).not.toContain('noise');
    expect(served.join('\n')).not.toContain('urn:lifecycle:working');
    // Whole subjects per page: no subject appears on two pages.
    const pageOfSubject = new Map<string, number>();
    pages.forEach((page, index) => {
      for (const line of page) {
        const subject = subjectOf(line);
        expect(pageOfSubject.get(subject) ?? index).toBe(index);
        pageOfSubject.set(subject, index);
      }
    });

    const onMeta = queries.filter((query) => query.sparql.includes(`<${metaGraph}>`));
    // The store is never asked to sort or skip the metadata graph.
    expect(onMeta.filter((query) => /\bORDER BY\b|\bOFFSET\b/.test(query.sparql))).toEqual([]);
    // One plan for the whole session, however many pages it has.
    expect(pages.length).toBeGreaterThan(5);
    expect(onMeta.filter((query) => query.source === 'sync.responder.readDurableMetaPlanSubjects')).toHaveLength(1);
    expect(onMeta.filter((query) => query.source === 'sync.responder.countDurableMetaPlanRows')).toHaveLength(1);
    // A page read returns the rows of the subjects it covers, not the graph.
    const pageReads = onMeta.filter((query) => query.source === 'sync.responder.readDurableMetaPlanSubjectRows');
    expect(pageReads.length).toBeGreaterThanOrEqual(pages.length);
    for (const read of pageReads) expect(read.rows).toBeLessThanOrEqual(pageRows + DESCRIPTOR_ROWS);
    await store.close();
  });

  it('builds a new plan for a new session, so later writes are served', async () => {
    const cgId = 'meta-plan-new-session';
    const store = await storeWithDescriptors(cgId, 3);
    const cap = registerTestSyncHandler(store, { syncPageSize: 8192, snapshotBudget: TINY_SNAPSHOT_BUDGET });
    const firstPage = (syncSessionId: string) => cap.invoke({
      contextGraphId: cgId,
      includeSharedMemory: false,
      phase: 'meta',
      offset: 0,
      limit: 500,
      pageMode: 'byte-budget-v1',
      pageRowsHint: 8192,
      syncSessionId,
    });

    expect(linesFromNquads(await firstPage('before'))).toHaveLength(1 + 3 * DESCRIPTOR_ROWS);
    await store.insert(descriptorQuads(cgId, 3));
    expect(linesFromNquads(await firstPage('after'))).toHaveLength(1 + 4 * DESCRIPTOR_ROWS);
    await store.close();
  });

  it('bounds its two scans by construction and refuses a graph beyond the row cap before reading subjects', async () => {
    const cgId = 'meta-plan-row-cap';
    const store = await storeWithDescriptors(cgId, 5);
    const queries = observeQueries(store);

    const plan = await buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'row-cap',
      limits: { maxRows: 1_000, maxSubjects: 50 },
    });
    expect(plan.totalRows).toBe(1 + 5 * DESCRIPTOR_ROWS);
    expect(queries.map((query) => query.source)).toEqual([
      'sync.responder.countDurableMetaPlanRows',
      'sync.responder.readDurableMetaPlanSubjects',
    ]);
    // The count stops one row past the cap; the subject scan cannot outgrow
    // twice the cap and returns at most one row past the subject cap.
    expect(queries[0]!.sparql).toContain('LIMIT 1001 }');
    expect(queries[1]!.sparql).toContain('LIMIT 2001 }');
    expect(queries[1]!.sparql).toMatch(/LIMIT 51$/);
    for (const query of queries) expect(query.sparql).not.toMatch(/\bORDER BY\b|\bOFFSET\b/);

    queries.length = 0;
    const rawRows = 3 + 5 * DESCRIPTOR_ROWS;
    await expect(buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'row-cap',
      limits: { maxRows: rawRows - 1 },
    })).rejects.toMatchObject({ name: 'SyncRowSnapshotBudgetError', reason: 'snapshot_rows', rows: rawRows });
    // Refused on the bounded count alone.
    expect(queries.map((query) => query.source)).toEqual(['sync.responder.countDurableMetaPlanRows']);
    await store.close();
  });

  it('refuses a plan beyond its subject, subject-size and retained-size caps with the typed budget error', async () => {
    const cgId = 'meta-plan-caps';
    const store = await storeWithDescriptors(cgId, 5);
    const build = (limits: Parameters<typeof buildDurableMetaPlan>[0]['limits']) => buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'caps',
      limits,
    });

    // Six admitted subjects: the context graph and five descriptors.
    await expect(build({ maxSubjects: 5 })).rejects.toMatchObject({ reason: 'snapshot_rows' });
    await expect(build({ subjectMaxRows: DESCRIPTOR_ROWS - 1 })).rejects.toMatchObject({
      reason: 'snapshot_rows',
      rows: DESCRIPTOR_ROWS,
    });
    await expect(build({ maxBytesEstimate: 10 })).rejects.toMatchObject({ reason: 'snapshot_bytes' });
    await expect(build({ maxSubjects: 6, subjectMaxRows: DESCRIPTOR_ROWS })).resolves.toMatchObject({
      totalRows: 1 + 5 * DESCRIPTOR_ROWS,
    });
    await store.close();
  });

  it('turns a store response over the plan byte cap into the typed budget error', async () => {
    const store = {
      query: async () => { throw new StoreResponseTooLargeError(1_024, 4_096); },
    } as unknown as TripleStore;

    const refusal = await buildDurableMetaPlan({
      store,
      contextGraphId: 'meta-plan-response-cap',
      registeredSubGraphNames: [],
      budgetKey: 'response-cap',
    }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SyncRowSnapshotBudgetError);
    expect(refusal).toMatchObject({ reason: 'snapshot_bytes', bytesEstimate: 4_096 });
  });

  it('reads whole subjects from any offset and nothing past the end', async () => {
    const cgId = 'meta-plan-window';
    const store = await storeWithDescriptors(cgId, 4);
    const plan = await buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'window',
    });
    // Descriptor subjects sort before the context graph's own subject.
    expect(plan.subjects.map((entry) => entry.rowCount)).toEqual([6, 6, 6, 6, 1]);
    expect(plan.rowsBefore).toEqual([0, 6, 12, 18, 24, 25]);

    // One row is asked for; the subject that holds it comes whole.
    const second = await readDurableMetaPlanWindow(store, plan, 6, 1);
    expect(second).toHaveLength(DESCRIPTOR_ROWS);
    expect(new Set(second.map((row) => row.s)).size).toBe(1);
    // An offset inside a subject starts there and still ends on a boundary.
    const inside = await readDurableMetaPlanWindow(store, plan, 8, 6);
    expect(inside).toHaveLength(4 + DESCRIPTOR_ROWS);
    expect(inside.slice(0, 4).every((row) => row.s === second[0]!.s)).toBe(true);
    expect(inside.slice(4).every((row) => row.s !== second[0]!.s)).toBe(true);
    // Rows are in (subject, predicate, object) code-point order.
    const whole = await readDurableMetaPlanWindow(store, plan, 0, plan.totalRows);
    expect(whole).toHaveLength(plan.totalRows);
    const keys = whole.map((row) => `${row.s}\n${row.p}\n${row.o}`);
    expect([...keys].sort()).toEqual(keys);
    expect(await readDurableMetaPlanWindow(store, plan, plan.totalRows, 10)).toEqual([]);
    expect(await readDurableMetaPlanWindow(store, plan, 0, 0)).toEqual([]);
    await store.close();
  });

  it('ends the session when a planned subject no longer has the planned row count', async () => {
    const cgId = 'meta-plan-changed';
    const store = await storeWithDescriptors(cgId, 6);
    const metaPlanMemo = createResponderDurableMetaPlanMemo();
    const page = (offset: number, refreshRowList: boolean) => readDurableMetaPage({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      offset,
      limit: 2 * DESCRIPTOR_ROWS,
      rowListCacheKey: 'peer:durable-meta:changed',
      refreshRowList,
      metaPlanMemo,
    });

    const first = await page(0, true);
    expect(first).toHaveLength(2 * DESCRIPTOR_ROWS);
    // A later subject gains a row after the plan fixed its place in the walk.
    const lastSubject = descriptorQuads(cgId, 5)[0]!.subject;
    await store.insert([{
      graph: contextGraphMetaGraphUri(cgId),
      subject: lastSubject,
      predicate: `${DKG_NS}transactionHash`,
      object: '"0x01"',
    }]);

    let offset = first.length;
    let failure: unknown;
    for (let guard = 0; guard < 10 && failure === undefined; guard += 1) {
      const rows = await page(offset, false).catch((error: unknown) => { failure = error; return []; });
      if (rows.length === 0) break;
      offset += rows.length;
    }
    // The words a requester reads as "restart this session from offset zero".
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message.toLowerCase()).toMatch(/sync session/);
    expect((failure as Error).message.toLowerCase()).toMatch(/superseded/);
    expect((failure as Error).message).toContain('expected 6 rows, found 7');

    // A new session plans the graph as it is now.
    const restarted = await page(0, true);
    expect(restarted).toHaveLength(2 * DESCRIPTOR_ROWS);
    await store.close();
  });

  it('requires the session plan for an offset above zero', async () => {
    const cgId = 'meta-plan-expired';
    const store = await storeWithDescriptors(cgId, 4);
    const metaPlanMemo = createResponderDurableMetaPlanMemo(5);
    const page = (offset: number, refreshRowList: boolean) => readDurableMetaPage({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      offset,
      limit: DESCRIPTOR_ROWS,
      rowListCacheKey: 'peer:durable-meta:expired',
      refreshRowList,
      metaPlanMemo,
    });

    const first = await page(0, true);
    expect(first.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(page(first.length, false)).rejects.toThrow(/sync session plan expired/);
    await store.close();
  });

  it('serves the admitted rows of blank-node subjects whole, after the IRI subjects', async () => {
    const cgId = 'meta-plan-blank';
    const graph = contextGraphMetaGraphUri(cgId);
    const store = await storeWithDescriptors(cgId, 2);
    const blank = (label: string, rows: number, layer: string): Quad[] => [
      { graph, subject: `_:${label}`, predicate: `${DKG_NS}memoryLayer`, object: layer },
      ...Array.from({ length: rows - 1 }, (_, index) => ({
        graph,
        subject: `_:${label}`,
        predicate: `${DKG_NS}p${index}`,
        object: `"${label}-${index}"`,
      })),
    ];
    await store.insert([...blank('first', 5, VM), ...blank('second', 7, VM), ...blank('working', 3, WM)]);

    const plan = await buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'blank',
    });
    expect(plan.blankNodeRows).toBe(12);
    expect(plan.totalRows).toBe(1 + 2 * DESCRIPTOR_ROWS + 12);

    const pages: Array<Array<{ s: string; p: string; o: string }>> = [];
    for (let offset = 0, guard = 0; guard < 20; guard += 1) {
      const rows = await readDurableMetaPage({
        store,
        contextGraphId: cgId,
        registeredSubGraphNames: [],
        offset,
        limit: 4,
      });
      if (rows.length === 0) break;
      pages.push(rows.map((row) => ({ s: row.s, p: row.p, o: row.o })));
      offset += rows.length;
    }
    const served = pages.flat();
    expect(served).toHaveLength(plan.totalRows);
    // Content identifies a blank-node row whatever label a query gives it: the
    // two admitted subjects share only their memory-layer row.
    const blankRows = served.filter((row) => row.s.startsWith('_:'));
    expect(blankRows).toHaveLength(12);
    expect(new Set(blankRows.map((row) => `${row.p}\n${row.o}`)).size).toBe(11);
    expect(blankRows.some((row) => row.o.includes('working'))).toBe(false);
    // Each blank-node subject stays on one page, and all of them follow the IRIs.
    for (const page of pages) {
      const bySubject = new Map<string, number>();
      for (const row of page.filter((entry) => entry.s.startsWith('_:'))) {
        bySubject.set(row.s, (bySubject.get(row.s) ?? 0) + 1);
      }
      for (const count of bySubject.values()) expect([5, 7]).toContain(count);
    }
    const firstBlank = served.findIndex((row) => row.s.startsWith('_:'));
    expect(served.slice(firstBlank).every((row) => row.s.startsWith('_:'))).toBe(true);
    await store.close();
  });

  it('ends the session when the non-IRI tail changes', async () => {
    const cgId = 'meta-plan-blank-changed';
    const graph = contextGraphMetaGraphUri(cgId);
    const store = await storeWithDescriptors(cgId, 1);
    await store.insert([
      { graph, subject: '_:tail', predicate: `${DKG_NS}memoryLayer`, object: VM },
      { graph, subject: '_:tail', predicate: `${DKG_NS}label`, object: '"one"' },
    ]);
    const plan = await buildDurableMetaPlan({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      budgetKey: 'blank-changed',
    });
    expect(plan.blankNodeRows).toBe(2);
    await store.insert([{ graph, subject: '_:other', predicate: `${DKG_NS}memoryLayer`, object: VM }]);

    await expect(readDurableMetaPlanWindow(store, plan, 0, plan.totalRows))
      .rejects.toThrow(/sync session superseded.*non-IRI subjects: expected 2 rows, found 3/);
    await store.close();
  });
});
