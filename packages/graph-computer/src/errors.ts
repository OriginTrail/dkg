export interface GraphComputerErrorDetails {
  status?: number;
  details?: unknown;
  /** Retain this ID after an ambiguous invocation failure; do not create a new execution. */
  invocationId?: string;
  cause?: unknown;
}

export class GraphComputerError extends Error {
  readonly status?: number;
  readonly details?: unknown;
  readonly invocationId?: string;

  constructor(readonly code: string, message: string, options: GraphComputerErrorDetails = {}) {
    super(message, { cause: options.cause });
    this.name = 'GraphComputerError';
    this.status = options.status;
    this.details = options.details;
    this.invocationId = options.invocationId;
  }
}
