const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 1000;
const DEFAULT_OFFSET = 0;

export interface Pagination {
  limit: number;
  offset: number;
}

export class PaginationError extends Error {
  public readonly field: 'limit' | 'offset';

  constructor(field: 'limit' | 'offset', message: string) {
    super(message);
    this.name = 'PaginationError';
    this.field = field;
  }
}

export function parsePagination(searchParams: URLSearchParams): Pagination {
  const limit = parsePositiveInt(searchParams.get('limit'), 'limit', DEFAULT_LIMIT);
  const offset = parsePositiveInt(searchParams.get('offset'), 'offset', DEFAULT_OFFSET);
  return {
    limit: Math.min(limit, MAX_LIMIT),
    offset,
  };
}

function parsePositiveInt(raw: string | null, field: 'limit' | 'offset', fallback: number): number {
  if (raw === null) return fallback;
  if (raw.trim().length === 0) {
    throw new PaginationError(field, `Invalid ${field}: empty value`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new PaginationError(field, `Invalid ${field}: "${raw}" is not an integer`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new PaginationError(field, `Invalid ${field}: ${raw} exceeds Number.MAX_SAFE_INTEGER`);
  }
  if (n < 0) {
    throw new PaginationError(field, `Invalid ${field}: ${raw} must be >= 0`);
  }
  return n;
}
