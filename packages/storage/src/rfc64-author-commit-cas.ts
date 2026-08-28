import { randomUUID } from 'node:crypto';
import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { Quad } from './triple-store.js';
import {
  ATOMIC_GRAPH_REPLACE_STAGING_PREFIX,
  assertReplacementPayload,
  assertSubjectReplacementPayload,
  formatGraphBlock,
  formatObject,
  isAtomicGraphReplaceStagingGraph,
  unwrapIri,
} from './atomic-graph-replace.js';

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

/** One named RFC-64 semantic fence and its complete replacement subject. */
export interface Rfc64AuthorCommitStateTransitionV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly predicate: string;
  readonly expectedObject: string | null;
  readonly quads: readonly Quad[];
}

/** Closed `SYNC_AUTHOR_COMMIT_CAS_V1` manifest for one author publication. */
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
  /** Exact expected KA-state digest fence and next KA-state subject. */
  readonly kaStateDigest: Rfc64AuthorCommitStateTransitionV1;
  /** Exact subgraph mutation-generation fence and next mutation subject. */
  readonly subgraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  /** Exact context-graph mutation-generation fence and next mutation subject. */
  readonly contextGraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  /** Exact applied-set fence and next applied-set subject. */
  readonly appliedSet: Rfc64AuthorCommitStateTransitionV1;
  readonly sealInvalidations: readonly Rfc64AuthorCommitSubjectReplacementV1[];
}

export type Rfc64AuthorCommitCasResultV1 = 'committed' | 'conflict';

export interface Rfc64AuthorCommitCasUpdateV1 {
  readonly update: string;
  readonly cleanup: string;
  readonly receiptAsk: string;
  readonly receiptGraph: string;
  readonly semanticQuads: readonly Quad[];
  readonly touchedGraphs: readonly string[];
}

/** Canonical validated metadata consumed by every adapter and decorator. */
export interface NormalizedRfc64AuthorCommitCasV1 {
  readonly input: Rfc64AuthorCommitCasInputV1;
  readonly stateGuards: readonly Rfc64AuthorCommitValueGuardV1[];
  readonly stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementV1[];
  readonly semanticQuads: readonly Quad[];
  readonly touchedGraphs: readonly string[];
  readonly referencedGraphs: readonly string[];
}

export function normalizeRfc64AuthorCommitCasV1(
  input: Rfc64AuthorCommitCasInputV1,
): NormalizedRfc64AuthorCommitCasV1 {
  const roles = [
    ['kaStateDigest', input.kaStateDigest],
    ['subgraphMutationGeneration', input.subgraphMutationGeneration],
    ['contextGraphMutationGeneration', input.contextGraphMutationGeneration],
    ['appliedSet', input.appliedSet],
  ] as const;
  for (const [role, transition] of roles) {
    if (!transition || typeof transition !== 'object') {
      throw new Error(`RFC-64 author commit requires the exact ${role} semantic transition`);
    }
  }
  if (!Array.isArray(input.sealInvalidations)) {
    throw new Error('RFC-64 author commit requires bounded seal invalidations');
  }
  const stateGuards = Object.freeze(roles.map(([, transition]) => ({
    graphUri: transition.graphUri,
    subject: transition.subject,
    predicate: transition.predicate,
    expectedObject: transition.expectedObject,
  })));
  const stateReplacements = Object.freeze([
    ...roles.map(([, transition]) => ({
      graphUri: transition.graphUri,
      subject: transition.subject,
      quads: transition.quads,
    })),
    ...input.sealInvalidations,
  ]);
  validateInput(input, stateGuards, stateReplacements);
  const touchedGraphs = Object.freeze([...new Set([
    input.sharedProjectionGraph,
    input.authorSealGraph,
    input.currentHeadGraph,
    ...stateReplacements.map(({ graphUri }) => graphUri),
  ])]);
  const referencedGraphs = Object.freeze([...new Set([
    ...touchedGraphs,
    ...stateGuards.map(({ graphUri }) => graphUri),
  ])]);
  const semanticQuads = Object.freeze([
    ...input.sharedProjectionQuads,
    ...input.authorSealQuads,
    ...stateReplacements.flatMap(({ quads }) => quads),
  ]);
  return Object.freeze({
    input,
    stateGuards,
    stateReplacements,
    semanticQuads,
    touchedGraphs,
    referencedGraphs,
  });
}

/** Build the one certified transactional update for the closed manifest. */
export function buildRfc64AuthorCommitCasUpdateV1(
  input: Rfc64AuthorCommitCasInputV1,
): Rfc64AuthorCommitCasUpdateV1 {
  const manifest = normalizeRfc64AuthorCommitCasV1(input);
  const sharedProjectionGraph = assertSafeIri(input.sharedProjectionGraph);
  const currentHeadGraph = assertSafeIri(input.currentHeadGraph);
  const currentHeadSubject = assertNonBlankNodeIri(
    input.currentHeadSubject,
    'RFC-64 author current-head subject',
  );
  const currentHeadPredicate = assertSafeIri(unwrapIri(input.currentHeadPredicate));
  const nextCurrentHeadObject = formatControlObject(input.nextCurrentHeadObject, 'next current head');
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
    ...manifest.stateReplacements,
  ];
  const staged: Array<Readonly<{
    targetGraph: string;
    targetSubject: string | null;
    stagingGraph: string;
    quads: readonly Quad[];
  }>> = [{
    targetGraph: sharedProjectionGraph,
    targetSubject: null,
    stagingGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`,
    quads: input.sharedProjectionQuads,
  }];
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
  const cleanup = internalGraphs.map((graph) => `DROP SILENT GRAPH <${graph}>`).join(';\n');
  const stagePayload = `INSERT DATA {\n${staged.map(({ stagingGraph, quads }) =>
    formatGraphBlock(stagingGraph, quads)).join('\n')}\n};\n`;
  const guards = [
    formatGuard({
      graphUri: input.currentHeadGraph,
      subject: input.currentHeadSubject,
      predicate: input.currentHeadPredicate,
      expectedObject: input.expectedCurrentHeadObject,
    }, 0),
    ...manifest.stateGuards.map((guard, index) => formatGuard(guard, index + 1)),
  ];
  const receiptInsert =
    `INSERT { ${receiptPattern} }\n` +
    `WHERE {\n${guards.map((guard) => `  ${guard}`).join('\n')}\n};\n`;
  const mutations: string[] = [formatGuardedGraphReplacement(
    sharedProjectionGraph,
    staged[0]!.stagingGraph,
    receiptPattern,
  )];
  for (const replacement of replacements) {
    const targetGraph = assertSafeIri(replacement.graphUri);
    const targetSubject = assertNonBlankNodeIri(
      replacement.subject,
      'RFC-64 author commit replacement subject',
    );
    const stagingGraph = staged.find((candidate) =>
      candidate.targetGraph === targetGraph && candidate.targetSubject === targetSubject,
    )?.stagingGraph ?? null;
    mutations.push(formatGuardedSubjectReplacement(
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
    semanticQuads: manifest.semanticQuads,
    touchedGraphs: manifest.touchedGraphs,
  });
}

function validateInput(
  input: Rfc64AuthorCommitCasInputV1,
  stateGuards: readonly Rfc64AuthorCommitValueGuardV1[],
  stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementV1[],
): void {
  const sharedProjectionGraph = assertNonInternalGraph(input.sharedProjectionGraph, 'shared projection graph');
  if (input.sharedProjectionQuads.length === 0) {
    throw new Error(
      'RFC-64 author commit requires a non-empty shared projection; retraction uses its own certified capability',
    );
  }
  assertReplacementPayload(sharedProjectionGraph, input.sharedProjectionQuads);
  const authorSealGraph = assertNonInternalGraph(input.authorSealGraph, 'author seal graph');
  const authorSealSubject = assertNonBlankNodeIri(input.authorSealSubject, 'RFC-64 author seal subject');
  if (authorSealGraph === sharedProjectionGraph) {
    throw new Error('RFC-64 author seal cannot share the complete projection graph');
  }
  if (input.authorSealQuads.length === 0) {
    throw new Error('RFC-64 author commit requires a non-empty author seal');
  }
  assertSubjectReplacementPayload(authorSealGraph, authorSealSubject, input.authorSealQuads);
  const currentHeadGraph = assertNonInternalGraph(input.currentHeadGraph, 'current-head graph');
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
  const nextCurrentHeadObject = formatControlObject(input.nextCurrentHeadObject, 'next current head');
  if (
    input.expectedCurrentHeadObject !== null &&
    formatControlObject(input.expectedCurrentHeadObject, 'expected current head') === nextCurrentHeadObject
  ) {
    throw new Error('RFC-64 author commit next current head must advance the guarded value');
  }
  if (stateGuards.length !== RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1) {
    throw new Error(
      `RFC-64 author commit requires exactly ${RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1} state guards`,
    );
  }
  if (stateReplacements.length > RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1) {
    throw new Error(
      `RFC-64 author commit accepts at most ${RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1} state replacements`,
    );
  }
  const guardKeys = new Set([
    JSON.stringify([currentHeadGraph, currentHeadSubject, currentHeadPredicate]),
  ]);
  for (const guard of stateGuards) {
    const graphUri = assertNonInternalGraph(guard.graphUri, 'state guard graph');
    const subject = assertNonBlankNodeIri(guard.subject, 'RFC-64 author commit guard subject');
    const predicate = assertSafeIri(unwrapIri(guard.predicate));
    if (guard.expectedObject !== null) formatControlObject(guard.expectedObject, 'expected guard value');
    const key = JSON.stringify([graphUri, subject, predicate]);
    if (guardKeys.has(key)) throw new Error('RFC-64 author commit contains a duplicate guard');
    guardKeys.add(key);
  }
  const replacementKeys = new Set([JSON.stringify([authorSealGraph, authorSealSubject])]);
  let controlQuadCount = 1 + input.authorSealQuads.length;
  for (const replacement of stateReplacements) {
    const graphUri = assertNonInternalGraph(replacement.graphUri, 'state replacement graph');
    const subject = assertNonBlankNodeIri(replacement.subject, 'RFC-64 author commit replacement subject');
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

function formatGuard(guard: Rfc64AuthorCommitValueGuardV1, index: number): string {
  const graphUri = assertSafeIri(guard.graphUri);
  const subject = assertNonBlankNodeIri(guard.subject, 'RFC-64 author commit guard subject');
  const predicate = assertSafeIri(unwrapIri(guard.predicate));
  if (guard.expectedObject === null) {
    return `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?guard${index} . } }`;
  }
  const expected = formatControlObject(guard.expectedObject, 'expected guard value');
  return `GRAPH <${graphUri}> { <${subject}> <${predicate}> ${expected} . } ` +
    `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?other${index} . ` +
    `FILTER(!sameTerm(?other${index}, ${expected})) } }`;
}

function formatGuardedGraphReplacement(
  targetGraph: string,
  stagingGraph: string,
  receiptPattern: string,
): string {
  return `DELETE { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } }\n` +
    `WHERE { ${receiptPattern} OPTIONAL { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } } };\n` +
    `INSERT { GRAPH <${targetGraph}> { ?dataS ?dataP ?dataO . } }\n` +
    `WHERE { ${receiptPattern} GRAPH <${stagingGraph}> { ?dataS ?dataP ?dataO . } }`;
}

function formatGuardedSubjectReplacement(
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

function formatControlObject(value: string, label: string): string {
  if (value.startsWith('_:')) {
    throw new Error(`RFC-64 author commit ${label} cannot be a blank node`);
  }
  return formatObject(value);
}

function assertNonInternalGraph(value: string, label: string): string {
  const graphUri = assertSafeIri(value);
  if (isAtomicGraphReplaceStagingGraph(graphUri)) {
    throw new Error(`RFC-64 author commit ${label} cannot target an internal atomic graph`);
  }
  return graphUri;
}
