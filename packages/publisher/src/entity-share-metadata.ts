import {
  contextGraphSharedMemoryMetaUri,
  DKG_ROOT_ENTITY_LEGACY,
  isEntityPredicate,
  isSafeIri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';
import { isWorkspaceKnowledgeAssetHeadSubject, workspaceOperationPublicSliceSubject, workspaceOperationSubject } from './workspace-metadata-subjects.js';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PROV_ATTRIBUTION = 'http://www.w3.org/ns/prov#wasAttributedTo';
export const ENTITY_SHARE_SNAPSHOT_MERKLE_ROOT_PREDICATE = `${DKG}snapshotMerkleRoot`;
export const ENTITY_SHARE_SNAPSHOT_CONTENT_DIGEST_PREDICATE = `${DKG}snapshotContentDigest`;
/** Agent-local annotations accepted as sidecars, never as protocol rows. */
export const ENTITY_SHARE_METADATA_SIDECAR_PREDICATES: ReadonlySet<string> =
  new Set([
    ENTITY_SHARE_SNAPSHOT_MERKLE_ROOT_PREDICATE,
    ENTITY_SHARE_SNAPSHOT_CONTENT_DIGEST_PREDICATE,
  ]);

/** Canonical field vocabulary shared by the entity-share writer and decoder. */
export const ENTITY_SHARE_METADATA_PREDICATES = Object.freeze({
  type: RDF_TYPE,
  contextGraphId: `${DKG}contextGraphId`,
  shareOperationId: `${DKG}shareOperationId`,
  subGraphName: `${DKG}subGraphName`,
  publisherPeerId: `${DKG}publisherPeerId`,
  publishedAt: `${DKG}publishedAt`,
  wasAttributedTo: PROV_ATTRIBUTION,
  rootEntity: DKG_ROOT_ENTITY_LEGACY,
  publicSliceRootEntity: `${DKG}publicSliceRootEntity`,
  publicQuadsDigest: `${DKG}publicQuadsDigest`,
  publicQuadsCount: `${DKG}publicQuadsCount`,
  publicSnapshotRef: `${DKG}publicSnapshotRef`,
  publicSnapshotGraph: `${DKG}publicSnapshotGraph`,
});
const F = ENTITY_SHARE_METADATA_PREDICATES;
const COMMON_FIELDS = [
  F.contextGraphId, F.shareOperationId, F.subGraphName,
  F.publisherPeerId, F.publishedAt, F.wasAttributedTo,
];
const SLICE_FIELDS: ReadonlySet<string> = new Set([...COMMON_FIELDS, F.publicSliceRootEntity,
  F.publicQuadsDigest, F.publicQuadsCount, F.publicSnapshotRef, F.publicSnapshotGraph]);
const OPERATION_FIELDS: ReadonlySet<string> = new Set([...COMMON_FIELDS, F.type]);

export interface EntityShareOperationMetadataTerms {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly publisherPeerId: string;
  readonly wasAttributedTo: string;
  readonly publishedAt: string;
  readonly rootEntities: readonly string[];
  readonly subGraphName?: string;
}

/** Encode the canonical operation record from already-encoded RDF terms. */
export function encodeEntityShareOperationMetadata(
  subject: string,
  graph: string,
  terms: EntityShareOperationMetadataTerms,
): Quad[] {
  const rows: Quad[] = [
    { subject, predicate: F.type, object: `${DKG}WorkspaceOperation`, graph },
    { subject, predicate: F.contextGraphId, object: terms.contextGraphId, graph },
    { subject, predicate: F.shareOperationId, object: terms.shareOperationId, graph },
    { subject, predicate: F.publisherPeerId, object: terms.publisherPeerId, graph },
    { subject, predicate: F.wasAttributedTo, object: terms.wasAttributedTo, graph },
    { subject, predicate: F.publishedAt, object: terms.publishedAt, graph },
  ];
  if (terms.subGraphName) {
    rows.push({ subject, predicate: F.subGraphName, object: terms.subGraphName, graph });
  }
  for (const rootEntity of terms.rootEntities) {
    rows.push({ subject, predicate: F.rootEntity, object: rootEntity, graph });
  }
  return rows;
}

export interface EntityShareSliceMetadataTerms {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly rootEntity: string;
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: string;
  readonly publisherPeerId: string;
  readonly wasAttributedTo: string;
  readonly publishedAt: string;
  readonly publicSnapshotGraph?: string;
  readonly subGraphName?: string;
}

/** Encode the canonical per-root slice record from already-encoded RDF terms. */
export function encodeEntityShareSliceMetadata(
  subject: string,
  graph: string,
  terms: EntityShareSliceMetadataTerms,
): Quad[] {
  const rows: Quad[] = [
    { subject, predicate: F.contextGraphId, object: terms.contextGraphId, graph },
    { subject, predicate: F.shareOperationId, object: terms.shareOperationId, graph },
    { subject, predicate: F.publicSliceRootEntity, object: terms.rootEntity, graph },
    { subject, predicate: F.publicQuadsDigest, object: terms.publicQuadsDigest, graph },
    { subject, predicate: F.publicQuadsCount, object: terms.publicQuadsCount, graph },
    { subject, predicate: F.publisherPeerId, object: terms.publisherPeerId, graph },
    { subject, predicate: F.wasAttributedTo, object: terms.wasAttributedTo, graph },
    { subject, predicate: F.publishedAt, object: terms.publishedAt, graph },
  ];
  if (terms.publicSnapshotGraph) {
    rows.push({ subject, predicate: F.publicSnapshotGraph, object: terms.publicSnapshotGraph, graph });
  }
  if (terms.subGraphName) {
    rows.push({ subject, predicate: F.subGraphName, object: terms.subGraphName, graph });
  }
  return rows;
}

interface MetadataSubject { readonly subject: string; readonly graph: string }
export interface EntityShareSliceDescriptor extends MetadataSubject {
  readonly kind: 'slice';
  readonly ref: string;
  readonly rootEntity: string;
  readonly operationSubject: string;
  readonly subGraphName?: string;
  readonly metadataRows: readonly Quad[];
}
export interface EntityShareOperationDescriptor extends MetadataSubject {
  readonly kind: 'operation';
  readonly rootEntities: readonly string[];
  readonly subGraphName?: string;
  readonly metadataRows: readonly Quad[];
}
export type EntityShareMetadataRecord = EntityShareSliceDescriptor | EntityShareOperationDescriptor
  | (MetadataSubject & { readonly kind: 'head'; readonly operationSubjects: readonly string[] })
  | (MetadataSubject & { readonly kind: 'other' });

function oneValue(rows: readonly Quad[], predicate: string): string | undefined {
  const values = new Set(rows.filter(row => row.predicate === predicate).map(row => row.object));
  return values.size === 1 ? [...values][0] : undefined;
}
function literal(rows: readonly Quad[], predicate: string): string | undefined {
  const value = oneValue(rows, predicate);
  return value === undefined ? undefined : parseRdfLiteralTerm(value)?.value;
}
function operationSubject(contextGraphId: string, operationId: string): string | undefined {
  try { return workspaceOperationSubject(contextGraphId, operationId); } catch { return undefined; }
}

/** Decode the publisher's entity-share model; the requester owns readiness policy. */
export function decodeEntityShareMetadata(contextGraphId: string, metadata: readonly Quad[]): EntityShareMetadataRecord[] {
  const groups = new Map<string, Quad[]>();
  for (const row of metadata) {
    const key = `${row.graph}\u0000${row.subject}`;
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  return [...groups.values()].map(rows => {
    const { graph, subject } = rows[0]!;
    const protocolRows = rows.filter(
      row => !ENTITY_SHARE_METADATA_SIDECAR_PREDICATES.has(row.predicate),
    );
    const other = { kind: 'other', graph, subject } as const;
    if (isWorkspaceKnowledgeAssetHeadSubject(subject)) {
      const claims = protocolRows.filter(row => row.predicate === F.shareOperationId)
        .map(row => operationSubject(contextGraphId, parseRdfLiteralTerm(row.object)?.value ?? row.object))
        .filter((value): value is string => value !== undefined);
      return { kind: 'head', graph, subject, operationSubjects: [...new Set(claims)] };
    }
    const cg = literal(protocolRows, F.contextGraphId);
    const operationId = literal(protocolRows, F.shareOperationId);
    const subGraphName = literal(protocolRows, F.subGraphName);
    if (cg !== contextGraphId || !operationId
        || (subGraphName === undefined && protocolRows.some(row => row.predicate === F.subGraphName))) return other;
    if ((subGraphName !== undefined && !validateSubGraphName(subGraphName).valid)
        || graph !== contextGraphSharedMemoryMetaUri(cg, subGraphName)) return other;
    const operation = operationSubject(cg, operationId);
    if (!operation) return other;
    const root = oneValue(protocolRows, F.publicSliceRootEntity);
    const digest = literal(protocolRows, F.publicQuadsDigest);
    const count = literal(protocolRows, F.publicQuadsCount);
    const explicitRef = literal(protocolRows, F.publicSnapshotRef);
    const ref = explicitRef ?? digest;
    const validRef = explicitRef !== undefined || !protocolRows.some(row => row.predicate === F.publicSnapshotRef);
    if (root && isSafeIri(root) && digest && ref && validRef && count !== undefined
        && /^\d+$/.test(count) && Number.isSafeInteger(Number(count))
        && protocolRows.every(row => SLICE_FIELDS.has(row.predicate))
        && subject === workspaceOperationPublicSliceSubject(cg, operationId, root, subGraphName)) {
      return { kind: 'slice', ref, graph, subject, rootEntity: root, operationSubject: operation, subGraphName, metadataRows: protocolRows };
    }
    if (subject !== operation || oneValue(protocolRows, F.type) !== `${DKG}WorkspaceOperation`
        || !protocolRows.every(row => OPERATION_FIELDS.has(row.predicate) || isEntityPredicate(row.predicate))) return other;
    const rootEntities = [...new Set(protocolRows.filter(row => isEntityPredicate(row.predicate)).map(row => row.object))];
    if (rootEntities.length === 0 || !rootEntities.every(isSafeIri)) return other;
    return { kind: 'operation', graph, subject, rootEntities, subGraphName,
      metadataRows: protocolRows };
  });
}
