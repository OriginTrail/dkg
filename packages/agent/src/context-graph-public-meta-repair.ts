// SPDX-License-Identifier: Apache-2.0

import {
  DKG_ONTOLOGY,
  SYSTEM_CONTEXT_GRAPHS,
  assertSafeIri,
  contextGraphDataGraphUri,
  contextGraphMetaGraphUri,
} from '@origintrail-official/dkg-core';
import {
  tryUpdateWithTouchedGraphs,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import {
  buildAuthoritativePublicMetaRepairUpdate,
  inspectAuthoritativePublicMetaDefinition,
} from './context-graph-public-meta-proof.js';

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';

export interface PublicMetaRepairResult {
  candidates: number;
  repairedGraphs: number;
  insertedTriples: number;
  conflictingGraphs: string[];
}

type ActivePublicContextGraphChainProof =
  | { state: 'public' }
  | { state: 'not-public'; reason: 'private' | 'unregistered' }
  | { state: 'unknown'; reason: 'unprovable' | 'rpc-failure'; detail?: string };

type ChainAttestedPublicMetaRepairResult =
  | { outcome: 'already-complete'; chainProof: { state: 'not-requested' } }
  | {
      outcome: 'not-chain-attested';
      chainProof: Exclude<ActivePublicContextGraphChainProof, { state: 'public' }>;
    }
  | { outcome: 'conflicting-policy'; chainProof: { state: 'public' } }
  | { outcome: 'projection-complete'; chainProof: { state: 'public' } };

async function inspectPublicMetaProjection(
  store: TripleStore,
  contextGraphId: string,
): Promise<{ missing: Quad[]; conflictingPolicy: boolean }> {
  const subject = assertSafeIri(contextGraphDataGraphUri(contextGraphId));
  const metaGraph = assertSafeIri(contextGraphMetaGraphUri(contextGraphId));
  const existingResult = await store.query(`
    SELECT ?predicate ?object WHERE {
      GRAPH <${metaGraph}> {
        <${subject}> ?predicate ?object .
      }
    }
  `);
  const existing: Quad[] = existingResult.type === 'bindings'
    ? existingResult.bindings.flatMap((row) => (
        row['predicate'] && row['object']
          ? [{ subject, predicate: row['predicate'], object: row['object'], graph: metaGraph }]
          : []
      ))
    : [];
  return inspectAuthoritativePublicMetaDefinition(contextGraphId, existing);
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
    const inspection = await inspectPublicMetaProjection(store, contextGraphId);
    if (inspection.conflictingPolicy) {
      conflictingGraphs.push(contextGraphId);
      continue;
    }
    if (inspection.missing.length === 0) continue;
    inserts.push(...inspection.missing);
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

/**
 * Backfill one public root `_meta` projection only after a caller-supplied
 * resolver proves that the exact local id is bound to a live, public slot on
 * the current chain. The resolver must include identity/name-hash binding;
 * liveness plus `accessPolicy=public` alone is insufficient because a stale
 * numeric id can be reused after a devnet reset.
 *
 * Existing non-public root policy is a hard conflict and is never overwritten.
 */
export async function repairChainAttestedPublicMetaProjection(
  store: TripleStore,
  contextGraphId: string,
  resolveActivePublicBinding: () => Promise<ActivePublicContextGraphChainProof>,
): Promise<ChainAttestedPublicMetaRepairResult> {
  // Canonical metadata needs no repair and therefore no chain RPC. This keeps
  // normal restarts cheap once a legacy graph has been healed.
  const inspection = await inspectPublicMetaProjection(store, contextGraphId);
  if (!inspection.conflictingPolicy && inspection.missing.length === 0) {
    return { outcome: 'already-complete', chainProof: { state: 'not-requested' } };
  }

  const chainProof = await resolveActivePublicBinding();
  if (chainProof.state !== 'public') {
    return { outcome: 'not-chain-attested', chainProof };
  }

  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  const updated = await tryUpdateWithTouchedGraphs(
    store,
    buildAuthoritativePublicMetaRepairUpdate(contextGraphId),
    [metaGraph],
    { source: 'agent.chainAttestedPublicMetaRepair' },
  );
  if (!updated) {
    throw new Error('Triple store does not support atomic public metadata repair');
  }
  await store.flush?.();
  const finalInspection = await inspectPublicMetaProjection(store, contextGraphId);
  if (finalInspection.conflictingPolicy) {
    return { outcome: 'conflicting-policy', chainProof };
  }
  if (finalInspection.missing.length > 0) {
    throw new Error('Atomic public metadata repair completed without the canonical proof');
  }
  return { outcome: 'projection-complete', chainProof };
}
