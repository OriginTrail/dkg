import { formatCanonicalRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';

type SparqlJsonLiteralTerm = {
  type: 'literal' | 'typed-literal';
  value: string;
} & (
  | { 'xml:lang': string; datatype?: never }
  | { datatype: string; 'xml:lang'?: never }
  | { datatype?: never; 'xml:lang'?: never }
);

type AdapterSparqlJsonTerm =
  | { type: 'uri'; value: string }
  | { type: 'bnode'; value: string }
  | SparqlJsonLiteralTerm;

export interface AdapterSparqlJsonSelectResponse {
  head?: { vars?: string[] };
  results?: { bindings?: Array<Record<string, AdapterSparqlJsonTerm>> };
}

export class SparqlJsonResultsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SparqlJsonResultsShapeError';
  }
}

function formatSparqlJsonTerm(term: AdapterSparqlJsonTerm): string {
  if (term.type === 'bnode') return `_:${term.value}`;
  if (term.type === 'literal' || term.type === 'typed-literal') {
    if (term['xml:lang']) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'language',
        value: term.value,
        language: term['xml:lang'],
      });
    }
    if (term.datatype) {
      return formatCanonicalRdfLiteralTerm({
        kind: 'typed',
        value: term.value,
        datatype: term.datatype,
      });
    }
    return formatCanonicalRdfLiteralTerm({ kind: 'plain', value: term.value });
  }
  return term.value;
}

/** Convert an adapter SPARQL Results JSON SELECT payload into DKG API bindings. */
export function formatSparqlJsonBindings(
  response: unknown,
): Array<Record<string, string>> {
  const head = ownDataRecord(response, 'head', 'SPARQL JSON response');
  const variables = ownDataValue(head, 'vars', 'SPARQL JSON head');
  if (!Array.isArray(variables) || variables.some((variable) => typeof variable !== 'string')) {
    malformed('SPARQL JSON head.vars must be an array of strings');
  }
  const results = ownDataRecord(response, 'results', 'SPARQL JSON response');
  const bindings = ownDataValue(results, 'bindings', 'SPARQL JSON results');
  if (!Array.isArray(bindings)) {
    malformed('SPARQL JSON results.bindings must be an array');
  }
  return bindings.map((row) => {
    const binding: Record<string, string> = {};
    for (const variable of variables) {
      const term = row[variable];
      if (term) binding[variable] = formatSparqlJsonTerm(term);
    }
    return binding;
  });
}

function ownDataRecord(input: unknown, key: string, label: string): Record<string, unknown> {
  const value = ownDataValue(input, key, label);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    malformed(`${label}.${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function ownDataValue(input: unknown, key: string, label: string): unknown {
  if (input === null || typeof input !== 'object') {
    malformed(`${label} must be an object`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    malformed(`${label}.${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function malformed(message: string): never {
  throw new SparqlJsonResultsShapeError(message);
}
