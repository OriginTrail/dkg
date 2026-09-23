// SPDX-License-Identifier: Apache-2.0

/**
 * Pure pieces of the core ACK promotion audit: its status record, the store
 * queries it runs, and Knowledge Asset id decoding. The agent-side pass lives
 * in `dkg-agent-vm-promotion.ts`.
 */

import { createGraphKnowledgeAssetScope, isSafeIri } from '@origintrail-official/dkg-core';
import {
  STORAGE_ACK_SHARE_OPERATION_ID_PREFIX,
  STORAGE_ACK_UNREGISTERED_AT_PREDICATE,
} from './storage-ack-retention.js';

const DKG = 'http://dkg.io/ontology/';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';
const SHARED_MEMORY_META_SUFFIX = '/_shared_memory_meta';

/** What the last ACK promotion audit found; served on `/api/status`. */
export interface VmPromotionAuditStatus {
  /** Epoch ms when the last pass finished, or null before the first one. */
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  /** Context graphs holding StorageACK copies at the last pass. */
  graphsWithAckCopies: number;
  /** Graphs the backfill recorded as core-hosted since start. */
  backfilledGraphs: number;
  /** Graphs whose on-chain id or policy the last pass could not resolve. */
  unresolvedGraphs: number;
  /** Unpromoted StorageACK copies older than the stall threshold (bounded sample). */
  staleUnpromotedCopies: number;
  /** Sampled copies registered on chain to their graph yet not in VM (last pass). */
  stalledOnChain: number;
  /** Sampled copies whose KA is not registered to their graph (last pass). */
  notRegisteredOnChain: number;
  /** Copies stamped chain-absent, so the TTL cleanup may expire them, since start. */
  expiredUnregisteredCopies: number;
  /** VM reconcile passes re-triggered for graphs with stalled copies, since start. */
  retriesTriggered: number;
}

export function createVmPromotionAuditStatus(): VmPromotionAuditStatus {
  return {
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    graphsWithAckCopies: 0,
    backfilledGraphs: 0,
    unresolvedGraphs: 0,
    staleUnpromotedCopies: 0,
    stalledOnChain: 0,
    notRegisteredOnChain: 0,
    expiredUnregisteredCopies: 0,
    retriesTriggered: 0,
  };
}

/** One SWM meta graph that holds StorageACK copies of one Context Graph. */
export interface StorageAckCopyLocation {
  readonly contextGraphId: string;
  readonly metaGraph: string;
}

/**
 * Every (Context Graph, SWM meta graph) pair holding a StorageACK copy, in one
 * row SELECT. DISTINCT only: no COUNT/GROUP BY, which Blazegraph mis-evaluates
 * over multi-graph patterns.
 */
export function storageAckCopyLocationsQuery(limit: number): string {
  return `SELECT DISTINCT ?cg ?meta WHERE {
    GRAPH ?meta {
      ?op <${DKG}shareOperationId> ?opId ;
        <${DKG}contextGraphId> ?cg .
      FILTER(STRSTARTS(STR(?opId), "${STORAGE_ACK_SHARE_OPERATION_ID_PREFIX}"))
    }
  } LIMIT ${limit}`;
}

/**
 * Validate one discovery row: the literal must name a Context Graph whose own
 * SWM meta graph (root or sub-graph) is where the copy lives.
 */
export function parseStorageAckCopyLocation(
  contextGraphLiteral: string | undefined,
  metaGraph: string | undefined,
): StorageAckCopyLocation | null {
  if (!contextGraphLiteral || !metaGraph) return null;
  const contextGraphId = stripLiteral(contextGraphLiteral);
  if (!contextGraphId || !isSafeIri(`${CONTEXT_GRAPH_PREFIX}${contextGraphId}`)) return null;
  if (!isSafeIri(metaGraph)) return null;
  if (!metaGraph.startsWith(`${CONTEXT_GRAPH_PREFIX}${contextGraphId}/`)) return null;
  if (!metaGraph.endsWith(SHARED_MEMORY_META_SUFFIX)) return null;
  return { contextGraphId, metaGraph };
}

/**
 * Unpromoted StorageACK copies in one meta graph published before
 * `beforeIso`, not yet stamped chain-absent. `newestFirst` samples recent
 * stalls; oldest-first reaches the copies the TTL would otherwise retain.
 */
export function unpromotedStorageAckCopiesQuery(input: Readonly<{
  metaGraph: string;
  rootMetaGraph: string;
  beforeIso: string;
  newestFirst: boolean;
  limit: number;
}>): string {
  const order = input.newestFirst ? 'DESC(?ts)' : 'ASC(?ts)';
  return `SELECT ?op ?ka ?ts WHERE {
    GRAPH <${input.metaGraph}> {
      ?op <${DKG}shareOperationId> ?opId ;
        <${DKG}kaUal> ?ka ;
        <${DKG}publishedAt> ?ts .
      FILTER(STRSTARTS(STR(?opId), "${STORAGE_ACK_SHARE_OPERATION_ID_PREFIX}"))
      FILTER(?ts < "${input.beforeIso}"^^<${XSD_DATE_TIME}>)
      FILTER NOT EXISTS { ?op <${STORAGE_ACK_UNREGISTERED_AT_PREDICATE}> ?unregisteredAt }
    }
    FILTER NOT EXISTS { GRAPH <${input.rootMetaGraph}> { ?ka <${DKG}status> "confirmed" } }
  } ORDER BY ${order} LIMIT ${input.limit}`;
}

/** The packed V10 Knowledge Asset id a graph-scoped UAL names, or null. */
export function knowledgeAssetIdFromUal(ual: string): bigint | null {
  try {
    const scope = createGraphKnowledgeAssetScope(ual, 1);
    return (BigInt(scope.agentAddress) << 96n) | BigInt(scope.kaNumber);
  } catch {
    return null;
  }
}

/** A canonical positive decimal on-chain Context Graph id. */
export function isCanonicalOnChainContextGraphId(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function stripLiteral(value: string): string {
  const match = /^"([\s\S]*)"(?:\^\^<[^>]+>|@[A-Za-z-]+)?$/.exec(value);
  return (match ? match[1] : value).trim();
}
