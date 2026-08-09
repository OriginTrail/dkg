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
