import { isEntityPredicate, isSafeIri } from '@origintrail-official/dkg-core';
import {
  isWorkspaceKnowledgeAssetHeadSubject,
  workspaceOperationPublicSliceSubject,
  workspaceOperationSubject,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripMetadataLiteral } from './metadata-literal.js';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ATTRIBUTION = 'http://www.w3.org/ns/prov#wasAttributedTo';
const COMMON_FIELDS = [
  `${DKG}contextGraphId`, `${DKG}shareOperationId`, `${DKG}subGraphName`,
  `${DKG}publisherPeerId`, `${DKG}publishedAt`, ATTRIBUTION,
];
const SLICE_FIELDS = new Set([
  ...COMMON_FIELDS, `${DKG}publicSliceRootEntity`, `${DKG}publicQuadsDigest`,
  `${DKG}publicQuadsCount`, `${DKG}publicSnapshotRef`, `${DKG}publicSnapshotGraph`,
]);
const OPERATION_FIELDS = new Set([...COMMON_FIELDS, RDF_TYPE]);

interface EntitySliceDescriptor {
  readonly ref: string;
  readonly subject: string;
  readonly graph: string;
  readonly rootEntity: string;
  readonly operationSubject: string;
  readonly subGraphName?: string;
  readonly metadataRows: readonly Quad[];
}

interface EntityOperationDescriptor {
  readonly subject: string;
  readonly graph: string;
  readonly rootEntities: readonly string[];
  readonly subGraphName?: string;
  readonly claimedByKnowledgeAssetHead: boolean;
  readonly metadataRows: readonly Quad[];
}

function oneValue(rows: readonly Quad[], predicate: string): string | undefined {
  const values = new Set(rows.filter(row => row.predicate === predicate).map(row => row.object));
  return values.size === 1 ? [...values][0] : undefined;
}

function literal(rows: readonly Quad[], predicate: string): string | undefined {
  const value = oneValue(rows, predicate);
  return value?.startsWith('"') ? stripMetadataLiteral(value) : undefined;
}

/**
 * Parse the entity metadata model once. Ref authority is independent of slice
 * recognition: a valid slice sharing its ref with a KA remains an unready root.
 * The requester consumes this plan without owning publisher URI/field rules.
 */
export function createEntitySliceRecoveryPlan(
  contextGraphId: string,
  metaQuads: readonly Quad[],
  sourcesByRef: ReadonlyMap<string, ReadonlySet<string>>,
): { refs: ReadonlySet<string>; metadataFor(readyRefs: ReadonlySet<string>): Quad[] } {
  // Provenance is collected only after graph-scoped parsing fails. Keep the
  // ordinary successful path free of a second metadata parse.
  if (sourcesByRef.size === 0) return { refs: new Set(), metadataFor: () => [] };
  const key = (graph: string, subject: string) => `${graph}\u0000${subject}`;
  const groups = new Map<string, Quad[]>();
  const refsBySubject = new Map<string, Set<string>>();
  for (const [ref, sources] of sourcesByRef) {
    for (const subject of sources) {
      const refs = refsBySubject.get(subject) ?? new Set<string>();
      refs.add(ref);
      refsBySubject.set(subject, refs);
    }
  }
  const headClaims = new Set<string>();
  for (const row of metaQuads) {
    const subjectKey = key(row.graph, row.subject);
    const rows = groups.get(subjectKey) ?? [];
    rows.push(row);
    groups.set(subjectKey, rows);
    if (isWorkspaceKnowledgeAssetHeadSubject(row.subject) && row.predicate === `${DKG}shareOperationId`) {
      // Include every candidate of an ambiguous head, rather than choosing one.
      const operationId = stripMetadataLiteral(row.object)?.trim();
      if (operationId) headClaims.add(key(row.graph, workspaceOperationSubject(contextGraphId, operationId)));
    }
  }

  const slices: EntitySliceDescriptor[] = [];
  const operations: EntityOperationDescriptor[] = [];
  const validSliceSources = new Map<string, boolean>();
  for (const rows of groups.values()) {
    const { graph, subject } = rows[0]!;
    const cg = literal(rows, `${DKG}contextGraphId`);
    const operationId = literal(rows, `${DKG}shareOperationId`);
    const root = oneValue(rows, `${DKG}publicSliceRootEntity`);
    const subGraphName = literal(rows, `${DKG}subGraphName`);
    const validSubGraph = subGraphName !== undefined || !rows.some(row => row.predicate === `${DKG}subGraphName`);
    const digest = literal(rows, `${DKG}publicQuadsDigest`);
    const count = literal(rows, `${DKG}publicQuadsCount`);
    const explicitRef = literal(rows, `${DKG}publicSnapshotRef`);
    const validExplicitRef = explicitRef !== undefined || !rows.some(row => row.predicate === `${DKG}publicSnapshotRef`);
    const sourceRefs = refsBySubject.get(subject);
    const isSlice = cg === contextGraphId && !!operationId && !!root && isSafeIri(root)
      && validSubGraph && validExplicitRef && !!digest && count !== undefined
      && /^\d+$/.test(count) && Number.isSafeInteger(Number(count))
      && sourceRefs?.size === 1
      && sourceRefs.has(explicitRef ?? digest)
      && rows.every(row => SLICE_FIELDS.has(row.predicate))
      && subject === workspaceOperationPublicSliceSubject(cg, operationId, root, subGraphName);
    validSliceSources.set(subject, (validSliceSources.get(subject) ?? true) && isSlice);
    if (isSlice) {
      slices.push({
        ref: [...sourceRefs][0]!, subject, graph, rootEntity: root,
        operationSubject: workspaceOperationSubject(cg, operationId), subGraphName, metadataRows: rows,
      });
    }
    if (cg !== contextGraphId || !operationId || !validSubGraph || subject !== workspaceOperationSubject(cg, operationId)
        || oneValue(rows, RDF_TYPE) !== `${DKG}WorkspaceOperation`
        || !rows.every(row => OPERATION_FIELDS.has(row.predicate) || isEntityPredicate(row.predicate))) continue;
    const rootEntities = [...new Set(rows.filter(row => isEntityPredicate(row.predicate)).map(row => row.object))];
    if (rootEntities.length === 0 || !rootEntities.every(isSafeIri)) continue;
    operations.push({ subject, graph, rootEntities, subGraphName, metadataRows: rows, claimedByKnowledgeAssetHead: headClaims.has(key(graph, subject)) });
  }
  const refs = new Set<string>();
  for (const [ref, sources] of sourcesByRef) {
    if (sources.size > 0 && [...sources].every(subject => validSliceSources.get(subject) === true)) refs.add(ref);
  }
  return {
    refs,
    metadataFor(readyRefs) {
      const readySlices = slices.filter(slice => refs.has(slice.ref) && readyRefs.has(slice.ref));
      const rows = readySlices.flatMap(slice => slice.metadataRows);
      for (const operation of operations) {
        if (operation.claimedByKnowledgeAssetHead) continue;
        const everyRootReady = operation.rootEntities.every(root => readySlices.some(slice =>
          slice.graph === operation.graph && slice.operationSubject === operation.subject
          && slice.subGraphName === operation.subGraphName && slice.rootEntity === root));
        if (everyRootReady) rows.push(...operation.metadataRows);
      }
      return rows;
    },
  };
}
