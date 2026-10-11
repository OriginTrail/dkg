// SPDX-License-Identifier: Apache-2.0

import { DKG_ENTITY, DKG_ROOT_ENTITY_LEGACY } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

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
export const SWM_WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
export const SWM_HEAD_SUFFIX = '#dkg-swm-head';
export const SWM_PREDICATES = {
  ...ENTITY_SHARE_METADATA_PREDICATES,
  entity: DKG_ENTITY,
  contentScopeVersion: `${DKG}contentScopeVersion`, kaUal: `${DKG}kaUal`,
  assertionVersion: `${DKG}assertionVersion`, assertionGraph: `${DKG}assertionGraph`,
  privateTripleCount: `${DKG}privateTripleCount`, privateMerkleRoot: `${DKG}privateMerkleRoot`,
  accessPolicy: `${DKG}accessPolicy`, allowedPeer: `${DKG}allowedPeer`,
  publicStagedQuads: `${DKG}publicStagedQuads`, workspaceOwner: `${DKG}workspaceOwner`,
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
/** Admission retains historical inline payloads; readiness requires a snapshot reference. */
export type SwmRecordReadPolicy = 'admission' | 'snapshot-readiness';

const READ_PREDICATES: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries(SWM_READ_FIELDS)
  .map(([role, fields]) => [role, new Set(Object.values(fields))]));

export function isSwmRecordRowAllowed(role: SwmRecordRole, row: Quad, policy: SwmRecordReadPolicy = 'admission'): boolean {
  return !(policy === 'snapshot-readiness' && row.predicate === P.publicStagedQuads)
    && READ_PREDICATES.get(role)!.has(row.predicate)
    && (row.predicate !== P.type || row.object === SWM_WORKSPACE_OPERATION);
}

/** Preserve row order and duplicates while excluding fields from other roles. */
export function selectSwmRecordRows(role: SwmRecordRole, rows: readonly Quad[]): Quad[] {
  return rows.filter(row => isSwmRecordRowAllowed(role, row));
}
