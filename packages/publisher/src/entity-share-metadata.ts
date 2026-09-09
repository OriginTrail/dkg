import { isEntityPredicate, isSafeIri } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';
import { isWorkspaceKnowledgeAssetHeadSubject, workspaceOperationPublicSliceSubject, workspaceOperationSubject } from './workspace-metadata-subjects.js';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const COMMON_FIELDS = [
  `${DKG}contextGraphId`, `${DKG}shareOperationId`, `${DKG}subGraphName`,
  `${DKG}publisherPeerId`, `${DKG}publishedAt`, 'http://www.w3.org/ns/prov#wasAttributedTo',
];
const SLICE_FIELDS = new Set([...COMMON_FIELDS, `${DKG}publicSliceRootEntity`,
  `${DKG}publicQuadsDigest`, `${DKG}publicQuadsCount`, `${DKG}publicSnapshotRef`, `${DKG}publicSnapshotGraph`]);
const OPERATION_FIELDS = new Set([...COMMON_FIELDS, RDF_TYPE]);

/** Local finalization caches are annotations, never peer authority for a snapshot. */
export const SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE = `${DKG}snapshotMerkleRoot`;
export const SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE = `${DKG}snapshotContentDigest`;
const OPERATION_MEMOS = new Set([SWM_SNAPSHOT_MERKLE_ROOT_PREDICATE, SWM_SNAPSHOT_CONTENT_DIGEST_PREDICATE]);

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
    const other = { kind: 'other', graph, subject } as const;
    if (isWorkspaceKnowledgeAssetHeadSubject(subject)) {
      const claims = rows.filter(row => row.predicate === `${DKG}shareOperationId`)
        .map(row => operationSubject(contextGraphId, parseRdfLiteralTerm(row.object)?.value ?? row.object))
        .filter((value): value is string => value !== undefined);
      return { kind: 'head', graph, subject, operationSubjects: [...new Set(claims)] };
    }
    const cg = literal(rows, `${DKG}contextGraphId`);
    const operationId = literal(rows, `${DKG}shareOperationId`);
    const subGraphName = literal(rows, `${DKG}subGraphName`);
    if (cg !== contextGraphId || !operationId
        || (subGraphName === undefined && rows.some(row => row.predicate === `${DKG}subGraphName`))) return other;
    const operation = operationSubject(cg, operationId);
    if (!operation) return other;
    const root = oneValue(rows, `${DKG}publicSliceRootEntity`);
    const digest = literal(rows, `${DKG}publicQuadsDigest`);
    const count = literal(rows, `${DKG}publicQuadsCount`);
    const explicitRef = literal(rows, `${DKG}publicSnapshotRef`);
    const ref = explicitRef ?? digest;
    const validRef = explicitRef !== undefined || !rows.some(row => row.predicate === `${DKG}publicSnapshotRef`);
    if (root && isSafeIri(root) && digest && ref && validRef && count !== undefined
        && /^\d+$/.test(count) && Number.isSafeInteger(Number(count))
        && rows.every(row => SLICE_FIELDS.has(row.predicate))
        && subject === workspaceOperationPublicSliceSubject(cg, operationId, root, subGraphName)) {
      return { kind: 'slice', ref, graph, subject, rootEntity: root, operationSubject: operation, subGraphName, metadataRows: rows };
    }
    if (subject !== operation || oneValue(rows, RDF_TYPE) !== `${DKG}WorkspaceOperation`
        || !rows.every(row => OPERATION_FIELDS.has(row.predicate) || OPERATION_MEMOS.has(row.predicate) || isEntityPredicate(row.predicate))) return other;
    const rootEntities = [...new Set(rows.filter(row => isEntityPredicate(row.predicate)).map(row => row.object))];
    if (rootEntities.length === 0 || !rootEntities.every(isSafeIri)) return other;
    return { kind: 'operation', graph, subject, rootEntities, subGraphName,
      metadataRows: rows.filter(row => !OPERATION_MEMOS.has(row.predicate)) };
  });
}
