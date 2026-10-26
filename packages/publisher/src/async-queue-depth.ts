import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import {
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_JOURNAL_GRAPH_URI,
  JOURNAL_ENTRY_TYPE,
  RDF_TYPE_PREDICATE,
} from './async-lift-control-plane.js';
import {
  DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
  PROMOTE_STATE,
  expectBindings,
  parseIntegerLiteral,
} from './async-promote-queue-utils.js';
import { PROMOTE_JOB_STATES, type PromoteJobState } from './async-promote-queue-types.js';
import { LIFT_JOB_STATES, type LiftJobState } from './lift-job-states.js';

/**
 * Queue depth for the `async_admission_usage` line (OT-RFC-73 P1b): one `COUNT ... GROUP BY`
 * per queue, read without the share mutex or the claim lock, so a reading never waits behind
 * (or delays) queue work. Each runs on the background lane under its own `publisher.queueUsage.*`
 * source, apart from the queue's own sources, so a monitoring read the scheduler refuses is not
 * counted as a queue rejection. The monitoring cadence is five minutes, so a reading may trail
 * a transition in flight.
 */

export interface AsyncQueueDepthOptions {
  /** The queue's control graph. Defaults to the daemon's fixed graph. */
  graphUri?: string;
  /** The publisher admission journal graph. Defaults to the daemon's fixed graph. */
  journalGraphUri?: string;
  /** Cancels a reading that outlives its deadline. */
  signal?: AbortSignal;
}

type QueryableStore = Pick<TripleStore, 'query'>;

function readOptions(source: string, signal: AbortSignal | undefined): QueryOptions {
  return signal ? { source, priority: 'background', signal } : { source, priority: 'background' };
}

function zeroes<S extends string>(states: readonly S[]): Record<S, number> {
  return Object.fromEntries(states.map((state) => [state, 0])) as Record<S, number>;
}

/** A state is stored as a JSON string literal, such as `"queued"`. */
function stateName(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}

async function countByState<S extends string>(
  store: QueryableStore,
  states: readonly S[],
  predicate: string,
  graphUri: string,
  options: QueryOptions,
): Promise<Record<S, number>> {
  const result = await store.query(
    `SELECT ?state (COUNT(?job) AS ?n) WHERE { GRAPH <${graphUri}> { ?job <${predicate}> ?state } } GROUP BY ?state`,
    options,
  );
  const counts = zeroes(states);
  for (const row of expectBindings(result)) {
    const state = stateName(row['state'] ?? '');
    // A state this build does not know (a newer or older format) is not a queue state to report.
    if ((states as readonly string[]).includes(state)) counts[state as S] = parseIntegerLiteral(row['n'] ?? '');
  }
  return counts;
}

/** Share jobs per state; every state is present, with 0 when none. */
export async function readShareQueueDepth(
  store: QueryableStore,
  options: AsyncQueueDepthOptions = {},
): Promise<Record<PromoteJobState, number>> {
  return countByState(
    store,
    PROMOTE_JOB_STATES,
    PROMOTE_STATE,
    options.graphUri ?? DEFAULT_PROMOTE_CONTROL_GRAPH_URI,
    readOptions('publisher.queueUsage.share', options.signal),
  );
}

/** Publisher jobs per state; every state is present, with 0 when none. `accepted` is the unclaimed backlog. */
export async function readLiftQueueDepth(
  store: QueryableStore,
  options: AsyncQueueDepthOptions = {},
): Promise<Record<LiftJobState, number>> {
  return countByState(
    store,
    LIFT_JOB_STATES,
    CONTROL_STATUS,
    options.graphUri ?? DEFAULT_CONTROL_GRAPH_URI,
    readOptions('publisher.queueUsage.lift', options.signal),
  );
}

/** Entries in the append-only publisher admission journal, which outlives the jobs it describes. */
export async function readLiftJournalEntryCount(
  store: QueryableStore,
  options: AsyncQueueDepthOptions = {},
): Promise<number> {
  const result = await store.query(
    `SELECT (COUNT(?entry) AS ?n) WHERE { GRAPH <${options.journalGraphUri ?? DEFAULT_JOURNAL_GRAPH_URI}> `
      + `{ ?entry <${RDF_TYPE_PREDICATE}> <${JOURNAL_ENTRY_TYPE}> } }`,
    readOptions('publisher.queueUsage.liftJournal', options.signal),
  );
  const raw = expectBindings(result)[0]?.['n'];
  return raw === undefined ? 0 : parseIntegerLiteral(raw);
}
