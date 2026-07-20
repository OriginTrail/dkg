import type { WalAdmissionReasonCode } from './types.js';

export type WalAdmissionErrorCode =
  | 'WAL_ADMISSION_INVALID_CONFIGURATION'
  | 'WAL_ADMISSION_PERSISTENCE_FAILED';

export class WalAdmissionError extends Error {
  constructor(
    readonly code: WalAdmissionErrorCode,
    message: string,
    readonly reasonCode?: WalAdmissionReasonCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalAdmissionError';
  }
}

export function admissionError(
  code: WalAdmissionErrorCode,
  message: string,
  reasonCode?: WalAdmissionReasonCode,
  cause?: unknown,
): never {
  throw new WalAdmissionError(code, message, reasonCode, cause === undefined ? undefined : { cause });
}
