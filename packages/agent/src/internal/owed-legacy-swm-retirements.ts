// SPDX-License-Identifier: Apache-2.0

/**
 * GH#3081 — the retirements of legacy shared-memory boundary markers that their caller stopped
 * waiting for.
 *
 * After a confirmed publication, and after a receiver verified a finalized VM twin, the marker of
 * the asset's shared copy is retired behind a fence. The retirement takes its turn behind the
 * leases and retirements of its graph, and a lease can be up for tens of seconds. Nothing the
 * caller does next depends on the marker, so the caller waits for the retirement a short time
 * only. One that outlives the wait is owed here: it runs to its end, and one that did not get its
 * turn, or failed, is repeated with a growing pause until it ran.
 *
 * This owner has the lifetime of the node's run. Every attempt it started is its own until the
 * attempt ended, whether its caller still waits or not: closing ends the ones that are still
 * waiting for their turn through the signal they were given, and waits for the ones at work, so
 * no retirement reads or writes after the close has resolved.
 *
 * Process-local. A marker whose retirement is owed when the process stops stays, as the marker of
 * a retirement that gave up always did: the next confirmed publication of its asset retires it,
 * and so does the projection of an author catalog that holds the asset.
 */
import { AsyncResource } from 'node:async_hooks';

/** What one attempt ended with; `not-run` is an attempt that did not get its turn. */
export type LegacySwmRetirementAttemptV1 = 'retired' | 'kept' | 'not-run';

/** How long a caller waits for the retirement it asked for. */
export const LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS = 1_000;
/** The pause before the first repeat. Each later pause is twice the one before, up to the cap. */
export const LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS = 30_000;
export const LEGACY_SWM_RETIREMENT_REPEAT_MAX_MS = 600_000;
/** Repeats of one retirement. After them its marker is left to the asset's next publication. */
export const MAX_LEGACY_SWM_RETIREMENT_REPEATS = 10;
/** Retirements that wait for a repeat at one time. One more is not repeated. */
export const MAX_OWED_LEGACY_SWM_RETIREMENTS = 4_096;

export type OwedLegacySwmRetirementEventV1 =
  | Readonly<{
      kind: 'repeating';
      key: string;
      /** Why the attempt before this pause retired nothing. */
      reason: 'not-run' | 'failed';
      /** The repeat this pause precedes, from 1. */
      repeat: number;
      inMs: number;
      error?: unknown;
    }>
  /** A repeat ended the retirement. */
  | Readonly<{ kind: 'repeated'; key: string; outcome: 'retired' | 'kept'; repeats: number }>
  | Readonly<{
      kind: 'abandoned';
      key: string;
      reason: 'repeats-exhausted' | 'too-many-owed';
      error?: unknown;
    }>;

/** One log line for an event, and the level it is worth. */
export function describeOwedLegacySwmRetirementEventV1(
  event: OwedLegacySwmRetirementEventV1,
): Readonly<{ level: 'info' | 'warn'; line: string }> {
  const cause = 'error' in event
    ? `: ${event.error instanceof Error ? event.error.message : String(event.error)}`
    : '';
  const subject = `Legacy SWM boundary retirement ${event.key}`;
  if (event.kind === 'repeating') {
    const why = event.reason === 'failed' ? 'failed' : 'did not get its turn';
    return {
      level: 'info',
      line: `${subject} ${why}; repeat ${event.repeat} in ${Math.round(event.inMs / 1000)} s${cause}`,
    };
  }
  if (event.kind === 'repeated') {
    return { level: 'info', line: `${subject} ended on repeat ${event.repeats}: ${event.outcome}` };
  }
  return {
    level: 'warn',
    line: `${subject} is not repeated any more (${event.reason}); `
      + `its marker stays until the asset is published again${cause}`,
  };
}

export interface OwedLegacySwmRetirementsOptionsV1 {
  readonly callerWaitMs?: number;
  readonly repeatBaseMs?: number;
  readonly repeatMaxMs?: number;
  readonly maxRepeats?: number;
  readonly maxOwed?: number;
  /** Observation only: a throw from it changes nothing. */
  readonly onEvent?: (event: OwedLegacySwmRetirementEventV1) => void;
}

/**
 * One attempt. It is called inside the call that asks for it, and `signal` aborts when this owner
 * closes: an attempt that is still waiting for its turn then has to end.
 */
export type LegacySwmRetirementAttemptFnV1 =
  (signal: AbortSignal) => Promise<LegacySwmRetirementAttemptV1>;

type SettledV1 =
  | Readonly<{ outcome: LegacySwmRetirementAttemptV1 }>
  | Readonly<{ error: unknown }>;

interface OwedRetirementV1 {
  /** The pause that is running; null while the repeat itself runs. */
  timer: ReturnType<typeof setTimeout> | null;
}

const WAITED_OUT = Symbol('waited-out');

// Repeats start from a timer. They run in the context this module was loaded in, which is no
// caller's: an owner is made on first use, inside whatever asked first.
const NO_CALLER = new AsyncResource('OwedLegacySwmRetirementsV1');

export class OwedLegacySwmRetirementsV1 {
  readonly #owed = new Map<string, OwedRetirementV1>();
  /** Every attempt that has started and not ended, the first of a retirement and its repeats. */
  readonly #running = new Set<Promise<SettledV1>>();
  /** One per run of the node; what an attempt of an earlier run ends with is nobody's. */
  #run = new AbortController();
  #closed = false;
  readonly #callerWaitMs: number;
  readonly #repeatBaseMs: number;
  readonly #repeatMaxMs: number;
  readonly #maxRepeats: number;
  readonly #maxOwed: number;
  readonly #onEvent: OwedLegacySwmRetirementsOptionsV1['onEvent'];

  constructor(options: OwedLegacySwmRetirementsOptionsV1 = {}) {
    this.#callerWaitMs = options.callerWaitMs ?? LEGACY_SWM_RETIREMENT_CALLER_WAIT_MS;
    this.#repeatBaseMs = options.repeatBaseMs ?? LEGACY_SWM_RETIREMENT_REPEAT_BASE_MS;
    this.#repeatMaxMs = options.repeatMaxMs ?? LEGACY_SWM_RETIREMENT_REPEAT_MAX_MS;
    this.#maxRepeats = options.maxRepeats ?? MAX_LEGACY_SWM_RETIREMENT_REPEATS;
    this.#maxOwed = options.maxOwed ?? MAX_OWED_LEGACY_SWM_RETIREMENTS;
    this.#onEvent = options.onEvent;
  }

  /** Retirements that wait for a repeat, or whose repeat is running. */
  get owed(): number {
    return this.#owed.size;
  }

  /** Attempts that have started and not ended. */
  get running(): number {
    return this.#running.size;
  }

  /**
   * Start the retirement that `key` names and wait for it, for the caller's wait at most.
   *
   * `attempt` is called inside this call, so a fence it raises is up before this returns its
   * promise. A failure inside the wait is thrown to the caller, as it was when the caller waited
   * to the end. Whatever the attempt ends with after the wait is this owner's. An attempt that
   * did not run or failed is repeated either way. A closed owner starts nothing: the node is
   * stopping, and the marker stays.
   */
  async retire(key: string, attempt: LegacySwmRetirementAttemptFnV1): Promise<void> {
    if (this.#closed) return;
    const run = this.#run;
    const settled = this.#start(attempt, run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitedOut = new Promise<typeof WAITED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(WAITED_OUT), this.#callerWaitMs);
    });
    let first: SettledV1 | typeof WAITED_OUT;
    try {
      first = await Promise.race([settled, waitedOut]);
    } finally {
      clearTimeout(timer);
    }
    if (first === WAITED_OUT) {
      void settled.then((late) => this.#afterAttempt(key, attempt, run, late, null, 0));
      return;
    }
    this.#afterAttempt(key, attempt, run, first, null, 0);
    if ('error' in first) throw first.error;
  }

  /**
   * Admit no more retirements, drop what is owed, end the attempts that are waiting for their
   * turn, and resolve once every attempt that had started has ended.
   */
  async closeAndDrain(): Promise<void> {
    this.#closed = true;
    this.#run.abort();
    for (const entry of this.#owed.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.#owed.clear();
    while (this.#running.size > 0) await Promise.allSettled(this.#running);
  }

  /** Admit retirements again after a close. */
  reopen(): void {
    if (!this.#closed) return;
    this.#run = new AbortController();
    this.#closed = false;
  }

  /** Start `attempt` now, as this owner's until it ended. A throw of the call is its failure. */
  #start(attempt: LegacySwmRetirementAttemptFnV1, run: AbortController): Promise<SettledV1> {
    let started: Promise<LegacySwmRetirementAttemptV1>;
    try {
      started = attempt(run.signal);
    } catch (error) {
      return Promise.resolve({ error });
    }
    const settled: Promise<SettledV1> = started.then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    this.#running.add(settled);
    void settled.then(() => { this.#running.delete(settled); });
    return settled;
  }

  /**
   * `owner` is the entry of the repeat that just ran, or null for a first attempt; `repeats` is
   * the number of repeats that have run for it.
   */
  #afterAttempt(
    key: string,
    attempt: LegacySwmRetirementAttemptFnV1,
    run: AbortController,
    settled: SettledV1,
    owner: OwedRetirementV1 | null,
    repeats: number,
  ): void {
    // The node stopped, and may run again: nothing of this run touches what the next one owes.
    if (run !== this.#run || run.signal.aborted) return;
    const owed = this.#owed.get(key);
    if (owner !== null && owed !== owner) return;
    if ('outcome' in settled && settled.outcome !== 'not-run') {
      // A first attempt that ended well leaves a pending repeat alone: it finds nothing to do.
      if (owner === null) return;
      this.#owed.delete(key);
      this.#report({ kind: 'repeated', key, outcome: settled.outcome, repeats });
      return;
    }
    const cause = 'error' in settled ? { error: settled.error } : {};
    // One repeat serves every request for the same retirement.
    if (owner === null && owed !== undefined) return;
    if (repeats >= this.#maxRepeats) {
      this.#owed.delete(key);
      this.#report({ kind: 'abandoned', key, reason: 'repeats-exhausted', ...cause });
      return;
    }
    if (owner === null && this.#owed.size >= this.#maxOwed) {
      this.#report({ kind: 'abandoned', key, reason: 'too-many-owed', ...cause });
      return;
    }
    const inMs = Math.min(this.#repeatMaxMs, this.#repeatBaseMs * 2 ** repeats);
    const entry: OwedRetirementV1 = owner ?? { timer: null };
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (run !== this.#run || run.signal.aborted || this.#owed.get(key) !== entry) return;
      void NO_CALLER.runInAsyncScope(() => this.#start(attempt, run))
        .then((next) => this.#afterAttempt(key, attempt, run, next, entry, repeats + 1));
    }, inMs);
    entry.timer.unref?.();
    this.#owed.set(key, entry);
    this.#report({
      kind: 'repeating',
      key,
      reason: 'error' in settled ? 'failed' : 'not-run',
      repeat: repeats + 1,
      inMs,
      ...cause,
    });
  }

  #report(event: OwedLegacySwmRetirementEventV1): void {
    try {
      this.#onEvent?.(event);
    } catch { /* observation only */ }
  }
}

/**
 * One owner per agent-like host, created on first use. Keyed by host identity and not stored on
 * the class, so that a prototype-bound test host owns one exactly as a constructed agent does.
 */
const ownersByHost = new WeakMap<object, OwedLegacySwmRetirementsV1>();

export function owedLegacySwmRetirementsOfV1(
  host: object,
  onEvent: NonNullable<OwedLegacySwmRetirementsOptionsV1['onEvent']>,
): OwedLegacySwmRetirementsV1 {
  let owner = ownersByHost.get(host);
  if (owner === undefined) {
    owner = new OwedLegacySwmRetirementsV1({ onEvent });
    ownersByHost.set(host, owner);
  }
  return owner;
}

/** The host's owner if it ever asked for a retirement; lifecycle hooks never create one. */
export function peekOwedLegacySwmRetirementsV1(host: object): OwedLegacySwmRetirementsV1 | undefined {
  return ownersByHost.get(host);
}
