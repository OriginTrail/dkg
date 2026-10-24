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
import type { ActivePublicContextGraphChainProof } from
  './active-public-context-graph-chain-proof.js';

const CONTEXT_GRAPH_URI_PREFIX = 'did:dkg:context-graph:';
const DURABILITY_PENDING_PUBLIC_META = new WeakMap<TripleStore, Set<string>>();

function markPublicMetaDurabilityPending(store: TripleStore, contextGraphId: string): void {
  const pending = DURABILITY_PENDING_PUBLIC_META.get(store) ?? new Set<string>();
  pending.add(contextGraphId);
  DURABILITY_PENDING_PUBLIC_META.set(store, pending);
}

function clearPublicMetaDurabilityPending(store: TripleStore, contextGraphId: string): void {
  const pending = DURABILITY_PENDING_PUBLIC_META.get(store);
  if (!pending) return;
  pending.delete(contextGraphId);
  if (pending.size === 0) DURABILITY_PENDING_PUBLIC_META.delete(store);
}

export function isPublicMetaDurabilityPending(
  store: TripleStore,
  contextGraphId: string,
): boolean {
  return DURABILITY_PENDING_PUBLIC_META.get(store)?.has(contextGraphId) === true;
}

export interface PublicMetaRepairResult {
  candidates: number;
  repairedGraphs: number;
  insertedTriples: number;
  conflictingGraphs: string[];
}

export type ChainAttestedPublicMetaRepairResult =
  | { outcome: 'already-complete' }
  | {
      outcome: 'not-chain-attested';
      chainProof: Exclude<ActivePublicContextGraphChainProof, { state: 'public' }>;
    }
  | { outcome: 'conflicting-policy' }
  | { outcome: 'projection-complete' }
  | {
      outcome: 'repair-failed';
      failureStage: 'pre-mutation' | 'mutation-or-durability';
      detail: string;
    };

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
  // A prior UPDATE may be visible in memory even though its durability flush
  // failed. Retry durability before any inspection so those facts cannot take
  // the already-complete shortcut. Confirmation consults the same quarantine.
  const resumedPendingDurability = isPublicMetaDurabilityPending(store, contextGraphId);
  if (resumedPendingDurability) {
    try {
      await store.flush?.();
    } catch (error) {
      return {
        outcome: 'repair-failed',
        failureStage: 'mutation-or-durability',
        detail: errorDetail(error),
      };
    }
  }

  // Canonical metadata needs no repair and therefore no chain RPC. This keeps
  // normal restarts cheap once a legacy graph has been healed.
  let inspection: Awaited<ReturnType<typeof inspectPublicMetaProjection>>;
  try {
    inspection = await inspectPublicMetaProjection(store, contextGraphId);
  } catch (error) {
    return {
      outcome: 'repair-failed',
      failureStage: resumedPendingDurability
        ? 'mutation-or-durability'
        : 'pre-mutation',
      detail: errorDetail(error),
    };
  }
  if (!inspection.conflictingPolicy && inspection.missing.length === 0) {
    if (resumedPendingDurability) {
      clearPublicMetaDurabilityPending(store, contextGraphId);
    }
    return { outcome: 'already-complete' };
  }
  if (resumedPendingDurability) {
    clearPublicMetaDurabilityPending(store, contextGraphId);
  }

  let chainProof: ActivePublicContextGraphChainProof;
  try {
    chainProof = await resolveActivePublicBinding();
  } catch (error) {
    return {
      outcome: 'repair-failed',
      failureStage: 'pre-mutation',
      detail: errorDetail(error),
    };
  }
  if (chainProof.state !== 'public') {
    return { outcome: 'not-chain-attested', chainProof };
  }
  if (inspection.conflictingPolicy) {
    return { outcome: 'conflicting-policy' };
  }

  const metaGraph = contextGraphMetaGraphUri(contextGraphId);
  let updated: boolean;
  markPublicMetaDurabilityPending(store, contextGraphId);
  try {
    updated = await tryUpdateWithTouchedGraphs(
      store,
      buildAuthoritativePublicMetaRepairUpdate(contextGraphId),
      [metaGraph],
      { source: 'agent.chainAttestedPublicMetaRepair' },
    );
  } catch (error) {
    return {
      outcome: 'repair-failed',
      failureStage: 'mutation-or-durability',
      detail: errorDetail(error),
    };
  }
  if (!updated) {
    clearPublicMetaDurabilityPending(store, contextGraphId);
    return {
      outcome: 'repair-failed',
      failureStage: 'pre-mutation',
      detail: 'Triple store does not support atomic public metadata repair',
    };
  }
  try {
    await store.flush?.();
    const finalInspection = await inspectPublicMetaProjection(store, contextGraphId);
    if (finalInspection.conflictingPolicy) {
      clearPublicMetaDurabilityPending(store, contextGraphId);
      return { outcome: 'conflicting-policy' };
    }
    if (finalInspection.missing.length > 0) {
      return {
        outcome: 'repair-failed',
        failureStage: 'mutation-or-durability',
        detail: 'Atomic public metadata repair completed without the canonical proof',
      };
    }
    clearPublicMetaDurabilityPending(store, contextGraphId);
  } catch (error) {
    return {
      outcome: 'repair-failed',
      failureStage: 'mutation-or-durability',
      detail: errorDetail(error),
    };
  }
  return { outcome: 'projection-complete' };
}
