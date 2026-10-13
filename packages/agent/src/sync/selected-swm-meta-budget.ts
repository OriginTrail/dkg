export interface SelectedSwmMetaRetentionLimits {
  maxRows: number;
  maxBytesEstimate: number;
  maxPrefixRows: number;
  maxPrefixBytesEstimate: number;
}

/**
 * Why a reservation carries no append capacity.
 *
 * `prefix` is this lease's own ceiling: no later pass can widen it, so the
 * caller must keep failing closed on an over-long prefix. `shared` is
 * transient contention from other leases, which a later pass can clear — the
 * caller must not spend a fetch that is guaranteed to exceed a zero allowance.
 */
export type SelectedSwmMetaRetentionExhaustionV1 = 'prefix' | 'shared';

export interface SelectedSwmMetaRetentionReservation {
  maxRows: number;
  maxBytesEstimate: number;
  /** Set only when this reservation admits no rows or no bytes. */
  exhaustion: SelectedSwmMetaRetentionExhaustionV1 | null;
  /**
   * Atomically consume this reservation while replacing the lease's prefix.
   * `complete` says that the prefix is the whole manifest. Without it the
   * transfer is taken to come back for the rest of its allowance, and the pool
   * keeps that room from waiting leases until `endRound()`.
   */
  commitReplace(rows: number, bytesEstimate: number, complete?: boolean): void;
  release(): void;
}

export interface SelectedSwmMetaRetentionLease {
  /** Reserve append capacity before a page fetch starts. */
  reserve(): SelectedSwmMetaRetentionReservation;
  /**
   * Reserve this lease's whole remaining prefix allowance, waiting for it
   * while another lease's fetch is in flight.
   *
   * The budget decides again whenever a reservation settles, a lease gives
   * rows back or a round ends, in the order the leases started to wait. It
   * grants the allowance only whole, and only when the pool then still has
   * room for the rest of the allowance of every lease whose transfer is
   * between two passes over an unfinished manifest. A waiting lease holds no
   * capacity.
   *
   * Resolves `null` after `timeoutMs`, when `signal` aborts, and as soon as
   * no other lease has a fetch in flight: the pool is then held by retained
   * prefixes, which only their owners or the retention clock give back, so
   * there is nothing bounded to wait for. A caller that is answered `null`
   * has no reservation and must not take one in its place: what is free then
   * is the room this operation kept for others.
   */
  reserveWholeAllowance(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SelectedSwmMetaRetentionReservation | null>;
  /** Atomically replace this lease's retained size after a fetched tail. */
  replace(rows: number, bytesEstimate: number): void;
  /**
   * Drop the retained prefix and reserve a fresh allowance in one step, taking
   * back any reservation this lease still has out. Waiting leases decide only
   * afterwards, so a transfer that starts its prefix over keeps its allowance.
   */
  restart(): SelectedSwmMetaRetentionReservation;
  /**
   * The round that fetched this lease's prefix has ended. The prefix stays
   * retained for a later round, which may never come: until that round
   * fetches for it again, the pool keeps no room for its next pass.
   */
  endRound(): void;
  release(): void;
}

export class SelectedSwmMetaRetentionBudgetError extends Error {
  readonly code = 'SELECTED_SWM_META_RETENTION_LIMIT' as const;

  constructor(
    readonly dimension: 'rows' | 'bytes',
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`Selected SWM metadata retention ${dimension} ${actual} exceeds limit ${limit}`);
    this.name = 'SelectedSwmMetaRetentionBudgetError';
  }
}

/** Largest delay a Node timer takes without firing at once. */
const MAX_CAPACITY_WAIT_MS = 2_147_483_647;

/**
 * Process-local retained-prefix budget shared by overlapping selected calls.
 *
 * A lease starts empty. `reserve()` atomically removes append capacity from the
 * process-wide pool before network I/O starts, so overlapping selected calls
 * cannot each observe and allocate the same free allowance. A reservation is
 * either committed into the lease's retained prefix or released on failure.
 */
export function createSelectedSwmMetaRetentionBudget(
  input: SelectedSwmMetaRetentionLimits,
): { lease(): SelectedSwmMetaRetentionLease } {
  const limits = {
    maxRows: Math.max(0, Math.floor(input.maxRows)),
    maxBytesEstimate: Math.max(0, Math.floor(input.maxBytesEstimate)),
    maxPrefixRows: Math.max(0, Math.min(
      Math.floor(input.maxPrefixRows),
      Math.floor(input.maxRows),
    )),
    maxPrefixBytesEstimate: Math.max(0, Math.min(
      Math.floor(input.maxPrefixBytesEstimate),
      Math.floor(input.maxBytesEstimate),
    )),
  };
  const entries = new Map<symbol, {
    rows: number;
    bytesEstimate: number;
    /**
     * The prefix is part of a manifest and its transfer is between two passes
     * of a running round: it will ask for the rest of its allowance.
     */
    expectsMore: boolean;
  }>();
  const reservations = new Map<
    symbol,
    { owner: symbol; rows: number; bytesEstimate: number }
  >();
  let rows = 0;
  let bytesEstimate = 0;
  let reservedRows = 0;
  let reservedBytesEstimate = 0;
  /** Leases waiting for a whole allowance, in the order they started to wait. */
  const allowanceWaiters = new Set<{ decide(): void }>();
  /**
   * Let every waiting lease decide again, after a change that can free
   * capacity, drop a claim on it or end the last fetch in flight. A grant is
   * a reservation made right here, so the next waiter in line sees the pool
   * without it.
   */
  const settleAllowanceWaiters = () => {
    for (const waiter of allowanceWaiters) waiter.decide();
  };

  const validateRetainedSize = (nextRows: number, nextBytesEstimate: number) => {
    if (!Number.isSafeInteger(nextRows) || nextRows < 0) {
      throw new Error(`Invalid selected SWM metadata retained rows: ${nextRows}`);
    }
    if (!Number.isSafeInteger(nextBytesEstimate) || nextBytesEstimate < 0) {
      throw new Error(
        `Invalid selected SWM metadata retained bytes estimate: ${nextBytesEstimate}`,
      );
    }
  };

  return {
    lease() {
      const id = Symbol('selected-swm-meta-retention');
      entries.set(id, { rows: 0, bytesEstimate: 0, expectsMore: false });
      let released = false;
      const replaceRetained = (
        nextRows: number,
        nextBytesEstimate: number,
        expectsMore: boolean,
      ) => {
        if (released) {
          throw new Error('Selected SWM metadata retention lease is released');
        }
        validateRetainedSize(nextRows, nextBytesEstimate);
        const current = entries.get(id) ?? { rows: 0, bytesEstimate: 0 };
        if (nextRows > limits.maxPrefixRows) {
          throw new SelectedSwmMetaRetentionBudgetError(
            'rows',
            nextRows,
            limits.maxPrefixRows,
          );
        }
        if (nextBytesEstimate > limits.maxPrefixBytesEstimate) {
          throw new SelectedSwmMetaRetentionBudgetError(
            'bytes',
            nextBytesEstimate,
            limits.maxPrefixBytesEstimate,
          );
        }
        const globalRows = rows - current.rows + nextRows;
        const globalBytes = bytesEstimate - current.bytesEstimate + nextBytesEstimate;
        if (globalRows + reservedRows > limits.maxRows) {
          throw new SelectedSwmMetaRetentionBudgetError(
            'rows',
            globalRows + reservedRows,
            limits.maxRows,
          );
        }
        if (globalBytes + reservedBytesEstimate > limits.maxBytesEstimate) {
          throw new SelectedSwmMetaRetentionBudgetError(
            'bytes',
            globalBytes + reservedBytesEstimate,
            limits.maxBytesEstimate,
          );
        }
        entries.set(id, { rows: nextRows, bytesEstimate: nextBytesEstimate, expectsMore });
        rows = globalRows;
        bytesEstimate = globalBytes;
      };
      /** Whether another lease has a fetch in flight, whatever it reserved. */
      const siblingFetchInFlight = () => {
        for (const reservation of reservations.values()) {
          if (reservation.owner !== id) return true;
        }
        return false;
      };
      /** Take back every reservation this lease still has out. */
      const dropOwnReservations = () => {
        for (const [reservationId, reservation] of reservations) {
          if (reservation.owner !== id) continue;
          reservations.delete(reservationId);
          reservedRows -= reservation.rows;
          reservedBytesEstimate -= reservation.bytesEstimate;
        }
      };
      /**
       * Whether this lease can take its whole remaining allowance now and
       * leave every other lease whose transfer is between two passes the rest
       * of its own allowance: what that transfer asks for with its next pass.
       * A lease that is fetching has that room reserved already.
       */
      const wholeAllowanceIsFree = () => {
        const current = entries.get(id) ?? { rows: 0, bytesEstimate: 0 };
        const needRows = limits.maxPrefixRows - current.rows;
        const needBytesEstimate = limits.maxPrefixBytesEstimate - current.bytesEstimate;
        if (needRows <= 0 || needBytesEstimate <= 0) return false;
        const fetching = new Set<symbol>();
        for (const reservation of reservations.values()) fetching.add(reservation.owner);
        let claimRows = 0;
        let claimBytesEstimate = 0;
        for (const [holder, held] of entries) {
          if (holder === id || fetching.has(holder) || !held.expectsMore) continue;
          if (held.rows === 0 && held.bytesEstimate === 0) continue;
          claimRows += limits.maxPrefixRows - held.rows;
          claimBytesEstimate += limits.maxPrefixBytesEstimate - held.bytesEstimate;
        }
        return limits.maxRows - rows - reservedRows >= needRows + claimRows
          && limits.maxBytesEstimate - bytesEstimate - reservedBytesEstimate
            >= needBytesEstimate + claimBytesEstimate;
      };
      const lease: SelectedSwmMetaRetentionLease = {
        reserve() {
          if (released) {
            throw new Error('Selected SWM metadata retention lease is released');
          }
          const current = entries.get(id) ?? { rows: 0, bytesEstimate: 0 };
          const reservationRows = Math.max(0, Math.min(
            limits.maxPrefixRows - current.rows,
            limits.maxRows - rows - reservedRows,
          ));
          const reservationBytesEstimate = Math.max(0, Math.min(
            limits.maxPrefixBytesEstimate - current.bytesEstimate,
            limits.maxBytesEstimate - bytesEstimate - reservedBytesEstimate,
          ));
          const reservationId = Symbol('selected-swm-meta-reservation');
          reservations.set(reservationId, {
            owner: id,
            rows: reservationRows,
            bytesEstimate: reservationBytesEstimate,
          });
          reservedRows += reservationRows;
          reservedBytesEstimate += reservationBytesEstimate;
          let reservationReleased = false;
          /** False when the reservation was settled or taken back before. */
          const removeReservation = () => {
            if (reservationReleased) return false;
            reservationReleased = true;
            const reservation = reservations.get(reservationId);
            if (!reservation) return false;
            reservations.delete(reservationId);
            reservedRows -= reservation.rows;
            reservedBytesEstimate -= reservation.bytesEstimate;
            return true;
          };
          const releaseReservation = () => {
            if (removeReservation()) settleAllowanceWaiters();
          };
          // A lease at its own prefix ceiling stays exhausted no matter what
          // the rest of the pool does, so that case is reported first.
          const prefixExhausted = limits.maxPrefixRows - current.rows <= 0
            || limits.maxPrefixBytesEstimate - current.bytesEstimate <= 0;
          const exhaustion: SelectedSwmMetaRetentionExhaustionV1 | null =
            reservationRows > 0 && reservationBytesEstimate > 0
              ? null
              : prefixExhausted
                ? 'prefix'
                : 'shared';
          return {
            maxRows: reservationRows,
            maxBytesEstimate: reservationBytesEstimate,
            exhaustion,
            commitReplace(nextRows, nextBytesEstimate, complete) {
              if (reservationReleased) {
                throw new Error('Selected SWM metadata retention reservation is released');
              }
              validateRetainedSize(nextRows, nextBytesEstimate);
              if (
                nextRows - current.rows > reservationRows
                || nextBytesEstimate - current.bytesEstimate > reservationBytesEstimate
              ) {
                releaseReservation();
                throw new SelectedSwmMetaRetentionBudgetError(
                  nextRows - current.rows > reservationRows ? 'rows' : 'bytes',
                  nextRows - current.rows > reservationRows
                    ? nextRows - current.rows
                    : nextBytesEstimate - current.bytesEstimate,
                  nextRows - current.rows > reservationRows
                    ? reservationRows
                    : reservationBytesEstimate,
                );
              }
              // The waiters decide once the committed prefix is counted: a
              // grant made between the two steps would spend the room the
              // prefix is about to take.
              removeReservation();
              try {
                replaceRetained(nextRows, nextBytesEstimate, complete !== true);
              } finally {
                settleAllowanceWaiters();
              }
            },
            release: releaseReservation,
          };
        },
        reserveWholeAllowance(timeoutMs, signal) {
          if (released || signal?.aborted || !(timeoutMs > 0)) return Promise.resolve(null);
          if (wholeAllowanceIsFree()) return Promise.resolve(lease.reserve());
          if (!siblingFetchInFlight()) return Promise.resolve(null);
          return new Promise<SelectedSwmMetaRetentionReservation | null>((resolve) => {
            const finish = (reservation: SelectedSwmMetaRetentionReservation | null) => {
              clearTimeout(timer);
              allowanceWaiters.delete(waiter);
              signal?.removeEventListener('abort', giveUp);
              resolve(reservation);
            };
            const giveUp = () => finish(null);
            const waiter = {
              decide: () => {
                if (released) finish(null);
                else if (wholeAllowanceIsFree()) finish(lease.reserve());
                else if (!siblingFetchInFlight()) finish(null);
              },
            };
            const timer = setTimeout(giveUp, Math.min(timeoutMs, MAX_CAPACITY_WAIT_MS));
            timer.unref?.();
            signal?.addEventListener('abort', giveUp, { once: true });
            allowanceWaiters.add(waiter);
          });
        },
        replace(nextRows, nextBytesEstimate) {
          replaceRetained(nextRows, nextBytesEstimate, false);
          settleAllowanceWaiters();
        },
        restart() {
          if (released) {
            throw new Error('Selected SWM metadata retention lease is released');
          }
          dropOwnReservations();
          replaceRetained(0, 0, false);
          const reservation = lease.reserve();
          settleAllowanceWaiters();
          return reservation;
        },
        endRound() {
          const current = entries.get(id);
          if (released || !current?.expectsMore) return;
          entries.set(id, { ...current, expectsMore: false });
          settleAllowanceWaiters();
        },
        release() {
          if (released) return;
          released = true;
          dropOwnReservations();
          const current = entries.get(id);
          if (current) {
            entries.delete(id);
            rows -= current.rows;
            bytesEstimate -= current.bytesEstimate;
          }
          settleAllowanceWaiters();
        },
      };
      return lease;
    },
  };
}
