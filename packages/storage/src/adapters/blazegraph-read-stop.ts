import { randomUUID } from 'node:crypto';
import { prepareSparql, prepareSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { QueryWorkStoppedError, remainingWorkMs } from '../query-work-stop.js';

/**
 * Blazegraph's per-request server-side query deadline. The deployed 2.1.x
 * engine honours this header (`BigdataRDFContext$AbstractQueryTask` reads it
 * via `getQueryTimeout`); `web.xml`'s `queryTimeout` context-param is the
 * global equivalent and ships as `0` — unbounded.
 */
export const MAX_QUERY_MILLIS_HEADER = 'X-BIGDATA-MAX-QUERY-MILLIS';

/**
 * Multiplier applied to the client deadline to derive the server-side bound.
 *
 * This is deliberately > 1: the server deadline must be WIDER than the
 * client's, never tighter. Two reasons, and the second is a correctness trap:
 *
 * 1. The problem being solved is *abandoned* work. When the client aborts at
 *    its deadline the HTTP connection goes away but Blazegraph keeps executing
 *    the query — observed on mainnet running 10-32+ minutes past a 30s client
 *    abort, with `queryErrorCount = 0` across 20,953 queries confirming the
 *    server never cancelled anything. A handful of these saturate a core. Any
 *    finite server bound fixes that; it does not need to be tight.
 *
 * 2. A tight bound introduces silent data loss. Blazegraph commits `200 OK`
 *    and begins streaming before the deadline fires, then appends its error
 *    into the already-committed body. A CONSTRUCT killed mid-stream therefore
 *    returns a SHORT BUT STRUCTURALLY VALID n-quads document. Since the client
 *    is still reading at that point, it parses the truncated result as a
 *    complete one — a sync page that looks whole and is not. Keeping the
 *    server bound comfortably above the client deadline means the client
 *    always aborts first, so no caller is ever parsing a truncated body.
 *    (`parseBlazegraphConstructNQuads` in blazegraph.ts is the belt-and-braces
 *    guard for the residual case.)
 *
 * With the 30s default this yields a 120s server bound: orphan lifetime drops
 * from unbounded to at most 2 minutes, while the truncation path stays
 * unreachable.
 */
export const SERVER_QUERY_DEADLINE_FACTOR = 4;

/**
 * A read with a work deadline keeps the same order of deadlines, only closer:
 * the client gives up at the read's own limit, and the server bound is that
 * limit plus this margin, so the client still always aborts first.
 */
const WORK_DEADLINE_SERVER_MARGIN_MS = 1_000;
const CANCEL_REQUEST_TIMEOUT_MS = 5_000;

/** The client deadline of a read: the store's own, or the read's work deadline when sooner. */
export function blazegraphClientDeadlineMs(operationTimeoutMs: number, workDeadline: number | undefined): number {
  const remaining = remainingWorkMs(workDeadline);
  return remaining === undefined ? operationTimeoutMs : Math.min(operationTimeoutMs, remaining);
}

/**
 * Stopping a Blazegraph read with a work deadline.
 *
 * A dropped HTTP connection does not stop Blazegraph's query engine; two things
 * do, both checked against Blazegraph 2.1.6: the header deadline above, and a
 * `cancelQuery` request naming the query's id. The id must be the engine's own,
 * which Blazegraph takes from the `queryId` query hint: the `queryId` URL
 * parameter names only the HTTP task, and cancelling that leaves the engine
 * running. So the read carries the hint, and when its caller leaves, or its
 * limit passes, the query is cancelled by that id. A query the hint cannot be
 * added to safely (no top-level WHERE group, a CONSTRUCT WHERE short form, a
 * group that is a sub-select) still stops at its server deadline.
 */
export class BlazegraphReadStop {
  readonly sparql: string;
  readonly queryId: string | null;
  readonly serverDeadlineMs: number;
  #dispatched = false;
  #done = false;
  #detach: (() => void) | null = null;

  constructor(
    private readonly endpoint: string,
    sparql: string,
    operationTimeoutMs: number,
    private readonly workDeadline: number,
  ) {
    const hinted = withBlazegraphQueryId(sparql);
    this.sparql = hinted?.sparql ?? sparql;
    this.queryId = hinted?.queryId ?? null;
    this.serverDeadlineMs = Math.min(
      operationTimeoutMs * SERVER_QUERY_DEADLINE_FACTOR,
      blazegraphClientDeadlineMs(operationTimeoutMs, workDeadline) + WORK_DEADLINE_SERVER_MARGIN_MS,
    );
  }

  /** The request is being sent under `signal`: cancel the query if it aborts first. */
  dispatched(signal: AbortSignal): void {
    // An aborted signal sends nothing, so there is nothing to cancel.
    if (signal.aborted) return;
    this.#dispatched = true;
    if (this.queryId === null || this.#detach) return;
    const cancel = () => {
      this.#detach = null;
      if (!this.#done) void cancelBlazegraphQuery(this.endpoint, this.queryId!);
    };
    signal.addEventListener('abort', cancel, { once: true });
    this.#detach = () => signal.removeEventListener('abort', cancel);
  }

  /** The read settled. A later abort cancels nothing. */
  done(): void {
    this.#done = true;
    this.#detach?.();
    this.#detach = null;
  }

  /** The error a stopped read rejects with: its caller left or its limit passed. */
  failed(error: unknown, callerSignal: AbortSignal | undefined): unknown {
    const ended = callerSignal?.aborted === true || performance.now() >= this.workDeadline;
    if (!ended) return error;
    return new QueryWorkStoppedError('blazegraph', this.#dispatched ? 'stopped' : 'not_started', callerSignal?.aborted ? callerSignal.reason : error);
  }
}

const HINT = '<http://www.bigdata.com/queryHints#Query> <http://www.bigdata.com/queryHints#queryId>';

/** Add an engine query id as a `hint:Query` triple at the start of the top-level WHERE group. */
export function withBlazegraphQueryId(sparql: string, queryId = randomUUID()): { sparql: string; queryId: string } | null {
  if (/queryId/i.test(sparql)) return null;
  const prepared = prepareSparql(sparql);
  if (prepared.status !== 'valid') return null;
  const query = prepareSparqlQuery(prepared);
  const { where } = query;
  if (!where || !query.structure.braces.balanced) return null;
  const { tokens } = prepared;
  const operationIndex = prepared.prologue.endTokenIndex;
  // CONSTRUCT WHERE { … } uses its pattern as the template: a hint there would be output.
  const afterOperation = tokens[operationIndex + 1];
  if (query.operation === 'CONSTRUCT' && !(afterOperation?.kind === 'symbol' && afterOperation.logicalValue === '{')) return null;
  // A group that holds a sub-select may hold nothing else.
  const first = tokens[where.openingTokenIndex + 1];
  if (first?.kind === 'word' && first.upper === 'SELECT') return null;
  return {
    queryId,
    sparql: `${sparql.slice(0, where.openEnd)} ${HINT} "${queryId}" . ${sparql.slice(where.openEnd)}`,
  };
}

/** Ask Blazegraph to cancel a running query; one that is not running yet is cancelled when it starts. */
export async function cancelBlazegraphQuery(endpoint: string, queryId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CANCEL_REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await fetch(`${endpoint}?cancelQuery&queryId=${encodeURIComponent(queryId)}`, {
      method: 'POST', signal: controller.signal,
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
