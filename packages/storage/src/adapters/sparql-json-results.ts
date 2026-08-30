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
  head: { vars: string[] };
  results: { bindings: Array<Record<string, AdapterSparqlJsonTerm>> };
}

export interface ParsedSparqlJsonSelectResponse {
  variables: string[];
  bindings: Array<Record<string, string>>;
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
  return parseSparqlJsonSelectResponse(response).bindings;
}

/** Validate and snapshot one complete untrusted SPARQL JSON SELECT response. */
export function parseSparqlJsonSelectResponse(
  response: unknown,
): ParsedSparqlJsonSelectResponse {
  const head = ownDataRecord(response, 'head', 'SPARQL JSON response');
  const variables = denseStringArray(
    ownDataValue(head, 'vars', 'SPARQL JSON head'),
    'SPARQL JSON head.vars',
  );
  if (new Set(variables).size !== variables.length) {
    malformed('SPARQL JSON head.vars must not contain duplicates');
  }
  const results = ownDataRecord(response, 'results', 'SPARQL JSON response');
  const rows = denseArray(
    ownDataValue(results, 'bindings', 'SPARQL JSON results'),
    'SPARQL JSON results.bindings',
  );
  const bindings = rows.map((input, rowIndex) => {
    if (!isOrdinaryRecord(input)) {
      malformed(`SPARQL JSON binding ${rowIndex} must be a plain object`);
    }
    const row = input as Record<string, unknown>;
    for (const key of Reflect.ownKeys(row)) {
      if (typeof key !== 'string' || !variables.includes(key)) {
        malformed(`SPARQL JSON binding ${rowIndex} contains an undeclared variable`);
      }
    }
    const binding: Record<string, string> = {};
    for (const variable of variables) {
      if (!Object.prototype.hasOwnProperty.call(row, variable)) continue;
      const term = ownDataValue(row, variable, `SPARQL JSON binding ${rowIndex}`);
      binding[variable] = formatSparqlJsonTerm(snapshotTerm(term, rowIndex, variable));
    }
    return binding;
  });
  return { variables: [...variables], bindings };
}

function ownDataRecord(input: unknown, key: string, label: string): Record<string, unknown> {
  const value = ownDataValue(input, key, label);
  if (!isOrdinaryRecord(value)) {
    malformed(`${label}.${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function denseStringArray(input: unknown, label: string): string[] {
  const values = denseArray(input, label);
  if (values.some((value) => typeof value !== 'string')) {
    malformed(`${label} must be an array of strings`);
  }
  return values as string[];
}

function denseArray(input: unknown, label: string): unknown[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    malformed(`${label} must be an ordinary array`);
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== 'string')
    || keys.length !== input.length + 1
    || !keys.includes('length')
  ) {
    malformed(`${label} must be dense and unadorned`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < input.length; index += 1) {
    result.push(ownDataValue(input, String(index), label));
  }
  return result;
}

function snapshotTerm(input: unknown, rowIndex: number, variable: string): AdapterSparqlJsonTerm {
  const label = `SPARQL JSON binding ${rowIndex}.${variable}`;
  if (!isOrdinaryRecord(input)) malformed(`${label} must be a plain term object`);
  const term = input as Record<string, unknown>;
  const type = ownDataValue(term, 'type', label);
  const value = ownDataValue(term, 'value', label);
  if (typeof type !== 'string' || typeof value !== 'string') {
    malformed(`${label} type and value must be strings`);
  }
  const keys = Reflect.ownKeys(term);
  if (keys.some((key) => typeof key !== 'string')) malformed(`${label} has invalid fields`);
  if (type === 'uri' || type === 'bnode') {
    assertExactKeys(keys as string[], ['type', 'value'], label);
    return { type, value };
  }
  if (type !== 'literal' && type !== 'typed-literal') {
    malformed(`${label} has an unsupported term type`);
  }
  const hasLanguage = Object.prototype.hasOwnProperty.call(term, 'xml:lang');
  const hasDatatype = Object.prototype.hasOwnProperty.call(term, 'datatype');
  if (hasLanguage && hasDatatype) malformed(`${label} cannot contain both language and datatype`);
  const expected = hasLanguage
    ? ['type', 'value', 'xml:lang']
    : hasDatatype
      ? ['datatype', 'type', 'value']
      : ['type', 'value'];
  assertExactKeys(keys as string[], expected, label);
  if (hasLanguage) {
    const language = ownDataValue(term, 'xml:lang', label);
    if (typeof language !== 'string' || language.length === 0) {
      malformed(`${label} language must be a non-empty string`);
    }
    return { type, value, 'xml:lang': language };
  }
  if (hasDatatype) {
    const datatype = ownDataValue(term, 'datatype', label);
    if (typeof datatype !== 'string' || datatype.length === 0) {
      malformed(`${label} datatype must be a non-empty string`);
    }
    return { type, value, datatype };
  }
  return { type, value };
}

function assertExactKeys(actual: string[], expected: string[], label: string): void {
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    malformed(`${label} has invalid fields`);
  }
}

function isOrdinaryRecord(input: unknown): input is Record<string, unknown> {
  return input !== null
    && typeof input === 'object'
    && Object.getPrototypeOf(input) === Object.prototype;
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
