export const READ_AUTHORITY_CODE: 'CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE';
export const AUTHORITY_CODE: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE';
export const RETRYABLE_AUTHORITY_CODES: readonly string[];
export const AUTHORITY_RETRY_DELAYS_MS: readonly number[];
export const AUTHORITY_RETRY_MAX_DELAY_MS: number;

export function isRetryableAuthorityAnswer(status: number, json: unknown, codes?: readonly string[]): boolean;
export function retryAfterMs(header: string | null | undefined, nowMs?: number): number | undefined;
export function authorityRetryDelayMs(
  retry: number,
  retryAfter: string | null | undefined,
  nowMs?: number,
): number | null;

export interface AuthorityRetryAnswer {
  readonly status: number;
  readonly json: unknown;
  readonly retryAfter?: string | null;
}

export function askWithAuthorityRetry<T extends AuthorityRetryAnswer>(
  ask: () => Promise<T>,
  options?: {
    readonly codes?: readonly string[];
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRetry?: (retry: { readonly retry: number; readonly delayMs: number }) => void;
  },
): Promise<T>;
