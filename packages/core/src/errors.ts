/**
 * Shared error hierarchy for the DKG V9 stack.
 *
 * DKGError is the base class for all domain-specific errors. Subclasses
 * distinguish between user-facing errors (nice message, no stack) and
 * internal errors (full diagnostic info).
 */

/** Base class for all DKG domain errors. */
export class DKGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DKGError';
  }
}

/**
 * An error caused by invalid user input or a pre-condition that the user
 * can fix. CLI handlers can show these messages directly without a stack trace.
 */
export class DKGUserError extends DKGError {
  constructor(message: string) {
    super(message);
    this.name = 'DKGUserError';
  }
}

/**
 * An internal/unexpected error. These should be logged with full context
 * and typically indicate a bug or infrastructure issue.
 */
export class DKGInternalError extends DKGError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DKGInternalError';
  }
}

/** HTTP request body exceeded the size limit. */
export class PayloadTooLargeError extends DKGUserError {
  constructor(maxBytes?: number) {
    super(
      maxBytes != null
        ? `Request body too large (>${maxBytes} bytes)`
        : 'Payload too large',
    );
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Safely extract a human-readable error message from an unknown thrown value.
 * Prefer this over `catch (err: any) { err.message }` to maintain type safety.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Check whether an unknown value is an Error with a specific `code` property
 * (common in Node.js system errors like ENOENT, ECONNREFUSED, etc.).
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
