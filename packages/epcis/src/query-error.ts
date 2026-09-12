/** Request failures translated to HTTP at the EPCIS route boundary. */
export class EpcisQueryError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'EpcisQueryError';
  }
}
