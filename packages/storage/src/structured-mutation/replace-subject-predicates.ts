import type { ReplaceSubjectPredicatesInput } from '../triple-store.js';
import {
  BOUNDED_MUTATION_MAX_IRIS,
  BOUNDED_MUTATION_MAX_PREDICATES,
  absoluteIri,
  assertBoundedStructuredUpdate,
  assertOperandBudget,
  normalizeStructuredRdfObject,
} from './primitives.js';
import {
  captureArray,
  captureInputRecord,
  captureUniqueIris,
  type StructuredMutationSemantics,
} from './capture-internal.js';

export function captureReplaceSubjectPredicatesInput(
  input: unknown,
): ReplaceSubjectPredicatesInput {
  const value = captureInputRecord(input, 'replaceSubjectPredicates');
  const graphUri = absoluteIri(value.graphUri as string, 'replaceSubjectPredicates.graphUri');
  const subject = absoluteIri(value.subject as string, 'replaceSubjectPredicates.subject');
  const predicates = captureUniqueIris(
    value.predicates,
    'replaceSubjectPredicates.predicates',
    BOUNDED_MUTATION_MAX_PREDICATES,
    false,
  );
  const allowedPredicates = new Set(predicates);
  const replacementQuads = captureArray(
    value.replacementQuads,
    'replaceSubjectPredicates.replacementQuads',
    0,
    BOUNDED_MUTATION_MAX_IRIS,
    (candidate, index) => {
      const quad = captureInputRecord(
        candidate,
        `replaceSubjectPredicates.replacementQuads[${index}]`,
      );
      const quadSubject = quad.subject;
      const quadPredicate = quad.predicate;
      const quadObject = quad.object;
      const quadGraph = quad.graph;
      if (quadGraph !== graphUri || quadSubject !== subject) {
        throw new Error(
          `replaceSubjectPredicates quad ${index} must target subject ${subject} in graph ${graphUri}`,
        );
      }
      const predicate = absoluteIri(
        quadPredicate as string,
        `replaceSubjectPredicates.replacementQuads[${index}].predicate`,
      );
      if (!allowedPredicates.has(predicate)) {
        throw new Error(
          `replaceSubjectPredicates quad ${index} targets undeclared predicate ${predicate}`,
        );
      }
      const object = normalizeStructuredRdfObject(
        quadObject as string,
        `replaceSubjectPredicates.replacementQuads[${index}].object`,
      );
      return Object.freeze({ subject, predicate, object, graph: graphUri });
    },
  );
  return Object.freeze({ graphUri, subject, predicates, replacementQuads });
}

export function replaceSubjectPredicatesSemantics(
  input: ReplaceSubjectPredicatesInput,
): StructuredMutationSemantics {
  return { guardedGraphs: [input.graphUri], touchedGraphs: [input.graphUri], mightMutate: true };
}

export function materializeReplaceSubjectPredicatesInput(
  input: ReplaceSubjectPredicatesInput,
  buildUpdate = true,
): string | undefined {
  assertOperandBudget('replaceSubjectPredicates', replaceSubjectPredicatesOperands(input));
  return buildUpdate ? buildReplaceSubjectPredicatesUpdateFromNormalized(input) : undefined;
}

function* replaceSubjectPredicatesOperands(
  input: ReplaceSubjectPredicatesInput,
): Iterable<string> {
  yield input.graphUri;
  yield input.subject;
  yield* input.predicates;
  for (const quad of input.replacementQuads) {
    yield quad.subject;
    yield quad.predicate;
    yield quad.object;
    yield quad.graph;
  }
}

export function normalizeReplaceSubjectPredicatesInput(
  input: ReplaceSubjectPredicatesInput,
): ReplaceSubjectPredicatesInput {
  const captured = captureReplaceSubjectPredicatesInput(input);
  materializeReplaceSubjectPredicatesInput(captured, false);
  return captured;
}

/** Validate before a storage decorator rewrites RDF objects. */
export function normalizeReplaceSubjectPredicatesInputForObjectRewrite(
  input: ReplaceSubjectPredicatesInput,
): ReplaceSubjectPredicatesInput {
  return captureReplaceSubjectPredicatesInput(input);
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
