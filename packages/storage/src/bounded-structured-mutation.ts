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
  assertBoundedStructuredUpdate,
} from './structured-mutation/primitives.js';
import {
  buildDeleteSubjectsUpdate,
  captureDeleteSubjectsInput,
  deleteSubjectsSemantics,
  normalizeDeleteSubjectsInput,
} from './structured-mutation/delete-subjects.js';
import {
  buildPruneLinkedRecordClosuresUpdate,
  buildPruneRankedSubjectsUpdate,
  capturePruneLinkedRecordClosuresInput,
  capturePruneRankedSubjectsInput,
  normalizePruneLinkedRecordClosuresInput,
  normalizePruneRankedSubjectsInput,
  pruneLinkedRecordClosuresSemantics,
  pruneRankedSubjectsSemantics,
} from './structured-mutation/retention.js';
import {
  buildReplaceSubjectPredicatesUpdate,
  captureReplaceSubjectPredicatesInput,
  normalizeReplaceSubjectPredicatesInput,
  normalizeReplaceSubjectPredicatesInputForObjectRewrite,
  replaceSubjectPredicatesSemantics,
} from './structured-mutation/replace-subject-predicates.js';
import {
  buildReplaceProjectionFromGraphUpdate,
  captureReplaceProjectionFromGraphInput,
  normalizeReplaceProjectionFromGraphInput,
  replaceProjectionFromGraphSemantics,
} from './structured-mutation/replace-projection-from-graph.js';
import {
  buildCopySubjectProjectionUpdate,
  captureCopySubjectProjectionInput,
  chunkCopySubjectProjectionInput,
  copySubjectProjectionSemantics,
  normalizeCopySubjectProjectionInput,
} from './structured-mutation/copy-subject-projection.js';
import type { StructuredMutationSemantics } from './structured-mutation/capture-internal.js';

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

interface StructuredMutationSnapshotBase {
  readonly mutation: ReadonlyStructuredMutation;
  readonly guardedGraphs: readonly string[];
}

export type StructuredMutationSnapshot =
  | Readonly<StructuredMutationSnapshotBase & {
    outcome: 'noop';
    effects: undefined;
  }>
  | Readonly<StructuredMutationSnapshotBase & {
    outcome: 'candidate';
    effects: StructuredMutationEffects;
  }>;

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
  let semantics: StructuredMutationSemantics;
  switch (kind) {
    case 'delete-subjects': {
      const capturedInput = captureDeleteSubjectsInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = deleteSubjectsSemantics(capturedInput);
      break;
    }
    case 'prune-ranked-subjects': {
      const capturedInput = capturePruneRankedSubjectsInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = pruneRankedSubjectsSemantics(capturedInput);
      break;
    }
    case 'prune-linked-record-closures': {
      const capturedInput = capturePruneLinkedRecordClosuresInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = pruneLinkedRecordClosuresSemantics(capturedInput);
      break;
    }
    case 'replace-subject-predicates': {
      const capturedInput = captureReplaceSubjectPredicatesInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = replaceSubjectPredicatesSemantics(capturedInput);
      break;
    }
    case 'replace-projection-from-graph': {
      const capturedInput = captureReplaceProjectionFromGraphInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = replaceProjectionFromGraphSemantics(capturedInput);
      break;
    }
    case 'copy-subject-projection': {
      const capturedInput = captureCopySubjectProjectionInput(input);
      captured = brandMutation(kind, capturedInput);
      semantics = copySubjectProjectionSemantics(capturedInput);
      break;
    }
    default:
      throw new Error(`Unsupported structured mutation kind ${String(kind)}`);
  }
  const guardedGraphs = Object.freeze([...semantics.guardedGraphs]);
  const snapshot: StructuredMutationSnapshot = semantics.mightMutate
    ? Object.freeze({
      mutation: captured,
      guardedGraphs,
      outcome: 'candidate' as const,
      effects: Object.freeze({
        touchedGraphs: Object.freeze([...semantics.touchedGraphs]),
      }),
    })
    : Object.freeze({
      mutation: captured,
      guardedGraphs,
      outcome: 'noop' as const,
      effects: undefined,
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
  return structuredMutationSemantics(mutation).guardedGraphs;
}

export function structuredMutationTouchedGraphs(mutation: StructuredMutation): readonly string[] {
  return structuredMutationSemantics(mutation).touchedGraphs;
}

export function structuredMutationMightMutate(mutation: StructuredMutation): boolean {
  return structuredMutationSemantics(mutation).mightMutate;
}

function structuredMutationSemantics(
  mutation: StructuredMutation,
): StructuredMutationSemantics {
  switch (mutation.kind) {
    case 'delete-subjects': return deleteSubjectsSemantics(mutation.input);
    case 'prune-ranked-subjects': return pruneRankedSubjectsSemantics(mutation.input);
    case 'prune-linked-record-closures': return pruneLinkedRecordClosuresSemantics(mutation.input);
    case 'replace-subject-predicates': return replaceSubjectPredicatesSemantics(mutation.input);
    case 'replace-projection-from-graph': return replaceProjectionFromGraphSemantics(mutation.input);
    case 'copy-subject-projection': return copySubjectProjectionSemantics(mutation.input);
    default: return unsupportedMutation(mutation);
  }
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
