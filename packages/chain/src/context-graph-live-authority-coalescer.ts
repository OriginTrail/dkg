// SPDX-License-Identifier: Apache-2.0

import {
  activeRpcRequestContext,
  withOwnedRpcRequestContext,
  type RpcRequestClass,
} from './rpc-request-transport.js';
import { waitForSignal } from './keyed-ttl-single-flight-cache.js';

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
 * BATCHING, NOT WAITING (review R6/F4). A flight is created on the first
 * caller but DISPATCHED one macrotask later, so every caller arriving in the
 * same turn shares it. A caller arriving after dispatch never waits for the
 * running flight to settle — it opens (or joins) the SUCCESSOR, immediately.
 * The rejected alternative was to make late callers wait up to ~750 ms for the
 * running flight: with dense-but-serial callers almost every caller is late,
 * and adding that wait to its own read would push reads that succeed today
 * past the caller's 2,500 ms fail-closed budget.
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
 * they re-read through ONE shared successor, never N private ones.
 *
 * OWNERSHIP OF CANCELLATION. The physical read runs under
 * {@link withOwnedRpcRequestContext} with the flight's OWN controller, so
 * neither the initiator's ambient signal nor its request class reaches the
 * governor. A waiter's signal detaches that waiter only; when the last waiter
 * leaves, the flight is aborted so abandoned RPC admission cannot outlive its
 * callers.
 */

/** A settled flight, split by whether a joiner may take the outcome. */
type ContextGraphLiveAuthorityFlightOutcome<V> =
  | { readonly kind: 'value'; readonly value: V }
  | { readonly kind: 'definitive-error'; readonly error: unknown }
  | { readonly kind: 'indefinite-error'; readonly error: unknown };

interface ContextGraphLiveAuthorityFlight<V> {
  readonly controller: AbortController;
  readonly outcome: Promise<ContextGraphLiveAuthorityFlightOutcome<V>>;
  waiters: number;
  dispatched: boolean;
  settled: boolean;
}

interface ContextGraphLiveAuthorityPartition<V> {
  /** The one flight new callers may still enrol in: created, not dispatched. */
  readonly pending: Map<string, ContextGraphLiveAuthorityFlight<V>>;
}

export interface ContextGraphLiveAuthorityCoalescerOptions {
  /**
   * How dispatch is deferred so same-turn callers batch into one read. A
   * macrotask by default; tests inject a deterministic scheduler.
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
 * successor flight; if that one is indefinite too the failure is its own read's
 * and is raised, so a permanently failing endpoint cannot spin here.
 */
const MAX_JOINER_RETRIES = 1;

const ABANDONED_FLIGHT_MESSAGE =
  'Context Graph live authority read has no active waiters';

function abandonedFlightError(): Error {
  const error = new Error(ABANDONED_FLIGHT_MESSAGE);
  error.name = 'AbortError';
  return error;
}

export class ContextGraphLiveAuthorityCoalescer<V> {
  readonly #partitions: Readonly<
    Record<RpcRequestClass, ContextGraphLiveAuthorityPartition<V>>
  >;

  readonly #defer: (dispatch: () => void) => void;

  readonly #isDefinitiveError: (error: unknown) => boolean;

  constructor(options: ContextGraphLiveAuthorityCoalescerOptions = {}) {
    this.#partitions = Object.freeze({
      foreground: { pending: new Map<string, ContextGraphLiveAuthorityFlight<V>>() },
      background: { pending: new Map<string, ContextGraphLiveAuthorityFlight<V>>() },
    });
    this.#defer = options.defer ?? ((dispatch) => {
      const timer = setTimeout(dispatch, 0);
      timer.unref?.();
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
      const pending = partition.pending.get(key);
      const initiated = pending === undefined;
      const flight = pending ?? this.#open(partition, key, load, requestClass);
      flight.waiters += 1;
      let outcome: ContextGraphLiveAuthorityFlightOutcome<V>;
      try {
        // The flight's promise never rejects, so this can only reject for THIS
        // caller's own signal.
        outcome = await waitForSignal(flight.outcome, options.signal);
      } finally {
        this.#leave(partition, key, flight);
      }
      if (outcome.kind === 'value') return outcome.value;
      if (outcome.kind === 'definitive-error') throw outcome.error;
      // Indefinite: the initiator owns the failure of the read it started.
      if (initiated || retries >= MAX_JOINER_RETRIES) throw outcome.error;
      options.signal?.throwIfAborted();
    }
  }

  /**
   * Stop new callers from enrolling in flights opened before whatever changed
   * — a contract rotation, an adapter teardown. Enrolled callers keep the read
   * they are already sharing: it is still a live read they asked for, and
   * nothing it produces is retained for anyone else.
   */
  invalidateAll(): void {
    for (const partition of Object.values(this.#partitions)) partition.pending.clear();
  }

  #open(
    partition: ContextGraphLiveAuthorityPartition<V>,
    key: string,
    load: (signal: AbortSignal) => Promise<V>,
    requestClass: RpcRequestClass,
  ): ContextGraphLiveAuthorityFlight<V> {
    const controller = new AbortController();
    let settle!: (outcome: ContextGraphLiveAuthorityFlightOutcome<V>) => void;
    const outcome = new Promise<ContextGraphLiveAuthorityFlightOutcome<V>>((resolve) => {
      settle = resolve;
    });
    const flight: ContextGraphLiveAuthorityFlight<V> = {
      controller,
      outcome,
      waiters: 0,
      dispatched: false,
      settled: false,
    };
    const complete = (settled: ContextGraphLiveAuthorityFlightOutcome<V>) => {
      if (flight.settled) return;
      flight.settled = true;
      settle(settled);
    };
    partition.pending.set(key, flight);
    this.#defer(() => {
      // Detach BEFORE any physical work starts. From here on a new caller opens
      // a successor, so nobody is ever answered by a read issued before it
      // asked — the property that lets a gate share a read at all.
      if (partition.pending.get(key) === flight) partition.pending.delete(key);
      flight.dispatched = true;
      if (flight.waiters === 0) {
        // Everyone left while dispatch was deferred: no read is owed.
        controller.abort(abandonedFlightError());
        complete({ kind: 'indefinite-error', error: abandonedFlightError() });
        return;
      }
      void (async () => {
        try {
          const value = await withOwnedRpcRequestContext(
            { signal: controller.signal, requestClass },
            () => load(controller.signal),
          );
          complete({ kind: 'value', value });
        } catch (error) {
          complete(this.#isDefinitiveError(error)
            ? { kind: 'definitive-error', error }
            : { kind: 'indefinite-error', error });
        }
      })();
    });
    return flight;
  }

  #leave(
    partition: ContextGraphLiveAuthorityPartition<V>,
    key: string,
    flight: ContextGraphLiveAuthorityFlight<V>,
  ): void {
    flight.waiters -= 1;
    if (flight.waiters > 0) return;
    if (partition.pending.get(key) === flight) partition.pending.delete(key);
    if (flight.settled) return;
    // Nobody is waiting for this read any more; abandoned RPC admission must
    // not outlive its callers. A flight abandoned before dispatch is stopped by
    // the waiter check inside the deferred dispatch, so it costs no RPC at all.
    flight.controller.abort(abandonedFlightError());
  }
}
