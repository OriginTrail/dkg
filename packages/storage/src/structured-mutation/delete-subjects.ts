import type { DeleteSubjectsInput } from '../triple-store.js';
import {
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  uniqueIris,
} from './primitives.js';

export function normalizeDeleteSubjectsInput(input: DeleteSubjectsInput): DeleteSubjectsInput {
  const graphUri = absoluteIri(input.graphUri, 'deleteSubjects.graphUri');
  const subjects = uniqueIris(input.subjects, 'deleteSubjects.subjects', undefined, true);
  assertOperandBudget('deleteSubjects', [graphUri, ...subjects]);
  return { graphUri, subjects };
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
