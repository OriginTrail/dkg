import { sparqlString } from '@origintrail-official/dkg-core';
import type { ReplaceProjectionFromGraphInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_PREFIXES,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  uniqueIris,
} from './primitives.js';

export function normalizeReplaceProjectionFromGraphInput(
  input: ReplaceProjectionFromGraphInput,
): ReplaceProjectionFromGraphInput {
  const targetGraphUri = absoluteIri(
    input.targetGraphUri,
    'replaceProjectionFromGraph.targetGraphUri',
  );
  const stagingGraphUri = absoluteIri(
    input.stagingGraphUri,
    'replaceProjectionFromGraph.stagingGraphUri',
  );
  if (targetGraphUri === stagingGraphUri) {
    throw new Error('replaceProjectionFromGraph requires distinct target and staging graphs');
  }
  const targetSubject = absoluteIri(
    input.targetSubject,
    'replaceProjectionFromGraph.targetSubject',
  );
  const preservedTargetPredicates = uniqueIris(
    input.preservedTargetPredicates,
    'replaceProjectionFromGraph.preservedTargetPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    true,
  );
  const targetSubjectPrefixes = uniqueIris(
    input.targetSubjectPrefixes,
    'replaceProjectionFromGraph.targetSubjectPrefixes',
    BOUNDED_MUTATION_MAX_PREFIXES,
    true,
  );
  assertOperandBudget('replaceProjectionFromGraph', [
    targetGraphUri,
    stagingGraphUri,
    targetSubject,
    ...preservedTargetPredicates,
    ...targetSubjectPrefixes,
  ]);
  return {
    targetGraphUri,
    stagingGraphUri,
    targetSubject,
    preservedTargetPredicates,
    targetSubjectPrefixes,
  };
}

export function buildReplaceProjectionFromGraphUpdate(
  input: ReplaceProjectionFromGraphInput,
): string {
  const normalized = normalizeReplaceProjectionFromGraphInput(input);
  const preserved = normalized.preservedTargetPredicates.length > 0
    ? ` && ?stalePredicate NOT IN (${normalized.preservedTargetPredicates.map((iri) => `<${iri}>`).join(', ')})`
    : '';
  const prefixes = normalized.targetSubjectPrefixes
    .map((prefix) => `STRSTARTS(STR(?staleSubject), ${sparqlString(prefix)})`);
  const staleScopes = [
    `(?staleSubject = <${normalized.targetSubject}>${preserved})`,
    ...prefixes,
  ].join(' || ');
  const freshScopes = [
    `?freshSubject = <${normalized.targetSubject}>`,
    ...normalized.targetSubjectPrefixes.map(
      (prefix) => `STRSTARTS(STR(?freshSubject), ${sparqlString(prefix)})`,
    ),
  ].join(' || ');
  return assertBoundedStructuredUpdate('replaceProjectionFromGraph', `DELETE {
  GRAPH <${normalized.targetGraphUri}> { ?staleSubject ?stalePredicate ?staleObject }
}
INSERT {
  GRAPH <${normalized.targetGraphUri}> { ?freshSubject ?freshPredicate ?freshObject }
}
WHERE {
  {
    GRAPH <${normalized.targetGraphUri}> {
      ?staleSubject ?stalePredicate ?staleObject .
      FILTER(${staleScopes})
    }
  }
  UNION
  {
    GRAPH <${normalized.stagingGraphUri}> {
      ?freshSubject ?freshPredicate ?freshObject .
      FILTER(${freshScopes})
    }
  }
}`);
}
