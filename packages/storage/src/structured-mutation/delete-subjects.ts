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
  if (normalized.subjects.length === 0) return undefined;
  const values = normalized.subjects.map((subject) => `<${subject}>`).join(' ');
  return assertBoundedStructuredUpdate('deleteSubjects', `DELETE { GRAPH <${normalized.graphUri}> { ?subject ?predicate ?object } }
WHERE { GRAPH <${normalized.graphUri}> {
  VALUES ?subject { ${values} }
  ?subject ?predicate ?object
} }`);
}
