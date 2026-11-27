import { assertSafeIri, unwrapIri } from '@origintrail-official/dkg-core';
import {
  assertReplacementPayload,
  assertSubjectReplacementPayload,
  formatGraphBlock,
} from './atomic-graph-replace.js';
import type { Quad, QueryOptions, TripleStore } from './triple-store.js';
import { UnsupportedTripleStoreCapabilityError } from './unsupported-capability-error.js';

/** Validate both groups before a mutation or literal externalization can start. */
export function assertSubjectAndInsertPayload(
  graphUri: string,
  subject: string,
  replacementQuads: readonly Quad[],
  insertQuads: readonly Quad[],
): void {
  assertSafeIri(graphUri);
  assertSafeIri(subject);
  assertSubjectReplacementPayload(graphUri, subject, replacementQuads);
  assertReplacementPayload(graphUri, insertQuads);
  for (const quad of insertQuads) {
    if (unwrapIri(quad.subject) === subject) {
      throw new Error('Atomic subject replacement companion quads must use a different subject');
    }
  }
  // Render before any I/O, including on capability-absent fallback paths. This
  // validates every RDF term, not only the graph/subject grouping.
  formatGraphBlock(graphUri, [...replacementQuads, ...insertQuads]);
}

/** Replace one subject and add companion rows in the same transaction/graph. */
export function buildAtomicSubjectAndInsertUpdate(
  graphUri: string,
  subject: string,
  replacementQuads: readonly Quad[],
  insertQuads: readonly Quad[],
): string {
  assertSubjectAndInsertPayload(graphUri, subject, replacementQuads, insertQuads);
  const del = `DELETE WHERE { GRAPH <${graphUri}> { <${subject}> ?p ?o } }`;
  const quads = [...replacementQuads, ...insertQuads];
  return quads.length === 0 ? del : `${del};\nINSERT DATA {\n${formatGraphBlock(graphUri, quads)}\n}`;
}

/** Only a missing capability or a clean, matching refusal permits fallback. */
export async function tryReplaceSubjectAndInsertAtomically(
  store: TripleStore,
  graphUri: string,
  subject: string,
  replacementQuads: Quad[],
  insertQuads: Quad[],
  options: QueryOptions = {},
): Promise<boolean> {
  assertSubjectAndInsertPayload(graphUri, subject, replacementQuads, insertQuads);
  const replace = store.replaceSubjectAndInsert;
  if (typeof replace !== 'function') return false;
  try {
    await replace.call(store, graphUri, subject, replacementQuads, insertQuads, options);
    return true;
  } catch (error) {
    if (error instanceof UnsupportedTripleStoreCapabilityError
      && error.capability === 'replaceSubjectAndInsert') return false;
    // An execution or postcommit error may hide a committed write. Never replay.
    throw error;
  }
}
