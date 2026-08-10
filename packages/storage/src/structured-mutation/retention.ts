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
  boundedUniqueStrings,
  uniqueIris,
} from './primitives.js';

export function normalizePruneRankedSubjectsInput(
  input: PruneRankedSubjectsInput,
): PruneRankedSubjectsInput {
  const graphUri = absoluteIri(input.graphUri, 'pruneRankedSubjects.graphUri');
  const subjectPrefix = absoluteIri(input.subjectPrefix, 'pruneRankedSubjects.subjectPrefix');
  const eligibilityPredicate = absoluteIri(
    input.eligibilityPredicate,
    'pruneRankedSubjects.eligibilityPredicate',
  );
  const primaryRankPredicate = absoluteIri(
    input.primaryRankPredicate,
    'pruneRankedSubjects.primaryRankPredicate',
  );
  const secondaryRankPredicate = absoluteIri(
    input.secondaryRankPredicate,
    'pruneRankedSubjects.secondaryRankPredicate',
  );
  const eligibleObjects = boundedUniqueStrings(
    input.eligibleObjects,
    'pruneRankedSubjects.eligibleObjects',
    16,
  );
  const retainNewest = boundedInteger(
    input.retainNewest,
    'pruneRankedSubjects.retainNewest',
    BOUNDED_MUTATION_MAX_IRIS,
  );
  const maxDelete = boundedInteger(
    input.maxDelete,
    'pruneRankedSubjects.maxDelete',
    BOUNDED_MUTATION_MAX_PRUNE_DELETE,
  );
  if (maxDelete === 0) throw new Error('pruneRankedSubjects.maxDelete must be positive');
  assertOperandBudget('pruneRankedSubjects', [
    graphUri,
    subjectPrefix,
    eligibilityPredicate,
    primaryRankPredicate,
    secondaryRankPredicate,
    ...eligibleObjects,
  ]);
  return {
    graphUri,
    subjectPrefix,
    eligibilityPredicate,
    eligibleObjects,
    primaryRankPredicate,
    secondaryRankPredicate,
    retainNewest,
    maxDelete,
  };
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
  const graphUri = absoluteIri(input.graphUri, 'pruneLinkedRecordClosures.graphUri');
  const matchObjectIris = uniqueIris(
    input.matchObjectIris,
    'pruneLinkedRecordClosures.matchObjectIris',
  );
  const linkPredicates = uniqueIris(
    input.linkPredicates,
    'pruneLinkedRecordClosures.linkPredicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
  );
  const recordParentPredicate = absoluteIri(
    input.recordParentPredicate,
    'pruneLinkedRecordClosures.recordParentPredicate',
  );
  const protectedRecordIri = input.protectedRecordIri === undefined
    ? undefined
    : absoluteIri(input.protectedRecordIri, 'pruneLinkedRecordClosures.protectedRecordIri');
  const descendantSeparator = boundedString(
    input.descendantSeparator,
    'pruneLinkedRecordClosures.descendantSeparator',
    64,
  );
  assertOperandBudget('pruneLinkedRecordClosures', [
    graphUri,
    ...matchObjectIris,
    ...linkPredicates,
    recordParentPredicate,
    descendantSeparator,
    ...(protectedRecordIri ? [protectedRecordIri] : []),
  ]);
  return {
    graphUri,
    matchObjectIris,
    linkPredicates,
    recordParentPredicate,
    protectedRecordIri,
    descendantSeparator,
  };
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
