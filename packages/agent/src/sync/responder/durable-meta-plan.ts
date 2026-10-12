// SPDX-License-Identifier: Apache-2.0
import { assertSafeIri, compareCodePoint, contextGraphMetaGraphUri } from '@origintrail-official/dkg-core';
import { StoreResponseTooLargeError, type QueryOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import { estimateStringRowHeapBytes } from '../memory-telemetry.js';
import { isIriTerm } from '../iri-term.js';
import {
  createAssertionNameMatcher,
  durableMetaAssertionNamesQuery,
  durableMetaJoinRequestExclusionExpression,
  durableMetaLiteralValue,
  durableMetaSubjectAdmissionExpression,
  DURABLE_META_ASSERTION_SUBJECT_MARKER,
} from './durable-meta-admission.js';
import { snapshotBudgetError, snapshotResponseByteLimit, storeResponseActualBytes } from './exact-graph-reader.js';
import { compareRows } from './row-serialization.js';
import { createSessionPlanMemo, type SessionPlanMemo } from './session-plan-memo.js';
import { SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE, type SyncRow } from './snapshot-cache.js';
import type { SyncResponderSnapshotBudget } from './snapshot-budget.js';

/**
 * Raw `_meta` rows one plan may describe. The plan is built from one scan of
 * the metadata graph, so this bounds that scan by construction; a graph beyond
 * it is refused before any page is read. Sized from a measured scan (about
 * 1 µs a row on a managed Oxigraph) so that the scan stays an order of
 * magnitude under the store deadline on slower hosts.
 */
export const DURABLE_META_PLAN_MAX_ROWS = 2_000_000;
/** Admitted subjects one plan may retain (scalars only: IRI plus row count). */
export const DURABLE_META_PLAN_MAX_SUBJECTS = 250_000;
/** Retained-heap ceiling of one plan's scalars. */
export const DURABLE_META_PLAN_MAX_BYTES_ESTIMATE = 64 * 1024 * 1024;
/**
 * Ceiling for one subject's rows. A page reads whole subjects (#1788), so a
 * subject larger than this cannot be served as a unit; it can only come from a
 * non-conforming writer, never from descriptors or seals (tens of rows).
 */
export const DURABLE_META_PLAN_SUBJECT_MAX_ROWS = 64_000;
const DURABLE_META_PLAN_SUBJECT_CHUNK = 100;

export interface DurableMetaPlanLimits {
  maxRows: number;
  maxSubjects: number;
  maxBytesEstimate: number;
  subjectMaxRows: number;
}

export interface DurableMetaPlanSubject {
  readonly subject: string;
  readonly rowCount: number;
  /**
   * Admitted only because a promoted assertion names it. Nothing in its own
   * rows decides that, so a page reads it without asking the store again.
   */
  readonly byAssertionName?: true;
}

/**
 * Pagination plan of one durable-meta session whose metadata graph is too
 * large for an in-memory snapshot. It holds scalars only: the admitted IRI
 * subjects in code-point order with their row counts. Payload rows stay in the
 * store and each page reads the subjects it covers by exact lookup, so no page
 * asks the store to sort or skip the graph.
 *
 * Row order is (subject, predicate, object) in code-point order, with the
 * admitted rows of non-IRI subjects after every IRI subject. A plan is
 * immutable; a subject whose row count no longer matches fails the session,
 * because the prefix sums are the cursor.
 *
 * The plan decides which subjects a session walks. It does not decide that
 * their rows may be served: a page asks the store for the rows of its subjects
 * that are admitted at that moment, in the query that reads them, so rows
 * written after the plan are never served on the strength of the plan.
 */
export interface DurableMetaPlan {
  readonly graph: string;
  readonly subjects: readonly DurableMetaPlanSubject[];
  /** `rowsBefore[i]` rows precede `subjects[i]`; the last entry is the IRI row total. */
  readonly rowsBefore: readonly number[];
  /** Admitted rows of non-IRI subjects, served as the tail of the plan. */
  readonly blankNodeRows: number;
  readonly totalRows: number;
  /** Estimated retained heap bytes of the scalars above. */
  readonly bytesEstimate: number;
  /** Admission of `?s` in `?g`, asked again by every page read and by the non-IRI tail read. */
  readonly admissionExpression: string;
}

export type DurableMetaPlanMemo = SessionPlanMemo<DurableMetaPlan>;

/**
 * Session-scoped plan cache for the durable-meta phase. Same contract as the
 * shared-memory meta plan cache: touched on every page, an offset above zero
 * requires the existing plan, and each retained plan is charged to the
 * process-wide responder budget as a control-plane entry.
 */
export function createResponderDurableMetaPlanMemo(
  ttlMs = 10 * 60_000,
  maxEntries = 32,
  budget?: SyncResponderSnapshotBudget,
): DurableMetaPlanMemo {
  return createSessionPlanMemo<DurableMetaPlan>(
    ttlMs,
    maxEntries,
    budget && { budget, phase: 'durable_meta', bytesEstimate: (plan) => plan.bytesEstimate },
  );
}

function storeOptions(signal: AbortSignal | undefined, source: string): QueryOptions {
  return { signal, priority: 'background', source };
}

function sparqlInteger(value: string | undefined): number {
  const match = String(value ?? '').match(/\d+/);
  return match ? Math.floor(Number(match[0])) : 0;
}

async function queryPlanBindings(
  store: TripleStore,
  sparql: string,
  source: string,
  budgetKey: string,
  signal: AbortSignal | undefined,
): Promise<Array<Record<string, string>>> {
  try {
    const result = await store.query(sparql, {
      ...storeOptions(signal, source),
      maxResponseBytes: snapshotResponseByteLimit(DURABLE_META_PLAN_MAX_BYTES_ESTIMATE),
    });
    return result.type === 'bindings' ? result.bindings : [];
  } catch (error) {
    if (!(error instanceof StoreResponseTooLargeError)) throw error;
    throw snapshotBudgetError({
      key: budgetKey,
      reason: 'snapshot_bytes',
      rows: 0,
      bytesEstimate: storeResponseActualBytes(error),
      limit: DURABLE_META_PLAN_MAX_BYTES_ESTIMATE,
    });
  }
}

/**
 * Build the plan with unsorted reads of the metadata graph: a bounded row
 * count, then one row per admitted subject with its row count. Admission is
 * evaluated in the store, once per subject, by exact lookups. Only when the
 * graph holds promoted assertions are their names read as well, with one more
 * pass for the subjects under an assertion path, which are matched against the
 * names in process.
 */
export async function buildDurableMetaPlan(params: {
  store: TripleStore;
  contextGraphId: string;
  registeredSubGraphNames: readonly string[];
  budgetKey: string;
  signal?: AbortSignal;
  /** Primarily injectable for deterministic tests; production uses the constants above. */
  limits?: Partial<DurableMetaPlanLimits>;
}): Promise<DurableMetaPlan> {
  const { store, budgetKey, signal } = params;
  const limits: DurableMetaPlanLimits = {
    maxRows: DURABLE_META_PLAN_MAX_ROWS,
    maxSubjects: DURABLE_META_PLAN_MAX_SUBJECTS,
    maxBytesEstimate: DURABLE_META_PLAN_MAX_BYTES_ESTIMATE,
    subjectMaxRows: DURABLE_META_PLAN_SUBJECT_MAX_ROWS,
    ...params.limits,
  };
  const graph = assertSafeIri(contextGraphMetaGraphUri(params.contextGraphId));
  const admissionExpression = durableMetaSubjectAdmissionExpression(
    params.contextGraphId,
    params.registeredSubGraphNames,
  );
  const refuse = (reason: 'snapshot_rows' | 'snapshot_bytes', actual: number, limit: number) =>
    snapshotBudgetError({
      key: budgetKey,
      reason,
      rows: reason === 'snapshot_rows' ? actual : 0,
      bytesEstimate: reason === 'snapshot_bytes' ? actual : 0,
      limit,
    });

  // The inner LIMIT is the bound: at most maxRows + 1 rows of the one metadata
  // graph are counted, however large the graph is.
  const counted = await queryPlanBindings(store, `
    SELECT (COUNT(*) AS ?count) WHERE {
      { SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } } LIMIT ${limits.maxRows + 1} }
    }
  `, 'sync.responder.countDurableMetaPlanRows', budgetKey, signal);
  const rawRows = sparqlInteger(counted[0]?.['count']);
  if (rawRows > limits.maxRows) throw refuse('snapshot_rows', rawRows, limits.maxRows);

  // One unsorted scan of the one metadata graph, one row per subject. Its bound
  // is twice the row cap, not the cap: the count above already refused a larger
  // graph, so the bound can only bind if the graph doubles between the two
  // reads, and a truncated scan cannot pass for a complete one.
  const subjectRowCounts = `{
        SELECT ?s (COUNT(*) AS ?count) WHERE {
          { SELECT ?s WHERE { GRAPH <${graph}> { ?s ?p ?o } } LIMIT ${2 * limits.maxRows + 1} }
        }
        GROUP BY ?s
      }`;
  const readGroups = async (filter: string, source: string) => {
    const groups = await queryPlanBindings(store, `
    SELECT ?s ?count WHERE {
      VALUES ?g { <${graph}> }
      ${subjectRowCounts}
      FILTER${durableMetaJoinRequestExclusionExpression()}
      FILTER${filter}
    }
    LIMIT ${limits.maxSubjects + 1}
  `, source, budgetKey, signal);
    if (groups.length > limits.maxSubjects) throw refuse('snapshot_rows', groups.length, limits.maxSubjects);
    return groups;
  };

  const subjects: DurableMetaPlanSubject[] = [];
  const planned = new Set<string>();
  let blankNodeRows = 0;
  let bytesEstimate = 0;
  const admit = (subject: string, rowCount: number, byAssertionName: boolean) => {
    if (rowCount > limits.subjectMaxRows) throw refuse('snapshot_rows', rowCount, limits.subjectMaxRows);
    planned.add(subject);
    subjects.push(byAssertionName ? { subject, rowCount, byAssertionName } : { subject, rowCount });
    bytesEstimate += estimateStringRowHeapBytes(subject, '', '', '');
  };
  for (const group of await readGroups(admissionExpression, 'sync.responder.readDurableMetaPlanSubjects')) {
    const subject = group['s'];
    const rowCount = sparqlInteger(group['count']);
    if (!subject || rowCount === 0) continue;
    if (isIriTerm(subject)) admit(subject, rowCount, false);
    else blankNodeRows += rowCount;
  }
  if (blankNodeRows > limits.subjectMaxRows) throw refuse('snapshot_rows', blankNodeRows, limits.subjectMaxRows);

  // The assertion-name rule. Its inputs are read once each and matched here:
  // the names of the assertions that left working memory, and the subjects
  // under an assertion path. A graph without such a name skips the second pass.
  const names = await queryPlanBindings(
    store,
    durableMetaAssertionNamesQuery(graph, limits.maxSubjects + 1),
    'sync.responder.readDurableMetaPlanAssertionNames',
    budgetKey,
    signal,
  );
  if (names.length > limits.maxSubjects) throw refuse('snapshot_rows', names.length, limits.maxSubjects);
  if (names.length > 0) {
    const namedByAssertion = createAssertionNameMatcher(names.map((row) => durableMetaLiteralValue(row['name'])));
    const underAssertionPath = `(isIRI(?s) && CONTAINS(STR(?s), "${DURABLE_META_ASSERTION_SUBJECT_MARKER}"))`;
    for (const group of await readGroups(underAssertionPath, 'sync.responder.readDurableMetaPlanAssertionSubjects')) {
      const subject = group['s'];
      const rowCount = sparqlInteger(group['count']);
      if (!subject || rowCount === 0 || planned.has(subject) || !namedByAssertion(subject)) continue;
      admit(subject, rowCount, true);
    }
    if (subjects.length > limits.maxSubjects) throw refuse('snapshot_rows', subjects.length, limits.maxSubjects);
  }
  if (bytesEstimate > limits.maxBytesEstimate) {
    throw refuse('snapshot_bytes', bytesEstimate, limits.maxBytesEstimate);
  }
  subjects.sort((left, right) => compareCodePoint(left.subject, right.subject));
  const rowsBefore = [0];
  for (const entry of subjects) rowsBefore.push(rowsBefore[rowsBefore.length - 1]! + entry.rowCount);
  return {
    graph,
    subjects,
    rowsBefore,
    blankNodeRows,
    totalRows: rowsBefore[subjects.length]! + blankNodeRows,
    bytesEstimate,
    admissionExpression,
  };
}

function planChanged(plan: DurableMetaPlan, detail: string): Error {
  // "sync session … superseded" is what a requester reads as a session it must
  // restart from offset zero; the next session builds a new plan.
  return new Error(`Durable meta sync session superseded: ${plan.graph} changed while paging (${detail})`);
}

/** Index of the subject that holds row `offset`; `offset` is below the IRI row total. */
function subjectIndexAt(rowsBefore: readonly number[], offset: number): number {
  let low = 0;
  let high = rowsBefore.length - 2;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rowsBefore[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Read every row of the given subjects by exact lookup, in plan order. Each
 * subject comes whole from one query, so a response page never mixes two
 * versions of a subject.
 *
 * The same query decides admission again, once per subject, before it reads
 * the rows: a subject that is no longer admitted comes back without rows. Its
 * row count then differs from the plan and ends the session, exactly as a
 * subject that changed size does. A subject the assertion-name rule admitted
 * is read as it is; that rule does not look at the subject's own rows.
 */
async function readPlanSubjectRows(
  store: TripleStore,
  plan: DurableMetaPlan,
  subjects: readonly DurableMetaPlanSubject[],
  signal: AbortSignal | undefined,
): Promise<SyncRow[]> {
  const bySubject = new Map<string, SyncRow[]>();
  const read = async (group: readonly DurableMetaPlanSubject[], admitted: boolean) => {
    for (let offset = 0; offset < group.length; offset += DURABLE_META_PLAN_SUBJECT_CHUNK) {
      const values = group
        .slice(offset, offset + DURABLE_META_PLAN_SUBJECT_CHUNK)
        .map((entry) => `<${assertSafeIri(entry.subject)}>`)
        .join(' ');
      const selected = admitted
        ? `VALUES ?s { ${values} }`
        : `{ SELECT ?s WHERE { VALUES ?g { <${plan.graph}> } VALUES ?s { ${values} } FILTER${plan.admissionExpression} } }`;
      const result = await store.query(`
      SELECT ?s ?p ?o WHERE {
        ${selected}
        GRAPH <${plan.graph}> { ?s ?p ?o }
      }
    `, {
        ...storeOptions(signal, 'sync.responder.readDurableMetaPlanSubjectRows'),
        maxResponseBytes: snapshotResponseByteLimit(SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE),
      });
      if (result.type !== 'bindings') continue;
      for (const row of result.bindings) {
        const s = row['s'];
        const p = row['p'];
        const o = row['o'];
        if (!s || !p || !o) continue;
        const bucket = bySubject.get(s);
        if (bucket) bucket.push({ s, p, o, g: plan.graph });
        else bySubject.set(s, [{ s, p, o, g: plan.graph }]);
      }
    }
  };
  await read(subjects.filter((entry) => !entry.byAssertionName), false);
  await read(subjects.filter((entry) => entry.byAssertionName), true);
  const rows: SyncRow[] = [];
  for (const entry of subjects) {
    const subjectRows = bySubject.get(entry.subject) ?? [];
    if (subjectRows.length !== entry.rowCount) {
      throw planChanged(
        plan,
        `subject ${entry.subject}: expected ${entry.rowCount} rows, found ${subjectRows.length}`,
      );
    }
    subjectRows.sort(compareRows);
    for (const row of subjectRows) rows.push(row);
  }
  return rows;
}

/**
 * Read the admitted rows of non-IRI subjects. A blank node has no identity an
 * exact lookup could address and its label may differ between queries, so the
 * whole tail is read by one query and its subjects are ordered by content,
 * which does not depend on labels. Conforming writers emit IRI subjects only;
 * this serves metadata a peer ingested before that was enforced (#1921).
 */
async function readPlanBlankNodeRows(
  store: TripleStore,
  plan: DurableMetaPlan,
  signal: AbortSignal | undefined,
): Promise<SyncRow[]> {
  const result = await store.query(`
    SELECT ?s ?p ?o WHERE {
      VALUES ?g { <${plan.graph}> }
      GRAPH ?g { ?s ?p ?o }
      FILTER(isBlank(?s) && ${plan.admissionExpression})
    }
    LIMIT ${plan.blankNodeRows + 1}
  `, {
    ...storeOptions(signal, 'sync.responder.readDurableMetaPlanBlankNodeRows'),
    maxResponseBytes: snapshotResponseByteLimit(SYNC_RESPONDER_SNAPSHOT_BUILD_MAX_BYTES_ESTIMATE),
  });
  const bySubject = new Map<string, SyncRow[]>();
  let found = 0;
  if (result.type === 'bindings') {
    for (const row of result.bindings) {
      const s = row['s'];
      const p = row['p'];
      const o = row['o'];
      if (!s || !p || !o) continue;
      found += 1;
      const bucket = bySubject.get(s);
      if (bucket) bucket.push({ s, p, o, g: plan.graph });
      else bySubject.set(s, [{ s, p, o, g: plan.graph }]);
    }
  }
  if (found !== plan.blankNodeRows) {
    throw planChanged(plan, `non-IRI subjects: expected ${plan.blankNodeRows} rows, found ${found}`);
  }
  const groups = [...bySubject.values()].map((subjectRows) => {
    subjectRows.sort(compareRows);
    return { rows: subjectRows, content: subjectRows.map((row) => `${row.p}\u0000${row.o}`).join('\u0001') };
  });
  groups.sort((left, right) => compareCodePoint(left.content, right.content));
  return groups.flatMap((group) => group.rows);
}

/**
 * The plan's rows from `offset` through the END of the subject that holds row
 * `offset + limit - 1`: whole subjects, so the caller can cut the page on a
 * subject boundary without a second read. When the window runs past the last
 * IRI subject it carries the whole non-IRI tail.
 */
export async function readDurableMetaPlanWindow(
  store: TripleStore,
  plan: DurableMetaPlan,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<SyncRow[]> {
  const start = Math.max(0, Math.floor(offset));
  const wanted = Math.max(0, Math.floor(limit));
  if (wanted === 0 || start >= plan.totalRows) return [];
  const rows: SyncRow[] = [];
  const iriRows = plan.rowsBefore[plan.subjects.length]!;
  if (start < iriRows) {
    let index = subjectIndexAt(plan.rowsBefore, start);
    const windowStart = plan.rowsBefore[index]!;
    const window: DurableMetaPlanSubject[] = [];
    while (index < plan.subjects.length && plan.rowsBefore[index]! < start + wanted) {
      window.push(plan.subjects[index]!);
      index += 1;
    }
    const read = await readPlanSubjectRows(store, plan, window, signal);
    for (let position = start - windowStart; position < read.length; position += 1) {
      rows.push(read[position]!);
    }
  }
  if (rows.length < wanted && plan.blankNodeRows > 0) {
    const tail = await readPlanBlankNodeRows(store, plan, signal);
    for (let position = Math.max(0, start - iriRows); position < tail.length; position += 1) {
      rows.push(tail[position]!);
    }
  }
  return rows;
}
