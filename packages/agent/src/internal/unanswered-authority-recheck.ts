// SPDX-License-Identifier: Apache-2.0

/**
 * Graphs whose authority check got no answer, asked again in turn.
 *
 * Nothing here can read when the chain will answer, so the wait is a plain
 * delay. It is one delay for the whole queue and not one per graph: a node
 * whose endpoint is not answering then spends one short check per delay,
 * however many graphs are waiting, and each of them still gets its turn. A
 * graph is asked for as long as its check stays unanswered; the owner settles
 * it when a check is answered.
 *
 * The owner decides what "ask" does. This component owns the order, the delay
 * and the timer, and runs every ask as the node's own background work: the
 * timer would otherwise carry the request context of whichever check armed
 * it, a context that has ended by the time the ask runs.
 */

import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { withDefaultStoreWorkPriority } from '@origintrail-official/dkg-storage';

/** Wait before the next graph is asked again. Matches the read's own deadline. */
export const UNANSWERED_AUTHORITY_RECHECK_MS = 2_500;

/** Bound on graphs retained in one queue. */
export const UNANSWERED_AUTHORITY_RECHECK_MAX_WAITING = 4_096;

export class UnansweredAuthorityRecheck {
  /** What asks each waiting graph again, in the order they are asked. */
  readonly #waiting = new Map<string, () => void>();
  /**
   * Unanswered checks in a row per graph, kept until the graph is settled. It
   * only tells a first unanswered check from a repeated one.
   */
  readonly #unanswered = new Map<string, number>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(private readonly delayMs = UNANSWERED_AUTHORITY_RECHECK_MS) {}

  /**
   * The graph's check got no answer: ask it again after the graphs already
   * waiting. A graph that is already waiting keeps its place. Returns how
   * many checks of this graph in a row have gone unanswered, or 0 when the
   * graph was not taken (closed, or no room) and nothing will ask it again.
   */
  defer(key: string, ask: () => void): number {
    if (this.#closed) return 0;
    if (
      !this.#waiting.has(key)
      && this.#waiting.size >= UNANSWERED_AUTHORITY_RECHECK_MAX_WAITING
    ) return 0;
    const unanswered = (this.#unanswered.get(key) ?? 0) + 1;
    this.#unanswered.set(key, unanswered);
    this.#waiting.set(key, ask);
    this.#arm();
    return unanswered;
  }

  /** The graph's check was answered, or the graph is gone. */
  settle(key: string): void {
    this.#unanswered.delete(key);
    if (this.#waiting.delete(key) && this.#waiting.size === 0) this.#disarm();
  }

  /** Graphs waiting to be asked again. */
  get size(): number {
    return this.#waiting.size;
  }

  close(): void {
    this.#closed = true;
    this.#waiting.clear();
    this.#unanswered.clear();
    this.#disarm();
  }

  #arm(): void {
    if (this.#timer !== undefined || this.#closed || this.#waiting.size === 0) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const next = this.#waiting.entries().next();
      if (!next.done) {
        const [key, ask] = next.value;
        this.#waiting.delete(key);
        try {
          withOwnedRpcRequestContext(
            { requestClass: 'background' },
            () => withDefaultStoreWorkPriority('background', ask),
          );
        } catch {
          // The owner's ask reports its own failures. One that throws anyway
          // must not stop the graphs behind it from being asked.
        }
      }
      this.#arm();
    }, this.delayMs);
    this.#timer.unref?.();
  }

  #disarm(): void {
    if (this.#timer === undefined) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

const lifecycleQueues = new WeakMap<object, {
  readonly lifecycleSignal: AbortSignal;
  readonly recheck: UnansweredAuthorityRecheck;
}>();

/**
 * The owner's queue for the lifecycle `lifecycleSignal` belongs to. It closes
 * when that signal aborts, and the owner's next lifecycle gets a fresh one: a
 * stopped owner asks nothing, a restarted one starts with nobody waiting.
 * `delayMs` applies to the queue this call creates.
 */
export function unansweredAuthorityRecheckFor(
  owner: object,
  lifecycleSignal: AbortSignal,
  delayMs = UNANSWERED_AUTHORITY_RECHECK_MS,
): UnansweredAuthorityRecheck {
  let state = lifecycleQueues.get(owner);
  if (state === undefined || state.lifecycleSignal !== lifecycleSignal) {
    state?.recheck.close();
    const recheck = new UnansweredAuthorityRecheck(delayMs);
    if (lifecycleSignal.aborted) recheck.close();
    else lifecycleSignal.addEventListener('abort', () => recheck.close(), { once: true });
    state = { lifecycleSignal, recheck };
    lifecycleQueues.set(owner, state);
  }
  return state.recheck;
}

/**
 * The line an owner logs for a check that got no answer. `unansweredChecks`
 * is what {@link UnansweredAuthorityRecheck.defer} returned.
 */
export function describeUnansweredAuthorityCheck(input: {
  /** What is waiting, e.g. `SWM gossip subscription for "<graph>"`. */
  readonly subject: string;
  /** What it is waiting for, e.g. `read authority`. */
  readonly waitingFor: string;
  /** The unanswered read, as the observation named it. */
  readonly read: string;
  /** What holds in the meantime, e.g. `the subscription is kept`. */
  readonly meanwhile: string;
  readonly unansweredChecks: number;
}): string {
  return `${input.subject} is waiting for ${input.waitingFor} (${input.read}): `
    + `the chain read got no answer; ${input.meanwhile}, `
    + (input.unansweredChecks > 0 ? 'asking again shortly' : 'asked again at its next reconcile');
}
