import {
  RFC64_SEMANTIC_PREDICATES_V1,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  snapshotRfc64SemanticRecordV1,
  type Rfc64SemanticRecordTypeV1,
  type Rfc64SemanticRecordV1,
} from '@origintrail-official/dkg-core';

import {
  type Quad,
} from './triple-store.js';
import {
  normalizeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasInputV1,
  type Rfc64AuthorCommitStateTransitionV1,
} from './rfc64-author-commit-cas.js';

type SemanticRecordOfV1<Type extends Rfc64SemanticRecordTypeV1> = Extract<
  Rfc64SemanticRecordV1,
  { readonly recordType: Type }
>;

type CurrentHeadRecordV1 = SemanticRecordOfV1<'CurrentAuthorCatalogRefV1'>;
type SubgraphMutationRecordV1 = SemanticRecordOfV1<'SubgraphMutationGuardV1'>;
type ContextGraphMutationRecordV1 = SemanticRecordOfV1<'ContextGraphMutationGuardV1'>;
type AppliedSetRecordV1 = SemanticRecordOfV1<'AppliedSubgraphSetRefV1'>;
type GenerationRecordV1 =
  | SubgraphMutationRecordV1
  | ContextGraphMutationRecordV1
  | AppliedSetRecordV1;

export interface Rfc64SemanticAuthorCommitInputV1 {
  readonly sharedProjectionGraph: string;
  readonly sharedProjectionQuads: readonly Quad[];
  readonly authorSealGraph: string;
  readonly authorSealSubject: string;
  readonly authorSealQuads: readonly Quad[];
  readonly expectedCurrentHead: CurrentHeadRecordV1 | null;
  readonly nextCurrentHead: CurrentHeadRecordV1;
  readonly expectedSubgraphMutation: SubgraphMutationRecordV1 | null;
  readonly nextSubgraphMutation: SubgraphMutationRecordV1;
  readonly expectedContextGraphMutation: ContextGraphMutationRecordV1 | null;
  readonly nextContextGraphMutation: ContextGraphMutationRecordV1;
  readonly expectedAppliedSet: AppliedSetRecordV1 | null;
  readonly nextAppliedSet: AppliedSetRecordV1;
}

export type Rfc64SemanticAuthorCommitErrorCodeV1 =
  | 'rfc64-semantic-author-commit-schema'
  | 'rfc64-semantic-author-commit-scope'
  | 'rfc64-semantic-author-commit-generation';

export class Rfc64SemanticAuthorCommitErrorV1 extends Error {
  constructor(
    readonly code: Rfc64SemanticAuthorCommitErrorCodeV1,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`[${code}] ${message}`, options);
    this.name = 'Rfc64SemanticAuthorCommitErrorV1';
  }
}

/**
 * Compile one authenticated author publication into the closed backend CAS.
 * All four control subjects are complete codec projections at canonical
 * addresses; callers cannot supply a semantic graph, subject, or predicate.
 */
export function compileRfc64SemanticAuthorCommitV1(
  input: unknown,
): Rfc64AuthorCommitCasInputV1 {
  const candidate = snapshotExactRecord(input, [
    'authorSealGraph',
    'authorSealQuads',
    'authorSealSubject',
    'expectedAppliedSet',
    'expectedContextGraphMutation',
    'expectedCurrentHead',
    'expectedSubgraphMutation',
    'nextAppliedSet',
    'nextContextGraphMutation',
    'nextCurrentHead',
    'nextSubgraphMutation',
    'sharedProjectionGraph',
    'sharedProjectionQuads',
  ], 'semantic author commit');

  const expectedCurrentHead = optionalRecord(
    candidate.expectedCurrentHead,
    'CurrentAuthorCatalogRefV1',
  );
  const nextCurrentHead = requiredRecord(
    candidate.nextCurrentHead,
    'CurrentAuthorCatalogRefV1',
  );
  const expectedSubgraphMutation = optionalRecord(
    candidate.expectedSubgraphMutation,
    'SubgraphMutationGuardV1',
  );
  const nextSubgraphMutation = requiredRecord(
    candidate.nextSubgraphMutation,
    'SubgraphMutationGuardV1',
  );
  const expectedContextGraphMutation = optionalRecord(
    candidate.expectedContextGraphMutation,
    'ContextGraphMutationGuardV1',
  );
  const nextContextGraphMutation = requiredRecord(
    candidate.nextContextGraphMutation,
    'ContextGraphMutationGuardV1',
  );
  const expectedAppliedSet = optionalRecord(
    candidate.expectedAppliedSet,
    'AppliedSubgraphSetRefV1',
  );
  const nextAppliedSet = requiredRecord(
    candidate.nextAppliedSet,
    'AppliedSubgraphSetRefV1',
  );

  assertOneScope(
    expectedCurrentHead,
    nextCurrentHead,
    expectedSubgraphMutation,
    nextSubgraphMutation,
    expectedContextGraphMutation,
    nextContextGraphMutation,
    expectedAppliedSet,
    nextAppliedSet,
  );
  assertHeadAdvances(expectedCurrentHead, nextCurrentHead);
  assertGenerationAdvances(
    'subgraph mutation',
    expectedSubgraphMutation,
    nextSubgraphMutation,
  );
  assertGenerationAdvances(
    'context-graph mutation',
    expectedContextGraphMutation,
    nextContextGraphMutation,
  );
  assertGenerationAdvances('applied set', expectedAppliedSet, nextAppliedSet);
  if (nextAppliedSet.value.generation !== nextContextGraphMutation.value.generation) {
    fail(
      'rfc64-semantic-author-commit-generation',
      'next applied-set and context-graph mutation generations must match',
    );
  }
  if (
    expectedAppliedSet !== null
    && expectedContextGraphMutation !== null
    && expectedAppliedSet.value.generation
      !== expectedContextGraphMutation.value.generation
  ) {
    fail(
      'rfc64-semantic-author-commit-generation',
      'expected applied-set and context-graph mutation generations must match',
    );
  }

  const compiled = Object.freeze({
    sharedProjectionGraph: requiredString(
      candidate.sharedProjectionGraph,
      'sharedProjectionGraph',
    ),
    sharedProjectionQuads: snapshotQuads(
      candidate.sharedProjectionQuads,
      'sharedProjectionQuads',
    ),
    authorSealGraph: requiredString(candidate.authorSealGraph, 'authorSealGraph'),
    authorSealSubject: requiredString(candidate.authorSealSubject, 'authorSealSubject'),
    authorSealQuads: snapshotQuads(candidate.authorSealQuads, 'authorSealQuads'),
    currentHead: transition(
      expectedCurrentHead,
      nextCurrentHead,
      RFC64_SEMANTIC_PREDICATES_V1.CATALOG_HEAD_DIGEST,
    ),
    subgraphMutationGeneration: transition(
      expectedSubgraphMutation,
      nextSubgraphMutation,
      RFC64_SEMANTIC_PREDICATES_V1.GENERATION,
    ),
    contextGraphMutationGeneration: transition(
      expectedContextGraphMutation,
      nextContextGraphMutation,
      RFC64_SEMANTIC_PREDICATES_V1.GENERATION,
    ),
    appliedSet: transition(
      expectedAppliedSet,
      nextAppliedSet,
      RFC64_SEMANTIC_PREDICATES_V1.GENERATION,
    ),
  });
  normalizeRfc64AuthorCommitCasV1(compiled);
  return compiled;
}

function transition<Type extends Rfc64SemanticRecordTypeV1>(
  expected: SemanticRecordOfV1<Type> | null,
  next: SemanticRecordOfV1<Type>,
  guardPredicate: string,
): Rfc64AuthorCommitStateTransitionV1 {
  const nextRows = projectRfc64SemanticRecordStoreRowsV1(next);
  const firstNextRow = nextRows[0];
  if (firstNextRow === undefined) {
    fail('rfc64-semantic-author-commit-schema', `${next.recordType} has no codec rows`);
  }
  if (expected !== null) {
    const firstExpectedRow = projectRfc64SemanticRecordStoreRowsV1(expected)[0];
    if (firstExpectedRow === undefined) {
      fail('rfc64-semantic-author-commit-schema', `${expected.recordType} has no codec rows`);
    }
    if (
      firstExpectedRow.graphIri !== firstNextRow.graphIri
      || firstExpectedRow.subjectIri !== firstNextRow.subjectIri
    ) {
      fail(
        'rfc64-semantic-author-commit-scope',
        `${next.recordType} predecessor and successor addresses differ`,
      );
    }
  }
  const expectedObject = expected === null
    ? null
    : renderedGuardObject(expected, guardPredicate);
  const quads = Object.freeze(nextRows.map(renderRfc64SemanticStoreRowV1));
  return Object.freeze({
    graphUri: firstNextRow.graphIri,
    subject: firstNextRow.subjectIri,
    predicate: guardPredicate,
    expectedObject,
    quads,
  });
}

function renderedGuardObject(
  record: Rfc64SemanticRecordV1,
  predicate: string,
): string {
  const matches = projectRfc64SemanticRecordStoreRowsV1(record)
    .filter((row) => row.predicateIri === predicate);
  if (matches.length !== 1) {
    fail(
      'rfc64-semantic-author-commit-schema',
      `${record.recordType} does not contain exactly one guard predicate`,
    );
  }
  return renderRfc64SemanticStoreRowV1(matches[0]).object;
}

function assertOneScope(
  expectedCurrentHead: CurrentHeadRecordV1 | null,
  nextCurrentHead: CurrentHeadRecordV1,
  expectedSubgraphMutation: SubgraphMutationRecordV1 | null,
  nextSubgraphMutation: SubgraphMutationRecordV1,
  expectedContextGraphMutation: ContextGraphMutationRecordV1 | null,
  nextContextGraphMutation: ContextGraphMutationRecordV1,
  expectedAppliedSet: AppliedSetRecordV1 | null,
  nextAppliedSet: AppliedSetRecordV1,
): void {
  const scope = nextCurrentHead.value;
  const candidates = [
    expectedCurrentHead,
    nextCurrentHead,
    expectedSubgraphMutation,
    nextSubgraphMutation,
    expectedContextGraphMutation,
    nextContextGraphMutation,
    expectedAppliedSet,
    nextAppliedSet,
  ];
  const all: Rfc64SemanticRecordV1[] = [];
  for (const record of candidates) {
    if (record !== null) all.push(record);
  }
  if (all.some(({ value }) => (
    value.networkId !== scope.networkId
    || value.contextGraphId !== scope.contextGraphId
  ))) {
    fail('rfc64-semantic-author-commit-scope', 'semantic commit records span scopes');
  }
  if (
    nextSubgraphMutation.value.subGraphName !== scope.subGraphName
    || expectedSubgraphMutation?.value.subGraphName !== undefined
      && expectedSubgraphMutation.value.subGraphName !== scope.subGraphName
    || expectedCurrentHead?.value.subGraphName !== undefined
      && expectedCurrentHead.value.subGraphName !== scope.subGraphName
    || expectedCurrentHead?.value.authorAddress !== undefined
      && expectedCurrentHead.value.authorAddress !== scope.authorAddress
  ) {
    fail('rfc64-semantic-author-commit-scope', 'semantic commit author lane differs');
  }
}

function assertHeadAdvances(
  expected: CurrentHeadRecordV1 | null,
  next: CurrentHeadRecordV1,
): void {
  if (expected === null) {
    if (next.value.catalogVersion !== '1') {
      fail(
        'rfc64-semantic-author-commit-generation',
        'the first semantic author commit must install catalog version one',
      );
    }
    return;
  }
  if (
    expected.value.governanceChainId !== next.value.governanceChainId
    || expected.value.governanceContractAddress !== next.value.governanceContractAddress
    || expected.value.ownershipTransitionDigest !== next.value.ownershipTransitionDigest
    || expected.value.catalogEra !== next.value.catalogEra
  ) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'ordinary author commit cannot change the catalog authority scope',
    );
  }
  if (
    expected.value.catalogHeadDigest === next.value.catalogHeadDigest
    || BigInt(next.value.catalogVersion) !== BigInt(expected.value.catalogVersion) + 1n
  ) {
    fail(
      'rfc64-semantic-author-commit-generation',
      'next current-author catalog head must advance by exactly one version',
    );
  }
}

function assertGenerationAdvances(
  label: string,
  expected: GenerationRecordV1 | null,
  next: GenerationRecordV1,
): void {
  if (expected === null && next.value.generation !== '1') {
    fail(
      'rfc64-semantic-author-commit-generation',
      `the first ${label} generation must be one`,
    );
  }
  if (
    expected !== null
    && BigInt(next.value.generation) !== BigInt(expected.value.generation) + 1n
  ) {
    fail(
      'rfc64-semantic-author-commit-generation',
      `${label} generation must advance by exactly one`,
    );
  }
}

function requiredRecord<Type extends Rfc64SemanticRecordTypeV1>(
  input: unknown,
  recordType: Type,
): SemanticRecordOfV1<Type> {
  const record = snapshotRfc64SemanticRecordV1(input);
  if (record.recordType !== recordType) {
    fail(
      'rfc64-semantic-author-commit-schema',
      `semantic author commit expected ${recordType}`,
    );
  }
  return record as SemanticRecordOfV1<Type>;
}

function optionalRecord<Type extends Rfc64SemanticRecordTypeV1>(
  input: unknown,
  recordType: Type,
): SemanticRecordOfV1<Type> | null {
  return input === null ? null : requiredRecord(input, recordType);
}

function snapshotQuads(input: unknown, label: string): readonly Quad[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    fail('rfc64-semantic-author-commit-schema', `${label} must be an ordinary array`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== input.length + 1
    || !keys.includes('length')
  ) {
    fail('rfc64-semantic-author-commit-schema', `${label} must be dense and unadorned`);
  }
  return Object.freeze(input.map((quad, index) => {
    const value = snapshotExactRecord(
      quad,
      ['graph', 'object', 'predicate', 'subject'],
      `${label}[${index}]`,
    );
    return Object.freeze({
      graph: requiredString(value.graph, `${label}[${index}].graph`),
      object: requiredString(value.object, `${label}[${index}].object`),
      predicate: requiredString(value.predicate, `${label}[${index}].predicate`),
      subject: requiredString(value.subject, `${label}[${index}].subject`),
    });
  }));
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    fail('rfc64-semantic-author-commit-schema', `${label} must be a non-empty string`);
  }
  return input;
}

function snapshotExactRecord(
  input: unknown,
  expectedKeys: readonly string[],
  label: string,
): Readonly<Record<string, unknown>> {
  if (
    input === null
    || typeof input !== 'object'
    || Object.getPrototypeOf(input) !== Object.prototype
  ) {
    fail('rfc64-semantic-author-commit-schema', `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== expectedKeys.length
    || expectedKeys.some((key) => !keys.includes(key))
  ) {
    fail('rfc64-semantic-author-commit-schema', `${label} has an invalid field set`);
  }
  const result: Record<string, unknown> = {};
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(
        'rfc64-semantic-author-commit-schema',
        `${label} must use enumerable data properties`,
      );
    }
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

function fail(
  code: Rfc64SemanticAuthorCommitErrorCodeV1,
  message: string,
  cause?: unknown,
): never {
  throw new Rfc64SemanticAuthorCommitErrorV1(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}
