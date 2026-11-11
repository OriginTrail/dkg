import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { PreparedSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import type { QueryResult } from '@origintrail-official/dkg-storage';
import { hasDefaultGraphRead } from './sparql-default-graph-pattern.js';
import type { StoreReadLane } from './query-store-read-context.js';

const LOOKUP_BATCH = 256;

/**
 * The graphs a query names when it reads only through explicit `GRAPH <iri>`
 * clauses: every graph target is an IRI and nothing reads the default graph.
 * Null for every other query.
 */
export function explicitGraphTargets(scope: PreparedSparqlQuery): string[] | null {
  if (scope.graphTargets.length === 0 || scope.operation === 'DESCRIBE'
    || scope.readsOnlyDeclaredNamedSet || hasDefaultGraphRead(scope)) return null;
  const graphs = new Set<string>();
  for (const target of scope.graphTargets) {
    if (target.kind !== 'iri') return null;
    graphs.add(target.iri);
  }
  return [...graphs];
}

interface GraphLookupReads {
  query(sparql: string): Promise<QueryResult>;
}

/**
 * The named graphs among these that the store holds, by one existence probe per
 * graph: no prefix is listed and no other graph is read, so the cost follows the
 * number of names, not the size of the store.
 */
export async function readStoredGraphs(reads: GraphLookupReads, graphs: readonly string[],
  visible: (graph: string) => boolean = () => true): Promise<string[]> {
  const stored: string[] = [];
  for (let offset = 0; offset < graphs.length; offset += LOOKUP_BATCH) {
    const values = graphs.slice(offset, offset + LOOKUP_BATCH).map(graph => `<${assertSafeIri(graph)}>`).join(' ');
    const result = await reads.query(`SELECT ?graph WHERE { VALUES ?graph { ${values} } FILTER EXISTS { GRAPH ?graph { ?s ?p ?o } } }`);
    if (result.type !== 'bindings') throw new Error('graph lookup expected SELECT bindings');
    for (const row of result.bindings) if (row.graph && visible(row.graph)) stored.push(row.graph);
  }
  return stored;
}

/**
 * A lane whose catalog holds only the named graphs the store has, so a route's
 * own graph rule can judge each one. A named graph is looked up once, and only
 * when the route lists a prefix it falls under.
 */
export function laneOverNamedGraphs(named: readonly string[], reads: StoreReadLane,
  visible?: (graph: string) => boolean): StoreReadLane {
  const stored = new Map<string, boolean>();
  return {
    query: reads.query,
    listGraphsByPrefix: async prefix => {
      const under = named.filter(graph => graph.startsWith(prefix));
      const unknown = under.filter(graph => !stored.has(graph));
      if (unknown.length > 0) {
        const found = new Set(await readStoredGraphs(reads, unknown, visible));
        for (const graph of unknown) stored.set(graph, found.has(graph));
      }
      return under.filter(graph => stored.get(graph));
    },
  };
}

export interface ExplicitGraphMembershipCounts {
  /** Named graphs judged both ways. */
  readonly checked: number;
  /** Named graphs the two ways judged differently. */
  readonly disagreed: number;
  /** Queries whose membership check could not run. */
  readonly failed: number;
}

/** Log the first disagreements, then at each power of two. */
const worthLogging = (count: number) => count <= 20 || (count & (count - 1)) === 0;

/**
 * Counting mode of the membership check for explicit graphs. The enumeration
 * decides; the check runs beside it, and each disagreement is counted and logged.
 * The check never changes a query's answer: its failures are counted too.
 */
export class ExplicitGraphMembershipCheck {
  private readonly counts = { checked: 0, disagreed: 0, failed: 0 };

  snapshot(): ExplicitGraphMembershipCounts {
    return { ...this.counts };
  }

  /** A check the caller's abort ends is neither a disagreement nor a failure. */
  async compare(route: string, graphs: readonly string[], enumerated: readonly string[],
    members: () => Promise<readonly string[]>, signal?: AbortSignal): Promise<void> {
    let judged: ReadonlySet<string>;
    try {
      judged = new Set(await members());
    } catch (error) {
      if (signal?.aborted) return;
      const failed = ++this.counts.failed;
      if (worthLogging(failed)) {
        console.warn(`[DKGQueryEngine] explicit graph membership check failed on the ${route} (${failed} so far): ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    const named = new Set(graphs);
    const listed = new Set(enumerated.filter(graph => named.has(graph)));
    for (const graph of graphs) {
      this.counts.checked++;
      if (listed.has(graph) === judged.has(graph)) continue;
      const disagreed = ++this.counts.disagreed;
      if (worthLogging(disagreed)) {
        console.warn(`[DKGQueryEngine] explicit graph membership check disagrees with the enumeration on the ${route}: ` +
          `<${graph}> enumerated=${listed.has(graph)} member=${judged.has(graph)} (${disagreed} of ${this.counts.checked} graphs so far)`);
      }
    }
  }
}
