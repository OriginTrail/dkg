// SPDX-License-Identifier: Apache-2.0

/**
 * Read-graph state: one row per read graph, kept in the state graph of its
 * context graph's read-graph partition (`readGraphStateGraphIri`), with its state,
 * a generation, the membership-rule version and the builder version.
 *
 *   absent → building → ready → dirty → repairing | rebuilding → ready
 *
 * Every transition is a compare-and-set on the stored row, sent in the same
 * request as the write that causes it. Every transition except publishing
 * `ready` gives the row a new generation, so anything issued for an earlier
 * phase no longer matches: a finished job cannot overwrite a newer dirty mark,
 * and a request left over from before a restart cannot either. Each rebuild or
 * repair operation carries {@link readGraphStateFencePattern} in its own
 * `WHERE`, so a stale operation changes neither data nor state.
 *
 * A generation is never reused for the same read graph: a new row starts at a
 * random generation ({@link newReadGraphGeneration}), so a row that is removed
 * and created again does not admit the operations of its earlier life.
 *
 * Nothing here talks to a store. The statements are single SPARQL UPDATE
 * operations without a trailing `;`, for the layer to place in a request.
 */

import { randomInt } from 'node:crypto';
import {
  READ_GRAPH_SEGMENT,
  assertSafeIri,
  parseReadGraphIri,
  readGraphStateGraphIri,
  sparqlString,
} from '@origintrail-official/dkg-core';
import { parseRdfLiteralTerm } from '@origintrail-official/dkg-rdf-utils';
import { READ_GRAPH_MEMBERSHIP_RULE_VERSION } from './membership.js';

const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/** The states a stored row can have. A read graph without a row is absent. */
export const READ_GRAPH_STATES = Object.freeze(['building', 'ready', 'dirty', 'repairing', 'rebuilding'] as const);
export type ReadGraphState = (typeof READ_GRAPH_STATES)[number];

/**
 * The version of the procedure that builds a read graph's contents, stored
 * with each read graph. Change it when the build changes in a way that makes
 * read graphs built before it wrong; a running release rebuilds any read graph
 * whose builder it does not accept.
 */
export const READ_GRAPH_BUILDER_VERSION = 1;

/** The versions a release builds with, and the builder versions it accepts from earlier builds. */
export interface ReadGraphVersions {
  readonly ruleVersion: number;
  readonly builderVersion: number;
  readonly acceptedBuilderVersions: readonly number[];
}

export const CURRENT_READ_GRAPH_VERSIONS: ReadGraphVersions = Object.freeze({
  ruleVersion: READ_GRAPH_MEMBERSHIP_RULE_VERSION,
  builderVersion: READ_GRAPH_BUILDER_VERSION,
  acceptedBuilderVersions: Object.freeze([READ_GRAPH_BUILDER_VERSION]),
});

/** One stored state row. `readGraph` is the read graph's IRI and the row's subject. */
export interface ReadGraphStateRow {
  readonly readGraph: string;
  readonly state: ReadGraphState;
  readonly generation: number;
  readonly ruleVersion: number;
  readonly builderVersion: number;
}

const ONTOLOGY = 'http://dkg.io/ontology/';

/** The predicates of a state row. */
export const READ_GRAPH_STATE_PREDICATES = Object.freeze({
  state: `${ONTOLOGY}readGraphState`,
  generation: `${ONTOLOGY}readGraphGeneration`,
  ruleVersion: `${ONTOLOGY}readGraphRuleVersion`,
  builderVersion: `${ONTOLOGY}readGraphBuilderVersion`,
} as const);

type RowField = keyof typeof READ_GRAPH_STATE_PREDICATES;
const ROW_FIELDS = Object.keys(READ_GRAPH_STATE_PREDICATES) as RowField[];

/** Restricts `?stateGraph` to the state graph of some context graph's read-graph partition (`readGraphStateGraphIri`). */
const IN_STATE_GRAPH = 'FILTER(STRSTARTS(STR(?stateGraph), "did:dkg:context-graph:") && '
  + `STRENDS(STR(?stateGraph), ${sparqlString(`/${READ_GRAPH_SEGMENT}/state`)}))`;

/** The largest generation: transitions add one, and a generation must stay a safe integer. */
export const MAX_READ_GRAPH_GENERATION = Number.MAX_SAFE_INTEGER;
const INITIAL_GENERATION_BOUND = 2 ** 48;

/** A random first generation for a new row, far below {@link MAX_READ_GRAPH_GENERATION}. */
export function newReadGraphGeneration(): number {
  return randomInt(1, INITIAL_GENERATION_BOUND);
}

/** A change of state. `create` and `start-rebuild` stamp the versions the row is built under. */
export type ReadGraphTransition =
  | { readonly kind: 'create'; readonly readGraph: string; readonly generation: number; readonly versions: ReadGraphVersions }
  | { readonly kind: 'mark-dirty' }
  | { readonly kind: 'start-repair'; readonly versions: ReadGraphVersions }
  | { readonly kind: 'start-rebuild'; readonly versions: ReadGraphVersions }
  | { readonly kind: 'publish-ready' }
  | { readonly kind: 'remove' };

export class ReadGraphTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadGraphTransitionError';
  }
}

/**
 * The row after `transition`, or `undefined` for an absent read graph. Throws
 * {@link ReadGraphTransitionError} for a transition the state machine does not
 * allow from `current`.
 *
 * - `create`: absent → building, at the given generation.
 * - `mark-dirty`: any state → dirty. Membership changes, failed checks,
 *   versions the release does not accept, and interrupted work all use it.
 * - `start-repair`: dirty → repairing, only under the current rule and an
 *   accepted builder, because a scoped repair keeps the existing contents.
 * - `start-rebuild`: dirty → rebuilding, stamping the current versions.
 * - `publish-ready`: building, repairing or rebuilding → ready, at the same
 *   generation.
 * - `remove`: any state → absent.
 */
export function nextReadGraphState(
  current: ReadGraphStateRow | undefined,
  transition: ReadGraphTransition,
): ReadGraphStateRow | undefined {
  if (transition.kind === 'create') {
    if (current !== undefined) throw illegal(current, transition);
    return checkedRow({
      readGraph: transition.readGraph,
      state: 'building',
      generation: transition.generation,
      ruleVersion: transition.versions.ruleVersion,
      builderVersion: transition.versions.builderVersion,
    });
  }
  if (current === undefined) throw new ReadGraphTransitionError(`Cannot ${transition.kind} an absent read graph`);
  switch (transition.kind) {
    case 'mark-dirty':
      return { ...current, state: 'dirty', generation: nextGeneration(current) };
    case 'start-repair':
      if (current.state !== 'dirty' || !isReadGraphRowAccepted(current, transition.versions)) throw illegal(current, transition);
      return { ...current, state: 'repairing', generation: nextGeneration(current) };
    case 'start-rebuild':
      if (current.state !== 'dirty') throw illegal(current, transition);
      return {
        ...current,
        state: 'rebuilding',
        generation: nextGeneration(current),
        ruleVersion: transition.versions.ruleVersion,
        builderVersion: transition.versions.builderVersion,
      };
    case 'publish-ready':
      if (current.state === 'ready' || current.state === 'dirty') throw illegal(current, transition);
      return { ...current, state: 'ready' };
    case 'remove':
      return undefined;
  }
}

/** Whether a release with `versions` may serve or repair a read graph with this row's versions. */
export function isReadGraphRowAccepted(row: ReadGraphStateRow, versions: ReadGraphVersions): boolean {
  return row.ruleVersion === versions.ruleVersion && versions.acceptedBuilderVersions.includes(row.builderVersion);
}

/**
 * The generation a merged query may plan with: the row's generation when it
 * is `ready` under versions this release accepts, otherwise `undefined`. A
 * query compares it again after the store answers.
 */
export function servingReadGraphGeneration(
  row: ReadGraphStateRow | undefined,
  versions: ReadGraphVersions = CURRENT_READ_GRAPH_VERSIONS,
): number | undefined {
  return row !== undefined && row.state === 'ready' && isReadGraphRowAccepted(row, versions) ? row.generation : undefined;
}

/**
 * The process-wide copy of the state rows. The daemon holds the authoritative
 * copy while it runs, one for every store object of the process. It records a
 * row before it dispatches the write that commits it, so no new query picks a
 * read graph that the write will dirty.
 */
export interface ReadGraphStateMirror {
  get(readGraph: string): ReadGraphStateRow | undefined;
  set(row: ReadGraphStateRow): void;
  remove(readGraph: string): void;
  rows(): readonly ReadGraphStateRow[];
}

/**
 * The compare-and-set for one transition: one UPDATE operation that changes
 * the stored row from `from` to `to` only when the stored row is exactly
 * `from`, and otherwise changes nothing. `from` undefined creates the row only
 * when the state graph holds none of its fields, so a field left by a damaged
 * row never ends up beside new values; `to` undefined removes it. Only the
 * triples that differ are deleted and inserted, so no triple is both removed
 * and added by the operation.
 */
export function readGraphStateCompareAndSet(
  from: ReadGraphStateRow | undefined,
  to: ReadGraphStateRow | undefined,
): string {
  const row = from ?? to;
  if (row === undefined) throw new ReadGraphTransitionError('A compare-and-set needs a row before or after');
  if (from !== undefined && to !== undefined && from.readGraph !== to.readGraph) {
    throw new ReadGraphTransitionError('A compare-and-set cannot move a row to another read graph');
  }
  const stateGraph = stateGraphOf(row.readGraph);
  if (from === undefined) {
    const created = checkedRow(to!);
    const absent = ROW_FIELDS.map((field) => `  FILTER NOT EXISTS { GRAPH <${stateGraph}> { <${created.readGraph}> `
      + `<${READ_GRAPH_STATE_PREDICATES[field]}> ?existing${field[0]!.toUpperCase()}${field.slice(1)} } }`);
    return `INSERT { GRAPH <${stateGraph}> { ${rowTriples(created, ROW_FIELDS)} } } WHERE {\n${absent.join('\n')}\n}`;
  }
  const before = checkedRow(from);
  const fence = exactRowPattern(before, ROW_FIELDS);
  if (to === undefined) {
    return `DELETE { GRAPH <${stateGraph}> { ${rowTriples(before, ROW_FIELDS)} } } WHERE {\n${fence}\n}`;
  }
  const after = checkedRow(to);
  const changed = ROW_FIELDS.filter((field) => before[field] !== after[field]);
  if (changed.length === 0) throw new ReadGraphTransitionError('A compare-and-set must change the row');
  return `DELETE { GRAPH <${stateGraph}> { ${rowTriples(before, changed)} } }\n`
    + `INSERT { GRAPH <${stateGraph}> { ${rowTriples(after, changed)} } }\n`
    + `WHERE {\n${fence}\n}`;
}

/**
 * The fence of one rebuild, repair or drop operation: a group-pattern fragment
 * that has exactly one solution when the read graph's stored row has exactly
 * this state and generation, and none otherwise. Place it in the operation's
 * own `WHERE`. Its variables start with `?readGraphFence`.
 */
export function readGraphStateFencePattern(readGraph: string, state: ReadGraphState, generation: number): string {
  if (!(READ_GRAPH_STATES as readonly string[]).includes(state)) {
    throw new ReadGraphTransitionError(`Unknown read-graph state: ${String(state)}`);
  }
  checkGeneration(generation);
  return exactValuesPattern(readGraph, [['state', state], ['generation', generation]]);
}

/**
 * Every state row in the store, in any context graph's state graph. A row is
 * found by any of its fields, and every field is optional, so a damaged row is
 * still found, one that has lost its state included. Rows are read with
 * {@link parseReadGraphStateRows}.
 */
export function readGraphStateRowsQuery(): string {
  return rowsQuery('');
}

/**
 * The row of one read graph, read as {@link readGraphStateRowsQuery} reads
 * every row: by any of its fields, in any context graph's state graph, so a
 * damaged or misplaced copy still reads as damaged. Read the answer with
 * {@link parseReadGraphStateRows}. With the read graph bound, an engine
 * answers from an index.
 */
export function readGraphStateRowQuery(readGraph: string): string {
  stateGraphOf(readGraph);
  return rowsQuery(`VALUES ?readGraph { <${assertSafeIri(readGraph)}> }\n  `);
}

/**
 * The start-up mark of a release that maintains read graphs: every listed
 * read graph's row, in whatever state it is stored, gets the next generation
 * and the state `dirty`. One request of two operations, with no condition on
 * the stored state or generation, so an operation that an earlier process
 * left in flight is fenced out even when it lands between the lookup of the
 * rows and this request. A damaged row, or one at
 * {@link MAX_READ_GRAPH_GENERATION}, takes {@link readGraphStateReset}
 * instead. Read the rows back afterwards.
 */
export function readGraphStateMarkDirtyAtStart(readGraphs: readonly string[]): string {
  const p = READ_GRAPH_STATE_PREDICATES;
  const dirty = sparqlString('dirty');
  const pairs = [...new Set(readGraphs)].map((readGraph) => `(<${stateGraphOf(readGraph)}> <${assertSafeIri(readGraph)}>)`);
  if (pairs.length === 0) throw new ReadGraphTransitionError('A start-up mark needs at least one read graph');
  // sparql-scan-allow: R2 -- ?stateGraph and ?readGraph are VALUES-bound to the exact pairs found at start
  const listed = `  VALUES (?stateGraph ?readGraph) { ${pairs.join(' ')} }\n`;
  return `DELETE { GRAPH ?stateGraph { ?readGraph <${p.generation}> ?generation } }\n`
    + `INSERT { GRAPH ?stateGraph { ?readGraph <${p.generation}> ?nextGeneration } }\n`
    + `WHERE {\n${listed}  GRAPH ?stateGraph { ?readGraph <${p.generation}> ?generation }\n  BIND(?generation + 1 AS ?nextGeneration)\n};\n`
    + `DELETE { GRAPH ?stateGraph { ?readGraph <${p.state}> ?state } }\n`
    + `INSERT { GRAPH ?stateGraph { ?readGraph <${p.state}> ${dirty} } }\n`
    + `WHERE {\n${listed}  GRAPH ?stateGraph { ?readGraph <${p.state}> ?state }\n  FILTER(!sameTerm(?state, ${dirty}))\n}`;
}

function rowsQuery(selection: string): string {
  const p = READ_GRAPH_STATE_PREDICATES;
  const anyField = ROW_FIELDS.map((field) => `{ ?readGraph <${p[field]}> ?readGraphRowField }`).join(' UNION ');
  return `SELECT DISTINCT ?stateGraph ?readGraph ?state ?generation ?ruleVersion ?builderVersion WHERE {
  ${selection}GRAPH ?stateGraph {
    ${anyField}
    OPTIONAL { ?readGraph <${p.state}> ?state }
    OPTIONAL { ?readGraph <${p.generation}> ?generation }
    OPTIONAL { ?readGraph <${p.ruleVersion}> ?ruleVersion }
    OPTIONAL { ?readGraph <${p.builderVersion}> ?builderVersion }
  }
  ${IN_STATE_GRAPH}
}`;
}

/**
 * The state rows of a {@link readGraphStateRowsQuery} answer. A read graph
 * whose row is damaged (a missing or repeated field, a value out of range, or
 * a row outside its own context graph's state graph) is listed in `damaged`
 * instead; {@link readGraphStateReset} replaces such a row.
 */
export function parseReadGraphStateRows(bindings: readonly Readonly<Record<string, string | undefined>>[]): {
  rows: ReadGraphStateRow[];
  damaged: string[];
} {
  const byReadGraph = new Map<string, Readonly<Record<string, string | undefined>>[]>();
  for (const binding of bindings) {
    const readGraph = binding.readGraph;
    if (readGraph === undefined) continue;
    byReadGraph.set(readGraph, [...(byReadGraph.get(readGraph) ?? []), binding]);
  }
  const rows: ReadGraphStateRow[] = [];
  const damaged: string[] = [];
  for (const [readGraph, found] of byReadGraph) {
    const row = parseRow(readGraph, found);
    if (row) rows.push(row); else damaged.push(readGraph);
  }
  return { rows, damaged };
}

/**
 * Mark every read graph in the store dirty, for a release that recognizes read
 * graphs but does not maintain them: run once at start, before anything else
 * writes. One request of two operations that find the rows with one lookup on
 * the state predicate, in any context graph's state graph. Every row that is
 * not already dirty gets a new generation, then the state `dirty`; a row that
 * is dirty stays as it is. No `ready` mark survives it, a damaged row's
 * included. On a store without state rows it changes nothing.
 */
export function readGraphStateMarkAllDirty(): string {
  const p = READ_GRAPH_STATE_PREDICATES;
  const dirty = sparqlString('dirty');
  return `DELETE { GRAPH ?stateGraph { ?readGraph <${p.generation}> ?generation } }\n`
    + `INSERT { GRAPH ?stateGraph { ?readGraph <${p.generation}> ?nextGeneration } }\n`
    + `WHERE {\n  GRAPH ?stateGraph { ?readGraph <${p.state}> ?state . ?readGraph <${p.generation}> ?generation }\n`
    + `  ${IN_STATE_GRAPH}\n  FILTER(!sameTerm(?state, ${dirty}))\n  BIND(?generation + 1 AS ?nextGeneration)\n};\n`
    + `DELETE { GRAPH ?stateGraph { ?readGraph <${p.state}> ?state } }\n`
    + `INSERT { GRAPH ?stateGraph { ?readGraph <${p.state}> ${dirty} } }\n`
    + `WHERE {\n  GRAPH ?stateGraph { ?readGraph <${p.state}> ?state }\n  ${IN_STATE_GRAPH}\n  FILTER(!sameTerm(?state, ${dirty}))\n}`;
}

/**
 * Mark one read graph dirty from whatever row is stored: two operations, in
 * its context graph's state graph. A row that is not dirty gets a new
 * generation, then the state `dirty`; a dirty row, or none, stays as it is.
 * Unlike a compare-and-set it needs no copy of the stored row, so a mark that
 * may not have landed can be sent again.
 */
export function readGraphStateMarkDirty(readGraph: string): string {
  const p = READ_GRAPH_STATE_PREDICATES;
  const dirty = sparqlString('dirty');
  const stateGraph = stateGraphOf(readGraph);
  const subject = `<${assertSafeIri(readGraph)}>`;
  return `DELETE { GRAPH <${stateGraph}> { ${subject} <${p.generation}> ?generation } }\n`
    + `INSERT { GRAPH <${stateGraph}> { ${subject} <${p.generation}> ?nextGeneration } }\n`
    + `WHERE {\n  GRAPH <${stateGraph}> { ${subject} <${p.state}> ?state . ${subject} <${p.generation}> ?generation }\n`
    + `  FILTER(!sameTerm(?state, ${dirty}))\n  BIND(?generation + 1 AS ?nextGeneration)\n};\n`
    + `DELETE { GRAPH <${stateGraph}> { ${subject} <${p.state}> ?state } }\n`
    + `INSERT { GRAPH <${stateGraph}> { ${subject} <${p.state}> ${dirty} } }\n`
    + `WHERE {\n  GRAPH <${stateGraph}> { ${subject} <${p.state}> ?state }\n  FILTER(!sameTerm(?state, ${dirty}))\n}`;
}

/**
 * Replace a read graph's row, whatever it holds, with `row`: two operations.
 * The first removes the read graph's row fields from every state graph, a
 * misplaced copy in another context graph's included; the second inserts
 * `row` in its own state graph. Unfenced, so it is for start-up, before any
 * work on the read graph, under its lock.
 */
export function readGraphStateReset(row: ReadGraphStateRow): string {
  const checked = checkedRow(row);
  const stateGraph = stateGraphOf(checked.readGraph);
  const fields = ROW_FIELDS.map((field) => `<${READ_GRAPH_STATE_PREDICATES[field]}>`).join(' ');
  return `DELETE { GRAPH ?stateGraph { <${checked.readGraph}> ?readGraphResetPredicate ?readGraphResetValue } } WHERE {\n`
    + `  VALUES ?readGraphResetPredicate { ${fields} }\n`
    + `  GRAPH ?stateGraph { <${checked.readGraph}> ?readGraphResetPredicate ?readGraphResetValue }\n`
    + `  ${IN_STATE_GRAPH}\n};\n`
    + `INSERT DATA { GRAPH <${stateGraph}> { ${rowTriples(checked, ROW_FIELDS)} } }`;
}

function parseRow(readGraph: string, found: readonly Readonly<Record<string, string | undefined>>[]): ReadGraphStateRow | undefined {
  if (!parseReadGraphIri(readGraph)) return undefined;
  const stateGraphs = distinct(found.map((binding) => binding.stateGraph));
  if (stateGraphs.length !== 1 || stateGraphs[0] !== stateGraphOf(readGraph)) return undefined;
  const values = (name: string) => distinct(found.map((binding) => binding[name]));
  const one = (name: string) => {
    const list = values(name);
    return list.length === 1 && list[0] !== undefined ? list[0] : undefined;
  };
  const row = {
    readGraph,
    state: stateValue(one('state')),
    generation: integerValue(one('generation')),
    ruleVersion: integerValue(one('ruleVersion')),
    builderVersion: integerValue(one('builderVersion')),
  };
  if (!(READ_GRAPH_STATES as readonly (string | undefined)[]).includes(row.state)) return undefined;
  if (row.generation === undefined || row.ruleVersion === undefined || row.builderVersion === undefined) return undefined;
  return row as ReadGraphStateRow;
}

/**
 * A binding's value, only in the term forms the row's statements write and
 * match: a plain literal for the state, an `xsd:integer` for the numbers, or
 * the bare lexical form some decoders give. Any other term (a language tag, a
 * string where a number belongs) leaves the row damaged.
 */
function stateValue(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  if (!binding.startsWith('"')) return binding;
  const literal = parseRdfLiteralTerm(binding);
  return literal?.kind === 'plain' ? literal.value : undefined;
}

function integerValue(binding: string | undefined): number | undefined {
  if (binding === undefined) return undefined;
  let lexical = binding;
  if (binding.startsWith('"')) {
    const literal = parseRdfLiteralTerm(binding);
    if (literal?.kind !== 'typed' || literal.datatype !== XSD_INTEGER) return undefined;
    lexical = literal.value;
  }
  if (!/^[1-9][0-9]*$/.test(lexical)) return undefined;
  const parsed = Number(lexical);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function distinct<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function checkedRow(row: ReadGraphStateRow): ReadGraphStateRow {
  if (!parseReadGraphIri(row.readGraph)) throw new ReadGraphTransitionError(`Not a read-graph IRI: ${row.readGraph}`);
  if (!(READ_GRAPH_STATES as readonly string[]).includes(row.state)) {
    throw new ReadGraphTransitionError(`Unknown read-graph state: ${String(row.state)}`);
  }
  checkGeneration(row.generation);
  for (const version of [row.ruleVersion, row.builderVersion]) {
    if (!Number.isSafeInteger(version) || version < 1) throw new ReadGraphTransitionError(`Invalid read-graph version: ${version}`);
  }
  return row;
}

function checkGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ReadGraphTransitionError(`Invalid read-graph generation: ${generation}`);
  }
}

function nextGeneration(row: ReadGraphStateRow): number {
  if (row.generation >= MAX_READ_GRAPH_GENERATION) throw new ReadGraphTransitionError(`Generation exhausted for ${row.readGraph}`);
  return row.generation + 1;
}

function illegal(current: ReadGraphStateRow | undefined, transition: ReadGraphTransition): ReadGraphTransitionError {
  return new ReadGraphTransitionError(`Cannot ${transition.kind} a read graph in state ${current?.state ?? 'absent'}`);
}

function stateGraphOf(readGraph: string): string {
  const key = parseReadGraphIri(readGraph);
  if (!key) throw new ReadGraphTransitionError(`Not a read-graph IRI: ${readGraph}`);
  return assertSafeIri(readGraphStateGraphIri(key.scope.contextGraphId));
}

function term(field: RowField, value: string | number): string {
  return field === 'state' ? sparqlString(String(value)) : String(value);
}

function rowTriples(row: ReadGraphStateRow, fields: readonly RowField[]): string {
  return fields.map((field) => `<${row.readGraph}> <${READ_GRAPH_STATE_PREDICATES[field]}> ${term(field, row[field])} .`).join(' ');
}

/** The stored row has exactly these values for every field of `fields`, and no other value for them. */
function exactRowPattern(row: ReadGraphStateRow, fields: readonly RowField[]): string {
  return exactValuesPattern(row.readGraph, fields.map((field) => [field, row[field]]));
}

function exactValuesPattern(readGraph: string, values: readonly (readonly [RowField, string | number])[]): string {
  const stateGraph = stateGraphOf(readGraph);
  const subject = `<${readGraph}>`;
  const lines = [`  GRAPH <${stateGraph}> { ${values.map(([field, value]) => `${subject} <${READ_GRAPH_STATE_PREDICATES[field]}> ${term(field, value)} .`).join(' ')} }`];
  for (const [field, value] of values) {
    const other = `?readGraphFence${field[0]!.toUpperCase()}${field.slice(1)}`;
    lines.push(`  FILTER NOT EXISTS { GRAPH <${stateGraph}> { ${subject} <${READ_GRAPH_STATE_PREDICATES[field]}> ${other} } FILTER(!sameTerm(${other}, ${term(field, value)})) }`);
  }
  return lines.join('\n');
}
