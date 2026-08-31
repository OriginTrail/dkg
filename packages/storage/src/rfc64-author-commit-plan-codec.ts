import {
  readOwnEnumerableDataProperty,
  snapshotDenseDataArray,
  snapshotExactDataRecord,
} from '@origintrail-official/dkg-core/closed-data-snapshot';

import type { Quad } from './triple-store.js';
import type {
  Rfc64AuthorCommitCasLegacyInputV1,
  Rfc64AuthorCommitCasSemanticInputV1,
  Rfc64AuthorCommitCasSourceInputV1,
  Rfc64AuthorCommitExactStateTransitionV1,
  Rfc64AuthorCommitExactSubjectGuardV1,
  Rfc64AuthorCommitPredicateValueGuardV1,
  Rfc64AuthorCommitStateTransitionV1,
} from './rfc64-author-commit-cas.js';

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

type Rfc64AuthorCommitGuardRoleV1 = Exclude<
  Rfc64AuthorCommitSemanticRoleV1,
  'sharedProjection' | 'authorSeal' | 'sealInvalidation'
>;

export type Rfc64AuthorCommitGuardPlanV1 =
  | (Rfc64AuthorCommitPredicateValueGuardV1 & Readonly<{
    role: Rfc64AuthorCommitGuardRoleV1;
  }>)
  | (Rfc64AuthorCommitExactSubjectGuardV1 & Readonly<{
    role: Rfc64AuthorCommitGuardRoleV1;
  }>);

export interface Rfc64AuthorCommitPredicateReplacementPlanV1
  extends Rfc64AuthorCommitPredicateValueGuardV1 {
  readonly role: Rfc64AuthorCommitGuardRoleV1;
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

interface NormalizedRfc64AuthorCommitCasBaseV1 {
  readonly planKind: 'rfc64-author-commit-plan-v1';
  readonly semanticQuads: readonly Quad[];
  readonly touchedGraphs: readonly string[];
  readonly referencedGraphs: readonly string[];
}

type SubjectReplacementForV1<
  Role extends Exclude<Rfc64AuthorCommitSemanticRoleV1, 'sharedProjection'>,
  Index extends number = 0,
> = Omit<Rfc64AuthorCommitSubjectReplacementPlanV1, 'role' | 'roleIndex'> & Readonly<{
  role: Role;
  roleIndex: Index;
}>;

type PredicateGuardForV1<Role extends Rfc64AuthorCommitGuardPlanV1['role']> =
  Rfc64AuthorCommitPredicateValueGuardV1 & Readonly<{ role: Role }>;
type ExactGuardForV1<Role extends Rfc64AuthorCommitGuardPlanV1['role']> =
  Rfc64AuthorCommitExactSubjectGuardV1 & Readonly<{ role: Role }>;

export interface NormalizedRfc64SemanticAuthorCommitCasV1
  extends NormalizedRfc64AuthorCommitCasBaseV1 {
  readonly sourceKind: 'semantic';
  readonly graphReplacements: readonly [Rfc64AuthorCommitGraphReplacementPlanV1];
  readonly subjectReplacements: readonly [
    SubjectReplacementForV1<'authorSeal'>,
    SubjectReplacementForV1<'currentHead'>,
    SubjectReplacementForV1<'subgraphMutationGeneration'>,
    SubjectReplacementForV1<'contextGraphMutationGeneration'>,
    SubjectReplacementForV1<'appliedSet'>,
  ];
  readonly predicateReplacements: readonly [];
  readonly guards: readonly [
    ExactGuardForV1<'currentHead'>,
    ExactGuardForV1<'subgraphMutationGeneration'>,
    ExactGuardForV1<'contextGraphMutationGeneration'>,
    ExactGuardForV1<'appliedSet'>,
  ];
}

export interface NormalizedRfc64LegacyAuthorCommitCasV1
  extends NormalizedRfc64AuthorCommitCasBaseV1 {
  readonly sourceKind: 'legacy';
  readonly graphReplacements: readonly [Rfc64AuthorCommitGraphReplacementPlanV1];
  readonly subjectReplacements: readonly [
    SubjectReplacementForV1<'authorSeal'>,
    SubjectReplacementForV1<'kaStateDigest'>,
    SubjectReplacementForV1<'subgraphMutationGeneration'>,
    SubjectReplacementForV1<'contextGraphMutationGeneration'>,
    SubjectReplacementForV1<'appliedSet'>,
    ...SubjectReplacementForV1<'sealInvalidation', number>[],
  ];
  readonly predicateReplacements: readonly [Rfc64AuthorCommitPredicateReplacementPlanV1];
  readonly guards: readonly [
    PredicateGuardForV1<'currentHead'>,
    PredicateGuardForV1<'kaStateDigest'>,
    PredicateGuardForV1<'subgraphMutationGeneration'>,
    PredicateGuardForV1<'contextGraphMutationGeneration'>,
    PredicateGuardForV1<'appliedSet'>,
  ];
}

export type NormalizedRfc64AuthorCommitCasV1 =
  | NormalizedRfc64SemanticAuthorCommitCasV1
  | NormalizedRfc64LegacyAuthorCommitCasV1;

export interface Rfc64AuthorCommitPlanLimitsV1 {
  readonly maximumStateGuards: number;
  readonly maximumStateReplacements: number;
}

export type Rfc64AuthorCommitPlanTopologyValidatorV1 = (
  sourceKind: NormalizedRfc64AuthorCommitCasV1['sourceKind'],
  graphReplacements: readonly Rfc64AuthorCommitGraphReplacementPlanV1[],
  subjectReplacements: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
  predicateReplacements: readonly Rfc64AuthorCommitPredicateReplacementPlanV1[],
  guards: readonly Rfc64AuthorCommitGuardPlanV1[],
) => void;

const CERTIFIED_PLANS = new WeakSet<object>();

export function sourceFromRfc64AuthorCommitPlanV1(
  plan: NormalizedRfc64AuthorCommitCasV1,
): Rfc64AuthorCommitCasSourceInputV1 {
  const projection = plan.graphReplacements[0]!;
  const authorSeal = plan.subjectReplacements[0]!;

  if (plan.sourceKind === 'semantic') {
    const transition = (index: number): Rfc64AuthorCommitExactStateTransitionV1 => {
      const replacement = plan.subjectReplacements[index + 1]!;
      const guard = plan.guards[index]!;
      return Object.freeze({
        graphUri: guard.graphUri,
        subject: guard.subject,
        predicate: guard.predicate,
        expectedObject: guard.expectedObject,
        expectedQuads: guard.expectedQuads,
        quads: replacement.quads,
      });
    };
    return Object.freeze({
      sharedProjectionGraph: projection.graphUri,
      sharedProjectionQuads: projection.quads,
      authorSealGraph: authorSeal.graphUri,
      authorSealSubject: authorSeal.subject,
      authorSealQuads: authorSeal.quads,
      currentHead: transition(0),
      subgraphMutationGeneration: transition(1),
      contextGraphMutationGeneration: transition(2),
      appliedSet: transition(3),
    }) satisfies Rfc64AuthorCommitCasSemanticInputV1;
  }

  const transition = (index: number): Rfc64AuthorCommitStateTransitionV1 => {
    const replacement = plan.subjectReplacements[index + 1]!;
    const guard = plan.guards[index + 1]!;
    return Object.freeze({
      graphUri: guard.graphUri,
      subject: guard.subject,
      predicate: guard.predicate,
      expectedObject: guard.expectedObject,
      quads: replacement.quads,
    });
  };
  const currentHead = plan.predicateReplacements[0]!;
  return Object.freeze({
    sharedProjectionGraph: projection.graphUri,
    sharedProjectionQuads: projection.quads,
    authorSealGraph: authorSeal.graphUri,
    authorSealSubject: authorSeal.subject,
    authorSealQuads: authorSeal.quads,
    currentHeadGraph: currentHead.graphUri,
    currentHeadSubject: currentHead.subject,
    currentHeadPredicate: currentHead.predicate,
    expectedCurrentHeadObject: currentHead.expectedObject,
    nextCurrentHeadObject: currentHead.nextObject,
    kaStateDigest: transition(0),
    subgraphMutationGeneration: transition(1),
    contextGraphMutationGeneration: transition(2),
    appliedSet: transition(3),
    sealInvalidations: Object.freeze(plan.subjectReplacements
      .slice(5)
      .map(({ graphUri, subject, quads }) => Object.freeze({ graphUri, subject, quads }))),
  }) satisfies Rfc64AuthorCommitCasLegacyInputV1;
}

export async function mapRfc64AuthorCommitPlanV1(
  manifest: NormalizedRfc64AuthorCommitCasV1,
  mapper: Rfc64AuthorCommitCasMapperV1,
  limits: Rfc64AuthorCommitPlanLimitsV1,
  validateTopology: Rfc64AuthorCommitPlanTopologyValidatorV1,
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
  const subjectReplacements = await Promise.all(manifest.subjectReplacements.map(
    async (replacement) => ({
      ...replacement,
      quads: await Promise.all(replacement.quads.map((quad) => mapper.mapQuad(quad, {
        role: replacement.role,
        roleIndex: replacement.roleIndex,
        graphUri: replacement.graphUri,
        subject: replacement.subject,
      }))),
    }),
  ));
  const guards = await Promise.all(manifest.guards.map(async (guard) => {
    const expectedObject = await mapper.mapObject(guard.expectedObject, {
      role: guard.role,
      graphUri: guard.graphUri,
      kind: 'expected',
    });
    if (guard.guardKind === 'predicate-value') return { ...guard, expectedObject };
    return {
      ...guard,
      expectedObject,
      expectedQuads: guard.expectedQuads === null
        ? null
        : await Promise.all(guard.expectedQuads.map((quad) => mapper.mapQuad(quad, {
          role: guard.role,
          roleIndex: 0,
          graphUri: guard.graphUri,
          subject: guard.subject,
        }))),
    };
  }));
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
        nextObject,
      };
    }),
  );

  return finalizeRfc64AuthorCommitPlanV1(
    manifest.sourceKind,
    graphReplacements,
    subjectReplacements,
    predicateReplacements,
    guards,
    limits,
    validateTopology,
  );
}

export function decodeRfc64AuthorCommitPlanV1(
  input: unknown,
  limits: Rfc64AuthorCommitPlanLimitsV1,
  validateTopology: Rfc64AuthorCommitPlanTopologyValidatorV1,
): NormalizedRfc64AuthorCommitCasV1 {
  if (input !== null && typeof input === 'object' && CERTIFIED_PLANS.has(input)) {
    return input as NormalizedRfc64AuthorCommitCasV1;
  }
  const plan = snapshotExactDataRecord(input, [
    'graphReplacements',
    'guards',
    'planKind',
    'predicateReplacements',
    'referencedGraphs',
    'semanticQuads',
    'sourceKind',
    'subjectReplacements',
    'touchedGraphs',
  ], 'RFC-64 author commit plan');
  if (
    plan.planKind !== 'rfc64-author-commit-plan-v1'
    || (plan.sourceKind !== 'legacy' && plan.sourceKind !== 'semantic')
  ) {
    throw new Error('RFC-64 author commit plan is malformed');
  }
  return finalizeRfc64AuthorCommitPlanV1(
    plan.sourceKind,
    plan.graphReplacements as readonly Rfc64AuthorCommitGraphReplacementPlanV1[],
    plan.subjectReplacements as readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
    plan.predicateReplacements as readonly Rfc64AuthorCommitPredicateReplacementPlanV1[],
    plan.guards as readonly Rfc64AuthorCommitGuardPlanV1[],
    limits,
    validateTopology,
  );
}

export function finalizeRfc64AuthorCommitPlanV1(
  sourceKind: NormalizedRfc64AuthorCommitCasV1['sourceKind'],
  graphReplacementsInput: readonly Rfc64AuthorCommitGraphReplacementPlanV1[],
  subjectReplacementsInput: readonly Rfc64AuthorCommitSubjectReplacementPlanV1[],
  predicateReplacementsInput: readonly Rfc64AuthorCommitPredicateReplacementPlanV1[],
  guardsInput: readonly Rfc64AuthorCommitGuardPlanV1[],
  limits: Rfc64AuthorCommitPlanLimitsV1,
  validateTopology: Rfc64AuthorCommitPlanTopologyValidatorV1,
): NormalizedRfc64AuthorCommitCasV1 {
  const rawGraphReplacements = snapshotPlanArray(
    graphReplacementsInput,
    'graph replacements',
    1,
  );
  const rawSubjectReplacements = snapshotPlanArray(
    subjectReplacementsInput,
    'subject replacements',
    limits.maximumStateReplacements + 1,
  );
  const rawPredicateReplacements = snapshotPlanArray(
    predicateReplacementsInput,
    'predicate replacements',
    1,
  );
  const rawGuards = snapshotPlanArray(
    guardsInput,
    'guards',
    limits.maximumStateGuards + 1,
  );
  if (rawGraphReplacements.length !== 1) {
    throw new Error('RFC-64 author commit plan requires exactly one shared projection');
  }
  if (
    (sourceKind === 'semantic' && rawPredicateReplacements.length !== 0)
    || (sourceKind === 'legacy' && rawPredicateReplacements.length !== 1)
  ) {
    throw new Error('RFC-64 author commit plan source kind does not match its operations');
  }
  const graphReplacements = Object.freeze(rawGraphReplacements.map(
    (replacement, index) => snapshotGraphReplacement(replacement, index),
  ));
  const subjectReplacements = Object.freeze(rawSubjectReplacements.map(
    (replacement, index) => snapshotSubjectReplacement(replacement, index),
  ));
  const guards = Object.freeze(rawGuards.map(
    (guard, index) => snapshotGuard(guard, index),
  ));
  const predicateReplacements = Object.freeze(rawPredicateReplacements.map(
    (replacement, index) => snapshotPredicateReplacement(replacement, index),
  ));
  validateTopology(
    sourceKind,
    graphReplacements,
    subjectReplacements,
    predicateReplacements,
    guards,
  );
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
  }) as NormalizedRfc64AuthorCommitCasV1;
  CERTIFIED_PLANS.add(plan);
  return plan;
}

function snapshotPlanArray(
  input: unknown,
  label: string,
  maximumLength: number,
): readonly unknown[] {
  const values = snapshotDenseDataArray(input, `RFC-64 author commit ${label}`);
  if (values.length > maximumLength) {
    throw new Error(`RFC-64 author commit plan has too many ${label}`);
  }
  return values;
}

function snapshotQuadArray(input: unknown, label: string): readonly Quad[] {
  const values = snapshotDenseDataArray(input, label);
  return Object.freeze(values.map((value, index) => {
    const quad = snapshotExactDataRecord(
      value,
      ['graph', 'object', 'predicate', 'subject'],
      `${label}[${index}]`,
    );
    if (
      typeof quad.graph !== 'string'
      || typeof quad.object !== 'string'
      || typeof quad.predicate !== 'string'
      || typeof quad.subject !== 'string'
    ) {
      throw new Error(`${label}[${index}] must contain string quad terms`);
    }
    return Object.freeze({
      graph: quad.graph,
      object: quad.object,
      predicate: quad.predicate,
      subject: quad.subject,
    });
  }));
}

function snapshotGraphReplacement(
  input: unknown,
  index: number,
): Rfc64AuthorCommitGraphReplacementPlanV1 {
  const label = `RFC-64 author commit graph replacement ${index}`;
  const value = snapshotExactDataRecord(input, ['graphUri', 'quads', 'role'], label);
  if (value.role !== 'sharedProjection' || typeof value.graphUri !== 'string') {
    throw new Error(`${label} has an invalid role or graph`);
  }
  return Object.freeze({
    role: value.role,
    graphUri: value.graphUri,
    quads: snapshotQuadArray(value.quads, `${label}.quads`),
  });
}

function snapshotSubjectReplacement(
  input: unknown,
  index: number,
): Rfc64AuthorCommitSubjectReplacementPlanV1 {
  const label = `RFC-64 author commit subject replacement ${index}`;
  const value = snapshotExactDataRecord(
    input,
    ['graphUri', 'quads', 'role', 'roleIndex', 'subject'],
    label,
  );
  if (
    !isSemanticRole(value.role)
    || value.role === 'sharedProjection'
    || typeof value.roleIndex !== 'number'
    || !Number.isSafeInteger(value.roleIndex)
    || value.roleIndex < 0
    || typeof value.graphUri !== 'string'
    || typeof value.subject !== 'string'
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  return Object.freeze({
    role: value.role,
    roleIndex: value.roleIndex,
    graphUri: value.graphUri,
    subject: value.subject,
    quads: snapshotQuadArray(value.quads, `${label}.quads`),
  });
}

function snapshotGuard(input: unknown, index: number): Rfc64AuthorCommitGuardPlanV1 {
  const label = `RFC-64 author commit guard ${index}`;
  const guardKind = readOwnEnumerableDataProperty(input, 'guardKind', label);
  const keys = guardKind === 'exact-subject'
    ? ['expectedObject', 'expectedQuads', 'graphUri', 'guardKind', 'predicate', 'role', 'subject']
    : ['expectedObject', 'graphUri', 'guardKind', 'predicate', 'role', 'subject'];
  const value = snapshotExactDataRecord(input, keys, label);
  if (
    (guardKind !== 'predicate-value' && guardKind !== 'exact-subject')
    || !isGuardRole(value.role)
    || typeof value.graphUri !== 'string'
    || typeof value.subject !== 'string'
    || typeof value.predicate !== 'string'
    || (value.expectedObject !== null && typeof value.expectedObject !== 'string')
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  if (guardKind === 'predicate-value') {
    return Object.freeze({
      guardKind,
      role: value.role,
      graphUri: value.graphUri,
      subject: value.subject,
      predicate: value.predicate,
      expectedObject: value.expectedObject as string | null,
    });
  }
  return Object.freeze({
    guardKind,
    role: value.role,
    graphUri: value.graphUri,
    subject: value.subject,
    predicate: value.predicate,
    expectedObject: value.expectedObject as string | null,
    expectedQuads: value.expectedQuads === null
      ? null
      : snapshotQuadArray(value.expectedQuads, `${label}.expectedQuads`),
  });
}

function snapshotPredicateReplacement(
  input: unknown,
  index: number,
): Rfc64AuthorCommitPredicateReplacementPlanV1 {
  const label = `RFC-64 author commit predicate replacement ${index}`;
  const value = snapshotExactDataRecord(input, [
    'expectedObject',
    'graphUri',
    'guardKind',
    'nextObject',
    'predicate',
    'role',
    'subject',
  ], label);
  if (
    value.guardKind !== 'predicate-value'
    || !isGuardRole(value.role)
    || typeof value.graphUri !== 'string'
    || typeof value.subject !== 'string'
    || typeof value.predicate !== 'string'
    || (value.expectedObject !== null && typeof value.expectedObject !== 'string')
    || typeof value.nextObject !== 'string'
  ) {
    throw new Error(`${label} has invalid fields`);
  }
  return Object.freeze({
    guardKind: value.guardKind,
    role: value.role,
    graphUri: value.graphUri,
    subject: value.subject,
    predicate: value.predicate,
    expectedObject: value.expectedObject as string | null,
    nextObject: value.nextObject,
  });
}

function isSemanticRole(value: unknown): value is Rfc64AuthorCommitSemanticRoleV1 {
  return typeof value === 'string' && [
    'sharedProjection',
    'authorSeal',
    'currentHead',
    'kaStateDigest',
    'subgraphMutationGeneration',
    'contextGraphMutationGeneration',
    'appliedSet',
    'sealInvalidation',
  ].includes(value);
}

function isGuardRole(value: unknown): value is Rfc64AuthorCommitGuardPlanV1['role'] {
  return isSemanticRole(value)
    && value !== 'sharedProjection'
    && value !== 'authorSeal'
    && value !== 'sealInvalidation';
}
