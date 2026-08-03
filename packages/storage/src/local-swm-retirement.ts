import {
  DKG_SWM_FINALIZED_PREDICATE,
  assertSafeIri,
} from '@origintrail-official/dkg-core';
import { LOCAL_TRUSTED_KA_CONTROLS_GRAPH } from './local-trusted-controls.js';
import type { Quad, QueryResult } from './triple-store.js';

const DKG_ASSERTION_GRAPH = 'http://dkg.io/ontology/assertionGraph';
const DKG_ASSERTION_VERSION = 'http://dkg.io/ontology/assertionVersion';
const XSD_NAMESPACE = 'http://www.w3.org/2001/XMLSchema#';
const XSD_INTEGER = `${XSD_NAMESPACE}integer`;

function assertionVersionLiteral(assertionVersion: string | number | bigint): string {
  const version = BigInt(assertionVersion);
  if (version < 1n) throw new Error(`SWM retirement assertion version must be positive: ${version}`);
  return `"${version}"^^<${XSD_INTEGER}>`;
}

/** One node-local, version-bound authority record for an exact SWM graph. */
export function localSwmRetirementMarker(
  assertionGraph: string,
  assertionVersion: string | number | bigint,
): Quad {
  return {
    graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    subject: assertSafeIri(assertionGraph),
    predicate: DKG_SWM_FINALIZED_PREDICATE,
    object: assertionVersionLiteral(assertionVersion),
  };
}

/** Exact delete pattern for one assertion version; newer markers are preserved. */
export function localSwmRetirementMarkerPattern(
  assertionGraph: string,
  assertionVersion: string | number | bigint,
): Partial<Quad> {
  return localSwmRetirementMarker(assertionGraph, assertionVersion);
}

/** Delete pattern for all obsolete retirement versions of one SWM graph. */
export function localSwmRetirementMarkerSubjectPattern(
  assertionGraph: string,
): Partial<Quad> {
  return {
    graph: LOCAL_TRUSTED_KA_CONTROLS_GRAPH,
    subject: assertSafeIri(assertionGraph),
    predicate: DKG_SWM_FINALIZED_PREDICATE,
  };
}

/**
 * Resolve only local retirement markers that match a candidate graph's current
 * durable SWM head. Peer metadata and stale local assertion versions cannot
 * satisfy this join.
 */
export async function discoverLocallyRetiredSwmGraphs(
  metaGraphs: readonly string[],
  reader: { query(sparql: string): Promise<QueryResult> },
): Promise<Set<string>> {
  const safeMetaGraphs = [...new Set(metaGraphs.map((graph) => assertSafeIri(graph)))];
  if (safeMetaGraphs.length === 0) return new Set();

  const result = await reader.query(
    `PREFIX xsd: <${XSD_NAMESPACE}>
    SELECT DISTINCT ?graph WHERE {
      {
        SELECT ?graph (MAX(xsd:integer(?candidateVersion)) AS ?assertionVersion) WHERE {
          VALUES ?metaGraph { ${safeMetaGraphs.map((graph) => `<${graph}>`).join(' ')} }
          GRAPH ?metaGraph {
            ?head <${DKG_ASSERTION_GRAPH}> ?graph ;
              <${DKG_ASSERTION_VERSION}> ?candidateVersion .
          }
        }
        GROUP BY ?graph
      }
      GRAPH <${LOCAL_TRUSTED_KA_CONTROLS_GRAPH}> {
        ?graph <${DKG_SWM_FINALIZED_PREDICATE}> ?assertionVersion .
      }
    }`,
  );
  if (result.type !== 'bindings') return new Set();
  return new Set(result.bindings
    .map((binding) => binding['graph']?.replace(/^<|>$/g, ''))
    .filter((graph): graph is string => Boolean(graph)));
}
