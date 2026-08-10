import { sparqlInt, sparqlString } from '@origintrail-official/dkg-core';
import type {
  PruneLinkedRecordClosuresInput,
  PruneRankedSubjectsInput,
} from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_PREDICATES,
  BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  boundedInteger,
  boundedString,
} from './primitives.js';
import {
  captureInputRecord,
  captureUniqueIris,
  captureUniqueStrings,
  type StructuredMutationSemantics,
} from './capture-internal.js';

export function capturePruneRankedSubjectsInput(input: unknown): PruneRankedSubjectsInput {
  const value = captureInputRecord(input, 'pruneRankedSubjects');
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

export function pruneRankedSubjectsSemantics(
  input: PruneRankedSubjectsInput,
): StructuredMutationSemantics {
  return { guardedGraphs: [input.graphUri], touchedGraphs: [input.graphUri], mightMutate: true };
}

export function materializePruneRankedSubjectsInput(
  input: PruneRankedSubjectsInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('pruneRankedSubjects', [
    input.graphUri,
    input.subjectPrefix,
    input.eligibilityPredicate,
    input.primaryRankPredicate,
    input.secondaryRankPredicate,
    ...input.eligibleObjects,
  ]);
  return buildUpdate ? buildPruneRankedSubjectsUpdateFromNormalized(input) : undefined;
}

export function capturePruneLinkedRecordClosuresInput(
  input: unknown,
): PruneLinkedRecordClosuresInput {
  const value = captureInputRecord(input, 'pruneLinkedRecordClosures');
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

export function pruneLinkedRecordClosuresSemantics(
  input: PruneLinkedRecordClosuresInput,
): StructuredMutationSemantics {
  return { guardedGraphs: [input.graphUri], touchedGraphs: [input.graphUri], mightMutate: true };
}

export function materializePruneLinkedRecordClosuresInput(
  input: PruneLinkedRecordClosuresInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('pruneLinkedRecordClosures', [
    input.graphUri,
    ...input.matchObjectIris,
    ...input.linkPredicates,
    input.recordParentPredicate,
    input.descendantSeparator,
    ...(input.protectedRecordIri ? [input.protectedRecordIri] : []),
  ]);
  return buildUpdate ? buildPruneLinkedRecordClosuresUpdateFromNormalized(input) : undefined;
}

export function normalizePruneRankedSubjectsInput(
  input: PruneRankedSubjectsInput,
): PruneRankedSubjectsInput {
  const captured = capturePruneRankedSubjectsInput(input);
  materializePruneRankedSubjectsInput(captured, false);
  return captured;
}

export function buildPruneRankedSubjectsUpdate(input: PruneRankedSubjectsInput): string {
  const normalized = normalizePruneRankedSubjectsInput(input);
  return buildPruneRankedSubjectsUpdateFromNormalized(normalized);
}

export function buildPruneRankedSubjectsUpdateFromNormalized(
  input: PruneRankedSubjectsInput,
): string {
  const eligibleObjects = input.eligibleObjects.map(sparqlString).join(' ');
  const eligibilityFilter = `VALUES ?eligibleObject { ${eligibleObjects} }
      FILTER NOT EXISTS {
        ?subject <${input.eligibilityPredicate}> ?ineligibleObject .
        FILTER(?ineligibleObject NOT IN (${input.eligibleObjects.map(sparqlString).join(', ')}))
      }`;
  return assertBoundedStructuredUpdate('pruneRankedSubjects', `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DELETE { GRAPH <${input.graphUri}> { ?subject ?predicate ?object } }
WHERE {
  {
    SELECT ?subject
           (MAX(?primaryRank) AS ?latestPrimaryRank)
           (MAX(?secondaryRank) AS ?latestSecondaryRank)
    WHERE {
      GRAPH <${input.graphUri}> {
        ?subject <${input.eligibilityPredicate}> ?eligibleObject .
        OPTIONAL { ?subject <${input.primaryRankPredicate}> ?primaryRank }
        OPTIONAL { ?subject <${input.secondaryRankPredicate}> ?secondaryRank }
        ${eligibilityFilter}
        FILTER(STRSTARTS(STR(?subject), ${sparqlString(input.subjectPrefix)}))
      }
    }
    # sparql-scan-allow: R3 -- one bounded retention prune; OFFSET <= 100000 and LIMIT <= 10000; never page-walked
    GROUP BY ?subject
    ORDER BY DESC(COALESCE(
      xsd:integer(STR(?latestPrimaryRank)),
      xsd:integer(STR(?latestSecondaryRank)),
      0
    )) DESC(STR(?subject))
    OFFSET ${sparqlInt(input.retainNewest, { min: 0 })}
    LIMIT ${sparqlInt(input.maxDelete, { min: 1 })}
  }
  GRAPH <${input.graphUri}> {
    ?subject <${input.eligibilityPredicate}> ?eligibleObject ; ?predicate ?object .
    ${eligibilityFilter}
    FILTER(STRSTARTS(STR(?subject), ${sparqlString(input.subjectPrefix)}))
  }
}`);
}

export function normalizePruneLinkedRecordClosuresInput(
  input: PruneLinkedRecordClosuresInput,
): PruneLinkedRecordClosuresInput {
  const captured = capturePruneLinkedRecordClosuresInput(input);
  materializePruneLinkedRecordClosuresInput(captured, false);
  return captured;
}

export function buildPruneLinkedRecordClosuresUpdate(input: PruneLinkedRecordClosuresInput): string {
  const normalized = normalizePruneLinkedRecordClosuresInput(input);
  return buildPruneLinkedRecordClosuresUpdateFromNormalized(normalized);
}

export function buildPruneLinkedRecordClosuresUpdateFromNormalized(
  input: PruneLinkedRecordClosuresInput,
): string {
  const matchObjects = input.matchObjectIris.map((root) => `<${root}>`).join(' ');
  const linkPredicates = input.linkPredicates
    .map((predicate) => `<${predicate}>`)
    .join(' ');
  const keepFilter = input.protectedRecordIri
    ? `FILTER(?record != <${input.protectedRecordIri}>)`
    : '';
  return assertBoundedStructuredUpdate('pruneLinkedRecordClosures', `DELETE { GRAPH <${input.graphUri}> { ?subject ?predicate ?object } }
WHERE { GRAPH <${input.graphUri}> {
  VALUES ?matchObject { ${matchObjects} }
  VALUES ?linkPredicate { ${linkPredicates} }
  ?member ?linkPredicate ?matchObject .
  OPTIONAL { ?member <${input.recordParentPredicate}> ?parent }
  BIND(COALESCE(?parent, ?member) AS ?record)
  ${keepFilter}
  ?subject ?predicate ?object .
  FILTER(?subject = ?record || STRSTARTS(STR(?subject), CONCAT(STR(?record), ${sparqlString(input.descendantSeparator)})))
} }`);
}
