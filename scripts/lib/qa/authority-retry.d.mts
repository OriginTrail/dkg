export * from '../../../packages/core/runtime/daemon-authority-retry.mjs';

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
