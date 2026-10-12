import { describe, expect, it, vi } from 'vitest';
import { contextGraphMetaGraphUri, DKG_ONTOLOGY, MemoryLayer } from '@origintrail-official/dkg-core';
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
  type DurableMetaPlan,
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

  it('bounds its scans by construction and refuses a graph beyond the row cap before reading subjects', async () => {
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
    // No assertion left working memory here, so the subjects under an assertion
    // path are not read at all.
    expect(queries.map((query) => query.source)).toEqual([
      'sync.responder.countDurableMetaPlanRows',
      'sync.responder.readDurableMetaPlanSubjects',
      'sync.responder.readDurableMetaPlanAssertionNames',
    ]);
    expect(queries[2]!.rows).toBe(0);
    // The count stops one row past the cap; the subject scan cannot outgrow
    // twice the cap and returns at most one row past the subject cap, as does
    // the read of the names.
    expect(queries[0]!.sparql).toContain('LIMIT 1001 }');
    expect(queries[1]!.sparql).toContain('LIMIT 2001 }');
    expect(queries[1]!.sparql).toMatch(/LIMIT 51$/);
    expect(queries[2]!.sparql).toMatch(/LIMIT 51$/);
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

  it('decides the assertion-name rule in process, from one read of the names and one of the subjects', async () => {
    const cgId = 'meta-plan-names';
    const graph = contextGraphMetaGraphUri(cgId);
    const cgEntity = `did:dkg:context-graph:${cgId}`;
    const q = (subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
    const store = new OxigraphStore();
    await store.insert([
      q(cgEntity, 'http://schema.org/name', '"root"'),
      // Two assertions that left working memory, one that did not.
      q('urn:lifecycle:promoted', `${DKG_NS}memoryLayer`, VM),
      q('urn:lifecycle:promoted', `${DKG_NS}assertionName`, '"notes"'),
      q('urn:lifecycle:nested', `${DKG_NS}memoryLayer`, VM),
      q('urn:lifecycle:nested', `${DKG_NS}assertionName`, '"team/plan"'),
      q('urn:lifecycle:draft', `${DKG_NS}memoryLayer`, WM),
      q('urn:lifecycle:draft', `${DKG_NS}assertionName`, '"draft"'),
      // Named by them, in whole path segments only.
      q(`${cgEntity}/assertion/0xabc/notes`, `${DKG_NS}label`, '"a"'),
      q(`${cgEntity}/assertion/0xabc/notes`, `${DKG_NS}note`, '"b"'),
      q(`${cgEntity}/assertion/0xdef/team/plan`, `${DKG_NS}label`, '"c"'),
      // Not named: a draft's name, a name that is only a suffix of a segment,
      // no name at all, and a name outside an assertion path.
      q(`${cgEntity}/assertion/0xabc/draft`, `${DKG_NS}label`, '"d"'),
      q(`${cgEntity}/assertion/0xabc/my-notes`, `${DKG_NS}label`, '"e"'),
      q(`${cgEntity}/assertion/0xabc/other`, `${DKG_NS}label`, '"f"'),
      q('urn:elsewhere/notes', `${DKG_NS}label`, '"g"'),
    ]);
    const queries = observeQueries(store);

    const plan = await buildDurableMetaPlan({ store, contextGraphId: cgId, registeredSubGraphNames: [], budgetKey: 'names' });
    expect(plan.subjects).toEqual([
      { subject: cgEntity, rowCount: 1 },
      { subject: `${cgEntity}/assertion/0xabc/notes`, rowCount: 2, namedBy: 'urn:lifecycle:promoted' },
      { subject: `${cgEntity}/assertion/0xdef/team/plan`, rowCount: 1, namedBy: 'urn:lifecycle:nested' },
      { subject: 'urn:lifecycle:nested', rowCount: 2 },
      { subject: 'urn:lifecycle:promoted', rowCount: 2 },
    ]);
    expect(queries.map((query) => query.source)).toEqual([
      'sync.responder.countDurableMetaPlanRows',
      'sync.responder.readDurableMetaPlanSubjects',
      'sync.responder.readDurableMetaPlanAssertionNames',
      'sync.responder.readDurableMetaPlanAssertionSubjects',
    ]);
    // One row per promoted assertion; building the plan never has the store
    // compare a subject with the names.
    expect(queries[2]!.rows).toBe(2);
    for (const query of queries) expect(query.sparql).not.toMatch(/STRENDS/);

    // A page asks each named subject's own lifecycle record, and no other,
    // in one group with the read of the rows: the pairs lead it.
    queries.length = 0;
    const rows = await readDurableMetaPlanWindow(store, plan, 0, plan.totalRows);
    expect(rows).toHaveLength(8);
    const named = queries.filter((query) => /STRENDS/.test(query.sparql));
    expect(named).toHaveLength(1);
    expect(named[0]!.sparql.startsWith(
      `SELECT DISTINCT ?s ?p ?o WHERE { VALUES (?s ?lifecycle) { (<${cgEntity}/assertion/0xabc/notes> <urn:lifecycle:promoted>) `
      + `(<${cgEntity}/assertion/0xdef/team/plan> <urn:lifecycle:nested>) } GRAPH <${graph}> { ?lifecycle `,
    )).toBe(true);
    expect(named[0]!.sparql.match(/SELECT/g)).toHaveLength(1);
    await store.close();
  });

  it('asks the lifecycle record again before it serves a subject that record named', async () => {
    const cgId = 'meta-plan-names-recheck';
    const graph = contextGraphMetaGraphUri(cgId);
    const cgEntity = `did:dkg:context-graph:${cgId}`;
    const q = (subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
    const lifecycle = 'urn:lifecycle:promoted';
    const named = `${cgEntity}/assertion/0xabc/notes`;
    const seed: Quad[] = [
      q(lifecycle, `${DKG_NS}memoryLayer`, VM),
      q(lifecycle, `${DKG_NS}assertionName`, '"notes"'),
      q(named, `${DKG_NS}label`, '"sealed"'),
      q(named, `${DKG_NS}note`, '"published"'),
    ];
    const planned = async () => {
      const store = new OxigraphStore();
      await store.insert(seed);
      const plan = await buildDurableMetaPlan({ store, contextGraphId: cgId, registeredSubGraphNames: [], budgetKey: 'names-recheck' });
      expect(plan.subjects).toEqual([
        { subject: named, rowCount: 2, namedBy: lifecycle },
        { subject: lifecycle, rowCount: 2 },
      ]);
      return { store, plan };
    };
    const draft = [q(named, `${DKG_NS}label`, '"draft"'), q(named, `${DKG_NS}note`, '"not published"')];

    // The assertion goes back to working memory and its subject is rewritten
    // with as many rows as it had: nothing of that is served.
    {
      const { store, plan } = await planned();
      await store.deleteByPattern({ graph, subject: lifecycle, predicate: `${DKG_NS}memoryLayer` });
      await store.insert([q(lifecycle, `${DKG_NS}memoryLayer`, WM)]);
      await store.deleteByPattern({ graph, subject: named });
      await store.insert(draft);
      await expect(readDurableMetaPlanWindow(store, plan, 0, 2)).rejects.toThrow(
        `subject ${named}: expected 2 rows, found 0`,
      );
      await store.close();
    }
    // The same when the record is gone, or no longer carries that name.
    for (const change of [
      (store: OxigraphStore) => store.deleteByPattern({ graph, subject: lifecycle }),
      async (store: OxigraphStore) => {
        await store.deleteByPattern({ graph, subject: lifecycle, predicate: `${DKG_NS}assertionName` });
        await store.insert([q(lifecycle, `${DKG_NS}assertionName`, '"renamed"')]);
      },
    ]) {
      const { store, plan } = await planned();
      await change(store);
      await expect(readDurableMetaPlanWindow(store, plan, 0, 2)).rejects.toThrow(/sync session superseded/i);
      await store.close();
    }
    // While the record still names it, the subject is served with the rows it has.
    {
      const { store, plan } = await planned();
      await store.deleteByPattern({ graph, subject: named });
      await store.insert(draft);
      expect((await readDurableMetaPlanWindow(store, plan, 0, 2)).map((row) => row.o)).toEqual(['"draft"', '"not published"']);
      // A record that carries the name twice over does not repeat the rows.
      await store.insert([q(lifecycle, `${DKG_NS}assertionName`, '"abc/notes"')]);
      expect(await readDurableMetaPlanWindow(store, plan, 0, 2)).toHaveLength(2);
      await store.close();
    }
  });

  it('asks the store again, with every page, whether a subject is still admitted', async () => {
    const cgId = 'meta-plan-recheck';
    const graph = contextGraphMetaGraphUri(cgId);
    const cgEntity = `did:dkg:context-graph:${cgId}`;
    const q = (subject: string, predicate: string, object: string): Quad => ({ graph, subject, predicate, object });
    const lifecycle = 'urn:lifecycle:recheck';
    const descriptor = descriptorQuads(cgId, 0);
    const delegation = `did:dkg:agent-delegation:${cgId}:0xmember`;
    const seed: Quad[] = [
      q(cgEntity, 'http://schema.org/name', '"root"'),
      q(cgEntity, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, '"0xMember"'),
      q(delegation, DKG_ONTOLOGY.DKG_DELEGATION_AGENT, '"0xmember"'),
      q(lifecycle, `${DKG_NS}memoryLayer`, VM),
      q(lifecycle, `${DKG_NS}note`, '"published"'),
      ...descriptor,
    ];
    /** The failure of reading the one planned subject `subject` after `change`. */
    const superseded = async (subject: string, change: (store: OxigraphStore) => Promise<void>): Promise<string> => {
      const store = new OxigraphStore();
      await store.insert(seed);
      const plan = await buildDurableMetaPlan({ store, contextGraphId: cgId, registeredSubGraphNames: [], budgetKey: 'recheck' });
      expect(plan.totalRows).toBe(seed.length);
      expect(await readDurableMetaPlanWindow(store, plan, 0, plan.totalRows)).toHaveLength(seed.length);
      await change(store);
      // A window of that subject alone, so no other subject's change can end it.
      const index = plan.subjects.findIndex((entry) => entry.subject === subject);
      expect(index).toBeGreaterThanOrEqual(0);
      const failure = await readDurableMetaPlanWindow(store, plan, plan.rowsBefore[index]!, 1)
        .catch((error: unknown) => error);
      await store.close();
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/sync session superseded/i);
      return (failure as Error).message;
    };

    // A subject rewritten in place with as many rows as it had, none of which
    // was ever admitted: working-memory content is not served on the strength
    // of the plan.
    expect(await superseded(lifecycle, async (store) => {
      await store.deleteByPattern({ graph, subject: lifecycle });
      await store.insert([q(lifecycle, `${DKG_NS}memoryLayer`, WM), q(lifecycle, `${DKG_NS}note`, '"local draft"')]);
    })).toContain(`subject ${lifecycle}: expected 2 rows, found 0`);

    // A descriptor that is no longer confirmed, with the same number of rows.
    expect(await superseded(descriptor[0]!.subject, async (store) => {
      await store.deleteByPattern({ graph, subject: descriptor[0]!.subject, predicate: `${DKG_NS}status` });
      await store.insert([q(descriptor[0]!.subject, `${DKG_NS}status`, '"tentative"')]);
    })).toContain(`subject ${descriptor[0]!.subject}: expected ${DESCRIPTOR_ROWS} rows, found 0`);

    // A subject whose own row did not change, but whose admission did: the
    // delegation of an agent that was revoked after the plan.
    expect(await superseded(delegation, async (store) => {
      await store.insert([q(cgEntity, DKG_ONTOLOGY.DKG_REVOKED_AGENT, '"0xMEMBER"')]);
    })).toContain(`subject ${delegation}: expected 1 rows, found 0`);
  });

  it('rebuilds the plan for a new session even when that session never spent its refresh', async () => {
    const cgId = 'meta-plan-generation';
    const store = await storeWithDescriptors(cgId, 2);
    const metaPlanMemo = createResponderDurableMetaPlanMemo();
    const queries = observeQueries(store);
    const page = (generation: string, refreshRowList: boolean) => readDurableMetaPage({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 1_000,
      rowListCacheKey: 'peer:durable-meta:generation',
      refreshRowList,
      refreshGeneration: `peer:durable-meta:generation\u0000${generation}`,
      metaPlanMemo,
    });
    const plansBuilt = () => queries
      .filter((query) => query.source === 'sync.responder.readDurableMetaPlanSubjects').length;

    expect(await page('first', true)).toHaveLength(1 + 2 * DESCRIPTOR_ROWS);
    // Same session: the plan is kept.
    expect(await page('first', false)).toHaveLength(1 + 2 * DESCRIPTOR_ROWS);
    expect(plansBuilt()).toBe(1);

    // A later session whose first request was lost before it reached the plan:
    // the request that arrives no longer carries the refresh, only the session.
    await store.insert(descriptorQuads(cgId, 2));
    expect(await page('second', false)).toHaveLength(1 + 3 * DESCRIPTOR_ROWS);
    expect(plansBuilt()).toBe(2);
    await store.close();
  });

  it('waits out a plan build of another session instead of joining it', async () => {
    const memo = createResponderDurableMetaPlanMemo();
    const planOf = (label: string) => ({ graph: label, bytesEstimate: 0 }) as unknown as DurableMetaPlan;
    const [earlier, later, unused] = [planOf('earlier'), planOf('later'), planOf('unused')];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = memo.get('key', async () => { await gate; return earlier; }, { generation: 'earlier' });
    // A request of a later session arrives while the earlier build is running.
    const second = memo.get('key', async () => later, { generation: 'later' });
    release();
    expect(await first).toBe(earlier);
    expect(await second).toBe(later);

    // The later session's plan is the one kept for it.
    expect(await memo.get('key', async () => unused, { generation: 'later' })).toBe(later);
    // To the earlier session its plan is gone: a later page of it cannot go on.
    expect(await memo.get('key', async () => unused, { generation: 'earlier', requireExisting: true })).toBeNull();
  });

  it('keeps building a session plan after the request that started it has left', async () => {
    const cgId = 'meta-plan-owner';
    const store = await storeWithDescriptors(cgId, 2);
    const metaPlanMemo = createResponderDurableMetaPlanMemo();
    const queries = observeQueries(store);
    const original = store.query.bind(store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signalsSeen: Array<AbortSignal | undefined> = [];
    (store as { query: TripleStore['query'] }).query = async (sparql, options) => {
      if (options?.source === 'sync.responder.countDurableMetaPlanRows') {
        signalsSeen.push(options.signal);
        await gate;
      }
      return original(sparql, options);
    };
    const page = (signal: AbortSignal | undefined, refreshRowList: boolean) => readDurableMetaPage({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 1_000,
      signal,
      rowListCacheKey: 'peer:durable-meta:owner',
      refreshRowList,
      refreshGeneration: 'peer:durable-meta:owner\u0000session',
      metaPlanMemo,
    });

    const leaving = new AbortController();
    const first = page(leaving.signal, true).catch((error: unknown) => error);
    await vi.waitFor(() => expect(signalsSeen).toHaveLength(1));
    leaving.abort(new Error('requester stopped waiting'));
    expect(await first).toMatchObject({ message: 'requester stopped waiting' });
    // The build was not tied to that request, and it goes on.
    expect(signalsSeen).toEqual([undefined]);
    release();

    // The retry of the same session finds the plan instead of starting it again.
    expect(await page(undefined, false)).toHaveLength(1 + 2 * DESCRIPTOR_ROWS);
    expect(queries.filter((query) => query.source === 'sync.responder.readDurableMetaPlanSubjects')).toHaveLength(1);
    await store.close();
  });

  it('reports a session plan build that fails after its request has left', async () => {
    const cgId = 'meta-plan-detached-failure';
    const store = await storeWithDescriptors(cgId, 2);
    const original = store.query.bind(store);
    let fail!: (error: Error) => void;
    const gate = new Promise<never>((_, reject) => { fail = reject; });
    let started = false;
    (store as { query: TripleStore['query'] }).query = async (sparql, options) => {
      if (options?.source === 'sync.responder.countDurableMetaPlanRows') {
        started = true;
        await gate;
      }
      return original(sparql, options);
    };
    const reported: unknown[] = [];
    const leaving = new AbortController();
    const request = readDurableMetaPage({
      store,
      contextGraphId: cgId,
      registeredSubGraphNames: [],
      offset: 0,
      limit: 1_000,
      signal: leaving.signal,
      rowListCacheKey: 'peer:durable-meta:detached-failure',
      refreshRowList: true,
      refreshGeneration: 'peer:durable-meta:detached-failure\u0000session',
      metaPlanMemo: createResponderDurableMetaPlanMemo(),
      onSessionPlanFailure: (error) => reported.push(error),
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(started).toBe(true));
    leaving.abort(new Error('requester stopped waiting'));
    expect(await request).toMatchObject({ message: 'requester stopped waiting' });
    expect(reported).toEqual([]);

    const storeFailure = new Error('the store gave up on the query');
    fail(storeFailure);
    await vi.waitFor(() => expect(reported).toEqual([storeFailure]));
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
