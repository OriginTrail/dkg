export interface SwmMetaRetentionLimits {
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
export type SwmMetaRetentionExhaustionV1 = 'prefix' | 'shared';

export interface SwmMetaRetentionReservation {
  maxRows: number;
  maxBytesEstimate: number;
  /** Set only when this reservation admits no rows or no bytes. */
  exhaustion: SwmMetaRetentionExhaustionV1 | null;
  /** Atomically consume this reservation while replacing the lease's prefix. */
  commitReplace(rows: number, bytesEstimate: number): void;
  release(): void;
}

export interface SwmMetaRetentionLease {
  /** Reserve append capacity before a page fetch starts. */
  reserve(): SwmMetaRetentionReservation;
  /** Atomically replace this lease's retained size after a fetched tail. */
  replace(rows: number, bytesEstimate: number): void;
  release(): void;
}

export class SwmMetaRetentionBudgetError extends Error {
  readonly code = 'SELECTED_SWM_META_RETENTION_LIMIT' as const;

  constructor(
    readonly dimension: 'rows' | 'bytes',
    readonly actual: number,
    readonly limit: number,
  ) {
    super(`SWM metadata retention ${dimension} ${actual} exceeds limit ${limit}`);
    // Keep the released selected API's observable error identity.
    this.name = 'SelectedSwmMetaRetentionBudgetError';
  }
}

/**
 * Process-local retained-prefix budget shared by overlapping ordinary and selected calls.
 *
 * A lease starts empty. `reserve()` atomically removes append capacity from the
 * process-wide pool before network I/O starts, so overlapping ordinary and selected calls
 * cannot each observe and allocate the same free allowance. A reservation is
 * either committed into the lease's retained prefix or released on failure.
 */
export function createSwmMetaRetentionBudget(
  input: SwmMetaRetentionLimits,
): { lease(): SwmMetaRetentionLease } {
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
  const entries = new Map<symbol, { rows: number; bytesEstimate: number }>();
  const reservations = new Map<
    symbol,
    { owner: symbol; rows: number; bytesEstimate: number }
  >();
  let rows = 0;
  let bytesEstimate = 0;
  let reservedRows = 0;
  let reservedBytesEstimate = 0;

  const validateRetainedSize = (nextRows: number, nextBytesEstimate: number) => {
    if (!Number.isSafeInteger(nextRows) || nextRows < 0) {
      throw new Error(`Invalid SWM metadata retained rows: ${nextRows}`);
    }
    if (!Number.isSafeInteger(nextBytesEstimate) || nextBytesEstimate < 0) {
      throw new Error(
        `Invalid SWM metadata retained bytes estimate: ${nextBytesEstimate}`,
      );
    }
  };

  return {
    lease() {
      const id = Symbol('swm-meta-retention');
      entries.set(id, { rows: 0, bytesEstimate: 0 });
      let released = false;
      const replace = (nextRows: number, nextBytesEstimate: number) => {
        if (released) {
          throw new Error('SWM metadata retention lease is released');
        }
        validateRetainedSize(nextRows, nextBytesEstimate);
        const current = entries.get(id) ?? { rows: 0, bytesEstimate: 0 };
        if (nextRows > limits.maxPrefixRows) {
          throw new SwmMetaRetentionBudgetError(
            'rows',
            nextRows,
            limits.maxPrefixRows,
          );
        }
        if (nextBytesEstimate > limits.maxPrefixBytesEstimate) {
          throw new SwmMetaRetentionBudgetError(
            'bytes',
            nextBytesEstimate,
            limits.maxPrefixBytesEstimate,
          );
        }
        const globalRows = rows - current.rows + nextRows;
        const globalBytes = bytesEstimate - current.bytesEstimate + nextBytesEstimate;
        if (globalRows + reservedRows > limits.maxRows) {
          throw new SwmMetaRetentionBudgetError(
            'rows',
            globalRows + reservedRows,
            limits.maxRows,
          );
        }
        if (globalBytes + reservedBytesEstimate > limits.maxBytesEstimate) {
          throw new SwmMetaRetentionBudgetError(
            'bytes',
            globalBytes + reservedBytesEstimate,
            limits.maxBytesEstimate,
          );
        }
        entries.set(id, { rows: nextRows, bytesEstimate: nextBytesEstimate });
        rows = globalRows;
        bytesEstimate = globalBytes;
      };
      return {
        reserve() {
          if (released) {
            throw new Error('SWM metadata retention lease is released');
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
          const reservationId = Symbol('swm-meta-reservation');
          reservations.set(reservationId, {
            owner: id,
            rows: reservationRows,
            bytesEstimate: reservationBytesEstimate,
          });
          reservedRows += reservationRows;
          reservedBytesEstimate += reservationBytesEstimate;
          let reservationReleased = false;
          const releaseReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            const reservation = reservations.get(reservationId);
            if (!reservation) return;
            reservations.delete(reservationId);
            reservedRows -= reservation.rows;
            reservedBytesEstimate -= reservation.bytesEstimate;
          };
          // A lease at its own prefix ceiling stays exhausted no matter what
          // the rest of the pool does, so that case is reported first.
          const prefixExhausted = limits.maxPrefixRows - current.rows <= 0
            || limits.maxPrefixBytesEstimate - current.bytesEstimate <= 0;
          const exhaustion: SwmMetaRetentionExhaustionV1 | null =
            reservationRows > 0 && reservationBytesEstimate > 0
              ? null
              : prefixExhausted
                ? 'prefix'
                : 'shared';
          return {
            maxRows: reservationRows,
            maxBytesEstimate: reservationBytesEstimate,
            exhaustion,
            commitReplace(nextRows, nextBytesEstimate) {
              if (reservationReleased) {
                throw new Error('SWM metadata retention reservation is released');
              }
              validateRetainedSize(nextRows, nextBytesEstimate);
              if (
                nextRows - current.rows > reservationRows
                || nextBytesEstimate - current.bytesEstimate > reservationBytesEstimate
              ) {
                releaseReservation();
                throw new SwmMetaRetentionBudgetError(
                  nextRows - current.rows > reservationRows ? 'rows' : 'bytes',
                  nextRows - current.rows > reservationRows
                    ? nextRows - current.rows
                    : nextBytesEstimate - current.bytesEstimate,
                  nextRows - current.rows > reservationRows
                    ? reservationRows
                    : reservationBytesEstimate,
                );
              }
              releaseReservation();
              replace(nextRows, nextBytesEstimate);
            },
            release: releaseReservation,
          };
        },
        replace,
        release() {
          if (released) return;
          released = true;
          for (const [reservationId, reservation] of reservations) {
            if (reservation.owner !== id) continue;
            reservations.delete(reservationId);
            reservedRows -= reservation.rows;
            reservedBytesEstimate -= reservation.bytesEstimate;
          }
          const current = entries.get(id);
          if (!current) return;
          entries.delete(id);
          rows -= current.rows;
          bytesEstimate -= current.bytesEstimate;
        },
      };
    },
  };
}
