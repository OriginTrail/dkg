// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { inspectAuthoritativePublicMeta } from './context-graph-public-meta-proof.js';

export interface PublicMetaRepairResult {
  candidates: number;
  repairedGraphs: number;
  insertedTriples: number;
  conflictingGraphs: string[];
}

/**
 * Backfill canonical public root metadata for context graphs whose durable,
 * local-only membership record proves they were created by this node.
 *
 * The caller must supply ids sourced from `contextGraphMembershipStore` rows
 * marked `source="local-create"`; ONTOLOGY creator claims are deliberately
 * irrelevant because network gossip can spoof them. Store inspection is
 * batched into one portable SPARQL query rather than an N+1 query per graph.
 */
export async function repairLocallyCreatedPublicMetaProjections(
  store: TripleStore,
  locallyCreatedContextGraphIds: readonly string[],
): Promise<PublicMetaRepairResult> {
  const trustedEntries = [...new Set(locallyCreatedContextGraphIds)]
    .map((contextGraphId) => {
      try {
        return {
          contextGraphId,
          subject: assertSafeIri(contextGraphDataGraphUri(contextGraphId)),
          metaGraph: assertSafeIri(contextGraphMetaGraphUri(contextGraphId)),
        };
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  if (trustedEntries.length === 0) {
    return {
      candidates: 0,
      repairedGraphs: 0,
      insertedTriples: 0,
      conflictingGraphs: [],
    };
  }

  const ontologyGraph = assertSafeIri(
    contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  );
  const values = trustedEntries
    .map(({ subject, metaGraph }) => `(<${subject}> <${metaGraph}>)`)
    .join('\n      ');
  const result = await store.query(`
    SELECT ?contextGraph ?metaGraph ?predicate ?object WHERE {
      VALUES (?contextGraph ?metaGraph) {
        ${values}
      }
      GRAPH <${ontologyGraph}> {
        ?contextGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> ;
          <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?ontologyPolicy .
        FILTER(
          isLiteral(?ontologyPolicy) &&
          LCASE(REPLACE(STR(?ontologyPolicy), "^\\\\s+|\\\\s+$", "")) = "public"
        )
        FILTER NOT EXISTS {
          ?contextGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?conflictingOntologyPolicy .
          FILTER(
            !isLiteral(?conflictingOntologyPolicy) ||
            LCASE(REPLACE(STR(?conflictingOntologyPolicy), "^\\\\s+|\\\\s+$", "")) != "public"
          )
        }
      }
      OPTIONAL {
        GRAPH ?metaGraph {
          ?contextGraph ?predicate ?object .
          FILTER(?predicate IN (
            <${DKG_ONTOLOGY.RDF_TYPE}>,
            <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}>
          ))
        }
      }
    }
  `);
  const rows = result.type === 'bindings' ? result.bindings : [];
  const trustedBySubject = new Map(trustedEntries.map((entry) => [entry.subject, entry]));
  const existingBySubject = new Map<string, Quad[]>();
  for (const row of rows) {
    const subject = row['contextGraph'];
    const entry = subject ? trustedBySubject.get(subject) : undefined;
    if (!entry) continue;
    const existing = existingBySubject.get(subject) ?? [];
    if (row['predicate'] && row['object']) {
      existing.push({
        subject,
        predicate: row['predicate'],
        object: row['object'],
        graph: entry.metaGraph,
      });
    }
    existingBySubject.set(subject, existing);
  }

  const inserts: Quad[] = [];
  const conflictingGraphs: string[] = [];
  let repairedGraphs = 0;
  for (const [subject, existing] of existingBySubject) {
    const entry = trustedBySubject.get(subject)!;
    const inspection = inspectAuthoritativePublicMeta(entry.contextGraphId, existing);
    if (inspection.conflictingAccessPolicy) {
      conflictingGraphs.push(entry.contextGraphId);
      continue;
    }
    if (inspection.missingQuads.length === 0) continue;
    inserts.push(...inspection.missingQuads);
    repairedGraphs += 1;
  }

  if (inserts.length > 0) {
    await store.insert(inserts, { source: 'agent.publicMetaRepair' });
    await store.flush?.();
  }

  return {
    candidates: existingBySubject.size,
    repairedGraphs,
    insertedTriples: inserts.length,
    conflictingGraphs,
  };
}
