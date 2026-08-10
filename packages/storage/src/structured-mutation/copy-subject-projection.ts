import { sparqlString } from '@origintrail-official/dkg-core';
import type { CopySubjectProjectionInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  BoundedMutationBudgetError,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  boundedString,
} from './primitives.js';
import {
  captureInputRecord,
  captureUniqueIris,
  type StructuredMutationSemantics,
} from './capture-internal.js';

export function captureCopySubjectProjectionInput(input: unknown): CopySubjectProjectionInput {
  const value = captureInputRecord(input, 'copySubjectProjection');
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

export function copySubjectProjectionSemantics(
  input: CopySubjectProjectionInput,
): StructuredMutationSemantics {
  return {
    guardedGraphs: [...input.sourceGraphUris, input.targetGraphUri],
    touchedGraphs: [input.targetGraphUri],
    mightMutate: true,
  };
}

export function materializeCopySubjectProjectionInput(
  input: CopySubjectProjectionInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('copySubjectProjection', [
    ...input.sourceGraphUris,
    input.targetGraphUri,
    ...input.roots,
    input.descendantSuffix,
    ...input.excludedPredicates,
  ]);
  return buildUpdate ? buildCopySubjectProjectionUpdateFromNormalized(input) : undefined;
}

export function normalizeCopySubjectProjectionInput(
  input: CopySubjectProjectionInput,
): CopySubjectProjectionInput {
  const captured = captureCopySubjectProjectionInput(input);
  materializeCopySubjectProjectionInput(captured, false);
  return captured;
}

export function buildCopySubjectProjectionUpdate(input: CopySubjectProjectionInput): string {
  const normalized = normalizeCopySubjectProjectionInput(input);
  return buildCopySubjectProjectionUpdateFromNormalized(normalized);
}

export function buildCopySubjectProjectionUpdateFromNormalized(
  input: CopySubjectProjectionInput,
): string {
  const sources = input.sourceGraphUris.map((graph) => `<${graph}>`).join(' ');
  const roots = input.roots.map((root) => `<${root}>`).join(' ');
  const excluded = input.excludedPredicates.length > 0
    ? `FILTER(?predicate NOT IN (${input.excludedPredicates.map((iri) => `<${iri}>`).join(', ')}))`
    : '';
  return assertBoundedStructuredUpdate('copySubjectProjection', `INSERT { GRAPH <${input.targetGraphUri}> { ?subject ?predicate ?object } }
WHERE {
  VALUES ?sourceGraph { ${sources} }
  VALUES ?root { ${roots} }
  # sparql-scan-allow: R2 -- ?sourceGraph is VALUES-bound to at most 8 validated exact graph IRIs
  GRAPH ?sourceGraph { ?subject ?predicate ?object }
  FILTER(?subject = ?root || STRSTARTS(STR(?subject), CONCAT(STR(?root), ${sparqlString(input.descendantSuffix)})))
  ${excluded}
}`);
}

/** Split a subject-projection copy into the largest ordered bounded root batches. */
export function chunkCopySubjectProjectionInput(
  input: CopySubjectProjectionInput,
): CopySubjectProjectionInput[] {
  const roots = captureUniqueIris(
    input.roots,
    'copySubjectProjection.roots',
    BOUNDED_MUTATION_MAX_IRIS,
    false,
  );
  const normalized = normalizeCopySubjectProjectionInput({ ...input, roots: [roots[0]] });
  const chunks: CopySubjectProjectionInput[] = [];

  for (let start = 0; start < roots.length;) {
    let low = start + 1;
    let high = roots.length;
    let accepted: CopySubjectProjectionInput | undefined;

    while (low <= high) {
      const end = low + Math.floor((high - low) / 2);
      const candidate = { ...normalized, roots: roots.slice(start, end) };
      try {
        buildCopySubjectProjectionUpdate(candidate);
        accepted = candidate;
        low = end + 1;
      } catch (error) {
        if (!(error instanceof BoundedMutationBudgetError)) throw error;
        high = end - 1;
      }
    }

    if (!accepted) {
      buildCopySubjectProjectionUpdate({ ...normalized, roots: [roots[start]] });
      throw new Error('copySubjectProjection root cannot fit the bounded mutation budget');
    }
    chunks.push(accepted);
    start += accepted.roots.length;
  }
  return chunks;
}
