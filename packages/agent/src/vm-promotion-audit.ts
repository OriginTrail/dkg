// SPDX-License-Identifier: Apache-2.0

/**
 * Pure pieces of the core ACK promotion audit: its status record, the store
 * queries it runs against the node-local signed-ACK ledger, and Knowledge
 * Asset id decoding. The agent-side pass lives in `dkg-agent-vm-promotion.ts`.
 *
 * Every query is a plain row SELECT (DISTINCT / ORDER BY / LIMIT, keyset
 * paged): no COUNT or GROUP BY, which Blazegraph mis-evaluates over
 * multi-graph patterns.
 */

import {
  contextGraphMetaUri,
  createGraphKnowledgeAssetScope,
  isSafeIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import {
  STORAGE_ACK_LEDGER_GRAPH,
  STORAGE_ACK_LEDGER_PREDICATES as LEDGER,
} from '@origintrail-official/dkg-publisher';

const DKG = 'http://dkg.io/ontology/';
const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const CONTEXT_GRAPH_PREFIX = 'did:dkg:context-graph:';

/** What the ACK promotion audit found; served on `/api/status`. */
export interface VmPromotionAuditStatus {
  /** Epoch ms when the last pass finished, or null before the first one. */
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  /** The signed-ACK ledger exists and pre-ledger copies are grandfathered. */
  ledgerReady: boolean;
  /** Namespaces with ledgered ACK copies in the last discovery page. */
  namespacesWithAckCopies: number;
  /** True when the last page reached the end of the ledger's namespaces. */
  discoveryWrapped: boolean;
  /** Graphs the backfill recorded as core-hosted since start. */
  backfilledGraphs: number;
  /** Namespaces in the last page still waiting for a core-hosted row. */
  backfillPending: number;
  /** Of those, how many are backing off after an unresolved attempt. */
  unresolvedGraphs: number;
  /** Ledgered copies the last pass examined. */
  auditedCopies: number;
  /** Examined copies past the stall threshold and not in VM at their version. */
  staleUnpromotedCopies: number;
  /** Of those, how many the chain has registered (or updated) as ACKed. */
  stalledOnChain: number;
  /** Of those, how many the chain does not have (yet). */
  notRegisteredOnChain: number;
  /** Copies stamped chain-absent (twice, past the TTL) since start. */
  expiredUnregisteredCopies: number;
  /** Per-asset VM reconciles the audit ran for landed copies since start. */
  retriesTriggered: number;
  /** Of those, how many promoted (or found already) the asset. */
  promotedByAudit: number;
}

export function createVmPromotionAuditStatus(): VmPromotionAuditStatus {
  return {
    lastRunAt: null,
    lastDurationMs: null,
    lastError: null,
    ledgerReady: false,
    namespacesWithAckCopies: 0,
    discoveryWrapped: false,
    backfilledGraphs: 0,
    backfillPending: 0,
    unresolvedGraphs: 0,
    auditedCopies: 0,
    staleUnpromotedCopies: 0,
    stalledOnChain: 0,
    notRegisteredOnChain: 0,
    expiredUnregisteredCopies: 0,
    retriesTriggered: 0,
    promotedByAudit: 0,
  };
}

/** One ledgered ACK copy the audit may examine. */
export interface StorageAckLedgerCandidate {
  readonly operationSubject: string;
  readonly namespace: string;
  readonly kaUal: string;
  readonly assertionVersion: bigint;
  readonly signedAtMs: number;
  /** Numeric on-chain id the ACK was signed for; absent on grandfathered copies. */
  readonly contextGraphId?: string;
  readonly registered: boolean;
  readonly absentSeenAtMs?: number;
}

export function storageAckLedgerEpochQuery(): string {
  return `SELECT ?epoch WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    <${STORAGE_ACK_LEDGER_GRAPH}> <${LEDGER.epoch}> ?epoch
  } } LIMIT 1`;
}

/** Keyset page of ledger namespaces after `after` (exclusive). */
export function storageAckLedgerNamespacesQuery(after: string, limit: number): string {
  return `SELECT DISTINCT ?namespace WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    ?op <${LEDGER.namespace}> ?namespace .
    FILTER(STR(?namespace) > ${sparqlString(after)})
  } } ORDER BY ?namespace LIMIT ${limit}`;
}

/** On-chain ids this core signed ACKs for in one namespace. */
export function storageAckNamespaceTargetsQuery(namespace: string, limit: number): string {
  return `SELECT DISTINCT ?target WHERE { GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
    ?op <${LEDGER.namespace}> ${sparqlString(namespace)} ;
      <${LEDGER.contextGraphId}> ?target .
  } } ORDER BY ?target LIMIT ${limit}`;
}

/**
 * Keyset page (by operation IRI, after `after`) of ledgered copies signed
 * before `signedBeforeIso` and not yet stamped chain-absent. The keyset
 * rotates the audit through every copy regardless of age.
 */
export function storageAckAuditCandidatesQuery(input: Readonly<{
  after: string;
  signedBeforeIso: string;
  limit: number;
}>): string {
  return `SELECT ?op ?namespace ?ka ?version ?signedAt ?target ?registered ?absentSeen WHERE {
    GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> {
      ?op <${LEDGER.signedAt}> ?signedAt ;
        <${LEDGER.namespace}> ?namespace ;
        <${LEDGER.kaUal}> ?ka ;
        <${LEDGER.assertionVersion}> ?version .
      OPTIONAL { ?op <${LEDGER.contextGraphId}> ?target }
      OPTIONAL { ?op <${LEDGER.registeredAt}> ?registered }
      OPTIONAL { ?op <${LEDGER.absentSeenAt}> ?absentSeen }
      FILTER NOT EXISTS { ?op <${LEDGER.unregisteredAt}> ?unregistered }
      FILTER(?signedAt < "${input.signedBeforeIso}"^^<${XSD_DATE_TIME}>)
      FILTER(STR(?op) > ${sparqlString(input.after)})
    }
  } ORDER BY ?op LIMIT ${input.limit}`;
}

/** Whether the namespace's VM holds the asset at `version` or later. */
export function storageAckPromotedQuery(namespace: string, kaUal: string, version: bigint): string {
  return `ASK { GRAPH <${contextGraphMetaUri(namespace)}> {
    <${kaUal}> <${DKG}status> "confirmed" ;
      <${DKG}assertionVersion> ?confirmedVersion .
    FILTER(?confirmedVersion >= ${version})
  } }`;
}

/** Ledger rows whose ACK copy no longer exists (retired or expired). */
export function storageAckLedgerOrphansQuery(limit: number): string {
  return `SELECT ?op WHERE {
    GRAPH <${STORAGE_ACK_LEDGER_GRAPH}> { ?op <${LEDGER.metaGraph}> ?meta }
    FILTER NOT EXISTS { GRAPH ?meta { ?op <${DKG}shareOperationId> ?operationId } }
  } LIMIT ${limit}`;
}

export function parseStorageAckLedgerCandidate(
  row: Readonly<Record<string, string | undefined>>,
): StorageAckLedgerCandidate | null {
  const operationSubject = row['op'];
  const namespace = row['namespace'] === undefined ? undefined : stripLiteral(row['namespace']);
  const kaUal = row['ka'];
  const versionLiteral = row['version'] === undefined ? undefined : stripLiteral(row['version']);
  const signedAtMs = row['signedAt'] === undefined ? NaN : Date.parse(stripLiteral(row['signedAt']));
  if (!operationSubject || !namespace || !kaUal || !versionLiteral || !Number.isFinite(signedAtMs)) {
    return null;
  }
  if (!isStorageAckNamespace(namespace) || !isSafeIri(kaUal)) return null;
  let assertionVersion: bigint;
  try {
    assertionVersion = BigInt(versionLiteral);
  } catch {
    return null;
  }
  if (assertionVersion <= 0n) return null;
  const target = row['target'] === undefined ? undefined : stripLiteral(row['target']);
  const absentSeenAtMs = row['absentSeen'] === undefined
    ? undefined
    : Date.parse(stripLiteral(row['absentSeen']));
  return {
    operationSubject,
    namespace,
    kaUal,
    assertionVersion,
    signedAtMs,
    ...(target && isCanonicalOnChainContextGraphId(target) ? { contextGraphId: target } : {}),
    registered: row['registered'] !== undefined,
    ...(absentSeenAtMs !== undefined && Number.isFinite(absentSeenAtMs) ? { absentSeenAtMs } : {}),
  };
}

/** A namespace string that names a safe Context Graph IRI family. */
export function isStorageAckNamespace(namespace: string): boolean {
  return namespace.length > 0 && isSafeIri(`${CONTEXT_GRAPH_PREFIX}${namespace}`);
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

export function stripLiteral(value: string): string {
  const match = /^"([\s\S]*)"(?:\^\^<[^>]+>|@[A-Za-z-]+)?$/.exec(value);
  return (match ? match[1] : value).trim();
}
