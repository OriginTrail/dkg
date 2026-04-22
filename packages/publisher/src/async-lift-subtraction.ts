import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { assertSafeRdfTerm } from '@origintrail-official/dkg-core';
import { GraphManager, decryptPrivateLiteral } from '@origintrail-official/dkg-storage';
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
  /**
   * Explicit encryption key used when sealing private literals (same
   * value the caller's `PrivateContentStore` was constructed with).
   *
   * PR #229 bot review round 9 (async-lift-subtraction.ts:147): without
   * this, the subtraction called `decryptPrivateLiteral` with no
   * override and resolved ONLY the env/default key. A deployment that
   * uses a non-default key therefore never matched any plaintext input
   * against the on-disk envelope — every private quad reappeared as
   * "unseen" and got republished. Callers (DKGPublisher) thread the
   * same key they passed to `PrivateContentStore` here. `undefined`
   * keeps the legacy env/default resolution so tests with no explicit
   * key keep working.
   */
  privateStoreEncryptionKey?: Uint8Array | string;
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
  // Private quads land on disk as AES-GCM-SIV ciphertext (BUGS_FOUND.md
  // ST-2). The deterministic IV guarantees identical plaintexts produce
  // identical ciphertexts, but the authoritative-key set still has to
  // be in plaintext form so callers can match against the
  // user-supplied (plaintext) input quads. Decrypt as we read.
  const authoritativePrivate = await loadAuthoritativeQuadKeys(
    params.store,
    params.graphManager.privateGraphUri(params.request.contextGraphId),
    confirmedRoots,
    /* decryptObjects */ true,
    params.privateStoreEncryptionKey,
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

async function loadAuthoritativeQuadKeys(
  store: TripleStore,
  graph: string,
  confirmedRoots: Set<string>,
  decryptObjects = false,
  encryptionKey?: Uint8Array | string,
): Promise<Set<string>> {
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

  return new Set(
    result.quads.map((quad) => {
      // PR #229 bot review round 9 (async-lift-subtraction.ts:147):
      // forward the store's explicit `encryptionKey` (when the caller
      // supplied one) so the decrypt here uses the SAME key the
      // backing `PrivateContentStore` sealed under. Without this,
      // `decryptPrivateLiteral` silently falls back to env/default
      // and never round-trips a non-default-key seal — causing
      // subtraction to miss every authoritative private quad on a
      // retry and republish duplicates.
      const object = decryptObjects
        ? decryptPrivateLiteral(quad.object, { encryptionKey })
        : quad.object;
      return toQuadKey({ ...quad, object, graph: '' });
    }),
  );
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
