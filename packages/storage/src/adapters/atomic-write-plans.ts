import { assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';
import {
  buildAtomicGraphAndSubjectReplaceUpdate,
  buildAtomicGraphReplaceUpdate,
  buildAtomicSubjectReplaceUpdate,
} from '../atomic-graph-replace.js';
import { buildAtomicSubjectAndInsertUpdate } from '../atomic-subject-insert.js';
import type { Quad } from '../triple-store.js';
import { sparqlStatements } from './sparql-statements.js';

type Adapter = 'blazegraph' | 'sparql-http';

function validateLiterals(adapter: Adapter, operation: string, quads: readonly Quad[]): void {
  assertQuadLiteralsMutf8Safe(quads, {
    maxBytes: JAVA_WRITE_UTF_MAX_BYTES,
    label: `${adapter === 'blazegraph' ? 'BlazegraphStore' : 'SparqlHttpStore'}.${operation}`,
  });
}

/** Preparation only; adapters retain their existing dispatch/cleanup lifecycles. */
export function prepareAtomicGraphReplace(adapter: Adapter, graphUri: string, quads: Quad[]) {
  validateLiterals(adapter, 'replaceGraph', quads);
  const plan = buildAtomicGraphReplaceUpdate(graphUri, quads);
  sparqlStatements(adapter).checkIris.replaceGraph(graphUri, quads);
  return plan;
}

export function prepareAtomicGraphAndSubjectReplace(
  adapter: Adapter, graphUri: string, graphQuads: Quad[],
  metaGraphUri: string, metadataSubject: string, metadataQuads: Quad[],
) {
  validateLiterals(adapter, 'replaceGraphAndSubject', [...graphQuads, ...metadataQuads]);
  const plan = buildAtomicGraphAndSubjectReplaceUpdate(
    graphUri, graphQuads, metaGraphUri, metadataSubject, metadataQuads, adapter === 'blazegraph' ? 'bounded-direct' : 'staged',
  );
  sparqlStatements(adapter).checkIris.replaceGraphAndSubject(
    graphUri, graphQuads, metaGraphUri, metadataSubject, metadataQuads,
  );
  return plan;
}

export function prepareAtomicSubjectReplace(
  adapter: Adapter, graphUri: string, subject: string, quads: Quad[],
): string {
  validateLiterals(adapter, 'replaceSubject', quads);
  const update = buildAtomicSubjectReplaceUpdate(graphUri, subject, quads);
  sparqlStatements(adapter).checkIris.replaceSubject(graphUri, subject, quads);
  return update;
}

export function prepareAtomicSubjectAndInsert(
  adapter: Adapter, graphUri: string, subject: string,
  replacementQuads: Quad[], insertQuads: Quad[],
): string {
  const quads = [...replacementQuads, ...insertQuads];
  validateLiterals(adapter, 'replaceSubjectAndInsert', quads);
  const update = buildAtomicSubjectAndInsertUpdate(graphUri, subject, replacementQuads, insertQuads);
  sparqlStatements(adapter).checkIris.replaceSubjectAndInsert(graphUri, subject, quads);
  return update;
}
