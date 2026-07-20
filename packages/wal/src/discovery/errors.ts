import type { WalProviderReadiness } from './types.js';

export type WalProviderDiscoveryErrorCode =
  | 'WAL_PROVIDER_INVALID_CONFIGURATION'
  | 'WAL_PROVIDER_INVALID_MANIFEST'
  | 'WAL_PROVIDER_UNAUTHORIZED'
  | 'WAL_PROVIDER_UNAVAILABLE';

export class WalProviderDiscoveryError extends Error {
  constructor(
    readonly code: WalProviderDiscoveryErrorCode,
    message: string,
    readonly readiness?: Exclude<WalProviderReadiness, 'provider-ready' | 'denied'>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WalProviderDiscoveryError';
  }
}

export function providerError(
  code: WalProviderDiscoveryErrorCode,
  message: string,
  readiness?: Exclude<WalProviderReadiness, 'provider-ready' | 'denied'>,
  cause?: unknown,
): never {
  throw new WalProviderDiscoveryError(code, message, readiness, cause === undefined ? undefined : { cause });
}
