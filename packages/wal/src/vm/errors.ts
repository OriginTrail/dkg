export type WalVmProtocolErrorCode =
  | 'WAL_VM_INVALID'
  | 'WAL_VM_WRONG_OPERATION'
  | 'WAL_VM_BINDING_MISMATCH'
  | 'WAL_VM_PRIVATE_DISCLOSURE'
  | 'WAL_VM_FINALITY_POLICY';

export class WalVmProtocolError extends Error {
  constructor(
    readonly code: WalVmProtocolErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalVmProtocolError';
  }
}

export function walVmError(
  code: WalVmProtocolErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WalVmProtocolError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
