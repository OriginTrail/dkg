export const READ_AUTHORITY_CODE: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE';
export const AUTHORITY_CODE: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE';
export const RETRYABLE_AUTHORITY_CODES: readonly string[];
export const AUTHORITY_RETRY_DELAYS_MS: readonly number[];
export const AUTHORITY_RETRY_MAX_DELAY_MS: number;
export function isRetryableAuthorityAnswer(status: number, body: unknown, codes?: readonly string[]): boolean;
export function retryAfterMs(header: string | null | undefined, nowMs?: number): number | undefined;
export function authorityRetryDelayMs(retry: number, retryAfter: string | null | undefined, nowMs?: number): number | null;
