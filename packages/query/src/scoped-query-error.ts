export class ScopedQueryViolationError extends Error {
  constructor(message: string) {
    super(`Scoped query violation: ${message}`);
    this.name = 'ScopedQueryViolationError';
  }
}
