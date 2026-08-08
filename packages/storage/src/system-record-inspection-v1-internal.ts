import {
  assertSafeIri,
  assertSafeRdfTerm,
  escapeSparqlLiteral,
  isSafeIri,
  tripleContentV10,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_MAX_ATOMIC_DECODED_TERM_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
  SYSTEM_RECORD_MAX_PROJECTION_QUADS,
  SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH,
} from '@origintrail-official/dkg-core/system-record-v1';
import {
  buildBoundedSystemRecordUtf8V1,
  type SystemRecordUtf8WriterV1,
} from './system-record-bounded-utf8-builder-v1-internal.js';
import {
  assertSystemRecordUnicodeScalarStringV1,
  snapshotSystemRecordDataRecordV1,
  snapshotSystemRecordDenseArrayV1,
  snapshotSystemRecordExactDataRecordV1,
} from './system-record-input-guards-v1-internal.js';
import type { Quad } from './triple-store.js';
import { compareSystemRecordUtf8V1 } from './system-record-utf8-order-v1-internal.js';
import { SYSTEM_RECORD_V1_STATE_GRAPH } from './internal-graph-policy.js';
import {
  systemRecordProjectionGraphV1,
  type SystemRecordMaterializationModeV1,
} from './system-record-rdf-schema-v1-internal.js';

export const SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1 = 128;
export const SYSTEM_RECORD_MAX_RESERVED_INSPECTION_RESPONSE_BYTES_V1 =
  SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES;
export const SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1 =
  SYSTEM_RECORD_MAX_PROJECTION_QUADS + 1;

const UTF8 = new TextEncoder();
const TERM_KEYS = new Set(['type', 'value', 'datatype', 'xml:lang']);
const CONTAINER_ENTRY_BYTES_V1 = 128;

export type SystemRecordInspectionQueryBuilderChargeV1 = (retainedBytes: number) => void;

/**
 * Conservative peak while JSON.parse and strict quad projection coexist.
 * The scan is allocation-bounded and runs before JSON.parse, so adversarial
 * arrays cannot allocate an uncharged object graph merely because their
 * encoded body is inside the transport ceiling.
 */
export function estimateSystemRecordInspectionParseBytesV1(
  body: string,
  maxRows: number,
  maxDecodedTermBytes = SYSTEM_RECORD_MAX_ATOMIC_DECODED_TERM_BYTES,
): number {
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const structure = scanJsonStructure(body);
  const possibleRows = Math.min(maxRows, structure.arrayEntries);
  // Input JS text + JSON.parse-produced strings each use at most 2x encoded
  // bytes. Canonical output terms can expand escaping, but remain bounded by
  // the decoded-term ceiling and twice the encoded source size.
  const possibleDecodedBytes = Math.min(maxDecodedTermBytes, bodyBytes * 2);
  const result = bodyBytes * 4
    + possibleDecodedBytes * 3
    + (structure.containers + structure.arrayEntries + structure.objectEntries + possibleRows * 2)
      * CONTAINER_ENTRY_BYTES_V1;
  return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
}

export function retainedSystemRecordInspectionQuadsBytesV1(
  quads: readonly Readonly<Quad>[],
): number {
  let bytes = 0;
  for (const quad of quads) {
    bytes += 2 * (
      Buffer.byteLength(quad.subject, 'utf8')
      + Buffer.byteLength(quad.predicate, 'utf8')
      + Buffer.byteLength(quad.object, 'utf8')
      + Buffer.byteLength(quad.graph, 'utf8')
    ) + CONTAINER_ENTRY_BYTES_V1;
    if (!Number.isSafeInteger(bytes)) return Number.MAX_SAFE_INTEGER;
  }
  return bytes;
}

function scanJsonStructure(body: string): Readonly<{
  containers: number;
  arrayEntries: number;
  objectEntries: number;
}> {
  // Fixed workspace is load-bearing. This scan runs before the accountant can
  // accept JSON.parse's object graph, so an attacker-controlled nesting stack
  // would itself be an uncharged allocation proportional to the response body.
  const kinds = new Uint8Array(SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH);
  const commas = new Uint32Array(SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH);
  const hasValue = new Uint8Array(SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH);
  let depth = 0;
  let containers = 0;
  let arrayEntries = 0;
  let objectEntries = 0;
  let inString = false;
  let escaped = false;
  const closeArray = (index: number): void => {
    if (hasValue[index] !== 0) arrayEntries += commas[index] + 1;
  };
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true;
      else if (code === 0x22) inString = false;
      continue;
    }
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    const current = depth - 1;
    if (current >= 0 && kinds[current] === 1) {
      if (code === 0x2c) commas[current] += 1;
      else if (code !== 0x5d) hasValue[current] = 1;
    } else if (current >= 0 && kinds[current] === 2 && code === 0x3a) {
      objectEntries += 1;
    }
    if (code === 0x22) {
      inString = true;
    } else if (code === 0x5b || code === 0x7b) {
      if (depth >= SYSTEM_RECORD_MAX_SHALLOW_JSON_DEPTH) {
        throw new Error('system-record inspection JSON exceeds its depth bound');
      }
      containers += 1;
      kinds[depth] = code === 0x5b ? 1 : 2;
      commas[depth] = 0;
      hasValue[depth] = 0;
      depth += 1;
    } else if (code === 0x5d || code === 0x7d) {
      if (depth === 0
          || (code === 0x5d && kinds[depth - 1] !== 1)
          || (code === 0x7d && kinds[depth - 1] !== 2)) {
        throw new Error('system-record inspection JSON has mismatched structural delimiters');
      }
      depth -= 1;
      if (code === 0x5d) closeArray(depth);
    }
  }
  for (let index = 0; index < depth; index += 1) {
    if (kinds[index] === 1) closeArray(index);
  }
  return Object.freeze({ containers, arrayEntries, objectEntries });
}

export function buildSystemRecordReservedInspectionQueryV1(
  subjects: readonly string[],
  replaceBuilderCharge?: SystemRecordInspectionQueryBuilderChargeV1,
): string {
  return buildExactSubjectQuery(
    SYSTEM_RECORD_V1_STATE_GRAPH,
    subjects,
    SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1 + 1,
    replaceBuilderCharge,
  );
}

export function buildSystemRecordProjectionInspectionQueryV1(
  mode: SystemRecordMaterializationModeV1,
  subjects: readonly string[],
  replaceBuilderCharge?: SystemRecordInspectionQueryBuilderChargeV1,
): string {
  if (subjects.length < 1 || subjects.length > SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
    throw new Error('system-record projection inspection subject count is outside its bound');
  }
  return buildExactSubjectQuery(
    systemRecordProjectionGraphV1(mode),
    subjects,
    SYSTEM_RECORD_MAX_PROJECTION_INSPECTION_ROWS_V1,
    replaceBuilderCharge,
  );
}

function buildExactSubjectQuery(
  graph: string,
  subjects: readonly string[],
  limit: number,
  replaceBuilderCharge?: SystemRecordInspectionQueryBuilderChargeV1,
): string {
  assertSafeIri(graph);
  const closed = snapshotSubjects(subjects);
  const emit = (writer: SystemRecordUtf8WriterV1): void => {
    writer.add('SELECT ?s ?p ?o WHERE {\n');
    writer.add(`  GRAPH <${graph}> {\n`);
    writer.add('    VALUES ?s { ');
    for (let index = 0; index < closed.length; index += 1) {
      if (index > 0) writer.add(' ');
      writer.add('<');
      writer.add(closed[index]);
      writer.add('>');
    }
    writer.add(' }\n');
    writer.add('    ?s ?p ?o .\n');
    writer.add('  }\n');
    writer.add(`}\nLIMIT ${limit}`);
  };
  return buildBoundedSystemRecordUtf8V1({
    emit,
    maxEncodedBytes: SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
    // Inspection queries are transient request workspace, not retained
    // materialization state. At the 4 MiB encoded boundary the Buffer and JS
    // string coexist at a conservative 3x charge under the 12 MiB atomic lease.
    maxRetainedBytes: SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES,
    label: 'system-record inspection query',
    replaceCharge: replaceBuilderCharge,
  }).value;
}

/** Strictly decode one bounded Oxigraph SPARQL JSON SELECT response. */
export function parseSystemRecordInspectionResponseV1(input: {
  readonly body: string;
  readonly scope: 'reserved' | SystemRecordMaterializationModeV1;
  readonly allowedSubjects: readonly string[];
  readonly maxRows: number;
  readonly maxDecodedTermBytes?: number;
}): readonly Readonly<Quad>[] {
  const rawInput = dataRecord(input, 'system-record inspection input');
  const optional = Object.getOwnPropertyDescriptor(rawInput, 'maxDecodedTermBytes')
    ? ['maxDecodedTermBytes'] as const
    : [] as const;
  const snapshot = exactRecord(
    rawInput,
    ['body', 'scope', 'allowedSubjects', 'maxRows', ...optional],
    'system-record inspection input',
  );
  if (snapshot.scope !== 'reserved' && snapshot.scope !== 'shadow'
      && snapshot.scope !== 'authoritative') {
    throw new Error('system-record inspection scope is invalid');
  }
  const scope = snapshot.scope as 'reserved' | SystemRecordMaterializationModeV1;
  const graph = scope === 'reserved'
    ? SYSTEM_RECORD_V1_STATE_GRAPH
    : systemRecordProjectionGraphV1(scope);
  const bodyCap = scope === 'reserved'
    ? SYSTEM_RECORD_MAX_RESERVED_INSPECTION_RESPONSE_BYTES_V1
    : SYSTEM_RECORD_MAX_ATOMIC_INSPECTION_RESPONSE_BYTES;
  if (typeof snapshot.body !== 'string') {
    throw new Error('system-record inspection body must be text');
  }
  if (Buffer.byteLength(snapshot.body, 'utf8') > bodyCap) {
    throw new Error('system-record inspection response exceeds its encoded byte bound');
  }
  const rowCap = scope === 'reserved'
    ? SYSTEM_RECORD_MAX_RESERVED_INSPECTION_ROWS_V1
    : SYSTEM_RECORD_MAX_PROJECTION_QUADS;
  if (!Number.isSafeInteger(snapshot.maxRows) || (snapshot.maxRows as number) < 0
      || (snapshot.maxRows as number) > rowCap) {
    throw new Error('system-record inspection row bound is invalid');
  }
  const decodedCapValue = snapshot.maxDecodedTermBytes ?? SYSTEM_RECORD_MAX_ATOMIC_DECODED_TERM_BYTES;
  if (typeof decodedCapValue !== 'number' || !Number.isSafeInteger(decodedCapValue)
      || decodedCapValue < 0
      || decodedCapValue > SYSTEM_RECORD_MAX_ATOMIC_DECODED_TERM_BYTES) {
    throw new Error('system-record inspection decoded-term bound is invalid');
  }
  const decodedCap = decodedCapValue;
  const subjects = snapshotSubjects(snapshot.allowedSubjects as readonly string[]);
  const allowed = new Set(subjects);
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.body);
  } catch (cause) {
    throw new Error('system-record inspection response is not JSON', { cause });
  }
  const root = exactRecord(parsed, ['head', 'results'], 'SPARQL result');
  const head = exactRecord(root.head, ['vars'], 'SPARQL result head');
  const variables = closedArray(head.vars, 3, 'SPARQL result variables');
  if (variables.length !== 3 || new Set(variables).size !== 3
      || !['s', 'p', 'o'].every((name) => variables.includes(name))) {
    throw new Error('system-record inspection response has unexpected variables');
  }
  const results = exactRecord(root.results, ['bindings'], 'SPARQL result rows');
  const maxRows = snapshot.maxRows as number;
  const rows = closedArray(results.bindings, maxRows + 1, 'SPARQL result bindings');
  if (rows.length > maxRows) throw new Error('system-record inspection response exceeds its row bound');

  let decodedBytes = 0;
  const quads = rows.map((candidate, index) => {
    const row = exactRecord(candidate, ['s', 'p', 'o'], `SPARQL result row ${index}`);
    const subject = parseUriBinding(row.s, `row ${index} subject`);
    const predicate = parseUriBinding(row.p, `row ${index} predicate`);
    if (!allowed.has(subject)) throw new Error('system-record inspection returned an unrequested subject');
    const object = parseObjectBinding(row.o, `row ${index} object`);
    decodedBytes += UTF8.encode(subject).byteLength
      + UTF8.encode(predicate).byteLength
      + UTF8.encode(object).byteLength;
    if (decodedBytes > decodedCap) {
      throw new Error('system-record inspection response exceeds its decoded-term byte bound');
    }
    return Object.freeze({ subject, predicate, object, graph });
  });
  if (scope === 'reserved') {
    quads.sort(compareTupleQuad);
    for (let index = 1; index < quads.length; index += 1) {
      if (compareTupleQuad(quads[index - 1], quads[index]) === 0) {
        throw new Error('system-record inspection response contains a duplicate quad');
      }
    }
    return Object.freeze(quads);
  }

  // Materialized projection identity is canonical graphless N-Triples bytes,
  // not raw tuple order. Precompute each line once: calling tripleContentV10
  // from an O(n log n) comparator would repeatedly encode the same maximum-size
  // terms and turn a bounded sort into avoidable CPU/allocation churn.
  const projectionOrder = quads.map((quad) => Object.freeze({
    quad,
    line: tripleContentV10(quad.subject, quad.predicate, quad.object),
  }));
  projectionOrder.sort((left, right) => Buffer.compare(left.line, right.line));
  for (let index = 1; index < projectionOrder.length; index += 1) {
    if (Buffer.compare(projectionOrder[index - 1].line, projectionOrder[index].line) === 0) {
      throw new Error('system-record inspection response contains a duplicate quad');
    }
  }
  return Object.freeze(projectionOrder.map(({ quad }) => quad));
}

function snapshotSubjects(value: readonly string[]): readonly string[] {
  const values = closedArray(value, SYSTEM_RECORD_MAX_OWNED_SUBJECTS, 'inspection subjects');
  if (values.length < 1) throw new Error('system-record inspection requires at least one subject');
  const copied = values.map((subject) => {
    if (typeof subject !== 'string' || !isSafeIri(subject)) {
      throw new Error('system-record inspection subject is not a safe IRI');
    }
    return subject;
  });
  copied.sort(compareSystemRecordUtf8V1);
  for (let index = 1; index < copied.length; index += 1) {
    if (copied[index - 1] === copied[index]) {
      throw new Error('system-record inspection subjects must be unique');
    }
  }
  return Object.freeze(copied);
}

function parseUriBinding(value: unknown, label: string): string {
  const binding = exactTerm(value, label);
  if (binding.type !== 'uri' || typeof binding.value !== 'string' || !isSafeIri(binding.value)
      || Object.prototype.hasOwnProperty.call(binding, 'datatype')
      || Object.prototype.hasOwnProperty.call(binding, 'xml:lang')) {
    throw new Error(`${label} must be one safe IRI binding`);
  }
  return binding.value;
}

function parseObjectBinding(value: unknown, label: string): string {
  const binding = exactTerm(value, label);
  if (binding.type === 'uri') {
    if (typeof binding.value !== 'string' || !isSafeIri(binding.value)
        || Object.prototype.hasOwnProperty.call(binding, 'datatype')
        || Object.prototype.hasOwnProperty.call(binding, 'xml:lang')) {
      throw new Error(`${label} URI is invalid`);
    }
    return binding.value;
  }
  if (binding.type !== 'literal' || typeof binding.value !== 'string') {
    throw new Error(`${label} must be an IRI or literal; blank nodes are forbidden`);
  }
  assertUnicodeScalarString(binding.value, `${label} value`);
  const hasDatatype = Object.prototype.hasOwnProperty.call(binding, 'datatype');
  const hasLanguage = Object.prototype.hasOwnProperty.call(binding, 'xml:lang');
  if (hasDatatype && hasLanguage) throw new Error(`${label} cannot have datatype and language`);
  let term = `"${escapeSparqlLiteral(binding.value)}"`;
  if (hasDatatype) {
    if (typeof binding.datatype !== 'string' || !isSafeIri(binding.datatype)) {
      throw new Error(`${label} datatype is invalid`);
    }
    term += `^^<${binding.datatype}>`;
  } else if (hasLanguage) {
    if (typeof binding['xml:lang'] !== 'string'
        || !/^[A-Za-z]+(?:-[A-Za-z0-9]+)*$/.test(binding['xml:lang'])) {
      throw new Error(`${label} language is invalid`);
    }
    term += `@${binding['xml:lang'].toLowerCase()}`;
  }
  assertSafeRdfTerm(term);
  return term;
}

function exactTerm(value: unknown, label: string): Record<string, unknown> {
  const term = dataRecord(value, label);
  const keys = Reflect.ownKeys(term);
  if (keys.some((key) => typeof key !== 'string' || !TERM_KEYS.has(key))
      || !Object.prototype.hasOwnProperty.call(term, 'type')
      || !Object.prototype.hasOwnProperty.call(term, 'value')) {
    throw new Error(`${label} has unknown or missing fields`);
  }
  return term;
}

function exactRecord(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  return snapshotSystemRecordExactDataRecordV1(value, expected, label) as Record<string, unknown>;
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  return snapshotSystemRecordDataRecordV1(value, label) as Record<string, unknown>;
}

function assertUnicodeScalarString(value: string, label: string): void {
  assertSystemRecordUnicodeScalarStringV1(value, label);
}

function closedArray(value: unknown, maxLength: number, label: string): readonly unknown[] {
  return snapshotSystemRecordDenseArrayV1(value, { label, maxLength });
}

function compareTupleQuad(left: Readonly<Quad>, right: Readonly<Quad>): number {
  return compareSystemRecordUtf8V1(left.subject, right.subject)
    || compareSystemRecordUtf8V1(left.predicate, right.predicate)
    || compareSystemRecordUtf8V1(left.object, right.object);
}
