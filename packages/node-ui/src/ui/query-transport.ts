import { fetchBoundedJson } from './http.js';

/** Finite transport budgets for automatic reads; console execution opts out. */
export const AUTOMATIC_QUERY_TIMEOUT_MS = 60_000;
export const AUTOMATIC_QUERY_MAX_BYTES = 8 * 1024 * 1024;

export class QueryResponseLimitError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Query response exceeded ${maxBytes} bytes. Use a narrower query to inspect further data.`);
    this.name = 'QueryResponseLimitError';
  }
}

/** Query policy stays here; shared HTTP owns deadline, decoding and cancellation. */
export function fetchQueryJson(
  url: string,
  init: RequestInit,
  limits: { timeoutMs: number | null; maxResponseBytes: number | null },
  onResponse: (response: Response) => void,
): Promise<{ response: Response; body: unknown }> {
  return fetchBoundedJson(url, init, { ...limits, onResponse,
    limitError: maxBytes => new QueryResponseLimitError(maxBytes) });
}
