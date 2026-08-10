import type { ReplaceSubjectPredicatesInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_PREDICATES,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  normalizeStructuredRdfObject,
  uniqueIris,
} from './primitives.js';

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

/** Validate before a storage decorator rewrites RDF objects. */
export function normalizeReplaceSubjectPredicatesInputForObjectRewrite(
  input: ReplaceSubjectPredicatesInput,
): ReplaceSubjectPredicatesInput {
  return normalizeReplaceSubjectPredicatesInputInternal(input, false);
}

export function buildReplaceSubjectPredicatesUpdate(
  input: ReplaceSubjectPredicatesInput,
): string {
  const normalized = normalizeReplaceSubjectPredicatesInput(input);
  return buildReplaceSubjectPredicatesUpdateFromNormalized(normalized);
}

export function buildReplaceSubjectPredicatesUpdateFromNormalized(
  input: ReplaceSubjectPredicatesInput,
): string {
  const predicateValues = input.predicates.map((predicate) => `<${predicate}>`).join(', ');
  const insertion = input.replacementQuads.length > 0
    ? `INSERT {
  GRAPH <${input.graphUri}> {
${input.replacementQuads.map((quad) => `    <${quad.subject}> <${quad.predicate}> ${quad.object} .`).join('\n')}
  }
}
`
    : '';
  return assertBoundedStructuredUpdate('replaceSubjectPredicates', `DELETE {
  GRAPH <${input.graphUri}> { <${input.subject}> ?predicate ?oldObject }
}
${insertion}WHERE {
  OPTIONAL {
    GRAPH <${input.graphUri}> {
      <${input.subject}> ?predicate ?oldObject .
      FILTER(?predicate IN (${predicateValues}))
    }
  }
}`);
}
