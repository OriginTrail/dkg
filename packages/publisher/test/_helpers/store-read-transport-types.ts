import { StoreOperationTimeoutError, isStoreReadTransportFailure } from '@origintrail-official/dkg-storage';

/** GH#3419: an ordinary mutation timeout must remain usable in the negative branch. */
export function ordinaryTimeoutRemainsVisible(error: StoreOperationTimeoutError): string {
  if (!isStoreReadTransportFailure(error)) return error.outcome;
  return error.message;
}

/** The positive branch still narrows unknown to a read error with diagnostics. */
export function readDiagnostic(error: unknown): string | undefined {
  if (isStoreReadTransportFailure(error)) return error.message;
  return undefined;
}
