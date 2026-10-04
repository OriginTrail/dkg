// SPDX-License-Identifier: Apache-2.0
import { assertQuadLiteralsMutf8Safe, JAVA_WRITE_UTF_MAX_BYTES } from '@origintrail-official/dkg-core';
import { buildAtomicSubjectReplaceUpdate, buildAtomicSubjectPredicatesReplaceUpdate } from '../atomic-graph-replace.js';
import type { Quad } from '../triple-store.js';
import { sparqlStatements } from './sparql-statements.js';

/** Shared strict payload/IRI policy; the adapter separately certifies its transaction boundary. */
export function prepareRemoteAtomicSubjectWrite(
  adapter: 'blazegraph' | 'sparql-http', graph: string, subject: string, quads: Quad[], predicates?: readonly string[],
) {
  const operation = predicates === undefined ? 'replaceSubject' : 'replaceSubjectPredicates';
  assertQuadLiteralsMutf8Safe(quads, { maxBytes: JAVA_WRITE_UTF_MAX_BYTES, label: `${adapter === 'blazegraph' ? 'BlazegraphStore' : 'SparqlHttpStore'}.${operation}` });
  // Blazegraph runs one UPDATE request (DELETE WHERE + INSERT DATA) as a single
  // transaction, so the subject is replaced atomically. No staging/cleanup: a
  // failed request commits nothing. HTTP requires its explicit consistency profile.
  const update = predicates === undefined ? buildAtomicSubjectReplaceUpdate(graph, subject, quads)
    : buildAtomicSubjectPredicatesReplaceUpdate(graph, subject, predicates, quads);
  const checks = sparqlStatements(adapter).checkIris;
  if (predicates === undefined) checks.replaceSubject(graph, subject, quads);
  else checks.replaceSubjectPredicates(graph, subject, predicates, quads);
  return { operation, update } as const;
}
