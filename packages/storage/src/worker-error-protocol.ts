export interface WorkerErrorEnvelopeV1 {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly maxBytes?: number;
  readonly actualBytes?: number | bigint;
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
  const maxBytes = ownNumber(error, 'maxBytes');
  const actualBytes = ownNumberOrBigInt(error, 'actualBytes');
  return Object.freeze({
    name: error.name || 'Error',
    message: error.message,
    ...(code === undefined ? {} : { code }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(actualBytes === undefined ? {} : { actualBytes }),
  });
}

export function deserializeWorkerErrorV1(
  envelope: WorkerErrorEnvelopeV1,
): Error {
  const error = new Error(envelope.message) as Error & {
    code?: string;
    maxBytes?: number;
    actualBytes?: number | bigint;
  };
  error.name = envelope.name;
  if (envelope.code !== undefined) error.code = envelope.code;
  if (envelope.maxBytes !== undefined) error.maxBytes = envelope.maxBytes;
  if (envelope.actualBytes !== undefined) error.actualBytes = envelope.actualBytes;
  return error;
}

function ownNumber(input: object, key: string): number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'number'
    ? descriptor.value
    : undefined;
}

function ownNumberOrBigInt(input: object, key: string): number | bigint | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && (typeof descriptor.value === 'number' || typeof descriptor.value === 'bigint')
    ? descriptor.value
    : undefined;
}

function ownString(input: object, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}
