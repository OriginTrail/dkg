import {
  XSD_STRING_DATATYPE,
  parseRdfLiteralTerm,
} from '@origintrail-official/dkg-rdf-utils';
import { isSafeIri } from './sparql-safe.js';
import { isPlainRecord, snapshotExactDataRecord } from './sync-wire-objects.js';

const UTF8 = new TextEncoder();

export type TypedRdfStoreObjectV1 =
  | { readonly kind: 'named-node'; readonly value: string }
  | { readonly kind: 'literal'; readonly value: string; readonly datatypeIri: string };

export interface TypedRdfStoreRowV1 {
  readonly subjectIri: string;
  readonly predicateIri: string;
  readonly graphIri: string;
  readonly object: TypedRdfStoreObjectV1;
}

export interface RenderedRdfStoreRowV1 {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly graph: string;
}

export type TypedRdfStoreRowErrorCodeV1 =
  | 'row-schema'
  | 'row-cardinality'
  | 'row-term'
  | 'row-too-large';

export type TypedRdfStoreRowErrorReasonV1 =
  | Readonly<{ readonly kind: 'invalid-iri'; readonly field: string }>
  | Readonly<{ readonly kind: 'unsupported-literal-datatype'; readonly datatypeIri: string }>
  | Readonly<{ readonly kind: 'invalid-field-set'; readonly context: string }>
  | Readonly<{ readonly kind: 'non-data-property'; readonly field: string }>
  | Readonly<{ readonly kind: 'other' }>;

export class TypedRdfStoreRowErrorV1 extends Error {
  readonly reason: TypedRdfStoreRowErrorReasonV1;

  constructor(
    readonly code: TypedRdfStoreRowErrorCodeV1,
    message: string,
    options: ErrorOptions & { readonly reason?: TypedRdfStoreRowErrorReasonV1 } = {},
  ) {
    super(message, options);
    this.name = 'TypedRdfStoreRowErrorV1';
    this.reason = Object.freeze(options.reason ?? { kind: 'other' });
  }
}

export function typedRdfNamedNodeV1(value: string): TypedRdfStoreObjectV1 {
  if (!isSafeIri(value)) throw new TypedRdfStoreRowErrorV1(
    'row-term',
    'named-node value must be one bare safe IRI',
    { reason: { kind: 'invalid-iri', field: 'named-node value' } },
  );
  return Object.freeze({ kind: 'named-node' as const, value });
}

export function typedRdfLiteralV1(value: string, datatypeIri: string): TypedRdfStoreObjectV1 {
  if (!isSafeIri(datatypeIri)) throw new TypedRdfStoreRowErrorV1(
    'row-term',
    'literal datatype must be one bare safe IRI',
    { reason: { kind: 'invalid-iri', field: 'literal datatype' } },
  );
  return Object.freeze({ kind: 'literal' as const, value, datatypeIri });
}

/**
 * Parse the flattened RDF term returned by a triple-store adapter into the
 * same typed object model used by the canonical renderer.
 */
export function parseRenderedRdfStoreObjectV1(input: unknown): TypedRdfStoreObjectV1 {
  if (typeof input !== 'string') {
    throw new TypedRdfStoreRowErrorV1('row-term', 'rendered RDF object must be a string');
  }
  const literal = parseRdfLiteralTerm(input);
  if (literal?.kind === 'plain') {
    return typedRdfLiteralV1(literal.value, XSD_STRING_DATATYPE);
  }
  if (literal?.kind === 'typed') {
    return typedRdfLiteralV1(literal.value, literal.datatype);
  }
  if (literal?.kind === 'language') {
    throw new TypedRdfStoreRowErrorV1(
      'row-term',
      'typed RDF store objects cannot carry a language tag',
    );
  }
  if (isSafeIri(input)) return typedRdfNamedNodeV1(input);
  throw new TypedRdfStoreRowErrorV1('row-term', 'rendered RDF object is not an exact RDF term');
}

export function snapshotTypedRdfStoreRowV1(input: unknown): TypedRdfStoreRowV1 {
  const row = snapshotClosed(input, ['graphIri', 'object', 'predicateIri', 'subjectIri'], 'typed RDF store row');
  for (const key of ['subjectIri', 'predicateIri', 'graphIri'] as const) {
    if (typeof row[key] !== 'string') {
      throw new TypedRdfStoreRowErrorV1('row-schema', `${key} must be a string`);
    }
    if (!isSafeIri(row[key])) {
      throw new TypedRdfStoreRowErrorV1(
        'row-term',
        `${key} must be one bare safe IRI`,
        { reason: { kind: 'invalid-iri', field: key } },
      );
    }
  }
  if (!isPlainRecord(row.object)) {
    throw new TypedRdfStoreRowErrorV1('row-schema', 'typed RDF store object must be a plain object');
  }
  const kind = ownDataProperty(row.object, 'kind');
  if (kind === 'named-node') {
    const object = snapshotClosed(row.object, ['kind', 'value'], 'typed RDF named-node');
    if (typeof object.value !== 'string') {
      throw new TypedRdfStoreRowErrorV1('row-schema', 'named-node value must be a string');
    }
    return Object.freeze({
      subjectIri: row.subjectIri as string,
      predicateIri: row.predicateIri as string,
      graphIri: row.graphIri as string,
      object: typedRdfNamedNodeV1(object.value),
    });
  }
  if (kind === 'literal') {
    const object = snapshotClosed(row.object, ['datatypeIri', 'kind', 'value'], 'typed RDF literal');
    if (typeof object.value !== 'string' || typeof object.datatypeIri !== 'string') {
      throw new TypedRdfStoreRowErrorV1('row-schema', 'literal value and datatype must be strings');
    }
    return Object.freeze({
      subjectIri: row.subjectIri as string,
      predicateIri: row.predicateIri as string,
      graphIri: row.graphIri as string,
      object: typedRdfLiteralV1(object.value, object.datatypeIri),
    });
  }
  throw new TypedRdfStoreRowErrorV1('row-schema', 'typed RDF store object has an unsupported kind');
}

export function snapshotDenseTypedRdfStoreRowsV1(
  input: unknown,
  options: Readonly<{
    readonly allowedLengths: readonly number[];
    readonly maxBytes?: number;
  }>,
): readonly TypedRdfStoreRowV1[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    throw new TypedRdfStoreRowErrorV1('row-schema', 'typed RDF rows must be an ordinary Array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length = lengthDescriptor
    && Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
    && Number.isSafeInteger(lengthDescriptor.value)
    ? lengthDescriptor.value as number
    : -1;
  if (!options.allowedLengths.includes(length)) {
    throw new TypedRdfStoreRowErrorV1(
      'row-cardinality',
      `typed RDF rows require ${options.allowedLengths.join(' or ')} rows`,
    );
  }
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== 'string')
    || ownKeys.length !== length + 1
    || !ownKeys.includes('length')
  ) {
    throw new TypedRdfStoreRowErrorV1('row-schema', 'typed RDF rows must be dense and unadorned');
  }
  let totalBytes = 0;
  const rows: TypedRdfStoreRowV1[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new TypedRdfStoreRowErrorV1(
        'row-schema',
        'typed RDF rows must contain enumerable data properties',
      );
    }
    const row = snapshotTypedRdfStoreRowV1(descriptor.value);
    totalBytes += typedRdfStoreRowByteLengthV1(row);
    if (options.maxBytes !== undefined && totalBytes > options.maxBytes) {
      throw new TypedRdfStoreRowErrorV1('row-too-large', 'typed RDF rows exceed the byte limit');
    }
    rows.push(row);
  }
  return Object.freeze(rows);
}

export function renderTypedRdfStoreRowV1(
  input: unknown,
  allowedLiteralDatatypeIris?: ReadonlySet<string>,
): RenderedRdfStoreRowV1 {
  const row = snapshotTypedRdfStoreRowV1(input);
  let object: string;
  if (row.object.kind === 'named-node') {
    object = `<${row.object.value}>`;
  } else {
    if (allowedLiteralDatatypeIris && !allowedLiteralDatatypeIris.has(row.object.datatypeIri)) {
      throw new TypedRdfStoreRowErrorV1(
        'row-term',
        `unsupported literal datatype ${row.object.datatypeIri}`,
        {
          reason: {
            kind: 'unsupported-literal-datatype',
            datatypeIri: row.object.datatypeIri,
          },
        },
      );
    }
    const literal = JSON.stringify(row.object.value);
    object = row.object.datatypeIri === 'http://www.w3.org/2001/XMLSchema#string'
      ? literal
      : `${literal}^^<${row.object.datatypeIri}>`;
  }
  return Object.freeze({
    subject: row.subjectIri,
    predicate: row.predicateIri,
    object,
    graph: row.graphIri,
  });
}

export function sameTypedRdfStoreRowV1(left: TypedRdfStoreRowV1, right: TypedRdfStoreRowV1): boolean {
  if (
    left.subjectIri !== right.subjectIri
    || left.predicateIri !== right.predicateIri
    || left.graphIri !== right.graphIri
    || left.object.kind !== right.object.kind
  ) return false;
  if (left.object.kind === 'named-node' && right.object.kind === 'named-node') {
    return left.object.value === right.object.value;
  }
  return left.object.kind === 'literal'
    && right.object.kind === 'literal'
    && left.object.value === right.object.value
    && left.object.datatypeIri === right.object.datatypeIri;
}

export function typedRdfStoreRowByteLengthV1(row: TypedRdfStoreRowV1): number {
  return UTF8.encode(row.subjectIri).byteLength
    + UTF8.encode(row.predicateIri).byteLength
    + UTF8.encode(row.graphIri).byteLength
    + UTF8.encode(row.object.value).byteLength
    + (row.object.kind === 'literal' ? UTF8.encode(row.object.datatypeIri).byteLength : 0);
}

function snapshotClosed(input: unknown, keys: readonly string[], label: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    throw new TypedRdfStoreRowErrorV1('row-schema', `${label} must be a plain object`);
  }
  try {
    return snapshotExactDataRecord(input, keys, label);
  } catch (cause) {
    throw new TypedRdfStoreRowErrorV1(
      'row-schema',
      `${label} has an invalid field set`,
      { cause, reason: { kind: 'invalid-field-set', context: label } },
    );
  }
}

function ownDataProperty(value: Readonly<Record<string, unknown>>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    throw new TypedRdfStoreRowErrorV1(
      'row-schema',
      `${key} must be an enumerable data property`,
      { reason: { kind: 'non-data-property', field: key } },
    );
  }
  return descriptor.value;
}
