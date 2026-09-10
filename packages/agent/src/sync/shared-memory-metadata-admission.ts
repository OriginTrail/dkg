// SPDX-License-Identifier: Apache-2.0

import { GRAPH_KA_CONTENT_SCOPE_VERSION, contextGraphSharedMemoryMetaUri, isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import {
  SWM_HEAD_SUFFIX, SWM_PREDICATES as P, SWM_WORKSPACE_OPERATION,
  decodeSwmPublicSliceSubject, selectSwmRecordRows, swmKnowledgeAssetHeadSubject, swmOperationSubject,
} from '@origintrail-official/dkg-publisher';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';

export type SharedMemoryAdmissionScope =
  | { readonly kind: 'allGraphs' }
  | { readonly kind: 'context'; readonly contextGraphId: string; readonly registeredSubGraphNames: ReadonlySet<string> };

export interface AdmittedSwmRecord {
  readonly subject: string;
  readonly metaGraph: string;
  readonly dataGraph: string;
  readonly rows: readonly Quad[];
}

interface OperationIdentity {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly subGraphName?: string;
}

export interface AdmittedLegacySwmOperation extends AdmittedSwmRecord, OperationIdentity {
  readonly roots: ReadonlySet<string>;
  readonly published: boolean;
  readonly creator?: string;
}

export interface AdmittedSharedMemoryMetadata {
  /** Original order and duplicates, with no synthesized identity rows. */
  readonly metadata: Quad[];
  readonly heads: readonly AdmittedSwmRecord[];
  readonly graphOperations: ReadonlyMap<string, AdmittedSwmRecord>;
  readonly legacyOperations: ReadonlyMap<string, AdmittedLegacySwmOperation>;
  readonly legacyRoots: ReadonlyMap<string, ReadonlySet<string>>;
  readonly ownership: Array<{ dataGraph: string; entity: string; creator: string }>;
  /** Descriptor parsing must fail closed on a recognizable but invalid head. */
  readonly rejectedHeads: ReadonlyArray<{ subject: string; metaGraph: string }>;
}

export function swmRecordKey(metaGraph: string, subject: string): string {
  return `${metaGraph}\0${subject}`;
}

/** The same graph scope controls metadata admission and legacy data selection. */
function swmDataGraphFromMetaGraph(metaGraph: string, scope: SharedMemoryAdmissionScope): string | undefined {
  const prefix = 'did:dkg:context-graph:';
  const suffix = '/_shared_memory_meta';
  if (!isSafeIri(metaGraph) || !metaGraph.startsWith(prefix) || !metaGraph.endsWith(suffix)
    || metaGraph.length <= prefix.length + suffix.length) return undefined;
  if (scope.kind === 'allGraphs') return metaGraph.slice(0, -'_meta'.length);
  const root = `did:dkg:context-graph:${scope.contextGraphId}`;
  if (metaGraph === `${root}${suffix}`) return metaGraph.slice(0, -'_meta'.length);
  if (!metaGraph.startsWith(`${root}/`)) return undefined;
  const name = metaGraph.slice(root.length + 1, -suffix.length);
  return validateSubGraphName(name).valid && scope.registeredSubGraphNames.has(name)
    ? metaGraph.slice(0, -'_meta'.length) : undefined;
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

function matchesLiteral(rows: readonly Quad[], predicate: string, expected: string | undefined, required = false): boolean {
  if (!rows.some(row => row.predicate === predicate)) return !required;
  const value = literalValue(rows, predicate);
  return value !== undefined && value === expected;
}

function legacyRoot(object: string): string | undefined {
  const root = object.startsWith('"') ? parseRdfLiteralTerm(object)?.value : object;
  return root && isSafeIri(root) && !root.endsWith(SWM_HEAD_SUFFIX)
    && !root.startsWith('urn:dkg:share:') && !root.startsWith('urn:dkg:public-stage:') ? root : undefined;
}

/** Recover the old operation identity from its subject and matching graph lane. */
function operationIdentity(subject: string, metaGraph: string): OperationIdentity | undefined {
  const graphId = metaGraph.slice('did:dkg:context-graph:'.length, -'/_shared_memory_meta'.length);
  const candidates: Array<{ contextGraphId: string; subGraphName?: string }> = [{ contextGraphId: graphId }];
  const slash = graphId.lastIndexOf('/');
  if (slash > 0 && validateSubGraphName(graphId.slice(slash + 1)).valid) {
    candidates.push({ contextGraphId: graphId.slice(0, slash), subGraphName: graphId.slice(slash + 1) });
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
    if (row.predicate === P.publisherPeerId) {
      peer = row.object.startsWith('"') ? parseRdfLiteralTerm(row.object)?.value : row.object;
    } else if (row.predicate === P.wasAttributedTo && row.object.startsWith('"')) {
      legacy = parseRdfLiteralTerm(row.object)?.value;
    }
  }
  return peer ?? legacy;
}

/**
 * Canonical shape boundary for metadata parsing, legacy data selection, and
 * persistence. Historical identity is decoded only from canonical subjects;
 * modern graph operations require their explicit identity/version envelope.
 * This admission establishes protocol shape, not writer authority.
 */
export function admitSharedMemoryMetadata(metaQuads: readonly Quad[], scope: SharedMemoryAdmissionScope): AdmittedSharedMemoryMetadata {
  const graphs = new Map<string, Map<string, Quad[]>>();
  const rejectedHeads = new Map<string, { subject: string; metaGraph: string }>();
  for (const quad of metaQuads) {
    if (!isSafeIri(quad.subject) || swmDataGraphFromMetaGraph(quad.graph, scope) === undefined) {
      if (quad.subject.endsWith(SWM_HEAD_SUFFIX)) rejectedHeads.set(swmRecordKey(quad.graph, quad.subject), { subject: quad.subject, metaGraph: quad.graph });
      continue;
    }
    let subjects = graphs.get(quad.graph);
    if (!subjects) { subjects = new Map(); graphs.set(quad.graph, subjects); }
    const rows = subjects.get(quad.subject);
    if (rows) rows.push(quad); else subjects.set(quad.subject, [quad]);
  }
  const admitted = new Set<Quad>();
  const heads: AdmittedSwmRecord[] = [];
  const graphOperations = new Map<string, AdmittedSwmRecord>();
  const legacyOperations = new Map<string, AdmittedLegacySwmOperation>();
  for (const [metaGraph, subjects] of graphs) {
    const dataGraph = metaGraph.slice(0, -'_meta'.length);
    const roots = new Set<string>();
    for (const [subject, rows] of subjects) {
      const record = { subject, metaGraph, dataGraph };
      if (subject.endsWith(SWM_HEAD_SUFFIX)) {
        try {
          if (swmKnowledgeAssetHeadSubject(subject.slice(0, -SWM_HEAD_SUFFIX.length)) !== subject) throw new Error('non-canonical head');
        } catch {
          rejectedHeads.set(swmRecordKey(metaGraph, subject), { subject, metaGraph });
          continue;
        }
        const selected = selectSwmRecordRows('headV2', rows);
        heads.push({ ...record, rows: selected });
        for (const row of selected) admitted.add(row);
        continue;
      }
      const identity = operationIdentity(subject, metaGraph);
      if (!identity || (scope.kind === 'context' && identity.contextGraphId !== scope.contextGraphId)
        || !rows.some(row => row.predicate === P.type && row.object === SWM_WORKSPACE_OPERATION)) continue;
      const modern = rows.some(row => row.predicate === P.contentScopeVersion);
      if (!matchesIdentity(rows, identity, modern)) continue;
      if (modern) {
        if (Number(literalValue(rows, P.contentScopeVersion)) !== GRAPH_KA_CONTENT_SCOPE_VERSION) continue;
        const selected = selectSwmRecordRows('graphOperationV2', rows);
        graphOperations.set(swmRecordKey(metaGraph, subject), { ...record, rows: selected });
        for (const row of selected) admitted.add(row);
      } else {
        if (rows.some(row => row.predicate === P.kaUal || row.predicate === P.assertionVersion)) continue;
        const members = new Set<string>();
        const selected = selectSwmRecordRows('legacyOperationV1', rows).filter(row => {
          if (row.predicate !== P.rootEntity && row.predicate !== P.entity) return true;
          const root = legacyRoot(row.object);
          if (!root) return false;
          members.add(root); roots.add(root); return true;
        });
        legacyOperations.set(swmRecordKey(metaGraph, subject), {
          ...record, ...identity, rows: selected, roots: members,
          published: selected.some(row => row.predicate === P.publishedAt),
          creator: operationCreator(selected),
        });
        for (const row of selected) admitted.add(row);
      }
    }
    for (const [subject, rows] of subjects) {
      if (roots.has(subject)) {
        for (const row of selectSwmRecordRows('ownershipV1', rows)) admitted.add(row);
      }
      const identity = decodeSwmPublicSliceSubject(subject);
      if (!identity || contextGraphSharedMemoryMetaUri(identity.contextGraphId, identity.subGraphName) !== metaGraph
        || !matchesIdentity(rows, identity, false)) continue;
      const operation = legacyOperations.get(swmRecordKey(metaGraph, swmOperationSubject(identity.contextGraphId, identity.shareOperationId)));
      if (!operation?.roots.has(identity.rootEntity)) continue;
      if (rows.some(row => row.predicate === P.publicSliceRootEntity && legacyRoot(row.object) !== identity.rootEntity)) continue;
      for (const row of selectSwmRecordRows('publicSliceV1', rows)) admitted.add(row);
    }
  }
  const metadata: Quad[] = [];
  const legacyRoots = new Map<string, Set<string>>();
  const ownership = new Map<string, { dataGraph: string; entity: string; creator: string }>();
  for (const row of metaQuads) {
    if (!admitted.has(row)) continue;
    metadata.push(row);
    if (row.predicate !== P.rootEntity && row.predicate !== P.entity) continue;
    const operation = legacyOperations.get(swmRecordKey(row.graph, row.subject));
    if (!operation?.published) continue;
    const root = legacyRoot(row.object)!;
    let allowed = legacyRoots.get(operation.dataGraph);
    if (!allowed) { allowed = new Set(); legacyRoots.set(operation.dataGraph, allowed); }
    allowed.add(root);
    const key = swmRecordKey(operation.dataGraph, root);
    if (operation.creator && !ownership.has(key)) ownership.set(key, { dataGraph: operation.dataGraph, entity: root, creator: operation.creator });
  }
  return { metadata, heads, graphOperations, legacyOperations, legacyRoots, ownership: [...ownership.values()], rejectedHeads: [...rejectedHeads.values()] };
}
