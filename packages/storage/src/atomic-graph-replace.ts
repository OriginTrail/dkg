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

export const RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1 = 4;
export const RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1 = 6;
export const RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1 = 1024;

export interface Rfc64AuthorCommitValueGuardV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly predicate: string;
  /** `null` requires the guarded value to be absent. */
  readonly expectedObject: string | null;
}

export interface Rfc64AuthorCommitSubjectReplacementV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly quads: readonly Quad[];
}

/**
 * Dormant RFC-64 storage boundary for one author publication.
 *
 * Immutable catalog objects are staged outside this operation. This input owns
 * only semantic state that must move old-or-new together: one complete,
 * non-empty shared projection graph, its non-empty exact author-seal subject,
 * the author's current-head pointer, and a bounded set of mutation/applied-set
 * guards and invalidations. Retraction is deliberately not expressible here.
 */
export interface Rfc64AuthorCommitCasInputV1 {
  readonly sharedProjectionGraph: string;
  readonly sharedProjectionQuads: readonly Quad[];
  readonly authorSealGraph: string;
  readonly authorSealSubject: string;
  readonly authorSealQuads: readonly Quad[];
  readonly currentHeadGraph: string;
  readonly currentHeadSubject: string;
  readonly currentHeadPredicate: string;
  readonly expectedCurrentHeadObject: string | null;
  readonly nextCurrentHeadObject: string;
  readonly stateGuards: readonly Rfc64AuthorCommitValueGuardV1[];
  readonly stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementV1[];
}

export type Rfc64AuthorCommitCasResultV1 = 'committed' | 'conflict';

export interface Rfc64AuthorCommitCasUpdateV1 {
  readonly update: string;
  readonly cleanup: string;
  readonly receiptAsk: string;
  readonly receiptGraph: string;
  readonly touchedGraphs: readonly string[];
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

/**
 * Build the fixed `SYNC_AUTHOR_COMMIT_CAS_V1` update shape.
 *
 * A unique receipt is inserted only when every exact guard matches. Every
 * semantic mutation is conditioned on that receipt and is executed inside the
 * same backend transaction. Separate guarded DELETE/INSERT operations avoid a
 * Cartesian product between a large KA graph and the bounded control subjects.
 * The receipt survives the transaction just long enough for the adapter to
 * distinguish a clean CAS conflict from a committed update; it is hidden from
 * graph enumeration and removed best-effort afterward.
 */
export function buildRfc64AuthorCommitCasUpdateV1(
  input: Rfc64AuthorCommitCasInputV1,
): Rfc64AuthorCommitCasUpdateV1 {
  validateRfc64AuthorCommitInputV1(input);

  const sharedProjectionGraph = assertSafeIri(input.sharedProjectionGraph);
  const currentHeadGraph = assertSafeIri(input.currentHeadGraph);
  const currentHeadSubject = assertNonBlankNodeIri(
    input.currentHeadSubject,
    'RFC-64 author current-head subject',
  );
  const currentHeadPredicate = assertSafeIri(unwrapIri(input.currentHeadPredicate));
  const nextCurrentHeadObject = formatRfc64ControlObjectV1(
    input.nextCurrentHeadObject,
    'next current head',
  );
  const receiptId = randomUUID();
  const receiptGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}rfc64-author-commit:${receiptId}`;
  const receiptSubject = `${receiptGraph}:receipt`;
  const receiptPredicate = 'urn:dkg:sync:authorCommitApplied';
  const receiptObject = '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>';
  const receiptPattern =
    `GRAPH <${receiptGraph}> { <${receiptSubject}> <${receiptPredicate}> ${receiptObject} . }`;

  const replacements: Rfc64AuthorCommitSubjectReplacementV1[] = [
    {
      graphUri: input.authorSealGraph,
      subject: input.authorSealSubject,
      quads: input.authorSealQuads,
    },
    ...input.stateReplacements,
  ];
  const staged: Array<Readonly<{
    targetGraph: string;
    targetSubject: string | null;
    stagingGraph: string;
    quads: readonly Quad[];
  }>> = [];
  if (input.sharedProjectionQuads.length > 0) {
    staged.push({
      targetGraph: sharedProjectionGraph,
      targetSubject: null,
      stagingGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`,
      quads: input.sharedProjectionQuads,
    });
  }
  for (const replacement of replacements) {
    if (replacement.quads.length === 0) continue;
    staged.push({
      targetGraph: assertSafeIri(replacement.graphUri),
      targetSubject: assertNonBlankNodeIri(
        replacement.subject,
        'RFC-64 author commit replacement subject',
      ),
      stagingGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`,
      quads: replacement.quads,
    });
  }

  const internalGraphs = [receiptGraph, ...staged.map(({ stagingGraph }) => stagingGraph)];
  const cleanup = internalGraphs
    .map((graph) => `DROP SILENT GRAPH <${graph}>`)
    .join(';\n');
  const stageBlocks = staged.map(({ stagingGraph, quads }) =>
    formatGraphBlock(stagingGraph, quads));
  const stagePayload = stageBlocks.length > 0
    ? `INSERT DATA {\n${stageBlocks.join('\n')}\n};\n`
    : '';
  const guards = [
    formatRfc64AuthorCommitGuardV1({
      graphUri: input.currentHeadGraph,
      subject: input.currentHeadSubject,
      predicate: input.currentHeadPredicate,
      expectedObject: input.expectedCurrentHeadObject,
    }, 0),
    ...input.stateGuards.map((guard, index) =>
      formatRfc64AuthorCommitGuardV1(guard, index + 1)),
  ];
  const receiptInsert =
    `INSERT { ${receiptPattern} }\n` +
    `WHERE {\n${guards.map((guard) => `  ${guard}`).join('\n')}\n};\n`;

  const mutations: string[] = [];
  mutations.push(formatGuardedGraphReplacementV1(
    sharedProjectionGraph,
    staged.find(({ targetGraph, targetSubject }) =>
      targetGraph === sharedProjectionGraph && targetSubject === null)?.stagingGraph ?? null,
    receiptPattern,
  ));
  for (const replacement of replacements) {
    const targetGraph = assertSafeIri(replacement.graphUri);
    const targetSubject = assertNonBlankNodeIri(
      replacement.subject,
      'RFC-64 author commit replacement subject',
    );
    const stagingGraph = staged.find((candidate) =>
      candidate.targetGraph === targetGraph && candidate.targetSubject === targetSubject,
    )?.stagingGraph ?? null;
    mutations.push(formatGuardedSubjectReplacementV1(
      targetGraph,
      targetSubject,
      stagingGraph,
      receiptPattern,
    ));
  }
  mutations.push(
    `DELETE { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ?oldHead . } }\n` +
    `WHERE { ${receiptPattern} OPTIONAL { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ?oldHead . } } };\n` +
    `INSERT { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ${nextCurrentHeadObject} . } }\n` +
    `WHERE { ${receiptPattern} }`,
  );

  const touchedGraphs = Object.freeze([...new Set([
    sharedProjectionGraph,
    input.authorSealGraph,
    currentHeadGraph,
    ...input.stateReplacements.map(({ graphUri }) => graphUri),
  ])]);
  return Object.freeze({
    update:
      `${cleanup};\n` +
      stagePayload +
      receiptInsert +
      `${mutations.join(';\n')};\n` +
      staged.map(({ stagingGraph }) => `DROP SILENT GRAPH <${stagingGraph}>`).join(';\n'),
    cleanup,
    receiptAsk: `ASK WHERE { ${receiptPattern} }`,
    receiptGraph,
    touchedGraphs,
  });
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

function validateRfc64AuthorCommitInputV1(input: Rfc64AuthorCommitCasInputV1): void {
  const sharedProjectionGraph = assertNonInternalGraphV1(
    input.sharedProjectionGraph,
    'shared projection graph',
  );
  if (input.sharedProjectionQuads.length === 0) {
    throw new Error(
      'RFC-64 author commit requires a non-empty shared projection; retraction uses its own certified capability',
    );
  }
  assertReplacementPayload(sharedProjectionGraph, input.sharedProjectionQuads);
  const authorSealGraph = assertNonInternalGraphV1(input.authorSealGraph, 'author seal graph');
  const authorSealSubject = assertNonBlankNodeIri(
    input.authorSealSubject,
    'RFC-64 author seal subject',
  );
  if (authorSealGraph === sharedProjectionGraph) {
    throw new Error('RFC-64 author seal cannot share the complete projection graph');
  }
  if (input.authorSealQuads.length === 0) {
    throw new Error('RFC-64 author commit requires a non-empty author seal');
  }
  assertSubjectReplacementPayload(
    authorSealGraph,
    authorSealSubject,
    input.authorSealQuads,
  );
  const currentHeadGraph = assertNonInternalGraphV1(input.currentHeadGraph, 'current-head graph');
  const currentHeadSubject = assertNonBlankNodeIri(
    input.currentHeadSubject,
    'RFC-64 author current-head subject',
  );
  const currentHeadPredicate = assertSafeIri(unwrapIri(input.currentHeadPredicate));
  if (currentHeadGraph === sharedProjectionGraph) {
    throw new Error('RFC-64 current head cannot live inside the complete projection graph');
  }
  if (currentHeadGraph === authorSealGraph && currentHeadSubject === authorSealSubject) {
    throw new Error('RFC-64 current-head subject cannot also be the author-seal subject');
  }
  const nextCurrentHeadObject = formatRfc64ControlObjectV1(
    input.nextCurrentHeadObject,
    'next current head',
  );
  if (
    input.expectedCurrentHeadObject !== null
    && formatRfc64ControlObjectV1(
      input.expectedCurrentHeadObject,
      'expected current head',
    ) === nextCurrentHeadObject
  ) {
    throw new Error('RFC-64 author commit next current head must advance the guarded value');
  }
  if (input.stateGuards.length > RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1) {
    throw new Error(
      `RFC-64 author commit accepts at most ${RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1} state guards`,
    );
  }
  if (input.stateReplacements.length > RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1) {
    throw new Error(
      `RFC-64 author commit accepts at most ${RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1} state replacements`,
    );
  }
  const guardKeys = new Set([
    JSON.stringify([currentHeadGraph, currentHeadSubject, currentHeadPredicate]),
  ]);
  for (const guard of input.stateGuards) {
    const graphUri = assertNonInternalGraphV1(guard.graphUri, 'state guard graph');
    const subject = assertNonBlankNodeIri(guard.subject, 'RFC-64 author commit guard subject');
    const predicate = assertSafeIri(unwrapIri(guard.predicate));
    if (guard.expectedObject !== null) {
      formatRfc64ControlObjectV1(guard.expectedObject, 'expected guard value');
    }
    const key = JSON.stringify([graphUri, subject, predicate]);
    if (guardKeys.has(key)) throw new Error('RFC-64 author commit contains a duplicate guard');
    guardKeys.add(key);
  }
  const replacementKeys = new Set([
    JSON.stringify([authorSealGraph, authorSealSubject]),
  ]);
  // Include the one next-head row written by the fixed manifest itself.
  let controlQuadCount = 1 + input.authorSealQuads.length;
  for (const replacement of input.stateReplacements) {
    const graphUri = assertNonInternalGraphV1(replacement.graphUri, 'state replacement graph');
    const subject = assertNonBlankNodeIri(
      replacement.subject,
      'RFC-64 author commit replacement subject',
    );
    if (graphUri === sharedProjectionGraph) {
      throw new Error('RFC-64 author commit cannot replace a subject inside its complete projection graph');
    }
    if (graphUri === currentHeadGraph && subject === currentHeadSubject) {
      throw new Error('RFC-64 current-head subject is owned by the guarded head transition');
    }
    const key = JSON.stringify([graphUri, subject]);
    if (replacementKeys.has(key)) {
      throw new Error('RFC-64 author commit contains a duplicate subject replacement');
    }
    replacementKeys.add(key);
    assertSubjectReplacementPayload(graphUri, subject, replacement.quads);
    controlQuadCount += replacement.quads.length;
  }
  if (controlQuadCount > RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1) {
    throw new Error(
      `RFC-64 author commit control payload exceeds ${RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1} quads`,
    );
  }
}

function formatRfc64AuthorCommitGuardV1(
  guard: Rfc64AuthorCommitValueGuardV1,
  index: number,
): string {
  const graphUri = assertSafeIri(guard.graphUri);
  const subject = assertNonBlankNodeIri(guard.subject, 'RFC-64 author commit guard subject');
  const predicate = assertSafeIri(unwrapIri(guard.predicate));
  if (guard.expectedObject === null) {
    return `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?guard${index} . } }`;
  }
  const expected = formatRfc64ControlObjectV1(
    guard.expectedObject,
    'expected guard value',
  );
  return `GRAPH <${graphUri}> { <${subject}> <${predicate}> ${expected} . } ` +
    `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?other${index} . ` +
    `FILTER(!sameTerm(?other${index}, ${expected})) } }`;
}

function formatGuardedGraphReplacementV1(
  targetGraph: string,
  stagingGraph: string | null,
  receiptPattern: string,
): string {
  const remove =
    `DELETE { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } }\n` +
    `WHERE { ${receiptPattern} OPTIONAL { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } } }`;
  if (stagingGraph === null) return remove;
  return `${remove};\n` +
    `INSERT { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } }\n` +
    `WHERE { ${receiptPattern} GRAPH <${stagingGraph}> { ?dataS ?dataP ?dataO . } }`;
}

function formatGuardedSubjectReplacementV1(
  targetGraph: string,
  targetSubject: string,
  stagingGraph: string | null,
  receiptPattern: string,
): string {
  const variableSuffix = randomUUID().replaceAll('-', '');
  const predicate = `?subjectP${variableSuffix}`;
  const object = `?subjectO${variableSuffix}`;
  const remove =
    `DELETE { GRAPH <${targetGraph}> { <${targetSubject}> ${predicate} ${object} . } }\n` +
    `WHERE { ${receiptPattern} OPTIONAL { GRAPH <${targetGraph}> { <${targetSubject}> ${predicate} ${object} . } } }`;
  if (stagingGraph === null) return remove;
  return `${remove};\n` +
    `INSERT { GRAPH <${targetGraph}> { <${targetSubject}> ${predicate} ${object} . } }\n` +
    `WHERE { ${receiptPattern} GRAPH <${stagingGraph}> { <${targetSubject}> ${predicate} ${object} . } }`;
}

function assertNonBlankNodeIri(value: string, label: string): string {
  if (value.startsWith('_:')) throw new Error(`${label} must be a canonical IRI`);
  return assertSafeIri(unwrapIri(value));
}

function formatRfc64ControlObjectV1(value: string, label: string): string {
  if (value.startsWith('_:')) {
    throw new Error(`RFC-64 author commit ${label} cannot be a blank node`);
  }
  return formatObject(value);
}

function assertNonInternalGraphV1(value: string, label: string): string {
  const graphUri = assertSafeIri(value);
  if (isAtomicGraphReplaceStagingGraph(graphUri)) {
    throw new Error(`RFC-64 author commit ${label} cannot target an internal atomic graph`);
  }
  return graphUri;
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
