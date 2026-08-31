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
const RFC64_AUTHOR_COMMIT_SEMANTIC_STATE_REPLACEMENTS_V1 = 4;

export interface Rfc64AuthorCommitValueGuardV1 {
  readonly graphUri: string;
  readonly subject: string;
  readonly predicate: string;
  /** `null` requires the guarded value to be absent. */
  readonly expectedObject: string | null;
  /** Complete expected subject for typed semantic commits; absent on legacy callers. */
  readonly expectedQuads?: readonly Quad[] | null;
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
  /** Complete predecessor subject, or null when the whole subject must be absent. */
  readonly expectedQuads?: readonly Quad[] | null;
  readonly quads: readonly Quad[];
}

/** Original exported V1 storage contract retained for existing callers. */
export interface Rfc64AuthorCommitCasLegacyInputV1 {
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
  readonly kaStateDigest: Rfc64AuthorCommitStateTransitionV1;
  readonly subgraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  readonly contextGraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  readonly appliedSet: Rfc64AuthorCommitStateTransitionV1;
  readonly sealInvalidations: readonly Rfc64AuthorCommitSubjectReplacementV1[];
}

/** Full-record semantic input compiled only by the typed RFC-64 boundary. */
export interface Rfc64AuthorCommitCasSemanticInputV1 {
  readonly sharedProjectionGraph: string;
  readonly sharedProjectionQuads: readonly Quad[];
  readonly authorSealGraph: string;
  readonly authorSealSubject: string;
  readonly authorSealQuads: readonly Quad[];
  /** Exact author current-head fence and complete next semantic record. */
  readonly currentHead: Rfc64AuthorCommitStateTransitionV1;
  /** Exact subgraph mutation-generation fence and next mutation subject. */
  readonly subgraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  /** Exact context-graph mutation-generation fence and next mutation subject. */
  readonly contextGraphMutationGeneration: Rfc64AuthorCommitStateTransitionV1;
  /** Exact applied-set fence and next applied-set subject. */
  readonly appliedSet: Rfc64AuthorCommitStateTransitionV1;
}

/** Backward-compatible source shapes accepted only at the outer capability edge. */
export type Rfc64AuthorCommitCasSourceInputV1 =
  | Rfc64AuthorCommitCasLegacyInputV1
  | Rfc64AuthorCommitCasSemanticInputV1;

/** Public compatibility input plus the canonical command carried internally. */
export type Rfc64AuthorCommitCasInputV1 =
  | Rfc64AuthorCommitCasSourceInputV1
  | NormalizedRfc64AuthorCommitCasV1;

export type Rfc64AuthorCommitCasResultV1 = 'committed' | 'conflict';

export interface Rfc64AuthorCommitCasUpdateV1 {
  readonly update: string;
  readonly cleanup: string;
  readonly receiptAsk: string;
  readonly receiptGraph: string;
  readonly semanticQuads: readonly Quad[];
  readonly touchedGraphs: readonly string[];
}

export interface Rfc64AuthorCommitCasExecutionV1 {
  /** Dispatch the one backend-transactional semantic update. */
  readonly executeUpdate: () => void | Promise<void>;
  /** Read the private receipt after the update request has settled. */
  readonly readReceipt: () => unknown | Promise<unknown>;
  /** Best-effort removal of receipt and staging graphs. */
  readonly cleanup: () => void | Promise<void>;
  /** Adapter-specific bookkeeping that is valid only for a committed CAS. */
  readonly onCommitted?: () => void | Promise<void>;
}

export type Rfc64AuthorCommitSemanticRoleV1 =
  | 'sharedProjection'
  | 'authorSeal'
  | 'currentHead'
  | 'kaStateDigest'
  | 'subgraphMutationGeneration'
  | 'contextGraphMutationGeneration'
  | 'appliedSet'
  | 'sealInvalidation';

export interface Rfc64AuthorCommitGraphReplacementPlanV1 {
  readonly role: 'sharedProjection';
  readonly graphUri: string;
  readonly quads: readonly Quad[];
}

export interface Rfc64AuthorCommitSubjectReplacementPlanV1 {
  readonly role: Exclude<Rfc64AuthorCommitSemanticRoleV1, 'sharedProjection'>;
  readonly roleIndex: number;
  readonly graphUri: string;
  readonly subject: string;
  readonly quads: readonly Quad[];
}

export interface Rfc64AuthorCommitGuardPlanV1 extends Rfc64AuthorCommitValueGuardV1 {
  readonly role: Exclude<
    Rfc64AuthorCommitSemanticRoleV1,
    'sharedProjection' | 'authorSeal' | 'sealInvalidation'
  >;
}

export interface Rfc64AuthorCommitPredicateReplacementPlanV1
  extends Rfc64AuthorCommitGuardPlanV1 {
  readonly nextObject: string;
}

export interface Rfc64AuthorCommitCasMapperV1 {
  mapQuad(
    quad: Quad,
    context: Readonly<{
      role: Rfc64AuthorCommitSemanticRoleV1;
      roleIndex: number;
      graphUri: string;
      subject: string | null;
    }>,
  ): Quad | Promise<Quad>;
  mapObject(
    object: string | null,
    context: Readonly<{
      role: Rfc64AuthorCommitGuardPlanV1['role'];
      graphUri: string;
      kind: 'expected' | 'next';
    }>,
  ): string | null | Promise<string | null>;
}

/**
 * Execute the receipt-bearing RFC-64 CAS protocol identically on every backend.
 *
 * Cleanup never replaces the semantic update or receipt error. A false receipt
 * is the only clean conflict; missing or malformed receipts remain
 * indeterminate failures because the update may already have committed.
 */
export async function executeRfc64AuthorCommitCasV1(
  execution: Rfc64AuthorCommitCasExecutionV1,
): Promise<Rfc64AuthorCommitCasResultV1> {
  try {
    await execution.executeUpdate();
  } catch (error) {
    await bestEffortRfc64Cleanup(execution.cleanup);
    throw error;
  }

  let committed: boolean;
  try {
    committed = normalizeRfc64AuthorCommitReceipt(await execution.readReceipt());
  } finally {
    await bestEffortRfc64Cleanup(execution.cleanup);
  }

  if (committed) await execution.onCommitted?.();
  return committed ? 'committed' : 'conflict';
}

function normalizeRfc64AuthorCommitReceipt(receipt: unknown): boolean {
  if (typeof receipt === 'boolean') return receipt;
  if (
    receipt !== null
    && typeof receipt === 'object'
    && (receipt as { type?: unknown }).type === 'boolean'
    && typeof (receipt as { value?: unknown }).value === 'boolean'
  ) {
    return (receipt as { value: boolean }).value;
  }
  throw new Error('RFC-64 author commit receipt query returned a non-boolean result');
}

async function bestEffortRfc64Cleanup(cleanup: () => void | Promise<void>): Promise<void> {
  try {
    await cleanup();
  } catch {
    // Receipt/staging cleanup is auxiliary. Preserve the semantic outcome or
    // the original indeterminate transport failure.
  }
}

/** Canonical validated metadata consumed by every adapter and decorator. */
export interface NormalizedRfc64AuthorCommitCasV1 {
  readonly planKind: 'rfc64-author-commit-plan-v1';
  readonly sourceKind: 'legacy' | 'semantic';
  readonly graphReplacements: readonly Rfc64AuthorCommitGraphReplacementPlanV1[];
  readonly subjectReplacements: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[];
  readonly predicateReplacements: readonly Rfc64AuthorCommitPredicateReplacementPlanV1[];
  readonly guards: readonly Rfc64AuthorCommitGuardPlanV1[];
  readonly semanticQuads: readonly Quad[];
  readonly touchedGraphs: readonly string[];
  readonly referencedGraphs: readonly string[];
}

const NORMALIZED_RFC64_AUTHOR_COMMIT_PLANS = new WeakSet<object>();

export function normalizeRfc64AuthorCommitCasV1(
  input: Rfc64AuthorCommitCasInputV1,
): NormalizedRfc64AuthorCommitCasV1 {
  if ('planKind' in input) return importNormalizedPlan(input);
  return 'currentHead' in input
    ? normalizeSemanticRfc64AuthorCommitCasV1(input)
    : normalizeLegacyRfc64AuthorCommitCasV1(input);
}

function normalizeSemanticRfc64AuthorCommitCasV1(
  input: Rfc64AuthorCommitCasSemanticInputV1,
): NormalizedRfc64AuthorCommitCasV1 {
  const roles = [
    ['currentHead', input.currentHead],
    ['subgraphMutationGeneration', input.subgraphMutationGeneration],
    ['contextGraphMutationGeneration', input.contextGraphMutationGeneration],
    ['appliedSet', input.appliedSet],
  ] as const;
  for (const [role, transition] of roles) {
    if (!transition || typeof transition !== 'object') {
      throw new Error(`RFC-64 author commit requires the exact ${role} semantic transition`);
    }
  }
  const stateGuards = Object.freeze(roles.map(([role, transition]) => ({
    role,
    graphUri: transition.graphUri,
    subject: transition.subject,
    predicate: transition.predicate,
    expectedObject: transition.expectedObject,
    expectedQuads: transition.expectedQuads,
  })));
  const stateReplacements = Object.freeze(roles.map(([role, transition]) => ({
    role,
    roleIndex: 0,
    graphUri: transition.graphUri,
    subject: transition.subject,
    quads: transition.quads,
  })));
  validateSemanticInput(input, stateGuards, stateReplacements);
  const graphReplacements = Object.freeze([Object.freeze({
    role: 'sharedProjection' as const,
    graphUri: input.sharedProjectionGraph,
    quads: input.sharedProjectionQuads,
  })]);
  const authorSealReplacement = Object.freeze({
    role: 'authorSeal' as const,
    roleIndex: 0,
    graphUri: input.authorSealGraph,
    subject: input.authorSealSubject,
    quads: input.authorSealQuads,
  });
  const subjectReplacements = Object.freeze([
    authorSealReplacement,
    ...stateReplacements,
  ]);
  const guards = stateGuards;
  return finalizeNormalizedPlan(
    'semantic',
    graphReplacements,
    subjectReplacements,
    Object.freeze([]),
    guards,
  );
}

function normalizeLegacyRfc64AuthorCommitCasV1(
  input: Rfc64AuthorCommitCasLegacyInputV1,
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
  const stateGuards = Object.freeze(roles.map(([role, transition]) => ({
    role,
    graphUri: transition.graphUri,
    subject: transition.subject,
    predicate: transition.predicate,
    expectedObject: transition.expectedObject,
  })));
  const stateReplacements = Object.freeze([
    ...roles.map(([role, transition]) => ({
      role,
      roleIndex: 0,
      graphUri: transition.graphUri,
      subject: transition.subject,
      quads: transition.quads,
    })),
    ...input.sealInvalidations.map((replacement, roleIndex) => ({
      role: 'sealInvalidation' as const,
      roleIndex,
      ...replacement,
    })),
  ]);
  const currentHead = Object.freeze({
    role: 'currentHead' as const,
    graphUri: input.currentHeadGraph,
    subject: input.currentHeadSubject,
    predicate: input.currentHeadPredicate,
    expectedObject: input.expectedCurrentHeadObject,
    nextObject: input.nextCurrentHeadObject,
  });
  validateLegacyInput(input, currentHead, stateGuards, stateReplacements);
  const graphReplacements = Object.freeze([Object.freeze({
    role: 'sharedProjection' as const,
    graphUri: input.sharedProjectionGraph,
    quads: input.sharedProjectionQuads,
  })]);
  const subjectReplacements = Object.freeze([Object.freeze({
    role: 'authorSeal' as const,
    roleIndex: 0,
    graphUri: input.authorSealGraph,
    subject: input.authorSealSubject,
    quads: input.authorSealQuads,
  }), ...stateReplacements]);
  const guards = Object.freeze([currentHead, ...stateGuards]);
  return finalizeNormalizedPlan(
    'legacy',
    graphReplacements,
    subjectReplacements,
    Object.freeze([currentHead]),
    guards,
  );
}

/**
 * Map every quad and scalar in the closed manifest through one canonical plan.
 * Decorators use this instead of reconstructing RFC-64 roles field-by-field.
 * Source-shape reconstruction is confined to this compatibility edge; the
 * normalized plan itself contains executable operations only.
 */
export async function mapRfc64AuthorCommitCasV1(
  manifest: NormalizedRfc64AuthorCommitCasV1,
  mapper: Rfc64AuthorCommitCasMapperV1,
): Promise<NormalizedRfc64AuthorCommitCasV1> {
  const graphReplacements = await Promise.all(manifest.graphReplacements.map(async (replacement) => ({
    ...replacement,
    quads: await Promise.all(replacement.quads.map((quad) => mapper.mapQuad(quad, {
      role: replacement.role,
      roleIndex: 0,
      graphUri: replacement.graphUri,
      subject: null,
    }))),
  })));
  const subjectReplacements = await Promise.all(manifest.subjectReplacements.map(async (replacement) => ({
    ...replacement,
    quads: await Promise.all(replacement.quads.map((quad) => mapper.mapQuad(quad, {
      role: replacement.role,
      roleIndex: replacement.roleIndex,
      graphUri: replacement.graphUri,
      subject: replacement.subject,
    }))),
  })));
  const guards = await Promise.all(manifest.guards.map(async (guard) => ({
    ...guard,
    expectedObject: await mapper.mapObject(guard.expectedObject, {
      role: guard.role,
      graphUri: guard.graphUri,
      kind: 'expected',
    }),
    expectedQuads: guard.expectedQuads === undefined
      ? undefined
      : guard.expectedQuads === null
        ? null
        : await Promise.all(guard.expectedQuads.map((quad) => mapper.mapQuad(quad, {
          role: guard.role,
          roleIndex: 0,
          graphUri: guard.graphUri,
          subject: guard.subject,
        }))),
  })));
  const predicateReplacements = await Promise.all(
    manifest.predicateReplacements.map(async (replacement) => {
      const mappedGuard = guards.find(({ role }) => role === replacement.role);
      if (mappedGuard === undefined) {
        throw new Error(`RFC-64 author commit plan has no ${replacement.role} guard`);
      }
      const nextObject = await mapper.mapObject(replacement.nextObject, {
        role: replacement.role,
        graphUri: replacement.graphUri,
        kind: 'next',
      });
      if (nextObject === null) {
        throw new Error('RFC-64 author commit mapper removed the next current head');
      }
      return {
        ...replacement,
        expectedObject: mappedGuard.expectedObject,
        expectedQuads: mappedGuard.expectedQuads,
        nextObject,
      };
    }),
  );

  return finalizeNormalizedPlan(
    manifest.sourceKind,
    graphReplacements,
    subjectReplacements,
    predicateReplacements,
    guards,
  );
}

function importNormalizedPlan(
  input: NormalizedRfc64AuthorCommitCasV1,
): NormalizedRfc64AuthorCommitCasV1 {
  if (NORMALIZED_RFC64_AUTHOR_COMMIT_PLANS.has(input)) return input;
  if (
    input.planKind !== 'rfc64-author-commit-plan-v1'
    || (input.sourceKind !== 'legacy' && input.sourceKind !== 'semantic')
    || !Array.isArray(input.graphReplacements)
    || !Array.isArray(input.subjectReplacements)
    || !Array.isArray(input.predicateReplacements)
    || !Array.isArray(input.guards)
  ) {
    throw new Error('RFC-64 author commit plan is malformed');
  }
  return finalizeNormalizedPlan(
    input.sourceKind,
    input.graphReplacements,
    input.subjectReplacements,
    input.predicateReplacements,
    input.guards,
  );
}

function finalizeNormalizedPlan(
  sourceKind: NormalizedRfc64AuthorCommitCasV1['sourceKind'],
  graphReplacementsInput: readonly Rfc64AuthorCommitGraphReplacementPlanV1[],
  subjectReplacementsInput: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
  predicateReplacementsInput: readonly Rfc64AuthorCommitPredicateReplacementPlanV1[],
  guardsInput: readonly Rfc64AuthorCommitGuardPlanV1[],
): NormalizedRfc64AuthorCommitCasV1 {
  if (graphReplacementsInput.length !== 1) {
    throw new Error('RFC-64 author commit plan requires exactly one shared projection');
  }
  if (
    (sourceKind === 'semantic' && predicateReplacementsInput.length !== 0)
    || (sourceKind === 'legacy' && predicateReplacementsInput.length !== 1)
  ) {
    throw new Error('RFC-64 author commit plan source kind does not match its operations');
  }
  const freezeQuads = (quads: readonly Quad[]): readonly Quad[] => Object.freeze(
    quads.map((quad) => Object.freeze({ ...quad })),
  );
  const graphReplacements = Object.freeze(graphReplacementsInput.map((replacement) =>
    Object.freeze({ ...replacement, quads: freezeQuads(replacement.quads) })));
  const subjectReplacements = Object.freeze(subjectReplacementsInput.map((replacement) =>
    Object.freeze({ ...replacement, quads: freezeQuads(replacement.quads) })));
  const guards = Object.freeze(guardsInput.map((guard) => Object.freeze({
    ...guard,
    expectedQuads: guard.expectedQuads === undefined || guard.expectedQuads === null
      ? guard.expectedQuads
      : freezeQuads(guard.expectedQuads),
  })));
  const predicateReplacements = Object.freeze(predicateReplacementsInput.map((replacement) =>
    Object.freeze({
      ...replacement,
      expectedQuads: replacement.expectedQuads === undefined
        || replacement.expectedQuads === null
        ? replacement.expectedQuads
        : freezeQuads(replacement.expectedQuads),
    })));
  const touchedGraphs = Object.freeze([...new Set([
    ...graphReplacements.map(({ graphUri }) => graphUri),
    ...subjectReplacements.map(({ graphUri }) => graphUri),
    ...predicateReplacements.map(({ graphUri }) => graphUri),
  ])]);
  const referencedGraphs = Object.freeze([...new Set([
    ...touchedGraphs,
    ...guards.map(({ graphUri }) => graphUri),
  ])]);
  const semanticQuads = Object.freeze([
    ...graphReplacements.flatMap(({ quads }) => quads),
    ...subjectReplacements.flatMap(({ quads }) => quads),
    ...predicateReplacements.map((replacement) => Object.freeze({
      graph: replacement.graphUri,
      subject: replacement.subject,
      predicate: replacement.predicate,
      object: replacement.nextObject,
    })),
  ]);
  const plan = Object.freeze({
    planKind: 'rfc64-author-commit-plan-v1' as const,
    sourceKind,
    graphReplacements,
    subjectReplacements,
    predicateReplacements,
    guards,
    semanticQuads,
    touchedGraphs,
    referencedGraphs,
  });
  NORMALIZED_RFC64_AUTHOR_COMMIT_PLANS.add(plan);
  return plan;
}

/** Build the one certified transactional update for the closed manifest. */
export function buildRfc64AuthorCommitCasUpdateV1(
  input: Rfc64AuthorCommitCasInputV1,
): Rfc64AuthorCommitCasUpdateV1 {
  const manifest = normalizeRfc64AuthorCommitCasV1(input);
  const projection = manifest.graphReplacements[0]!;
  const sharedProjectionGraph = assertSafeIri(projection.graphUri);
  const receiptId = randomUUID();
  const receiptGraph = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}rfc64-author-commit:${receiptId}`;
  const receiptSubject = `${receiptGraph}:receipt`;
  const receiptPredicate = 'urn:dkg:sync:authorCommitApplied';
  const receiptObject = '"true"^^<http://www.w3.org/2001/XMLSchema#boolean>';
  const receiptPattern =
    `GRAPH <${receiptGraph}> { <${receiptSubject}> <${receiptPredicate}> ${receiptObject} . }`;
  const replacements = manifest.subjectReplacements;
  const staged: Array<Readonly<{
    targetGraph: string;
    targetSubject: string | null;
    stagingGraph: string;
    quads: readonly Quad[];
  }>> = [{
    targetGraph: sharedProjectionGraph,
    targetSubject: null,
    stagingGraph: `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`,
    quads: projection.quads,
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
  const guards = manifest.guards.map((guard, index) => formatGuard(guard, index));
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
  for (const predicateReplacement of manifest.predicateReplacements) {
    const currentHeadGraph = assertSafeIri(predicateReplacement.graphUri);
    const currentHeadSubject = assertNonBlankNodeIri(
      predicateReplacement.subject,
      'RFC-64 author current-head subject',
    );
    const currentHeadPredicate = assertSafeIri(unwrapIri(predicateReplacement.predicate));
    const nextCurrentHeadObject = formatControlObject(
      predicateReplacement.nextObject,
      'next current head',
    );
    mutations.push(
      `DELETE { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ?oldHead . } }\n` +
      `WHERE { ${receiptPattern} OPTIONAL { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ?oldHead . } } };\n` +
      `INSERT { GRAPH <${currentHeadGraph}> { <${currentHeadSubject}> <${currentHeadPredicate}> ${nextCurrentHeadObject} . } }\n` +
      `WHERE { ${receiptPattern} }`,
    );
  }
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

function validateSemanticInput(
  input: Rfc64AuthorCommitCasSemanticInputV1,
  stateGuards: readonly Rfc64AuthorCommitGuardPlanV1[],
  stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
): void {
  const currentHeadGuard = stateGuards.find(({ role }) => role === 'currentHead');
  const currentHeadReplacement = stateReplacements.find(({ role }) => role === 'currentHead');
  if (!currentHeadGuard || !currentHeadReplacement) {
    throw new Error('RFC-64 author commit requires one guarded current-head replacement');
  }
  for (const guard of stateGuards) {
    if (guard.expectedQuads === undefined) {
      throw new Error(`RFC-64 semantic ${guard.role} guard requires the complete predecessor subject`);
    }
    validateExactSubjectGuard(guard);
  }
  const predecessorQuadCount = stateGuards.reduce(
    (count, guard) => count + (guard.expectedQuads?.length ?? 0),
    0,
  );
  if (predecessorQuadCount > RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1) {
    throw new Error(
      `RFC-64 semantic predecessor payload exceeds ${RFC64_AUTHOR_COMMIT_MAX_CONTROL_QUADS_V1} quads`,
    );
  }
  if (currentHeadReplacement.quads.length === 0) {
    throw new Error('RFC-64 author commit requires a non-empty current-head replacement');
  }
  const nextHeadValues = currentHeadReplacement.quads.filter(({ predicate }) =>
    unwrapIri(predicate) === unwrapIri(currentHeadGuard.predicate));
  if (nextHeadValues.length !== 1) {
    throw new Error(
      'RFC-64 author commit current-head replacement requires exactly one guarded predicate',
    );
  }
  const nextHeadObject = formatControlObject(
    nextHeadValues[0]!.object,
    'next current-head value',
  );
  if (
    currentHeadGuard.expectedObject !== null
    && formatControlObject(currentHeadGuard.expectedObject, 'expected current-head value')
      === nextHeadObject
  ) {
    throw new Error('RFC-64 author commit next current head must advance the guarded value');
  }
  validateCommonRfc64AuthorCommitCasV1(input, stateGuards, stateReplacements, {
    replacementLimit: {
      kind: 'exact',
      value: RFC64_AUTHOR_COMMIT_SEMANTIC_STATE_REPLACEMENTS_V1,
    },
    initialControlQuadCount: 0,
  });
}

function validateLegacyInput(
  input: Rfc64AuthorCommitCasLegacyInputV1,
  currentHead: Rfc64AuthorCommitPredicateReplacementPlanV1,
  stateGuards: readonly Rfc64AuthorCommitGuardPlanV1[],
  stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
): void {
  const currentHeadGraph = assertNonInternalGraph(currentHead.graphUri, 'current-head graph');
  const currentHeadSubject = assertNonBlankNodeIri(
    currentHead.subject,
    'RFC-64 author current-head subject',
  );
  const currentHeadPredicate = assertSafeIri(unwrapIri(currentHead.predicate));
  if (currentHeadGraph === input.sharedProjectionGraph) {
    throw new Error('RFC-64 current head cannot live inside the complete projection graph');
  }
  if (
    currentHeadGraph === input.authorSealGraph
    && currentHeadSubject === input.authorSealSubject
  ) {
    throw new Error('RFC-64 current-head subject cannot also be the author-seal subject');
  }
  const nextCurrentHeadObject = formatControlObject(currentHead.nextObject, 'next current head');
  if (
    currentHead.expectedObject !== null
    && formatControlObject(currentHead.expectedObject, 'expected current head')
      === nextCurrentHeadObject
  ) {
    throw new Error('RFC-64 author commit next current head must advance the guarded value');
  }
  validateCommonRfc64AuthorCommitCasV1(input, stateGuards, stateReplacements, {
    replacementLimit: {
      kind: 'maximum',
      value: RFC64_AUTHOR_COMMIT_MAX_STATE_REPLACEMENTS_V1,
    },
    initialGuardKeys: Object.freeze([
      JSON.stringify([currentHeadGraph, currentHeadSubject, currentHeadPredicate]),
    ]),
    forbiddenReplacement: Object.freeze({
      graphUri: currentHeadGraph,
      subject: currentHeadSubject,
      message: 'RFC-64 current-head subject is owned by the guarded head transition',
    }),
    initialControlQuadCount: 1,
  });
}

interface Rfc64AuthorCommitValidationPolicyV1 {
  readonly replacementLimit: Readonly<{
    kind: 'exact' | 'maximum';
    value: number;
  }>;
  readonly initialGuardKeys?: readonly string[];
  readonly forbiddenReplacement?: Readonly<{
    graphUri: string;
    subject: string;
    message: string;
  }>;
  readonly initialControlQuadCount: number;
}

function validateCommonRfc64AuthorCommitCasV1(
  input: Readonly<{
    sharedProjectionGraph: string;
    sharedProjectionQuads: readonly Quad[];
    authorSealGraph: string;
    authorSealSubject: string;
    authorSealQuads: readonly Quad[];
  }>,
  stateGuards: readonly Rfc64AuthorCommitGuardPlanV1[],
  stateReplacements: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
  policy: Rfc64AuthorCommitValidationPolicyV1,
): void {
  const sharedProjectionGraph = assertNonInternalGraph(
    input.sharedProjectionGraph,
    'shared projection graph',
  );
  if (input.sharedProjectionQuads.length === 0) {
    throw new Error(
      'RFC-64 author commit requires a non-empty shared projection; retraction uses its own certified capability',
    );
  }
  assertReplacementPayload(sharedProjectionGraph, input.sharedProjectionQuads);
  const authorSealGraph = assertNonInternalGraph(input.authorSealGraph, 'author seal graph');
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
  assertSubjectReplacementPayload(authorSealGraph, authorSealSubject, input.authorSealQuads);
  if (stateGuards.length !== RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1) {
    throw new Error(
      `RFC-64 author commit requires exactly ${RFC64_AUTHOR_COMMIT_MAX_STATE_GUARDS_V1} state guards`,
    );
  }
  if (
    policy.replacementLimit.kind === 'exact'
    && stateReplacements.length !== policy.replacementLimit.value
  ) {
    throw new Error(
      `RFC-64 semantic author commit requires exactly ${policy.replacementLimit.value} state replacements`,
    );
  }
  if (
    policy.replacementLimit.kind === 'maximum'
    && stateReplacements.length > policy.replacementLimit.value
  ) {
    throw new Error(
      `RFC-64 author commit accepts at most ${policy.replacementLimit.value} state replacements`,
    );
  }
  const guardKeys = new Set(policy.initialGuardKeys ?? []);
  for (const guard of stateGuards) {
    const graphUri = assertNonInternalGraph(guard.graphUri, 'state guard graph');
    const subject = assertNonBlankNodeIri(guard.subject, 'RFC-64 author commit guard subject');
    const predicate = assertSafeIri(unwrapIri(guard.predicate));
    if (guard.expectedObject !== null) {
      formatControlObject(guard.expectedObject, 'expected guard value');
    }
    const key = JSON.stringify([graphUri, subject, predicate]);
    if (guardKeys.has(key)) throw new Error('RFC-64 author commit contains a duplicate guard');
    guardKeys.add(key);
  }
  const replacementKeys = new Set([JSON.stringify([authorSealGraph, authorSealSubject])]);
  let controlQuadCount = policy.initialControlQuadCount + input.authorSealQuads.length;
  for (const replacement of stateReplacements) {
    const graphUri = assertNonInternalGraph(replacement.graphUri, 'state replacement graph');
    const subject = assertNonBlankNodeIri(
      replacement.subject,
      'RFC-64 author commit replacement subject',
    );
    if (graphUri === sharedProjectionGraph) {
      throw new Error(
        'RFC-64 author commit cannot replace a subject inside its complete projection graph',
      );
    }
    if (
      policy.forbiddenReplacement
      && graphUri === policy.forbiddenReplacement.graphUri
      && subject === policy.forbiddenReplacement.subject
    ) {
      throw new Error(policy.forbiddenReplacement.message);
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
  if (guard.expectedQuads !== undefined) {
    return formatExactSubjectGuard(graphUri, subject, guard.expectedQuads, index);
  }
  const predicate = assertSafeIri(unwrapIri(guard.predicate));
  if (guard.expectedObject === null) {
    return `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?guard${index} . } }`;
  }
  const expected = formatControlObject(guard.expectedObject, 'expected guard value');
  return `GRAPH <${graphUri}> { <${subject}> <${predicate}> ${expected} . } ` +
    `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> <${predicate}> ?other${index} . ` +
    `FILTER(!sameTerm(?other${index}, ${expected})) } }`;
}

function validateExactSubjectGuard(guard: Rfc64AuthorCommitValueGuardV1): void {
  if (guard.expectedQuads === undefined) return;
  if (guard.expectedQuads === null) {
    if (guard.expectedObject !== null) {
      throw new Error('RFC-64 absent semantic predecessor cannot carry a guard value');
    }
    return;
  }
  if (guard.expectedQuads.length === 0) {
    throw new Error('RFC-64 semantic predecessor subject cannot be empty');
  }
  assertSubjectReplacementPayload(guard.graphUri, guard.subject, guard.expectedQuads);
  const guardValues = guard.expectedQuads.filter(({ predicate }) =>
    unwrapIri(predicate) === unwrapIri(guard.predicate));
  if (guardValues.length !== 1 || guard.expectedObject === null) {
    throw new Error('RFC-64 semantic predecessor must contain exactly one guard value');
  }
  if (
    formatControlObject(guardValues[0]!.object, 'semantic predecessor guard value')
      !== formatControlObject(guard.expectedObject, 'expected semantic predecessor guard value')
  ) {
    throw new Error('RFC-64 semantic predecessor guard value disagrees with its complete subject');
  }
}

function formatExactSubjectGuard(
  graphUri: string,
  subject: string,
  expectedQuads: readonly Quad[] | null,
  index: number,
): string {
  if (expectedQuads === null) {
    return `FILTER NOT EXISTS { GRAPH <${graphUri}> { <${subject}> ?guardP${index} ?guardO${index} . } }`;
  }
  const exactRows = expectedQuads.map(({ predicate, object }) => {
    const expectedPredicate = assertSafeIri(unwrapIri(predicate));
    const expectedObject = formatControlObject(object, 'expected semantic predecessor value');
    return Object.freeze({ expectedPredicate, expectedObject });
  });
  const required = exactRows.map(({ expectedPredicate, expectedObject }) =>
    `GRAPH <${graphUri}> { <${subject}> <${expectedPredicate}> ${expectedObject} . }`).join('\n  ');
  const allowed = exactRows.map(({ expectedPredicate, expectedObject }) =>
    `(sameTerm(?guardP${index}, <${expectedPredicate}>) && ` +
    `sameTerm(?guardO${index}, ${expectedObject}))`).join(' || ');
  return `${required}\n  FILTER NOT EXISTS { GRAPH <${graphUri}> { ` +
    `<${subject}> ?guardP${index} ?guardO${index} . FILTER(!(${allowed})) } }`;
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
