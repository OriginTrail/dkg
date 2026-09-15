// SPDX-License-Identifier: Apache-2.0

import { assertSafeIri, createGraphKnowledgeAssetScope, isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
export const SWM_WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
export const SWM_HEAD_SUFFIX = '#dkg-swm-head';
export const SWM_PREDICATES = {
  type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  wasAttributedTo: 'http://www.w3.org/ns/prov#wasAttributedTo',
  contextGraphId: `${DKG}contextGraphId`, shareOperationId: `${DKG}shareOperationId`,
  publisherPeerId: `${DKG}publisherPeerId`, publishedAt: `${DKG}publishedAt`,
  subGraphName: `${DKG}subGraphName`, rootEntity: `${DKG}rootEntity`, entity: `${DKG}entity`,
  contentScopeVersion: `${DKG}contentScopeVersion`, kaUal: `${DKG}kaUal`,
  assertionVersion: `${DKG}assertionVersion`, assertionGraph: `${DKG}assertionGraph`,
  publicQuadsCount: `${DKG}publicQuadsCount`, privateTripleCount: `${DKG}privateTripleCount`,
  privateMerkleRoot: `${DKG}privateMerkleRoot`, accessPolicy: `${DKG}accessPolicy`,
  allowedPeer: `${DKG}allowedPeer`, publicQuadsDigest: `${DKG}publicQuadsDigest`,
  publicSnapshotGraph: `${DKG}publicSnapshotGraph`, publicSnapshotRef: `${DKG}publicSnapshotRef`,
  publicSliceRootEntity: `${DKG}publicSliceRootEntity`, publicStagedQuads: `${DKG}publicStagedQuads`,
  workspaceOwner: `${DKG}workspaceOwner`,
} as const;

const P = SWM_PREDICATES;
const COMMON = {
  contextGraphId: P.contextGraphId, shareOperationId: P.shareOperationId,
  publisherPeerId: P.publisherPeerId, publishedAt: P.publishedAt,
  subGraphName: P.subGraphName, wasAttributedTo: P.wasAttributedTo,
};
const PUBLIC_SNAPSHOT = {
  publicQuadsDigest: P.publicQuadsDigest, publicQuadsCount: P.publicQuadsCount,
  publicSnapshotGraph: P.publicSnapshotGraph,
  // Read compatibility: current producers use the digest as the store reference.
  publicSnapshotRef: P.publicSnapshotRef,
};

/** Inbound predicate allowlists, including historical read-only wire fields. */
export const SWM_READ_FIELDS = {
  legacyOperationV1: {
    ...COMMON, type: P.type, rootEntity: P.rootEntity,
    entity: P.entity, // Historical member alias; current writers emit rootEntity.
  },
  graphOperationV2: {
    ...COMMON, ...PUBLIC_SNAPSHOT, type: P.type,
    contentScopeVersion: P.contentScopeVersion, kaUal: P.kaUal,
    assertionVersion: P.assertionVersion, privateTripleCount: P.privateTripleCount,
    privateMerkleRoot: P.privateMerkleRoot, accessPolicy: P.accessPolicy, allowedPeer: P.allowedPeer,
  },
  headV2: {
    contentScopeVersion: P.contentScopeVersion, kaUal: P.kaUal,
    assertionVersion: P.assertionVersion, assertionGraph: P.assertionGraph,
    shareOperationId: P.shareOperationId,
  },
  publicSliceV1: {
    ...COMMON, ...PUBLIC_SNAPSHOT, publicSliceRootEntity: P.publicSliceRootEntity,
    publicStagedQuads: P.publicStagedQuads, // Historical inline JSON payload.
  },
  ownershipV1: { workspaceOwner: P.workspaceOwner, wasAttributedTo: P.wasAttributedTo },
} as const;

export type SwmRecordRole = keyof typeof SWM_READ_FIELDS;
/** Current producers cannot emit historical member/payload/reference aliases. */
interface CurrentWriteTerms {
  readonly entity?: never;
  readonly publicSnapshotRef?: never;
  readonly publicStagedQuads?: never;
}
interface OperationTerms extends CurrentWriteTerms {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly publisherPeerId: string;
  readonly wasAttributedTo: string;
  readonly publishedAt: string;
  readonly subGraphName?: string;
}
export interface LegacySwmOperationTerms extends OperationTerms {
  readonly type: typeof SWM_WORKSPACE_OPERATION;
  readonly rootEntity: readonly string[];
}
export interface SwmHeadTerms extends CurrentWriteTerms {
  readonly contentScopeVersion: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  readonly shareOperationId: string;
}
export interface SwmPublicSliceTerms extends OperationTerms {
  readonly publicSliceRootEntity: string;
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: string;
  readonly publicSnapshotGraph?: string;
}
export interface SwmOwnershipTerms extends CurrentWriteTerms {
  readonly workspaceOwner: string;
  readonly wasAttributedTo?: never;
}
interface GraphSwmOperationHeaderTerms extends OperationTerms {
  readonly type: typeof SWM_WORKSPACE_OPERATION;
  readonly contentScopeVersion: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly publicQuadsCount: string;
  readonly privateTripleCount: string;
  readonly privateMerkleRoot?: string;
  readonly accessPolicy?: string;
  readonly allowedPeer?: readonly string[];
}
interface GraphSwmSnapshotFragmentTerms extends CurrentWriteTerms {
  readonly publicQuadsDigest: string;
  readonly publicSnapshotGraph?: string;
}

const CURRENT_OPERATION_FIELDS = ['contextGraphId', 'shareOperationId', 'publisherPeerId', 'wasAttributedTo', 'publishedAt', 'subGraphName'] as const;
// Write fields are deliberately independent of historical read allowlists.
const WRITE_FIELDS = {
  legacyOperationV1: [...CURRENT_OPERATION_FIELDS, 'type', 'rootEntity'],
  headV2: ['contentScopeVersion', 'kaUal', 'assertionVersion', 'assertionGraph', 'shareOperationId'],
  publicSliceV1: [...CURRENT_OPERATION_FIELDS, 'publicSliceRootEntity', 'publicQuadsDigest', 'publicQuadsCount', 'publicSnapshotGraph'],
  ownershipV1: ['workspaceOwner'],
  graphOperationHeader: [...CURRENT_OPERATION_FIELDS, 'type', 'contentScopeVersion', 'kaUal', 'assertionVersion',
    'publicQuadsCount', 'privateTripleCount', 'privateMerkleRoot', 'accessPolicy', 'allowedPeer'],
  graphSnapshotFragment: ['publicQuadsDigest', 'publicSnapshotGraph'],
} as const satisfies Record<string, readonly (keyof typeof P)[]>;

/** Private serializer: preserve caller order and reject fields outside the writer contract. */
function emitTerms(role: keyof typeof WRITE_FIELDS, subject: string, graph: string, terms: object): Quad[] {
  const rows: Quad[] = [];
  const fields: readonly string[] = WRITE_FIELDS[role];
  for (const [field, value] of Object.entries(terms) as Array<[keyof typeof P, string | readonly string[] | undefined]>) {
    if (!fields.includes(field)) throw new Error(`Unknown ${role} field: ${field}`);
    for (const object of typeof value === 'string' ? [value] : value ?? []) {
      rows.push({ subject, predicate: P[field], object, graph });
    }
  }
  return rows;
}
export function emitLegacySwmOperation(subject: string, graph: string, terms: LegacySwmOperationTerms): Quad[] {
  return emitTerms('legacyOperationV1', subject, graph, terms);
}
export function emitSwmHead(subject: string, graph: string, terms: SwmHeadTerms): Quad[] {
  return emitTerms('headV2', subject, graph, terms);
}
export function emitSwmPublicSlice(subject: string, graph: string, terms: SwmPublicSliceTerms): Quad[] {
  return emitTerms('publicSliceV1', subject, graph, terms);
}
export function emitSwmOwnership(subject: string, graph: string, terms: SwmOwnershipTerms): Quad[] {
  return emitTerms('ownershipV1', subject, graph, terms);
}
/** Internal incremental writer: the snapshot commitment is appended after snapshot storage. */
export function emitGraphSwmOperationHeader(subject: string, graph: string, terms: GraphSwmOperationHeaderTerms): Quad[] {
  return emitTerms('graphOperationHeader', subject, graph, terms);
}
/** Internal fragment writer; deliberately absent from the publisher package exports. */
export function emitGraphSwmSnapshotFragment(subject: string, graph: string, terms: GraphSwmSnapshotFragmentTerms): Quad[] {
  return emitTerms('graphSnapshotFragment', subject, graph, terms);
}

const READ_PREDICATES: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries(SWM_READ_FIELDS)
  .map(([role, fields]) => [role, new Set(Object.values(fields))]));

export function isSwmRecordRowAllowed(role: SwmRecordRole, row: Quad): boolean {
  return READ_PREDICATES.get(role)!.has(row.predicate)
    && (row.predicate !== P.type || row.object === SWM_WORKSPACE_OPERATION);
}

/** Preserve row order and duplicates while excluding fields from other roles. */
export function selectSwmRecordRows(role: SwmRecordRole, rows: readonly Quad[]): Quad[] {
  return rows.filter(row => isSwmRecordRowAllowed(role, row));
}

export function swmOperationSubject(contextGraphId: string, shareOperationId: string): string {
  const cg = safeWorkspaceIdPart(contextGraphId, 'contextGraphId');
  const id = safeWorkspaceIdPart(shareOperationId, 'shareOperationId');
  return assertSafeIri(`urn:dkg:share:${cg}:${id}`);
}

function safeWorkspaceIdPart(value: string, fieldName: 'contextGraphId' | 'shareOperationId'): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`Shared-memory resolution requires a non-empty ${fieldName}`);
  if (/[\s<>"{}|^`\\]/.test(normalized)) throw new Error(`Shared-memory resolution rejected unsafe ${fieldName}: ${value}`);
  return normalized;
}

export function swmKnowledgeAssetHeadSubject(kaUal: string): string {
  return assertSafeIri(`${createGraphKnowledgeAssetScope(kaUal, 1).ual}${SWM_HEAD_SUFFIX}`);
}

export function swmPublicSliceSubject(contextGraphId: string, shareOperationId: string, rootEntity: string, subGraphName?: string): string {
  return assertSafeIri(`urn:dkg:public-stage:${[contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity].map(encodeURIComponent).join(':')}`);
}

export function decodeSwmPublicSliceSubject(subject: string): {
  contextGraphId: string; shareOperationId: string; rootEntity: string; subGraphName?: string;
} | undefined {
  const prefix = 'urn:dkg:public-stage:';
  if (!subject.startsWith(prefix)) return undefined;
  try {
    const parts = subject.slice(prefix.length).split(':').map(decodeURIComponent);
    if (parts.length !== 4 || parts.some(part => !part)) return undefined;
    const [contextGraphId, sub, shareOperationId, rootEntity] = parts;
    const subGraphName = sub === '_' ? undefined : sub;
    if (!isSafeIri(rootEntity) || (subGraphName !== undefined && !validateSubGraphName(subGraphName).valid)) return undefined;
    swmOperationSubject(contextGraphId, shareOperationId);
    if (swmPublicSliceSubject(contextGraphId, shareOperationId, rootEntity, subGraphName) !== subject) return undefined;
    return { contextGraphId, shareOperationId, rootEntity, ...(subGraphName ? { subGraphName } : {}) };
  } catch { return undefined; }
}

export function swmKnowledgeAssetOperationSnapshotGraph(contextGraphId: string, shareOperationId: string, subGraphName?: string): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId].map(encodeURIComponent);
  return assertSafeIri(`did:dkg:context-graph:${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/ka`);
}
