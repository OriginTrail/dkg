// SPDX-License-Identifier: Apache-2.0

import { SWM_PREDICATES as P, SWM_WORKSPACE_OPERATION } from './swm-metadata-vocabulary.js';
export { SWM_PREDICATES, SWM_WORKSPACE_OPERATION, SWM_HEAD_SUFFIX, SWM_READ_FIELDS,
  isSwmRecordRowAllowed, selectSwmRecordRows, type SwmRecordRole, type SwmRecordReadPolicy,
} from './swm-metadata-vocabulary.js';
export { decodeSwmOperationIdentity, matchesSwmMetadataIdentity, swmMetadataLiteralValue,
  type SwmOperationIdentity, type SwmMetadataIdentityPolicy,
} from './swm-metadata-identity.js';
export {
  workspaceOperationSubject as swmOperationSubject,
  workspaceKnowledgeAssetHeadSubject as swmKnowledgeAssetHeadSubject,
  workspaceOperationPublicSliceSubject as swmPublicSliceSubject,
  decodeWorkspaceOperationPublicSliceSubject as decodeSwmPublicSliceSubject,
} from './workspace-metadata-subjects.js';
import type { Quad } from '@origintrail-official/dkg-storage';

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

type CurrentFieldKeys<T> = { [K in keyof T]: Exclude<T[K], undefined> extends never ? never : K }[keyof T];
interface WriteTermsByRole {
  legacyOperationV1: LegacySwmOperationTerms;
  headV2: SwmHeadTerms;
  publicSliceV1: SwmPublicSliceTerms;
  ownershipV1: SwmOwnershipTerms;
  graphOperationHeader: GraphSwmOperationHeaderTerms;
  graphSnapshotFragment: GraphSwmSnapshotFragmentTerms;
}
type CompleteWriteFields = {
  [Role in keyof WriteTermsByRole]: Record<Extract<CurrentFieldKeys<WriteTermsByRole[Role]>, string>, true>;
};
const CURRENT_OPERATION_FIELDS = {
  contextGraphId: true, shareOperationId: true, publisherPeerId: true,
  wasAttributedTo: true, publishedAt: true, subGraphName: true,
} as const;
// Exhaustive mapped contracts catch missing or additional writer fields at compilation.
// Historical read-only aliases are excluded by their optional-never term types.
const WRITE_FIELDS = {
  legacyOperationV1: { ...CURRENT_OPERATION_FIELDS, type: true, rootEntity: true },
  headV2: { contentScopeVersion: true, kaUal: true, assertionVersion: true, assertionGraph: true, shareOperationId: true },
  publicSliceV1: { ...CURRENT_OPERATION_FIELDS, publicSliceRootEntity: true, publicQuadsDigest: true, publicQuadsCount: true, publicSnapshotGraph: true },
  ownershipV1: { workspaceOwner: true },
  graphOperationHeader: { ...CURRENT_OPERATION_FIELDS, type: true, contentScopeVersion: true, kaUal: true, assertionVersion: true,
    publicQuadsCount: true, privateTripleCount: true, privateMerkleRoot: true, accessPolicy: true, allowedPeer: true },
  graphSnapshotFragment: { publicQuadsDigest: true, publicSnapshotGraph: true },
} as const satisfies CompleteWriteFields;

/** Private serializer: preserve caller order and reject fields outside the writer contract. */
function emitTerms(role: keyof typeof WRITE_FIELDS, subject: string, graph: string, terms: object): Quad[] {
  const rows: Quad[] = [];
  const fields = WRITE_FIELDS[role];
  for (const [field, value] of Object.entries(terms) as Array<[keyof typeof P, string | readonly string[] | undefined]>) {
    if (!Object.hasOwn(fields, field)) throw new Error(`Unknown ${role} field: ${field}`);
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
