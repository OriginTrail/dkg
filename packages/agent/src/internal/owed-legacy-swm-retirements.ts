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

/** An attempt that leaves nothing to come back for. */
function endedV1(
  settled: SettledV1,
): settled is Readonly<{ outcome: 'retired' | 'kept' }> {
  return 'outcome' in settled && settled.outcome !== 'not-run';
}

function causeOfV1(settled: SettledV1): { error?: unknown } {
  return 'error' in settled ? { error: settled.error } : {};
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts. The timer holds no process open. Called
 * with a signal that has not aborted: a task checks its run before every pause.
 */
function pauseV1(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const over = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', over);
      resolve();
    };
    const timer = setTimeout(over, ms);
    timer.unref?.();
    signal.addEventListener('abort', over, { once: true });
  });
}

const WAITED_OUT = Symbol('waited-out');

/** One run of the node, from a start to the stop that follows it. */
interface RunV1 {
  /** Aborts when the run is closed. */
  readonly lifetime: AbortController;
  /** The repeat tasks of this run that have not returned. */
  readonly tasks: Set<Promise<void>>;
}

function newRunV1(): RunV1 {
  return { lifetime: new AbortController(), tasks: new Set() };
}

// The repeats of a retirement run in the context this module was loaded in, which is no
// caller's: an owner is made on first use, inside whatever asked first.
const NO_CALLER = new AsyncResource('OwedLegacySwmRetirementsV1');

export class OwedLegacySwmRetirementsV1 {
  /** The retirements that are being repeated, each with the task that repeats it. */
  readonly #repeating = new Map<string, object>();
  /** Every attempt that has started and not ended, of this run and of the ones before it. */
  readonly #attempts = new Set<Promise<SettledV1>>();
  /** What an attempt of an earlier run ends with is nobody's. */
  #run = newRunV1();
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

  /** Retirements that are being repeated: in a pause, or in the repeat itself. */
  get owed(): number {
    return this.#repeating.size;
  }

  /** Attempts that have started and not ended. */
  get running(): number {
    return this.#attempts.size;
  }

  /**
   * Start the retirement that `key` names and wait for it, for the caller's wait at most.
   *
   * `attempt` is called inside this call, so a fence it raises is up before this returns its
   * promise. A failure inside the wait is thrown to the caller, as it was when the caller waited
   * to the end. Whether the caller is still waiting or not, an attempt that did not run or
   * failed is repeated. A closed owner starts nothing: the node is stopping, and the marker
   * stays.
   */
  async retire(key: string, attempt: LegacySwmRetirementAttemptFnV1): Promise<void> {
    if (this.#closed) return;
    const run = this.#run;
    const first = this.#start(attempt, run);
    // The owner's part: it is told what the first attempt ended with, before the caller is.
    void first.then((settled) => {
      if (!endedV1(settled)) this.#repeat(key, attempt, run, settled);
    });
    // The caller's part: its wait.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitedOut = new Promise<typeof WAITED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(WAITED_OUT), this.#callerWaitMs);
    });
    try {
      const settled = await Promise.race([first, waitedOut]);
      if (settled !== WAITED_OUT && 'error' in settled) throw settled.error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Admit no more retirements, stop repeating, end the attempts that are waiting for their turn,
   * and resolve once every attempt that had started has ended, with the tasks of this run.
   * Nothing starts in a closed run, so one look at what is running is enough.
   */
  async closeAndDrain(): Promise<void> {
    const run = this.#run;
    this.#closed = true;
    run.lifetime.abort();
    this.#repeating.clear();
    await Promise.allSettled(this.#attempts);
    await Promise.allSettled(run.tasks);
  }

  /** Admit retirements again after a close, as a new run. */
  reopen(): void {
    if (!this.#closed) return;
    this.#run = newRunV1();
    this.#closed = false;
  }

  /** Start `attempt` now, as this owner's until it ended. A throw of the call is its failure. */
  #start(attempt: LegacySwmRetirementAttemptFnV1, run: RunV1): Promise<SettledV1> {
    let started: Promise<LegacySwmRetirementAttemptV1>;
    try {
      started = attempt(run.lifetime.signal);
    } catch (error) {
      return Promise.resolve({ error });
    }
    const settled: Promise<SettledV1> = started.then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    this.#attempts.add(settled);
    void settled.then(() => { this.#attempts.delete(settled); });
    return settled;
  }

  /** Give `key` its repeat task, unless it has one: one task serves every request for it. */
  #repeat(
    key: string,
    attempt: LegacySwmRetirementAttemptFnV1,
    run: RunV1,
    first: SettledV1,
  ): void {
    if (run !== this.#run || run.lifetime.signal.aborted || this.#repeating.has(key)) return;
    if (this.#repeating.size >= this.#maxOwed) {
      this.#report({ kind: 'abandoned', key, reason: 'too-many-owed', ...causeOfV1(first) });
      return;
    }
    const task = {};
    this.#repeating.set(key, task);
    const repeated = NO_CALLER.runInAsyncScope(() => this.#repeatUntilEnded(key, attempt, run, task, first));
    run.tasks.add(repeated);
    void repeated.then(() => { run.tasks.delete(repeated); });
  }

  /** The task of one retirement: pause, attempt, until an attempt ends it or the repeats run out. */
  async #repeatUntilEnded(
    key: string,
    attempt: LegacySwmRetirementAttemptFnV1,
    run: RunV1,
    task: object,
    first: SettledV1,
  ): Promise<void> {
    // The node stopped, and may run again: nothing of this run touches what the next one owes.
    const mine = (): boolean => (
      run === this.#run && !run.lifetime.signal.aborted && this.#repeating.get(key) === task
    );
    let last = first;
    for (let repeat = 1; repeat <= this.#maxRepeats; repeat += 1) {
      const inMs = Math.min(this.#repeatMaxMs, this.#repeatBaseMs * 2 ** (repeat - 1));
      this.#report({
        kind: 'repeating',
        key,
        reason: 'error' in last ? 'failed' : 'not-run',
        repeat,
        inMs,
        ...causeOfV1(last),
      });
      await pauseV1(inMs, run.lifetime.signal);
      if (!mine()) return;
      last = await this.#start(attempt, run);
      if (!mine()) return;
      if (endedV1(last)) {
        this.#repeating.delete(key);
        this.#report({ kind: 'repeated', key, outcome: last.outcome, repeats: repeat });
        return;
      }
    }
    this.#repeating.delete(key);
    this.#report({ kind: 'abandoned', key, reason: 'repeats-exhausted', ...causeOfV1(last) });
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

/** The host's owner if it has one; `start()` has nothing to reopen for a host that has none. */
export function peekOwedLegacySwmRetirementsV1(host: object): OwedLegacySwmRetirementsV1 | undefined {
  return ownersByHost.get(host);
}
