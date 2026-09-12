// SPDX-License-Identifier: Apache-2.0

import { GRAPH_KA_CONTENT_SCOPE_VERSION, contextGraphSharedMemoryMetaUri, isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import {
  SWM_HEAD_SUFFIX, SWM_PREDICATES as P, SWM_WORKSPACE_OPERATION,
  decodeSwmPublicSliceSubject, isSwmRecordRowAllowed, swmKnowledgeAssetHeadSubject, swmOperationSubject,
  type SwmRecordRole,
} from '@origintrail-official/dkg-publisher';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';

export type SharedMemoryContextScope = {
  readonly kind: 'context';
  readonly contextGraphId: string;
  readonly registeredSubGraphNames: ReadonlySet<string>;
};
export type SharedMemoryAdmissionScope = {
  readonly kind: 'allGraphs';
  readonly contextGraphId?: never;
  readonly registeredSubGraphNames?: never;
} | SharedMemoryContextScope;
/** A context-bound lane is resolved during admission, including slash-shaped IDs. */
export type SwmMetadataLane =
  | Readonly<{ kind: 'allGraphs' }>
  | Readonly<{ kind: 'context'; contextGraphId: string; subGraphName?: string }>;

export interface IndexedSwmRow { readonly sourceIndex: number; readonly quad: Quad }
export interface SwmRecordSource {
  readonly subject: string;
  readonly metaGraph: string;
  readonly dataGraph: string;
  readonly lane: SwmMetadataLane;
  readonly rows: readonly IndexedSwmRow[];
}
export type AdmittedSwmRecord = SwmRecordSource;
interface OperationIdentity {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly subGraphName?: string;
}
export interface AdmittedLegacySwmOperation extends AdmittedSwmRecord, OperationIdentity {
  readonly role: 'legacyOperation';
  readonly roots: ReadonlySet<string>;
  readonly members: ReadonlyArray<{ sourceIndex: number; root: string }>;
  readonly published: boolean;
  readonly creator?: string;
}
export type AdmittedSwmHead = AdmittedSwmRecord & { readonly role: 'head' };
export interface GraphSwmOperationEnvelope extends OperationIdentity {
  readonly contentScopeVersion: typeof GRAPH_KA_CONTENT_SCOPE_VERSION;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly publishedAt: string;
  readonly publisherPeerId: string;
}
export type AdmittedGraphSwmOperation = AdmittedSwmRecord & {
  readonly role: 'graphOperation';
  readonly envelope: GraphSwmOperationEnvelope;
};
export type DecodedSwmRecord = AdmittedLegacySwmOperation | AdmittedSwmHead | AdmittedGraphSwmOperation
  | (AdmittedSwmRecord & { readonly role: 'publicSlice' | 'ownership' });
export interface SwmRecordRejection {
  readonly role: 'rejected';
  readonly recordRole: 'head' | 'operation' | 'publicSlice';
  readonly reason: 'outOfScope' | 'unsafeSubject' | 'nonCanonicalSubject' | 'identityMismatch'
    | 'unsupportedVersion' | 'modernFieldsWithoutVersion' | 'missingLegacyRoot';
  readonly subject: string;
  readonly metaGraph: string;
}

export function swmRecordKey(metaGraph: string, subject: string): string {
  return `${metaGraph}\0${subject}`;
}

/** Graph scope is checked once, before any record decoder sees a source. */
function swmGraphIdentityFromMetaGraph(metaGraph: string, scope: SharedMemoryAdmissionScope):
  Pick<SwmRecordSource, 'dataGraph' | 'lane'> | undefined {
  const prefix = 'did:dkg:context-graph:';
  const suffix = '/_shared_memory_meta';
  if (!isSafeIri(metaGraph) || !metaGraph.startsWith(prefix) || !metaGraph.endsWith(suffix)
    || metaGraph.length <= prefix.length + suffix.length) return undefined;
  const dataGraph = metaGraph.slice(0, -'_meta'.length);
  if (scope.kind === 'allGraphs') return { dataGraph, lane: { kind: 'allGraphs' } };
  const root = `did:dkg:context-graph:${scope.contextGraphId}`;
  if (metaGraph === `${root}${suffix}`) {
    return { dataGraph, lane: { kind: 'context', contextGraphId: scope.contextGraphId } };
  }
  if (!metaGraph.startsWith(`${root}/`)) return undefined;
  const name = metaGraph.slice(root.length + 1, -suffix.length);
  return validateSubGraphName(name).valid && scope.registeredSubGraphNames.has(name)
    ? { dataGraph, lane: { kind: 'context', contextGraphId: scope.contextGraphId, subGraphName: name } }
    : undefined;
}

/** A suffix alone is a valid user IRI, not evidence of a protocol head. */
export function hasSwmHeadEnvelope(source: Pick<SwmRecordSource, 'subject' | 'rows'>): boolean {
  return source.subject.endsWith(SWM_HEAD_SUFFIX)
    && source.rows.some(({ quad }) => isSwmRecordRowAllowed('headV2', quad));
}

export function indexSwmMetadata(quads: readonly Quad[], scope: SharedMemoryAdmissionScope): {
  sources: SwmRecordSource[]; rejections: SwmRecordRejection[];
} {
  const groups = new Map<string, { subject: string; metaGraph: string; rows: IndexedSwmRow[] }>();
  quads.forEach((quad, sourceIndex) => {
    const key = JSON.stringify([quad.graph, quad.subject]);
    let group = groups.get(key);
    if (!group) { group = { subject: quad.subject, metaGraph: quad.graph, rows: [] }; groups.set(key, group); }
    group.rows.push({ sourceIndex, quad });
  });
  const sources: SwmRecordSource[] = [];
  const rejections: SwmRecordRejection[] = [];
  for (const group of groups.values()) {
    const graphIdentity = swmGraphIdentityFromMetaGraph(group.metaGraph, scope);
    if (graphIdentity !== undefined && isSafeIri(group.subject)) sources.push({ ...group, ...graphIdentity });
    else if (hasSwmHeadEnvelope(group)) rejections.push({
      role: 'rejected', recordRole: 'head', subject: group.subject, metaGraph: group.metaGraph,
      reason: graphIdentity === undefined ? 'outOfScope' : 'unsafeSubject',
    });
  }
  return { sources, rejections };
}

function recordRows(source: SwmRecordSource, rows: readonly IndexedSwmRow[]): AdmittedSwmRecord {
  return { subject: source.subject, metaGraph: source.metaGraph, dataGraph: source.dataGraph, lane: source.lane, rows };
}
export function swmRecordQuads(record: Pick<AdmittedSwmRecord, 'rows'>): readonly Quad[] {
  return record.rows.map(row => row.quad);
}
export function swmRecordSourceIndices(record: Pick<AdmittedSwmRecord, 'rows'>): readonly number[] {
  return record.rows.map(row => row.sourceIndex);
}
function selectRows(source: SwmRecordSource, role: SwmRecordRole): IndexedSwmRow[] {
  return source.rows.filter(({ quad }) => isSwmRecordRowAllowed(role, quad));
}
function rejection(source: SwmRecordSource, recordRole: SwmRecordRejection['recordRole'], reason: SwmRecordRejection['reason']): SwmRecordRejection {
  return { role: 'rejected', recordRole, reason, subject: source.subject, metaGraph: source.metaGraph };
}
function literalValue(rows: readonly Quad[], predicate: string): string | undefined {
  const values = new Set<string>();
  for (const row of rows) {
    if (row.predicate !== predicate) continue;
    const literal = parseRdfLiteralTerm(row.object);
    if (!literal) return undefined;
    values.add(literal.value);
  }
  return values.size === 1 ? [...values][0] : undefined;
}
function singleObject(rows: readonly Quad[], predicate: string): string | undefined {
  const values = new Set(rows.filter(row => row.predicate === predicate).map(row => row.object));
  return values.size === 1 ? [...values][0] : undefined;
}
function singleLiteralValue(rows: readonly Quad[], predicate: string): string | undefined {
  const object = singleObject(rows, predicate);
  return object === undefined ? undefined : parseRdfLiteralTerm(object)?.value;
}
function matchesLiteral(rows: readonly Quad[], predicate: string, expected: string | undefined, required = false): boolean {
  if (!rows.some(row => row.predicate === predicate)) return !required;
  const value = literalValue(rows, predicate);
  return value !== undefined && value === expected;
}
function legacyRoot(object: string): string | undefined {
  const root = object.startsWith('"') ? parseRdfLiteralTerm(object)?.value : object;
  return root && isSafeIri(root) ? root : undefined;
}
function operationIdentity(subject: string, source: Pick<SwmRecordSource, 'metaGraph' | 'lane'>): OperationIdentity | undefined {
  const candidates: Array<{ contextGraphId: string; subGraphName?: string }> = [];
  if (source.lane.kind === 'context') {
    candidates.push(source.lane);
  } else {
    // Broad persistence has no requested context to disambiguate a slash-shaped
    // root from a named lane; the operation subject supplies that identity.
    const graphId = source.metaGraph.slice('did:dkg:context-graph:'.length, -'/_shared_memory_meta'.length);
    candidates.push({ contextGraphId: graphId });
    const slash = graphId.lastIndexOf('/');
    if (slash > 0 && validateSubGraphName(graphId.slice(slash + 1)).valid) {
      candidates.push({ contextGraphId: graphId.slice(0, slash), subGraphName: graphId.slice(slash + 1) });
    }
  }
  for (const candidate of candidates) {
    const prefix = `urn:dkg:share:${candidate.contextGraphId}:`;
    if (!subject.startsWith(prefix)) continue;
    const shareOperationId = subject.slice(prefix.length);
    if (!shareOperationId || swmOperationSubject(candidate.contextGraphId, shareOperationId) !== subject) continue;
    return { ...candidate, shareOperationId };
  }
  return undefined;
}
function matchesIdentity(rows: readonly Quad[], identity: OperationIdentity, required: boolean): boolean {
  return matchesLiteral(rows, P.contextGraphId, identity.contextGraphId, required)
    && matchesLiteral(rows, P.shareOperationId, identity.shareOperationId, required)
    && matchesLiteral(rows, P.subGraphName, identity.subGraphName, required && identity.subGraphName !== undefined);
}
function operationCreator(rows: readonly Quad[]): string | undefined {
  let peer: string | undefined;
  let legacy: string | undefined;
  for (const row of rows) {
    if (row.predicate === P.publisherPeerId) peer = row.object.startsWith('"') ? parseRdfLiteralTerm(row.object)?.value : row.object;
    else if (row.predicate === P.wasAttributedTo && row.object.startsWith('"')) legacy = parseRdfLiteralTerm(row.object)?.value;
  }
  return peer ?? legacy;
}

export function decodeSwmOperation(source: SwmRecordSource):
  AdmittedLegacySwmOperation | AdmittedGraphSwmOperation | SwmRecordRejection | undefined {
  if (!source.subject.startsWith('urn:dkg:share:')) return undefined;
  const rows = source.rows.map(row => row.quad);
  if (!rows.some(row => row.predicate === P.type && row.object === SWM_WORKSPACE_OPERATION)) return undefined;
  const identity = operationIdentity(source.subject, source);
  if (!identity) return rejection(source, 'operation', 'nonCanonicalSubject');
  const modern = rows.some(row => row.predicate === P.contentScopeVersion);
  if (!matchesIdentity(rows, identity, modern)) return rejection(source, 'operation', 'identityMismatch');
  if (modern) {
    const contentScopeVersion = Number(singleLiteralValue(rows, P.contentScopeVersion));
    if (contentScopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) return rejection(source, 'operation', 'unsupportedVersion');
    const kaUal = singleObject(rows, P.kaUal);
    const assertionVersion = singleLiteralValue(rows, P.assertionVersion);
    const publishedAt = singleLiteralValue(rows, P.publishedAt);
    const publisherPeerId = singleLiteralValue(rows, P.publisherPeerId)?.trim();
    if (!kaUal || !assertionVersion || !publishedAt || !publisherPeerId) {
      return rejection(source, 'operation', 'identityMismatch');
    }
    return {
      ...recordRows(source, selectRows(source, 'graphOperationV2')),
      role: 'graphOperation',
      envelope: {
        ...identity, contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
        kaUal, assertionVersion, publishedAt, publisherPeerId,
      },
    };
  }
  if (rows.some(row => row.predicate === P.kaUal || row.predicate === P.assertionVersion)) return rejection(source, 'operation', 'modernFieldsWithoutVersion');
  const members: Array<{ sourceIndex: number; root: string }> = [];
  const selected = selectRows(source, 'legacyOperationV1').filter(({ quad, sourceIndex }) => {
    if (quad.predicate !== P.rootEntity && quad.predicate !== P.entity) return true;
    const root = legacyRoot(quad.object);
    if (!root) return false;
    members.push({ sourceIndex, root }); return true;
  });
  const record = recordRows(source, selected);
  const admittedRows = swmRecordQuads(record);
  return { ...record, ...identity, role: 'legacyOperation', members, roots: new Set(members.map(member => member.root)),
    published: admittedRows.some(row => row.predicate === P.publishedAt), creator: operationCreator(admittedRows) };
}

export function decodeSwmHead(source: SwmRecordSource): AdmittedSwmHead | SwmRecordRejection | undefined {
  if (!hasSwmHeadEnvelope(source)) return undefined;
  try {
    if (swmKnowledgeAssetHeadSubject(source.subject.slice(0, -SWM_HEAD_SUFFIX.length)) !== source.subject) return rejection(source, 'head', 'nonCanonicalSubject');
  } catch { return rejection(source, 'head', 'nonCanonicalSubject'); }
  return { ...recordRows(source, selectRows(source, 'headV2')), role: 'head' };
}

export function decodeSwmPublicSlice(source: SwmRecordSource, operations: ReadonlyMap<string, AdmittedLegacySwmOperation>, isLegacyRoot: boolean):
  (AdmittedSwmRecord & { readonly role: 'publicSlice' }) | SwmRecordRejection | undefined {
  // A user root carrying only ownership fields is not a snapshot record. Keep
  // historical partial slice rows on other canonical subjects readable.
  if (isLegacyRoot && !source.rows.some(({ quad }) => isSwmRecordRowAllowed('publicSliceV1', quad)
    && !isSwmRecordRowAllowed('ownershipV1', quad))) return undefined;
  const identity = decodeSwmPublicSliceSubject(source.subject);
  if (!identity) return undefined;
  const rows = source.rows.map(row => row.quad);
  if (contextGraphSharedMemoryMetaUri(identity.contextGraphId, identity.subGraphName) !== source.metaGraph
    || !matchesIdentity(rows, identity, false)) return rejection(source, 'publicSlice', 'identityMismatch');
  const operation = operations.get(swmRecordKey(source.metaGraph, swmOperationSubject(identity.contextGraphId, identity.shareOperationId)));
  if (!operation?.roots.has(identity.rootEntity)) return rejection(source, 'publicSlice', 'missingLegacyRoot');
  if (rows.some(row => row.predicate === P.publicSliceRootEntity && legacyRoot(row.object) !== identity.rootEntity)) return rejection(source, 'publicSlice', 'identityMismatch');
  return { ...recordRows(source, selectRows(source, 'publicSliceV1')), role: 'publicSlice' };
}

export function decodeSwmOwnership(source: SwmRecordSource, isLegacyRoot: boolean):
  (AdmittedSwmRecord & { readonly role: 'ownership' }) | undefined {
  if (!isLegacyRoot) return undefined;
  const rows = selectRows(source, 'ownershipV1');
  return rows.length ? { ...recordRows(source, rows), role: 'ownership' } : undefined;
}

/** Preserve the established recovery and cross-store identity literal semantics. */
export function swmRecoveryLiteralValue(value: string): string {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[-A-Za-z0-9]+|\^\^<[^>]+>)?$/);
  if (!match) return value;
  return match[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
