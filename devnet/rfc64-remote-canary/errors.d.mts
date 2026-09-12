export class RemoteCanaryError extends Error {
  readonly code: string;
  readonly category: string;
  readonly phase?: string;
}

export function failure(code: string, category: string, cause?: unknown): RemoteCanaryError;
export function invalid(code: string): never;
export function runPhaseV1<Result>(phase: string, operation: () => Result): Result;
