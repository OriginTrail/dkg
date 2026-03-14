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
