import {
  assertSafeIri,
  assertSafeRdfTerm,
  isSafeIri,
} from '@origintrail-official/dkg-core';
import {
  SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES,
  SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES,
  SYSTEM_RECORD_MAX_OWNED_SUBJECTS,
} from '@origintrail-official/dkg-core/system-record-v1';
import type { Quad } from './triple-store.js';
import { compareSystemRecordUtf8V1 } from './system-record-utf8-order-v1-internal.js';
import {
  SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_PREDICATES,
} from './system-record-rdf-schema-v1-internal.js';
import {
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
} from './internal-graph-policy.js';
import {
  assertAuthenticSystemRecordActiveReplacementCompleteV1,
  type SystemRecordActiveReplacementCompleteV1,
} from './system-record-next-state-v1-internal.js';

export interface SystemRecordConditionalApplyUpdateV1 {
  readonly sparql: string;
  readonly requestBytes: number;
  readonly subjectUnion: readonly string[];
}

export type SystemRecordSparqlBuilderChargeV1 = (retainedBytes: number) => void;

/** Linear UTF-8 merge of two already canonical subject tables. */
export function mergeSystemRecordOwnedSubjectsV1(
  previous: readonly string[],
  next: readonly string[],
): readonly string[] {
  const left = snapshotCanonicalSubjects(previous, 'previous owned-subject table');
  const right = snapshotCanonicalSubjects(next, 'next owned-subject table');
  const merged: string[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length || rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    let selected: string;
    if (leftValue === undefined) {
      selected = rightValue;
      rightIndex += 1;
    } else if (rightValue === undefined) {
      selected = leftValue;
      leftIndex += 1;
    } else {
      const order = compareUtf8(leftValue, rightValue);
      if (order < 0) {
        selected = leftValue;
        leftIndex += 1;
      } else if (order > 0) {
        selected = rightValue;
        rightIndex += 1;
      } else {
        selected = leftValue;
        leftIndex += 1;
        rightIndex += 1;
      }
    }
    if (merged.length >= SYSTEM_RECORD_MAX_OWNED_SUBJECTS) {
      throw new Error('system-record prior/next subject union exceeds 2,048 subjects');
    }
    merged.push(selected);
  }
  return Object.freeze(merged);
}

/** Build one SPARQL Modify; a CAS miss gates both DELETE and INSERT. */
export function buildSystemRecordConditionalApplyUpdateV1(
  raw: SystemRecordActiveReplacementCompleteV1,
  replaceBuilderCharge?: SystemRecordSparqlBuilderChargeV1,
): SystemRecordConditionalApplyUpdateV1 {
  assertAuthenticSystemRecordActiveReplacementCompleteV1(raw);
  const projectionGraph = assertProjectionGraph(raw.projectionGraph);
  // The transition factory is the sole minter of this WeakSet-authentic,
  // deeply frozen derivation. Re-copying its maximum 10,000-row projection here
  // would create a second object graph inside the 12 MiB atomic lease without
  // adding a trust boundary.
  const priorSubjects = raw.priorSubjects;
  const nextSubjects = raw.nextSubjects;
  const subjectUnion = mergeSystemRecordOwnedSubjectsV1(priorSubjects, nextSubjects);
  if (subjectUnion.length < 1) throw new Error('active materialization requires an owned subject');
  const oldReserved = raw.previousReservedQuads;
  const nextReserved = raw.nextReservedQuads;
  const absent = raw.requiredAbsentReservedSubjects;
  const projection = raw.nextProjectionQuads;
  const guards = raw.rootClaimGuards;

  const oldBySubject = groupBySubject(oldReserved);
  for (const subject of absent) {
    if (oldBySubject.has(subject)) {
      throw new Error('one reserved subject cannot be expected present and absent');
    }
  }

  const emit = (writer: SparqlWriterV1): void => {
    writer.add('DELETE {\n');
    writer.add('  GRAPH ');
    emitIri(writer, projectionGraph);
    writer.add(' { ?deleteProjectionSubject ?deleteProjectionPredicate ?deleteProjectionObject . }\n');
    writer.add('  GRAPH ');
    emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
    writer.add(' { ?deleteReservedSubject ?deleteReservedPredicate ?deleteReservedObject . }\n');
    writer.add('}\nINSERT {\n');
    writer.add('  GRAPH ');
    emitIri(writer, projectionGraph);
    writer.add(' { ?insertProjectionSubject ?insertProjectionPredicate ?insertProjectionObject . }\n');
    writer.add('  GRAPH ');
    emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
    writer.add(' { ?insertReservedSubject ?insertReservedPredicate ?insertReservedObject . }\n');
    writer.add('}\nWHERE {\n');
    for (const quad of oldReserved) emitGraphQuad(writer, quad, '  ');
    for (const [subject, quads] of oldBySubject) {
      writer.add('  FILTER NOT EXISTS { GRAPH ');
      emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
      writer.add(' { ');
      emitIri(writer, subject);
      writer.add(' ?unexpectedPredicate ?unexpectedObject . FILTER(!(');
      for (const [index, quad] of quads.entries()) {
        if (index > 0) writer.add(' || ');
        writer.add('(?unexpectedPredicate = ');
        emitIri(writer, quad.predicate);
        writer.add(' && sameTerm(?unexpectedObject, ');
        emitObject(writer, quad.object);
        writer.add('))');
      }
      writer.add(')) } }\n');
    }
    for (const subject of absent) {
      writer.add('  FILTER NOT EXISTS { GRAPH ');
      emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
      writer.add(' { ');
      emitIri(writer, subject);
      writer.add(' ?absentPredicate ?absentObject . } }\n');
    }
    for (const guard of guards) {
      writer.add('  FILTER NOT EXISTS { GRAPH ');
      emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
      writer.add(' { ');
      emitIri(writer, guard.claimSubject);
      writer.add(' ');
      emitIri(writer, SYSTEM_RECORD_V1_PREDICATES.claimedBy);
      writer.add(' ?rootOwner . FILTER(?rootOwner != ');
      emitIri(writer, guard.recordSubject);
      writer.add(') } }\n');
    }
    // Four disjoint branches prevent a cross product between prior rows and inserts.
    writer.add('  {\n');
    writer.add('    VALUES ?deleteProjectionSubject {');
    for (const subject of subjectUnion) {
      writer.add(' ');
      emitIri(writer, subject);
    }
    writer.add(' }\n');
    writer.add('    GRAPH ');
    emitIri(writer, projectionGraph);
    writer.add(' { ?deleteProjectionSubject ?deleteProjectionPredicate ?deleteProjectionObject . }\n');
    writer.add('  }\n');
    if (oldReserved.length > 0) {
      writer.add('  UNION {\n');
      writer.add('    VALUES (?deleteReservedSubject ?deleteReservedPredicate ?deleteReservedObject) {\n');
      for (const quad of oldReserved) emitQuadTuple(writer, quad, '      ');
      writer.add('    }\n');
      writer.add('    GRAPH ');
      emitIri(writer, SYSTEM_RECORD_V1_STATE_GRAPH);
      writer.add(' { ?deleteReservedSubject ?deleteReservedPredicate ?deleteReservedObject . }\n');
      writer.add('  }\n');
    }
    if (projection.length > 0) {
      writer.add('  UNION {\n');
      writer.add('    VALUES (?insertProjectionSubject ?insertProjectionPredicate ?insertProjectionObject) {\n');
      for (const quad of projection) emitQuadTuple(writer, quad, '      ');
      writer.add('    }\n');
      writer.add('  }\n');
    }
    if (nextReserved.length > 0) {
      writer.add('  UNION {\n');
      writer.add('    VALUES (?insertReservedSubject ?insertReservedPredicate ?insertReservedObject) {\n');
      for (const quad of nextReserved) emitQuadTuple(writer, quad, '      ');
      writer.add('    }\n');
      writer.add('  }\n');
    }
    writer.add('}\n');
  };

  const counter = new CountingSparqlWriter();
  emit(counter);
  const writer = new BoundedSparqlWriter(counter.bytes, replaceBuilderCharge);
  emit(writer);
  const sparql = writer.finish();
  return Object.freeze({ sparql, requestBytes: counter.bytes, subjectUnion });
}

interface SparqlWriterV1 {
  add(value: string): void;
}

class CountingSparqlWriter implements SparqlWriterV1 {
  private encodedBytes = 0;

  get bytes(): number { return this.encodedBytes; }

  add(value: string): void {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES - this.encodedBytes) {
      throw new Error('system-record SPARQL request exceeds the 4 MiB bound');
    }
    this.encodedBytes += bytes;
  }
}

class BoundedSparqlWriter {
  private buffer: Buffer | null;
  private offset = 0;

  constructor(
    private readonly encodedBytes: number,
    private readonly replaceCharge?: SystemRecordSparqlBuilderChargeV1,
  ) {
    // One exact encoded buffer and the final two-byte-weighted JS string coexist
    // during conversion. There is no fragments array or join-time second string.
    const peakBytes = encodedBytes * 3;
    if (peakBytes > SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES) {
      throw new Error('system-record SPARQL builder exceeds the retained-byte bound');
    }
    replaceCharge?.(peakBytes);
    this.buffer = Buffer.allocUnsafe(encodedBytes);
  }

  add(value: string): void {
    const bytes = Buffer.byteLength(value, 'utf8');
    if (this.buffer === null || bytes > this.encodedBytes - this.offset) {
      throw new Error('system-record SPARQL request accounting mismatch');
    }
    const written = this.buffer.write(value, this.offset, bytes, 'utf8');
    if (written !== bytes) throw new Error('system-record SPARQL request accounting mismatch');
    this.offset += written;
  }

  finish(): string {
    if (this.buffer === null || this.offset !== this.encodedBytes) {
      throw new Error('system-record SPARQL request accounting mismatch');
    }
    const result = this.buffer.toString('utf8');
    this.buffer = null;
    this.replaceCharge?.(this.encodedBytes * 2);
    if (Buffer.byteLength(result, 'utf8') !== this.encodedBytes) {
      throw new Error('system-record SPARQL request accounting mismatch');
    }
    return result;
  }
}

function snapshotCanonicalSubjects(value: unknown, label: string): readonly string[] {
  const values = closedArray(value, SYSTEM_RECORD_MAX_OWNED_SUBJECTS, label);
  const result = values.map((candidate) => {
    if (typeof candidate !== 'string' || !isSafeIri(candidate)) {
      throw new Error(`${label} contains an unsafe IRI`);
    }
    return candidate;
  });
  for (let index = 1; index < result.length; index += 1) {
    if (compareUtf8(result[index - 1], result[index]) >= 0) {
      throw new Error(`${label} must be UTF-8 sorted and duplicate-free`);
    }
  }
  return Object.freeze(result);
}

function groupBySubject(quads: readonly Readonly<Quad>[]): Map<string, readonly Readonly<Quad>[]> {
  const mutable = new Map<string, Readonly<Quad>[]>();
  for (const quad of quads) {
    const rows = mutable.get(quad.subject) ?? [];
    rows.push(quad);
    mutable.set(quad.subject, rows);
  }
  return new Map([...mutable].map(([subject, rows]) => [subject, Object.freeze(rows)]));
}

function assertProjectionGraph(value: string): string {
  if (value !== SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH
      && value !== SYSTEM_RECORD_V1_AUTHORITATIVE_AGENTS_GRAPH) {
    throw new Error('system-record projection graph is not the fixed agents graph');
  }
  return value;
}

function emitIri(writer: SparqlWriterV1, value: string): void {
  assertSafeIri(value);
  writer.add('<');
  writer.add(value);
  writer.add('>');
}

function emitObject(writer: SparqlWriterV1, value: string): void {
  if (value.startsWith('"')) {
    assertSafeRdfTerm(value);
    writer.add(value);
    return;
  }
  emitIri(writer, value);
}

function emitGraphQuad(writer: SparqlWriterV1, quad: Readonly<Quad>, indent: string): void {
  writer.add(indent);
  writer.add('GRAPH ');
  emitIri(writer, quad.graph);
  writer.add(' { ');
  emitIri(writer, quad.subject);
  writer.add(' ');
  emitIri(writer, quad.predicate);
  writer.add(' ');
  emitObject(writer, quad.object);
  writer.add(' . }\n');
}

function emitQuadTuple(writer: SparqlWriterV1, quad: Readonly<Quad>, indent: string): void {
  writer.add(indent);
  writer.add('(');
  emitIri(writer, quad.subject);
  writer.add(' ');
  emitIri(writer, quad.predicate);
  writer.add(' ');
  emitObject(writer, quad.object);
  writer.add(')\n');
}

function closedArray(value: unknown, maxLength: number, label: string): unknown[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(value.length) || value.length > maxLength) {
    throw new Error(`${label} must be a bounded array`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) throw new Error(`${label} must be a closed dense array`);
  const result = new Array<unknown>(value.length);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new Error(`${label} contains a non-index property`);
    }
    const index = Number(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Number.isSafeInteger(index) || index >= value.length || !descriptor?.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new Error(`${label} must contain enumerable data elements`);
    }
    result[index] = descriptor.value;
  }
  return result;
}

function compareUtf8(left: string, right: string): number {
  return compareSystemRecordUtf8V1(left, right);
}
