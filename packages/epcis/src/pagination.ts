/** Bounds for the legacy offset-based SimpleEventQuery API. */
export const MAX_EPCIS_PAGE_SIZE = 1_000;
export const MAX_EPCIS_OFFSET = 10_000;

export class EpcisPaginationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpcisPaginationError';
  }
}

export function resolveEpcisPageSize(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) throw new EpcisPaginationError('EPCIS page size must be a safe integer');
  return Math.min(Math.max(value, 1), MAX_EPCIS_PAGE_SIZE);
}

export function resolveEpcisOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset > MAX_EPCIS_OFFSET) {
    throw new EpcisPaginationError(`EPCIS offset must be a safe integer no greater than ${MAX_EPCIS_OFFSET}; narrow the event or time filters`);
  }
  return Math.max(offset, 0);
}
