// SPDX-License-Identifier: Apache-2.0

import {
  activeRpcRequestContext,
  withOwnedRpcRequestContext,
  type RpcRequestClass,
} from './rpc-request-transport.js';
import { abortError, waitForSignal } from './wait-for-signal.js';

/**
 * In-flight de-duplication for the one-read Context Graph live authority.
 *
 * WHY, and why it is NOT a cache. `getContextGraph` folds liveness, access
 * policy and roster into one read, and that read is the trust anchor for the
 * gates that decide who receives a sender key, whether content is written in
 * plaintext, and who may query. Those gates may never be answered from a
 * retained value, however briefly. So nothing is retained here: a flight
 * exists only while it is running, there is no TTL, and a caller arriving
 * after it settled always causes a new physical read. What IS shared is the
 * read itself — callers that ask at the same moment for the same graph ask the
 * chain once, and every one of them is answered by a read issued AFTER it
 * asked. That introduces exactly zero staleness, which is what makes it safe
 * at a gate.
 *
 * BOUNDED SUCCESSION. A flight is created on the first caller and dispatched
 * one macrotask later, so every caller arriving before dispatch shares it. A
 * caller arriving after dispatch may NOT consume that already-started read;
 * it joins one successor cohort whose physical read starts only after the
 * active read settles. This preserves zero staleness while bounding a slow
 * endpoint to one active read plus one waiting cohort per key. Without that
 * bound, dense callers on consecutive event-loop turns each opened another
 * physical read, and an unhealthy endpoint amplified one gate timeout into a
 * self-sustaining RPC failover herd. The caller's own 2,500 ms deadline still
 * owns availability: a waiter that cannot stay for the successor simply
 * detaches and fails closed, without cancelling peers.
 *
 * A JOINER ONLY EVER SHARES A DEFINITIVE ANSWER (the #2666 defect). Draft PR
 * #2666 shared the whole bounded agent resolution, so the INITIATOR's 2,500 ms
 * timeout became a VALUE — `{unavailable, chain-access-policy-timeout}` — that
 * its joiners were handed as if it were their own read's outcome. One caller's
 * budget must never end another caller's read. Here a flight settles either
 * DEFINITIVELY (a decoded tuple, `null` for a nonexistent id, or the
 * deterministic `ContextGraphLiveAuthorityUnsupportedError`), which every
 * waiter may take, or INDEFINITELY (a transient RPC failure, an abort), which
 * only the initiator — whose own read it was — receives. A joiner that would
 * have inherited it re-reads instead, and because they all resume together
 * they re-read through ONE shared successor, never N private ones. If that
 * bounded retry is also indefinite, only its initiator receives the physical
 * error; another joiner receives a caller-local retry-exhausted error instead.
 *
 * OWNERSHIP OF CANCELLATION. The physical read runs under
 * {@link withOwnedRpcRequestContext} with the flight's OWN controller, so
 * neither the initiator's ambient signal nor its request class reaches the
 * governor. A waiter's signal detaches that waiter only; when the last waiter
 * leaves, the flight is aborted so abandoned RPC admission cannot outlive its
 * callers.
 *
 * WHAT IS STILL SHARED: THE CLOCK, NOT THE VALUE (review residual). A joiner
 * spends part of its own budget — 2,500 ms for the agent-side gate reads —
 * waiting on the INITIATOR's read before the successor re-read begins. So an
 * initiator-side transient failure can still fail a gate closed that an
 * unshared read would have answered in time. That is availability, not
 * authority: the joiner is never handed the initiator's outcome, and it never
 * waits past its own deadline. It is the same budget argument that rejected the
 * settle-wait above, and it is the reason MAX_JOINER_RETRIES is 1.
 *
 * TESTING TRAP. Dispatch rides on the {@link ContextGraphLiveAuthorityCoalescerOptions.defer}
 * hook, which defaults to `setTimeout(…, 0)`. Under `vi.useFakeTimers()` that
 * timer never fires on its own, so every caller for that key hangs: a test with
 * fake timers must advance them or inject its own `defer`.
 */

/** A settled flight, split by whether a joiner may take the outcome. */
type ContextGraphLiveAuthorityFlightOutcome<V> =
  | { readonly kind: 'value'; readonly value: V }
  | { readonly kind: 'definitive-error'; readonly error: unknown }
  | { readonly kind: 'indefinite-error'; readonly error: unknown };

interface SequencedFlight<V> {
  readonly controller: AbortController;
  readonly outcome: Promise<V>;
  readonly resolve: (value: V) => void;
  readonly reject: (error: unknown) => void;
  readonly load: (signal: AbortSignal) => Promise<V>;
  waiters: number;
  dispatched: boolean;
  settled: boolean;
}

interface SequencedLane<V> {
  active: SequencedFlight<V>;
  successor: SequencedFlight<V> | undefined;
}

interface SequencedFlightResult<V> {
  /** True only for the first caller enrolled in this cohort. */
  readonly initiated: boolean;
  readonly value: V;
}

/**
 * One active physical read and, while it runs, at most one successor cohort.
 *
 * The successor is deliberately a COHORT rather than a retained value. Its
 * read has not started yet, so every enrolled caller is guaranteed that the
 * read it may consume begins after that caller arrived. When the active read
 * settles, the cohort is promoted and dispatched on the configured scheduler;
 * callers arriving before that dispatch may join it, while callers arriving
 * after dispatch open the following successor. Thus no generation crosses the
 * zero-staleness boundary and no key can fan out an unbounded number of
 * simultaneous RPCs during a slow endpoint/failover window.
 */
class SequencedDeferredKeyedFlight<K, V> {
  readonly #lanes = new Map<K, SequencedLane<V>>();
  readonly #defer: (dispatch: () => void) => void;
  readonly #abandonmentMessage: string;

  constructor(options: {
    readonly defer: (dispatch: () => void) => void;
    readonly abandonmentMessage: string;
  }) {
    this.#defer = options.defer;
    this.#abandonmentMessage = options.abandonmentMessage;
  }

  async run(
    key: K,
    load: (signal: AbortSignal) => Promise<V>,
    waiterSignal?: AbortSignal,
  ): Promise<SequencedFlightResult<V>> {
    waiterSignal?.throwIfAborted();
    let lane = this.#lanes.get(key);
    let flight: SequencedFlight<V>;
    let initiated = false;
    if (lane === undefined) {
      flight = this.#createFlight(load);
      lane = { active: flight, successor: undefined };
      this.#lanes.set(key, lane);
      initiated = true;
      this.#schedule(key, lane, flight);
    } else if (!lane.active.dispatched) {
      flight = lane.active;
      flight.waiters += 1;
    } else if (lane.successor !== undefined) {
      flight = lane.successor;
      flight.waiters += 1;
    } else {
      flight = this.#createFlight(load);
      lane.successor = flight;
      initiated = true;
    }

    try {
      const value = await waitForSignal(flight.outcome, waiterSignal);
      return { initiated, value };
    } finally {
      this.#leave(key, lane, flight);
    }
  }

  /** New callers start a fresh lineage while already-enrolled callers finish. */
  detachAll(): void {
    this.#lanes.clear();
  }

  #createFlight(load: (signal: AbortSignal) => Promise<V>): SequencedFlight<V> {
    const controller = new AbortController();
    let resolve!: (value: V) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<V>((resolveOutcome, rejectOutcome) => {
      resolve = resolveOutcome;
      reject = rejectOutcome;
    });
    // A synchronous `defer` may run the loader before `run()` reaches
    // `waitForSignal`. If that loader aborts the initiating waiter, its
    // `finally` abandons and rejects this outcome before that caller can attach
    // a rejection handler. Mark the shared promise handled immediately while
    // leaving it rejected for every real awaiter.
    void outcome.catch(() => undefined);
    return {
      controller,
      outcome,
      resolve,
      reject,
      load,
      waiters: 1,
      dispatched: false,
      settled: false,
    };
  }

  #schedule(
    key: K,
    lane: SequencedLane<V>,
    flight: SequencedFlight<V>,
  ): void {
    try {
      this.#defer(() => this.#dispatch(key, lane, flight));
    } catch (error) {
      this.#finish(key, lane, flight, { kind: 'error', error });
    }
  }

  #dispatch(
    key: K,
    lane: SequencedLane<V>,
    flight: SequencedFlight<V>,
  ): void {
    if (flight.settled) return;
    if (flight.waiters === 0) {
      this.#abandon(key, lane, flight);
      return;
    }
    flight.dispatched = true;
    let loaded: Promise<V>;
    try {
      loaded = flight.load(flight.controller.signal);
    } catch (error) {
      this.#finish(key, lane, flight, { kind: 'error', error });
      return;
    }
    void loaded.then(
      (value) => this.#finish(key, lane, flight, { kind: 'value', value }),
      (error) => this.#finish(key, lane, flight, { kind: 'error', error }),
    );
  }

  #finish(
    key: K,
    lane: SequencedLane<V>,
    flight: SequencedFlight<V>,
    result: { readonly kind: 'value'; readonly value: V }
      | { readonly kind: 'error'; readonly error: unknown },
  ): void {
    if (flight.settled) return;
    flight.settled = true;
    if (result.kind === 'value') flight.resolve(result.value);
    else flight.reject(result.error);

    // A detach/rotation may already have installed a fresh lane for this key.
    // The old lane remains self-contained: its already-enrolled successor must
    // still run, but completion may never delete or mutate the new map entry.
    const attached = this.#lanes.get(key) === lane;
    if (lane.active !== flight) {
      if (lane.successor === flight) lane.successor = undefined;
      return;
    }
    const successor = lane.successor;
    if (successor === undefined || successor.waiters === 0 || successor.settled) {
      if (attached) this.#lanes.delete(key);
      return;
    }
    lane.active = successor;
    lane.successor = undefined;
    this.#schedule(key, lane, successor);
  }

  #leave(
    key: K,
    lane: SequencedLane<V>,
    flight: SequencedFlight<V>,
  ): void {
    flight.waiters -= 1;
    if (flight.waiters > 0 || flight.settled) return;
    this.#abandon(key, lane, flight);
  }

  #abandon(
    key: K,
    lane: SequencedLane<V>,
    flight: SequencedFlight<V>,
  ): void {
    const abandoned = abortError(this.#abandonmentMessage);
    if (!flight.controller.signal.aborted) flight.controller.abort(abandoned);
    this.#finish(key, lane, flight, { kind: 'error', error: abandoned });
  }
}

export interface ContextGraphLiveAuthorityCoalescerOptions {
  /**
   * How dispatch is deferred so same-turn callers batch into one read. A
   * macrotask by default; tests inject a deterministic scheduler. A synchronous
   * implementation is supported (without same-turn batching) and never loses
   * the initiating waiter.
   */
  readonly defer?: (dispatch: () => void) => void;
  /**
   * Classifies a loader rejection a waiter that did not initiate it may still
   * be answered with. Only deterministic "this read cannot answer" faults
   * qualify; a transient failure or an abort never does.
   */
  readonly isDefinitiveError?: (error: unknown) => boolean;
}

export interface ContextGraphLiveAuthorityRunOptions {
  /** Detaches THIS caller from the flight; never cancels it for the others. */
  readonly signal?: AbortSignal;
  /**
   * Flights are partitioned by request class so a foreground gate read can
   * never end up waiting behind a background flight the governor has throttled.
   * Defaults to the caller's ambient class, which is what its own read would
   * have used.
   */
  readonly requestClass?: RpcRequestClass;
}

/**
 * One shared retry. A joiner handed an indefinite outcome re-reads through the
 * successor flight. If that one is indefinite too, its initiator receives the
 * physical error while another joiner receives a caller-local exhaustion error,
 * so a permanently failing endpoint cannot spin or leak one caller's failure
 * to another.
 */
const MAX_JOINER_RETRIES = 1;

const ABANDONED_FLIGHT_MESSAGE =
  'Context Graph live authority read has no active waiters';
const JOIN_RETRY_EXHAUSTED_MESSAGE =
  'Context Graph live authority shared retry was exhausted';

function joinRetryExhaustedError(): Error {
  const error = new Error(JOIN_RETRY_EXHAUSTED_MESSAGE);
  error.name = 'ContextGraphLiveAuthorityJoinRetryExhaustedError';
  return error;
}

export class ContextGraphLiveAuthorityCoalescer<V> {
  readonly #partitions: Readonly<
    Record<
      RpcRequestClass,
      SequencedDeferredKeyedFlight<string, ContextGraphLiveAuthorityFlightOutcome<V>>
    >
  >;

  readonly #isDefinitiveError: (error: unknown) => boolean;

  constructor(options: ContextGraphLiveAuthorityCoalescerOptions = {}) {
    const defer = options.defer ?? ((dispatch) => {
      // This is the only mechanism that starts the physical read. Keeping the
      // one-turn timer referenced lets an otherwise-idle one-shot consumer
      // finish the operation it is awaiting instead of exiting before dispatch.
      setTimeout(dispatch, 0);
    });
    const partition = () => new SequencedDeferredKeyedFlight<
      string,
      ContextGraphLiveAuthorityFlightOutcome<V>
    >({ defer, abandonmentMessage: ABANDONED_FLIGHT_MESSAGE });
    this.#partitions = Object.freeze({
      foreground: partition(),
      background: partition(),
    });
    this.#isDefinitiveError = options.isDefinitiveError ?? (() => false);
  }

  /**
   * `key` must carry the full lineage of the read — deployment, contract
   * address and graph id — so a bare numeric id another deployment is free to
   * reuse can never make two unrelated reads share a flight.
   */
  async run(
    key: string,
    load: (signal: AbortSignal) => Promise<V>,
    options: ContextGraphLiveAuthorityRunOptions = {},
  ): Promise<V> {
    options.signal?.throwIfAborted();
    const requestClass = options.requestClass ?? activeRpcRequestContext().requestClass;
    const partition = this.#partitions[requestClass];
    for (let retries = 0; ; retries += 1) {
      const { initiated, value: outcome } = await partition.run(
        key,
        async (flightSignal) => {
          try {
            const value = await withOwnedRpcRequestContext(
              { signal: flightSignal, requestClass },
              () => load(flightSignal),
            );
            return { kind: 'value', value };
          } catch (error) {
            return this.#classify(error);
          }
        },
        options.signal,
      );
      if (outcome.kind === 'value') return outcome.value;
      if (outcome.kind === 'definitive-error') throw outcome.error;
      // Indefinite: the initiator owns the failure of the read it started.
      if (initiated) throw outcome.error;
      if (retries >= MAX_JOINER_RETRIES) throw joinRetryExhaustedError();
      options.signal?.throwIfAborted();
    }
  }

  /**
   * Stop new callers from enrolling in flights opened before whatever changed
   * — a contract rotation, an adapter teardown. Enrolled callers keep the read
   * they are already sharing: it is still a live read they asked for, and
   * nothing it produces is retained for anyone else.
   */
  detachAll(): void {
    for (const partition of Object.values(this.#partitions)) partition.detachAll();
  }

  /**
   * The classifier is the only caller-supplied code on the settle path, and it
   * is reached ONLY from the catch above — so a classifier that threw would
   * leave the flight unsettled and hang every enrolled waiter until its own
   * deadline, which is the exact failure this module exists to prevent. An
   * unclassifiable fault therefore settles INDEFINITELY: the conservative side,
   * where it crosses to nobody and the initiator still receives its own error
   * rather than a synthetic one.
   */
  #classify(error: unknown): ContextGraphLiveAuthorityFlightOutcome<V> {
    try {
      if (this.#isDefinitiveError(error)) return { kind: 'definitive-error', error };
    } catch { /* unclassifiable: fall through */ }
    return { kind: 'indefinite-error', error };
  }

}
