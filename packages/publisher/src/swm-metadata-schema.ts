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

type WriteCardinality = 'one' | 'optional' | 'many' | 'optionalMany';
type WriteFieldDescriptor = readonly [keyof typeof P, WriteCardinality];
const CURRENT_OPERATION_FIELDS = [
  ['contextGraphId', 'one'], ['shareOperationId', 'one'], ['publisherPeerId', 'one'],
  ['wasAttributedTo', 'one'], ['publishedAt', 'one'], ['subGraphName', 'optional'],
] as const satisfies readonly WriteFieldDescriptor[];

/**
 * The one source of truth for each current writer contract. Field order is
 * wire order; cardinality drives both the public input type and runtime
 * validation. Historical read-only fields intentionally appear only above.
 */
const SWM_WRITE_SCHEMAS = {
  legacyOperationV1: [...CURRENT_OPERATION_FIELDS, ['type', 'one'], ['rootEntity', 'many']],
  headV2: [
    ['contentScopeVersion', 'one'], ['kaUal', 'one'], ['assertionVersion', 'one'],
    ['assertionGraph', 'one'], ['shareOperationId', 'one'],
  ],
  publicSliceV1: [
    ...CURRENT_OPERATION_FIELDS, ['publicSliceRootEntity', 'one'], ['publicQuadsDigest', 'one'],
    ['publicQuadsCount', 'one'], ['publicSnapshotGraph', 'optional'],
  ],
  ownershipV1: [['workspaceOwner', 'one']],
  graphOperationHeader: [
    ...CURRENT_OPERATION_FIELDS, ['type', 'one'], ['contentScopeVersion', 'one'], ['kaUal', 'one'],
    ['assertionVersion', 'one'], ['publicQuadsCount', 'one'], ['privateTripleCount', 'one'],
    ['privateMerkleRoot', 'optional'], ['accessPolicy', 'optional'], ['allowedPeer', 'optionalMany'],
  ],
  graphSnapshotFragment: [['publicQuadsDigest', 'one'], ['publicSnapshotGraph', 'optional']],
} as const satisfies Record<string, readonly WriteFieldDescriptor[]>;

type WriterRole = keyof typeof SWM_WRITE_SCHEMAS;
type DescriptorFor<R extends WriterRole> = (typeof SWM_WRITE_SCHEMAS)[R][number];
type FieldsWithCardinality<R extends WriterRole, C extends WriteCardinality> =
  DescriptorFor<R> extends infer D
    ? D extends readonly [infer F extends keyof typeof P, C] ? F : never
    : never;
type WriterField<R extends WriterRole> = DescriptorFor<R>[0];
type WriterTerms<R extends WriterRole> =
  { readonly [F in FieldsWithCardinality<R, 'one'>]: string }
  & { readonly [F in FieldsWithCardinality<R, 'optional'>]?: string }
  & { readonly [F in FieldsWithCardinality<R, 'many'>]: readonly string[] }
  & { readonly [F in FieldsWithCardinality<R, 'optionalMany'>]?: readonly string[] }
  & { readonly [F in Exclude<keyof typeof P, WriterField<R>>]?: never };

export type LegacySwmOperationTerms = WriterTerms<'legacyOperationV1'>;
export type SwmHeadTerms = WriterTerms<'headV2'>;
export type SwmPublicSliceTerms = WriterTerms<'publicSliceV1'>;
export type SwmOwnershipTerms = WriterTerms<'ownershipV1'>;
type GraphSwmOperationHeaderTerms = WriterTerms<'graphOperationHeader'>;
type GraphSwmSnapshotFragmentTerms = WriterTerms<'graphSnapshotFragment'>;

/** Validate and emit in descriptor order, independent of caller object order. */
function emitTerms<R extends WriterRole>(role: R, subject: string, graph: string, terms: WriterTerms<R>): Quad[] {
  const schema: readonly WriteFieldDescriptor[] = SWM_WRITE_SCHEMAS[role];
  const allowed = new Set(schema.map(([field]) => field));
  for (const field of Object.keys(terms)) {
    if (!allowed.has(field as keyof typeof P)) throw new Error(`Unknown ${role} field: ${field}`);
  }
  const values = terms as Record<WriterField<R>, string | readonly string[] | undefined>;
  const rows: Quad[] = [];
  for (const [field, cardinality] of schema) {
    const value = values[field as WriterField<R>];
    const repeated = cardinality === 'many' || cardinality === 'optionalMany';
    const required = cardinality === 'one' || cardinality === 'many';
    if (value === undefined) {
      if (required) throw new Error(`Missing ${role} field: ${field}`);
      continue;
    }
    if (repeated ? !Array.isArray(value) : typeof value !== 'string') {
      throw new Error(`Invalid ${role} cardinality for field: ${field}`);
    }
    for (const object of repeated ? value as readonly string[] : [value as string]) {
      if (typeof object !== 'string') throw new Error(`Invalid ${role} value for field: ${field}`);
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
