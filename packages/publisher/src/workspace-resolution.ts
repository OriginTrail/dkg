import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { GraphManager } from '@origintrail-official/dkg-storage';
import { assertSafeIri, isSafeIri } from '@origintrail-official/dkg-core';
import type { LiftRequest } from './lift-job.js';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';

const DKG = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';

export type WorkspaceSelection = 'all' | { rootEntities: readonly string[] };

export interface ResolvedWorkspaceOperation {
  readonly rootEntities: string[];
  readonly publisherPeerId?: string;
}

export async function resolveWorkspaceSelection(params: {
  store: TripleStore;
  graphManager: GraphManager;
  contextGraphId: string;
  selection: WorkspaceSelection;
}): Promise<Quad[]> {
  const workspaceGraph = params.graphManager.workspaceGraphUri(params.contextGraphId);
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
}): Promise<ResolvedWorkspaceOperation> {
  const workspaceMetaGraph = params.graphManager.workspaceMetaGraphUri(params.contextGraphId);
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
}): Promise<LiftResolvedPublishSlice> {
  const request = params.request;
  const shareOperationId = request.shareOperationId;

  const operation = await resolveWorkspaceOperation({
    store: params.store,
    graphManager: params.graphManager,
    contextGraphId: request.contextGraphId,
    shareOperationId,
  });

  const requestedRoots = normalizeRoots(request.roots);
  const missing = requestedRoots.filter((root) => !operation.rootEntities.includes(root));
  if (missing.length > 0) {
    throw new Error(
      `Lift shared-memory resolution roots are not part of share operation ${shareOperationId}: ${missing.join(', ')}`,
    );
  }

  const quads = await resolveWorkspaceSelection({
    store: params.store,
    graphManager: params.graphManager,
    contextGraphId: request.contextGraphId,
    selection: { rootEntities: requestedRoots },
  });

  const publishContextGraphId = await resolveOnChainContextGraphId({
    store: params.store,
    contextGraphId: request.contextGraphId,
  });

  return {
    quads,
    publisherPeerId: operation.publisherPeerId,
    publishContextGraphId,
  };
}

async function resolveOnChainContextGraphId(params: {
  store: TripleStore;
  contextGraphId: string;
}): Promise<string | undefined> {
  const ontologyGraph = 'did:dkg:context-graph:ontology';
  const contextGraphUri = `did:dkg:context-graph:${params.contextGraphId}`;
  const result = await params.store.query(
    `SELECT ?id WHERE { GRAPH <${ontologyGraph}> { <${contextGraphUri}> <https://dkg.network/ontology#ParanetOnChainId> ?id } } LIMIT 1`,
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

function workspaceOperationSubject(contextGraphId: string, shareOperationId: string): string {
  const normalizedContextGraphId = safeWorkspaceIdPart(contextGraphId, 'contextGraphId');
  const normalizedShareOperationId = safeWorkspaceIdPart(shareOperationId, 'shareOperationId');
  const subject = `urn:dkg:share:${normalizedContextGraphId}:${normalizedShareOperationId}`;
  assertSafeIri(subject);
  return subject;
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
