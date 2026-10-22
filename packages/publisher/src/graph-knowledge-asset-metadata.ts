import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  createGraphKnowledgeAssetScope,
  toAgentDid,
  knowledgeAssetLayerGraphUri,
  MemoryLayer,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

import type {
  KCMetadata,
  MaterializedVersion,
  OnChainProvenance,
} from './metadata.js';

const AUTHENTICATED_SUB_GRAPH = 'http://dkg.io/ontology/authenticatedSubGraphName';
const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

export const GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE = `${DKG}confirmationKind`;
const GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE = `${DKG}status`;
const GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE = `${DKG}transactionHash`;
const MATERIALIZED_VERSION_PREDICATE = `${DKG}materializedVersion`;
const GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE = `${DKG}publishedAt`;

export type GraphKnowledgeAssetConfirmationKind =
  | 'transaction'
  | 'finalized-materialization';

export type GraphKnowledgeAssetConfirmation =
  | Readonly<{
      kind: Extract<GraphKnowledgeAssetConfirmationKind, 'transaction'>;
      provenance: OnChainProvenance;
    }>
  | Readonly<{
      kind: Extract<GraphKnowledgeAssetConfirmationKind, 'finalized-materialization'>;
      provenance: Readonly<{
        batchId: bigint;
        materializedVersion: MaterializedVersion;
      }>;
    }>;

export type GraphKnowledgeAssetMetadataState =
  | Readonly<{ readonly status: 'tentative' }>
  | Readonly<{
      readonly status: 'confirmed';
      readonly confirmation: GraphKnowledgeAssetConfirmation;
    }>;

export interface GraphKnowledgeAssetMetadata extends KCMetadata {
  assertionVersion: string | number | bigint;
  publicTripleCount: number;
  privateTripleCount?: number;
  privateMerkleRoot?: Uint8Array;
  assertionGraph: string;
}

export interface GraphKnowledgeAssetReceiptProvenanceV1 {
  readonly transactionHash: string;
  readonly materializedVersion?: MaterializedVersion;
}

/**
 * Parse the graph-scoped confirmation discriminator shared by metadata writers
 * and durable-sync readers. Missing metadata is the rolling-compatible legacy
 * receipt-backed shape; every explicit value must name exactly one supported
 * confirmation lane.
 */
export function normalizeGraphKnowledgeAssetConfirmationKindV1(
  raw: string | undefined,
): GraphKnowledgeAssetConfirmationKind {
  if (raw === undefined || raw === 'transaction') return 'transaction';
  if (raw === 'finalized-materialization') return raw;
  throw new Error(`Unsupported graph knowledge asset confirmation kind: ${raw}`);
}

/** Read and validate the confirmation state from one KA's structural metadata. */
export function readGraphKnowledgeAssetConfirmationKindV1(
  metadataQuads: readonly Pick<Quad, 'predicate' | 'object'>[],
): GraphKnowledgeAssetConfirmationKind {
  const values = metadataQuads
    .filter((quad) => quad.predicate === GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE)
    .map((quad) => rdfLiteralLexicalValue(quad.object));
  if (values.some(value => value === undefined)) {
    throw new Error('Graph knowledge asset confirmation kind must be an RDF literal');
  }
  const kinds = values.map(normalizeGraphKnowledgeAssetConfirmationKindV1);
  // Legacy union metadata may carry both compatible confirmations. Transaction
  // provenance is stronger: choosing it retains its receipt validation rather
  // than silently falling back to the receiptless materialization lane.
  return kinds.includes('transaction') || kinds.length === 0
    ? 'transaction' : 'finalized-materialization';
}

/**
 * Read the locally authenticated, receipt-backed part of graph-scoped KA
 * metadata. This is the canonical parser used when a receiptless finalized
 * replay must preserve stronger local transaction provenance.
 *
 * Invalid, tentative, or finalized-materialization metadata is not eligible
 * for preservation and returns null. A missing confirmationKind is accepted as
 * the rolling-compatible legacy transaction shape.
 */
export function readGraphKnowledgeAssetReceiptProvenanceV1(
  metadataQuads: readonly Pick<Quad, 'predicate' | 'object'>[],
): GraphKnowledgeAssetReceiptProvenanceV1 | null {
  const statuses = metadataQuads
    .filter((quad) => quad.predicate === GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE)
    .map((quad) => rdfLiteralLexicalValue(quad.object));
  if (statuses.length !== 1 || statuses[0] !== 'confirmed') return null;

  let confirmationKind: GraphKnowledgeAssetConfirmationKind;
  try {
    confirmationKind = readGraphKnowledgeAssetConfirmationKindV1(metadataQuads);
  } catch {
    return null;
  }
  if (confirmationKind !== 'transaction') return null;

  const hashes = metadataQuads
    .filter((quad) => quad.predicate === GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE)
    .map((quad) => rdfLiteralLexicalValue(quad.object));
  if (
    hashes.length !== 1
    || hashes[0] === undefined
    || !/^0x[0-9a-fA-F]{64}$/.test(hashes[0])
  ) {
    return null;
  }

  const versions = metadataQuads
    .filter((quad) => quad.predicate === MATERIALIZED_VERSION_PREDICATE)
    .map((quad) => rdfLiteralLexicalValue(quad.object));
  if (versions.length > 1 || (versions.length === 1 && versions[0] === undefined)) {
    return null;
  }
  const materializedVersion = versions.length === 0
    ? undefined
    : parseCanonicalMaterializedVersionV1(versions[0]!);
  if (versions.length === 1 && materializedVersion === null) return null;
  const validMaterializedVersion = materializedVersion ?? undefined;

  return Object.freeze({
    transactionHash: hashes[0],
    ...(validMaterializedVersion === undefined
      ? {}
      : { materializedVersion: Object.freeze(validMaterializedVersion) }),
  });
}

/**
 * Preserve valid local receipt provenance while accepting an otherwise exact
 * same-version metadata replacement from the receiptless finalized lane.
 */
export function preserveGraphKnowledgeAssetReceiptProvenanceV1(
  incomingMetadata: readonly Quad[],
  currentMetadata: readonly Pick<Quad, 'predicate' | 'object'>[],
): Quad[] {
  const provenance = readGraphKnowledgeAssetReceiptProvenanceV1(currentMetadata);
  if (provenance === null) return [...incomingMetadata];
  const identity = incomingMetadata[0];
  if (identity === undefined) return [...incomingMetadata];
  return [
    ...incomingMetadata.filter((quad) => (
      quad.predicate !== GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE
      && quad.predicate !== MATERIALIZED_VERSION_PREDICATE
      && quad.predicate !== GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE
    )),
    mq(
      identity.subject,
      GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE,
      lit(provenance.transactionHash),
      identity.graph,
    ),
    mq(
      identity.subject,
      GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE,
      lit('transaction'),
      identity.graph,
    ),
    ...(provenance.materializedVersion === undefined
      ? []
      : [materializedVersionQuad(
          identity.graph,
          identity.subject,
          provenance.materializedVersion,
        )]),
  ];
}

const RECOVERY_CANONICAL_PREDICATES = new Set(['contentScopeVersion', 'assertionVersion', 'publicTripleCount', 'privateTripleCount',
  'privateMerkleRoot', 'assertionGraph', 'subGraphName', 'merkleRoot', 'batchId', 'kaUal', 'status',
  'transactionHash', 'materializedVersion', 'confirmationKind'].map(name => `${DKG}${name}`));

/** One retention owner; callers separately establish the assertion anchor and trusted controls. */
export function reconcileSameAssertionGraphKnowledgeAssetMetadataV1(input: {
  readonly lane: 'lifecycle-recovery' | 'verified-projection';
  readonly incomingMetadata: readonly Quad[];
  readonly currentMetadata: readonly Quad[];
}): Quad[] {
  const { lane, incomingMetadata, currentMetadata } = input, identity = incomingMetadata[0];
  let canonical = [...incomingMetadata];
  if (lane === 'verified-projection') {
    const times = currentMetadata.filter(quad => quad.predicate === GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE);
    const lexical = times.length === 1 ? rdfLiteralLexicalValue(times[0]!.object) : undefined;
    if (identity !== undefined && times.length === 1 && times[0]!.subject === identity.subject
      && times[0]!.graph === identity.graph && lexical !== undefined && Number.isFinite(Date.parse(lexical))) {
      canonical = [...canonical.filter(quad => quad.predicate !== GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE), times[0]!];
    }
  }
  if (lane === 'lifecycle-recovery' || readGraphKnowledgeAssetConfirmationKindV1(incomingMetadata) === 'finalized-materialization') {
    canonical = preserveGraphKnowledgeAssetReceiptProvenanceV1(canonical, currentMetadata);
  }
  const incomingPredicates = new Set(canonical.map(quad => quad.predicate));
  const currentPredicates = new Set(currentMetadata.map(quad => quad.predicate));
  const retainedPredicates = new Set([...currentPredicates].filter(predicate => lane === 'lifecycle-recovery'
    // Recovery overlays trusted controls separately and keeps existing non-immutable fields.
    ? !RECOVERY_CANONICAL_PREDICATES.has(predicate)
    // Verified projection owns protocol fields and any annotation it explicitly supplies.
    : !predicate.startsWith(DKG) && !predicate.startsWith(PROV) && !incomingPredicates.has(predicate)));
  const retained = currentMetadata.filter(quad => retainedPredicates.has(quad.predicate)
    && (lane === 'lifecycle-recovery' || (identity !== undefined && quad.subject === identity.subject && quad.graph === identity.graph)));
  const incoming = canonical.filter(quad => !retainedPredicates.has(quad.predicate));
  return lane === 'lifecycle-recovery' ? [...retained, ...incoming] : [...incoming, ...retained];
}

/** Exact-assertion replay keeps incoming protocol controls plus local receive time, receipt and omitted annotations. */
export function mergeSameVersionGraphKnowledgeAssetMetadataV1(
  incomingMetadata: readonly Quad[], currentMetadata: readonly Quad[],
): Quad[] {
  return reconcileSameAssertionGraphKnowledgeAssetMetadataV1({ lane: 'verified-projection', incomingMetadata, currentMetadata });
}

/** Replace peer confirmation claims with facts established by this receiver. */
export function overlayLocallyAuthenticatedGraphKnowledgeAssetMetadataV1(
  metadata: readonly Quad[],
  scope: { ual: string; metaGraph: string; receivedAt: Date; subGraphName?: string },
  state: { status: 'tentative' } | {
    status: 'confirmed';
    materializedVersion: MaterializedVersion;
    confirmation: { kind: 'finalized-materialization' } | { kind: 'transaction'; transactionHash: string };
  },
): Quad[] {
  const controls = new Set([
    GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE, GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE,
    GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE, GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE,
    MATERIALIZED_VERSION_PREDICATE, AUTHENTICATED_SUB_GRAPH,
  ]);
  const result = metadata.filter(q => !controls.has(q.predicate));
  result.push(
    mq(scope.ual, GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE,
      `${lit(scope.receivedAt.toISOString())}^^<${XSD}dateTime>`, scope.metaGraph),
  );
  if (state.status === 'confirmed') {
    appendAuthenticatedSubGraphRoute(result, scope.ual, scope.metaGraph, scope.subGraphName);
    appendConfirmationControls(result, scope.ual, scope.metaGraph, state.confirmation);
    result.push(materializedVersionQuad(scope.metaGraph, scope.ual, state.materializedVersion));
  } else result.push(mq(scope.ual, GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE, lit('tentative'), scope.metaGraph));
  return result;
}

/**
 * Constant-size VM metadata for one graph-scoped KA. RDF subjects in the KA
 * payload never become membership, token, ownership, or trust rows here.
 */
export function generateGraphKnowledgeAssetMetadata(
  meta: GraphKnowledgeAssetMetadata,
  state: GraphKnowledgeAssetMetadataState,
): Quad[] {
  const { scope, metaGraph, quads } = generateGraphKnowledgeAssetMetadataBase(meta);
  if (state.status === 'confirmed') {
    const { confirmation } = state;
    const { batchId } = confirmation.provenance;
    if (confirmation.kind === 'finalized-materialization' && batchId < 0n) {
      throw new Error('Finalized graph metadata batchId must be non-negative');
    }
    appendConfirmationControls(quads, scope.ual, metaGraph, confirmation.kind === 'transaction'
      ? { kind: 'transaction', transactionHash: confirmation.provenance.txHash } : confirmation);
    quads.push(mq(scope.ual, `${DKG}batchId`, intLit(batchId), metaGraph));
    if (confirmation.kind === 'finalized-materialization') {
      quads.push(materializedVersionQuad(metaGraph, scope.ual, confirmation.provenance.materializedVersion));
    }
  } else {
    quads.push(mq(scope.ual, GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE, lit('tentative'), metaGraph));
  }
  if (state.status === 'confirmed') appendAuthenticatedSubGraphRoute(quads, scope.ual, metaGraph, meta.subGraphName);
  return quads;
}

/** Serialize confirmation controls identically for local generation and authenticated recovery. */
function appendConfirmationControls(
  quads: Quad[], ual: string, metaGraph: string,
  confirmation: { kind: 'finalized-materialization' } | { kind: 'transaction'; transactionHash: string },
): void {
  quads.push(
    mq(ual, GRAPH_KNOWLEDGE_ASSET_STATUS_PREDICATE, lit('confirmed'), metaGraph),
    mq(ual, GRAPH_KNOWLEDGE_ASSET_CONFIRMATION_KIND_PREDICATE, lit(confirmation.kind), metaGraph),
  );
  if (confirmation.kind === 'transaction') {
    quads.push(mq(ual, GRAPH_KNOWLEDGE_ASSET_TRANSACTION_HASH_PREDICATE, lit(confirmation.transactionHash), metaGraph));
  }
}

/** Locally authenticated routing is independent of receipt or snapshot provenance. */
function appendAuthenticatedSubGraphRoute(quads: Quad[], ual: string, metaGraph: string, subGraphName?: string): void {
  // The caller carries the scope established by verification or typed local generation.
  if (subGraphName !== undefined) quads.push(mq(ual, AUTHENTICATED_SUB_GRAPH, lit(subGraphName), metaGraph));
}

function generateGraphKnowledgeAssetMetadataBase(
  meta: GraphKnowledgeAssetMetadata,
): Readonly<{
  scope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  metaGraph: string;
  quads: Quad[];
}> {
  const scope = createGraphKnowledgeAssetScope(meta.ual, meta.assertionVersion);
  if (!Number.isSafeInteger(meta.publicTripleCount) || meta.publicTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA public triple count: ${meta.publicTripleCount}`);
  }
  const privateTripleCount = meta.privateTripleCount ?? 0;
  if (!Number.isSafeInteger(privateTripleCount) || privateTripleCount < 0) {
    throw new Error(`Invalid graph-scoped KA private triple count: ${privateTripleCount}`);
  }
  if (privateTripleCount > 0 && meta.privateMerkleRoot?.length !== 32) {
    throw new Error('Graph-scoped KA private content requires one 32-byte private Merkle root');
  }
  if (privateTripleCount === 0 && meta.privateMerkleRoot !== undefined) {
    throw new Error('Graph-scoped KA private Merkle root requires a positive private triple count');
  }
  if (meta.publicTripleCount === 0 && privateTripleCount === 0) {
    throw new Error('Graph-scoped KA metadata cannot describe an empty asset');
  }
  assertSafeGraphIriForSparql(meta.assertionGraph);
  if (meta.subGraphName !== undefined && meta.assertionGraph !== knowledgeAssetLayerGraphUri(
    meta.contextGraphId, MemoryLayer.VerifiableMemory, scope, meta.subGraphName,
  )) throw new Error('Graph-scoped KA subgraph does not match its canonical assertion graph');

  const metaGraph = `did:dkg:context-graph:${meta.contextGraphId}/_meta`;
  const publisherPeerId = meta.publisherPeerId || 'unknown';
  const attributedAgent = meta.agentAddress ?? meta.authorAddress;
  const quads: Quad[] = [
    mq(scope.ual, `${DKG}merkleRoot`, lit(toHex(meta.merkleRoot)), metaGraph),
    mq(scope.ual, GRAPH_KNOWLEDGE_ASSET_PUBLISHED_AT_PREDICATE, dateLit(meta.timestamp), metaGraph),
    mq(scope.ual, `${DKG}accessPolicy`, lit(meta.accessPolicy ?? 'public'), metaGraph),
    mq(scope.ual, `${DKG}publisherPeerId`, lit(publisherPeerId), metaGraph),
    mq(
      scope.ual,
      `${PROV}wasAttributedTo`,
      attributedAgent && !isZeroEthAddress(attributedAgent)
        ? agentDid(attributedAgent)
        : lit(publisherPeerId),
      metaGraph,
    ),
    mq(
      scope.ual,
      `${DKG}contextGraph`,
      `did:dkg:context-graph:${meta.contextGraphId}`,
      metaGraph,
    ),
  ];
  if (meta.subGraphName) {
    quads.push(mq(scope.ual, `${DKG}subGraphName`, lit(meta.subGraphName), metaGraph));
  }
  for (const peerId of meta.allowedPeers ?? []) {
    quads.push(mq(scope.ual, `${DKG}allowedPeer`, lit(peerId), metaGraph));
  }
  quads.push(
    mq(
      scope.ual,
      `${DKG}contentScopeVersion`,
      intLit(GRAPH_KA_CONTENT_SCOPE_VERSION),
      metaGraph,
    ),
    mq(scope.ual, `${DKG}kaUal`, scope.ual, metaGraph),
    mq(scope.ual, `${DKG}assertionVersion`, intLit(BigInt(scope.assertionVersion)), metaGraph),
    mq(scope.ual, `${DKG}publicTripleCount`, intLit(meta.publicTripleCount), metaGraph),
    mq(scope.ual, `${DKG}privateTripleCount`, intLit(privateTripleCount), metaGraph),
    mq(scope.ual, `${DKG}assertionGraph`, meta.assertionGraph, metaGraph),
  );
  if (meta.privateMerkleRoot) {
    quads.push(
      mq(scope.ual, `${DKG}privateMerkleRoot`, lit(toHex(meta.privateMerkleRoot)), metaGraph),
    );
  }
  return { scope, metaGraph, quads };
}

function parseCanonicalMaterializedVersionV1(raw: string): MaterializedVersion | null {
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(raw);
  if (!match) return null;
  const blockNumber = Number(match[1]);
  const txIndex = Number(match[2]);
  if (!Number.isSafeInteger(blockNumber) || !Number.isSafeInteger(txIndex)) return null;
  return { blockNumber, txIndex };
}

function rdfLiteralLexicalValue(value: string): string | undefined {
  const match = /^("(?:\\.|[^"\\])*")/.exec(value);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function materializedVersionQuad(
  metaGraph: string,
  ual: string,
  version: MaterializedVersion,
): Quad {
  assertSafeGraphIriForSparql(metaGraph);
  assertSafeGraphIriForSparql(ual);
  return mq(
    ual,
    MATERIALIZED_VERSION_PREDICATE,
    lit(`${version.blockNumber}:${version.txIndex}`),
    metaGraph,
  );
}

function assertSafeGraphIriForSparql(graphIri: string): void {
  if (/[<>"{}|^`\\\s]/.test(graphIri)) {
    throw new Error(`Unsafe graph IRI for SPARQL query: "${graphIri}"`);
  }
}

function mq(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

function lit(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
  return `"${escaped}"`;
}

function intLit(value: number | bigint): string {
  return `"${value}"^^<${XSD}integer>`;
}

function dateLit(value: Date): string {
  return `"${value.toISOString()}"^^<${XSD}dateTime>`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isZeroEthAddress(address: string): boolean {
  return /^0x0{40}$/i.test(address);
}

function agentDid(address: string): string {
  return toAgentDid(address);
}
