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
  get(options?: { refresh?: boolean }): Promise<readonly string[]>;
}

export function createResponderGraphListMemo(
  store: TripleStore,
  ttlMs = 10_000,
): GraphListMemo {
  let cached: readonly string[] | null = null;
  let cachedAt = 0;
  let inflight: Promise<readonly string[]> | null = null;
  return {
    async get(options?: { refresh?: boolean }) {
      const now = Date.now();
      if (inflight) return [...(await inflight)];
      if (!options?.refresh && cached && now - cachedAt < ttlMs) return [...cached];
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
  const candidateGraphs = graphs.filter((graph) => graphSet.has(graph));
  if (!params.cutoffIso) {
    return readPagedRowsAcrossGraphs(params.store, candidateGraphs, params.offset, params.limit, async () => true);
  }

  const rows: SyncRow[] = [];
  let skip = params.offset;
  let remaining = params.limit;
  for (const graph of candidateGraphs) {
    if (skip > 0) {
      const count = await countFreshSwmMetaGraphRows(params.store, graph, params.cutoffIso);
      if (skip >= count) {
        skip -= count;
        continue;
      }
    }

    const page = await readFreshSwmMetaGraphRowsPage(params.store, graph, params.cutoffIso, skip, remaining);
    rows.push(...page);
    remaining -= page.length;
    skip = 0;
    if (remaining <= 0) break;
  }
  return rows;
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
  const candidateGraphsFor = (graph: string) => params.graphList
    .filter((candidate) => candidate === graph || candidate.startsWith(`${graph}/`))
    .sort(compareCodePoint);

  if (!params.cutoffIso) {
    const candidateGraphs = dedupeStrings(dataGraphs.flatMap(candidateGraphsFor)).sort(compareCodePoint);
    return readPagedRowsAcrossGraphs(params.store, candidateGraphs, params.offset, params.limit, async () => true);
  }

  const rows: SyncRow[] = [];
  let skip = params.offset;
  let remaining = params.limit;
  for (const graph of dataGraphs) {
    const metaGraph = `${graph}_meta`;
    if (!graphSet.has(metaGraph)) continue;
    for (const candidate of candidateGraphsFor(graph)) {
      if (skip > 0) {
        const count = await countFreshSwmDataGraphRows(params.store, candidate, metaGraph, params.cutoffIso);
        if (skip >= count) {
          skip -= count;
          continue;
        }
      }

      const page = await readFreshSwmDataGraphRowsPage(params.store, candidate, metaGraph, params.cutoffIso, skip, remaining);
      rows.push(...page);
      remaining -= page.length;
      skip = 0;
      if (remaining <= 0) break;
    }
    if (remaining <= 0) break;
  }
  return rows;
}

export async function readDurableMetaPage(params: {
  store: TripleStore;
  contextGraphId: string;
  offset: number;
  limit: number;
}): Promise<SyncRow[]> {
  return readDurableMetaRowsPage(
    params.store,
    params.contextGraphId,
    params.offset,
    params.limit,
  );
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

async function countFreshSwmMetaGraphRows(
  store: TripleStore,
  graph: string,
  cutoffIso: string,
): Promise<number> {
  const res = await store.query(`
    SELECT (COUNT(*) AS ?count) WHERE {
      GRAPH <${assertSafeIri(graph)}> {
        ?s ?p ?o .
        ?s <${DKG_PUBLISHED_AT}> ?ts .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readFreshSwmMetaGraphRowsPage(
  store: TripleStore,
  graph: string,
  cutoffIso: string,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const res = await store.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <${assertSafeIri(graph)}> {
        ?s ?p ?o .
        ?s <${DKG_PUBLISHED_AT}> ?ts .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
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

async function countFreshSwmDataGraphRows(
  store: TripleStore,
  graph: string,
  metaGraph: string,
  cutoffIso: string,
): Promise<number> {
  const res = await store.query(`
    SELECT (COUNT(*) AS ?count) WHERE {
      {
        SELECT DISTINCT ?s ?p ?o WHERE {
          ${freshSwmDataWhereClause(graph, metaGraph, cutoffIso)}
        }
      }
    }
  `);
  if (res.type !== 'bindings') return 0;
  const value = parseIntegerLiteral(res.bindings[0]?.['count']);
  if (value == null || value < 0n) return 0;
  return Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
}

async function readFreshSwmDataGraphRowsPage(
  store: TripleStore,
  graph: string,
  metaGraph: string,
  cutoffIso: string,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const res = await store.query(`
    SELECT DISTINCT ?s ?p ?o WHERE {
      ${freshSwmDataWhereClause(graph, metaGraph, cutoffIso)}
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

function freshSwmDataWhereClause(graph: string, metaGraph: string, cutoffIso: string): string {
  return `
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?op <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_WORKSPACE_OPERATION}> ;
            <${DKG_PUBLISHED_AT}> ?ts ;
            <${DKG_ROOT_ENTITY}> ?root .
        FILTER(?ts >= ${sparqlString(cutoffIso)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)
      }
      GRAPH <${assertSafeIri(graph)}> { ?s ?p ?o }
      FILTER(sameTerm(?s, ?root) || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/")))
  `;
}

async function readDurableMetaRowsPage(
  store: TripleStore,
  contextGraphId: string,
  offset: number,
  limit: number,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const cgEntity = contextGraphDataGraphUri(contextGraphId);
  const workingMemory = sparqlString(MemoryLayer.WorkingMemory);
  const res = await store.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> { ?s ?p ?o }
      FILTER(
        STR(?s) = ${sparqlString(cgEntity)} ||
        STRSTARTS(STR(?s), "did:dkg:activity:") ||
        STRSTARTS(STR(?s), "did:dkg:join-request:") ||
        EXISTS {
          GRAPH <${assertSafeIri(metaGraph)}> {
            ?lc <${DKG_MEMORY_LAYER}> ?layer .
            FILTER(STR(?layer) != ${workingMemory})
            {
              FILTER(sameTerm(?lc, ?s))
            } UNION {
              ?lc <${DKG_ASSERTION_GRAPH}> ?s .
            } UNION {
              ?lc <${DKG_ASSERTION_NAME}> ?aname .
              FILTER(
                CONTAINS(STR(?s), "/assertion/") &&
                STRENDS(STR(?s), CONCAT("/", STR(?aname)))
              )
            }
          }
        } ||
        EXISTS {
          GRAPH <${assertSafeIri(metaGraph)}> {
            { ?evt <http://www.w3.org/ns/prov#generated> ?parent }
            UNION
            { ?evt <http://www.w3.org/ns/prov#used> ?parent }
            FILTER(sameTerm(?evt, ?s))
            ?parent <${DKG_MEMORY_LAYER}> ?eventLayer .
            FILTER(STR(?eventLayer) != ${workingMemory})
          }
        }
      )
    }
    ORDER BY ?s ?p ?o
    OFFSET ${safeOffset}
    LIMIT ${safeLimit}
  `);
  if (res.type !== 'bindings') return [];
  return res.bindings
    .map((row) => ({ s: row['s'], p: row['p'], o: row['o'], g: metaGraph }))
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

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
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
