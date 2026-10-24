export interface WorkerErrorEnvelopeV1 {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export type WorkerResponseV1 =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: WorkerErrorEnvelopeV1 };

/** Generic transport only: feature boundaries own typed reconstruction. */
export function serializeWorkerErrorV1(error: unknown): WorkerErrorEnvelopeV1 {
  if (!(error instanceof Error)) {
    return Object.freeze({ name: 'Error', message: String(error) });
  }
  const code = ownString(error, 'code');
  return Object.freeze({
    name: error.name || 'Error',
    message: error.message,
    ...(code === undefined ? {} : { code }),
  });
}

export function deserializeWorkerErrorV1(
  envelope: WorkerErrorEnvelopeV1,
): Error {
  const error = new Error(envelope.message) as Error & { code?: string };
  error.name = envelope.name;
  if (envelope.code !== undefined) error.code = envelope.code;
  return error;
}

function ownString(input: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}
