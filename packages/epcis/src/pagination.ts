/** Bounds for the legacy offset-based SimpleEventQuery API. */
export const MAX_EPCIS_PAGE_SIZE = 1_000;
export const MAX_EPCIS_OFFSET = 10_000;

export class EpcisPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpcisPaginationError';
  }
}

function resolveEpcisPageSize(value: number | undefined, fallback: number): number {
  value ??= fallback;
  if (!Number.isSafeInteger(value)) throw new EpcisPaginationError('EPCIS page size must be a safe integer');
  return Math.min(Math.max(value, 1), MAX_EPCIS_PAGE_SIZE);
}

function resolveEpcisOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset > MAX_EPCIS_OFFSET) {
    throw new EpcisPaginationError(`EPCIS offset must be a safe integer no greater than ${MAX_EPCIS_OFFSET}; narrow the event or time filters`);
  }
  return Math.max(offset, 0);
}

/** A normalized request page, including its lookahead and continuation policy. */
export class EpcisPaginationPlan {
  readonly pageSize: number;
  readonly offset: number;
  readonly queryRowLimit: number;

  constructor(pageSize: number | undefined, offset: number | undefined, defaultPageSize = 30) {
    this.pageSize = resolveEpcisPageSize(pageSize, defaultPageSize);
    this.offset = resolveEpcisOffset(offset);
    this.queryRowLimit = this.pageSize + 1;
    Object.freeze(this);
  }

  take<T>(rows: T[]): { bindings: T[]; nextOffset?: number } {
    if (rows.length <= this.pageSize) return { bindings: rows };
    const nextOffset = this.offset + this.pageSize;
    if (nextOffset > MAX_EPCIS_OFFSET) {
      throw new EpcisPaginationError('EPCIS pagination limit reached; narrow the event or time filters to retrieve the remaining events');
    }
    return { bindings: rows.slice(0, this.pageSize), nextOffset };
  }
}
