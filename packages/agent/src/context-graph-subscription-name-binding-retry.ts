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

import {
  contextGraphReadAuthorityDependencyOf,
  unavailableContextGraphReadAuthorityDecision,
  type ContextGraphReadAuthorityDecision,
} from './context-graph-read-authority.js';
import {
  contextGraphDormancyAfterAuthority,
  type ContextGraphDormancyReason,
} from './context-graph-subscription-dormancy.js';
import type { ContextGraphSub, ContextGraphSubscriptionRecord } from './dkg-agent-types.js';

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

export interface NameBindingRetryPorts {
  /** Aborts when the node stops. */
  readonly signal: AbortSignal;
  /** This node run still owns subscription state. */
  isCurrent(): boolean;
  dormancy(contextGraphId: string): ContextGraphDormancyReason | undefined;
  revision(contextGraphId: string): number;
  subscription(contextGraphId: string): ContextGraphSub | undefined;
  load(contextGraphId: string): Promise<ContextGraphSubscriptionRecord | null>;
  resolveAuthority(
    row: ContextGraphSubscriptionRecord,
    signal: AbortSignal,
  ): Promise<ContextGraphReadAuthorityDecision>;
  /** Whether the activation cap has room for one more user row now. */
  capHasRoom(): boolean;
  /** No room under the cap: the row waits for rolling activation as `activationCap`. */
  capped(contextGraphId: string): void;
  /** Activate the row; `isCurrent` says whether this retry still owns it. */
  activate(
    row: ContextGraphSubscriptionRecord,
    onChainId: string | undefined,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<void>;
  /** Record the dormancy a final answer leaves the row in. */
  retire(contextGraphId: string, reason: ContextGraphDormancyReason): void;
  track(run: Promise<unknown>): void;
  readonly log: {
    info(message: string): void;
    warn(message: string): void;
  };
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
  readonly contextGraphId: string;
  readonly since: number;
  checks: number;
  /** Unanswered checks so far; the pause grows with them. */
  unanswered: number;
  /** When the last check ended (when the row was taken, at first). */
  lastCheckAt: number;
  /** A wake-up brought the last check forward. */
  wokenCheck: boolean;
  last: string;
  /** Set while the row waits out a pause a wake-up may shorten. */
  cutPause?: () => void;
}

type AttemptOutcome =
  | { kind: 'activated' }
  /** Still unavailable, or the activation failed: ask again after the pause. */
  | { kind: 'retry'; why: string; activationFailed?: true }
  /** The row moved under the check: ask again without growing the pause. */
  | { kind: 'again' }
  | { kind: 'done' };

function sameRow(
  left: ContextGraphSubscriptionRecord,
  right: ContextGraphSubscriptionRecord,
): boolean {
  return left.id === right.id
    && left.onChainId === right.onChainId
    && left.onChainHash === right.onChainHash
    && left.subscribed === right.subscribed
    && (left.coreHosted === true) === (right.coreHosted === true);
}

function hasIntent(row: ContextGraphSubscriptionRecord | null): row is ContextGraphSubscriptionRecord {
  return row !== null && (row.subscribed || row.coreHosted === true);
}

/** The name-binding retries of one node run. */
export class PersistedSubscriptionNameBindingRetry {
  readonly #ports: NameBindingRetryPorts;
  readonly #firstPauseMs: number;
  readonly #maxPauseMs: number;
  readonly #windowMs: number;
  readonly #maxConcurrent: number;
  readonly #maxRows: number;
  readonly #checkTimeoutMs: number;
  readonly #now: () => number;
  readonly #rows = new Map<string, HeldRow>();
  readonly #runs = new Set<Promise<void>>();
  /** Check slots in use, and the rows waiting for one, first come first served. */
  #checking = 0;
  readonly #waiting: Array<() => void> = [];

  constructor(ports: NameBindingRetryPorts, options: NameBindingRetryOptions) {
    this.#ports = ports;
    this.#firstPauseMs = options.firstPauseMs ?? NAME_BINDING_RETRY_FIRST_PAUSE_MS;
    this.#maxPauseMs = options.maxPauseMs ?? NAME_BINDING_RETRY_MAX_PAUSE_MS;
    this.#windowMs = options.windowMs ?? NAME_BINDING_RETRY_WINDOW_MS;
    this.#maxConcurrent = options.maxConcurrent ?? NAME_BINDING_RETRY_MAX_CONCURRENT;
    this.#maxRows = options.maxRows ?? NAME_BINDING_RETRY_MAX_ROWS;
    this.#checkTimeoutMs = options.checkTimeoutMs;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Take rows the startup pass just left dormant because their chain name
   * binding could not be read. Returns the ones taken; the rest stay with
   * background recovery.
   */
  take(contextGraphIds: Iterable<string>): string[] {
    const taken: string[] = [];
    for (const contextGraphId of contextGraphIds) {
      if (!this.#current() || this.#rows.size >= this.#maxRows) break;
      if (this.#rows.has(contextGraphId)) continue;
      if (this.#ports.dormancy(contextGraphId) !== 'authorityUnavailable') continue;
      const now = this.#now();
      this.#start({
        contextGraphId, since: now, checks: 0, unanswered: 0, lastCheckAt: now, wokenCheck: false, last: 'none',
      });
      taken.push(contextGraphId);
    }
    return taken;
  }

  /** Whether this retry asks for the row now; background recovery leaves it alone meanwhile. */
  holds(contextGraphId: string): boolean {
    return this.#rows.has(contextGraphId) && this.#current();
  }

  /**
   * The chain authority source answered again. A held row waiting out a pause
   * is asked one first pause after its last check, unless a wake-up brought
   * that check forward too; the pause after it is not reset. However many
   * come, wake-ups at most double the checks of the schedule.
   */
  wake(): void {
    for (const held of this.#rows.values()) held.cutPause?.();
  }

  /** Rows held now, checking, waiting or pausing. */
  get size(): number {
    return this.#rows.size;
  }

  /** The node run this retry belongs to. */
  get signal(): AbortSignal {
    return this.#ports.signal;
  }

  /** Settles when no retry runs. */
  async whenIdle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.allSettled(this.#runs);
  }

  #current(): boolean {
    return !this.#ports.signal.aborted && this.#ports.isCurrent();
  }

  #start(held: HeldRow): void {
    this.#rows.set(held.contextGraphId, held);
    const run: Promise<void> = this.#run(held)
      .catch((error: unknown) => {
        if (!this.#current()) return;
        this.#ports.log.warn(
          `Could not ask again for persisted context-graph subscription "${held.contextGraphId}" ` +
          `left dormant without its chain name binding: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.#rows.delete(held.contextGraphId);
        this.#runs.delete(run);
      });
    this.#runs.add(run);
    this.#ports.track(run);
  }

  async #run(held: HeldRow): Promise<void> {
    const ports = this.#ports;
    const id = held.contextGraphId;
    for (;;) {
      await this.#pause(held);
      if (!this.#current() || ports.dormancy(id) !== 'authorityUnavailable') return;
      if (this.#now() - held.since >= this.#windowMs) {
        ports.log.info(
          `Persisted context-graph subscription "${id}" is still dormant ` +
          `${Math.round((this.#now() - held.since) / 1000)} s after its chain name binding could not be read ` +
          `(${held.checks} check(s), last: ${held.last}); background authority recovery keeps asking`,
        );
        return;
      }
      if (!(await this.#acquire())) return;
      let outcome: AttemptOutcome;
      try {
        if (!this.#current() || ports.dormancy(id) !== 'authorityUnavailable') {
          outcome = { kind: 'done' };
        } else {
          held.checks += 1;
          outcome = await this.#attempt(held);
        }
      } finally {
        this.#release();
        held.lastCheckAt = this.#now();
      }
      if (outcome.kind === 'done') return;
      if (outcome.kind === 'activated') {
        ports.log.info(
          `Activated persisted context-graph subscription "${id}" ` +
          `${this.#now() - held.since} ms after its chain name binding could not be read at start ` +
          `(${held.checks} check(s))`,
        );
        // Its lookup answered: the other rows may be answered now too.
        this.wake();
        return;
      }
      if (outcome.kind === 'retry') {
        if (outcome.activationFailed && outcome.why !== held.last) {
          ports.log.warn(
            `Could not activate persisted context-graph subscription "${id}" after its chain name binding ` +
            `answered: ${outcome.why}; asking again`,
          );
        }
        held.last = outcome.why;
        held.unanswered += 1;
      }
    }
  }

  /** Wait until the row's next check may start: shortened by a wake-up, ended by a stop. */
  async #pause(held: HeldRow): Promise<void> {
    const signal = this.#ports.signal;
    // None before the first check; then 1, 2, 4 ... s after each unanswered one.
    const pauseMs = held.checks === 0
      ? 0
      : Math.min(this.#maxPauseMs, this.#firstPauseMs * 2 ** Math.min(Math.max(0, held.unanswered - 1), 16));
    let notBefore = held.lastCheckAt + pauseMs;
    // A check a wake-up brought forward is not followed by another one.
    let wakeable = !held.wokenCheck;
    held.wokenCheck = false;
    for (;;) {
      const waitMs = notBefore - this.#now();
      if (waitMs <= 0 || signal.aborted) return;
      const cut = await new Promise<boolean>((resolve) => {
        const finish = (wasCut: boolean): void => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          held.cutPause = undefined;
          resolve(wasCut);
        };
        const onAbort = (): void => finish(false);
        const timer = setTimeout(() => finish(false), waitMs);
        timer.unref?.();
        signal.addEventListener('abort', onAbort, { once: true });
        if (wakeable) held.cutPause = () => finish(true);
      });
      if (!cut) return;
      // Woken: wait out what is left of the first pause, and nothing more.
      wakeable = false;
      held.wokenCheck = true;
      notBefore = Math.min(notBefore, held.lastCheckAt + this.#firstPauseMs);
    }
  }

  /** Take a check slot; false when the node stops first. */
  #acquire(): Promise<boolean> {
    const signal = this.#ports.signal;
    if (signal.aborted) return Promise.resolve(false);
    if (this.#checking < this.#maxConcurrent) {
      this.#checking += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const grant = (): void => {
        signal.removeEventListener('abort', cancel);
        resolve(true);
      };
      const cancel = (): void => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        resolve(false);
      };
      this.#waiting.push(grant);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  /** Hand the slot to the next row waiting for one, if any. */
  #release(): void {
    const next = this.#waiting.shift();
    if (next !== undefined) next();
    else this.#checking -= 1;
  }

  async #attempt(held: HeldRow): Promise<AttemptOutcome> {
    const ports = this.#ports;
    const id = held.contextGraphId;
    const row = await ports.load(id);
    if (!this.#current()) return { kind: 'done' };
    // No saved intent any more: the owners that clear rows have it.
    if (!hasIntent(row)) return { kind: 'done' };
    const revision = ports.revision(id);
    const authority = await this.#check(row);
    if (!this.#current()) return { kind: 'done' };
    if (authority === undefined) {
      return { kind: 'retry', why: `no answer within ${this.#checkTimeoutMs} ms` };
    }
    // The answer belongs to the row as it was read; if it moved, decide again.
    const fresh = await ports.load(id);
    if (!this.#current() || ports.dormancy(id) !== 'authorityUnavailable') return { kind: 'done' };
    if (!hasIntent(fresh)) return { kind: 'done' };
    if (ports.revision(id) !== revision || !sameRow(row, fresh)) return { kind: 'again' };
    const live = ports.subscription(id);
    if (live?.subscribed === true || live?.coreHosted === true) return { kind: 'done' };
    if (authority.outcome !== 'allowed') {
      const next = contextGraphDormancyAfterAuthority(authority);
      if (next === 'authorityUnavailable') {
        return { kind: 'retry', why: `${authority.outcome} by ${authority.source} (${authority.reason})` };
      }
      ports.retire(id, next);
      ports.log.info(
        `Left persisted context-graph subscription "${id}" dormant: ` +
        `${authority.outcome} by ${authority.source} (${authority.reason})`,
      );
      return { kind: 'done' };
    }
    if (fresh.coreHosted !== true && !ports.capHasRoom()) {
      ports.capped(id);
      ports.log.info(
        `Persisted context-graph subscription "${id}" answered after its chain name binding could not be read, ` +
        'but the activation cap is full; it waits for rolling activation',
      );
      return { kind: 'done' };
    }
    const isCurrent = (): boolean => this.#current() && this.#rows.get(id) === held;
    try {
      await ports.activate(fresh, authority.onChainId?.toString() ?? fresh.onChainId, revision, isCurrent);
    } catch (error) {
      if (!this.#current() || ports.dormancy(id) !== 'authorityUnavailable') return { kind: 'done' };
      // Another owner may be activating the same row; the next check sees it.
      return { kind: 'retry', why: error instanceof Error ? error.message : String(error), activationFailed: true };
    }
    return { kind: 'activated' };
  }

  /**
   * One read of the row's authority under the check's own deadline; undefined
   * when the read gave no answer by then. A read that does not end at its
   * signal is left behind: it cannot hold the check slot.
   */
  #check(row: ContextGraphSubscriptionRecord): Promise<ContextGraphReadAuthorityDecision | undefined> {
    const deadline = new AbortController();
    const timer = setTimeout(() => {
      deadline.abort(new Error(`no answer within ${this.#checkTimeoutMs} ms`));
    }, this.#checkTimeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([this.#ports.signal, deadline.signal]);
    if (signal.aborted) {
      clearTimeout(timer);
      return Promise.resolve(undefined);
    }
    return new Promise<ContextGraphReadAuthorityDecision | undefined>((resolve) => {
      const settle = (answer: ContextGraphReadAuthorityDecision | undefined): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(answer);
      };
      const onAbort = (): void => settle(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
      this.#ports.resolveAuthority(row, signal).then(
        (answer) => settle(signal.aborted ? undefined : answer),
        (error: unknown) => settle(signal.aborted ? undefined : unavailableContextGraphReadAuthorityDecision(
          'legacy-local',
          'unexpected-authority-error',
          contextGraphReadAuthorityDependencyOf(error),
        )),
      );
    });
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
