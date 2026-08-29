import { Rfc64ExactBindingsReadResultErrorV1 } from
  './rfc64-exact-bindings-read-capability.js';

export const WORKER_ERROR_CODES_V1 = Object.freeze({
  RFC64_EXACT_BINDINGS_RESULT: 'RFC64_EXACT_BINDINGS_RESULT_V1',
} as const);

export type WorkerErrorCodeV1 =
  (typeof WORKER_ERROR_CODES_V1)[keyof typeof WORKER_ERROR_CODES_V1];

export interface WorkerErrorEnvelopeV1 {
  readonly message: string;
  readonly code?: WorkerErrorCodeV1;
}

export function serializeWorkerErrorV1(error: unknown): WorkerErrorEnvelopeV1 {
  return Object.freeze({
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Rfc64ExactBindingsReadResultErrorV1
      ? { code: WORKER_ERROR_CODES_V1.RFC64_EXACT_BINDINGS_RESULT }
      : {}),
  });
}

export function deserializeWorkerErrorV1(
  envelope: WorkerErrorEnvelopeV1,
): Error {
  if (envelope.code === WORKER_ERROR_CODES_V1.RFC64_EXACT_BINDINGS_RESULT) {
    return new Rfc64ExactBindingsReadResultErrorV1(envelope.message);
  }
  return new Error(envelope.message);
}
