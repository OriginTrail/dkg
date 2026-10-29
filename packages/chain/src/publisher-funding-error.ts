import { InsufficientPublisherFundsError } from './evm-adapter-errors.js';

/** Native-gas routing evidence only. This never grants transaction replay authority. */
export function isPublisherNativeGasFailure(error: unknown): boolean {
  if (hasNativeGasFacts(error)) return true;
  try {
    return error instanceof InsufficientPublisherFundsError
      && (error.nativeGasShortfall === true || hasNativeGasFacts(error.cause));
  } catch { return false; }
}

/** Only the chain-owned funding wrapper's immediate cause is inspected. */
function hasNativeGasFacts(error: unknown): boolean {
  try {
    const record = error as { code?: unknown; message?: unknown } | null | undefined;
    const code = record?.code;
    const message = typeof error === 'string' ? error : typeof record?.message === 'string' ? record.message : '';
    const lower = message.toLowerCase();
    return code === 'PUBLISHER_GAS_FUNDING_UNAVAILABLE'
      || (!lower.includes('revert') && (code === 'INSUFFICIENT_FUNDS' || /insufficient funds for gas\b/.test(lower)));
  } catch { return false; }
}
