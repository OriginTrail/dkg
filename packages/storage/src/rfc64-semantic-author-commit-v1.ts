import {
  MemoryLayer,
  RFC64_SEMANTIC_PREDICATES_V1,
  assertCanonicalDeterministicUalV1,
  buildCatalogAssertionScopeV1,
  contextGraphLayerUri,
  decodeCanonicalGraphScopedAuthorSealRenderedRowsV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  parseContextGraphAssertionUri,
  projectRfc64SemanticRecordStoreRowsV1,
  renderRfc64SemanticStoreRowV1,
  snapshotRfc64SemanticRecordV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
  type Rfc64SemanticRecordTypeV1,
  type Rfc64SemanticRecordV1,
} from '@origintrail-official/dkg-core';
import { snapshotExactDataRecord } from '@origintrail-official/dkg-core/strict-data-boundary';

import {
  type Quad,
} from './triple-store.js';
import {
  normalizeRfc64AuthorCommitCasV1,
  type Rfc64AuthorCommitCasSemanticInputV1,
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
): Rfc64AuthorCommitCasSemanticInputV1 {
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

  const sharedProjectionGraph = requiredString(
    candidate.sharedProjectionGraph,
    'sharedProjectionGraph',
  );
  const sharedProjectionQuads = snapshotQuads(
    candidate.sharedProjectionQuads,
    'sharedProjectionQuads',
  );
  const authorSealGraph = requiredString(candidate.authorSealGraph, 'authorSealGraph');
  const authorSealSubject = requiredString(candidate.authorSealSubject, 'authorSealSubject');
  const authorSealQuads = snapshotQuads(candidate.authorSealQuads, 'authorSealQuads');
  assertPayloadTargets(
    nextCurrentHead,
    sharedProjectionGraph,
    sharedProjectionQuads,
    authorSealGraph,
    authorSealSubject,
    authorSealQuads,
  );

  const compiled = Object.freeze({
    sharedProjectionGraph,
    sharedProjectionQuads,
    authorSealGraph,
    authorSealSubject,
    authorSealQuads,
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

function assertPayloadTargets(
  nextCurrentHead: CurrentHeadRecordV1,
  sharedProjectionGraph: string,
  sharedProjectionQuads: readonly Quad[],
  authorSealGraph: string,
  authorSealSubject: string,
  authorSealQuads: readonly Quad[],
): void {
  const scope = nextCurrentHead.value;
  const parsedCoordinate = parseContextGraphAssertionUri(authorSealSubject);
  const expectedScope = buildCatalogAssertionScopeV1({
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
  });
  if (
    !parsedCoordinate
    || parsedCoordinate.scope !== expectedScope
    || parsedCoordinate.agentAddress.toLowerCase() !== scope.authorAddress
  ) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'author seal does not belong to the semantic commit author lane',
    );
  }
  const coordinate = Object.freeze({
    contextGraphId: scope.contextGraphId,
    subGraphName: scope.subGraphName,
    authorAddress: scope.authorAddress,
    assertionCoordinate: parsedCoordinate.name,
  }) as CanonicalGraphScopedAuthorSealCoordinateV1;
  let placement;
  try {
    placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(coordinate);
  } catch (cause) {
    fail(
      'rfc64-semantic-author-commit-schema',
      'author seal coordinate is not canonical',
      cause,
    );
  }
  if (authorSealGraph !== placement.metaGraph || authorSealSubject !== placement.subject) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'author seal graph and subject must use the canonical lane placement',
    );
  }
  let payload;
  try {
    payload = decodeCanonicalGraphScopedAuthorSealRenderedRowsV1(
      authorSealQuads,
      coordinate,
    ).payload;
  } catch (cause) {
    fail(
      'rfc64-semantic-author-commit-schema',
      'author seal quads are not one canonical graph-scoped seal',
      cause,
    );
  }
  let ual;
  try {
    ual = assertCanonicalDeterministicUalV1(payload.kaUal);
  } catch (cause) {
    fail(
      'rfc64-semantic-author-commit-schema',
      'author seal has no canonical KA identity',
      cause,
    );
  }
  if (ual.chainId !== scope.networkId || ual.agentAddress !== scope.authorAddress) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'sealed KA identity does not belong to the semantic commit network and author',
    );
  }
  const expectedProjectionGraph = contextGraphLayerUri(
    scope.contextGraphId,
    MemoryLayer.SharedWorkingMemory,
    scope.authorAddress,
    ual.kaNumber,
    scope.subGraphName ?? undefined,
  );
  if (sharedProjectionGraph !== expectedProjectionGraph) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'shared projection graph does not belong to the sealed KA author lane',
    );
  }
  if (sharedProjectionQuads.some(({ graph }) => graph !== expectedProjectionGraph)) {
    fail(
      'rfc64-semantic-author-commit-scope',
      'shared projection quads target a graph outside the sealed KA author lane',
    );
  }
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
  const expectedQuads = expected === null
    ? null
    : Object.freeze(projectRfc64SemanticRecordStoreRowsV1(expected)
      .map(renderRfc64SemanticStoreRowV1));
  const quads = Object.freeze(nextRows.map(renderRfc64SemanticStoreRowV1));
  return Object.freeze({
    graphUri: firstNextRow.graphIri,
    subject: firstNextRow.subjectIri,
    predicate: guardPredicate,
    expectedObject,
    expectedQuads,
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
  let record: Rfc64SemanticRecordV1;
  try {
    record = snapshotRfc64SemanticRecordV1(input);
  } catch (cause) {
    fail(
      'rfc64-semantic-author-commit-schema',
      `semantic author commit contains an invalid ${recordType}`,
      cause,
    );
  }
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
  const result: Quad[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(
        'rfc64-semantic-author-commit-schema',
        `${label} must use enumerable data properties`,
      );
    }
    const value = snapshotExactRecord(
      descriptor.value,
      ['graph', 'object', 'predicate', 'subject'],
      `${label}[${index}]`,
    );
    result.push(Object.freeze({
      graph: requiredString(value.graph, `${label}[${index}].graph`),
      object: requiredString(value.object, `${label}[${index}].object`),
      predicate: requiredString(value.predicate, `${label}[${index}].predicate`),
      subject: requiredString(value.subject, `${label}[${index}].subject`),
    }));
  }
  return Object.freeze(result);
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
  try {
    return snapshotExactDataRecord(input, expectedKeys, label);
  } catch (cause) {
    fail('rfc64-semantic-author-commit-schema', `${label} has an invalid field set`, cause);
  }
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
