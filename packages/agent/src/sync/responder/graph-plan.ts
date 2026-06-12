import {
  DKG_ONTOLOGY,
  MemoryLayer,
  assertSafeIri,
  sparqlString,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';

export type SyncRow = { s: string; p: string; o: string; g: string };

const DKG = 'http://dkg.io/ontology/';
const DKG_SUB_GRAPH = `${DKG}SubGraph`;
const DKG_WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
const DKG_PUBLISHED_AT = `${DKG}publishedAt`;
const DKG_ROOT_ENTITY = `${DKG}rootEntity`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_ASSERTION_NAME = `${DKG}assertionName`;
const DKG_MEMORY_LAYER = `${DKG}memoryLayer`;
const DKG_PART_OF = `${DKG}partOf`;
const DKG_BATCH_ID = `${DKG}batchId`;
const SCHEMA_NAME = 'http://schema.org/name';

export interface GraphListMemo {
  get(): Promise<readonly string[]>;
}

export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  let cached: readonly string[] | null = null;
  let cachedAt = 0;
  let inflight: Promise<readonly string[]> | null = null;
  return {
    async get() {
      const now = Date.now();
      if (cached && now - cachedAt < ttlMs) return [...cached];
      if (inflight) return [...(await inflight)];
      inflight = store.listGraphs()
        .then((graphs) => {
          const sorted = [...new Set(graphs)].sort(compareCodePoint);
          cached = sorted;
          cachedAt = Date.now();
          return sorted;
        })
        .finally(() => {
          inflight = null;
        });
      return [...(await inflight)];
    },
  };
}

export function compareCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const delta = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (delta !== 0) return delta;
  }
  return left.length - right.length;
}

export function compareRows(a: SyncRow, b: SyncRow): number {
  return (
    compareCodePoint(a.g, b.g) ||
    compareCodePoint(a.s, b.s) ||
    compareCodePoint(a.p, b.p) ||
    compareCodePoint(a.o, b.o)
  );
}

export function serializeResponderRows(rows: readonly SyncRow[]): string {
  return rows.map((row) =>
    `${formatTerm(row.s)} <${assertSafeIri(row.p)}> ${formatTerm(row.o)} <${assertSafeIri(row.g)}> .`,
  ).join('\n');
}

export async function readSwmMetaPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const graphs = await planSwmGraphs(params.store, params.contextGraphId, true);
  const graphSet = new Set(params.graphList);
  const rows: SyncRow[] = [];
  for (const graph of graphs.filter((graph) => graphSet.has(graph))) {
    const subjects = params.cutoffIso
      ? await readFreshWorkspaceSubjects(params.store, graph, params.cutoffIso)
      : null;
    rows.push(...await readGraphRows(params.store, graph, (row) =>
      !subjects || subjects.has(row.s),
    ));
  }
  rows.sort(compareRows);
  return rows.slice(params.offset, params.offset + params.limit);
}

export async function readSwmDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  cutoffIso: string | null;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const dataGraphs = await planSwmGraphs(params.store, params.contextGraphId, false);
  const graphSet = new Set(params.graphList);
  if (!params.cutoffIso) {
    const rows = (await Promise.all(dataGraphs
      .filter((graph) => graphSet.has(graph) || params.graphList.some((candidate) => candidate.startsWith(`${graph}/`)))
      .flatMap((graph) => params.graphList.filter((candidate) => candidate === graph || candidate.startsWith(`${graph}/`)))
      .map((graph) => readGraphRows(params.store, graph))))
      .flat()
      .sort(compareRows);
    return rows.slice(params.offset, params.offset + params.limit);
  }

  const rows: SyncRow[] = [];
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    const roots = await readFreshWorkspaceRoots(params.store, metaGraph, params.cutoffIso);
    if (roots.size === 0) continue;
    const rootList = [...roots];
    for (const candidate of params.graphList) {
      if (candidate !== graph && !candidate.startsWith(`${graph}/`)) continue;
      rows.push(...await readGraphRows(params.store, candidate, (row) =>
        roots.has(row.s) || rootList.some((root) => row.s.startsWith(`${root}/.well-known/genid/`)),
      ));
    }
  }
  rows.sort(compareRows);
  return dedupeRows(rows).slice(params.offset, params.offset + params.limit);
}

export async function readDurableMetaPage(params: {
  store: TripleStore;
  contextGraphId: string;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const metaGraph = contextGraphMetaGraphUri(params.contextGraphId);
  const metaRows = await readGraphRows(params.store, metaGraph);
  const allowedSubjects = collectDurableMetaSubjects(metaRows, params.contextGraphId);
  if (allowedSubjects.size === 0) return [];
  const rows = metaRows.filter((row) => allowedSubjects.has(row.s));
  rows.sort(compareRows);
  return rows.slice(params.offset, params.offset + params.limit);
}

export async function readDurableCanonicalDataPage(params: {
  store: TripleStore;
  contextGraphId: string;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  return readGraphRowsPage(
    params.store,
    contextGraphDataGraphUri(params.contextGraphId),
    params.offset,
    params.limit,
  );
}

export async function readDurableDataPage(params: {
  store: TripleStore;
  graphList: readonly string[];
  contextGraphId: string;
  sinceBatchId: bigint | null;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  const cgPrefix = contextGraphDataGraphUri(params.contextGraphId);
  const topMetaGraph = contextGraphMetaGraphUri(params.contextGraphId);
  const candidateGraphs = params.graphList.filter((graph) => {
    if (graph !== cgPrefix && !graph.startsWith(`${cgPrefix}/`)) return false;
    if (graph === topMetaGraph) return false;
    return !graph.includes('/_private');
  }).sort(compareCodePoint);

  let assertionGraphs: Set<string> | null = null;
  const isAdmitted = async (graph: string): Promise<boolean> => {
    if (graph.includes('/assertion/')) {
      assertionGraphs ??= await readAdmittedAssertionGraphs(params.store, params.contextGraphId);
      if (!assertionGraphs.has(graph)) return false;
    }
    return !(await isDescendantOfKnownChildContextGraph(params.store, cgPrefix, graph));
  };

  if (params.sinceBatchId == null) {
    return readPagedRowsAcrossGraphs(params.store, candidateGraphs, params.offset, params.limit, isAdmitted);
  }

  const graphs: string[] = [];
  for (const graph of candidateGraphs) {
    if (await isAdmitted(graph)) graphs.push(graph);
  }

  const metaGraphs = [
    topMetaGraph,
    ...graphs.filter((graph) =>
      graph.startsWith(`${cgPrefix}/`) && graph.endsWith('/_meta'),
    ),
  ];
  return readPagedDurableDeltaRowsAcrossGraphs(
    params.store,
    graphs,
    metaGraphs,
    params.sinceBatchId,
    params.offset,
    params.limit,
  );
}

async function readPagedRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  offset: number,
  limit: number,
  isAdmitted: (graph: string) => Promise<boolean>,
): Promise<SyncRow[]> {
  let skip = offset;
  let remaining = limit;
  const rows: SyncRow[] = [];

  for (const graph of graphs) {
    if (!(await isAdmitted(graph))) continue;
    if (skip > 0) {
      const count = await countGraphRows(store, graph);
      if (skip >= count) {
        skip -= count;
        continue;
      }
    }

    const page = await readGraphRowsPage(store, graph, skip, remaining);
    rows.push(...page);
    remaining -= page.length;
    skip = 0;
    if (remaining <= 0) break;
  }

  return rows;
}

async function readPagedDurableDeltaRowsAcrossGraphs(
  store: TripleStore,
  graphs: readonly string[],
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  let skip = offset;
  let remaining = limit;
  const rows: SyncRow[] = [];

  for (const graph of graphs) {
    if (skip > 0) {
      const count = await countDurableDeltaGraphRows(store, graph, metaGraphs, sinceBatchId);
      if (skip >= count) {
        skip -= count;
        continue;
      }
    }

    const page = await readDurableDeltaGraphRowsPage(
      store,
      graph,
      metaGraphs,
      sinceBatchId,
      skip,
      remaining,
    );
    rows.push(...page);
    remaining -= page.length;
    skip = 0;
    if (remaining <= 0) break;
  }

  return rows;
}

async function planSwmGraphs(
  store: TripleStore,
  contextGraphId: string,
  meta: boolean,
): Promise<string[]> {
  const cgPrefix = contextGraphDataGraphUri(contextGraphId);
  const suffix = meta ? '/_shared_memory_meta' : '/_shared_memory';
  const graphs = [`${cgPrefix}${suffix}`];
  for (const name of await readRegisteredSubGraphNames(store, contextGraphId)) {
    const childCgUri = `${cgPrefix}/${name}`;
    if (await isKnownContextGraph(store, childCgUri)) continue;
    graphs.push(`${childCgUri}${suffix}`);
  }
  return graphs.sort(compareCodePoint);
}

async function readRegisteredSubGraphNames(
  store: TripleStore,
  contextGraphId: string,
): Promise<string[]> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?name WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?sg <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_SUB_GRAPH}> ;
            <${SCHEMA_NAME}> ?name .
      }
    }
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => stripLiteral(row['name']))
    .filter((name) => name && validateSubGraphName(name).valid)
    .sort(compareCodePoint);
}

async function isKnownContextGraph(store: TripleStore, contextGraphUri: string): Promise<boolean> {
  const metaGraph = `${contextGraphUri}/_meta`;
  const res = await store.query(`
    ASK {
      GRAPH <${assertSafeIri(metaGraph)}> {
        {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> .
        } UNION {
          <${assertSafeIri(contextGraphUri)}> <${DKG_ONTOLOGY.DKG_REGISTRATION_STATUS}> ?status .
        }
      }
    }
  `);
  return res.type === 'boolean' && res.value;
}

async function isDescendantOfKnownChildContextGraph(
  store: TripleStore,
  cgPrefix: string,
  graph: string,
): Promise<boolean> {
  if (graph === cgPrefix || !graph.startsWith(`${cgPrefix}/`)) return false;
  const remainder = graph.slice(cgPrefix.length + 1);
  const segments = remainder.split('/').filter(Boolean);
  let childUri = cgPrefix;
  for (const segment of segments) {
    childUri = `${childUri}/${segment}`;
    if (await isKnownContextGraph(store, childUri)) return true;
  }
  return false;
}

async function readAdmittedAssertionGraphs(
  store: TripleStore,
  contextGraphId: string,
): Promise<Set<string>> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const res = await store.query(`
    SELECT DISTINCT ?g WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?lifecycle <${DKG_ASSERTION_GRAPH}> ?g ;
                   <${DKG_MEMORY_LAYER}> ?layer .
        FILTER(?layer != ${sparqlString(MemoryLayer.WorkingMemory)})
      }
    }
  `);
  if (res.type !== 'bindings') return new Set();
  return new Set(res.bindings.map((row) => row['g']).filter(Boolean));
}

function collectDurableMetaSubjects(
  rows: readonly SyncRow[],
  contextGraphId: string,
): Set<string> {
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const allowed = new Set<string>([cgEntity]);
  const nonWorkingLifecycle = new Set<string>();
  const assertionNames: string[] = [];
  const assertionSubjects = new Set<string>();

  for (const row of rows) {
    if (row.s.startsWith('did:dkg:activity:') || row.s.startsWith('did:dkg:join-request:')) {
      allowed.add(row.s);
    }
    if (row.s.includes('/assertion/')) {
      assertionSubjects.add(row.s);
    }
    if (row.p === DKG_MEMORY_LAYER && stripLiteral(row.o) !== MemoryLayer.WorkingMemory) {
      nonWorkingLifecycle.add(row.s);
    }
  }

  for (const row of rows) {
    if (nonWorkingLifecycle.has(row.s)) {
      allowed.add(row.s);
      if (row.p === DKG_ASSERTION_GRAPH) allowed.add(row.o);
      if (row.p === DKG_ASSERTION_NAME) assertionNames.push(stripLiteral(row.o));
    }
    if (
      (row.p === 'http://www.w3.org/ns/prov#generated' || row.p === 'http://www.w3.org/ns/prov#used') &&
      nonWorkingLifecycle.has(row.o)
    ) {
      allowed.add(row.s);
    }
  }

  for (const assertionName of assertionNames) {
    const suffix = `/${assertionName}`;
    for (const subject of assertionSubjects) {
      if (subject.endsWith(suffix)) allowed.add(subject);
    }
  }
  return allowed;
}

async function readFreshWorkspaceSubjects(
  store: TripleStore,
  metaGraph: string,
  cutoffIso: string,
): Promise<Set<string>> {
  const res = await store.query(`
    SELECT DISTINCT ?subject WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?subject <${DKG_PUBLISHED_AT}> ?ts .
        FILTER(?ts >= "${cutoffIso}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `);
  return new Set(res.type === 'bindings' ? res.bindings.map((row) => row['subject']).filter(Boolean) : []);
}

async function readFreshWorkspaceRoots(
  store: TripleStore,
  metaGraph: string,
  cutoffIso: string,
): Promise<Set<string>> {
  const res = await store.query(`
    SELECT DISTINCT ?root WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_PUBLISHED_AT}> ?ts ;
            <${DKG_ROOT_ENTITY}> ?root .
        FILTER(?ts >= "${cutoffIso}"^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `);
  return new Set(res.type === 'bindings' ? res.bindings.map((row) => row['root']).filter(Boolean) : []);
}

async function readGraphRows(
  store: TripleStore,
  graph: string,
  predicate?: (row: SyncRow) => boolean | Promise<boolean>,
): Promise<SyncRow[]> {
  const res = await store.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
    }
  `);
  if (res.type !== 'bindings') return [];
  const rows: SyncRow[] = [];
  for (const row of res.bindings) {
    const syncRow = { s: row['s'], p: row['p'], o: row['o'], g: graph };
    if (!syncRow.s || !syncRow.p || !syncRow.o) continue;
    if (!predicate || await predicate(syncRow)) rows.push(syncRow);
  }
  return rows;
}

async function countGraphRows(store: TripleStore, graph: string): Promise<number> {
  const res = await store.query(`
    SELECT (COUNT(*) AS ?count) WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readGraphRowsPage(
  store: TripleStore,
  graph: string,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const res = await store.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
    }
    ORDER BY ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: graph }))
    .filter((row) => row.s && row.p && row.o);
}

async function countDurableDeltaGraphRows(
  store: TripleStore,
  graph: string,
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
): Promise<number> {
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT (COUNT(*) AS ?count) WHERE {
      {
        SELECT ?s ?p ?o WHERE {
          ${durableDeltaWhereClause(graph, metaGraphs)}
        }
        ${durableDeltaGroupClause(metaGraphs, sinceBatchId)}
      }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readDurableDeltaGraphRowsPage(
  store: TripleStore,
  graph: string,
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const res = await store.query(`
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?s ?p ?o WHERE {
      ${durableDeltaWhereClause(graph, metaGraphs)}
    }
    ${durableDeltaGroupClause(metaGraphs, sinceBatchId)}
    ORDER BY ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: graph }))
    .filter((row) => row.s && row.p && row.o);
}

function durableDeltaWhereClause(
  graph: string,
  metaGraphs: readonly string[],
): string {
  const values = metaGraphs.map((graph) => `<${assertSafeIri(graph)}>`).join(' ');
  if (!values) {
    return `
          GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
    `;
  }
  return `
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
      OPTIONAL {
        {
          SELECT ?deltaRoot ?deltaBid WHERE {
            VALUES ?deltaMg { ${values} }
            GRAPH ?deltaMg {
              ?deltaKa <${DKG_PART_OF}> ?deltaUal ;
                       <${DKG_ROOT_ENTITY}> ?deltaRoot .
              { ?deltaUal <${DKG_BATCH_ID}> ?deltaBid }
              UNION
              { ?deltaKa <${DKG_BATCH_ID}> ?deltaBid }
              FILTER(REGEX(STR(?deltaBid), "^-?\\\\d+$"))
            }
          }
        }
        FILTER(sameTerm(?s, ?deltaRoot) || STRSTARTS(STR(?s), CONCAT(STR(?deltaRoot), "/.well-known/genid/")))
        BIND(xsd:integer(STR(?deltaBid)) AS ?deltaBatch)
      }
    `;
}

function durableDeltaGroupClause(
  metaGraphs: readonly string[],
  sinceBatchId: bigint,
): string {
  if (metaGraphs.length === 0) return '';
  return `
    GROUP BY ?s ?p ?o
    HAVING(COUNT(?deltaBatch) = 0 || MAX(?deltaBatch) > ${sinceBatchId.toString()})
  `;
}

function dedupeRows(rows: readonly SyncRow[]): SyncRow[] {
  const seen = new Set<string>();
  const out: SyncRow[] = [];
  for (const row of rows) {
    const key = `${row.g}\u0000${row.s}\u0000${row.p}\u0000${row.o}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function contextGraphDataGraphUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}`;
}

function contextGraphMetaGraphUri(contextGraphId: string): string {
  return `${contextGraphDataGraphUri(contextGraphId)}/_meta`;
}

function stripLiteral(value: string | undefined): string {
  if (!value) return '';
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[\w-]+|\^\^<[^>]+>)?$/);
  return match ? match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : value;
}

function parseIntegerLiteral(value: string | undefined): bigint | null {
  const stripped = stripLiteral(value);
  if (!/^-?\d+$/.test(stripped)) return null;
  try {
    return BigInt(stripped);
  } catch {
    return null;
  }
}

function formatTerm(term: string): string {
  if (term.startsWith('"') || term.startsWith('_:')) return term;
  if (term.startsWith('<') && term.endsWith('>')) return term;
  return `<${assertSafeIri(term)}>`;
}
