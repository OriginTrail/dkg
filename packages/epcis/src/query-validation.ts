/** Invalid event filters or row windows, independent of any transport. */
export class EpcisQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EpcisQueryValidationError';
  }
}
