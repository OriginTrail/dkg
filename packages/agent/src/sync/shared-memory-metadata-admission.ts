// SPDX-License-Identifier: Apache-2.0

import { GRAPH_KA_CONTENT_SCOPE_VERSION, createGraphKnowledgeAssetScope, isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ATTRIBUTION = 'http://www.w3.org/ns/prov#wasAttributedTo';
const WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;
const HEAD_SUFFIX = '#dkg-swm-head';
const COMMON = [
  'contextGraphId', 'shareOperationId', 'publisherPeerId', 'publishedAt', 'subGraphName',
].map((name) => `${DKG}${name}`);
const ROOT_MEMBERS = new Set([`${DKG}rootEntity`, `${DKG}entity`]);
const LEGACY_OPERATION = new Set([...COMMON, RDF_TYPE, ATTRIBUTION, ...ROOT_MEMBERS]);
const GRAPH_OPERATION = new Set([
  ...COMMON, RDF_TYPE, ATTRIBUTION,
  ...[
    'contentScopeVersion', 'kaUal', 'assertionVersion', 'publicQuadsCount',
    'privateTripleCount', 'privateMerkleRoot', 'accessPolicy', 'allowedPeer',
    'publicQuadsDigest', 'publicSnapshotGraph', 'publicSnapshotRef',
  ].map((name) => `${DKG}${name}`),
]);
const HEAD = new Set([
  'contentScopeVersion', 'kaUal', 'assertionVersion', 'assertionGraph', 'shareOperationId',
].map((name) => `${DKG}${name}`));
const PUBLIC_SLICE = new Set([
  ...COMMON, ATTRIBUTION,
  ...['publicSliceRootEntity', 'publicQuadsDigest', 'publicQuadsCount', 'publicSnapshotGraph', 'publicSnapshotRef']
    .map((name) => `${DKG}${name}`),
]);
const OWNERSHIP = new Set([`${DKG}workspaceOwner`, ATTRIBUTION]);

function selectPredicates(rows: readonly Quad[], predicates: ReadonlySet<string>): Quad[] {
  return rows.filter((row) => predicates.has(row.predicate)
    && (row.predicate !== RDF_TYPE || row.object === WORKSPACE_OPERATION));
}

/** A validated descriptor must not carry additional peer-supplied predicates. */
export function selectGraphScopedSwmDescriptorMetadata(
  headRows: readonly Quad[],
  operationRows: readonly Quad[],
): Quad[] {
  return [...selectPredicates(headRows, HEAD), ...selectPredicates(operationRows, GRAPH_OPERATION)];
}

/** Same graph admission used for metadata and its corresponding legacy data. */
export function swmDataGraphFromMetaGraph(
  metaGraph: string,
  contextGraphId: string | undefined,
  registeredSubGraphNames?: readonly string[],
): string | undefined {
  const prefix = 'did:dkg:context-graph:';
  const suffix = '/_shared_memory_meta';
  if (!metaGraph.startsWith(prefix) || !metaGraph.endsWith(suffix)) return undefined;
  if (contextGraphId === undefined) return metaGraph.slice(0, -'_meta'.length);
  const root = `${prefix}${contextGraphId}`;
  if (metaGraph === `${root}${suffix}`) return metaGraph.slice(0, -'_meta'.length);
  if (!metaGraph.startsWith(`${root}/`)) return undefined;
  const name = metaGraph.slice(root.length + 1, -suffix.length);
  return validateSubGraphName(name).valid && registeredSubGraphNames?.includes(name)
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

function isHeadSubject(subject: string): boolean {
  if (!subject.endsWith(HEAD_SUFFIX)) return false;
  const ual = subject.slice(0, -HEAD_SUFFIX.length);
  try { return createGraphKnowledgeAssetScope(ual, 1).ual === ual; } catch { return false; }
}

function isLegacyRoot(subject: string): boolean {
  return isSafeIri(subject) && !subject.endsWith(HEAD_SUFFIX)
    && !subject.startsWith('urn:dkg:share:') && !subject.startsWith('urn:dkg:public-stage:');
}

/**
 * Admit the SWM protocol's subject roles before data selection or persistence.
 * Unknown predicates and record types are dropped. Schema additions must be
 * added here with their producer and reader; legacy snapshot refs and member
 * aliases remain readable. This policy establishes shape, not writer authority.
 */
export function admitSharedMemoryMetadata(
  metaQuads: readonly Quad[],
  contextGraphId?: string,
  registeredSubGraphNames?: readonly string[],
): Quad[] {
  const graphs = new Map<string, Map<string, Quad[]>>();
  for (const quad of metaQuads) {
    if (!isSafeIri(quad.subject)
      || swmDataGraphFromMetaGraph(quad.graph, contextGraphId, registeredSubGraphNames) === undefined) continue;
    let subjects = graphs.get(quad.graph);
    if (!subjects) { subjects = new Map(); graphs.set(quad.graph, subjects); }
    const rows = subjects.get(quad.subject);
    if (rows) rows.push(quad); else subjects.set(quad.subject, [quad]);
  }
  const admitted = new Set<Quad>();
  for (const [graph, subjects] of graphs) {
    const roots = new Set<string>();
    const legacyOperations = new Map<string, Set<string>>();
    const scopes = new Map<string, { cg: string; id: string; subGraphName?: string }>();
    for (const [subject, rows] of subjects) {
      if (isHeadSubject(subject)) {
        for (const row of selectPredicates(rows, HEAD)) admitted.add(row);
        continue;
      }
      const cg = literalValue(rows, `${DKG}contextGraphId`);
      const id = literalValue(rows, `${DKG}shareOperationId`);
      const subGraphName = literalValue(rows, `${DKG}subGraphName`);
      if (!cg || !id || (contextGraphId !== undefined && cg !== contextGraphId)) continue;
      if (rows.some((row) => row.predicate === `${DKG}subGraphName`)
        && (!subGraphName || !validateSubGraphName(subGraphName).valid)) continue;
      if (graph !== `did:dkg:context-graph:${cg}${subGraphName ? `/${subGraphName}` : ''}/_shared_memory_meta`) continue;
      scopes.set(subject, { cg, id, subGraphName });
      if (subject !== `urn:dkg:share:${cg}:${id}`
        || !rows.some((row) => row.predicate === RDF_TYPE && row.object === WORKSPACE_OPERATION)) continue;
      const hasScopeVersion = rows.some((row) => row.predicate === `${DKG}contentScopeVersion`);
      if (hasScopeVersion) {
        if (Number(literalValue(rows, `${DKG}contentScopeVersion`)) !== GRAPH_KA_CONTENT_SCOPE_VERSION) continue;
        for (const row of selectPredicates(rows, GRAPH_OPERATION)) admitted.add(row);
      } else {
        // A partial or future graph-scoped operation must not gain legacy root
        // controls by losing its version marker.
        if (rows.some((row) => row.predicate === `${DKG}kaUal`
          || row.predicate === `${DKG}assertionVersion`)) continue;
        const members = new Set(rows.filter((row) => ROOT_MEMBERS.has(row.predicate)
          && isLegacyRoot(row.object)).map((row) => row.object));
        legacyOperations.set(subject, members);
        for (const root of members) roots.add(root);
        for (const row of selectPredicates(rows, LEGACY_OPERATION)) {
          if (!ROOT_MEMBERS.has(row.predicate) || members.has(row.object)) admitted.add(row);
        }
      }
    }
    for (const [subject, rows] of subjects) {
      if (roots.has(subject)) {
        for (const row of selectPredicates(rows, OWNERSHIP)) admitted.add(row);
      }
      const scope = scopes.get(subject);
      if (!scope) continue;
      const rootRows = rows.filter((row) => row.predicate === `${DKG}publicSliceRootEntity`);
      const root = rootRows[0]?.object;
      if (!root || rootRows.some((row) => row.object !== root)
        || !legacyOperations.get(`urn:dkg:share:${scope.cg}:${scope.id}`)?.has(root)) continue;
      const parts = [scope.cg, scope.subGraphName ?? '_', scope.id, root].map(encodeURIComponent);
      if (subject !== `urn:dkg:public-stage:${parts.join(':')}`) continue;
      for (const row of selectPredicates(rows, PUBLIC_SLICE)) admitted.add(row);
    }
  }
  return metaQuads.filter((quad) => admitted.has(quad));
}
