import type { DeleteSubjectsInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
} from './primitives.js';
import {
  captureInputRecord,
  captureUniqueIris,
  type StructuredMutationSemantics,
} from './capture-internal.js';

export function captureDeleteSubjectsInput(input: unknown): DeleteSubjectsInput {
  const value = captureInputRecord(input, 'deleteSubjects');
  const graphUri = absoluteIri(value.graphUri as string, 'deleteSubjects.graphUri');
  const subjects = captureUniqueIris(
    value.subjects,
    'deleteSubjects.subjects',
    BOUNDED_MUTATION_MAX_IRIS,
    true,
  );
  return Object.freeze({ graphUri, subjects });
}

export function deleteSubjectsSemantics(
  input: DeleteSubjectsInput,
): StructuredMutationSemantics {
  return {
    guardedGraphs: [input.graphUri],
    touchedGraphs: [input.graphUri],
    mightMutate: input.subjects.length > 0,
  };
}

export function materializeDeleteSubjectsInput(
  input: DeleteSubjectsInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('deleteSubjects', [input.graphUri, ...input.subjects]);
  return buildUpdate ? buildDeleteSubjectsUpdateFromNormalized(input) : undefined;
}

export function normalizeDeleteSubjectsInput(input: DeleteSubjectsInput): DeleteSubjectsInput {
  const captured = captureDeleteSubjectsInput(input);
  materializeDeleteSubjectsInput(captured, false);
  return captured;
}

export function buildDeleteSubjectsUpdate(input: DeleteSubjectsInput): string | undefined {
  const normalized = normalizeDeleteSubjectsInput(input);
  return buildDeleteSubjectsUpdateFromNormalized(normalized);
}

export function buildDeleteSubjectsUpdateFromNormalized(
  input: DeleteSubjectsInput,
): string | undefined {
  if (input.subjects.length === 0) return undefined;
  const values = input.subjects.map((subject) => `<${subject}>`).join(' ');
  return assertBoundedStructuredUpdate('deleteSubjects', `DELETE { GRAPH <${input.graphUri}> { ?subject ?predicate ?object } }
WHERE { GRAPH <${input.graphUri}> {
  VALUES ?subject { ${values} }
  ?subject ?predicate ?object
} }`);
}
