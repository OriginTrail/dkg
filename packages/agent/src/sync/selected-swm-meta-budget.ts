export interface SelectedSwmMetaRetentionLimits {
  maxRows: number;
  maxBytesEstimate: number;
  maxPrefixRows: number;
  maxPrefixBytesEstimate: number;
}

export interface SelectedSwmMetaRetentionReservation {
  maxRows: number;
  maxBytesEstimate: number;
  /** Atomically consume this reservation while replacing the lease's prefix. */
  commitReplace(rows: number, bytesEstimate: number): void;
  release(): void;
}

export interface SelectedSwmMetaRetentionLease {
  /** Reserve append capacity before a page fetch starts. */
  reserve(): SelectedSwmMetaRetentionReservation;
  /** Atomically replace this lease's retained size after a fetched tail. */
  replace(rows: number, bytesEstimate: number): void;
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
      entries.set(id, { rows: 0, bytesEstimate: 0 });
      let released = false;
      const replace = (nextRows: number, nextBytesEstimate: number) => {
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
        entries.set(id, { rows: nextRows, bytesEstimate: nextBytesEstimate });
        rows = globalRows;
        bytesEstimate = globalBytes;
      };
      return {
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
          const releaseReservation = () => {
            if (reservationReleased) return;
            reservationReleased = true;
            const reservation = reservations.get(reservationId);
            if (!reservation) return;
            reservations.delete(reservationId);
            reservedRows -= reservation.rows;
            reservedBytesEstimate -= reservation.bytesEstimate;
          };
          return {
            maxRows: reservationRows,
            maxBytesEstimate: reservationBytesEstimate,
            commitReplace(nextRows, nextBytesEstimate) {
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
