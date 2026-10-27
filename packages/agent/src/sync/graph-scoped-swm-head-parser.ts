// SPDX-License-Identifier: Apache-2.0
import { stripMetadataLiteral as stripLiteral } from './metadata-literal.js';
import { operationPublishedAtMs } from './swm-operation-published-at.js';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  knowledgeAssetLayerGraphUri,
  validateSubGraphName,
  workspaceKnowledgeAssetOperationSnapshotGraph as knowledgeAssetSnapshotGraph,
} from '@origintrail-official/dkg-core';
import {
  canonicalPublisherWorkspaceOperationSemantics,
  selectEquivalentWorkspaceOperation,
  type WorkspaceOperationModel,
  type PublisherWorkspaceOperationSemantics,
  type WorkspaceOperationAccessEnvelope,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { normalizeIdentityObject } from './graph-scoped-swm-operation-identity.js';
const DKG = 'http://dkg.io/ontology/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const WORKSPACE_OPERATION = `${DKG}WorkspaceOperation`;

const CONTENT_SCOPE_VERSION = `${DKG}contentScopeVersion`;
const KA_UAL = `${DKG}kaUal`;
const ASSERTION_VERSION = `${DKG}assertionVersion`;
const ASSERTION_GRAPH = `${DKG}assertionGraph`;
const CONTEXT_GRAPH_ID = `${DKG}contextGraphId`;
const PUBLIC_QUADS_DIGEST = `${DKG}publicQuadsDigest`;
const PUBLIC_QUADS_COUNT = `${DKG}publicQuadsCount`;
const PUBLIC_SNAPSHOT_REF = `${DKG}publicSnapshotRef`;
const PUBLIC_SNAPSHOT_GRAPH = `${DKG}publicSnapshotGraph`;
const PRIVATE_TRIPLE_COUNT = `${DKG}privateTripleCount`;
const PRIVATE_MERKLE_ROOT = `${DKG}privateMerkleRoot`;
const PUBLISHER_PEER_ID = `${DKG}publisherPeerId`;
const ACCESS_POLICY = `${DKG}accessPolicy`;
const ALLOWED_PEER = `${DKG}allowedPeer`;
const SUB_GRAPH_NAME = `${DKG}subGraphName`;

interface RecoveryWorkspaceOperationIdentity {
  readonly contextGraphId: string;
  readonly contentScopeVersion: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
  readonly authorIdentities: readonly string[];
}

interface RecoveryWorkspaceOperationSemantics extends PublisherWorkspaceOperationSemantics {
  readonly recoveryIdentity: RecoveryWorkspaceOperationIdentity;
}

/** Same-payload aliases are compared after the recovery decoder validates them. */
function samePayloadOperationEquivalenceKey(
  semantics: RecoveryWorkspaceOperationSemantics,
): string {
  const normalizeSet = (values: readonly string[]) => [...new Set(values)].sort();
  const access: WorkspaceOperationAccessEnvelope = semantics.access.kind === 'persisted'
    ? {
        kind: 'persisted',
        accessPolicy: semantics.access.accessPolicy,
        allowedPeers: normalizeSet(semantics.access.allowedPeers.map((peer) => peer.trim())),
      }
    : semantics.access;
  return JSON.stringify({
    publisherSemantics: canonicalPublisherWorkspaceOperationSemantics({
      publicQuadsDigest: semantics.publicQuadsDigest.trim().toLowerCase(),
      publicTripleCount: semantics.publicTripleCount,
      ...(semantics.privateMerkleRoot === undefined
        ? {}
        : { privateMerkleRoot: semantics.privateMerkleRoot.toLowerCase() }),
      privateTripleCount: semantics.privateTripleCount,
      publisherIdentity: semantics.publisherIdentity.trim(),
      access,
    }),
    recoveryIdentity: {
      contextGraphId: semantics.recoveryIdentity.contextGraphId,
      contentScopeVersion: semantics.recoveryIdentity.contentScopeVersion,
      kaUal: semantics.recoveryIdentity.kaUal,
      assertionVersion: semantics.recoveryIdentity.assertionVersion,
      ...(semantics.recoveryIdentity.subGraphName === undefined
        ? {}
        : { subGraphName: semantics.recoveryIdentity.subGraphName }),
      authorIdentities: normalizeSet(semantics.recoveryIdentity.authorIdentities),
    },
  });
}

export type RecoverySnapshotLocator =
  | Readonly<{ kind: 'graph'; graph: string }>
  | Readonly<{
      kind: 'store';
      ref: string;
      provenance: 'persisted-ref' | 'digest-fallback';
    }>;

export interface GraphScopedSwmRecoveryDescriptor {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly operationSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  /** Deterministic newest alias used as the logical head identity. */
  readonly shareOperationId: string;
  /** Equivalent operation and immutable locator selected for materialization. */
  readonly snapshotSource: Readonly<{
    shareOperationId: string;
    operationSubject: string;
    locator: RecoverySnapshotLocator;
  }>;
  /** Complete validated same-payload alias class, in deterministic order. */
  readonly equivalentOperationSubjects: readonly string[];
  readonly publicQuadsDigest: string;
  readonly publicQuadsCount: number;
  /** Authenticated private-content commitment carried by the active operation. */
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly publisherPeerId: string;
  readonly subGraphName?: string;
  /** Only the active head and its referenced operation, for snapshot fetch. */
  readonly metadataQuads: readonly Quad[];
}

const PROV_WAS_ATTRIBUTED_TO = 'http://www.w3.org/ns/prov#wasAttributedTo';
export const SWM_HEAD_SUFFIX = '#dkg-swm-head';
export const SWM_SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';
export interface HeadOperationReference {
  readonly shareOperationId: string;
  readonly operationSubject: string;
}
export interface SwmRecoveryHead {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly headRows: readonly Quad[];
  readonly operationReferences: readonly HeadOperationReference[];
}
export interface SetAsideGraphScopedSwmHead {
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly operationSubjects: readonly string[];
  readonly error: Error;
}

function parseGraphScopedSwmHeads(
  params: GraphScopedSwmRecoveryParseInput,
  mode: 'strict' | 'set-aside',
): { descriptors: GraphScopedSwmRecoveryDescriptor[]; setAside: SetAsideGraphScopedSwmHead[] } {
  const allowedMetaGraphs = allowedWorkspaceMetaGraphs(params.contextGraphId,
    params.registeredSubGraphNames, params.excludedSubGraphNames);
  const index = new Map<string, Quad[]>();
  for (const quad of params.metaQuads) {
    const key = `${quad.graph}\u0000${quad.subject}`;
    const rows = index.get(key);
    if (rows) rows.push(quad); else index.set(key, [quad]);
  }
  const descriptors: GraphScopedSwmRecoveryDescriptor[] = [];
  const setAside: SetAsideGraphScopedSwmHead[] = [];
  for (const [key, headRows] of index) {
    const separator = key.indexOf('\u0000');
    const metaGraph = key.slice(0, separator);
    const headSubject = key.slice(separator + 1);
    if (!headSubject.endsWith(SWM_HEAD_SUFFIX)) continue;
    const operationReferences = [...new Set(headRows.filter(row => row.predicate === SWM_SHARE_OPERATION_ID)
      .map(row => stripLiteral(row.object).trim()))]
      .map(shareOperationId => ({ shareOperationId, operationSubject: `urn:dkg:share:${params.contextGraphId}:${shareOperationId}` }));
    try {
      descriptors.push(decodeHead(params, { metaGraph, headSubject, headRows, operationReferences }, index, allowedMetaGraphs));
    } catch (error) {
      if (mode === 'strict') throw error;
      setAside.push({
        metaGraph, headSubject,
        operationSubjects: operationReferences.filter(ref => ref.shareOperationId.length > 0).map(ref => ref.operationSubject),
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  // Cross-head ownership conflicts always reject the generation, even after isolated failures.
  const owners = new Map<string, string>();
  for (const descriptor of descriptors) {
    const owner = owners.get(descriptor.assertionGraph);
    if (owner && owner !== descriptor.kaUal) {
      throw new Error(`Graph-scoped SWM assertion graph ${descriptor.assertionGraph} has multiple UAL owners`);
    }
    owners.set(descriptor.assertionGraph, descriptor.kaUal);
  }
  return { descriptors, setAside };
}
export interface GraphScopedSwmRecoveryParseInput {
  readonly contextGraphId: string;
  readonly metaQuads: readonly Quad[];
  readonly registeredSubGraphNames?: readonly string[];
  readonly excludedSubGraphNames?: readonly string[];
}
export function parseGraphScopedSwmRecoveryDescriptors(params: GraphScopedSwmRecoveryParseInput): GraphScopedSwmRecoveryDescriptor[] {
  return parseRecoveryHeads(params, 'strict').descriptors;
}
export function parseGraphScopedSwmRecoveryHeadResults(params: GraphScopedSwmRecoveryParseInput) {
  return parseRecoveryHeads(params, 'set-aside');
}
function parseRecoveryHeads(params: GraphScopedSwmRecoveryParseInput, mode: 'strict' | 'set-aside') {
  return parseGraphScopedSwmHeads(params, mode);
}
function decodeHead(params: GraphScopedSwmRecoveryParseInput,
  { metaGraph, headSubject, headRows, operationReferences }: SwmRecoveryHead,
  byGraphAndSubject: ReadonlyMap<string, readonly Quad[]>,
  allowedMetaGraphs: ReadonlySet<string>,
): GraphScopedSwmRecoveryDescriptor {
  if (!allowedMetaGraphs.has(metaGraph)) {
    throw new Error(`Graph-scoped SWM head ${headSubject} is in an unregistered metadata graph ${metaGraph}`);
  }

  const kaUalFromHead = headSubject.slice(0, -SWM_HEAD_SUFFIX.length);
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
    headRows, operationReferences,
    byGraphAndSubject,
    contextGraphId: params.contextGraphId,
    metaGraph,
    headSubject,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    subGraphName,
  });
  const {
    shareOperationId,
    operationSubject,
    operationRows,
    semantics,
    snapshotSource,
    equivalentOperationSubjects,
  } = operation;
  const publicQuadsDigest = semantics.publicQuadsDigest;
  const publicQuadsCount = semantics.publicTripleCount;
  const privateTripleCount = semantics.privateTripleCount;
  const privateRoot = semantics.privateMerkleRoot;
  return {
    metaGraph,
    headSubject,
    operationSubject,
    kaUal: scope.ual,
    assertionVersion: scope.assertionVersion,
    assertionGraph,
    shareOperationId,
    snapshotSource: {
      shareOperationId: snapshotSource.shareOperationId,
      operationSubject: snapshotSource.operationSubject,
      locator: snapshotSource.locator,
    },
    equivalentOperationSubjects,
    publicQuadsDigest,
    publicQuadsCount,
    privateTripleCount,
    ...(privateRoot === undefined ? {} : { privateMerkleRoot: privateRoot }),
    publisherPeerId: semantics.publisherIdentity,
    ...(subGraphName ? { subGraphName } : {}),
    metadataQuads: [
      ...headRows.filter((row) => row.predicate !== SWM_SHARE_OPERATION_ID),
      // EVERY lexical form of the selected id, not just the one selected
      // row: RDF 1.1 admits the same value as a plain and an
      // xsd:string-typed literal, and downstream withhold plans are built
      // from these rows BYTE-keyed — a variant left out here passes the
      // value-based insert canonicalization and re-stacks the losing id
      // beside a just-preserved head.
      ...headRows.filter((row) => row.predicate === SWM_SHARE_OPERATION_ID
        && stripLiteral(row.object).trim() === shareOperationId),
      ...operationRows,
      ...(snapshotSource.operationSubject === operationSubject
        ? []
        : snapshotSource.operationRows),
    ],
  };
}

interface RecoveryOperationCandidate extends WorkspaceOperationModel<RecoveryWorkspaceOperationSemantics> {
  readonly shareOperationId: string;
  readonly operationSubject: string;
  readonly operationRows: readonly Quad[];
  readonly snapshotLocator: RecoverySnapshotLocator;
}

interface ResolvedHeadOperation {
  readonly shareOperationId: string;
  readonly operationSubject: string;
  readonly operationRows: readonly Quad[];
  readonly semantics: RecoveryWorkspaceOperationSemantics;
  readonly snapshotSource: Readonly<{
    shareOperationId: string;
    operationSubject: string;
    operationRows: readonly Quad[];
    locator: RecoverySnapshotLocator;
  }>;
  readonly equivalentOperationSubjects: readonly string[];
}

function recoverySnapshotLocator(params: {
  readonly rows: readonly Quad[];
  readonly contextGraphId: string;
  readonly operationSubject: string;
  readonly shareOperationId: string;
  readonly subGraphName?: string;
  readonly publicQuadsDigest: string;
}): RecoverySnapshotLocator {
  const publicSnapshotGraph = optionalSingle(
    params.rows,
    PUBLIC_SNAPSHOT_GRAPH,
    'publicSnapshotGraph',
  );
  const explicitSnapshotRef = optionalLiteral(
    params.rows,
    PUBLIC_SNAPSHOT_REF,
    'publicSnapshotRef',
  )?.trim();
  if (publicSnapshotGraph && explicitSnapshotRef) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has two public snapshot locations`);
  }
  if (publicSnapshotGraph) {
    const expectedSnapshotGraph = knowledgeAssetSnapshotGraph(
      params.contextGraphId,
      params.shareOperationId,
      params.subGraphName,
    );
    if (publicSnapshotGraph !== expectedSnapshotGraph) {
      throw new Error(
        `Graph-scoped SWM operation ${params.operationSubject} snapshot graph mismatch: ` +
        `expected ${expectedSnapshotGraph}, found ${publicSnapshotGraph}`,
      );
    }
    return { kind: 'graph', graph: publicSnapshotGraph };
  }
  const ref = explicitSnapshotRef || params.publicQuadsDigest;
  if (!/^sha256:[0-9a-f]{64}$/i.test(ref)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid publicSnapshotRef`);
  }
  return {
    kind: 'store',
    ref,
    provenance: explicitSnapshotRef ? 'persisted-ref' : 'digest-fallback',
  };
}

/**
 * Storage-ACK persistence and originator persistence can legitimately produce
 * two operation ids for the same exact assertion. Accept that residue only
 * when every recovery-relevant operation row is byte-equivalent (apart from
 * operation id and timestamp), then choose the newest operation
 * deterministically. Any content or policy disagreement remains fail-closed.
 */
function resolveEquivalentHeadOperation(params: {
  readonly operationReferences: readonly HeadOperationReference[];
  readonly headRows: readonly Quad[];
  readonly byGraphAndSubject: ReadonlyMap<string, readonly Quad[]>;
  readonly contextGraphId: string;
  readonly metaGraph: string;
  readonly headSubject: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
}): ResolvedHeadOperation {
  const shareOperationIds = params.operationReferences.map(ref => ref.shareOperationId);
  if (shareOperationIds.length === 0) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
  }
  if (shareOperationIds.some((value) => value.length === 0)) {
    throw new Error(`Graph-scoped SWM head ${params.headSubject} has an empty shareOperationId`);
  }

  const candidates: RecoveryOperationCandidate[] = params.operationReferences.map(({ shareOperationId, operationSubject }) => {
    const operationRows = params.byGraphAndSubject.get(
      `${params.metaGraph}\u0000${operationSubject}`,
    ) ?? [];
    const semantics = validateOperationRows({
      rows: operationRows,
      contextGraphId: params.contextGraphId,
      metaGraph: params.metaGraph,
      operationSubject,
      shareOperationId,
      kaUal: params.kaUal,
      assertionVersion: params.assertionVersion,
      subGraphName: params.subGraphName,
    });
    const publishedAtMs = operationPublishedAtMs(operationRows, operationSubject);
    const headShareOperationRow = params.headRows
      .filter((row) => row.predicate === SWM_SHARE_OPERATION_ID)
      .find((row) => stripLiteral(row.object).trim() === shareOperationId);
    if (!headShareOperationRow) {
      throw new Error(`Graph-scoped SWM head ${params.headSubject} is missing shareOperationId`);
    }
    return {
      semantics,
      provenance: { shareOperationId, publishedAtMs },
      shareOperationId,
      operationSubject,
      operationRows,
      snapshotLocator: recoverySnapshotLocator({
        rows: operationRows,
        contextGraphId: params.contextGraphId,
        operationSubject,
        shareOperationId,
        ...(params.subGraphName === undefined ? {} : { subGraphName: params.subGraphName }),
        publicQuadsDigest: semantics.publicQuadsDigest,
      }),
    };
  });

  const orderedCandidates = selectEquivalentWorkspaceOperation(
    candidates,
    samePayloadOperationEquivalenceKey,
    { ambiguityError: () => new Error('ambiguous shareOperationId') },
  );
  const selected = orderedCandidates[0];
  // Logical display ordering and snapshot capability are intentionally
  // independent. Prefer a self-contained graph locator from any equivalent
  // alias; otherwise prefer the selected alias, then an explicitly persisted
  // store ref, before using the modern digest fallback convention.
  const graphSource = orderedCandidates.find(
    (candidate) => candidate.snapshotLocator.kind === 'graph',
  );
  const persistedRefSource = orderedCandidates.find(
    (candidate) => candidate.snapshotLocator.kind === 'store'
      && candidate.snapshotLocator.provenance === 'persisted-ref',
  );
  const snapshotSource = graphSource
    ?? (selected.snapshotLocator.kind === 'store'
      && selected.snapshotLocator.provenance === 'persisted-ref'
      ? selected
      : persistedRefSource ?? selected);
  return {
    shareOperationId: selected.provenance.shareOperationId,
    operationSubject: selected.operationSubject,
    operationRows: selected.operationRows,
    semantics: selected.semantics,
    snapshotSource: {
      shareOperationId: snapshotSource.shareOperationId,
      operationSubject: snapshotSource.operationSubject,
      operationRows: snapshotSource.operationRows,
      locator: snapshotSource.snapshotLocator,
    },
    equivalentOperationSubjects: Object.freeze(
      orderedCandidates.map((candidate) => candidate.operationSubject),
    ),
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
}): RecoveryWorkspaceOperationSemantics {
  const rows = params.rows;
  if (rows.length === 0) {
    throw new Error(`Graph-scoped SWM head references missing operation ${params.operationSubject}`);
  }
  if (!rows.some((row) => row.predicate === RDF_TYPE && row.object === WORKSPACE_OPERATION)) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} is missing its type`);
  }
  operationPublishedAtMs(rows, params.operationSubject);
  if (requireSafeInteger(rows, CONTENT_SCOPE_VERSION, 'contentScopeVersion') !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid scope version`);
  }
  if (requireLiteral(rows, CONTEXT_GRAPH_ID, 'contextGraphId') !== params.contextGraphId) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has a contextGraphId mismatch`);
  }
  if (requireLiteral(rows, SWM_SHARE_OPERATION_ID, 'shareOperationId') !== params.shareOperationId) {
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
  const allowedPeers = distinctObjects(rows, ALLOWED_PEER)
    .map((value) => stripLiteral(value)?.trim())
    .filter((peer): peer is string => Boolean(peer))
    .sort();
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
  const publicTripleCount = requireSafeInteger(rows, PUBLIC_QUADS_COUNT, 'publicQuadsCount');
  const privateTripleCount = requireSafeInteger(rows, PRIVATE_TRIPLE_COUNT, 'privateTripleCount');
  const publicQuadsDigest = requireLiteral(rows, PUBLIC_QUADS_DIGEST, 'publicQuadsDigest')
    .trim()
    .toLowerCase();
  const privateMerkleRoot = optionalLiteral(rows, PRIVATE_MERKLE_ROOT, 'privateMerkleRoot')
    ?.trim()
    .toLowerCase();
  const publisherIdentity = requireLiteral(rows, PUBLISHER_PEER_ID, 'publisherPeerId').trim();
  if (
    publicTripleCount < 0
    || privateTripleCount < 0
    || (publicTripleCount === 0 && privateTripleCount === 0)
    || !/^sha256:[0-9a-f]{64}$/.test(publicQuadsDigest)
    || !publisherIdentity
  ) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has invalid commitment metadata`);
  }
  if (
    (privateTripleCount > 0 && !/^0x[0-9a-f]{64}$/i.test(privateMerkleRoot ?? ''))
    || (privateTripleCount === 0 && privateMerkleRoot !== undefined)
  ) {
    throw new Error(`Graph-scoped SWM operation ${params.operationSubject} has an invalid private commitment`);
  }
  const effectiveAccessPolicy = (accessPolicy
    ?? (privateTripleCount > 0 ? 'ownerOnly' : 'public')) as
    'public' | 'ownerOnly' | 'allowList';
  const access: WorkspaceOperationAccessEnvelope = accessPolicy === undefined
    ? {
        kind: 'legacy-default',
        accessPolicy: effectiveAccessPolicy as 'public' | 'ownerOnly',
        allowedPeers: [],
      }
    : {
        kind: 'persisted',
        accessPolicy: effectiveAccessPolicy,
        allowedPeers,
      };
  return {
    publicQuadsDigest,
    publicTripleCount,
    ...(privateMerkleRoot === undefined ? {} : { privateMerkleRoot }),
    privateTripleCount,
    publisherIdentity,
    access,
    recoveryIdentity: {
      contextGraphId: params.contextGraphId,
      contentScopeVersion: requireLiteral(rows, CONTENT_SCOPE_VERSION, 'contentScopeVersion'),
      kaUal: params.kaUal,
      assertionVersion: params.assertionVersion,
      ...(operationSubGraph === undefined ? {} : { subGraphName: operationSubGraph }),
      authorIdentities: distinctObjects(rows, PROV_WAS_ATTRIBUTED_TO)
        .map(normalizeIdentityObject),
    },
  };
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
