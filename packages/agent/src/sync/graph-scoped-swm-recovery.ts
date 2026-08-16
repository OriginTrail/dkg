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
  /** Authenticated private-content commitment carried by the active operation. */
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
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
    const scopeVersion = requireSafeInteger(headRows, CONTENT_SCOPE_VERSION, 'contentScopeVersion');
    if (scopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
      throw new Error(`Graph-scoped SWM head ${headSubject} has unsupported contentScopeVersion ${scopeVersion}`);
    }
    const kaUal = requireSingle(headRows, KA_UAL, 'kaUal');
    const assertionVersion = requirePositiveInteger(headRows, ASSERTION_VERSION, 'assertionVersion');
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
    const assertionGraph = requireSingle(headRows, ASSERTION_GRAPH, 'assertionGraph');
    if (assertionGraph !== expectedAssertionGraph) {
      throw new Error(
        `Graph-scoped SWM head ${headSubject} assertionGraph mismatch: ` +
        `expected ${expectedAssertionGraph}, found ${assertionGraph}`,
      );
    }

    const operation = resolveEquivalentHeadOperation({
      headRows,
      byGraphAndSubject,
      contextGraphId: params.contextGraphId,
      metaGraph,
      headSubject,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      subGraphName,
    });
    const { shareOperationId, operationSubject, operationRows } = operation;

    const publicQuadsDigest = requireLiteral(
      operationRows,
      PUBLIC_QUADS_DIGEST,
      'publicQuadsDigest',
    ).trim().toLowerCase();
    if (!/^sha256:[0-9a-f]{64}$/.test(publicQuadsDigest)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publicQuadsDigest`);
    }
    const publicQuadsCount = requireSafeInteger(
      operationRows,
      PUBLIC_QUADS_COUNT,
      'publicQuadsCount',
    );
    if (publicQuadsCount < 0) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has a negative publicQuadsCount`);
    }
    const privateTripleCount = requireSafeInteger(
      operationRows,
      PRIVATE_TRIPLE_COUNT,
      'privateTripleCount',
    );
    if (privateTripleCount < 0 || (privateTripleCount === 0 && publicQuadsCount === 0)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has invalid public/private counts`);
    }
    const privateRoot = optionalSingle(operationRows, PRIVATE_MERKLE_ROOT, 'privateMerkleRoot');
    if (
      (privateTripleCount > 0 && !/^0x[0-9a-fA-F]{64}$/.test(stripLiteral(privateRoot ?? '')))
      || (privateTripleCount === 0 && privateRoot !== undefined)
    ) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid private commitment`);
    }

    const publicSnapshotGraph = optionalSingle(
      operationRows,
      PUBLIC_SNAPSHOT_GRAPH,
      'publicSnapshotGraph',
    );
    const explicitSnapshotRef = optionalLiteral(
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

    const publisherPeerId = requireLiteral(operationRows, PUBLISHER_PEER_ID, 'publisherPeerId').trim();
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
      privateTripleCount,
      ...(privateRoot === undefined
        ? {}
        : { privateMerkleRoot: stripLiteral(privateRoot).toLowerCase() }),
      ...(publicSnapshotRef ? { publicSnapshotRef } : {}),
      ...(publicSnapshotGraph ? { publicSnapshotGraph } : {}),
      publisherPeerId,
      ...(subGraphName ? { subGraphName } : {}),
      metadataQuads: [
        ...headRows.filter((row) => row.predicate !== SHARE_OPERATION_ID),
        operation.headShareOperationRow,
        ...operationRows,
      ],
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

/**
 * Collapse only the current-head pointer rows covered by parsed descriptors.
 * Superseded operation subjects may remain as immutable history, but a head
 * itself must name exactly one operation or LIMIT-1 readers become arbitrary.
 */
export function canonicalizeGraphScopedSwmHeadRows(params: {
  readonly metaQuads: readonly Quad[];
  readonly descriptors: readonly GraphScopedSwmRecoveryDescriptor[];
}): Quad[] {
  const selectedByHead = new Map(
    params.descriptors.map((descriptor) => [
      `${descriptor.metaGraph}\u0000${descriptor.headSubject}`,
      descriptor.shareOperationId,
    ]),
  );
  return params.metaQuads.filter((row) => {
    if (row.predicate !== SHARE_OPERATION_ID) return true;
    const selected = selectedByHead.get(`${row.graph}\u0000${row.subject}`);
    return selected === undefined || stripLiteral(row.object).trim() === selected;
  });
}

const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/**
 * GH#2273 — the predicates over which two share operations for the same KA are
 * compared for IDENTITY-preserving decisions ("is this the same share under a
 * different operation id?"). An explicit ALLOW-LIST, not a deny-list: several
 * operation rows embed the operation id in their VALUE (`publicSnapshotGraph`
 * is `did:…/_shared_memory_snapshots/…/<shareOperationId>/ka`), and others are
 * legitimately per-node (`publisherPeerId` names whichever node persisted the
 * operation, `publishedAt` its clock) — a deny-list that misses any of those
 * makes byte-identical shares compare unequal and silently disables every
 * prefer-local decision built on it.
 *
 * `required` rows must be present on BOTH sides or the key is null (callers
 * treat null as NOT equivalent — fail toward remote authority, never toward
 * preserving unprovable equivalence). `compared` rows participate whenever
 * present; a row present on one side only makes the keys differ, which is the
 * correct outcome (e.g. an added accessPolicy or allowedPeer IS a change the
 * stale-intent machinery must see).
 */
export const OPERATION_IDENTITY_PREDICATES = {
  required: [
    CONTEXT_GRAPH_ID,
    CONTENT_SCOPE_VERSION,
    KA_UAL,
    ASSERTION_VERSION,
    PUBLIC_QUADS_COUNT,
    PUBLIC_QUADS_DIGEST,
    PRIVATE_TRIPLE_COUNT,
  ],
  compared: [
    PRIVATE_MERKLE_ROOT,
    ACCESS_POLICY,
    ALLOWED_PEER,
    SUB_GRAPH_NAME,
    PROV_WAS_ATTRIBUTED_TO,
  ],
} as const;

/**
 * One side of the comparison is WIRE quads (descriptor metadata) and the other
 * is rows READ BACK from the triple store, so object terms are canonicalized
 * before keying: RDF 1.1 makes a plain literal and `^^xsd:string` the same
 * term, and `^^xsd:integer` values compare by numeric value so a store that
 * canonicalizes the lexical form cannot break byte-equality of the key.
 */
function normalizeIdentityObject(object: string): string {
  const literal = /^"([\s\S]*)"(?:\^\^<(.+)>)?$/.exec(object);
  if (!literal) return `iri\u0000${object}`;
  const value = literal[1] ?? '';
  const datatype = literal[2] ?? '';
  if (datatype === '' || datatype === XSD_STRING) return `lit\u0000${value}\u0000`;
  if (datatype === XSD_INTEGER) {
    try {
      return `lit\u0000${BigInt(value).toString()}\u0000${XSD_INTEGER}`;
    } catch {
      return `lit\u0000${value}\u0000${XSD_INTEGER}`;
    }
  }
  return `lit\u0000${value}\u0000${datatype}`;
}

/**
 * Subject- and graph-independent identity key for one share operation's rows,
 * or null when any required identity row is absent. Two operations with equal
 * keys are the SAME share (same content commitment, same access envelope, same
 * author) under different operation ids — the residue storage-ACK persistence
 * and originator persistence legitimately produce for one share.
 */
export function operationIdentityKey(rows: readonly Quad[]): string | null {
  const parts = new Set<string>();
  const seenPredicates = new Set<string>();
  const allowed = new Set<string>([
    ...OPERATION_IDENTITY_PREDICATES.required,
    ...OPERATION_IDENTITY_PREDICATES.compared,
  ]);
  for (const row of rows) {
    if (!allowed.has(row.predicate)) continue;
    seenPredicates.add(row.predicate);
    parts.add(`${row.predicate}\u0000${normalizeIdentityObject(row.object)}`);
  }
  for (const predicate of OPERATION_IDENTITY_PREDICATES.required) {
    if (!seenPredicates.has(predicate)) return null;
  }
  return [...parts].sort().join('\u0001');
}

interface ResolvedHeadOperation {
  readonly shareOperationId: string;
  readonly operationSubject: string;
  readonly operationRows: readonly Quad[];
  readonly headShareOperationRow: Quad;
}

/**
 * Storage-ACK persistence and originator persistence can legitimately produce
 * two operation ids for the same exact assertion. Accept that residue only
 * when every recovery-relevant operation row is byte-equivalent (apart from
 * operation id and timestamp), then choose the newest operation
 * deterministically. Any content or policy disagreement remains fail-closed.
 */
function resolveEquivalentHeadOperation(params: {
  readonly headRows: readonly Quad[];
  readonly byGraphAndSubject: ReadonlyMap<string, readonly Quad[]>;
  readonly contextGraphId: string;
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
}): ResolvedHeadOperation {
  const shareOperationIds = [...new Set(
    distinctObjects(params.headRows, SHARE_OPERATION_ID)
      .map(stripLiteral)
      .map((value) => value.trim()),
  )];
  if (shareOperationIds.length === 0) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
  }
  if (shareOperationIds.some((value) => value.length === 0)) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} has an empty shareOperationId`);
  }

  const candidates = shareOperationIds.map((shareOperationId) => {
    const operationSubject = `urn:dkg:share:${params.contextGraphId}:${shareOperationId}`;
    const operationRows = params.byGraphAndSubject.get(
      `${params.metaGraph}\u0000${operationSubject}`,
    ) ?? [];
    validateOperationRows({
      rows: operationRows,
      contextGraphId: params.contextGraphId,
      metaGraph: params.metaGraph,
      operationSubject,
      shareOperationId,
      kaUal: params.kaUal,
      assertionVersion: params.assertionVersion,
      subGraphName: params.subGraphName,
    });
    const publishedAt = stripLiteral(requireSingle(operationRows, PUBLISHED_AT, 'publishedAt'));
    const publishedAtMs = Date.parse(publishedAt);
    if (!Number.isFinite(publishedAtMs)) {
      throw new Error(`Graph-scoped SWM operation ${operationSubject} has an invalid publishedAt`);
    }
    const equivalenceKey = operationRows
      .filter((row) => row.predicate !== SHARE_OPERATION_ID && row.predicate !== PUBLISHED_AT)
      .map((row) => `${row.predicate}\u0000${row.object}\u0000${row.graph}`)
      .sort()
      .join('\u0001');
    const headShareOperationRow = params.headRows
      .filter((row) => row.predicate === SHARE_OPERATION_ID)
      .filter((row) => stripLiteral(row.object).trim() === shareOperationId)
      .sort((left, right) => left.object.localeCompare(right.object))[0];
    if (!headShareOperationRow) {
      throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
    }
    return {
      shareOperationId,
      operationSubject,
      operationRows,
      headShareOperationRow,
      publishedAtMs,
      equivalenceKey,
    };
  });

  if (new Set(candidates.map((candidate) => candidate.equivalenceKey)).size > 1) {
    throw new Error(`ambiguous shareOperationId`);
  }
  candidates.sort((left, right) =>
    right.publishedAtMs - left.publishedAtMs
    || right.shareOperationId.localeCompare(left.shareOperationId));
  return candidates[0]!;
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
  requireSingle(rows, PUBLISHED_AT, 'publishedAt');
  if (requireSafeInteger(rows, CONTENT_SCOPE_VERSION, 'contentScopeVersion') !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid scope version`);
  }
  if (requireLiteral(rows, CONTEXT_GRAPH_ID, 'contextGraphId') !== params.contextGraphId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a contextGraphId mismatch`);
  }
  if (requireLiteral(rows, SHARE_OPERATION_ID, 'shareOperationId') !== params.shareOperationId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a shareOperationId mismatch`);
  }
  if (requireSingle(rows, KA_UAL, 'kaUal') !== params.kaUal) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a kaUal mismatch`);
  }
  if (requirePositiveInteger(rows, ASSERTION_VERSION, 'assertionVersion') !== params.assertionVersion) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an assertionVersion mismatch`);
  }
  const operationSubGraph = optionalLiteral(rows, SUB_GRAPH_NAME, 'subGraphName')?.trim();
  if (operationSubGraph !== params.subGraphName) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a subGraphName mismatch`);
  }
  const accessPolicy = optionalLiteral(rows, ACCESS_POLICY, 'accessPolicy')?.trim();
  if (accessPolicy && !['public', 'ownerOnly', 'allowList'].includes(accessPolicy)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid accessPolicy`);
  }
  const allowedPeers = distinctObjects(rows, ALLOWED_PEER).map(stripLiteral).filter(Boolean);
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

function distinctObjects(rows: readonly Quad[], predicate: string): string[] {
  return [...new Set(rows.filter((row) => row.predicate === predicate).map((row) => row.object))];
}

function requireSingle(rows: readonly Quad[], predicate: string, field: string): string {
  const values = distinctObjects(rows, predicate);
  if (values.length !== 1) {
    throw new Error(`${values.length === 0 ? 'missing' : 'ambiguous'} ${field}`);
  }
  return values[0]!;
}

function optionalSingle(rows: readonly Quad[], predicate: string, field: string): string | undefined {
  const values = distinctObjects(rows, predicate);
  if (values.length > 1) throw new Error(`ambiguous ${field}`);
  return values[0];
}

function requireLiteral(rows: readonly Quad[], predicate: string, field: string): string {
  return stripLiteral(requireSingle(rows, predicate, field));
}

function optionalLiteral(rows: readonly Quad[], predicate: string, field: string): string | undefined {
  const value = optionalSingle(rows, predicate, field);
  return value === undefined ? undefined : stripLiteral(value);
}

function requireSafeInteger(rows: readonly Quad[], predicate: string, field: string): number {
  const raw = stripLiteral(requireSingle(rows, predicate, field));
  if (!/^-?[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`unsafe ${field}`);
  return parsed;
}

function requirePositiveInteger(rows: readonly Quad[], predicate: string, field: string): string {
  const raw = stripLiteral(requireSingle(rows, predicate, field));
  if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid ${field}`);
  const parsed = BigInt(raw);
  if (parsed < 1n) throw new Error(`${field} must be positive`);
  return parsed.toString();
}

function stripLiteral(value: string): string {
  const match = value.match(/^"((?:[^"\\]|\\.)*)"(?:@[-A-Za-z0-9]+|\^\^<[^>]+>)?$/);
  if (!match) return value;
  return match[1]!
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}
