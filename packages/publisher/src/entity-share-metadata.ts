import { SWM_PREDICATES } from './swm-metadata-schema.js';
import {
  contextGraphSharedMemoryMetaUri,
  isEntityPredicate,
  isSafeIri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';
import { isWorkspaceKnowledgeAssetHeadSubject, workspaceOperationPublicSliceSubject, workspaceOperationSubject } from './workspace-metadata-subjects.js';

const DKG = 'http://dkg.io/ontology/';
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
  type: SWM_PREDICATES.type,
  contextGraphId: SWM_PREDICATES.contextGraphId,
  shareOperationId: SWM_PREDICATES.shareOperationId,
  subGraphName: SWM_PREDICATES.subGraphName,
  publisherPeerId: SWM_PREDICATES.publisherPeerId,
  publishedAt: SWM_PREDICATES.publishedAt,
  wasAttributedTo: SWM_PREDICATES.wasAttributedTo,
  rootEntity: SWM_PREDICATES.rootEntity,
  publicSliceRootEntity: SWM_PREDICATES.publicSliceRootEntity,
  publicQuadsDigest: SWM_PREDICATES.publicQuadsDigest,
  publicQuadsCount: SWM_PREDICATES.publicQuadsCount,
  publicSnapshotRef: SWM_PREDICATES.publicSnapshotRef,
  publicSnapshotGraph: SWM_PREDICATES.publicSnapshotGraph,
});
const F = ENTITY_SHARE_METADATA_PREDICATES;
const COMMON_FIELDS = [
  F.contextGraphId, F.shareOperationId, F.subGraphName,
  F.publisherPeerId, F.publishedAt, F.wasAttributedTo,
];
const SLICE_FIELDS: ReadonlySet<string> = new Set([...COMMON_FIELDS, F.publicSliceRootEntity,
  F.publicQuadsDigest, F.publicQuadsCount, F.publicSnapshotRef, F.publicSnapshotGraph]);
const OPERATION_FIELDS: ReadonlySet<string> = new Set([...COMMON_FIELDS, F.type]);

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
