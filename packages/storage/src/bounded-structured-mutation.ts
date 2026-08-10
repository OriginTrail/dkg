import type {
  Quad,
  StructuredMutation,
} from './triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_OPERAND_BYTES,
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_PREFIXES,
  BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  BOUNDED_MUTATION_MAX_UPDATE_BYTES,
  absoluteIri,
  assertBoundedStructuredUpdate,
  boundedInteger,
  boundedString,
  normalizeStructuredRdfObject,
} from './structured-mutation/primitives.js';
import {
  buildDeleteSubjectsUpdate,
  normalizeDeleteSubjectsInput,
} from './structured-mutation/delete-subjects.js';
import {
  buildPruneLinkedRecordClosuresUpdate,
  buildPruneRankedSubjectsUpdate,
  normalizePruneLinkedRecordClosuresInput,
  normalizePruneRankedSubjectsInput,
} from './structured-mutation/retention.js';
import {
  buildReplaceSubjectPredicatesUpdate,
  normalizeReplaceSubjectPredicatesInput,
  normalizeReplaceSubjectPredicatesInputForObjectRewrite,
} from './structured-mutation/replace-subject-predicates.js';
import {
  buildReplaceProjectionFromGraphUpdate,
  normalizeReplaceProjectionFromGraphInput,
} from './structured-mutation/replace-projection-from-graph.js';
import {
  buildCopySubjectProjectionUpdate,
  chunkCopySubjectProjectionInput,
  normalizeCopySubjectProjectionInput,
} from './structured-mutation/copy-subject-projection.js';

export {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_OPERAND_BYTES,
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_PREFIXES,
  BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  BOUNDED_MUTATION_MAX_UPDATE_BYTES,
  assertBoundedStructuredUpdate,
  buildCopySubjectProjectionUpdate,
  buildDeleteSubjectsUpdate,
  buildPruneLinkedRecordClosuresUpdate,
  buildPruneRankedSubjectsUpdate,
  buildReplaceProjectionFromGraphUpdate,
  buildReplaceSubjectPredicatesUpdate,
  chunkCopySubjectProjectionInput,
  normalizeCopySubjectProjectionInput,
  normalizeDeleteSubjectsInput,
  normalizePruneLinkedRecordClosuresInput,
  normalizePruneRankedSubjectsInput,
  normalizeReplaceProjectionFromGraphInput,
  normalizeReplaceSubjectPredicatesInput,
  normalizeReplaceSubjectPredicatesInputForObjectRewrite,
};

export interface ReadonlyStructuredMutationQuad {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
}

export type ReadonlyStructuredMutation =
  | Readonly<{
    kind: 'delete-subjects';
    input: Readonly<{ graphUri: string; subjects: readonly string[] }>;
  }>
  | Readonly<{
    kind: 'prune-ranked-subjects';
    input: Readonly<{
      graphUri: string;
      subjectPrefix: string;
      eligibilityPredicate: string;
      eligibleObjects: readonly string[];
      primaryRankPredicate: string;
      secondaryRankPredicate: string;
      retainNewest: number;
      maxDelete: number;
    }>;
  }>
  | Readonly<{
    kind: 'prune-linked-record-closures';
    input: Readonly<{
      graphUri: string;
      matchObjectIris: readonly string[];
      linkPredicates: readonly string[];
      recordParentPredicate: string;
      protectedRecordIri?: string;
      descendantSeparator: string;
    }>;
  }>
  | Readonly<{
    kind: 'replace-subject-predicates';
    input: Readonly<{
      graphUri: string;
      subject: string;
      predicates: readonly string[];
      replacementQuads: readonly ReadonlyStructuredMutationQuad[];
    }>;
  }>
  | Readonly<{
    kind: 'replace-projection-from-graph';
    input: Readonly<{
      targetGraphUri: string;
      stagingGraphUri: string;
      targetSubject: string;
      preservedTargetPredicates: readonly string[];
      targetSubjectPrefixes: readonly string[];
    }>;
  }>
  | Readonly<{
    kind: 'copy-subject-projection';
    input: Readonly<{
      sourceGraphUris: readonly string[];
      targetGraphUri: string;
      roots: readonly string[];
      descendantSuffix: string;
      excludedPredicates: readonly string[];
    }>;
  }>;

export interface StructuredMutationSnapshot {
  readonly mutation: ReadonlyStructuredMutation;
  readonly guardedGraphs: readonly string[];
  readonly effects: StructuredMutationEffects | undefined;
  readonly outcome: 'noop' | 'candidate';
}

const STRUCTURED_MUTATION_SNAPSHOT_BRAND = Symbol('structured-mutation-snapshot');
const STRUCTURED_MUTATION_SNAPSHOTS = new WeakMap<object, StructuredMutationSnapshot>();

/** Capture one immutable, caller-independent structured mutation observation. */
export function captureStructuredMutationSnapshot(
  mutation: StructuredMutation,
): StructuredMutationSnapshot {
  if (typeof mutation === 'object' && mutation !== null) {
    const trusted = STRUCTURED_MUTATION_SNAPSHOTS.get(mutation);
    if (trusted !== undefined) return trusted;
  }
  const descriptor = mutation as unknown as Record<string, unknown>;
  const kind = descriptor?.kind;
  const input = descriptor?.input;
  let captured: ReadonlyStructuredMutation;
  switch (kind) {
    case 'delete-subjects':
      captured = brandMutation(kind, captureDeleteSubjectsInput(input));
      break;
    case 'prune-ranked-subjects':
      captured = brandMutation(kind, capturePruneRankedSubjectsInput(input));
      break;
    case 'prune-linked-record-closures':
      captured = brandMutation(kind, capturePruneLinkedRecordClosuresInput(input));
      break;
    case 'replace-subject-predicates':
      captured = brandMutation(kind, captureReplaceSubjectPredicatesInput(input));
      break;
    case 'replace-projection-from-graph':
      captured = brandMutation(kind, captureReplaceProjectionFromGraphInput(input));
      break;
    case 'copy-subject-projection':
      captured = brandMutation(kind, captureCopySubjectProjectionInput(input));
      break;
    default:
      throw new Error(`Unsupported structured mutation kind ${String(kind)}`);
  }
  const guardedGraphs = Object.freeze([...structuredMutationGuardedGraphs(captured)]);
  const mightMutate = structuredMutationMightMutate(captured);
  const effects = mightMutate
    ? Object.freeze({
        touchedGraphs: Object.freeze([...structuredMutationTouchedGraphs(captured)]),
      })
    : undefined;
  const snapshot: StructuredMutationSnapshot = Object.freeze({
    mutation: captured,
    guardedGraphs,
    effects,
    outcome: mightMutate ? 'candidate' : 'noop',
  });
  STRUCTURED_MUTATION_SNAPSHOTS.set(captured, snapshot);
  return snapshot;
}

/** Storage-internal trust check used by final materialization. */
export function assertTrustedStructuredMutationSnapshot(
  snapshot: StructuredMutationSnapshot,
): void {
  if (typeof snapshot !== 'object'
      || snapshot === null
      || typeof snapshot.mutation !== 'object'
      || snapshot.mutation === null
      || STRUCTURED_MUTATION_SNAPSHOTS.get(snapshot.mutation) !== snapshot) {
    throw new Error('structured mutation snapshot is not trusted');
  }
}

function brandMutation<K extends ReadonlyStructuredMutation['kind']>(
  kind: K,
  input: Extract<ReadonlyStructuredMutation, { kind: K }>['input'],
): Extract<ReadonlyStructuredMutation, { kind: K }> {
  const mutation = { kind, input } as Extract<ReadonlyStructuredMutation, { kind: K }>;
  Object.defineProperty(mutation, STRUCTURED_MUTATION_SNAPSHOT_BRAND, { value: true });
  Object.freeze(mutation);
  return mutation;
}

function captureDeleteSubjectsInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'delete-subjects' }
>['input'] {
  const value = inputRecord(input, 'deleteSubjects');
  const graphUri = absoluteIri(value.graphUri as string, 'deleteSubjects.graphUri');
  const subjects = captureUniqueIris(
    value.subjects,
    'deleteSubjects.subjects',
    BOUNDED_MUTATION_MAX_IRIS,
    true,
  );
  return Object.freeze({ graphUri, subjects });
}

function capturePruneRankedSubjectsInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'prune-ranked-subjects' }
>['input'] {
  const value = inputRecord(input, 'pruneRankedSubjects');
  const graphUri = absoluteIri(value.graphUri as string, 'pruneRankedSubjects.graphUri');
  const subjectPrefix = absoluteIri(
    value.subjectPrefix as string,
    'pruneRankedSubjects.subjectPrefix',
  );
  const eligibilityPredicate = absoluteIri(
    value.eligibilityPredicate as string,
    'pruneRankedSubjects.eligibilityPredicate',
  );
  const eligibleObjects = captureUniqueStrings(
    value.eligibleObjects,
    'pruneRankedSubjects.eligibleObjects',
    16,
  );
  const primaryRankPredicate = absoluteIri(
    value.primaryRankPredicate as string,
    'pruneRankedSubjects.primaryRankPredicate',
  );
  const secondaryRankPredicate = absoluteIri(
    value.secondaryRankPredicate as string,
    'pruneRankedSubjects.secondaryRankPredicate',
  );
  const retainNewest = boundedInteger(
    value.retainNewest as number,
    'pruneRankedSubjects.retainNewest',
    BOUNDED_MUTATION_MAX_IRIS,
  );
  const maxDelete = boundedInteger(
    value.maxDelete as number,
    'pruneRankedSubjects.maxDelete',
    BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  );
  if (maxDelete === 0) throw new Error('pruneRankedSubjects.maxDelete must be positive');
  return Object.freeze({
    graphUri,
    subjectPrefix,
    eligibilityPredicate,
    eligibleObjects,
    primaryRankPredicate,
    secondaryRankPredicate,
    retainNewest,
    maxDelete,
  });
}

function capturePruneLinkedRecordClosuresInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'prune-linked-record-closures' }
>['input'] {
  const value = inputRecord(input, 'pruneLinkedRecordClosures');
  const graphUri = absoluteIri(value.graphUri as string, 'pruneLinkedRecordClosures.graphUri');
  const matchObjectIris = captureUniqueIris(
    value.matchObjectIris,
    'pruneLinkedRecordClosures.matchObjectIris',
    BOUNDED_MUTATION_MAX_IRIS,
    false,
  );
  const linkPredicates = captureUniqueIris(
    value.linkPredicates,
    'pruneLinkedRecordClosures.linkPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    false,
  );
  const recordParentPredicate = absoluteIri(
    value.recordParentPredicate as string,
    'pruneLinkedRecordClosures.recordParentPredicate',
  );
  const rawProtectedRecordIri = value.protectedRecordIri;
  const protectedRecordIri = rawProtectedRecordIri === undefined
    ? undefined
    : absoluteIri(
        rawProtectedRecordIri as string,
        'pruneLinkedRecordClosures.protectedRecordIri',
      );
  const descendantSeparator = boundedString(
    value.descendantSeparator as string,
    'pruneLinkedRecordClosures.descendantSeparator',
    64,
  );
  return Object.freeze({
    graphUri,
    matchObjectIris,
    linkPredicates,
    recordParentPredicate,
    protectedRecordIri,
    descendantSeparator,
  });
}

function captureReplaceSubjectPredicatesInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'replace-subject-predicates' }
>['input'] {
  const value = inputRecord(input, 'replaceSubjectPredicates');
  const graphUri = absoluteIri(value.graphUri as string, 'replaceSubjectPredicates.graphUri');
  const subject = absoluteIri(value.subject as string, 'replaceSubjectPredicates.subject');
  const predicates = captureUniqueIris(
    value.predicates,
    'replaceSubjectPredicates.predicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    false,
  );
  const allowedPredicates = new Set(predicates);
  const replacementQuads = captureArray(
    value.replacementQuads,
    'replaceSubjectPredicates.replacementQuads',
    0,
    BOUNDED_MUTATION_MAX_IRIS,
    (candidate, index) => {
      const quad = inputRecord(candidate, `replaceSubjectPredicates.replacementQuads[${index}]`);
      const quadSubject = quad.subject;
      const quadPredicate = quad.predicate;
      const quadObject = quad.object;
      const quadGraph = quad.graph;
      if (quadGraph !== graphUri || quadSubject !== subject) {
        throw new Error(
          `replaceSubjectPredicates quad ${index} must target subject ${subject} in graph ${graphUri}`,
        );
      }
      const predicate = absoluteIri(
        quadPredicate as string,
        `replaceSubjectPredicates.replacementQuads[${index}].predicate`,
      );
      if (!allowedPredicates.has(predicate)) {
        throw new Error(
          `replaceSubjectPredicates quad ${index} targets undeclared predicate ${predicate}`,
        );
      }
      const object = normalizeStructuredRdfObject(
        quadObject as string,
        `replaceSubjectPredicates.replacementQuads[${index}].object`,
      );
      return Object.freeze({ subject, predicate, object, graph: graphUri });
    },
  );
  return Object.freeze({ graphUri, subject, predicates, replacementQuads });
}

function captureReplaceProjectionFromGraphInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'replace-projection-from-graph' }
>['input'] {
  const value = inputRecord(input, 'replaceProjectionFromGraph');
  const targetGraphUri = absoluteIri(
    value.targetGraphUri as string,
    'replaceProjectionFromGraph.targetGraphUri',
  );
  const stagingGraphUri = absoluteIri(
    value.stagingGraphUri as string,
    'replaceProjectionFromGraph.stagingGraphUri',
  );
  if (targetGraphUri === stagingGraphUri) {
    throw new Error('replaceProjectionFromGraph requires distinct target and staging graphs');
  }
  const targetSubject = absoluteIri(
    value.targetSubject as string,
    'replaceProjectionFromGraph.targetSubject',
  );
  const preservedTargetPredicates = captureUniqueIris(
    value.preservedTargetPredicates,
    'replaceProjectionFromGraph.preservedTargetPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    true,
  );
  const targetSubjectPrefixes = captureUniqueIris(
    value.targetSubjectPrefixes,
    'replaceProjectionFromGraph.targetSubjectPrefixes',
    BOUNDED_MUTATION_MAX_PREFIXES,
    true,
  );
  return Object.freeze({
    targetGraphUri,
    stagingGraphUri,
    targetSubject,
    preservedTargetPredicates,
    targetSubjectPrefixes,
  });
}

function captureCopySubjectProjectionInput(input: unknown): Extract<
  ReadonlyStructuredMutation,
  { kind: 'copy-subject-projection' }
>['input'] {
  const value = inputRecord(input, 'copySubjectProjection');
  const sourceGraphUris = captureUniqueIris(
    value.sourceGraphUris,
    'copySubjectProjection.sourceGraphUris',
    BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
    false,
  );
  const targetGraphUri = absoluteIri(
    value.targetGraphUri as string,
    'copySubjectProjection.targetGraphUri',
  );
  if (sourceGraphUris.includes(targetGraphUri)) {
    throw new Error('copySubjectProjection target graph must not be a source graph');
  }
  const roots = captureUniqueIris(
    value.roots,
    'copySubjectProjection.roots',
    BOUNDED_MUTATION_MAX_IRIS,
    false,
  );
  const descendantSuffix = boundedString(
    value.descendantSuffix as string,
    'copySubjectProjection.descendantSuffix',
    256,
  );
  if (!descendantSuffix.startsWith('/')) {
    throw new Error('copySubjectProjection.descendantSuffix must start with /');
  }
  const excludedPredicates = captureUniqueIris(
    value.excludedPredicates,
    'copySubjectProjection.excludedPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    true,
  );
  return Object.freeze({
    sourceGraphUris,
    targetGraphUri,
    roots,
    descendantSuffix,
    excludedPredicates,
  });
}

function inputRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function captureUniqueIris(
  value: unknown,
  label: string,
  max: number,
  allowEmpty: boolean,
): readonly string[] {
  const seen = new Set<string>();
  return captureArray(value, label, allowEmpty ? 0 : 1, max, (candidate, index) => {
    const iri = absoluteIri(candidate as string, `${label}[${index}]`);
    if (seen.has(iri)) throw new Error(`${label} contains duplicate IRI ${iri}`);
    seen.add(iri);
    return iri;
  });
}

function captureUniqueStrings(
  value: unknown,
  label: string,
  max: number,
): readonly string[] {
  const seen = new Set<string>();
  return captureArray(value, label, 1, max, (candidate, index) => {
    const captured = boundedString(candidate as string, `${label}[${index}]`);
    if (seen.has(captured)) throw new Error(`${label} contains duplicate value ${captured}`);
    seen.add(captured);
    return captured;
  });
}

function captureArray<T>(
  value: unknown,
  label: string,
  min: number,
  max: number,
  capture: (candidate: unknown, index: number) => T,
): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const length = value.length;
  if (length < min || length > max) {
    throw new Error(`${label} must contain ${min}..${max} values`);
  }
  const result = new Array<T>(length);
  for (let index = 0; index < length; index += 1) {
    if (!(index in value)) throw new Error(`${label} must be a dense array`);
    result[index] = capture(value[index], index);
  }
  return Object.freeze(result);
}

function unsupportedMutation(mutation: never): never {
  throw new Error(
    `Unsupported structured mutation kind ${String((mutation as { kind?: unknown })?.kind)}`,
  );
}

export function normalizeStructuredMutation(mutation: StructuredMutation): StructuredMutation {
  switch (mutation.kind) {
    case 'delete-subjects':
      return { kind: mutation.kind, input: normalizeDeleteSubjectsInput(mutation.input) };
    case 'prune-ranked-subjects':
      return { kind: mutation.kind, input: normalizePruneRankedSubjectsInput(mutation.input) };
    case 'prune-linked-record-closures':
      return { kind: mutation.kind, input: normalizePruneLinkedRecordClosuresInput(mutation.input) };
    case 'replace-subject-predicates':
      return { kind: mutation.kind, input: normalizeReplaceSubjectPredicatesInput(mutation.input) };
    case 'replace-projection-from-graph':
      return { kind: mutation.kind, input: normalizeReplaceProjectionFromGraphInput(mutation.input) };
    case 'copy-subject-projection':
      return { kind: mutation.kind, input: normalizeCopySubjectProjectionInput(mutation.input) };
    default:
      return unsupportedMutation(mutation);
  }
}

/** Rewrite quad payloads, then reapply the canonical bounded mutation validation. */
export async function rewriteStructuredMutationQuads(
  mutation: StructuredMutation,
  rewriteQuad: (quad: Quad) => Quad | Promise<Quad>,
): Promise<StructuredMutation> {
  switch (mutation.kind) {
    case 'replace-subject-predicates': {
      const scoped = normalizeReplaceSubjectPredicatesInputForObjectRewrite(mutation.input);
      const replacementQuads = await Promise.all(scoped.replacementQuads.map(rewriteQuad));
      return normalizeStructuredMutation({
        kind: mutation.kind,
        input: { ...scoped, replacementQuads },
      });
    }
    case 'delete-subjects':
    case 'prune-ranked-subjects':
    case 'prune-linked-record-closures':
    case 'replace-projection-from-graph':
    case 'copy-subject-projection':
      return normalizeStructuredMutation(mutation);
    default:
      return unsupportedMutation(mutation);
  }
}

export function buildStructuredMutationUpdate(mutation: StructuredMutation): string | undefined {
  switch (mutation.kind) {
    case 'delete-subjects': return buildDeleteSubjectsUpdate(mutation.input);
    case 'prune-ranked-subjects': return buildPruneRankedSubjectsUpdate(mutation.input);
    case 'prune-linked-record-closures': return buildPruneLinkedRecordClosuresUpdate(mutation.input);
    case 'replace-subject-predicates': return buildReplaceSubjectPredicatesUpdate(mutation.input);
    case 'replace-projection-from-graph': return buildReplaceProjectionFromGraphUpdate(mutation.input);
    case 'copy-subject-projection': return buildCopySubjectProjectionUpdate(mutation.input);
    default: return unsupportedMutation(mutation);
  }
}

export function structuredMutationGuardedGraphs(mutation: StructuredMutation): readonly string[] {
  switch (mutation.kind) {
    case 'replace-projection-from-graph':
      return [mutation.input.targetGraphUri, mutation.input.stagingGraphUri];
    case 'copy-subject-projection':
      return [...mutation.input.sourceGraphUris, mutation.input.targetGraphUri];
    default:
      return [mutation.input.graphUri];
  }
}

export function structuredMutationTouchedGraphs(mutation: StructuredMutation): readonly string[] {
  switch (mutation.kind) {
    case 'replace-projection-from-graph': return [mutation.input.targetGraphUri];
    case 'copy-subject-projection': return [mutation.input.targetGraphUri];
    default: return [mutation.input.graphUri];
  }
}

export function structuredMutationMightMutate(mutation: StructuredMutation): boolean {
  return mutation.kind !== 'delete-subjects' || mutation.input.subjects.length > 0;
}

/** Immutable graph-scoped effects captured before a structured mutation is dispatched. */
export interface StructuredMutationEffects {
  readonly touchedGraphs: readonly string[];
}

/** Capture canonical effects without executing or probing a store capability. */
export function captureStructuredMutationEffects(
  mutation: StructuredMutation,
): StructuredMutationEffects | undefined {
  if (!structuredMutationMightMutate(mutation)) return undefined;
  const touchedGraphs = Object.freeze([...structuredMutationTouchedGraphs(mutation)]);
  return Object.freeze({ touchedGraphs });
}
