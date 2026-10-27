// SPDX-License-Identifier: Apache-2.0
import {
  CONTROL_ACCEPTED_AT,
  CONTROL_CONTEXT_GRAPH_ID,
  CONTROL_HAS_REQUEST,
  CONTROL_PAYLOAD,
  CONTROL_STATUS,
  CONTROL_SWM_ID,
  integer,
  jobSubject,
  literal,
  parseIntegerLiteral,
} from './async-lift-control-plane.js';
import { expectBindings, projectListedLiftJobs } from './async-lift-publisher-utils.js';
import { countByState } from './async-queue-depth.js';
import { LIFT_JOB_STATES, type LiftJobState } from './lift-job-states.js';
import { LiftJobStoreSelectors, parseInventoryPayload } from './lift-job-store-selectors.js';
import {
  LiftJobPageError,
  compareLiftJobPageKeys,
  decodeLiftJobPageCursor,
  encodeLiftJobPageCursor,
  liftJobPageLimit,
  type LiftJobPage,
  type LiftJobPageKey,
  type LiftJobPageRequest,
} from './lift-job-page.js';

/**
 * OT-RFC-73 P9a: the publisher queue's bounded listing, and its COUNT stats.
 *
 * Neither read holds the claim lock, so both keep the caller's lane (no priority, no control tag), exactly like the
 * complete `list()` they sit beside. The control path is for the calls that hold the claim lock; a client-driven
 * page must not queue behind, or ahead of, the two slots a claim or an admission is waiting for.
 *
 * WHICH JOBS A PAGE HOLDS. `publisherJobReadScope` decides what a context-graph scoped listing may show: a job whose
 * request is a knowledge-asset publish for that graph, and never a raw-lift job, whatever graph its request names
 * (raw lifts are operator-only). The page applies that rule twice:
 *
 *  1. In SPARQL, as a pre-filter that keeps the scan and the rows it sorts small: the job's request subject carries the
 *     graph id and does NOT carry `swmId`. `serializeRequest` is the only writer of those triples and writes them from
 *     the same job as the payload, in the same record: every raw-lift request carries `swmId` (unconditionally), no
 *     publish request does, and both carry `contextGraphId`. The legacy raw-lift payload schema changes the payload,
 *     not these triples; a publish job missing its lifecycle-key index (the legacy rows `ensureVmPublishIntentIndex`
 *     repairs) has the same request triples as an indexed one, so the filter does not look at the index.
 *  2. In code, on the decoded payload, with the very function the complete listing uses (`projectListedLiftJobs`).
 *     Step 2 can only remove a row step 1 let through. It makes a false positive of step 1, which would otherwise show
 *     an operator-only job to a context graph reader, impossible instead of unlikely.
 *
 * A page therefore equals the complete listing's answer when step 1 never rejects a job step 2 would keep. That is the
 * claim `async-lift-list-page-equivalence.test.ts` checks against `list()`: over a mixed inventory (indexed and
 * un-indexed publish jobs, current and legacy raw lifts, equal acceptance times, every state) for every status and
 * graph filter and several page sizes, and as a property over random inventories.
 *
 * Narrowings, all for rows `serializeJob` cannot produce: a job subject that is not `urn:dkg:publisher:lift-job:<id>`
 * is not part of the key order and is left out of every page; a job missing its `status`, `acceptedAt` or `payload`
 * triple is not listed (the complete listing needs the first and last); a request that names its graph only in the
 * payload is not found by a graph-scoped page. The COUNT tallies status triples and so counts a row whose payload no
 * longer decodes, which `list()` skips.
 *
 * ORDER. The key is (`acceptedAt`, subject IRI), and the subject IRI orders like the job id because every subject
 * shares one prefix. The store sorts and applies the cursor; the code re-checks every page against the cursor and
 * against itself with the same comparator the cursor uses, and refuses a page whose order the store got wrong
 * (`unordered_page`) rather than hand out a cursor that skips or repeats jobs.
 */

/** Source labels. The unlocked rows of the tagging table: they resolve to the caller's lane. */
export const LIFT_JOB_PAGE_SOURCE = 'publisher.asyncLift.listPage';
export const LIFT_JOB_STATS_SOURCE = 'publisher.asyncLift.stats';

const SUBJECT_PREFIX = jobSubject('');

export interface LiftJobPageQueryParams {
  readonly status?: LiftJobState;
  readonly contextGraphId?: string;
  /** Rows strictly after this position. */
  readonly after?: LiftJobPageKey;
  /** Rows to return. The query asks for one more, to learn whether the page is the last. */
  readonly limit: number;
}

/**
 * The page query. An inner SELECT finds the keys of the page (filter, order, `LIMIT limit + 1`); the payloads are
 * joined on only for those rows. Keyset: no `OFFSET`, so a deep page costs the same as the first. The scan is
 * proportional to the jobs that match the filters, not to the page.
 */
export function buildLiftJobPageQuery(graphUri: string, params: LiftJobPageQueryParams): string {
  const { status, contextGraphId, after, limit } = params;
  const conditions: string[] = [`FILTER (STRSTARTS(STR(?job), ${literal(SUBJECT_PREFIX)}))`];
  if (status !== undefined) conditions.push(`FILTER (?status = ${literal(status)})`);
  if (contextGraphId !== undefined) {
    conditions.push(
      `?job <${CONTROL_HAS_REQUEST}> ?request . ?request <${CONTROL_CONTEXT_GRAPH_ID}> ${literal(contextGraphId)} .`,
      `FILTER NOT EXISTS { ?request <${CONTROL_SWM_ID}> ?swmId }`,
    );
  }
  if (after !== undefined) {
    conditions.push(
      `FILTER (?acceptedAt > ${integer(after.acceptedAt)} || (?acceptedAt = ${integer(after.acceptedAt)} && STR(?job) > ${literal(jobSubject(after.jobId))}))`,
    );
  }
  return `SELECT ?job ?acceptedAt ?payload WHERE {
  { SELECT ?job ?acceptedAt WHERE { GRAPH <${graphUri}> {
      ?job <${CONTROL_STATUS}> ?status ; <${CONTROL_ACCEPTED_AT}> ?acceptedAt ; <${CONTROL_PAYLOAD}> ?stored .
      ${conditions.join('\n      ')}
  } } ORDER BY ?acceptedAt STR(?job) LIMIT ${limit + 1} }
  GRAPH <${graphUri}> { ?job <${CONTROL_PAYLOAD}> ?payload }
} ORDER BY ?acceptedAt STR(?job)`;
}

interface PageRow {
  readonly key: LiftJobPageKey;
  readonly payload: string | undefined;
}

/** Selectors plus the bounded reads. The complete reads and the control-path reads are inherited unchanged. */
export class LiftJobListingSelectors extends LiftJobStoreSelectors {
  /** One page of jobs after the cursor, in key order (see the module comment for what it holds and when it is last). */
  async page(request: LiftJobPageRequest = {}): Promise<LiftJobPage> {
    const limit = liftJobPageLimit(request.limit);
    const after = request.cursor === undefined ? undefined : decodeLiftJobPageCursor(request.cursor);
    const result = await this.store.query(
      buildLiftJobPageQuery(this.graphUri, { status: request.status, contextGraphId: request.contextGraphId, after, limit }),
      { source: LIFT_JOB_PAGE_SOURCE },
    );
    const rows = expectBindings(result).map(readPageRow);
    assertKeyOrder(rows, after);
    const more = rows.length > limit;
    const pageRows = more ? rows.slice(0, limit) : rows;
    const jobs = pageRows.flatMap((row) => {
      const job = parseInventoryPayload(row.payload);
      return job === null ? [] : projectListedLiftJobs([job], request.contextGraphId, this.project);
    });
    // The cursor names the last row the page SCANNED, not the last job it returned: skipped rows must not be read twice.
    const nextCursor = more ? encodeLiftJobPageCursor(pageRows[pageRows.length - 1]!.key) : null;
    return { jobs, nextCursor, complete: nextCursor === null };
  }

  /** Jobs per state, from one `COUNT ... GROUP BY`; every state is present, with 0 when none. */
  async stats(): Promise<Record<LiftJobState, number>> {
    return countByState(this.store, LIFT_JOB_STATES, CONTROL_STATUS, this.graphUri, { source: LIFT_JOB_STATS_SOURCE });
  }
}

function readPageRow(row: Record<string, string>): PageRow {
  const subject = row['job'] ?? '';
  if (!subject.startsWith(SUBJECT_PREFIX)) {
    throw new LiftJobPageError('unreadable_row', `the page query returned ${JSON.stringify(subject)}, which is not a job subject`);
  }
  let acceptedAt: number;
  try {
    acceptedAt = parseIntegerLiteral(row['acceptedAt'] ?? '');
  } catch {
    throw new LiftJobPageError('unreadable_row', `job ${subject} has no integer acceptedAt`);
  }
  return { key: { acceptedAt, jobId: subject.slice(SUBJECT_PREFIX.length) }, payload: row['payload'] };
}

/** Every row strictly after the cursor and strictly after the row before it, by the cursor's own comparator. */
function assertKeyOrder(rows: readonly PageRow[], after: LiftJobPageKey | undefined): void {
  let previous = after;
  for (const { key } of rows) {
    if (previous !== undefined && compareLiftJobPageKeys(previous, key) >= 0) {
      throw new LiftJobPageError(
        'unordered_page',
        `the store returned job ${key.jobId} (acceptedAt ${key.acceptedAt}) after ${previous.jobId} (acceptedAt ${previous.acceptedAt})`,
      );
    }
    previous = key;
  }
}
