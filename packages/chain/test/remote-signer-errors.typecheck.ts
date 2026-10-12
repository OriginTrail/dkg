import {
  RemoteSignerError,
  isRemoteSignerError,
  type RemoteSignerErrorCode,
  type RemoteSignerFailureCode,
  type RemoteSignerFailureLike,
} from '../src/index.js';

// Every code a RemoteSignerError carries is a remote-signer failure code, and the error has the recognized shape.
export const everyCodeIsAFailureCode = (code: RemoteSignerErrorCode): RemoteSignerFailureCode => code;
export const errorIsAFailure: RemoteSignerFailureLike = new RemoteSignerError('REMOTE_SIGNER_REJECTED', 'refused');
// So is a code-only record, including one with a code this version does not name.
export const codeOnly: RemoteSignerFailureLike = { code: 'REMOTE_SIGNER_SOMETHING_NEWER' };
// @ts-expect-error a code without the prefix is not a remote-signer failure code
export const otherCode: RemoteSignerFailureCode = 'RPC_TIMEOUT';

/** The guard narrows to the code it checks, and promises nothing else. */
export function codeOf(value: unknown): RemoteSignerFailureCode | undefined {
  if (!isRemoteSignerError(value)) return undefined;
  // @ts-expect-error a code-only record has no message
  void value.message;
  return value.code;
}
