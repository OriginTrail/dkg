import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { assertSafeRdfTerm } from '@origintrail-official/dkg-core';
import { GraphManager } from '@origintrail-official/dkg-storage';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import type { LiftJobValidationMetadata, LiftRequest } from './lift-job.js';

const DKG = 'http://dkg.io/ontology/';

export interface ExactQuadSubtractionResult {
  readonly resolved: LiftResolvedPublishSlice;
  readonly alreadyPublishedPublicCount: number;
  readonly alreadyPublishedPrivateCount: number;
}

export async function subtractFinalizedExactQuads(params: {
  store: TripleStore;
  graphManager: GraphManager;
  request: LiftRequest;
  validation: LiftJobValidationMetadata;
  resolved: LiftResolvedPublishSlice;
}): Promise<ExactQuadSubtractionResult> {
  if (params.request.transitionType !== 'CREATE') {
    return {
      resolved: params.resolved,
      alreadyPublishedPublicCount: 0,
      alreadyPublishedPrivateCount: 0,
    };
  }

  const confirmedRoots = await loadConfirmedRoots(params.store, params.graphManager, params.request.contextGraphId, params.validation.canonicalRoots);
  const authoritativePublic = await loadAuthoritativeQuadKeys(
    params.store,
    params.graphManager.dataGraphUri(params.request.contextGraphId),
    confirmedRoots,
  );
  const authoritativePrivate = await loadAuthoritativeQuadKeys(
    params.store,
    params.graphManager.privateGraphUri(params.request.contextGraphId),
    confirmedRoots,
  );

  const publicResult = subtractGraphExactMatches(params.resolved.quads, confirmedRoots, authoritativePublic);
  const privateResult = subtractGraphExactMatches(params.resolved.privateQuads ?? [], confirmedRoots, authoritativePrivate);

  return {
    resolved: {
      ...params.resolved,
      quads: publicResult.remaining,
      privateQuads: privateResult.remaining.length > 0 ? privateResult.remaining : undefined,
    },
    alreadyPublishedPublicCount: publicResult.removedCount,
    alreadyPublishedPrivateCount: privateResult.removedCount,
  };
}

async function loadConfirmedRoots(
  store: TripleStore,
  graphManager: GraphManager,
  contextGraphId: string,
  roots: readonly string[],
): Promise<Set<string>> {
  if (roots.length === 0) return new Set();
  const metaGraph = graphManager.metaGraphUri(contextGraphId);
  const values = roots.map((root) => safeStringLiteral(root)).join(' ');
  const result = await store.query(
    `SELECT DISTINCT ?root WHERE {
      GRAPH <${metaGraph}> {
        VALUES ?rootValue { ${values} }
        ?ka <${DKG}rootEntity> ?root ; <${DKG}partOf> ?kc .
        ?kc <${DKG}status> "confirmed" .
        FILTER(STR(?root) = ?rootValue)
      }
    }`,
  );

  if (result.type !== 'bindings') {
    return new Set();
  }

  return new Set(result.bindings.map((row) => stripTerm(row['root'])).filter(isPresent));
}

function subtractGraphExactMatches(
  quads: readonly Quad[],
  confirmedRoots: Set<string>,
  authoritativeQuadKeys: Set<string>,
): { remaining: Quad[]; removedCount: number } {
  const remaining: Quad[] = [];
  let removedCount = 0;

  for (const quad of quads) {
    const root = rootForSubject(quad.subject, confirmedRoots);
    if (!root) {
      remaining.push(quad);
      continue;
    }

    const exists = authoritativeQuadKeys.has(toQuadKey(quad));
    if (exists) {
      removedCount += 1;
    } else {
      remaining.push(quad);
    }
  }

  return { remaining, removedCount };
}

async function loadAuthoritativeQuadKeys(store: TripleStore, graph: string, confirmedRoots: Set<string>): Promise<Set<string>> {
  if (confirmedRoots.size === 0) {
    return new Set();
  }

  const values = [...confirmedRoots].map((root) => safeStringLiteral(root)).join(' ');
  const result = await store.query(
    `CONSTRUCT {
      ?s ?p ?o
    } WHERE {
      GRAPH <${graph}> {
        VALUES ?rootValue { ${values} }
        ?s ?p ?o .
        FILTER(
          STR(?s) = ?rootValue
          || STRSTARTS(STR(?s), CONCAT(?rootValue, "/.well-known/genid/"))
        )
      }
    }`,
  );

  if (result.type !== 'quads') {
    return new Set();
  }

  return new Set(result.quads.map((quad) => toQuadKey({ ...quad, graph: '' })));
}

function rootForSubject(subject: string, confirmedRoots: Set<string>): string | null {
  for (const root of confirmedRoots) {
    if (subject === root || subject.startsWith(`${root}/.well-known/genid/`)) {
      return root;
    }
  }
  return null;
}

function safeIri(value: string): string {
  const term = `<${value}>`;
  assertSafeRdfTerm(term);
  return term;
}

function safeStringLiteral(value: string): string {
  const term = JSON.stringify(value);
  assertSafeRdfTerm(term);
  return term;
}

function safeObject(value: string): string {
  const term = value.startsWith('"') ? value : `<${value}>`;
  assertSafeRdfTerm(term);
  return term;
}

function toQuadKey(quad: Quad): string {
  return `${quad.subject} ${quad.predicate} ${quad.object}`;
}

function stripTerm(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith('"') ? JSON.parse(value) : value;
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}
