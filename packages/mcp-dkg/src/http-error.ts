export class DkgHttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'DkgHttpError';
    this.status = status;
    this.body = body;
  }
}
