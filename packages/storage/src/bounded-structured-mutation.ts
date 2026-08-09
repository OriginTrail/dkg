import {
  isSafeIri,
  sparqlInt,
  sparqlString,
} from '@origintrail-official/dkg-core';
import type {
  CopySubjectProjectionInput,
  DeleteSubjectsInput,
  PruneLinkedRecordClosuresInput,
  PruneRankedSubjectsInput,
  Quad,
  ReplaceProjectionFromGraphInput,
  ReplaceSubjectPredicatesInput,
  StructuredMutation,
} from './triple-store.js';
import { formatRdfObjectTerm } from './rdf-term-format.js';

export const BOUNDED_MUTATION_MAX_IRIS = 100_000;
export const BOUNDED_MUTATION_MAX_PRUNE_DELETE = 10_000;
export const BOUNDED_MUTATION_MAX_OPERAND_BYTES = 4 * 1024 * 1024;
export const BOUNDED_MUTATION_MAX_UPDATE_BYTES = 4 * 1024 * 1024;
export const BOUNDED_MUTATION_MAX_SOURCE_GRAPHS = 8;
export const BOUNDED_MUTATION_MAX_PREDICATES = 64;
export const BOUNDED_MUTATION_MAX_PREFIXES = 64;

const UTF8 = new TextEncoder();

class BoundedMutationBudgetError extends Error {}

function unsupportedMutation(mutation: never): never {
  throw new Error(`Unsupported structured mutation kind ${String((mutation as { kind?: unknown })?.kind)}`);
}

function boundedInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer in 0..${max}`);
  }
  return value;
}

function boundedString(value: string, label: string, maxBytes = 512): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (UTF8.encode(value).byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function absoluteIri(value: string, label: string): string {
  if (typeof value !== 'string' || !isSafeIri(value)) {
    throw new Error(`${label} must be an absolute IRI`);
  }
  return value;
}

function normalizeStructuredRdfObject(value: string, label: string): string {
  try {
    return formatRdfObjectTerm(value, label, absoluteIri);
  } catch {
    throw new Error(`${label} must be a safe RDF literal or absolute IRI`);
  }
}

function uniqueIris(
  values: readonly string[],
  label: string,
  max = BOUNDED_MUTATION_MAX_IRIS,
  allowEmpty = false,
): string[] {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0) || values.length > max) {
    throw new Error(`${label} must contain ${allowEmpty ? '0' : '1'}..${max} IRIs`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!(index in values)) throw new Error(`${label} must be a dense array`);
    const iri = absoluteIri(values[index], `${label}[${index}]`);
    if (seen.has(iri)) throw new Error(`${label} contains duplicate IRI ${iri}`);
    seen.add(iri);
    result.push(iri);
  }
  return result;
}

function boundedUniqueStrings(
  values: readonly string[],
  label: string,
  max: number,
): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) {
    throw new Error(`${label} must contain 1..${max} values`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < values.length; index++) {
    if (!(index in values)) throw new Error(`${label} must be a dense array`);
    const value = boundedString(values[index], `${label}[${index}]`);
    if (seen.has(value)) throw new Error(`${label} contains duplicate value ${value}`);
    seen.add(value);
    result.push(value);
  }
  return result;
}

function assertOperandBudget(label: string, values: readonly string[]): void {
  let bytes = 0;
  for (const value of values) {
    bytes += UTF8.encode(value).byteLength;
    if (bytes > BOUNDED_MUTATION_MAX_OPERAND_BYTES) {
      throw new BoundedMutationBudgetError(
        `${label} exceeds ${BOUNDED_MUTATION_MAX_OPERAND_BYTES} operand bytes`,
      );
    }
  }
}

export function assertBoundedStructuredUpdate(label: string, update: string): string {
  const bytes = UTF8.encode(update).byteLength;
  if (bytes > BOUNDED_MUTATION_MAX_UPDATE_BYTES) {
    throw new BoundedMutationBudgetError(
      `${label} serialized update exceeds ${BOUNDED_MUTATION_MAX_UPDATE_BYTES} UTF-8 bytes`,
    );
  }
  return update;
}

export function normalizeDeleteSubjectsInput(input: DeleteSubjectsInput): DeleteSubjectsInput {
  const graphUri = absoluteIri(input.graphUri, 'deleteSubjects.graphUri');
  const subjects = uniqueIris(input.subjects, 'deleteSubjects.subjects', undefined, true);
  assertOperandBudget('deleteSubjects', [graphUri, ...subjects]);
  return { graphUri, subjects };
}

export function buildDeleteSubjectsUpdate(input: DeleteSubjectsInput): string | undefined {
  const normalized = normalizeDeleteSubjectsInput(input);
  if (normalized.subjects.length === 0) return undefined;
  const values = normalized.subjects.map((subject) => `<${subject}>`).join(' ');
  return assertBoundedStructuredUpdate('deleteSubjects', `DELETE { GRAPH <${normalized.graphUri}> { ?subject ?predicate ?object } }
WHERE { GRAPH <${normalized.graphUri}> {
  VALUES ?subject { ${values} }
  ?subject ?predicate ?object
} }`);
}

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
  const eligibleObjects = normalized.eligibleObjects.map(sparqlString).join(' ');
  const eligibilityFilter = `VALUES ?eligibleObject { ${eligibleObjects} }
      FILTER NOT EXISTS {
        ?subject <${normalized.eligibilityPredicate}> ?ineligibleObject .
        FILTER(?ineligibleObject NOT IN (${normalized.eligibleObjects.map(sparqlString).join(', ')}))
      }`;
  return assertBoundedStructuredUpdate('pruneRankedSubjects', `PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
DELETE { GRAPH <${normalized.graphUri}> { ?subject ?predicate ?object } }
WHERE {
  {
    SELECT ?subject
           (MAX(?primaryRank) AS ?latestPrimaryRank)
           (MAX(?secondaryRank) AS ?latestSecondaryRank)
    WHERE {
      GRAPH <${normalized.graphUri}> {
        ?subject <${normalized.eligibilityPredicate}> ?eligibleObject .
        OPTIONAL { ?subject <${normalized.primaryRankPredicate}> ?primaryRank }
        OPTIONAL { ?subject <${normalized.secondaryRankPredicate}> ?secondaryRank }
        ${eligibilityFilter}
        FILTER(STRSTARTS(STR(?subject), ${sparqlString(normalized.subjectPrefix)}))
      }
    }
    # sparql-scan-allow: R3 -- one bounded retention prune; OFFSET <= 100000 and LIMIT <= 10000; never page-walked
    GROUP BY ?subject
    ORDER BY DESC(COALESCE(
      xsd:integer(STR(?latestPrimaryRank)),
      xsd:integer(STR(?latestSecondaryRank)),
      0
    )) DESC(STR(?subject))
    OFFSET ${sparqlInt(normalized.retainNewest, { min: 0 })}
    LIMIT ${sparqlInt(normalized.maxDelete, { min: 1 })}
  }
  GRAPH <${normalized.graphUri}> {
    ?subject <${normalized.eligibilityPredicate}> ?eligibleObject ; ?predicate ?object .
    ${eligibilityFilter}
    FILTER(STRSTARTS(STR(?subject), ${sparqlString(normalized.subjectPrefix)}))
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
  const matchObjects = normalized.matchObjectIris.map((root) => `<${root}>`).join(' ');
  const linkPredicates = normalized.linkPredicates
    .map((predicate) => `<${predicate}>`)
    .join(' ');
  const keepFilter = normalized.protectedRecordIri
    ? `FILTER(?record != <${normalized.protectedRecordIri}>)`
    : '';
  return assertBoundedStructuredUpdate('pruneLinkedRecordClosures', `DELETE { GRAPH <${normalized.graphUri}> { ?subject ?predicate ?object } }
WHERE { GRAPH <${normalized.graphUri}> {
  VALUES ?matchObject { ${matchObjects} }
  VALUES ?linkPredicate { ${linkPredicates} }
  ?member ?linkPredicate ?matchObject .
  OPTIONAL { ?member <${normalized.recordParentPredicate}> ?parent }
  BIND(COALESCE(?parent, ?member) AS ?record)
  ${keepFilter}
  ?subject ?predicate ?object .
  FILTER(?subject = ?record || STRSTARTS(STR(?subject), CONCAT(STR(?record), ${sparqlString(normalized.descendantSeparator)})))
} }`);
}

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

function normalizeReplaceSubjectPredicatesInputInternal(
  input: ReplaceSubjectPredicatesInput,
  enforceOperandBudget: boolean,
): ReplaceSubjectPredicatesInput {
  const graphUri = absoluteIri(input.graphUri, 'replaceSubjectPredicates.graphUri');
  const subject = absoluteIri(input.subject, 'replaceSubjectPredicates.subject');
  const predicates = uniqueIris(
    input.predicates,
    'replaceSubjectPredicates.predicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
  );
  if (!Array.isArray(input.replacementQuads)
    || input.replacementQuads.length > BOUNDED_MUTATION_MAX_IRIS) {
    throw new Error(
      `replaceSubjectPredicates.replacementQuads must contain 0..${BOUNDED_MUTATION_MAX_IRIS} quads`,
    );
  }
  for (let index = 0; index < input.replacementQuads.length; index++) {
    if (!(index in input.replacementQuads)) {
      throw new Error('replaceSubjectPredicates.replacementQuads must be a dense array');
    }
  }
  const allowedPredicates = new Set(predicates);
  const replacementQuads = input.replacementQuads.map((quad, index) => {
    if (quad.graph !== graphUri || quad.subject !== subject) {
      throw new Error(
        `replaceSubjectPredicates quad ${index} must target subject ${subject} in graph ${graphUri}`,
      );
    }
    const predicate = absoluteIri(
      quad.predicate,
      `replaceSubjectPredicates.replacementQuads[${index}].predicate`,
    );
    if (!allowedPredicates.has(predicate)) {
      throw new Error(`replaceSubjectPredicates quad ${index} targets undeclared predicate ${predicate}`);
    }
    const object = normalizeStructuredRdfObject(
      quad.object,
      `replaceSubjectPredicates.replacementQuads[${index}].object`,
    );
    return { ...quad, predicate, object };
  });
  if (enforceOperandBudget) {
    assertOperandBudget('replaceSubjectPredicates', [
      graphUri,
      subject,
      ...predicates,
      ...replacementQuads.flatMap((quad) => [
        quad.subject,
        quad.predicate,
        quad.object,
        quad.graph,
      ]),
    ]);
  }
  return { graphUri, subject, predicates, replacementQuads };
}

export function normalizeReplaceSubjectPredicatesInput(
  input: ReplaceSubjectPredicatesInput,
): ReplaceSubjectPredicatesInput {
  return normalizeReplaceSubjectPredicatesInputInternal(input, true);
}

/**
 * Validate and canonicalize a predicate replacement before a storage decorator
 * rewrites its RDF objects. The final, rewritten mutation must still pass the
 * normal bounded validator before it reaches an adapter.
 */
export function normalizeReplaceSubjectPredicatesInputForObjectRewrite(
  input: ReplaceSubjectPredicatesInput,
): ReplaceSubjectPredicatesInput {
  return normalizeReplaceSubjectPredicatesInputInternal(input, false);
}

export function buildReplaceSubjectPredicatesUpdate(
  input: ReplaceSubjectPredicatesInput,
): string {
  const normalized = normalizeReplaceSubjectPredicatesInput(input);
  const predicateValues = normalized.predicates.map((predicate) => `<${predicate}>`).join(', ');
  const insertion = normalized.replacementQuads.length > 0
    ? `INSERT {
  GRAPH <${normalized.graphUri}> {
${normalized.replacementQuads.map((quad) => `    <${quad.subject}> <${quad.predicate}> ${quad.object} .`).join('\n')}
  }
}
`
    : '';
  return assertBoundedStructuredUpdate('replaceSubjectPredicates', `DELETE {
  GRAPH <${normalized.graphUri}> { <${normalized.subject}> ?predicate ?oldObject }
}
${insertion}WHERE {
  OPTIONAL {
    GRAPH <${normalized.graphUri}> {
      <${normalized.subject}> ?predicate ?oldObject .
      FILTER(?predicate IN (${predicateValues}))
    }
  }
}`);
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

/**
 * Split a subject-projection copy into the largest ordered root batches that
 * fit both structured-mutation byte limits. Each returned descriptor is
 * independently valid and preserves the caller's root order.
 */
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

    // Use the canonical normalizer and serializer as the only size model. A
    // binary search keeps planning bounded for large root sets while still
    // selecting the largest ordered prefix that fits both byte limits.
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
      // Surface the canonical limit error for an individually unrepresentable root.
      buildCopySubjectProjectionUpdate({ ...normalized, roots: [roots[start]] });
      throw new Error('copySubjectProjection root cannot fit the bounded mutation budget');
    }
    chunks.push(accepted);
    start += accepted.roots.length;
  }
  return chunks;
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

/**
 * Rewrite every caller-provided quad payload, then enforce the canonical
 * mutation budget on the rewritten representation. The exhaustive switch keeps
 * storage decorators from maintaining their own mutation-kind allowlists.
 */
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
