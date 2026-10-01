import { assertSafeIri, compareCodePoint, GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { StoreResponseTooLargeError, type TripleStore, type QueryOptions } from '@origintrail-official/dkg-storage';
import type { ExactGraphReadMode } from './durable-data-request-policy.js';
import { SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE, SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS,
  type SyncRow } from './snapshot-cache.js';
import { SyncRowSnapshotBudgetError } from './snapshot-budget.js';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import { compareRows, formatTerm } from './row-serialization.js';
import { raceAgainstAbort, throwIfAborted, type RowListCache } from './responder-row-page.js';
const DKG = 'http://dkg.io/ontology/';
const DKG_CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const DKG_KA_UAL = `${DKG}kaUal`;
const DKG_ASSERTION_VERSION = `${DKG}assertionVersion`;
const DKG_ASSERTION_GRAPH = `${DKG}assertionGraph`;
const DKG_CONTEXT_GRAPH = `${DKG}contextGraph`;
const DKG_PUBLIC_TRIPLE_COUNT = `${DKG}publicTripleCount`;
const DKG_PRIVATE_TRIPLE_COUNT = `${DKG}privateTripleCount`;
const DKG_STATUS = `${DKG}status`;
const DKG_SUB_GRAPH_NAME = `${DKG}subGraphName`;
const DETERMINISTIC_KA_UAL_SHAPE = /^did:dkg:[^/]+\/0x[0-9A-Fa-f]{40}\/[0-9]+$/;
function syncResponderStoreOptions(signal: AbortSignal | undefined, source: string): QueryOptions {
  return { signal, priority: 'background', source };
}

interface ExactGraphPagePlanEntry {
  graph: string;
  rowCount: number;
}

/**
 * The last row consumed from one exact graph.  The responder wire still uses
 * numeric offsets, so this is an internal session cursor: the next sequential
 * page can seek from the last row without asking the store to walk every
 * preceding row again.
 *
 * `graphOffset` is retained only for the plan/count invariant.  It lets the
 * seek query request one sentinel row when it reaches the committed graph
 * boundary, just like the legacy OFFSET path does.
 */
interface ExactGraphPageCursor {
  graph: string;
  graphOffset: number;
  s: string;
  p: string;
  o: string;
}

interface ConfirmedGraphScopedVmManifestEntry extends ExactGraphPagePlanEntry {
  ual: string;
}

export interface GraphScopedVmManifest {
  confirmedEntries: readonly ConfirmedGraphScopedVmManifestEntry[];
  confirmedGraphs: ReadonlySet<string>;
  /** Complete V2 descriptors in any lifecycle state, used to reject tentative VM payloads. */
  knownGraphs: ReadonlySet<string>;
}

export interface ExactGraphPagePlan {
  entries: readonly ExactGraphPagePlanEntry[];
  totalRows: number;
  /** At most one exact graph is retained while an oversized phase is framed. */
  activeGraphRows?: {
    graph: string;
    rows: readonly SyncRow[];
  };
  activeGraphRowsLoad?: {
    graph: string;
    promise: Promise<readonly SyncRow[] | null>;
  };
  /** Graphs that exceeded the bounded local snapshot and require ordered paging. */
  pagedGraphs: Set<string>;
  /**
   * Session-bound page boundaries.  The map is deliberately bounded: a
   * requester may probe arbitrary offsets, and those probes must not turn a
   * pagination session into an unbounded control-plane cache.
   */
  cursors: Map<number, ExactGraphPageCursor | null>;
  cursorBytesEstimate?: number;

}

export interface ExactGraphPagePlanMemo {
  get(
    key: string,
    load: () => Promise<ExactGraphPagePlan>,
    options?: { refresh?: boolean; requireExisting?: boolean; signal?: AbortSignal },
  ): Promise<ExactGraphPagePlan | null>;
}


/**
 * Read the constant-size V2 control rows that already form a per-KA manifest.
 *
 * The payload graph and its row count are authenticated again by the requester,
 * but deriving the responder plan from these rows removes three store-wide or
 * per-graph discovery operations from the normal rootless path: graph-family
 * enumeration as authority, child-prefix probing after the reserved VM segment,
 * and COUNT(*)/countQuads for every KA. The query is deliberately one exact
 * metadata graph, standard SPARQL 1.1, unordered, row/response bounded, and
 * backend-neutral.
 */
export async function readGraphScopedVmManifest(
  store: TripleStore,
  contextGraphId: string,
  signal?: AbortSignal,
): Promise<GraphScopedVmManifest> {
  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const contextGraph = contextGraphDataGraphUri(contextGraphId);
  const maxRows = SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_ROWS;
  const readBoundedBindings = async (
    sparql: string,
    operation: string,
  ): Promise<Array<Record<string, string>>> => {
    let result;
    try {
      result = await store.query(sparql, {
        ...syncResponderStoreOptions(signal, operation),
        maxResponseBytes: snapshotResponseByteLimit(
          SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
        ),
      });
    } catch (error) {
      if (!(error instanceof StoreResponseTooLargeError)) throw error;
      throw snapshotBudgetError({
        key: `durable-v2-manifest:${contextGraphId}`,
        reason: 'snapshot_bytes',
        rows: 0,
        bytesEstimate: storeResponseActualBytes(error),
        limit: SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE,
      });
    }
    if (result.type !== 'bindings') return [];
    if (result.bindings.length > maxRows) {
      throw snapshotBudgetError({
        key: `durable-v2-manifest:${contextGraphId}`,
        reason: 'snapshot_rows',
        rows: result.bindings.length,
        bytesEstimate: 0,
        limit: maxRows,
      });
    }
    return result.bindings;
  };

  // Read every scope marker independently of the complete descriptor join.
  // Without this pass, a partially written V2 descriptor would be absent from
  // the join below and its payload graph could incorrectly fall through the
  // legacy compatibility lane.
  const markerBindings = await readBoundedBindings(`
    SELECT ?ual ?scopeVersion WHERE {
      GRAPH <${assertSafeIri(metaGraph)}> {
        ?ual <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion .
      }
    }
    LIMIT ${maxRows + 1}
  `, 'sync.responder.readGraphScopedVmManifestMarkers');
  const scopeVersionsByUal = new Map<string, Set<string>>();
  for (const row of markerBindings) {
    const ual = row['ual'];
    const rawVersion = row['scopeVersion'];
    if (!ual || !rawVersion) continue;
    const versions = scopeVersionsByUal.get(ual) ?? new Set<string>();
    versions.add(stripLiteral(rawVersion));
    scopeVersionsByUal.set(ual, versions);
  }
  const currentV2Uals = new Set<string>();
  for (const [ual, versions] of scopeVersionsByUal) {
    // Lifecycle, assertion-graph and SWM-operation rows deliberately repeat
    // contentScopeVersion. Only deterministic UAL subjects are V2 descriptor
    // candidates; a UAL-shaped partial descriptor still fails closed below.
    if (!DETERMINISTIC_KA_UAL_SHAPE.test(ual)) continue;
    if (versions.size !== 1) {
      throw new Error(`Rootless sync manifest ${ual} has ambiguous scopeVersion`);
    }
    const decoded = [...versions][0]!;
    if (!/^-?\d+$/.test(decoded)) {
      throw new Error(`Rootless sync manifest ${ual} has invalid scopeVersion: ${decoded}`);
    }
    const version = BigInt(decoded);
    if (version < 0n || version.toString() !== decoded) {
      throw new Error(`Rootless sync manifest ${ual} has non-canonical scopeVersion: ${decoded}`);
    }
    if (version === 0n || version === 1n) continue;
    if (version !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Rootless sync manifest ${ual} has unsupported contentScopeVersion ${decoded}`);
    }
    currentV2Uals.add(ual);
  }

  const bindings = await readBoundedBindings(`
      SELECT ?ual ?scopeVersion ?kaUal ?assertionVersion ?assertionGraph
             ?contextGraph ?publicTripleCount ?privateTripleCount ?status ?subGraphName
      WHERE {
        GRAPH <${assertSafeIri(metaGraph)}> {
          ?ual <${DKG_CONTENT_SCOPE_VERSION}> ?scopeVersion ;
               <${DKG_KA_UAL}> ?kaUal ;
               <${DKG_ASSERTION_VERSION}> ?assertionVersion ;
               <${DKG_ASSERTION_GRAPH}> ?assertionGraph ;
               <${DKG_CONTEXT_GRAPH}> ?contextGraph ;
               <${DKG_PUBLIC_TRIPLE_COUNT}> ?publicTripleCount ;
               <${DKG_PRIVATE_TRIPLE_COUNT}> ?privateTripleCount ;
               <${DKG_STATUS}> ?status .
          OPTIONAL { ?ual <${DKG_SUB_GRAPH_NAME}> ?subGraphName }
        }
      }
      LIMIT ${maxRows + 1}
  `, 'sync.responder.readGraphScopedVmManifest');

  type ManifestField =
    | 'scopeVersion'
    | 'kaUal'
    | 'assertionVersion'
    | 'assertionGraph'
    | 'contextGraph'
    | 'publicTripleCount'
    | 'privateTripleCount'
    | 'status'
    | 'subGraphName';
  const fields: readonly ManifestField[] = [
    'scopeVersion',
    'kaUal',
    'assertionVersion',
    'assertionGraph',
    'contextGraph',
    'publicTripleCount',
    'privateTripleCount',
    'status',
    'subGraphName',
  ];
  const byUal = new Map<string, Map<ManifestField, Set<string>>>();
  for (const row of bindings) {
    const ual = row['ual'];
    if (!ual) continue;
    const values = byUal.get(ual) ?? new Map<ManifestField, Set<string>>();
    for (const field of fields) {
      const value = row[field];
      if (!value) continue;
      const set = values.get(field) ?? new Set<string>();
      set.add(value);
      values.set(field, set);
    }
    byUal.set(ual, values);
  }
  for (const ual of currentV2Uals) {
    if (!byUal.has(ual)) {
      throw new Error(`Rootless sync manifest ${ual} has an incomplete V2 descriptor`);
    }
  }

  const confirmedEntries: ConfirmedGraphScopedVmManifestEntry[] = [];
  const knownGraphs = new Set<string>();
  const graphOwners = new Map<string, string>();
  for (const [ual, values] of byUal) {
    if (!currentV2Uals.has(ual)) continue;
    const requireSingle = (field: ManifestField): string => {
      const candidates = [...(values.get(field) ?? [])];
      if (candidates.length !== 1) {
        throw new Error(
          `Rootless sync manifest ${ual} has ${candidates.length === 0 ? 'missing' : 'ambiguous'} ${field}`,
        );
      }
      return candidates[0]!;
    };
    const optionalSingle = (field: ManifestField): string | undefined => {
      const candidates = [...(values.get(field) ?? [])];
      if (candidates.length > 1) {
        throw new Error(`Rootless sync manifest ${ual} has ambiguous ${field}`);
      }
      return candidates[0];
    };
    const parseCanonicalInteger = (field: ManifestField, minimum: bigint): bigint => {
      const decoded = stripLiteral(requireSingle(field));
      if (!/^-?\d+$/.test(decoded)) {
        throw new Error(`Rootless sync manifest ${ual} has invalid ${field}: ${decoded}`);
      }
      const value = BigInt(decoded);
      if (value < minimum || value.toString() !== decoded) {
        throw new Error(`Rootless sync manifest ${ual} has non-canonical ${field}: ${decoded}`);
      }
      return value;
    };

    const scopeVersion = parseCanonicalInteger('scopeVersion', 0n);
    if (scopeVersion !== BigInt(GRAPH_KA_CONTENT_SCOPE_VERSION)) {
      throw new Error(`Rootless sync manifest ${ual} changed scopeVersion during projection`);
    }
    const metadataUal = requireSingle('kaUal');
    if (metadataUal !== ual) {
      throw new Error(`Rootless sync manifest UAL mismatch: subject ${ual}, kaUal ${metadataUal}`);
    }
    const assertionVersion = parseCanonicalInteger('assertionVersion', 1n);
    const scope = createGraphKnowledgeAssetScope(ual, assertionVersion);
    if (scope.ual !== ual) {
      throw new Error(`Rootless sync manifest contains non-canonical UAL ${ual}`);
    }
    if (requireSingle('contextGraph') !== contextGraph) {
      throw new Error(`Rootless sync manifest ${ual} points outside context graph ${contextGraphId}`);
    }
    const rawSubGraphName = optionalSingle('subGraphName');
    const subGraphName = rawSubGraphName === undefined
      ? undefined
      : stripLiteral(rawSubGraphName);
    if (subGraphName !== undefined && !validateSubGraphName(subGraphName).valid) {
      throw new Error(`Rootless sync manifest ${ual} has invalid subGraphName ${subGraphName}`);
    }
    const expectedGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.VerifiableMemory,
      scope,
      subGraphName,
    );
    const assertionGraph = requireSingle('assertionGraph');
    if (assertionGraph !== expectedGraph) {
      throw new Error(
        `Rootless sync manifest ${ual} assertionGraph mismatch: expected ${expectedGraph}, found ${assertionGraph}`,
      );
    }
    const publicCount = parseCanonicalInteger('publicTripleCount', 0n);
    const privateCount = parseCanonicalInteger('privateTripleCount', 0n);
    if (publicCount > BigInt(Number.MAX_SAFE_INTEGER) || privateCount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Rootless sync manifest ${ual} has an unsafe triple count`);
    }
    if (publicCount === 0n && privateCount === 0n) {
      throw new Error(`Rootless sync manifest ${ual} describes an empty asset`);
    }
    const owner = graphOwners.get(assertionGraph);
    if (owner && owner !== ual) {
      throw new Error(`Rootless sync graph ${assertionGraph} has multiple UAL owners`);
    }
    graphOwners.set(assertionGraph, ual);
    knownGraphs.add(assertionGraph);

    const statuses = new Set(
      [...(values.get('status') ?? [])].map((status) => stripLiteral(status)),
    );
    if (statuses.size !== 1) {
      throw new Error(`Rootless sync manifest ${ual} has ambiguous status metadata`);
    }
    if (!statuses.has('confirmed')) continue;
    confirmedEntries.push({
      ual,
      graph: assertionGraph,
      rowCount: Number(publicCount),
    });
  }
  confirmedEntries.sort((a, b) => compareCodePoint(a.graph, b.graph));
  return {
    confirmedEntries,
    confirmedGraphs: new Set(confirmedEntries.map((entry) => entry.graph)),
    knownGraphs,
  };
}

export async function buildExactGraphPagePlan(
  store: TripleStore,
  graphs: readonly string[],
  isAdmitted: (graph: string) => Promise<boolean>,
  signal?: AbortSignal,
  knownRowCounts?: ReadonlyMap<string, number>,
  exactGraphReadMode: ExactGraphReadMode = 'snapshot-or-page',
): Promise<ExactGraphPagePlan> {
  const entries: ExactGraphPagePlanEntry[] = [];
  for (const graph of dedupeStrings(graphs).sort(compareCodePoint)) {
    throwIfAborted(signal);
    if (!(await isAdmitted(graph))) continue;
    const rowCount = knownRowCounts?.get(graph) ?? await store.countQuads(
      graph,
      syncResponderStoreOptions(signal, 'sync.responder.countExactGraphRows'),
    );
    if (rowCount > 0) entries.push({ graph, rowCount });
  }
  return {
    entries,
    totalRows: entries.reduce((sum, entry) => sum + entry.rowCount, 0),
    pagedGraphs: new Set(
      exactGraphReadMode === 'page-only'
        ? entries.map((entry) => entry.graph)
        : [],
    ),
    cursors: new Map([[0, null]]),
  };
}

export interface ExactGraphSnapshotLimits {
  maxRows: number;
  maxBytesEstimate: number;
  maxPageResponseBytes?: number;
}

const EXACT_GRAPH_CURSOR_CACHE_MAX_ENTRIES = 512;
export const EXACT_GRAPH_CURSOR_CACHE_MAX_BYTES_ESTIMATE = 256 * 1024;
export const EXACT_GRAPH_PLAN_MAX_BYTES_ESTIMATE = 1024 * 1024;

export function exactGraphPlanScalarBytes(plan: ExactGraphPagePlan): number {
  return 256 + plan.entries.reduce((bytes, entry) => bytes + 128 + entry.graph.length * 4, 0);
}

function exactGraphCursorBytes(cursor: ExactGraphPageCursor | null): number {
  return cursor ? 128 + (cursor.graph.length + cursor.s.length + cursor.p.length + cursor.o.length) * 2 : 32;
}

/** Datatypes whose SPARQL value comparison is numeric/date-like, not lexical. */
const SPARQL_VALUE_ORDERED_DATATYPES = [
  'http://www.w3.org/2001/XMLSchema#boolean',
  'http://www.w3.org/2001/XMLSchema#date',
  'http://www.w3.org/2001/XMLSchema#dateTime',
  'http://www.w3.org/2001/XMLSchema#dateTimeStamp',
  'http://www.w3.org/2001/XMLSchema#dayTimeDuration',
  'http://www.w3.org/2001/XMLSchema#decimal',
  'http://www.w3.org/2001/XMLSchema#double',
  'http://www.w3.org/2001/XMLSchema#duration',
  'http://www.w3.org/2001/XMLSchema#float',
  'http://www.w3.org/2001/XMLSchema#gDay',
  'http://www.w3.org/2001/XMLSchema#gMonth',
  'http://www.w3.org/2001/XMLSchema#gMonthDay',
  'http://www.w3.org/2001/XMLSchema#gYear',
  'http://www.w3.org/2001/XMLSchema#gYearMonth',
  'http://www.w3.org/2001/XMLSchema#integer',
  'http://www.w3.org/2001/XMLSchema#nonNegativeInteger',
  'http://www.w3.org/2001/XMLSchema#nonPositiveInteger',
  'http://www.w3.org/2001/XMLSchema#negativeInteger',
  'http://www.w3.org/2001/XMLSchema#positiveInteger',
  'http://www.w3.org/2001/XMLSchema#long',
  'http://www.w3.org/2001/XMLSchema#int',
  'http://www.w3.org/2001/XMLSchema#short',
  'http://www.w3.org/2001/XMLSchema#time',
  'http://www.w3.org/2001/XMLSchema#byte',
  'http://www.w3.org/2001/XMLSchema#unsignedLong',
  'http://www.w3.org/2001/XMLSchema#unsignedInt',
  'http://www.w3.org/2001/XMLSchema#unsignedShort',
  'http://www.w3.org/2001/XMLSchema#unsignedByte',
  'http://www.w3.org/2001/XMLSchema#yearMonthDuration',
] as const;

const SPARQL_VALUE_ORDERED_DATATYPE_VALUES = SPARQL_VALUE_ORDERED_DATATYPES
  .map((datatype) => `<${datatype}>`)
  .join(', ');

function hasValueOrderedDatatype(term: string): boolean {
  return SPARQL_VALUE_ORDERED_DATATYPES
    .some((datatype) => term.endsWith(`^^<${datatype}>`));
}

function hasUnsupportedExactGraphCursorTerm(cursor: ExactGraphPageCursor): boolean {
  // SPARQL exposes no portable ordering relation for blank-node identifiers.
  // Ordered XSD values also cannot be continued portably with `>`: float and
  // double admit NaN, duration comparison can be partial, and distinct lexical
  // forms can denote the same date/time or numeric value. ORDER BY can still
  // place those terms after the cursor even when `>` is false. Falling back
  // preserves the pre-existing deterministic path for each unsafe boundary.
  return [cursor.s, cursor.p, cursor.o].some((term) => (
    term.startsWith('_:') || hasValueOrderedDatatype(term)
  ));
}

/**
 * Build a SPARQL predicate for one term being strictly after a cursor term in
 * the backend's `ORDER BY` order. IRI rank is explicit, while
 * literal values use value comparison for ordered XSD datatypes and lexical
 * comparison otherwise.  The datatype/language tie-break mirrors Oxigraph's
 * RDF-term ordering and is covered by the mixed-term regression fixture.
 */
function termAfterExactGraphCursor(variable: string, cursorTerm: string): string {
  const formatted = formatTerm(cursorTerm);
  if (!cursorTerm.startsWith('"')) {
    return `(isLiteral(${variable}) || (isIRI(${variable}) && STR(${variable}) > STR(${formatted})))`;
  }
  return `(
    isLiteral(${variable}) && (
      (
        STR(${variable}) > STR(${formatted})
        && !(
          DATATYPE(${variable}) = DATATYPE(${formatted})
          && DATATYPE(${variable}) IN (${SPARQL_VALUE_ORDERED_DATATYPE_VALUES})
        )
      )
      || (
        STR(${variable}) = STR(${formatted}) && (
          STR(DATATYPE(${variable})) > STR(DATATYPE(${formatted}))
          || (
            DATATYPE(${variable}) = DATATYPE(${formatted})
            && LANG(${variable}) > LANG(${formatted})
          )
        )
      )
      || (
        DATATYPE(${variable}) = DATATYPE(${formatted})
        && DATATYPE(${variable}) IN (${SPARQL_VALUE_ORDERED_DATATYPE_VALUES})
        && ${variable} > ${formatted}
      )
    )
  )`;
}

function exactGraphCursorFilter(cursor: ExactGraphPageCursor): string {
  const s = formatTerm(cursor.s);
  const p = formatTerm(cursor.p);
  return `(
    ${termAfterExactGraphCursor('?s', cursor.s)}
    || (?s = ${s} && ${termAfterExactGraphCursor('?p', cursor.p)})
    || (
      ?s = ${s}
      && ?p = ${p}
      && ${termAfterExactGraphCursor('?o', cursor.o)}
    )
  )`;
}

function rememberExactGraphPageCursor(
  plan: ExactGraphPagePlan,
  offset: number,
  cursor: ExactGraphPageCursor,
): void {
  const existing = plan.cursors.get(offset);
  if (existing && (
    existing.graph !== cursor.graph
    || existing.graphOffset !== cursor.graphOffset
    || existing.s !== cursor.s
    || existing.p !== cursor.p
    || existing.o !== cursor.o
  )) {
    // A boundary changing within one memoized session means the source no
    // longer describes the committed plan. Do not silently choose one cursor.
    throw new Error(`Sync exact-graph cursor changed at offset ${offset}`);
  }
  plan.cursorBytesEstimate = (plan.cursorBytesEstimate ??
    [...plan.cursors.values()].reduce((bytes, value) => bytes + exactGraphCursorBytes(value), 0))
    - (existing ? exactGraphCursorBytes(existing) : 0);
  plan.cursors.delete(offset);
  const cursorBytes = exactGraphCursorBytes(cursor);
  // A single very large boundary stays on the compatible OFFSET path.
  if (cursorBytes > EXACT_GRAPH_CURSOR_CACHE_MAX_BYTES_ESTIMATE) return;
  plan.cursors.set(offset, cursor);
  plan.cursorBytesEstimate += cursorBytes;
  while (plan.cursors.size > EXACT_GRAPH_CURSOR_CACHE_MAX_ENTRIES ||
    plan.cursorBytesEstimate > EXACT_GRAPH_CURSOR_CACHE_MAX_BYTES_ESTIMATE) {
    let evict = plan.cursors.keys().next().value as number;
    // Offset zero is the session origin and is never evicted.
    if (evict === 0) {
      const next = plan.cursors.keys();
      next.next();
      evict = next.next().value as number;
    }
    plan.cursorBytesEstimate -= exactGraphCursorBytes(plan.cursors.get(evict) ?? null);
    plan.cursors.delete(evict);
  }
}

export function snapshotResponseByteLimit(maxBytesEstimate: number): number {
  // SPARQL JSON adds field names and escaping around each RDF term. Bound the
  // transport body independently while leaving enough headroom for that wire
  // overhead. HTTP adapters enforce this before parsing; embedded adapters are
  // still bounded by the row LIMIT below.
  return Math.max(
    1,
    Math.min(Number.MAX_SAFE_INTEGER, Math.floor(maxBytesEstimate) * 2),
  );
}

/** Clamp a store response-cap overshoot (possibly bigint) into a safe number. */
export function storeResponseActualBytes(error: StoreResponseTooLargeError): number {
  return typeof error.actualBytes === 'bigint'
    ? Number(error.actualBytes > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : error.actualBytes)
    : error.actualBytes;
}

export function snapshotBudgetError(params: {
  key: string;
  reason: 'snapshot_rows' | 'snapshot_bytes';
  rows: number;
  bytesEstimate: number;
  limit: number;
}): SyncRowSnapshotBudgetError {
  return new SyncRowSnapshotBudgetError(params);
}

async function loadExactGraphRowsSnapshot(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  entry: ExactGraphPagePlanEntry,
  limits: ExactGraphSnapshotLimits,
  signal?: AbortSignal,
): Promise<readonly SyncRow[] | null> {
  if (entry.rowCount > limits.maxRows || plan.pagedGraphs.has(entry.graph)) return null;
  if (plan.activeGraphRows?.graph === entry.graph) return plan.activeGraphRows.rows;
  if (plan.activeGraphRowsLoad?.graph === entry.graph) {
    return raceAgainstAbort(plan.activeGraphRowsLoad.promise, signal);
  }

  const load = (async (): Promise<readonly SyncRow[] | null> => {
    try {
      const result = await store.query(`
        SELECT ?s ?p ?o WHERE {
          GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }
        }
        LIMIT ${limits.maxRows + 1}
      `, {
        ...syncResponderStoreOptions(undefined, 'sync.responder.readExactGraphSnapshot'),
        maxResponseBytes: snapshotResponseByteLimit(limits.maxBytesEstimate),
      });
      if (result.type !== 'bindings') return [];
      const rows: SyncRow[] = [];
      let bytesEstimate = 0;
      for (const row of result.bindings) {
        const s = row['s'];
        const p = row['p'];
        const o = row['o'];
        if (!s || !p || !o) continue;
        const nextBytes = bytesEstimate + estimateStringRowHeapBytes(s, p, o, entry.graph);
        if (rows.length + 1 > limits.maxRows || nextBytes > limits.maxBytesEstimate) {
          plan.pagedGraphs.add(entry.graph);
          return null;
        }
        rows.push({ s, p, o, g: entry.graph });
        bytesEstimate = nextBytes;
      }
      // The plan count and payload must describe one immutable graph snapshot.
      // A mismatch means the graph changed between COUNT and SELECT; fail the
      // session rather than silently skipping or duplicating rows.
      if (rows.length !== entry.rowCount) {
        throw new Error(
          `Sync exact-graph plan changed while reading ${entry.graph}: ` +
          `expected ${entry.rowCount} rows, found ${rows.length}`,
        );
      }
      rows.sort(compareRows);
      plan.activeGraphRows = { graph: entry.graph, rows };
      return rows;
    } catch (error) {
      if (error instanceof StoreResponseTooLargeError) {
        plan.pagedGraphs.add(entry.graph);
        return null;
      }
      throw error;
    }
  })().finally(() => {
    if (plan.activeGraphRowsLoad?.promise === load) plan.activeGraphRowsLoad = undefined;
  });
  plan.activeGraphRowsLoad = { graph: entry.graph, promise: load };
  return raceAgainstAbort(load, signal);
}

export async function readExactGraphPlanSnapshot(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  cache: RowListCache,
  limits: ExactGraphSnapshotLimits,
): Promise<readonly SyncRow[]> {
  if (plan.totalRows > limits.maxRows) {
    throw snapshotBudgetError({
      key: cache.key,
      reason: 'snapshot_rows',
      rows: plan.totalRows,
      bytesEstimate: 0,
      limit: limits.maxRows,
    });
  }
  const rows: SyncRow[] = [];
  let bytesEstimate = 0;
  for (const entry of plan.entries) {
    const graphRows = await loadExactGraphRowsSnapshot(store, plan, entry, limits);
    if (!graphRows) {
      throw snapshotBudgetError({
        key: cache.key,
        reason: 'snapshot_bytes',
        rows: rows.length,
        bytesEstimate: limits.maxBytesEstimate + 1,
        limit: limits.maxBytesEstimate,
      });
    }
    for (const row of graphRows) {
      const nextBytes = bytesEstimate + estimateStringRowHeapBytes(row.s, row.p, row.o, row.g);
      if (nextBytes > limits.maxBytesEstimate) {
        throw snapshotBudgetError({
          key: cache.key,
          reason: 'snapshot_bytes',
          rows: rows.length + 1,
          bytesEstimate: nextBytes,
          limit: limits.maxBytesEstimate,
        });
      }
      rows.push(row);
      bytesEstimate = nextBytes;
    }
  }
  return rows.sort(compareRows);
}


export function rememberExactGraphReturnedPrefix(
  plan: ExactGraphPagePlan,
  offset: number,
  rows: readonly SyncRow[],
): void {
  const lastRow = rows[rows.length - 1];
  if (!lastRow) return;
  let graphStart = 0;
  for (const entry of plan.entries) {
    if (entry.graph === lastRow.g) {
      rememberExactGraphPageCursor(plan, offset + rows.length, {
        graph: lastRow.g, graphOffset: offset + rows.length - graphStart,
        s: lastRow.s, p: lastRow.p, o: lastRow.o,
      });
      return;
    }
    graphStart += entry.rowCount;
  }
}

export async function readRowsPageFromExactGraphPlan(
  store: TripleStore,
  plan: ExactGraphPagePlan,
  offset: number,
  limit: number,
  snapshotLimits: ExactGraphSnapshotLimits,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const safeOffset = Math.max(0, Math.floor(offset));
  let skip = safeOffset;
  let remaining = Math.max(0, Math.floor(limit));
  if (remaining === 0 || skip >= plan.totalRows) return [];
  const rows: SyncRow[] = [];
  const cursor = plan.cursors.get(safeOffset);
  const useSeek = cursor !== undefined
    && cursor !== null
    && !hasUnsupportedExactGraphCursorTerm(cursor);
  let cursorActive = useSeek;
  let lastGraphOffset = 0;
  let lastRow: SyncRow | undefined;

  for (const entry of plan.entries) {
    let entryOffset: number;
    let seekFilter: string | undefined;
    if (cursorActive && cursor) {
      const graphOrder = compareCodePoint(entry.graph, cursor.graph);
      if (graphOrder < 0) continue;
      if (graphOrder === 0) {
        entryOffset = cursor.graphOffset;
        if (entryOffset > entry.rowCount) {
          throw new Error(
            `Sync exact-graph cursor is past the committed row count for ${entry.graph}`,
          );
        }
        seekFilter = exactGraphCursorFilter(cursor);
      } else {
        // Once the cursor's graph is exhausted, every later graph starts at
        // row zero and can be read with a plain LIMIT.  There is no OFFSET to
        // make the store revisit the already-consumed prefix.
        entryOffset = 0;
      }
    } else {
      if (skip >= entry.rowCount) {
        skip -= entry.rowCount;
        continue;
      }
      entryOffset = skip;
    }
    const expectedRows = Math.min(entry.rowCount - entryOffset, remaining);
    if (expectedRows <= 0) {
      cursorActive = false;
      // The cursor already consumed this graph. Subsequent graphs start at
      // their own zero offset rather than reusing the request's global offset.
      skip = 0;
      continue;
    }
    let added = 0;
    const graphRows = await loadExactGraphRowsSnapshot(
      store,
      plan,
      entry,
      snapshotLimits,
      signal,
    );
    if (graphRows) {
      const page = graphRows.slice(entryOffset, entryOffset + expectedRows);
      rows.push(...page);
      added = page.length;
    } else {
      const isFinalGraphPage = entryOffset + expectedRows === entry.rowCount;
      const seekEntry = cursorActive && cursor !== undefined && cursor !== null;
      const offsetClause = seekFilter || seekEntry ? '' : `\n        OFFSET ${entryOffset}`;
      // Keep the no-cursor query compact and compatible with adapters and
      // instrumentation that recognize the established one-line graph
      // pattern.  Cursor pages need the expanded form for their FILTER.
      const graphPattern = seekFilter
        ? `GRAPH <${assertSafeIri(entry.graph)}> {
            ?s ?p ?o
            FILTER(${seekFilter})
          }`
        : `GRAPH <${assertSafeIri(entry.graph)}> { ?s ?p ?o }`;
      const result = await store.query(`
        SELECT ?s ?p ?o WHERE {
          ${graphPattern}
        }
        ORDER BY ?s ?p ?o
        ${offsetClause}
        LIMIT ${expectedRows + (isFinalGraphPage ? 1 : 0)}
      `, {
        ...syncResponderStoreOptions(signal, 'sync.responder.readExactGraphRowsPage'),
        maxResponseBytes: snapshotLimits.maxPageResponseBytes ??
          snapshotResponseByteLimit(snapshotLimits.maxBytesEstimate),
      });
      if (result.type === 'bindings') {
        for (const row of result.bindings) {
          const s = row['s'];
          const p = row['p'];
          const o = row['o'];
          if (s && p && o) {
            rows.push({ s, p, o, g: entry.graph });
            added += 1;
          }
        }
      }
      if (isFinalGraphPage && added > expectedRows) {
        throw new Error(
          `Sync exact-graph plan changed while paging ${entry.graph}: `
          + `expected ${entry.rowCount} total rows but found a surplus row`,
        );
      }
    }
    // Exact-asset metadata is a commitment to the number of rows in each
    // assertion graph. Do not let a short graph borrow rows from the next
    // graph in the plan: that produces a full-looking response whose graph
    // boundaries no longer match the manifest and hides the damaged source.
    if (added !== expectedRows) {
      throw new Error(
        `Sync exact-graph plan changed while paging ${entry.graph}: ` +
        `expected ${expectedRows} rows at offset ${entryOffset}, found ${added}`,
      );
    }
    if (added > 0) {
      lastRow = rows[rows.length - 1];
      lastGraphOffset = entryOffset + added;
    }
    remaining -= added;
    if (remaining <= 0) break;
    skip = 0;
    // The cursor has served its graph.  Later entries are read from their
    // beginning, still without OFFSET.
    cursorActive = false;
  }

  const expectedTotal = Math.min(safeOffset + Math.max(0, Math.floor(limit)), plan.totalRows)
    - safeOffset;
  if (rows.length !== expectedTotal) {
    throw new Error(
      `Sync exact-graph plan changed at offset ${safeOffset}: `
      + `expected ${expectedTotal} rows, found ${rows.length}`,
    );
  }
  if (lastRow) {
    rememberExactGraphPageCursor(plan, safeOffset + rows.length, {
      graph: lastRow.g,
      graphOffset: lastGraphOffset,
      s: lastRow.s,
      p: lastRow.p,
      o: lastRow.o,
    });
  }
  return rows;
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
