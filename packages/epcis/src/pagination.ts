import { EpcisQueryValidationError } from './query-validation.js';
import type { EpcisPageParams } from './types.js';

/** Bounds for the legacy offset-based SimpleEventQuery API. */
export const MAX_EPCIS_PAGE_SIZE = 1_000;
export const MAX_EPCIS_OFFSET = 10_000;
export const DEFAULT_EPCIS_QUERY_LIMIT = 100;
export const DEFAULT_EPCIS_HTTP_PAGE_SIZE = 30;

function resolveEpcisPageSize(value: number): number {
  if (!Number.isSafeInteger(value)) throw new EpcisQueryValidationError('EPCIS page size must be a safe integer');
  return Math.min(Math.max(value, 1), MAX_EPCIS_PAGE_SIZE);
}

function resolveEpcisOffset(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isSafeInteger(offset) || offset > MAX_EPCIS_OFFSET) {
    throw new EpcisQueryValidationError(`EPCIS offset must be a safe integer no greater than ${MAX_EPCIS_OFFSET}; narrow the event or time filters`);
  }
  return Math.max(offset, 0);
}

/** Explicit row window: 1..1001 rows (including optional HTTP lookahead), offset 0..10000. */
export interface EpcisQueryWindow {
  readonly limit: number;
  readonly offset: number;
}

/** Validate explicit renderer windows without stripping the HTTP lookahead row. */
export function assertEpcisQueryWindow(window: EpcisQueryWindow): void {
  if (!Number.isSafeInteger(window.limit) || window.limit < 1 || window.limit > MAX_EPCIS_PAGE_SIZE + 1) {
    throw new EpcisQueryValidationError(`EPCIS query limit must be a safe integer from 1 to ${MAX_EPCIS_PAGE_SIZE + 1}`);
  }
  if (!Number.isSafeInteger(window.offset) || window.offset < 0 || window.offset > MAX_EPCIS_OFFSET) {
    throw new EpcisQueryValidationError(`EPCIS query offset must be a safe integer from 0 to ${MAX_EPCIS_OFFSET}`);
  }
}

export function resolveEpcisQueryWindow(input: { limit?: number; offset?: number }): EpcisQueryWindow {
  return Object.freeze({
    limit: resolveEpcisPageSize(input.limit ?? DEFAULT_EPCIS_QUERY_LIMIT),
    offset: resolveEpcisOffset(input.offset),
  });
}

/** HTTP-only lookahead and continuation policy around a normalized query window. */
export class EpcisHttpPage {
  readonly queryWindow: EpcisQueryWindow;
  private readonly pageSize: number;

  constructor(input: EpcisPageParams) {
    const page = resolveEpcisQueryWindow({
      limit: input.perPage ?? DEFAULT_EPCIS_HTTP_PAGE_SIZE,
      offset: input.offset,
    });
    this.pageSize = page.limit;
    this.queryWindow = Object.freeze({ limit: page.limit + 1, offset: page.offset });
    Object.freeze(this);
  }

  take<T>(rows: T[]): { bindings: T[]; nextOffset?: number } {
    if (rows.length <= this.pageSize) return { bindings: rows };
    const nextOffset = this.queryWindow.offset + this.pageSize;
    if (nextOffset > MAX_EPCIS_OFFSET) {
      throw new EpcisQueryValidationError('EPCIS pagination limit reached; narrow the event or time filters to retrieve the remaining events');
    }
    return { bindings: rows.slice(0, this.pageSize), nextOffset };
  }
}
