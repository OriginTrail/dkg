import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { assertSafeIri, isSafeIri, validateSubGraphName } from '@origintrail-official/dkg-core';
import type { LiftRequest } from './lift-job.js';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import { generateShareMetadata } from './metadata.js';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

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
    let snapshotRef: string | undefined;
    let snapshotGraph: string | undefined;
    if (params.publicSnapshotStore) {
      snapshotRef = (await params.publicSnapshotStore.putSnapshot({ digest, quads: rootQuads })).ref;
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
      { subject, predicate: `${PROV}wasAttributedTo`, object: lit(publisherPeerId), graph: workspaceMetaGraph },
      { subject, predicate: `${DKG}publishedAt`, object: dateLit(timestamp), graph: workspaceMetaGraph },
    );
    if (snapshotRef) {
      snapshotQuads.push({ subject, predicate: `${DKG}publicSnapshotRef`, object: lit(snapshotRef), graph: workspaceMetaGraph });
    }
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
    `SELECT ?root ?publisherPeerId WHERE {
      GRAPH <${workspaceMetaGraph}> {
        OPTIONAL { <${subject}> <${DKG}rootEntity> ?root }
        OPTIONAL { <${subject}> <${PROV}wasAttributedTo> ?publisherPeerId }
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
  request: LiftRequest;
  publicSnapshotStore?: WorkspacePublicSnapshotStore;
}): Promise<LiftResolvedPublishSlice> {
  const request = params.request;
  const shareOperationId = request.shareOperationId;
  const subGraphName = normalizeOptionalSubGraphName(request.subGraphName);
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
        privateStore.getPrivateTriplesForOperation(request.contextGraphId, shareOperationId, root, subGraphName),
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
          OPTIONAL { <${assertSafeIri(subject)}> <${PROV}wasAttributedTo> ?publisherPeerId }
        }
      } LIMIT 1`,
    );

    if (result.type !== 'bindings' || result.bindings.length === 0) {
      missingRoots.push(root);
      continue;
    }

    const expectedDigest = stripLiteral(result.bindings[0]?.['digest'])?.trim();
    const expectedCount = parseIntegerLiteral(result.bindings[0]?.['count']);
    const snapshotRef = stripLiteral(result.bindings[0]?.['snapshotRef'])?.trim();
    const snapshotGraph = result.bindings[0]?.['snapshotGraph'];
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
          OPTIONAL { <${assertSafeIri(subject)}> <${PROV}wasAttributedTo> ?publisherPeerId }
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

function intLit(value: number): string {
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
