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
  return buildReplaceProjectionFromGraphUpdateFromNormalized(normalized);
}

export function buildReplaceProjectionFromGraphUpdateFromNormalized(
  input: ReplaceProjectionFromGraphInput,
): string {
  const preserved = input.preservedTargetPredicates.length > 0
    ? ` && ?stalePredicate NOT IN (${input.preservedTargetPredicates.map((iri) => `<${iri}>`).join(', ')})`
    : '';
  const prefixes = input.targetSubjectPrefixes
    .map((prefix) => `STRSTARTS(STR(?staleSubject), ${sparqlString(prefix)})`);
  const staleScopes = [
    `(?staleSubject = <${input.targetSubject}>${preserved})`,
    ...prefixes,
  ].join(' || ');
  const freshScopes = [
    `?freshSubject = <${input.targetSubject}>`,
    ...input.targetSubjectPrefixes.map(
      (prefix) => `STRSTARTS(STR(?freshSubject), ${sparqlString(prefix)})`,
    ),
  ].join(' || ');
  return assertBoundedStructuredUpdate('replaceProjectionFromGraph', `DELETE {
  GRAPH <${input.targetGraphUri}> { ?staleSubject ?stalePredicate ?staleObject }
}
INSERT {
  GRAPH <${input.targetGraphUri}> { ?freshSubject ?freshPredicate ?freshObject }
}
WHERE {
  {
    GRAPH <${input.targetGraphUri}> {
      ?staleSubject ?stalePredicate ?staleObject .
      FILTER(${staleScopes})
    }
  }
  UNION
  {
    GRAPH <${input.stagingGraphUri}> {
      ?freshSubject ?freshPredicate ?freshObject .
      FILTER(${freshScopes})
    }
  }
}`);
}
