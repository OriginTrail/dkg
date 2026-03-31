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
  paranetId: string;
  selection: WorkspaceSelection;
}): Promise<Quad[]> {
  const workspaceGraph = params.graphManager.workspaceGraphUri(params.paranetId);
  const sparql = buildWorkspaceSelectionQuery(workspaceGraph, params.paranetId, params.selection);
  const result = await params.store.query(sparql);
  const quads = result.type === 'quads' ? result.quads.map((quad) => ({ ...quad, graph: '' })) : [];

  if (quads.length === 0) {
    throw new Error(`No quads in workspace for paranet ${params.paranetId} matching selection`);
  }

  return quads;
}

export async function resolveWorkspaceOperation(params: {
  store: TripleStore;
  graphManager: GraphManager;
  paranetId: string;
  workspaceOperationId: string;
}): Promise<ResolvedWorkspaceOperation> {
  const workspaceMetaGraph = params.graphManager.workspaceMetaGraphUri(params.paranetId);
  const subject = workspaceOperationSubject(params.paranetId, params.workspaceOperationId);
  const result = await params.store.query(
    `SELECT ?root ?publisherPeerId WHERE {
      GRAPH <${workspaceMetaGraph}> {
        OPTIONAL { <${subject}> <${DKG}rootEntity> ?root }
        OPTIONAL { <${subject}> <${PROV}wasAttributedTo> ?publisherPeerId }
      }
    }`,
  );

  if (result.type !== 'bindings') {
    throw new Error(`Unexpected workspace metadata query result for ${params.workspaceOperationId}: ${result.type}`);
  }

  const roots = [...new Set(result.bindings.map((row) => stripLiteral(row['root'])).filter(isPresent))];
  if (roots.length === 0) {
    throw new Error(
      `No workspace roots found for paranet ${params.paranetId} operation ${params.workspaceOperationId}`,
    );
  }

  const publisherPeerIds = [...new Set(result.bindings.map((row) => stripLiteral(row['publisherPeerId'])).filter(isPresent))];
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
  const workspaceId = params.request.workspaceId.trim();
  if (workspaceId.length === 0) {
    throw new Error('Lift workspace resolution requires a non-empty workspaceId');
  }

  const operation = await resolveWorkspaceOperation({
    store: params.store,
    graphManager: params.graphManager,
    paranetId: params.request.paranetId,
    workspaceOperationId: params.request.workspaceOperationId,
  });

  const requestedRoots = normalizeRoots(params.request.roots);
  const missing = requestedRoots.filter((root) => !operation.rootEntities.includes(root));
  if (missing.length > 0) {
    throw new Error(
      `Lift workspace resolution roots are not part of workspace operation ${params.request.workspaceOperationId}: ${missing.join(', ')}`,
    );
  }

  const quads = await resolveWorkspaceSelection({
    store: params.store,
    graphManager: params.graphManager,
    paranetId: params.request.paranetId,
    selection: { rootEntities: requestedRoots },
  });

  return {
    quads,
    publisherPeerId: operation.publisherPeerId,
  };
}

function buildWorkspaceSelectionQuery(
  workspaceGraph: string,
  paranetId: string,
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
        : `No rootEntities provided for paranet ${paranetId}`,
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

function workspaceOperationSubject(paranetId: string, workspaceOperationId: string): string {
  const normalizedParanetId = safeWorkspaceIdPart(paranetId, 'paranetId');
  const normalizedOperationId = safeWorkspaceIdPart(workspaceOperationId, 'workspaceOperationId');
  const subject = `urn:dkg:workspace:${normalizedParanetId}:${normalizedOperationId}`;
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

function safeWorkspaceIdPart(value: string, fieldName: 'paranetId' | 'workspaceOperationId'): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Workspace resolution requires a non-empty ${fieldName}`);
  }

  if (/[\s<>"{}|^`\\]/.test(normalized)) {
    throw new Error(`Workspace resolution rejected unsafe ${fieldName}: ${value}`);
  }

  return normalized;
}
