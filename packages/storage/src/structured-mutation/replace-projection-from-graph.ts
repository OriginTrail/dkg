import { sparqlString } from '@origintrail-official/dkg-core';
import type { ReplaceProjectionFromGraphInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_PREFIXES,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
} from './primitives.js';
import {
  captureInputRecord,
  captureUniqueIris,
  type StructuredMutationSemantics,
} from './capture-internal.js';

export function captureReplaceProjectionFromGraphInput(
  input: unknown,
): ReplaceProjectionFromGraphInput {
  const value = captureInputRecord(input, 'replaceProjectionFromGraph');
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

export function replaceProjectionFromGraphSemantics(
  input: ReplaceProjectionFromGraphInput,
): StructuredMutationSemantics {
  return {
    guardedGraphs: [input.targetGraphUri, input.stagingGraphUri],
    touchedGraphs: [input.targetGraphUri],
    mightMutate: true,
  };
}

export function materializeReplaceProjectionFromGraphInput(
  input: ReplaceProjectionFromGraphInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('replaceProjectionFromGraph', [
    input.targetGraphUri,
    input.stagingGraphUri,
    input.targetSubject,
    ...input.preservedTargetPredicates,
    ...input.targetSubjectPrefixes,
  ]);
  return buildUpdate ? buildReplaceProjectionFromGraphUpdateFromNormalized(input) : undefined;
}

export function normalizeReplaceProjectionFromGraphInput(
  input: ReplaceProjectionFromGraphInput,
): ReplaceProjectionFromGraphInput {
  const captured = captureReplaceProjectionFromGraphInput(input);
  materializeReplaceProjectionFromGraphInput(captured, false);
  return captured;
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
