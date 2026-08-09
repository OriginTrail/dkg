import { sparqlString } from '@origintrail-official/dkg-core';
import type { CopySubjectProjectionInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  BoundedMutationBudgetError,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  boundedString,
  uniqueIris,
} from './primitives.js';

export function normalizeCopySubjectProjectionInput(
  input: CopySubjectProjectionInput,
): CopySubjectProjectionInput {
  const sourceGraphUris = uniqueIris(
    input.sourceGraphUris,
    'copySubjectProjection.sourceGraphUris',
    BOUNDED_MUTATION_MAX_SOURCE_GRAPHS,
  );
  const targetGraphUri = absoluteIri(input.targetGraphUri, 'copySubjectProjection.targetGraphUri');
  if (sourceGraphUris.includes(targetGraphUri)) {
    throw new Error('copySubjectProjection target graph must not be a source graph');
  }
  const roots = uniqueIris(input.roots, 'copySubjectProjection.roots');
  const descendantSuffix = boundedString(
    input.descendantSuffix,
    'copySubjectProjection.descendantSuffix',
    256,
  );
  if (!descendantSuffix.startsWith('/')) {
    throw new Error('copySubjectProjection.descendantSuffix must start with /');
  }
  const excludedPredicates = uniqueIris(
    input.excludedPredicates,
    'copySubjectProjection.excludedPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    true,
  );
  assertOperandBudget('copySubjectProjection', [
    ...sourceGraphUris,
    targetGraphUri,
    ...roots,
    descendantSuffix,
    ...excludedPredicates,
  ]);
  return {
    sourceGraphUris,
    targetGraphUri,
    roots,
    descendantSuffix,
    excludedPredicates,
  };
}

export function buildCopySubjectProjectionUpdate(input: CopySubjectProjectionInput): string {
  const normalized = normalizeCopySubjectProjectionInput(input);
  const sources = normalized.sourceGraphUris.map((graph) => `<${graph}>`).join(' ');
  const roots = normalized.roots.map((root) => `<${root}>`).join(' ');
  const excluded = normalized.excludedPredicates.length > 0
    ? `FILTER(?predicate NOT IN (${normalized.excludedPredicates.map((iri) => `<${iri}>`).join(', ')}))`
    : '';
  return assertBoundedStructuredUpdate('copySubjectProjection', `INSERT { GRAPH <${normalized.targetGraphUri}> { ?subject ?predicate ?object } }
WHERE {
  VALUES ?sourceGraph { ${sources} }
  VALUES ?root { ${roots} }
  # sparql-scan-allow: R2 -- ?sourceGraph is VALUES-bound to at most 8 validated exact graph IRIs
  GRAPH ?sourceGraph { ?subject ?predicate ?object }
  FILTER(?subject = ?root || STRSTARTS(STR(?subject), CONCAT(STR(?root), ${sparqlString(normalized.descendantSuffix)})))
  ${excluded}
}`);
}

/** Split a subject-projection copy into the largest ordered bounded root batches. */
export function chunkCopySubjectProjectionInput(
  input: CopySubjectProjectionInput,
): CopySubjectProjectionInput[] {
  const roots = uniqueIris(input.roots, 'copySubjectProjection.roots');
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
