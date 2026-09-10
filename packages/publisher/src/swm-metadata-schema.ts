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

/** Versioned record roles shared by producers, readers, and inbound admission. */
export const SWM_RECORD_SCHEMAS = {
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

export type SwmRecordRole = keyof typeof SWM_RECORD_SCHEMAS;
export type SwmRecordTerms<Role extends SwmRecordRole> = Partial<
  Record<keyof (typeof SWM_RECORD_SCHEMAS)[Role], string | readonly string[]>
>;

/** Emit supplied RDF terms in caller order, using the role's canonical predicates. */
export function emitSwmRecord<Role extends SwmRecordRole>(
  role: Role, subject: string, graph: string, terms: SwmRecordTerms<Role>,
): Quad[] {
  const schema: Readonly<Record<string, string>> = SWM_RECORD_SCHEMAS[role];
  const rows: Quad[] = [];
  const supplied: Readonly<Record<string, string | readonly string[] | undefined>> = terms;
  for (const [field, value] of Object.entries(supplied)) {
    const predicate = schema[field];
    if (!predicate) throw new Error(`Unknown ${role} field: ${field}`);
    for (const object of typeof value === 'string' ? [value] : value ?? []) {
      rows.push({ subject, predicate, object, graph });
    }
  }
  return rows;
}

const READ_PREDICATES: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries(SWM_RECORD_SCHEMAS)
  .map(([role, fields]) => [role, new Set(Object.values(fields))]));

/** Preserve row order and duplicates while excluding fields from other roles. */
export function selectSwmRecordRows(role: SwmRecordRole, rows: readonly Quad[]): Quad[] {
  return rows.filter(row => READ_PREDICATES.get(role)!.has(row.predicate)
    && (row.predicate !== P.type || row.object === SWM_WORKSPACE_OPERATION));
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
