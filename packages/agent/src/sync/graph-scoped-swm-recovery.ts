import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import {
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { stripLiteral } from '../dkg-agent-utils.js';
import {
  distinctRdfObjects,
  optionalRdfLiteral,
  optionalRdfObject,
  requireRdfLiteral,
  requireRdfObject,
  requireRdfPositiveIntegerString,
  requireRdfSafeInteger,
} from './rdf-metadata.js';

const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;

const CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const KA_UAL = `${DKG}kaUal`;
const ASSERTION_VERSION = `${DKG}assertionVersion`;
const ASSERTION_GRAPH = `${DKG}assertionGraph`;
const SHARE_OPERATION_ID = `${DKG}shareOperationId`;
const CONTEXT_GRAPH_ID = `${DKG}contextGraphId`;
const PUBLIC_QUADS_DIGEST = `${DKG}publicQuadsDigest`;
const PUBLIC_QUADS_COUNT = `${DKG}publicQuadsCount`;
const PUBLIC_SNAPSHOT_REF = `${DKG}publicSnapshotRef`;
const PUBLIC_SNAPSHOT_GRAPH = `${DKG}publicSnapshotGraph`;
const PRIVATE_TRIPLE_COUNT = `${DKG}privateTripleCount`;
const PRIVATE_MERKLE_ROOT = `${DKG}privateMerkleRoot`;
const PUBLISHER_PEER_ID = `${DKG}publisherPeerId`;
const PUBLISHED_AT = `${DKG}publishedAt`;
const ACCESS_POLICY = `${DKG}accessPolicy`;
const ALLOWED_PEER = `${DKG}allowedPeer`;
const SUB_GRAPH_NAME = `${DKG}subGraphName`;
const HEAD_SUFFIX = '#dkg-swm-head';

/** Canonical responder pattern binding an untimestamped active head to its operation timestamp. */
export function graphScopedSwmHeadFreshnessPattern(): string {
  return `
            ?s <${CONTENT_SCOPE_VERSION}> ${GRAPH_KA_CONTENT_SCOPE_VERSION} ;
               <${KA_UAL}> ?headUal ;
               <${ASSERTION_VERSION}> ?headVersion ;
               <${SHARE_OPERATION_ID}> ?shareId .
            ?headOperation <${RDF_TYPE}> <${WORKSPACE_OPERATION}> ;
               <${CONTENT_SCOPE_VERSION}> ${GRAPH_KA_CONTENT_SCOPE_VERSION} ;
               <${KA_UAL}> ?headUal ;
               <${ASSERTION_VERSION}> ?headVersion ;
               <${SHARE_OPERATION_ID}> ?shareId ;
               <${PUBLISHED_AT}> ?ts .`;
}

/** Restrict graph-backed snapshot reads to the requested CG and admitted SWM lane. */
export function isGraphScopedSwmSnapshotGraph(params: {
  readonly contextGraphId: string;
  readonly snapshotGraph: string;
  readonly registeredSubGraphNames?: readonly string[];
}): boolean {
  const contextGraphComponent = encodeURIComponent(params.contextGraphId);
  const prefix = `did:dkg:context-graph:${contextGraphComponent}/_shared_memory_snapshots/`;
  if (!params.snapshotGraph.startsWith(prefix)) return false;
  const parts = params.snapshotGraph.slice(prefix.length).split('/');
  if (parts.length !== 3 || parts[2] !== 'ka' || !isCanonicalEncodedComponent(parts[1]!)) {
    return false;
  }
  const admittedLaneComponents = new Set([
    '_',
    ...(params.registeredSubGraphNames ?? []).map(encodeURIComponent),
  ]);
  return admittedLaneComponents.has(parts[0]!);
}

export interface GraphScopedSwmRecoveryDescriptor {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly operationSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  readonly shareOperationId: string;
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: number;
  readonly publicSnapshotRef?: string;
  readonly publicSnapshotGraph?: string;
  readonly publisherPeerId: string;
  readonly subGraphName?: string;
  /** Only the active head and its referenced operation, for snapshot fetch. */
  readonly metadataQuads: readonly Quad[];
}

export interface MaterializedGraphScopedSwmRecoveryAsset
  extends GraphScopedSwmRecoveryDescriptor {
  readonly quads: readonly Quad[];
}

/**
 * Recoveries run immediately after admission, before the durable subgraph
 * registration projection is guaranteed to have landed locally. The
 * authenticated responder has already filtered SWM lanes to its registered
 * subgraphs, so bootstrap syntactically valid lane names from the response and
 * retain the local known-child exclusion as the final collision guard.
 */
export function discoverSwmRecoverySubGraphNames(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly excludedSubGraphNames?: readonly string[];
}): string[] {
  const prefix = `did:dkg:context-graph:${params.contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  const excluded = new Set(params.excludedSubGraphNames ?? []);
  const names = new Set<string>();
  for (const quad of params.metaQuads) {
    const graph = quad.graph;
    if (!graph.startsWith(prefix) || !graph.endsWith(suffix)) continue;
    const name = graph.slice(prefix.length, -suffix.length);
    if (!name || excluded.has(name) || !validateSubGraphName(name).valid) continue;
    names.add(name);
  }
  return [...names].sort();
}

/**
 * Parse and validate the active graph-scoped SWM heads in a complete recovery
 * metadata snapshot. Every accepted descriptor is bound to one deterministic
 * UAL/version graph and one same-graph WorkspaceOperation commitment.
 */
export function parseGraphScopedSwmRecoveryDescriptors(params: {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly registeredSubGraphNames?: readonly string[];
  readonly excludedSubGraphNames?: readonly string[];
}): GraphScopedSwmRecoveryDescriptor[] {
  const allowedMetaGraphs = allowedWorkspaceMetaGraphs(
    params.contextGraphId,
    params.registeredSubGraphNames,
    params.excludedSubGraphNames,
  );
  const byGraphAndSubject = groupByGraphAndSubject(params.metaQuads);
  const descriptors: GraphScopedSwmRecoveryDescriptor[] = [];

  for (const [key, headRows] of byGraphAndSubject) {
    const separator = key.indexOf('\u0000');
    const metaGraph = key.slice(0, separator);
    const headSubject = key.slice(separator + 1);
    if (!headSubject.endsWith(HEAD_SUFFIX)) continue;
    if (!allowedMetaGraphs.has(metaGraph)) {
      throw new Error(`Graph-scoped SWM head ${headSubject} is in an unregistered metadata graph ${metaGraph}`);
    }

    const kaUalFromHead = headSubject.slice(0, -HEAD_SUFFIX.length);
    const scopeVersion = requireRdfSafeInteger(headRows, CONTENT_SCOPE_VERSION, 'contentScopeVersion');
    if (scopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new Error(`Graph-scoped SWM head ${headSubject} has unsupported contentScopeVersion ${scopeVersion}`);
    }
    const kaUal = requireRdfObject(headRows, KA_UAL, 'kaUal');
    const assertionVersion = requireRdfPositiveIntegerString(headRows, ASSERTION_VERSION, 'assertionVersion');
    const scope = createGraphKnowledgeAssetScope(kaUal, assertionVersion);
    if (scope.ual !== kaUal || scope.ual !== kaUalFromHead) {
      throw new Error(`Graph-scoped SWM head ${headSubject} has a non-canonical or mismatched kaUal`);
    }

    const subGraphName = subGraphForMetaGraph(params.contextGraphId, metaGraph);
    const expectedAssertionGraph = knowledgeAssetLayerGraphUri(
      params.contextGraphId,
      MemoryLayer.SharedWorkingMemory,
      scope,
      subGraphName,
    );
    const assertionGraph = requireRdfObject(headRows, ASSERTION_GRAPH, 'assertionGraph');
    if (assertionGraph !== expectedAssertionGraph) {
      throw new Error(
        `Graph-scoped SWM head ${headSubject} assertionGraph mismatch: ` +
        `expected ${expectedAssertionGraph}, found ${assertionGraph}`,
      );
    }

    const shareOperationId = requireRdfLiteral(headRows, SHARE_OPERATION_ID, 'shareOperationId').trim();
    if (!shareOperationId) throw new Error(`Graph-scoped SWM head ${headSubject} has an empty shareOperationId`);
    const operationSubject = `urn:dkg:share:${params.contextGraphId}:${shareOperationId}`;
    const operationRows = byGraphAndSubject.get(`${metaGraph}\u0000${operationSubject}`) ?? [];
    validateOperationRows({
      rows: operationRows,
      contextGraphId: params.contextGraphId,
      metaGraph,
      operationSubject,
      shareOperationId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      subGraphName,
    });

    const publicQuadsDigest = requireRdfLiteral(
      operationRows,
      PUBLIC_QUADS_DIGEST,
      'publicQuadsDigest',
    ).trim().toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(publicQuadsDigest)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publicQuadsDigest`);
    }
    const publicQuadsCount = requireRdfSafeInteger(
      operationRows,
      PUBLIC_QUADS_COUNT,
      'publicQuadsCount',
    );
    if (publicQuadsCount < 0) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has a negative publicQuadsCount`);
    }
    const privateTripleCount = requireRdfSafeInteger(
      operationRows,
      PRIVATE_TRIPLE_COUNT,
      'privateTripleCount',
    );
    if (privateTripleCount < 0 || (privateTripleCount === 0 && publicQuadsCount === 0)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has invalid public/private counts`);
    }
    const privateRoot = optionalRdfObject(operationRows, PRIVATE_MERKLE_ROOT, 'privateMerkleRoot');
    if (
      (privateTripleCount > 0 && !/^0x[0-9a-fA-F]{64}$/.test(stripLiteral(privateRoot ?? '')))
      || (privateTripleCount === 0 && privateRoot !== undefined)
    ) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid private commitment`);
    }

    const publicSnapshotGraph = optionalRdfObject(
      operationRows,
      PUBLIC_SNAPSHOT_GRAPH,
      'publicSnapshotGraph',
    );
    const explicitSnapshotRef = optionalRdfLiteral(
      operationRows,
      PUBLIC_SNAPSHOT_REF,
      'publicSnapshotRef',
    )?.trim();
    if (publicSnapshotGraph && explicitSnapshotRef) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has two public snapshot locations`);
    }
    if (publicSnapshotGraph) {
      const expectedSnapshotGraph = knowledgeAssetSnapshotGraph(
        params.contextGraphId,
        shareOperationId,
        subGraphName,
      );
      if (publicSnapshotGraph !== expectedSnapshotGraph) {
        throw new Error(
          `Graph-scoped SWM operation ${operationSubject} snapshot graph mismatch: ` +
          `expected ${expectedSnapshotGraph}, found ${publicSnapshotGraph}`,
        );
      }
    }
    const publicSnapshotRef = publicSnapshotGraph
      ? undefined
      : (explicitSnapshotRef || publicQuadsDigest);
    if (publicSnapshotRef && !/^sha256:[0-9a-f]{64}$/i.test(publicSnapshotRef)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publicSnapshotRef`);
    }

    const publisherPeerId = requireRdfLiteral(operationRows, PUBLISHER_PEER_ID, 'publisherPeerId').trim();
    if (!publisherPeerId) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an empty publisherPeerId`);
    }
    descriptors.push({
      metaGraph,
      headSubject,
      operationSubject,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      assertionGraph,
      shareOperationId,
      publicQuadsDigest,
      publicQuadsCount,
      ...(publicSnapshotRef ? { publicSnapshotRef } : {}),
      ...(publicSnapshotGraph ? { publicSnapshotGraph } : {}),
      publisherPeerId,
      ...(subGraphName ? { subGraphName } : {}),
      metadataQuads: [...headRows, ...operationRows],
    });
  }

  const assertionOwners = new Map<string, string>();
  for (const descriptor of descriptors) {
    const owner = assertionOwners.get(descriptor.assertionGraph);
    if (owner && owner !== descriptor.kaUal) {
      throw new Error(`Graph-scoped SWM assertion graph ${descriptor.assertionGraph} has multiple UAL owners`);
    }
    assertionOwners.set(descriptor.assertionGraph, descriptor.kaUal);
  }
  return descriptors;
}

/** Load and re-verify one immutable snapshot, then stamp its exact SWM graph. */
export async function materializeGraphScopedSwmRecoveryAsset(params: {
  readonly descriptor: GraphScopedSwmRecoveryDescriptor;
  readonly fetchedDataQuads: readonly Quad[];
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<MaterializedGraphScopedSwmRecoveryAsset> {
  const descriptor = params.descriptor;
  let raw: Quad[] | null;
  if (descriptor.publicSnapshotGraph) {
    raw = params.fetchedDataQuads
      .filter((quad) => quad.graph === descriptor.publicSnapshotGraph)
      .map((quad) => ({ ...quad, graph: '' }));
  } else {
    if (!params.publicSnapshotStore || !descriptor.publicSnapshotRef) {
      throw new Error(`Graph-scoped SWM recovery requires a public snapshot store for ${descriptor.kaUal}`);
    }
    raw = await params.publicSnapshotStore.getSnapshot(descriptor.publicSnapshotRef);
  }
  if (!raw) {
    throw new Error(`Graph-scoped SWM snapshot is missing for ${descriptor.kaUal}`);
  }
  const normalized = raw.map((quad) => ({ ...quad, graph: '' }));
  const actualDigest = workspacePublicQuadsDigest(normalized);
  if (
    normalized.length !== descriptor.publicQuadsCount
    || actualDigest !== descriptor.publicQuadsDigest
  ) {
    throw new Error(
      `Graph-scoped SWM snapshot failed integrity for ${descriptor.kaUal}: ` +
      `expected ${descriptor.publicQuadsDigest}/${descriptor.publicQuadsCount}, ` +
      `got ${actualDigest}/${normalized.length}`,
    );
  }
  return {
    ...descriptor,
    quads: normalized.map((quad) => ({ ...quad, graph: descriptor.assertionGraph })),
  };
}

function validateOperationRows(params: {
  rows: readonly Quad[];
  contextGraphId: string;
  metaGraph: string;
  operationSubject: string;
  shareOperationId: string;
  kaUal: string;
  assertionVersion: string;
  subGraphName?: string;
}): void {
  const rows = params.rows;
  if (rows.length === 0) {
    throw new Error(`Graph-scoped SWM head references missing operation ${params.operationSubject}`);
  }
  if (!rows.some((row) => row.predicate === RDF_TYPE && row.object === WORKSPACE_OPERATION)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} is missing its type`);
  }
  requireRdfObject(rows, PUBLISHED_AT, 'publishedAt');
  if (requireRdfSafeInteger(rows, CONTENT_SCOPE_VERSION, 'contentScopeVersion') !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid scope version`);
  }
  if (requireRdfLiteral(rows, CONTEXT_GRAPH_ID, 'contextGraphId') !== params.contextGraphId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a contextGraphId mismatch`);
  }
  if (requireRdfLiteral(rows, SHARE_OPERATION_ID, 'shareOperationId') !== params.shareOperationId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a shareOperationId mismatch`);
  }
  if (requireRdfObject(rows, KA_UAL, 'kaUal') !== params.kaUal) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a kaUal mismatch`);
  }
  if (requireRdfPositiveIntegerString(rows, ASSERTION_VERSION, 'assertionVersion') !== params.assertionVersion) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an assertionVersion mismatch`);
  }
  const operationSubGraph = optionalRdfLiteral(rows, SUB_GRAPH_NAME, 'subGraphName')?.trim();
  if (operationSubGraph !== params.subGraphName) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a subGraphName mismatch`);
  }
  const accessPolicy = optionalRdfLiteral(rows, ACCESS_POLICY, 'accessPolicy')?.trim();
  if (accessPolicy && !['public', 'ownerOnly', 'allowList'].includes(accessPolicy)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid accessPolicy`);
  }
  const allowedPeers = distinctRdfObjects(rows, ALLOWED_PEER, { stripLiterals: true }).filter(Boolean);
  if (
    (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid access envelope`);
  }
  for (const row of rows) {
    if (row.graph !== params.metaGraph || row.subject !== params.operationSubject) {
      throw new Error(`Graph-scoped SWM operation ${params.operationSubject} is not graph-local`);
    }
  }
}

function allowedWorkspaceMetaGraphs(
  contextGraphId: string,
  registeredSubGraphNames: readonly string[] | undefined,
  excludedSubGraphNames: readonly string[] | undefined,
): Set<string> {
  const prefix = `did:dkg:context-graph:${contextGraphId}`;
  const allowed = new Set<string>([`${prefix}/_shared_memory_meta`]);
  const excluded = new Set(excludedSubGraphNames ?? []);
  for (const name of registeredSubGraphNames ?? []) {
    if (excluded.has(name) || !validateSubGraphName(name).valid) continue;
    allowed.add(`${prefix}/${name}/_shared_memory_meta`);
  }
  return allowed;
}

function subGraphForMetaGraph(contextGraphId: string, metaGraph: string): string | undefined {
  const root = `did:dkg:context-graph:${contextGraphId}/_shared_memory_meta`;
  if (metaGraph === root) return undefined;
  const prefix = `did:dkg:context-graph:${contextGraphId}/`;
  const suffix = '/_shared_memory_meta';
  const name = metaGraph.slice(prefix.length, -suffix.length);
  if (!validateSubGraphName(name).valid) {
    throw new Error(`Invalid graph-scoped SWM subgraph metadata graph ${metaGraph}`);
  }
  return name;
}

function knowledgeAssetSnapshotGraph(
  contextGraphId: string,
  shareOperationId: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId].map(encodeURIComponent);
  return `did:dkg:context-graph:${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/ka`;
}

function isCanonicalEncodedComponent(value: string): boolean {
  if (!value) return false;
  try {
    return encodeURIComponent(decodeURIComponent(value)) === value;
  } catch {
    return false;
  }
}

function groupByGraphAndSubject(quads: readonly Quad[]): Map<string, Quad[]> {
  const grouped = new Map<string, Quad[]>();
  for (const quad of quads) {
    const key = `${quad.graph}\u0000${quad.subject}`;
    const rows = grouped.get(key);
    if (rows) rows.push(quad);
    else grouped.set(key, [quad]);
  }
  return grouped;
}
