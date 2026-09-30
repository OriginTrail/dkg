import { isStoreResponseTooLargeError } from './http-response-limit.js';

export interface GenericWorkerErrorEnvelopeV1 {
  readonly kind: 'generic';
  readonly name: string;
  readonly message: string;
  readonly code?: string;
}

export interface StoreResponseTooLargeWorkerErrorEnvelopeV1 {
  readonly kind: 'store-response-too-large';
  readonly name: string;
  readonly message: string;
  readonly code: 'STORE_RESPONSE_TOO_LARGE';
  readonly maxBytes: number;
  readonly actualBytes: number | bigint;
}

export type WorkerErrorEnvelopeV1 =
  | GenericWorkerErrorEnvelopeV1
  | StoreResponseTooLargeWorkerErrorEnvelopeV1;

export type WorkerResponseV1 =
  | { readonly id: number; readonly result: unknown }
  | { readonly id: number; readonly error: WorkerErrorEnvelopeV1 };

/** Keep generic errors minimal; only recognized variants receive typed metadata. */
export function serializeWorkerErrorV1(error: unknown): WorkerErrorEnvelopeV1 {
  if (isStoreResponseTooLargeError(error)) {
    const candidateName = (error as { readonly name?: unknown }).name;
    return Object.freeze({
      kind: 'store-response-too-large',
      name: typeof candidateName === 'string'
        ? candidateName
        : 'StoreResponseTooLargeError',
      message: error.message,
      code: error.code,
      maxBytes: error.maxBytes,
      actualBytes: error.actualBytes,
    });
  }
  if (!(error instanceof Error)) {
    return Object.freeze({ kind: 'generic', name: 'Error', message: String(error) });
  }
  const code = ownString(error, 'code');
  return Object.freeze({
    kind: 'generic',
    name: error.name || 'Error',
    message: error.message,
    ...(code === undefined ? {} : { code }),
  });
}

export function deserializeWorkerErrorV1(
  envelope: WorkerErrorEnvelopeV1,
): Error {
  if (envelope.kind === 'store-response-too-large') {
    const error = new Error(envelope.message) as Error & {
      code: 'STORE_RESPONSE_TOO_LARGE';
      maxBytes: number;
      actualBytes: number | bigint;
    };
    error.name = envelope.name;
    error.code = envelope.code;
    error.maxBytes = envelope.maxBytes;
    error.actualBytes = envelope.actualBytes;
    return error;
  }
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
