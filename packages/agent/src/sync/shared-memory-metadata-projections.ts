// SPDX-License-Identifier: Apache-2.0

import {
  GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer,
  createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri,
} from '@origintrail-official/dkg-core';
import {
  SWM_HEAD_SUFFIX, SWM_PREDICATES as P, swmOperationSubject,
  swmKnowledgeAssetOperationSnapshotGraph as knowledgeAssetSnapshotGraph,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { AdmittedSharedMemoryMetadata } from './shared-memory-metadata-admission.js';
import {
  swmRecordKey, swmRecordSourceIndices, swmRecordQuads,
  swmRecoveryLiteralValue as stripLiteral,
  type AdmittedGraphSwmOperation, type AdmittedSwmHead, type SharedMemoryContextScope,
} from './shared-memory-metadata-records.js';

const CONTENT_SCOPE_VERSION = P.contentScopeVersion;
const KA_UAL = P.kaUal;
const ASSERTION_VERSION = P.assertionVersion;
const ASSERTION_GRAPH = P.assertionGraph;
const SHARE_OPERATION_ID = P.shareOperationId;
const PUBLIC_QUADS_DIGEST = P.publicQuadsDigest;
const PUBLIC_QUADS_COUNT = P.publicQuadsCount;
const PUBLIC_SNAPSHOT_REF = P.publicSnapshotRef;
const PUBLIC_SNAPSHOT_GRAPH = P.publicSnapshotGraph;
const PRIVATE_TRIPLE_COUNT = P.privateTripleCount;
const PRIVATE_MERKLE_ROOT = P.privateMerkleRoot;
const PUBLISHED_AT = P.publishedAt;
const ACCESS_POLICY = P.accessPolicy;
const ALLOWED_PEER = P.allowedPeer;
const HEAD_SUFFIX = SWM_HEAD_SUFFIX;

/** Replay source positions, preserving duplicates and order without quad identity. */
export function projectSwmPersistence(model: AdmittedSharedMemoryMetadata): Quad[] {
  const selected = new Set(model.records.flatMap(record => [...swmRecordSourceIndices(record)]));
  return model.sourceQuads.filter((_row, index) => selected.has(index));
}

export interface LegacySwmHydration {
  readonly legacyRoots: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ownership: Array<{ dataGraph: string; entity: string; creator: string }>;
}
export function projectLegacySwmHydration(model: AdmittedSharedMemoryMetadata): LegacySwmHydration {
  const members = model.records.flatMap(record => record.role === 'legacyOperation' && record.published
    ? record.members.map(member => ({ ...member, dataGraph: record.dataGraph, creator: record.creator })) : []);
  // The first published membership in wire order owns a root, even when records
  // are interleaved or decoded in a different order from their member rows.
  members.sort((a, b) => a.sourceIndex - b.sourceIndex);
  const legacyRoots = new Map<string, Set<string>>();
  const ownership = new Map<string, { dataGraph: string; entity: string; creator: string }>();
  for (const { root, dataGraph, creator } of members) {
    let allowed = legacyRoots.get(dataGraph);
    if (!allowed) { allowed = new Set(); legacyRoots.set(dataGraph, allowed); }
    allowed.add(root);
    const key = swmRecordKey(dataGraph, root);
    if (creator && !ownership.has(key)) ownership.set(key, { dataGraph, entity: root, creator });
  }
  return { legacyRoots, ownership: [...ownership.values()] };
}

export interface GraphScopedSwmRecoveryDescriptor {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly operationSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  readonly shareOperationId: string;
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: number;
  /** Authenticated private-content commitment carried by the active operation. */
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly publicSnapshotRef?: string;
  readonly publicSnapshotGraph?: string;
  readonly publisherPeerId: string;
  readonly subGraphName?: string;
  /** Only the active head and its referenced operation, for snapshot fetch. */
  readonly metadataQuads: readonly Quad[];
}

/**
 * Decode complete recovery descriptors from admitted records. Persistence may
 * retain partial historical protocol records; this projection is the sole
 * strict recovery boundary for field decoding, candidate selection and binding
 * invariants. Recovery callers consume descriptors without re-reading fields.
 */
export function projectStrictSwmRecovery(
  model: AdmittedSharedMemoryMetadata<SharedMemoryContextScope>,
): GraphScopedSwmRecoveryDescriptor[] {
  const { contextGraphId } = model.scope;
  for (const rejection of model.rejections) {
    if (rejection.recordRole !== 'head') continue;
    if (rejection.reason === 'outOfScope') {
      throw new Error(`Graph-scoped SWM head ${rejection.subject} is in an unregistered metadata graph ${rejection.metaGraph}`);
    }
    throw new Error(`Graph-scoped SWM head ${rejection.subject} has a non-canonical or mismatched kaUal`);
  }
  const heads: AdmittedSwmHead[] = [];
  const graphOperations = new Map<string, AdmittedGraphSwmOperation>();
  for (const record of model.records) {
    if (record.role === 'head') heads.push(record);
    else if (record.role === 'graphOperation') graphOperations.set(swmRecordKey(record.metaGraph, record.subject), record);
  }
  const descriptors: GraphScopedSwmRecoveryDescriptor[] = [];

  for (const head of heads) {
    const { metaGraph, subject: headSubject } = head;
    const headRows = swmRecordQuads(head);
    const kaUalFromHead = headSubject.slice(0, -HEAD_SUFFIX.length);
    const scopeVersion = requireSafeInteger(headRows, CONTENT_SCOPE_VERSION, 'contentScopeVersion');
    if (scopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new Error(`Graph-scoped SWM head ${headSubject} has unsupported contentScopeVersion ${scopeVersion}`);
    }
    const kaUal = requireSingle(headRows, KA_UAL, 'kaUal');
    const assertionVersion = requirePositiveInteger(headRows, ASSERTION_VERSION, 'assertionVersion');
    const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
    if (scope.ual !== kaUal || scope.ual !== kaUalFromHead) {
      throw new Error(`Graph-scoped SWM head ${headSubject} has a non-canonical or mismatched kaUal`);
    }

    if (head.lane.kind !== 'context' || head.lane.contextGraphId !== contextGraphId) {
      throw new Error(`Graph-scoped SWM head ${headSubject} is in an unregistered metadata graph ${metaGraph}`);
    }
    const subGraphName = head.lane.subGraphName;
    const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
      contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
      subGraphName,
    );
    const assertionGraph = requireSingle(headRows, ASSERTION_GRAPH, 'assertionGraph');
    if (assertionGraph !== expectedAssertionGraph) {
      throw new Error(
        `Graph-scoped SWM head ${headSubject} assertionGraph mismatch: ` +
        `expected ${expectedAssertionGraph}, found ${assertionGraph}`,
      );
    }

    const operation = resolveEquivalentHeadOperation({
      headRows,
      graphOperations,
      contextGraphId,
      metaGraph,
      headSubject,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      subGraphName,
    });
    const { shareOperationId, operationSubject, operationRows, publisherPeerId } = operation;

    const publicQuadsDigest = requireLiteral(
      operationRows,
      PUBLIC_QUADS_DIGEST,
      'publicQuadsDigest',
    ).trim().toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(publicQuadsDigest)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publicQuadsDigest`);
    }
    const publicQuadsCount = requireSafeInteger(
      operationRows,
      PUBLIC_QUADS_COUNT,
      'publicQuadsCount',
    );
    if (publicQuadsCount < 0) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has a negative publicQuadsCount`);
    }
    const privateTripleCount = requireSafeInteger(
      operationRows,
      PRIVATE_TRIPLE_COUNT,
      'privateTripleCount',
    );
    if (privateTripleCount < 0 || (privateTripleCount === 0 && publicQuadsCount === 0)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has invalid public/private counts`);
    }
    const privateRoot = optionalSingle(operationRows, PRIVATE_MERKLE_ROOT, 'privateMerkleRoot');
    if (
      (privateTripleCount > 0 && !/^0x[0-9a-fA-F]{64}$/.test(stripLiteral(privateRoot ?? '')))
      || (privateTripleCount === 0 && privateRoot !== undefined)
    ) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid private commitment`);
    }

    const publicSnapshotGraph = optionalSingle(
      operationRows,
      PUBLIC_SNAPSHOT_GRAPH,
      'publicSnapshotGraph',
    );
    const explicitSnapshotRef = optionalLiteral(
      operationRows,
      PUBLIC_SNAPSHOT_REF,
      'publicSnapshotRef',
    )?.trim();
    if (publicSnapshotGraph && explicitSnapshotRef) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has two public snapshot locations`);
    }
    if (publicSnapshotGraph) {
      const expectedSnapshotGraph = knowledgeAssetSnapshotGraph(
        contextGraphId,
        shareOperationId,
        subGraphName,
      );
      if (publicSnapshotGraph !== expectedSnapshotGraph) {
        throw new Error(
          `Graph-scoped SWM operation ${operationSubject} snapshot graph mismatch: ` +
          `expected ${expectedSnapshotGraph}, found ${publicSnapshotGraph}`,
        );
      }
    }
    const publicSnapshotRef = publicSnapshotGraph
      ? undefined
      : (explicitSnapshotRef || publicQuadsDigest);
    if (publicSnapshotRef && !/^sha256:[0-9a-f]{64}$/i.test(publicSnapshotRef)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publicSnapshotRef`);
    }

    if (!publisherPeerId) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an empty publisherPeerId`);
    }
    descriptors.push({
      metaGraph,
      headSubject,
      operationSubject,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      assertionGraph,
      shareOperationId,
      publicQuadsDigest,
      publicQuadsCount,
      privateTripleCount,
      ...(privateRoot === undefined
        ? {}
        : { privateMerkleRoot: stripLiteral(privateRoot).toLowerCase() }),
      ...(publicSnapshotRef ? { publicSnapshotRef } : {}),
      ...(publicSnapshotGraph ? { publicSnapshotGraph } : {}),
      publisherPeerId,
      ...(subGraphName ? { subGraphName } : {}),
      metadataQuads: [
        ...headRows.filter((row) => row.predicate !== SHARE_OPERATION_ID),
        // EVERY lexical form of the selected id, not just the one selected
        // row: RDF 1.1 admits the same value as a plain and an
        // xsd:string-typed literal, and downstream withhold plans are built
        // from these rows BYTE-keyed — a variant left out here passes the
        // value-based insert canonicalization and re-stacks the losing id
        // beside a just-preserved head.
        ...headRows.filter((row) => row.predicate === SHARE_OPERATION_ID
          && stripLiteral(row.object).trim() === shareOperationId),
        ...operationRows,
      ],
    });
  }

  const assertionOwners = new Map<string, string>();
  for (const descriptor of descriptors) {
    const owner = assertionOwners.get(descriptor.assertionGraph);
    if (owner && owner !== descriptor.kaUal) {
      throw new Error(`Graph-scoped SWM assertion graph ${descriptor.assertionGraph} has multiple UAL owners`);
    }
    assertionOwners.set(descriptor.assertionGraph, descriptor.kaUal);
  }
  return descriptors;
}

interface ResolvedHeadOperation {
  readonly shareOperationId: string;
  readonly operationSubject: string;
  readonly operationRows: readonly Quad[];
  readonly publisherPeerId: string;
}

/**
 * Storage-ACK persistence and originator persistence can legitimately produce
 * two operation ids for the same exact assertion. Accept that residue only
 * when every recovery-relevant operation row is byte-equivalent (apart from
 * operation id and timestamp), then choose the newest operation
 * deterministically. Any content or policy disagreement remains fail-closed.
 */
function resolveEquivalentHeadOperation(params: {
  readonly headRows: readonly Quad[];
  readonly graphOperations: ReadonlyMap<string, AdmittedGraphSwmOperation>;
  readonly contextGraphId: string;
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
}): ResolvedHeadOperation {
  const shareOperationIds = [...new Set(
    distinctObjects(params.headRows, SHARE_OPERATION_ID)
      .map(stripLiteral)
      .map((value) => value.trim()),
  )];
  if (shareOperationIds.length === 0) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
  }
  if (shareOperationIds.some((value) => value.length === 0)) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} has an empty shareOperationId`);
  }

  const candidates = shareOperationIds.map((shareOperationId) => {
    const operationSubject = swmOperationSubject(params.contextGraphId, shareOperationId);
    const operation = params.graphOperations.get(
      `${params.metaGraph}\u0000${operationSubject}`,
    );
    if (!operation) {
      throw new Error(`Graph-scoped SWM head references missing operation ${operationSubject}`);
    }
    const operationRows = swmRecordQuads(operation);
    validateOperationForHead({
      operation,
      metaGraph: params.metaGraph,
      operationSubject,
      shareOperationId,
      kaUal: params.kaUal,
      assertionVersion: params.assertionVersion,
      subGraphName: params.subGraphName,
    });
    const publishedAt = operation.envelope.publishedAt;
    const publishedAtMs = Date.parse(publishedAt);
    if (!Number.isFinite(publishedAtMs)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publishedAt`);
    }
    // SAME-PAYLOAD BYTE-EQUIVALENCE policy — deliberately NOT the same model
    // as `operationIdentityKey`. This key compares candidate operations that
    // arrived in ONE payload (one serializer, one canonicalization), so byte
    // comparison over ALL rows minus id/publishedAt is exact, and its job is
    // to THROW on genuine ambiguity. `operationIdentityKey` compares rows
    // across INDEPENDENT stores (wire vs read-back), so it must normalize
    // lexical forms and restrict itself to the identity allow-list. Folding
    // either into the other loses a property: normalization here would merge
    // candidates that genuinely differ on the wire; byte comparison there
    // would break on store re-canonicalization. Unifying both behind one
    // policy module with explicit knobs is recorded follow-up F3.
    const samePayloadByteEquivalenceKey = operationRows
      .filter((row) => row.predicate !== SHARE_OPERATION_ID && row.predicate !== PUBLISHED_AT)
      .map((row) => `${row.predicate}\u0000${row.object}\u0000${row.graph}`)
      .sort()
      .join('\u0001');
    const headShareOperationRow = params.headRows
      .filter((row) => row.predicate === SHARE_OPERATION_ID)
      .find((row) => stripLiteral(row.object).trim() === shareOperationId);
    if (!headShareOperationRow) {
      throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
    }
    return {
      shareOperationId,
      operationSubject,
      operationRows,
      publisherPeerId: operation.envelope.publisherPeerId,
      publishedAtMs,
      samePayloadByteEquivalenceKey,
    };
  });

  if (new Set(candidates.map((candidate) => candidate.samePayloadByteEquivalenceKey)).size > 1) {
    throw new Error(`ambiguous shareOperationId`);
  }
  candidates.sort((left, right) =>
    right.publishedAtMs - left.publishedAtMs
    || right.shareOperationId.localeCompare(left.shareOperationId));
  return candidates[0]!;
}

function validateOperationForHead(params: {
  operation: AdmittedGraphSwmOperation;
  metaGraph: string;
  operationSubject: string;
  shareOperationId: string;
  kaUal: string;
  assertionVersion: string;
  subGraphName?: string;
}): void {
  const rows = swmRecordQuads(params.operation);
  const envelope = params.operation.envelope;
  if (envelope.shareOperationId !== params.shareOperationId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a shareOperationId mismatch`);
  }
  if (envelope.kaUal !== params.kaUal) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a kaUal mismatch`);
  }
  if (!/^[0-9]+$/.test(envelope.assertionVersion)
    || BigInt(envelope.assertionVersion) < 1n
    || BigInt(envelope.assertionVersion).toString() !== params.assertionVersion) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an assertionVersion mismatch`);
  }
  if (envelope.subGraphName !== params.subGraphName) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a subGraphName mismatch`);
  }
  const accessPolicy = optionalLiteral(rows, ACCESS_POLICY, 'accessPolicy')?.trim();
  if (accessPolicy && !['public', 'ownerOnly', 'allowList'].includes(accessPolicy)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid accessPolicy`);
  }
  const allowedPeers = distinctObjects(rows, ALLOWED_PEER).map(stripLiteral).filter(Boolean);
  if (
    (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid access envelope`);
  }
  if (params.operation.metaGraph !== params.metaGraph || params.operation.subject !== params.operationSubject) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} is not graph-local`);
  }
}

function distinctObjects(rows: readonly Quad[], predicate: string): string[] {
  return [...new Set(rows.filter((row) => row.predicate === predicate).map((row) => row.object))];
}

function requireSingle(rows: readonly Quad[], predicate: string, field: string): string {
  const values = distinctObjects(rows, predicate);
  if (values.length !== 1) {
    throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} ${field}`);
  }
  return values[0]!;
}

function optionalSingle(rows: readonly Quad[], predicate: string, field: string): string | undefined {
  const values = distinctObjects(rows, predicate);
  if (values.length > 1) throw new Error(`ambiguous ${field}`);
  return values[0];
}

function requireLiteral(rows: readonly Quad[], predicate: string, field: string): string {
  return stripLiteral(requireSingle(rows, predicate, field));
}

function optionalLiteral(rows: readonly Quad[], predicate: string, field: string): string | undefined {
  const value = optionalSingle(rows, predicate, field);
  return value === undefined ? undefined : stripLiteral(value);
}

function requireSafeInteger(rows: readonly Quad[], predicate: string, field: string): number {
  const raw = stripLiteral(requireSingle(rows, predicate, field));
  if (!/^-?[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`unsafe ${field}`);
  return parsed;
}

function requirePositiveInteger(rows: readonly Quad[], predicate: string, field: string): string {
  const raw = stripLiteral(requireSingle(rows, predicate, field));
  if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = BigInt(raw);
  if (parsed < 1n) throw new Error(`${field} must be positive`);
  return parsed.toString();
}
