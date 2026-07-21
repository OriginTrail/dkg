// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { buildAuthoritativePublicMetaQuads } from './context-graph-public-meta-proof.js';
import { stripLiteral } from './dkg-agent-utils.js';

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';

export interface PublicMetaRepairResult {
  candidates: number;
  repairedGraphs: number;
  insertedTriples: number;
  conflictingGraphs: string[];
}

/**
 * Backfill the canonical public proof for graphs created by this exact peer.
 *
 * Older builds wrote public definitions only to ONTOLOGY even though the sync
 * admission contract requires `rdf:type` and `accessPolicy="public"` in the
 * root `_meta` graph. Only creator-owned ontology rows are eligible: a
 * subscriber must never promote a network-discovered definition into an
 * authoritative control snapshot. Existing non-public `_meta` policy is a
 * hard conflict and is left untouched.
 */
export async function repairCreatorPublicMetaProjections(
  store: TripleStore,
  peerId: string,
): Promise<PublicMetaRepairResult> {
  const ontologyGraph = assertSafeIri(
    contextGraphDataGraphUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY),
  );
  const creatorDid = assertSafeIri(`did:dkg:agent:${peerId}`);
  const candidatesResult = await store.query(`
    SELECT DISTINCT ?contextGraph WHERE {
      GRAPH <${ontologyGraph}> {
        ?contextGraph <${DKG_ONTOLOGY.RDF_TYPE}> <${DKG_ONTOLOGY.DKG_CONTEXT_GRAPH}> ;
          <${DKG_ONTOLOGY.DKG_CREATOR}> <${creatorDid}> ;
          <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?accessPolicy .
        FILTER(
          isLiteral(?accessPolicy) &&
          LCASE(REPLACE(STR(?accessPolicy), "^\\\\s+|\\\\s+$", "")) = "public"
        )
        FILTER NOT EXISTS {
          ?contextGraph <${DKG_ONTOLOGY.DKG_CREATOR}> ?conflictingCreator .
          FILTER(?conflictingCreator != <${creatorDid}>)
        }
        FILTER NOT EXISTS {
          ?contextGraph <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}> ?conflictingAccessPolicy .
          FILTER(
            !isLiteral(?conflictingAccessPolicy) ||
            LCASE(REPLACE(STR(?conflictingAccessPolicy), "^\\\\s+|\\\\s+$", "")) != "public"
          )
        }
      }
    }
  `);
  const candidateSubjects = candidatesResult.type === 'bindings'
    ? [...new Set(candidatesResult.bindings
        .map((row) => row['contextGraph'])
        .filter((value): value is string => Boolean(value)))]
    : [];

  const inserts: Quad[] = [];
  const conflictingGraphs: string[] = [];
  let repairedGraphs = 0;

  for (const subject of candidateSubjects) {
    if (!subject.startsWith(CONTEXT_GRAPH_URI_PREFIX)) continue;
    const contextGraphId = subject.slice(CONTEXT_GRAPH_URI_PREFIX.length);
    if (!contextGraphId || contextGraphDataGraphUri(contextGraphId) !== subject) continue;
    const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
    const existingResult = await store.query(`
      SELECT ?predicate ?object WHERE {
        GRAPH <${metaGraph}> {
          <${assertSafeIri(subject)}> ?predicate ?object .
          FILTER(?predicate IN (
            <${DKG_ONTOLOGY.RDF_TYPE}>,
            <${DKG_ONTOLOGY.DKG_ACCESS_POLICY}>
          ))
        }
      }
    `);
    const existing = existingResult.type === 'bindings'
      ? existingResult.bindings
      : [];
    const policies = existing
      .filter((row) => row['predicate'] === DKG_ONTOLOGY.DKG_ACCESS_POLICY)
      .map((row) => row['object']);
    const hasConflictingPolicy = policies.some((value) => (
      !value?.startsWith('"') || stripLiteral(value).trim().toLowerCase() !== 'public'
    ));
    if (hasConflictingPolicy) {
      conflictingGraphs.push(contextGraphId);
      continue;
    }

    const hasType = existing.some((row) => (
      row['predicate'] === DKG_ONTOLOGY.RDF_TYPE &&
      row['object'] === DKG_ONTOLOGY.DKG_CONTEXT_GRAPH
    ));
    const hasPublicPolicy = policies.some((value) => (
      value?.startsWith('"') && stripLiteral(value).trim().toLowerCase() === 'public'
    ));
    const missing = buildAuthoritativePublicMetaQuads(contextGraphId).filter((quad) => (
      quad.predicate === DKG_ONTOLOGY.RDF_TYPE ? !hasType : !hasPublicPolicy
    ));
    if (missing.length === 0) continue;
    inserts.push(...missing);
    repairedGraphs += 1;
  }

  if (inserts.length > 0) {
    await store.insert(inserts, { source: 'agent.publicMetaRepair' });
    await store.flush?.();
  }

  return {
    candidates: candidateSubjects.length,
    repairedGraphs,
    insertedTriples: inserts.length,
    conflictingGraphs,
  };
}
