import { randomUUID } from 'node:crypto';
import {
  assertSafeIri,
  assertSafeRdfTerm,
} from '@origintrail-official/dkg-core';
import type { Quad } from './triple-store.js';

/** Never expose these operation-internal graphs through graph enumeration. */
export const ATOMIC_GRAPH_REPLACE_STAGING_PREFIX =
  'urn:dkg:internal:atomic-graph-replace:';

export interface AtomicGraphReplaceUpdate {
  update: string;
  cleanup: string;
  stagingGraph?: string;
}

export interface AtomicGraphAndSubjectReplaceUpdate {
  update: string;
  cleanup: string;
  stagingGraphs: readonly string[];
}

/**
 * Build one SPARQL Update request that replaces a complete named graph.
 *
 * Non-empty replacements are first materialized in a random internal graph and
 * moved into place as the final operation. The target is therefore untouched
 * if parsing or staging fails. Backends used by DKG execute one Update request
 * transactionally; the final MOVE is itself an atomic graph operation as an
 * additional old-or-new guard. A failed request can leave only an internal
 * staging graph, for which `cleanup` is safe to attempt best-effort.
 */
export function buildAtomicGraphReplaceUpdate(
  graphUri: string,
  quads: readonly Quad[],
): AtomicGraphReplaceUpdate {
  const target = assertSafeIri(graphUri);
  assertReplacementPayload(target, quads);

  if (quads.length === 0) {
    return {
      update: `DROP SILENT GRAPH <${target}>`,
      cleanup: '',
    };
  }

  const stagingGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
  const triples = quads
    .map((quad) => `    ${formatResource(quad.subject, 'subject')} <${assertSafeIri(unwrapIri(quad.predicate))}> ${formatObject(quad.object)} .`)
    .join('\n');
  const cleanup = `DROP SILENT GRAPH <${stagingGraph}>`;
  return {
    stagingGraph,
    cleanup,
    update:
      `${cleanup};\n` +
      `INSERT DATA {\n  GRAPH <${stagingGraph}> {\n${triples}\n  }\n};\n` +
      // The final MOVE must NOT be SILENT: if the staging graph is missing the
      // commit did not happen, and SILENT would report that as success while
      // the stale target content survives.
      `MOVE GRAPH <${stagingGraph}> TO GRAPH <${target}>`,
  };
}

/**
 * Build one transactional SPARQL Update that replaces a complete named graph
 * and every row for one subject in a second graph. Both payloads are staged in
 * the same request, so readers never observe a new assertion with stale
 * metadata (or the reverse).
 */
export function buildAtomicGraphAndSubjectReplaceUpdate(
  graphUri: string,
  graphQuads: readonly Quad[],
  metaGraphUri: string,
  metadataSubject: string,
  metadataQuads: readonly Quad[],
): AtomicGraphAndSubjectReplaceUpdate {
  const target = assertSafeIri(graphUri);
  const metaGraph = assertSafeIri(metaGraphUri);
  const subject = assertSafeIri(metadataSubject);
  assertReplacementPayload(target, graphQuads);
  assertSubjectReplacementPayload(metaGraph, subject, metadataQuads);

  const dataStagingGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
  const metaStagingGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;
  const stagingGraphs = [dataStagingGraph, metaStagingGraph];
  const cleanup = stagingGraphs
    .map((graph) => `DROP SILENT GRAPH <${graph}>`)
    .join(';\n');
  const stagingBlocks = [
    graphQuads.length > 0 ? formatGraphBlock(dataStagingGraph, graphQuads) : undefined,
    metadataQuads.length > 0 ? formatGraphBlock(metaStagingGraph, metadataQuads) : undefined,
  ].filter((block): block is string => block !== undefined);
  const stagePayload = stagingBlocks.length > 0
    ? `INSERT DATA {\n${stagingBlocks.join('\n')}\n};\n`
    : '';
  const insertMetadata = metadataQuads.length > 0
    ? `INSERT { GRAPH <${metaGraph}> { <${subject}> ?p ?o } }\n` +
      `WHERE { GRAPH <${metaStagingGraph}> { <${subject}> ?p ?o } };\n`
    : '';
  const replaceData = graphQuads.length > 0
    ? `MOVE GRAPH <${dataStagingGraph}> TO GRAPH <${target}>`
    : `DROP SILENT GRAPH <${target}>`;

  return {
    stagingGraphs,
    cleanup,
    update:
      `${cleanup};\n` +
      stagePayload +
      `DELETE WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } };\n` +
      insertMetadata +
      `${replaceData};\n` +
      `DROP SILENT GRAPH <${metaStagingGraph}>`,
  };
}

export function isAtomicGraphReplaceStagingGraph(graphUri: string): boolean {
  return graphUri.startsWith(ATOMIC_GRAPH_REPLACE_STAGING_PREFIX);
}

/**
 * Build one transactional SPARQL Update that atomically replaces every row for a
 * single subject inside a *shared* named graph, leaving all other subjects in
 * that graph untouched — unlike `buildAtomicGraphReplaceUpdate`, which replaces
 * the whole graph.
 *
 * Backends DKG uses execute one Update request as a single transaction, so a
 * concurrent reader observes `subject` either fully in its prior state or fully
 * in its new state — never the transiently-empty window a separate
 * delete-then-insert exposes (see #1863: a lock-free reader racing a job
 * transition would otherwise see zero rows for the subject and report a false
 * miss). A failed/malformed INSERT DATA aborts the whole request, so the DELETE
 * rolls back too; no staging graph is needed because there is no MOVE.
 *
 * This is a STRICT single-subject primitive: every quad in `insertQuads` must
 * target `graphUri` AND carry `subject` as its subject (enforced via
 * `assertSubjectReplacementPayload`, shared with `replaceGraphAndSubject`). A
 * caller that also needs to write co-located rows for another subject (e.g. an
 * immutable request record) must do that as its own separate write — the delete
 * scope and the insert scope are the same single subject, so the name never
 * diverges from the behaviour. Quads must be blank-node free; object terms are
 * validated/escaped through the same `formatObject` path as
 * `buildAtomicGraphReplaceUpdate`, so callers pass already-serialized RDF terms
 * rather than hand-escaping literals.
 */
export function buildAtomicSubjectReplaceUpdate(
  graphUri: string,
  subject: string,
  insertQuads: readonly Quad[],
): string {
  const target = assertSafeIri(graphUri);
  const safeSubject = assertSafeIri(subject);
  assertSubjectReplacementPayload(graphUri, subject, insertQuads);
  const del = `DELETE WHERE { GRAPH <${target}> { <${safeSubject}> ?p ?o } }`;
  if (insertQuads.length === 0) return del;
  return `${del};\nINSERT DATA {\n${formatGraphBlock(target, insertQuads)}\n}`;
}

function assertReplacementPayload(graphUri: string, quads: readonly Quad[]): void {
  for (const [index, quad] of quads.entries()) {
    if (quad.graph !== graphUri) {
      throw new Error(
        `Atomic graph replacement quad ${index} targets "${quad.graph}" instead of "${graphUri}"`,
      );
    }
    if (quad.subject.startsWith('_:') || quad.object.startsWith('_:')) {
      throw new Error(
        `Atomic graph replacement requires canonical skolem IRIs; quad ${index} still contains a blank node`,
      );
    }
  }
}

/**
 * The strict single-subject payload contract shared by the atomic subject-replace
 * primitive (`buildAtomicSubjectReplaceUpdate` → `tryReplaceSubjectAtomically` →
 * `replaceSubject`) and `buildAtomicGraphAndSubjectReplaceUpdate`: `subject` must be a
 * canonical skolem IRI (never a blank node), and every quad must target exactly that
 * `subject` in `graphUri` and be blank-node free. Exported so a caller that reproduces
 * the atomic-replace orchestration WITH a non-atomic fallback (the publisher's
 * `replaceSubjectAtomicallyOrFallback`, #1938) can enforce the IDENTICAL contract on
 * BOTH paths — a subject/graph-only re-check would leave the fallback laxer than the
 * atomic path on blank nodes, the exact asymmetry that guard closes. Throws on the
 * first violation; never mutates.
 */
export function assertSubjectReplacementPayload(
  graphUri: string,
  subject: string,
  quads: readonly Quad[],
): void {
  // The subject is interpolated as `<subject>` (an IRI). A blank-node label
  // (`_:b1`) passes `assertSafeIri` but would then be treated as an IRI term,
  // so the replace would operate on a different RDF term than the caller named
  // (and never clear the real blank-node rows). Reject it — atomic replacement
  // requires canonical skolem IRIs. Guards the empty-quads DELETE path too.
  if (subject.startsWith('_:')) {
    throw new Error(
      `Atomic subject replacement requires a canonical skolem IRI subject; "${subject}" is a blank node`,
    );
  }
  for (const [index, quad] of quads.entries()) {
    if (quad.graph !== graphUri || quad.subject !== subject) {
      throw new Error(
        `Atomic subject replacement quad ${index} must target subject "${subject}" in graph "${graphUri}"`,
      );
    }
    if (quad.subject.startsWith('_:') || quad.object.startsWith('_:')) {
      throw new Error(
        `Atomic subject replacement requires canonical skolem IRIs; quad ${index} still contains a blank node`,
      );
    }
  }
}

function formatGraphBlock(graphUri: string, quads: readonly Quad[]): string {
  const triples = quads
    .map((quad) => `    ${formatResource(quad.subject, 'subject')} <${assertSafeIri(unwrapIri(quad.predicate))}> ${formatObject(quad.object)} .`)
    .join('\n');
  return `  GRAPH <${graphUri}> {\n${triples}\n  }`;
}

function formatResource(term: string, role: string): string {
  if (term.startsWith('"')) {
    throw new Error(`Atomic graph replacement ${role} must be an IRI`);
  }
  return `<${assertSafeIri(unwrapIri(term))}>`;
}

function formatObject(term: string): string {
  if (term.startsWith('"')) {
    const normalized = normalizeLiteralDatatype(term);
    assertSafeRdfTerm(normalized);
    return normalized;
  }
  return formatResource(term, 'object');
}

function normalizeLiteralDatatype(term: string): string {
  const bareDatatype = term.match(/^("(?:[^"\\]|\\.)*")\^\^(?!<)(.+)$/);
  return bareDatatype
    ? `${bareDatatype[1]}^^<${assertSafeIri(unwrapIri(bareDatatype[2]))}>`
    : term;
}

function unwrapIri(term: string): string {
  return term.startsWith('<') && term.endsWith('>')
    ? term.slice(1, -1)
    : term;
}
