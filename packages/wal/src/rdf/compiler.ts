import { compareCanonicalCbor } from '../protocol/canonical-cbor.js';
import { decodeProtocolTuple, encodeProtocolTuple } from '../protocol/codec.js';
import { WAL_V1_ENUMS, type ProtocolTuple } from '../protocol/schema.js';
import { rdfError } from './errors.js';
import {
  assertRdfWriteAuthorizedV1,
  bytesEqualV1,
  isGraphAllowedByRdfPolicyV1,
  rdfLogicalKeyV1,
  rdfTouchedKeyV1,
} from './keys.js';
import {
  canonicalizeAbsoluteIriV1,
  canonicalizeNQuadsV1,
  requireCanonicalNQuadsV1,
} from './nquads.js';
import { validateRdfPolicyV1 } from './policy.js';
import {
  canonicalSparqlAuditBytesV1,
  compileLocalSparqlPatchV1,
} from './sparql.js';
import type {
  CanonicalRdfDatasetV1,
  CompileRdfMutationInputV1,
  CompiledRdfMutationV1,
  RdfQuadV1,
} from './types.js';

const DKG_MUTATION_KIND = BigInt(WAL_V1_ENUMS.payloadKind.DKG_MUTATION);
const REPLACE_MODE = BigInt(WAL_V1_ENUMS.mutationMode.REPLACE);
const PATCH_MODE = BigInt(WAL_V1_ENUMS.mutationMode.PATCH);
const MAXIMUM_GRAPH_SCOPES = 64;
const MAXIMUM_SUBJECT_SCOPES = 4_096;
const MAXIMUM_TOUCHED_KEYS = 4_096;
const OPERATION = Object.freeze({
  PUT: BigInt(WAL_V1_ENUMS.mutationOperation.PUT),
  PATCH: BigInt(WAL_V1_ENUMS.mutationOperation.PATCH),
  DELETE: BigInt(WAL_V1_ENUMS.mutationOperation.DELETE),
});

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function exactBytes(value: Uint8Array, length: number, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    rdfError('WAL_RDF_POLICY_INVALID', label + ' must be exactly ' + length + ' bytes');
  }
  return new Uint8Array(value);
}

function sortedUniqueIds(values: readonly Uint8Array[], label: string): readonly Uint8Array[] {
  if (!Array.isArray(values)) rdfError('WAL_RDF_CAUSAL_RELATION', label + ' must be an array');
  const output = values.map((value, index) => exactBytes(value, 32, label + '[' + index + ']'))
    .sort(compareCanonicalCbor);
  for (let index = 1; index < output.length; index += 1) {
    if (bytesEqualV1(output[index - 1]!, output[index]!)) {
      rdfError('WAL_RDF_CAUSAL_RELATION', label + ' contains a duplicate object ID');
    }
  }
  if (output.length > 64) rdfError('WAL_RDF_LIMIT_EXCEEDED', label + ' exceeds 64 object IDs');
  return output;
}

function sameIds(left: readonly Uint8Array[], right: readonly Uint8Array[]): boolean {
  return left.length === right.length && left.every((value, index) => bytesEqualV1(value, right[index]!));
}

function requireAllowedGraph(
  graphIri: string,
  allowedGraphs: ReadonlySet<string>,
  policy: ProtocolTuple<'RdfPolicyV1'>,
): string {
  const graph = canonicalizeAbsoluteIriV1(graphIri, 'graph IRI');
  if (!allowedGraphs.has(graph)) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'mutation graph is outside the declared logical-key scope');
  }
  if (!isGraphAllowedByRdfPolicyV1(graph, policy)) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'mutation graph is outside signed policy prefixes');
  }
  return graph;
}

function datasetFromLines(lines: Iterable<string>): CanonicalRdfDatasetV1 {
  return canonicalizeNQuadsV1([...lines].join('\n'));
}

function touchedKeys(quads: readonly RdfQuadV1[]): readonly Uint8Array[] {
  const byHex = new Map<string, Uint8Array>();
  for (const quad of quads) {
    const key = rdfTouchedKeyV1(quad.graph, quad.subject, quad.predicate);
    byHex.set(hex(key), key);
  }
  return [...byHex.values()].sort(compareCanonicalCbor);
}

function unionTouched(...datasets: readonly CanonicalRdfDatasetV1[]): readonly Uint8Array[] {
  return touchedKeys(datasets.flatMap(dataset => dataset.quads));
}

function applyPatch(
  base: CanonicalRdfDatasetV1,
  deletes: CanonicalRdfDatasetV1,
  inserts: CanonicalRdfDatasetV1,
): CanonicalRdfDatasetV1 {
  const lines = new Map(base.quads.map(quad => [quad.canonicalLine, quad.canonicalLine] as const));
  for (const quad of deletes.quads) lines.delete(quad.canonicalLine);
  for (const quad of inserts.quads) lines.set(quad.canonicalLine, quad.canonicalLine);
  return datasetFromLines(lines.values());
}

interface ReplacementCompilation {
  readonly graphTuples: readonly ProtocolTuple<'GraphReplacementV1'>[];
  readonly subjectTuples: readonly ProtocolTuple<'SubjectReplacementV1'>[];
  readonly removed: CanonicalRdfDatasetV1;
  readonly inserted: CanonicalRdfDatasetV1;
  readonly result: CanonicalRdfDatasetV1;
}

function compileReplacement(
  input: Extract<CompileRdfMutationInputV1['source'], { kind: 'replace' }>,
  base: CanonicalRdfDatasetV1,
  allowedGraphs: ReadonlySet<string>,
  policy: ProtocolTuple<'RdfPolicyV1'>,
): ReplacementCompilation {
  const graphScopes = new Set<string>();
  const subjectScopes = new Set<string>();
  const graphTuples: ProtocolTuple<'GraphReplacementV1'>[] = [];
  const subjectTuples: ProtocolTuple<'SubjectReplacementV1'>[] = [];
  const removedLines = new Set<string>();
  const insertedLines = new Set<string>();
  let explicitQuadCount = 0;
  const maximumQuads = Number(policy[3]);
  if ((input.graphs?.length ?? 0) > MAXIMUM_GRAPH_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'too many graph replacements');
  }
  if ((input.subjects?.length ?? 0) > MAXIMUM_SUBJECT_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'too many subject replacements');
  }

  for (const replacement of input.graphs ?? []) {
    const graph = requireAllowedGraph(replacement.graphIri, allowedGraphs, policy);
    if (graphScopes.has(graph)) rdfError('WAL_RDF_SCOPE_ESCAPE', 'duplicate graph replacement scope');
    graphScopes.add(graph);
    const dataset = canonicalizeNQuadsV1(replacement.nquads);
    if (dataset.quads.some(quad => quad.graph !== graph)) {
      rdfError('WAL_RDF_SCOPE_ESCAPE', 'graph replacement bytes escape graph ' + graph);
    }
    for (const quad of base.quads) if (quad.graph === graph) removedLines.add(quad.canonicalLine);
    for (const quad of dataset.quads) insertedLines.add(quad.canonicalLine);
    graphTuples.push([graph, dataset.bytes, BigInt(dataset.quadCount)]);
    explicitQuadCount += dataset.quadCount;
    if (explicitQuadCount > maximumQuads) {
      rdfError('WAL_RDF_LIMIT_EXCEEDED', 'replacement bytes exceed the signed policy quad limit');
    }
  }

  for (const replacement of input.subjects ?? []) {
    const graph = requireAllowedGraph(replacement.graphIri, allowedGraphs, policy);
    const subject = canonicalizeAbsoluteIriV1(replacement.subjectIri, 'subject replacement IRI');
    if (graphScopes.has(graph)) {
      rdfError('WAL_RDF_SCOPE_ESCAPE', 'subject replacement overlaps a complete graph replacement');
    }
    const scope = graph + '\0' + subject;
    if (subjectScopes.has(scope)) rdfError('WAL_RDF_SCOPE_ESCAPE', 'duplicate subject replacement scope');
    subjectScopes.add(scope);
    const dataset = canonicalizeNQuadsV1(replacement.nquads);
    if (dataset.quads.some(quad => quad.graph !== graph || quad.subject !== subject)) {
      rdfError('WAL_RDF_SCOPE_ESCAPE', 'subject replacement bytes escape their exact graph and subject');
    }
    for (const quad of base.quads) {
      if (quad.graph === graph && quad.subject === subject) removedLines.add(quad.canonicalLine);
    }
    for (const quad of dataset.quads) insertedLines.add(quad.canonicalLine);
    subjectTuples.push([graph, subject, dataset.bytes, BigInt(dataset.quadCount)]);
    explicitQuadCount += dataset.quadCount;
    if (explicitQuadCount > maximumQuads) {
      rdfError('WAL_RDF_LIMIT_EXCEEDED', 'replacement bytes exceed the signed policy quad limit');
    }
  }

  if (graphTuples.length === 0 && subjectTuples.length === 0) {
    rdfError('WAL_RDF_POLICY_INVALID', 'REPLACE requires at least one exact graph or subject scope');
  }
  graphTuples.sort(compareCanonicalCbor);
  subjectTuples.sort(compareCanonicalCbor);
  const removed = datasetFromLines(removedLines);
  const inserted = datasetFromLines(insertedLines);
  const result = applyPatch(base, removed, inserted);
  return { graphTuples, subjectTuples, removed, inserted, result };
}

function assertMutationBounds(
  policy: ProtocolTuple<'RdfPolicyV1'>,
  explicitQuadCount: number,
  result: CanonicalRdfDatasetV1,
): void {
  if (
    BigInt(explicitQuadCount) > policy[3]
    || BigInt(result.quadCount) > policy[3]
  ) rdfError('WAL_RDF_LIMIT_EXCEEDED', 'mutation or explicit result exceeds signed policy quad limit');
}

function allGraphsAllowed(
  dataset: CanonicalRdfDatasetV1,
  allowedGraphs: ReadonlySet<string>,
  policy: ProtocolTuple<'RdfPolicyV1'>,
): void {
  for (const quad of dataset.quads) requireAllowedGraph(quad.graph, allowedGraphs, policy);
}

export function compileRdfMutationV1(input: CompileRdfMutationInputV1): CompiledRdfMutationV1 {
  validateRdfPolicyV1(input.policy);
  if (!input.policy[10].includes(DKG_MUTATION_KIND)) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'signed policy does not permit DKG mutation payloads');
  }
  const policyObjectId = exactBytes(input.policyObjectId, 32, 'policyObjectId');
  const writerId = exactBytes(input.writerId, 20, 'writerId');
  const logicalKey = rdfLogicalKeyV1(input.logicalKey);
  assertRdfWriteAuthorizedV1({
    logicalKey,
    logicalKeyAuthor: input.logicalKey.authorAddress,
    writerId,
    memberWriterIds: input.memberWriterIds,
    policy: input.policy,
  });

  const allowedGraphList = input.allowedGraphIris.map((graph, index) =>
    canonicalizeAbsoluteIriV1(graph, 'allowedGraphIris[' + index + ']'));
  const allowedGraphs = new Set(allowedGraphList);
  if (allowedGraphs.size === 0 || allowedGraphs.size !== allowedGraphList.length) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'allowedGraphIris must be a non-empty unique exact set');
  }
  if (allowedGraphs.size > MAXIMUM_GRAPH_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'allowedGraphIris exceeds 64 exact graph scopes');
  }
  for (const graph of allowedGraphs) requireAllowedGraph(graph, allowedGraphs, input.policy);
  const base = canonicalizeNQuadsV1(input.baseNQuads);
  allGraphsAllowed(base, allowedGraphs, input.policy);

  const baseHeads = sortedUniqueIds(input.baseHeads, 'baseHeads');
  const parents = sortedUniqueIds(input.parents ?? input.baseHeads, 'parents');
  if (!sameIds(parents, baseHeads)) {
    rdfError('WAL_RDF_CAUSAL_RELATION', 'ordinary mutation parents must equal the exact baseHeads set');
  }

  let mode: bigint;
  let replaceGraphs: readonly ProtocolTuple<'GraphReplacementV1'>[] = [];
  let replaceSubjects: readonly ProtocolTuple<'SubjectReplacementV1'>[] = [];
  let deletes = canonicalizeNQuadsV1('');
  let inserts = canonicalizeNQuadsV1('');
  let result: CanonicalRdfDatasetV1;
  let audit: Uint8Array | null = null;

  if (input.operation === 'DELETE') {
    if (input.source.kind !== 'delete-logical-key') {
      rdfError('WAL_RDF_POLICY_INVALID', 'DELETE must use the deterministic logical-key deletion compiler');
    }
    mode = PATCH_MODE;
    deletes = base;
    result = canonicalizeNQuadsV1('');
  } else if (input.source.kind === 'replace') {
    const replacement = compileReplacement(input.source, base, allowedGraphs, input.policy);
    mode = REPLACE_MODE;
    replaceGraphs = replacement.graphTuples;
    replaceSubjects = replacement.subjectTuples;
    result = replacement.result;
    deletes = replacement.removed;
    inserts = replacement.inserted;
  } else if (input.source.kind === 'sparql') {
    if (input.operation !== 'PATCH') {
      rdfError('WAL_RDF_POLICY_INVALID', 'SPARQL compilation is available only for PATCH operations');
    }
    const patch = compileLocalSparqlPatchV1({
      sparql: input.source.text,
      base,
      allowedGraphIris: allowedGraphList,
      maximumSolutions: input.maximumSparqlSolutions,
      maximumQuads: Number(input.policy[3]),
    });
    mode = PATCH_MODE;
    deletes = patch.deleteDataset;
    inserts = patch.insertDataset;
    result = patch.resultDataset;
    audit = input.includeSourceSparqlAudit
      ? canonicalSparqlAuditBytesV1(input.source.text)
      : null;
  } else {
    rdfError('WAL_RDF_POLICY_INVALID', 'PUT/PATCH must compile a replacement or supported local SPARQL update');
  }

  assertMutationBounds(input.policy, deletes.quadCount + inserts.quadCount, result);
  const touched = unionTouched(deletes, inserts);
  if (touched.length > MAXIMUM_TOUCHED_KEYS) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'mutation exceeds 4096 touched keys');
  }
  const rdfMutation: ProtocolTuple<'RdfMutationV1'> = [
    1n,
    mode,
    base.stateDigest,
    result.stateDigest,
    replaceGraphs,
    replaceSubjects,
    mode === PATCH_MODE ? deletes.bytes : new Uint8Array(),
    mode === PATCH_MODE ? inserts.bytes : new Uint8Array(),
    touched,
    audit,
  ];
  const dkgMutation: ProtocolTuple<'DkgMutationV1'> = [
    1n,
    OPERATION[input.operation],
    logicalKey,
    parents,
    baseHeads,
    policyObjectId,
    rdfMutation,
    input.chainBinding ?? null,
    input.nonConsensusTimestampMs ?? null,
  ];
  let contentBytes: Uint8Array;
  try {
    contentBytes = encodeProtocolTuple('DkgMutationV1', dkgMutation);
  } catch (error) {
    return rdfError('WAL_RDF_POLICY_INVALID', 'compiled DkgMutationV1 violates the frozen tuple schema', error);
  }
  if (BigInt(contentBytes.length) > input.policy[4]) {
    rdfError('WAL_RDF_OBJECT_TOO_LARGE', 'compiled mutation payload exceeds signed policy byte limit');
  }
  return { logicalKey, dkgMutation, rdfMutation, contentBytes, base, result };
}

function validateReplacementTuple(
  tuple: ProtocolTuple<'GraphReplacementV1'> | ProtocolTuple<'SubjectReplacementV1'>,
  subjectScoped: boolean,
): CanonicalRdfDatasetV1 {
  const graph = canonicalizeAbsoluteIriV1(tuple[0], 'replacement graph IRI');
  const subject = subjectScoped
    ? canonicalizeAbsoluteIriV1((tuple as ProtocolTuple<'SubjectReplacementV1'>)[1], 'replacement subject IRI')
    : null;
  const bytes = subjectScoped
    ? (tuple as ProtocolTuple<'SubjectReplacementV1'>)[2]
    : (tuple as ProtocolTuple<'GraphReplacementV1'>)[1];
  const count = subjectScoped
    ? (tuple as ProtocolTuple<'SubjectReplacementV1'>)[3]
    : (tuple as ProtocolTuple<'GraphReplacementV1'>)[2];
  const dataset = requireCanonicalNQuadsV1(bytes);
  if (BigInt(dataset.quadCount) !== count) {
    rdfError('WAL_RDF_RESULT_MISMATCH', 'replacement quad count does not match canonical bytes');
  }
  if (dataset.quads.some(quad =>
    quad.graph !== graph || (subject !== null && quad.subject !== subject))) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'replacement bytes escape their exact scope');
  }
  return dataset;
}

export function applyExplicitRdfMutationV1(input: {
  readonly rdfMutation: ProtocolTuple<'RdfMutationV1'>;
  readonly baseNQuads: string | Uint8Array;
}): CanonicalRdfDatasetV1 {
  try {
    encodeProtocolTuple('RdfMutationV1', input.rdfMutation);
  } catch (error) {
    return rdfError('WAL_RDF_NON_CANONICAL', 'RdfMutationV1 is not an exact canonical tuple', error);
  }
  const mutation = input.rdfMutation;
  const base = canonicalizeNQuadsV1(input.baseNQuads);
  if (!bytesEqualV1(base.stateDigest, mutation[2])) {
    rdfError('WAL_RDF_BASE_MISMATCH', 'baseStateDigest does not match the declared base bytes');
  }
  let result: CanonicalRdfDatasetV1;
  let touched: readonly Uint8Array[];
  if (mutation[1] === PATCH_MODE) {
    if (mutation[4].length !== 0 || mutation[5].length !== 0) {
      rdfError('WAL_RDF_NON_CANONICAL', 'PATCH cannot contain replacement scopes');
    }
    const deletes = requireCanonicalNQuadsV1(mutation[6]);
    const inserts = requireCanonicalNQuadsV1(mutation[7]);
    result = applyPatch(base, deletes, inserts);
    touched = unionTouched(deletes, inserts);
  } else {
    // Exact tuple validation above limits the mode enum to PATCH or REPLACE.
    if (mutation[6].length !== 0 || mutation[7].length !== 0) {
      rdfError('WAL_RDF_NON_CANONICAL', 'REPLACE cannot contain patch bytes');
    }
    const graphScopes = new Set<string>();
    const subjectScopes = new Set<string>();
    const removed = new Set<string>();
    const inserted = new Set<string>();
    for (const tuple of mutation[4]) {
      if (graphScopes.has(tuple[0])) rdfError('WAL_RDF_SCOPE_ESCAPE', 'duplicate graph replacement');
      graphScopes.add(tuple[0]);
      const dataset = validateReplacementTuple(tuple, false);
      for (const quad of base.quads) if (quad.graph === tuple[0]) removed.add(quad.canonicalLine);
      for (const quad of dataset.quads) inserted.add(quad.canonicalLine);
    }
    for (const tuple of mutation[5]) {
      const scope = tuple[0] + '\0' + tuple[1];
      if (graphScopes.has(tuple[0]) || subjectScopes.has(scope)) {
        rdfError('WAL_RDF_SCOPE_ESCAPE', 'overlapping or duplicate subject replacement');
      }
      subjectScopes.add(scope);
      const dataset = validateReplacementTuple(tuple, true);
      for (const quad of base.quads) {
        if (quad.graph === tuple[0] && quad.subject === tuple[1]) removed.add(quad.canonicalLine);
      }
      for (const quad of dataset.quads) inserted.add(quad.canonicalLine);
    }
    if (mutation[4].length === 0 && mutation[5].length === 0) {
      rdfError('WAL_RDF_NON_CANONICAL', 'REPLACE has no replacement scope');
    }
    const deletes = datasetFromLines(removed);
    const inserts = datasetFromLines(inserted);
    result = applyPatch(base, deletes, inserts);
    touched = unionTouched(deletes, inserts);
  }
  if (!bytesEqualV1(result.stateDigest, mutation[3])) {
    rdfError('WAL_RDF_RESULT_MISMATCH', 'resultStateDigest does not match explicit canonical result');
  }
  if (!sameIds(touched, mutation[8])) {
    rdfError('WAL_RDF_TOUCHED_KEYS_MISMATCH', 'touchedKeys does not match the explicit mutation');
  }
  // sourceSparqlAuditBytesOrNull is intentionally not parsed or executed.
  return result;
}

export function decodeAndApplyDkgMutationV1(input: {
  readonly contentBytes: Uint8Array;
  readonly baseNQuads: string | Uint8Array;
  readonly expectedPolicyObjectId: Uint8Array;
  readonly logicalKeyCoordinates: CompileRdfMutationInputV1['logicalKey'];
  readonly writerId: Uint8Array;
  readonly memberWriterIds: readonly Uint8Array[];
  readonly allowedGraphIris: readonly string[];
  readonly policy: ProtocolTuple<'RdfPolicyV1'>;
}): { readonly dkgMutation: ProtocolTuple<'DkgMutationV1'>; readonly result: CanonicalRdfDatasetV1 } {
  validateRdfPolicyV1(input.policy);
  let mutation: ProtocolTuple<'DkgMutationV1'>;
  try {
    mutation = decodeProtocolTuple('DkgMutationV1', input.contentBytes);
  } catch (error) {
    return rdfError('WAL_RDF_NON_CANONICAL', 'invalid canonical DkgMutationV1 bytes', error);
  }
  if (!bytesEqualV1(mutation[5], exactBytes(input.expectedPolicyObjectId, 32, 'expectedPolicyObjectId'))) {
    rdfError('WAL_RDF_POLICY_SUBSTITUTION', 'mutation references a different signed policy object');
  }
  const expectedLogicalKey = rdfLogicalKeyV1(input.logicalKeyCoordinates);
  if (!bytesEqualV1(mutation[2], expectedLogicalKey)) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'mutation logical key does not match the requested scope');
  }
  assertRdfWriteAuthorizedV1({
    logicalKey: expectedLogicalKey,
    logicalKeyAuthor: input.logicalKeyCoordinates.authorAddress,
    writerId: input.writerId,
    memberWriterIds: input.memberWriterIds,
    policy: input.policy,
  });
  if (!sameIds(mutation[3], mutation[4])) {
    rdfError('WAL_RDF_CAUSAL_RELATION', 'ordinary mutation parents must equal baseHeads');
  }
  if (
    mutation[1] !== OPERATION.PUT
    && mutation[1] !== OPERATION.PATCH
    && mutation[1] !== OPERATION.DELETE
  ) rdfError('WAL_RDF_POLICY_INVALID', 'this compiler accepts only PUT, PATCH, and DELETE mutations');
  if (mutation[6] === null) rdfError('WAL_RDF_POLICY_INVALID', 'RDF mutation payload cannot be null');
  if (!input.policy[10].includes(DKG_MUTATION_KIND)) {
    rdfError('WAL_RDF_UNAUTHORIZED', 'signed policy does not permit DKG mutation payloads');
  }
  const allowedGraphList = input.allowedGraphIris.map((graph, index) =>
    canonicalizeAbsoluteIriV1(graph, 'allowedGraphIris[' + index + ']'));
  const allowedGraphs = new Set(allowedGraphList);
  if (allowedGraphs.size === 0 || allowedGraphs.size !== allowedGraphList.length) {
    rdfError('WAL_RDF_SCOPE_ESCAPE', 'allowedGraphIris must be a non-empty unique exact set');
  }
  if (allowedGraphs.size > MAXIMUM_GRAPH_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'allowedGraphIris exceeds 64 exact graph scopes');
  }
  for (const graph of allowedGraphs) requireAllowedGraph(graph, allowedGraphs, input.policy);
  const base = canonicalizeNQuadsV1(input.baseNQuads);
  allGraphsAllowed(base, allowedGraphs, input.policy);
  const rdfMutation = mutation[6];
  if (mutation[1] === OPERATION.PUT && rdfMutation[1] !== REPLACE_MODE) {
    rdfError('WAL_RDF_POLICY_INVALID', 'PUT must carry an exact-scope REPLACE mutation');
  }
  if (mutation[1] === OPERATION.DELETE && rdfMutation[1] !== PATCH_MODE) {
    rdfError('WAL_RDF_POLICY_INVALID', 'DELETE must carry the deterministic whole-key PATCH mutation');
  }
  if (rdfMutation[4].length > MAXIMUM_GRAPH_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'mutation exceeds the graph replacement scope limit');
  }
  if (rdfMutation[5].length > MAXIMUM_SUBJECT_SCOPES) {
    rdfError('WAL_RDF_LIMIT_EXCEEDED', 'mutation exceeds the subject replacement scope limit');
  }
  for (const replacement of rdfMutation[4]) requireAllowedGraph(replacement[0], allowedGraphs, input.policy);
  for (const replacement of rdfMutation[5]) requireAllowedGraph(replacement[0], allowedGraphs, input.policy);
  const deletes = requireCanonicalNQuadsV1(rdfMutation[6]);
  const inserts = requireCanonicalNQuadsV1(rdfMutation[7]);
  allGraphsAllowed(deletes, allowedGraphs, input.policy);
  allGraphsAllowed(inserts, allowedGraphs, input.policy);
  const replacementQuadCount = rdfMutation[4].reduce((sum, tuple) => sum + tuple[2], 0n)
    + rdfMutation[5].reduce((sum, tuple) => sum + tuple[3], 0n);
  if (
    replacementQuadCount > input.policy[3]
    || BigInt(deletes.quadCount + inserts.quadCount) > input.policy[3]
    || rdfMutation[8].length > MAXIMUM_TOUCHED_KEYS
  ) rdfError('WAL_RDF_LIMIT_EXCEEDED', 'remote explicit mutation exceeds signed policy limits');
  if (mutation[1] === OPERATION.DELETE && (
    rdfMutation[4].length !== 0
    || rdfMutation[5].length !== 0
    || !bytesEqualV1(deletes.bytes, base.bytes)
    || inserts.quadCount !== 0
    || rdfMutation[9] !== null
  )) rdfError('WAL_RDF_POLICY_INVALID', 'DELETE is not the deterministic whole-logical-key deletion');
  const result = applyExplicitRdfMutationV1({
    rdfMutation,
    baseNQuads: base.bytes,
  });
  allGraphsAllowed(result, allowedGraphs, input.policy);
  if (
    BigInt(result.quadCount) > input.policy[3]
    || BigInt(input.contentBytes.length) > input.policy[4]
  ) rdfError('WAL_RDF_LIMIT_EXCEEDED', 'remote mutation exceeds signed policy limits');
  return { dkgMutation: mutation, result };
}
