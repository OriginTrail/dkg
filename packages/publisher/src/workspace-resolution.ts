import type { Quad, QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  assertSafeIri,
  createGraphKnowledgeAssetScope,
  isSafeIri,
  knowledgeAssetLayerGraphUri,
  type TimestampMsV1,
  validateSubGraphName,
} from '@origintrail-official/dkg-core';
import type { LiftPublishSnapshotRequest } from './lift-job.js';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import {
  agentDid,
  generateKnowledgeAssetShareMetadata,
  generateShareMetadata,
  toHex,
} from './metadata.js';
import {
  computePrivateRootV10 as computePrivateRoot,
} from './merkle.js';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

function workspaceHeadStoreOptions(
  options: QueryOptions | undefined,
  operation: 'deleteByPattern' | 'insert',
): QueryOptions | undefined {
  if (!options) return undefined;
  return {
    ...options,
    ...(options.source ? { source: `${options.source}.${operation}` } : {}),
  };
}

export type WorkspaceSelection = 'all' | { rootEntities: readonly string[] };

export interface ResolvedWorkspaceOperation {
  readonly rootEntities: string[];
  readonly publisherPeerId?: string;
}

interface WorkspaceOperationPublicSnapshot {
  readonly quads: Quad[];
  readonly publisherPeerId?: string;
}

interface LegacyWorkspaceOperationPublicSnapshot extends WorkspaceOperationPublicSnapshot {
  readonly complete: boolean;
  readonly missingRoots: string[];
}

interface CompactWorkspaceOperationPublicSnapshot extends WorkspaceOperationPublicSnapshot {
  readonly complete: boolean;
  readonly missingRoots: string[];
  readonly staleRoots: string[];
}

export interface KnowledgeAssetOperationPublicSnapshot {
  readonly quads: Quad[];
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly publisherPeerId?: string;
}

/** Immutable operation snapshot is absent, not corrupt. */
export class KnowledgeAssetOperationPublicSnapshotNotFoundError extends Error {
  readonly code = 'KA_OPERATION_PUBLIC_SNAPSHOT_NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeAssetOperationPublicSnapshotNotFoundError';
  }
}

/** A durable graph-scoped workspace head exists but is incomplete or invalid. */
export class KnowledgeAssetWorkspaceHeadCorruptError extends Error {
  readonly code = 'KA_WORKSPACE_HEAD_CORRUPT';

  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeAssetWorkspaceHeadCorruptError';
  }
}

/**
 * The ONE way to recognize a corrupt-head outcome at any boundary. Matches by
 * `code` as well as `instanceof` deliberately: the error crosses package
 * boundaries (agent preflight -> publisher classifier -> CLI route), where a
 * re-wrap or a dual package instance can preserve `.code` while losing class
 * identity — and each consumer choosing its own raw check is how a single
 * boundary contract drifts. Callers pick only their local response policy.
 */
export function isKnowledgeAssetWorkspaceHeadCorruptError(
  error: unknown,
): boolean {
  if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) return true;
  // Throw-safe by contract: this predicate runs inside catch/failure-recording
  // paths against arbitrary cross-package thrown values, so inspecting the
  // value must never itself throw (a Proxy or a throwing `code` getter would
  // otherwise detonate mid-classification and mask the original failure).
  try {
    return (error as { code?: unknown } | null | undefined)?.code === 'KA_WORKSPACE_HEAD_CORRUPT';
  } catch {
    return false;
  }
}

/** Durable last-applied state for one graph-scoped KA in SWM. */
export interface KnowledgeAssetWorkspaceHead {
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly assertionGraph: string;
  readonly publicQuadsDigest: string;
  readonly publicTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly privateTripleCount: number;
  readonly shareOperationId: string;
  /** Canonical durable operation timestamp, normalized to decimal milliseconds. */
  readonly publishedAt?: TimestampMsV1;
  /** Transport owner retained at KA granularity; replaces per-subject ownership rows. */
  readonly publisherPeerId: string;
  readonly accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  readonly allowedPeers: string[];
}

export interface PublishedKnowledgeAssetWorkspaceHead extends KnowledgeAssetWorkspaceHead {
  readonly publishedAt: TimestampMsV1;
}

export interface ResolveKnowledgeAssetWorkspaceHeadParams {
  readonly store: TripleStore;
  readonly graphManager: GraphManager;
  readonly contextGraphId: string;
  readonly kaUal: string;
  readonly subGraphName?: string;
}

/**
 * Distinct object values per predicate for one subject's rows — the resolver's
 * one row-collection shape, shared by the head and operation phases so their
 * cardinality handling cannot drift apart.
 */
function collectSubjectValues(
  bindings: readonly Record<string, string | undefined>[],
): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const binding of bindings) {
    const predicate = binding['p'] ?? '';
    const object = binding['o'] ?? '';
    const list = values.get(predicate) ?? [];
    if (!list.includes(object)) list.push(object);
    values.set(predicate, list);
  }
  return values;
}

/**
 * Declared-cardinality accessors over one subject's collected values. Every
 * singleton predicate goes through `required`/`optional` — a duplicate is the
 * union-residue corruption class and fails closed with the offending values
 * named. Set-valued (`allowedPeer`) and canonicalized (`publishedAt`)
 * predicates are read from the map directly by the resolver, which owns those
 * two declared exceptions.
 */
function makeSingletonReader(
  values: Map<string, string[]>,
  ual: string,
  subjectNoun: 'head' | 'operation',
): {
  required: (predicate: string, label: string) => string;
  optional: (predicate: string, label: string) => string | undefined;
} {
  const read = (predicate: string, label: string, required: boolean): string | undefined => {
    const list = values.get(predicate);
    if (!list || list.length === 0) {
      if (!required) return undefined;
      throw new KnowledgeAssetWorkspaceHeadCorruptError(
        `Corrupt graph-scoped SWM head for ${ual}: incomplete head or operation metadata`,
      );
    }
    if (list.length > 1) {
      const rendered = list
        .map((value) => stripLiteral(value)?.trim())
        .filter((value): value is string => Boolean(value))
        .sort();
      throw new KnowledgeAssetWorkspaceHeadCorruptError(
        `Corrupt graph-scoped SWM head for ${ual}: ${subjectNoun} carries ` +
        `${list.length} ${label} values (${rendered.join(', ')})`,
      );
    }
    return list[0];
  };
  return {
    required: (predicate, label) => read(predicate, label, true)!,
    optional: (predicate, label) => read(predicate, label, false),
  };
}

/**
 * Resolve the latest complete graph-scoped assertion accepted into SWM.
 * Missing means this node has not accepted this KA yet; malformed rows fail
 * closed so a corrupt head cannot allow an older assertion to overwrite data.
 */
export async function resolveKnowledgeAssetWorkspaceHead(
  params: ResolveKnowledgeAssetWorkspaceHeadParams,
): Promise<KnowledgeAssetWorkspaceHead | undefined> {
  const scope = createGraphKnowledgeAssetScope(params.kaUal, 1);
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const metaGraph = params.graphManager.sharedMemoryMetaUri(
    params.contextGraphId,
    subGraphName,
  );
  const subject = workspaceKnowledgeAssetHeadSubject(scope.ual);
  // Phase 1 — the head subject's OWN rows. GH#2273: sync's bulk verified-meta
  // write is a bare set-union with no per-subject delete, so a peer's head row
  // for the same KA can land BESIDE the local one; a joined LIMIT-1 read over
  // that state handed every consumer (gossip monotonicity, finalization,
  // access decisions, the queued VM-publish preflight) an arbitrary answer
  // that could change between calls. Reading the head rows first makes the
  // exactly-one invariant primary: each required head predicate must carry
  // exactly ONE distinct value, and only a single validated operation id ever
  // reaches the operation lookup below. Duplicate rows on the OPERATION
  // subject (two cores ACKing the same content stamp their own clocks onto
  // the same deterministic operation subject) stay healthy — they never touch
  // the head subject this phase inspects.
  const headResult = await params.store.query(
    `SELECT ?p ?o WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ` +
    `<${assertSafeIri(subject)}> ?p ?o } }`,
  );
  if (headResult.type !== 'bindings') {
    throw new Error(
      `Unexpected graph-scoped SWM head query result for ${scope.ual}: ${headResult.type}`,
    );
  }
  if (headResult.bindings.length === 0) return undefined;
  const headValues = collectSubjectValues(headResult.bindings);
  const head = makeSingletonReader(headValues, scope.ual, 'head');
  const requiredHeadValue = head.required;
  if (parseIntegerLiteral(requiredHeadValue(`${DKG}contentScopeVersion`, 'contentScopeVersion'))
    !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: invalid scope version`,
    );
  }
  const actualUal = requiredHeadValue(`${DKG}kaUal`, 'kaUal');
  let assertionVersion: bigint;
  let actualScope: ReturnType<typeof createGraphKnowledgeAssetScope>;
  try {
    assertionVersion = parsePositiveBigIntLiteral(requiredHeadValue(`${DKG}assertionVersion`, 'assertionVersion'));
    actualScope = createGraphKnowledgeAssetScope(actualUal ?? '', assertionVersion);
  } catch (error) {
    if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) throw error;
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: invalid assertion identity ` +
      `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (actualScope.ual !== scope.ual) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: UAL mismatch`,
    );
  }
  const assertionGraph = requiredHeadValue(`${DKG}assertionGraph`, 'assertionGraph');
  const expectedGraph = knowledgeAssetLayerGraphUri(
    params.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    actualScope,
    subGraphName,
  );
  if (assertionGraph !== expectedGraph) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: assertion graph mismatch`,
    );
  }
  const shareOperationId = stripLiteral(requiredHeadValue(`${DKG}shareOperationId`, 'shareOperationId'))?.trim() ?? '';
  if (!shareOperationId) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: incomplete head or operation metadata`,
    );
  }
  let operationSubject = '';
  try {
    operationSubject = workspaceOperationSubject(params.contextGraphId, shareOperationId);
  } catch (error) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: invalid share operation ` +
      `(${error instanceof Error ? error.message : String(error)})`,
    );
  }

  // Phase 2 — the single validated operation, read as its OWN rows and
  // normalized under DECLARED cardinality rules (no LIMIT-1 first-binding
  // policy anywhere in the resolver): every commitment/envelope predicate must
  // carry exactly one distinct value; `allowedPeer` is set-valued by design;
  // `publishedAt` tolerates duplicates — two cores ACKing the same content
  // stamp their own clocks onto the same deterministic operation subject —
  // and canonicalizes to the EARLIEST stamp, which stays stable when a later
  // union adds more re-stamps (this timestamp orders RFC64 inventory).
  const operationResult = await params.store.query(
    `SELECT ?p ?o WHERE { GRAPH <${assertSafeIri(metaGraph)}> { ` +
    `<${assertSafeIri(operationSubject)}> ?p ?o } }`,
  );
  if (operationResult.type !== 'bindings') {
    throw new Error(
      `Unexpected graph-scoped SWM operation query result for ${scope.ual}: ${operationResult.type}`,
    );
  }
  const operationValues = collectSubjectValues(operationResult.bindings);
  const operation = makeSingletonReader(operationValues, scope.ual, 'operation');
  const singletonOperationValue = (
    predicate: string,
    label: string,
    required: boolean,
  ): string | undefined => (required ? operation.required(predicate, label) : operation.optional(predicate, label));
  // Id echo — the operation must itself carry the head's id (mirrors the
  // previous join). Multiple id rows on the operation subject were tolerated
  // by the join (only the matching one bound) and remain tolerated here.
  const echoedIds = (operationValues.get(`${DKG}shareOperationId`) ?? [])
    .map((value) => stripLiteral(value)?.trim());
  if (!echoedIds.includes(shareOperationId)) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: incomplete head or operation metadata`,
    );
  }
  const publicQuadsDigest = stripLiteral(singletonOperationValue(`${DKG}publicQuadsDigest`, 'publicQuadsDigest', true))?.trim() ?? '';
  const publicTripleCount = parseIntegerLiteral(singletonOperationValue(`${DKG}publicQuadsCount`, 'publicQuadsCount', true));
  const privateTripleCount = parseIntegerLiteral(singletonOperationValue(`${DKG}privateTripleCount`, 'privateTripleCount', true));
  const publisherPeerId = stripLiteral(singletonOperationValue(`${DKG}publisherPeerId`, 'publisherPeerId', true))?.trim() ?? '';
  const operationUal = singletonOperationValue(`${DKG}kaUal`, 'kaUal', true) ?? '';
  const privateMerkleRoot = stripLiteral(singletonOperationValue(`${DKG}privateMerkleRoot`, 'privateMerkleRoot', false))?.trim();
  const rawAccessPolicy = stripLiteral(singletonOperationValue(`${DKG}accessPolicy`, 'accessPolicy', false))?.trim();
  const accessPolicy = rawAccessPolicy === 'public'
    || rawAccessPolicy === 'ownerOnly'
    || rawAccessPolicy === 'allowList'
    ? rawAccessPolicy
    : undefined;
  const publishedAtStamps = (operationValues.get(`${DKG}publishedAt`) ?? [])
    .map((value) => {
      const lexical = stripLiteral(value)?.trim() ?? '';
      return { lexical, ms: Date.parse(lexical) };
    });
  const publishedAtMs = publishedAtStamps.length === 0
    ? undefined
    : publishedAtStamps.reduce((min, stamp) => Math.min(min, stamp.ms), Number.POSITIVE_INFINITY);
  let operationVersion: bigint;
  try {
    operationVersion = parsePositiveBigIntLiteral(singletonOperationValue(`${DKG}assertionVersion`, 'assertionVersion', true));
  } catch (error) {
    if (error instanceof KnowledgeAssetWorkspaceHeadCorruptError) throw error;
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: invalid operation version ` +
      `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (
    !publicQuadsDigest ||
    !Number.isSafeInteger(publicTripleCount) || publicTripleCount < 0 ||
    !Number.isSafeInteger(privateTripleCount) || privateTripleCount < 0 ||
    !publisherPeerId ||
    publishedAtStamps.some((stamp) => !Number.isSafeInteger(stamp.ms) || stamp.ms < 0) ||
    operationUal !== actualScope.ual ||
    operationVersion.toString() !== actualScope.assertionVersion ||
    (privateTripleCount > 0 && !/^0x[0-9a-f]{64}$/i.test(privateMerkleRoot ?? '')) ||
    (privateTripleCount === 0 && privateMerkleRoot !== undefined)
    || (rawAccessPolicy !== undefined && accessPolicy === undefined)
  ) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: incomplete commitment metadata`,
    );
  }

  const allowedPeers = [...new Set((operationValues.get(`${DKG}allowedPeer`) ?? [])
    .map((value) => stripLiteral(value)?.trim())
    .filter((peer): peer is string => Boolean(peer)))];
  if (
    (accessPolicy === 'allowList' && allowedPeers.length === 0)
    || (accessPolicy !== 'allowList' && allowedPeers.length > 0)
  ) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${scope.ual}: invalid access envelope`,
    );
  }
  return {
    kaUal: actualScope.ual,
    assertionVersion: actualScope.assertionVersion,
    assertionGraph,
    publicQuadsDigest,
    publicTripleCount,
    privateMerkleRoot,
    privateTripleCount,
    shareOperationId,
    ...(publishedAtMs === undefined
      ? {}
      : { publishedAt: publishedAtMs.toString() as TimestampMsV1 }),
    publisherPeerId,
    ...(accessPolicy ? { accessPolicy } : {}),
    allowedPeers,
  };
}

/** Resolve an inventory-ready SWM head with its canonical operation timestamp. */
export async function resolvePublishedKnowledgeAssetWorkspaceHead(
  params: ResolveKnowledgeAssetWorkspaceHeadParams,
): Promise<PublishedKnowledgeAssetWorkspaceHead | undefined> {
  const head = await resolveKnowledgeAssetWorkspaceHead(params);
  if (head === undefined) return undefined;
  if (head.publishedAt === undefined) {
    throw new KnowledgeAssetWorkspaceHeadCorruptError(
      `Corrupt graph-scoped SWM head for ${head.kaUal}: missing canonical publishedAt`,
    );
  }
  return Object.freeze({ ...head, publishedAt: head.publishedAt });
}

/** Replace the durable current-assertion pointer after data and snapshot land. */
export async function storeKnowledgeAssetWorkspaceHead(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  kaUal: string;
  assertionVersion: string | number | bigint;
  shareOperationId: string;
  subGraphName?: string;
  queryOptions?: QueryOptions;
}): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(params.kaUal, params.assertionVersion);
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const metaGraph = params.graphManager.sharedMemoryMetaUri(
    params.contextGraphId,
    subGraphName,
  );
  const subject = workspaceKnowledgeAssetHeadSubject(scope.ual);
  const assertionGraph = knowledgeAssetLayerGraphUri(
    params.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope,
    subGraphName,
  );
  await params.store.deleteByPattern(
    { graph: metaGraph, subject },
    workspaceHeadStoreOptions(params.queryOptions, 'deleteByPattern'),
  );
  const rows: Quad[] = [
    { subject, predicate: `${DKG}contentScopeVersion`, object: intLit(GRAPH_KA_CONTENT_SCOPE_VERSION), graph: metaGraph },
    { subject, predicate: `${DKG}kaUal`, object: scope.ual, graph: metaGraph },
    { subject, predicate: `${DKG}assertionVersion`, object: intLit(BigInt(scope.assertionVersion)), graph: metaGraph },
    { subject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: metaGraph },
    { subject, predicate: `${DKG}shareOperationId`, object: lit(params.shareOperationId), graph: metaGraph },
  ];
  await params.store.insert(
    rows,
    workspaceHeadStoreOptions(params.queryOptions, 'insert'),
  );
}

export async function resolveWorkspaceSelection(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  selection: WorkspaceSelection;
  subGraphName?: string;
}): Promise<Quad[]> {
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const workspaceGraph = params.graphManager.sharedMemoryUri(params.contextGraphId, subGraphName);
  const sparql = buildWorkspaceSelectionQuery(workspaceGraph, params.contextGraphId, params.selection);
  const result = await params.store.query(sparql);
  const quads: Quad[] = result.type === 'quads'
    ? result.quads.map((quad: Quad) => ({ ...quad, graph: '' }))
    : [];

  if (quads.length === 0) {
    throw new Error(`No quads in shared memory for context graph ${params.contextGraphId} matching selection`);
  }

  return quads;
}

export async function storeWorkspaceOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  rootEntities: readonly string[];
  // Retained for API compatibility; new metadata stores roots, not serialized payloads.
  quads: readonly Quad[];
  publisherPeerId?: string;
  /**
   * Durable on-chain agent identifier (EVM address, bare `0x…`). When
   * supplied, both the share-operation `prov:wasAttributedTo` (via
   * `generateShareMetadata`) and the per-root attribution emit
   * `<did:dkg:agent:0x…>` URIs. When omitted, attribution falls back to
   * `lit(publisherPeerId)` — preserves behaviour for the gossip-received
   * `SharedMemoryHandler` path until peer-ID → agent-address resolution
   * is wired in there. See GH #748.
   */
  agentAddress?: string;
  subGraphName?: string;
  timestamp?: Date;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<void> {
  const roots = normalizeRoots(params.rootEntities);
  if (roots.length === 0) return;

  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, subGraphName);
  const operationSubject = workspaceOperationSubject(params.contextGraphId, params.shareOperationId);
  const publisherPeerId = params.publisherPeerId?.trim() || 'unknown';
  const agentAddress = params.agentAddress?.trim() || undefined;
  const timestamp = params.timestamp ?? new Date();

  for (const root of roots) {
    const legacySubject = workspaceOperationPublicSliceSubject(
      params.contextGraphId,
      params.shareOperationId,
      root,
      subGraphName,
    );
    await params.store.deleteByPattern({ graph: workspaceMetaGraph, subject: legacySubject });
  }

  await params.store.deleteByPattern({ graph: workspaceMetaGraph, subject: operationSubject });
  await params.store.insert(generateShareMetadata(
    {
      shareOperationId: params.shareOperationId,
      contextGraphId: params.contextGraphId,
      rootEntities: roots,
      publisherPeerId,
      agentAddress,
      timestamp,
      subGraphName,
    },
    workspaceMetaGraph,
  ));

  const normalizedQuads = params.quads.map((quad) => ({ ...quad, graph: '' }));
  const snapshotQuads: Quad[] = [];
  for (const root of roots) {
    const subject = workspaceOperationPublicSliceSubject(
      params.contextGraphId,
      params.shareOperationId,
      root,
      subGraphName,
    );
    const rootQuads = filterQuadsForRoot(normalizedQuads, root);
    const digest = workspacePublicQuadsDigest(rootQuads);
    let snapshotGraph: string | undefined;
    if (params.publicSnapshotStore) {
      // The store keys the snapshot by its digest (`ref === digest`), so the
      // digest row below is the only pointer needed (RFC ka-metadata-trim
      // Phase 2 — no more `dkg:publicSnapshotRef` duplicate).
      await params.publicSnapshotStore.putSnapshot({ digest, quads: rootQuads });
    } else {
      snapshotGraph = workspaceOperationPublicSnapshotGraph(
        params.contextGraphId,
        params.shareOperationId,
        root,
        subGraphName,
      );
      await params.store.dropGraph(snapshotGraph);
      if (rootQuads.length > 0) {
        await params.store.insert(rootQuads.map((quad) => ({ ...quad, graph: snapshotGraph! })));
      }
    }
    snapshotQuads.push(
      { subject, predicate: `${DKG}contextGraphId`, object: lit(params.contextGraphId), graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}shareOperationId`, object: lit(params.shareOperationId), graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}publicSliceRootEntity`, object: root, graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}publicQuadsDigest`, object: lit(digest), graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}publicQuadsCount`, object: intLit(rootQuads.length), graph: workspaceMetaGraph },
      // GH #748: dedicated `dkg:publisherPeerId` field for peer-ID-bound reads
      // (resolveCompactWorkspaceOperationPublicQuads / Legacy variant + finalization);
      // `prov:wasAttributedTo` carries the durable agent DID URI when known.
      { subject, predicate: `${DKG}publisherPeerId`, object: lit(publisherPeerId), graph: workspaceMetaGraph },
      { subject, predicate: `${PROV}wasAttributedTo`, object: agentAddress ? agentDid(agentAddress) : lit(publisherPeerId), graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}publishedAt`, object: dateLit(timestamp), graph: workspaceMetaGraph },
    );
    // RFC ka-metadata-trim Phase 2: `dkg:publicSnapshotRef` is no longer
    // written — `FileWorkspacePublicSnapshotStore.putSnapshot` returns
    // `ref === digest`, so the row was byte-identical to
    // `dkg:publicQuadsDigest`. A store-backed snapshot row is now identified
    // by "digest present AND no `dkg:publicSnapshotGraph` row"; readers are
    // read-both (an explicit legacy ref row wins when present).
    if (snapshotGraph) {
      snapshotQuads.push({ subject, predicate: `${DKG}publicSnapshotGraph`, object: snapshotGraph, graph: workspaceMetaGraph });
    }
    if (subGraphName) {
      snapshotQuads.push({ subject, predicate: `${DKG}subGraphName`, object: lit(subGraphName), graph: workspaceMetaGraph });
    }
  }
  await params.store.insert(snapshotQuads);
}

/**
 * Store one immutable public snapshot for one complete graph-scoped KA.
 * Metadata and snapshot count are constant in the number of RDF subjects.
 */
export async function storeKnowledgeAssetOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  kaUal: string;
  assertionVersion: string | number | bigint;
  quads: readonly Quad[];
  privateMerkleRoot?: Uint8Array;
  privateTripleCount?: number;
  publisherPeerId?: string;
  accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers?: readonly string[];
  agentAddress?: string;
  subGraphName?: string;
  timestamp?: Date;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<void> {
  const scope = createGraphKnowledgeAssetScope(params.kaUal, params.assertionVersion);
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(
    params.contextGraphId,
    subGraphName,
  );
  const operationSubject = workspaceOperationSubject(
    params.contextGraphId,
    params.shareOperationId,
  );
  const publisherPeerId = params.publisherPeerId?.trim() || 'unknown';
  const timestamp = params.timestamp ?? new Date();
  const normalizedQuads = params.quads.map((quad) => ({ ...quad, graph: '' }));
  const digest = workspacePublicQuadsDigest(normalizedQuads);
  let snapshotGraph: string | undefined;
  if (params.publicSnapshotStore) {
    await params.publicSnapshotStore.putSnapshot({ digest, quads: normalizedQuads });
  } else {
    snapshotGraph = workspaceKnowledgeAssetOperationSnapshotGraph(
      params.contextGraphId,
      params.shareOperationId,
      subGraphName,
    );
    await params.store.dropGraph(snapshotGraph);
    await params.store.insert(
      normalizedQuads.map((quad) => ({ ...quad, graph: snapshotGraph! })),
    );
  }

  await params.store.deleteByPattern({
    graph: workspaceMetaGraph,
    subject: operationSubject,
  });
  const metadata = generateKnowledgeAssetShareMetadata(
    {
      shareOperationId: params.shareOperationId,
      contextGraphId: params.contextGraphId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      publicTripleCount: normalizedQuads.length,
      privateMerkleRoot: params.privateMerkleRoot,
      privateTripleCount: params.privateTripleCount,
      publisherPeerId,
      accessPolicy: params.accessPolicy,
      allowedPeers: params.allowedPeers,
      agentAddress: params.agentAddress?.trim() || undefined,
      timestamp,
      subGraphName,
    },
    workspaceMetaGraph,
  );
  metadata.push({
    subject: operationSubject,
    predicate: `${DKG}publicQuadsDigest`,
    object: lit(digest),
    graph: workspaceMetaGraph,
  });
  if (snapshotGraph) {
    metadata.push({
      subject: operationSubject,
      predicate: `${DKG}publicSnapshotGraph`,
      object: snapshotGraph,
      graph: workspaceMetaGraph,
    });
  }
  await params.store.insert(metadata);
}

/** Resolve and integrity-check a complete graph-scoped KA operation snapshot. */
export async function resolveKnowledgeAssetOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  kaUal: string;
  assertionVersion: string | number | bigint;
  subGraphName?: string;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<KnowledgeAssetOperationPublicSnapshot> {
  const expectedScope = createGraphKnowledgeAssetScope(
    params.kaUal,
    params.assertionVersion,
  );
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(
    params.contextGraphId,
    subGraphName,
  );
  const subject = workspaceOperationSubject(params.contextGraphId, params.shareOperationId);
  const result = await params.store.query(
    `SELECT ?scopeVersion ?kaUal ?assertionVersion ?snapshotRef ?snapshotGraph ?digest ?count ?publisherPeerId WHERE {
      GRAPH <${assertSafeIri(workspaceMetaGraph)}> {
        <${assertSafeIri(subject)}> <${DKG}contentScopeVersion> ?scopeVersion ;
          <${DKG}kaUal> ?kaUal ;
          <${DKG}assertionVersion> ?assertionVersion ;
          <${DKG}publicQuadsDigest> ?digest ;
          <${DKG}publicQuadsCount> ?count .
        OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publicSnapshotRef> ?snapshotRef }
        OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publicSnapshotGraph> ?snapshotGraph }
        OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publisherPeerId> ?publisherPeerId }
      }
    } LIMIT 1`,
  );
  if (result.type !== 'bindings') {
    throw new Error(
      `Unexpected graph-scoped public snapshot query result for share operation ` +
      `${params.shareOperationId}: ${result.type}`,
    );
  }
  if (result.bindings.length === 0) {
    const existence = await params.store.query(
      `ASK { GRAPH <${assertSafeIri(workspaceMetaGraph)}> { ` +
      `<${assertSafeIri(subject)}> ?predicate ?object } }`,
    );
    if (existence.type !== 'boolean') {
      throw new Error(
        `Unexpected graph-scoped public snapshot existence result for share operation ` +
        `${params.shareOperationId}: ${existence.type}`,
      );
    }
    if (existence.value) {
      throw new Error(
        `Immutable graph-scoped public snapshot metadata is corrupt for ` +
        `share operation ${params.shareOperationId}`,
      );
    }
    throw new KnowledgeAssetOperationPublicSnapshotNotFoundError(
      `No graph-scoped public snapshot for context graph ${params.contextGraphId} ` +
      `share operation ${params.shareOperationId}`,
    );
  }

  const row = result.bindings[0];
  const scopeVersion = parseIntegerLiteral(row?.['scopeVersion']);
  const actualUal = stripLiteral(row?.['kaUal'])?.trim() ?? '';
  const actualVersion = stripLiteral(row?.['assertionVersion'])?.trim() ?? '';
  if (scopeVersion !== GRAPH_KA_CONTENT_SCOPE_VERSION) {
    throw new Error(`Share operation ${params.shareOperationId} is not graph-scoped v2`);
  }
  const actualScope = createGraphKnowledgeAssetScope(actualUal, actualVersion);
  if (
    actualScope.ual !== expectedScope.ual ||
    actualScope.assertionVersion !== expectedScope.assertionVersion
  ) {
    throw new Error(
      `Graph-scoped public snapshot identity mismatch for share operation ${params.shareOperationId}`,
    );
  }

  const expectedDigest = stripLiteral(row?.['digest'])?.trim();
  const expectedCount = parseIntegerLiteral(row?.['count']);
  const snapshotGraph = row?.['snapshotGraph'];
  const snapshotRef = stripLiteral(row?.['snapshotRef'])?.trim()
    ?? (snapshotGraph ? undefined : expectedDigest);
  let quads: Quad[] | null = null;
  if (snapshotRef) {
    if (!params.publicSnapshotStore) {
      throw new Error(`Snapshot store is required for share operation ${params.shareOperationId}`);
    }
    quads = await params.publicSnapshotStore.getSnapshot(snapshotRef);
  } else if (snapshotGraph) {
    if (!isSafeIri(snapshotGraph)) {
      throw new Error(
        `Immutable graph-scoped public snapshot metadata is corrupt for ` +
        `share operation ${params.shareOperationId}: unsafe snapshot graph`,
      );
    }
    quads = await resolveSnapshotGraphQuads(params.store, snapshotGraph);
  }
  if (!quads) {
    throw new KnowledgeAssetOperationPublicSnapshotNotFoundError(
      `Immutable graph-scoped public snapshot is missing for ` +
      `share operation ${params.shareOperationId}`,
    );
  }
  if (
    !expectedDigest ||
    !Number.isInteger(expectedCount) ||
    quads.length !== expectedCount ||
    workspacePublicQuadsDigest(quads) !== expectedDigest
  ) {
    throw new Error(
      `Immutable graph-scoped public snapshot is missing or corrupt for ` +
      `share operation ${params.shareOperationId}`,
    );
  }
  return {
    quads,
    kaUal: actualScope.ual,
    assertionVersion: actualScope.assertionVersion,
    publisherPeerId: stripLiteral(row?.['publisherPeerId'])?.trim() || undefined,
  };
}

/**
 * @internal — exported strictly for backwards compatibility with
 * external consumers that deep-imported this helper before
 * `@origintrail-official/dkg-publisher` had an `exports` map.
 * The only in-repo caller is `resolveWorkspaceQuads` in this file.
 */
export async function resolveWorkspaceOperation(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  subGraphName?: string;
}): Promise<ResolvedWorkspaceOperation> {
  const subGraphName = normalizeOptionalSubGraphName(params.subGraphName);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, subGraphName);
  const subject = workspaceOperationSubject(params.contextGraphId, params.shareOperationId);
  const result = await params.store.query(
    // GH #748: prefer the dedicated `dkg:publisherPeerId` literal; fall back
    // to a literal-form `prov:wasAttributedTo` for legacy/un-migrated rows
    // that only have the deprecated peer-ID-in-attribution shape. The
    // `FILTER(isLiteral(...))` guard skips post-fix rows where
    // `wasAttributedTo` carries an agent DID URI (which downstream contact
    // code would mis-interpret as a libp2p peer ID).
    `SELECT ?root ?publisherPeerId WHERE {
      GRAPH <${workspaceMetaGraph}> {
        OPTIONAL { <${subject}> <${DKG}rootEntity> ?root }
        OPTIONAL { <${subject}> <${DKG}publisherPeerId> ?pidField }
        OPTIONAL { <${subject}> <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
        BIND(COALESCE(?pidField, ?attrField) AS ?publisherPeerId)
      }
    }`,
  );

  if (result.type !== 'bindings') {
    throw new Error(`Unexpected shared-memory metadata query result for ${params.shareOperationId}: ${result.type}`);
  }

  const roots: string[] = [
    ...new Set(result.bindings.map((row: Record<string, string>) => stripLiteral(row['root'])).filter(isPresent)),
  ];
  if (roots.length === 0) {
    throw new Error(
      `No shared-memory roots found for context graph ${params.contextGraphId} share operation ${params.shareOperationId}`,
    );
  }

  const publisherPeerIds: string[] = [
    ...new Set(result.bindings.map((row: Record<string, string>) => stripLiteral(row['publisherPeerId'])).filter(isPresent)),
  ];
  return {
    rootEntities: roots,
    publisherPeerId: publisherPeerIds[0],
  };
}

export async function resolveLiftWorkspaceSlice(params: {
  store: TripleStore;
  graphManager: GraphManager;
  request: LiftPublishSnapshotRequest;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<LiftResolvedPublishSlice> {
  const request = params.request;
  const shareOperationId = request.shareOperationId;
  const subGraphName = normalizeOptionalSubGraphName(request.subGraphName);
  if (request.contentScopeVersion === GRAPH_KA_CONTENT_SCOPE_VERSION) {
    if (request.roots.length !== 0) {
      throw new Error('Graph-scoped Lift snapshot must not contain root entities');
    }
    if (
      request.kaUal === undefined
      || request.assertionVersion === undefined
      || request.publicTripleCount === undefined
      || request.privateTripleCount === undefined
    ) {
      throw new Error('Graph-scoped Lift snapshot is missing its KA content envelope');
    }
    if (
      !Number.isSafeInteger(request.publicTripleCount)
      || request.publicTripleCount < 0
      || !Number.isSafeInteger(request.privateTripleCount)
      || request.privateTripleCount < 0
      || (request.publicTripleCount === 0 && request.privateTripleCount === 0)
    ) {
      throw new Error('Graph-scoped Lift snapshot has invalid public/private triple counts');
    }
    const scope = createGraphKnowledgeAssetScope(request.kaUal, request.assertionVersion);
    const publicSnapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store: params.store,
      graphManager: params.graphManager,
      contextGraphId: request.contextGraphId,
      shareOperationId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      subGraphName,
      publicSnapshotStore: params.publicSnapshotStore,
    });
    if (publicSnapshot.quads.length !== request.publicTripleCount) {
      throw new Error(
        `Graph-scoped Lift public triple count mismatch for ${scope.ual}: ` +
          `snapshot=${publicSnapshot.quads.length}, request=${request.publicTripleCount}`,
      );
    }
    const privateStore = new PrivateContentStore(params.store, params.graphManager);
    const privateQuads = await privateStore.getKnowledgeAssetPrivateTriples(
      request.contextGraphId,
      scope,
      subGraphName,
    );
    if (privateQuads.length !== request.privateTripleCount) {
      throw new Error(
        `Graph-scoped Lift private triple count mismatch for ${scope.ual}: ` +
          `store=${privateQuads.length}, request=${request.privateTripleCount}`,
      );
    }
    const privateRoot = computePrivateRoot(privateQuads);
    const actualPrivateRoot = privateRoot ? `0x${toHex(privateRoot)}`.toLowerCase() : undefined;
    const expectedPrivateRoot = request.privateMerkleRoot?.toLowerCase();
    if (actualPrivateRoot !== expectedPrivateRoot) {
      throw new Error(
        `Graph-scoped Lift private Merkle commitment mismatch for ${scope.ual}`,
      );
    }
    const publishContextGraphId = await resolveOnChainContextGraphId({
      store: params.store,
      contextGraphId: request.contextGraphId,
    });
    return {
      quads: publicSnapshot.quads,
      privateQuads: privateQuads.length > 0 ? privateQuads : undefined,
      publisherPeerId: publicSnapshot.publisherPeerId,
      accessPolicy: request.accessPolicy,
      allowedPeers: request.allowedPeers ? [...request.allowedPeers] : undefined,
      publishContextGraphId,
    };
  }
  // Raw Lift jobs retain their existing root-scoped staging contract until
  // the dedicated mutation-cutover PR. Named KA jobs are guarded at enqueue
  // and therefore never reach this compatibility branch.
  const requestedRoots = normalizeRoots(request.roots);
  if (requestedRoots.length === 0) {
    throw new Error(`No valid Lift shared-memory roots provided for context graph ${request.contextGraphId}`);
  }

  let operation: ResolvedWorkspaceOperation | undefined;
  try {
    operation = await resolveWorkspaceOperation({
      store: params.store,
      graphManager: params.graphManager,
      contextGraphId: request.contextGraphId,
      shareOperationId,
      subGraphName,
    });
  } catch (err) {
    if (!isMissingWorkspaceOperationError(err)) {
      throw err;
    }
  }

  if (operation) {
    const missing = requestedRoots.filter((root) => !operation.rootEntities.includes(root));
    if (missing.length > 0) {
      throw new Error(
        `Lift shared-memory resolution roots are not part of share operation ${shareOperationId}: ${missing.join(', ')}`,
      );
    }
  }

  const publicSnapshot = await resolveWorkspaceOperationPublicQuads({
    store: params.store,
    graphManager: params.graphManager,
    contextGraphId: request.contextGraphId,
    shareOperationId,
    roots: requestedRoots,
    subGraphName,
    operation,
    publicSnapshotStore: params.publicSnapshotStore,
  });
  const privateStore = new PrivateContentStore(params.store, params.graphManager);
  const privateQuads = (
    await Promise.all(
      requestedRoots.map((root) =>
        privateStore.getPrivateTriplesForOperation(
          request.contextGraphId,
          shareOperationId,
          root,
          subGraphName,
        ),
      ),
    )
  ).flat();
  const publishContextGraphId = await resolveOnChainContextGraphId({
    store: params.store,
    contextGraphId: request.contextGraphId,
  });
  return {
    quads: publicSnapshot.quads,
    privateQuads: privateQuads.length > 0 ? privateQuads : undefined,
    publisherPeerId: operation?.publisherPeerId ?? publicSnapshot.publisherPeerId,
    accessPolicy: request.accessPolicy,
    allowedPeers: request.allowedPeers ? [...request.allowedPeers] : undefined,
    publishContextGraphId,
  };
}

async function resolveWorkspaceOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  roots: readonly string[];
  subGraphName?: string;
  operation?: ResolvedWorkspaceOperation;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<WorkspaceOperationPublicSnapshot> {
  const roots = normalizeRoots(params.roots);
  const legacy = await resolveLegacyWorkspaceOperationPublicQuads(params);
  if (legacy.complete) {
    if (legacy.quads.length === 0) {
      throw new Error(
        `No public staged quads found for context graph ${params.contextGraphId} share operation ${params.shareOperationId}`,
      );
    }
    return {
      quads: legacy.quads,
      publisherPeerId: legacy.publisherPeerId,
    };
  }

  const compact = await resolveCompactWorkspaceOperationPublicQuads(params);
  if (compact.staleRoots.length > 0) {
    throw new Error(
      `Immutable public snapshot for shared-memory operation ${params.shareOperationId} is missing or corrupt for roots: ${compact.staleRoots.join(', ')}`,
    );
  }

  if (compact.complete) {
    if (compact.quads.length === 0) {
      throw new Error(
        `No public staged quads found for context graph ${params.contextGraphId} share operation ${params.shareOperationId}`,
      );
    }
    return {
      quads: compact.quads,
      publisherPeerId: compact.publisherPeerId ?? params.operation?.publisherPeerId,
    };
  }

  if (!params.operation || compact.missingRoots.length > 0) {
    const missingRoots = compact.missingRoots.length > 0 ? compact.missingRoots : legacy.missingRoots;
    throw new Error(
      `No immutable public snapshot metadata found for context graph ${params.contextGraphId} share operation ${params.shareOperationId} roots: ${missingRoots.join(', ')}`,
    );
  }

  throw new Error(
    `No immutable public snapshot metadata found for context graph ${params.contextGraphId} share operation ${params.shareOperationId} roots: ${roots.join(', ')}`,
  );
}

async function resolveCompactWorkspaceOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  roots: readonly string[];
  subGraphName?: string;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<CompactWorkspaceOperationPublicSnapshot> {
  const roots = normalizeRoots(params.roots);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, params.subGraphName);
  const quads: Quad[] = [];
  const publisherPeerIds: string[] = [];
  const missingRoots: string[] = [];
  const staleRoots: string[] = [];

  for (const root of roots) {
    const subject = workspaceOperationPublicSliceSubject(
      params.contextGraphId,
      params.shareOperationId,
      root,
      params.subGraphName,
    );
    const result = await params.store.query(
      `SELECT ?snapshotRef ?snapshotGraph ?digest ?count ?publisherPeerId WHERE {
        GRAPH <${assertSafeIri(workspaceMetaGraph)}> {
          <${assertSafeIri(subject)}> <${DKG}publicQuadsDigest> ?digest ;
            <${DKG}publicQuadsCount> ?count .
          OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publicSnapshotRef> ?snapshotRef }
          OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publicSnapshotGraph> ?snapshotGraph }
          # GH #748: prefer dedicated peer-ID field; fall back to a literal
          # wasAttributedTo for legacy/un-migrated snapshots. Skip URI form
          # (agent DID) — that's not a peer ID.
          OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publisherPeerId> ?pidField }
          OPTIONAL { <${assertSafeIri(subject)}> <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
          BIND(COALESCE(?pidField, ?attrField) AS ?publisherPeerId)
        }
      } LIMIT 1`,
    );

    if (result.type !== 'bindings' || result.bindings.length === 0) {
      missingRoots.push(root);
      continue;
    }

    const expectedDigest = stripLiteral(result.bindings[0]?.['digest'])?.trim();
    const expectedCount = parseIntegerLiteral(result.bindings[0]?.['count']);
    const snapshotGraph = result.bindings[0]?.['snapshotGraph'];
    // Read-both (RFC ka-metadata-trim Phase 2): an explicit legacy
    // `dkg:publicSnapshotRef` row wins (old stores); otherwise a row with a
    // digest and NO snapshot graph is store-backed and its ref IS the digest
    // (`putSnapshot` returns `ref === digest`).
    const snapshotRef = stripLiteral(result.bindings[0]?.['snapshotRef'])?.trim()
      ?? (snapshotGraph ? undefined : expectedDigest);
    if (!expectedDigest || !Number.isInteger(expectedCount)) {
      missingRoots.push(root);
      continue;
    }

    let snapshotQuads: Quad[] | null = null;
    if (snapshotRef) {
      if (!params.publicSnapshotStore) {
        missingRoots.push(root);
        continue;
      }
      snapshotQuads = await params.publicSnapshotStore.getSnapshot(snapshotRef);
    } else if (snapshotGraph && isSafeIri(snapshotGraph)) {
      snapshotQuads = await resolveSnapshotGraphQuads(params.store, snapshotGraph);
    }
    if (!snapshotQuads) {
      missingRoots.push(root);
      continue;
    }
    const snapshotDigest = workspacePublicQuadsDigest(snapshotQuads);
    if (snapshotDigest !== expectedDigest || snapshotQuads.length !== expectedCount) {
      staleRoots.push(root);
      continue;
    }

    quads.push(...snapshotQuads);
    const publisherPeerId = stripLiteral(result.bindings[0]?.['publisherPeerId'])?.trim();
    if (publisherPeerId) publisherPeerIds.push(publisherPeerId);
  }

  return {
    complete: missingRoots.length === 0 && staleRoots.length === 0,
    missingRoots,
    staleRoots,
    quads,
    publisherPeerId: publisherPeerIds[0],
  };
}

async function resolveLegacyWorkspaceOperationPublicQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  shareOperationId: string;
  roots: readonly string[];
  subGraphName?: string;
}): Promise<LegacyWorkspaceOperationPublicSnapshot> {
  const roots = normalizeRoots(params.roots);
  const workspaceMetaGraph = params.graphManager.sharedMemoryMetaUri(params.contextGraphId, params.subGraphName);
  const quads: Quad[] = [];
  const publisherPeerIds: string[] = [];
  const missingRoots: string[] = [];

  for (const root of roots) {
    const subject = workspaceOperationPublicSliceSubject(
      params.contextGraphId,
      params.shareOperationId,
      root,
      params.subGraphName,
    );
    const result = await params.store.query(
      `SELECT ?payload ?publisherPeerId WHERE {
        GRAPH <${assertSafeIri(workspaceMetaGraph)}> {
          <${assertSafeIri(subject)}> <${DKG}publicStagedQuads> ?payload .
          # GH #748: prefer dedicated peer-ID field; fall back to literal
          # wasAttributedTo for legacy snapshots. Skip URI form (agent DID).
          OPTIONAL { <${assertSafeIri(subject)}> <${DKG}publisherPeerId> ?pidField }
          OPTIONAL { <${assertSafeIri(subject)}> <${PROV}wasAttributedTo> ?attrField . FILTER(isLiteral(?attrField)) }
          BIND(COALESCE(?pidField, ?attrField) AS ?publisherPeerId)
        }
      } LIMIT 1`,
    );

    if (result.type !== 'bindings' || result.bindings.length === 0) {
      missingRoots.push(root);
      continue;
    }

    quads.push(...parseStoredPublicQuads(result.bindings[0]?.['payload'], params.shareOperationId, root));
    const publisherPeerId = stripLiteral(result.bindings[0]?.['publisherPeerId'])?.trim();
    if (publisherPeerId) publisherPeerIds.push(publisherPeerId);
  }

  return {
    complete: missingRoots.length === 0,
    missingRoots,
    quads,
    publisherPeerId: publisherPeerIds[0],
  };
}

async function resolveOnChainContextGraphId(params: {
  store: TripleStore;
  contextGraphId: string;
}): Promise<string | undefined> {
  const ontologyGraph = 'did:dkg:context-graph:ontology';
  const contextGraphUri = `did:dkg:context-graph:${params.contextGraphId}`;
  const result = await params.store.query(
    `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <https://dkg.network/ontology#ContextGraphOnChainId> ?id } } LIMIT 1`,
  );
  if (result.type !== 'bindings' || result.bindings.length === 0) return undefined;
  const value = stripLiteral(result.bindings[0]?.['id']);
  return value ? value.trim() : undefined;
}

function buildWorkspaceSelectionQuery(
  workspaceGraph: string,
  contextGraphId: string,
  selection: WorkspaceSelection,
): string {
  if (selection === 'all') {
    return `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${workspaceGraph}> { ?s ?p ?o } }`;
  }

  const roots = normalizeRoots(selection.rootEntities);
  if (roots.length === 0) {
    const hadInput = selection.rootEntities.length > 0;
    throw new Error(
      hadInput
        ? `No valid rootEntities provided (all ${selection.rootEntities.length} entries failed IRI validation)`
        : `No rootEntities provided for context graph ${contextGraphId}`,
    );
  }

  const values = roots.map((root) => `<${root}>`).join(' ');
  return `CONSTRUCT { ?s ?p ?o } WHERE {
    GRAPH <${workspaceGraph}> {
      VALUES ?root { ${values} }
      ?s ?p ?o .
      FILTER(
        ?s = ?root
        || STRSTARTS(STR(?s), CONCAT(STR(?root), "/.well-known/genid/"))
      )
    }
  }`;
}

function normalizeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => String(root).trim()).filter((root) => isSafeIri(root)))];
}

function normalizeOptionalSubGraphName(subGraphName: string | undefined): string | undefined {
  const normalized = subGraphName?.trim();
  if (!normalized) return undefined;

  const validation = validateSubGraphName(normalized);
  if (!validation.valid) {
    throw new Error(`Lift shared-memory resolution rejected invalid subGraphName "${subGraphName}": ${validation.reason}`);
  }
  return normalized;
}

function workspaceOperationSubject(contextGraphId: string, shareOperationId: string): string {
  const normalizedContextGraphId = safeWorkspaceIdPart(contextGraphId, 'contextGraphId');
  const normalizedShareOperationId = safeWorkspaceIdPart(shareOperationId, 'shareOperationId');
  const subject = `urn:dkg:share:${normalizedContextGraphId}:${normalizedShareOperationId}`;
  assertSafeIri(subject);
  return subject;
}

function workspaceKnowledgeAssetHeadSubject(kaUal: string): string {
  const scope = createGraphKnowledgeAssetScope(kaUal, 1);
  const subject = `${scope.ual}#dkg-swm-head`;
  assertSafeIri(subject);
  return subject;
}

function workspaceOperationPublicSliceSubject(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity]
    .map((part) => encodeURIComponent(part));
  const subject = `urn:dkg:public-stage:${parts.join(':')}`;
  assertSafeIri(subject);
  return subject;
}

function workspaceOperationPublicSnapshotGraph(
  contextGraphId: string,
  shareOperationId: string,
  rootEntity: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId, rootEntity]
    .map((part) => encodeURIComponent(part));
  const graph = `did:dkg:context-graph:${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/${parts[3]}/_shared_memory`;
  assertSafeIri(graph);
  return graph;
}

function workspaceKnowledgeAssetOperationSnapshotGraph(
  contextGraphId: string,
  shareOperationId: string,
  subGraphName?: string,
): string {
  const parts = [contextGraphId, subGraphName ?? '_', shareOperationId]
    .map((part) => encodeURIComponent(part));
  const graph = `did:dkg:context-graph:${parts[0]}/_shared_memory_snapshots/${parts[1]}/${parts[2]}/ka`;
  assertSafeIri(graph);
  return graph;
}

async function resolveSnapshotGraphQuads(store: TripleStore, snapshotGraph: string): Promise<Quad[]> {
  const result = await store.query(
    `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertSafeIri(snapshotGraph)}> { ?s ?p ?o } }`,
  );
  return result.type === 'quads'
    ? result.quads.map((quad) => ({ ...quad, graph: '' }))
    : [];
}

function parseStoredPublicQuads(value: string | undefined, shareOperationId: string, rootEntity: string): Quad[] {
  const payload = stripLiteral(value);
  if (typeof payload !== 'string') {
    throw new Error(`Invalid public staged quads for share operation ${shareOperationId} root ${rootEntity}`);
  }

  const parsed = JSON.parse(payload) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid public staged quads for share operation ${shareOperationId} root ${rootEntity}`);
  }

  return parsed.map((quad, index) => {
    if (!isRecord(quad)) {
      throw new Error(`Invalid public staged quad ${index} for share operation ${shareOperationId} root ${rootEntity}`);
    }
    return {
      subject: String(quad['subject'] ?? ''),
      predicate: String(quad['predicate'] ?? ''),
      object: String(quad['object'] ?? ''),
      graph: '',
    };
  });
}

function filterQuadsForRoot(quads: readonly Quad[], root: string): Quad[] {
  return quads.filter((quad) => quad.subject === root || quad.subject.startsWith(`${root}/.well-known/genid/`));
}

function lit(value: string): string {
  return JSON.stringify(value);
}

function intLit(value: number | bigint): string {
  return `"${value}"^^<${XSD}integer>`;
}

function dateLit(value: Date): string {
  return `"${value.toISOString()}"^^<${XSD}dateTime>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingWorkspaceOperationError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('No shared-memory roots found');
}

function stripLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, value.lastIndexOf('"'));
    }
  }
  return value;
}

function parseIntegerLiteral(value: string | undefined): number {
  const parsed = Number(stripLiteral(value));
  return Number.isInteger(parsed) ? parsed : NaN;
}

function parsePositiveBigIntLiteral(value: string | undefined): bigint {
  try {
    const parsed = BigInt(stripLiteral(value) ?? '');
    if (parsed < 1n) throw new Error('non-positive');
    return parsed;
  } catch {
    throw new Error(`Invalid positive integer literal: ${value ?? '(missing)'}`);
  }
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function safeWorkspaceIdPart(value: string, fieldName: 'contextGraphId' | 'shareOperationId'): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Shared-memory resolution requires a non-empty ${fieldName}`);
  }

  if (/[\s<>"{}|^`\\]/.test(normalized)) {
    throw new Error(`Shared-memory resolution rejected unsafe ${fieldName}: ${value}`);
  }

  return normalized;
}
