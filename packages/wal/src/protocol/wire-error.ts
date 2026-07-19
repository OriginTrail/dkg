import type { ProtocolTuple } from './schema.js';
import { WAL_WIRE_ERROR_CODE } from './wire-types.js';

export class WalWireError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly detailCode: number | null = null,
    readonly retryAfterMs: bigint | null = null,
    readonly requestId?: Uint8Array,
  ) {
    super(message);
    this.name = 'WalWireError';
  }

  toTuple(): ProtocolTuple<'ErrorV1'> {
    return [
      BigInt(this.code),
      this.retryAfterMs,
      this.detailCode === null ? null : BigInt(this.detailCode),
    ];
  }
}

export function asWalWireError(error: unknown): WalWireError {
  if (error instanceof WalWireError) return error;
  return new WalWireError(
    WAL_WIRE_ERROR_CODE.INTERNAL_UNAVAILABLE,
    error instanceof Error ? error.message : 'internal provider failure',
  );
}
