// SPDX-License-Identifier: Apache-2.0

/**
 * Ask again within seconds for a saved subscription row the startup pass left
 * dormant because its graph's chain name binding could not be read.
 *
 * After a restart the startup pass checks each saved row's read authority
 * under the request deadline. A row with no saved on-chain id needs its
 * graph's name looked up first, and when that lookup does not answer in time
 * the row is left dormant as `authorityUnavailable`
 * (`chain-name-binding-unavailable`). While it is dormant the node holds no
 * gossip subscription for the graph (gossip subscriptions are per graph, not
 * per sub-graph), so writes the other members send by gossip reach it only at
 * its next sync of that graph.
 *
 * Background authority recovery asks such a row again, but on its own pace:
 * a pass every 30 s, one row without an on-chain id per pass, and that one
 * check may wait up to 120 s for the lookup. A row whose first recovery check
 * comes before the lookup answers waits at least another 30 s, and minutes
 * when that check waits on the lookup.
 *
 * Here each such row is asked again on its own as soon as the node has
 * started (as recovery's first pass did), and after an unanswered check again
 * 1, 2, 4, 8 and then every 10 s, for up to ten minutes. When the chain
 * authority source shows it answers again (another row's check is answered,
 * or the node accepts a graph's RFC-64 authority), a row's current pause is
 * cut to 1 s after its last check, unless a wake-up brought that check forward
 * too, so wake-ups at most double the checks. Each check is the startup check
 * (current policy and roster, read live) under its own deadline, and an
 * allowed row is activated through the same transaction background recovery
 * uses. Two checks run at a time, one per row, for at most 32 rows; a row
 * waiting out a pause holds no check slot. A denial, or a graph the chain does
 * not know, is final, as for recovery. A row still unavailable after ten
 * minutes, or one past the row limit, is left to background recovery, which
 * leaves the rows held here alone until then.
 */

import type { ContextGraphReadAuthorityDecision } from './context-graph-read-authority.js';
import { recoverUnavailableSubscriptionRow, type SubscriptionRecoveryRowPorts } from './context-graph-subscription-recover-row.js';
import { SubscriptionRetryExecutor, type SubscriptionRetryRow, type SubscriptionRetryLease } from './subscription-retry-executor.js';

/** Pause after the first unanswered check, and the shortest a wake-up leaves. */
export const NAME_BINDING_RETRY_FIRST_PAUSE_MS = 1_000;
/** The pause doubles after each unanswered check, up to this. */
export const NAME_BINDING_RETRY_MAX_PAUSE_MS = 10_000;
/** How long a row is asked here before background recovery takes it back. */
export const NAME_BINDING_RETRY_WINDOW_MS = 10 * 60_000;
/** Checks (and activations) in flight at the same time. */
export const NAME_BINDING_RETRY_MAX_CONCURRENT = 2;
/** Rows held at once; past this, rows stay with background recovery. */
export const NAME_BINDING_RETRY_MAX_ROWS = 32;

/** The startup answer this retry is for. */
export function isChainNameBindingUnavailable(
  authority: Pick<ContextGraphReadAuthorityDecision, 'outcome' | 'reason'>,
): boolean {
  return authority.outcome === 'unavailable' && authority.reason === 'chain-name-binding-unavailable';
}

export interface NameBindingRetryPorts extends SubscriptionRecoveryRowPorts {
  /** Aborts when the node stops. */
  readonly signal: AbortSignal;
  track(run: Promise<unknown>): void;
  readonly log: { info(message: string): void; warn(message: string): void };
}

export interface NameBindingRetryOptions {
  readonly firstPauseMs?: number;
  readonly maxPauseMs?: number;
  readonly windowMs?: number;
  readonly maxConcurrent?: number;
  readonly maxRows?: number;
  /** One check's own deadline. */
  readonly checkTimeoutMs: number;
  readonly now?: () => number;
}

interface HeldRow {
  since: number;
  checks: number;
  unanswered: number;
  lastCheckAt: number;
  wokenCheck: boolean;
  wakeable: boolean;
  last: string;
}

/** The name-binding retry policy over the shared bounded subscription queue. */
export class PersistedSubscriptionNameBindingRetry {
  readonly #executor: SubscriptionRetryExecutor<HeldRow>;
  readonly #now: () => number;
  readonly #firstPauseMs: number;
  readonly #maxPauseMs: number;
  readonly #windowMs: number;
  constructor(private readonly ports: NameBindingRetryPorts, options: NameBindingRetryOptions) {
    this.#now = options.now ?? Date.now;
    this.#firstPauseMs = options.firstPauseMs ?? NAME_BINDING_RETRY_FIRST_PAUSE_MS;
    this.#maxPauseMs = options.maxPauseMs ?? NAME_BINDING_RETRY_MAX_PAUSE_MS;
    this.#windowMs = options.windowMs ?? NAME_BINDING_RETRY_WINDOW_MS;
    this.#executor = new SubscriptionRetryExecutor({
      signal: ports.signal, isCurrent: () => ports.isCurrent(), now: this.#now,
      maxRows: options.maxRows ?? NAME_BINDING_RETRY_MAX_ROWS,
      maxConcurrent: options.maxConcurrent ?? NAME_BINDING_RETRY_MAX_CONCURRENT,
      checkTimeoutMs: options.checkTimeoutMs, track: run => ports.track(run),
      eligible: row => ports.dormancy(row.id) === 'authorityUnavailable',
      attempt: (row, lease) => this.#attempt(row, lease),
      retired: (row, expired) => {
        if (!expired || !this.#executor.current()) return;
        ports.log.info(`Persisted context-graph subscription "${row.id}" is still dormant `
          + `${Math.round((this.#now() - row.value.since) / 1000)} s after its chain name binding could not be read `
          + `(${row.value.checks} check(s), last: ${row.value.last}); background authority recovery keeps asking`);
      },
      failed: (row, error) => {
        if (this.#executor.current()) ports.log.warn(`Could not ask again for persisted context-graph subscription "${row.id}" `
          + `left dormant without its chain name binding: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
  }

  take(contextGraphIds: Iterable<string>): string[] {
    const taken: string[] = [];
    for (const id of contextGraphIds) {
      if (this.ports.dormancy(id) !== 'authorityUnavailable') continue;
      const now = this.#now();
      if (this.#executor.take(id, { since: now, checks: 0, unanswered: 0, lastCheckAt: now,
        wokenCheck: false, wakeable: false, last: 'none' }, now + this.#windowMs)) taken.push(id);
    }
    return taken;
  }
  holds(id: string): boolean { return this.#executor.rows.has(id) && this.#executor.current(); }
  get size(): number { return this.#executor.rows.size; }
  get signal(): AbortSignal { return this.ports.signal; }
  whenIdle(): Promise<void> { return this.#executor.whenIdle(); }

  wake(): void {
    const now = this.#now();
    for (const row of this.#executor.rows.values()) {
      if (row.checking || row.dueAt <= now || !row.value.wakeable) continue;
      row.value.wakeable = false; row.value.wokenCheck = true;
      row.dueAt = Math.min(row.dueAt, row.value.lastCheckAt + this.#firstPauseMs);
    }
    this.#executor.pump();
  }

  async #attempt(row: SubscriptionRetryRow<HeldRow>, lease: SubscriptionRetryLease): Promise<number | undefined> {
    const held = row.value;
    held.checks += 1;
    const outcome = await recoverUnavailableSubscriptionRow(row.id, {
      ...this.ports, isCurrent: lease.isCurrent,
      resolveAuthority: saved => lease.check(signal => this.ports.resolveAuthority(saved, signal)),
    }, this.ports.signal);
    held.lastCheckAt = this.#now();
    if (outcome.kind === 'done') return undefined;
    if (outcome.kind === 'activated') {
      this.ports.log.info(`Activated persisted context-graph subscription "${row.id}" `
        + `${this.#now() - held.since} ms after its chain name binding could not be read at start (${held.checks} check(s))`);
      this.wake();
      return undefined;
    }
    if (outcome.kind === 'retry') {
      if (outcome.activationFailed && outcome.why !== held.last) {
        this.ports.log.warn(`Could not activate persisted context-graph subscription "${row.id}" after its chain name binding `
          + `answered: ${outcome.why}; asking again`);
      }
      held.last = outcome.why; held.unanswered += 1;
    }
    held.wakeable = !held.wokenCheck; held.wokenCheck = false;
    const pause = Math.min(this.#maxPauseMs, this.#firstPauseMs * 2 ** Math.min(Math.max(0, held.unanswered - 1), 16));
    return held.lastCheckAt + pause;
  }
}

const owners = new WeakMap<object, PersistedSubscriptionNameBindingRetry>();

/**
 * The agent's name-binding retry for the node run `signal` belongs to. A
 * stopped run's retry asks nothing more, and the next run gets a fresh one.
 */
export function persistedSubscriptionNameBindingRetryOf(
  agent: object,
  signal: AbortSignal,
  create: () => PersistedSubscriptionNameBindingRetry,
): PersistedSubscriptionNameBindingRetry {
  let retry = owners.get(agent);
  if (retry === undefined || retry.signal !== signal) {
    retry = create();
    owners.set(agent, retry);
  }
  return retry;
}

/** The agent's name-binding retry, if any run made one. */
export function peekPersistedSubscriptionNameBindingRetry(
  agent: object,
): PersistedSubscriptionNameBindingRetry | undefined {
  return owners.get(agent);
}
