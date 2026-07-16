// V10 PCA capability error. Thrown when DKGPublishingConvictionNFT is
// undeployed on the resolved Hub so callers can map it to HTTP 503.

export class PcaUnavailableError extends Error {
  readonly code = 'PCA_UNAVAILABLE' as const;
  constructor(message = 'DKGPublishingConvictionNFT not deployed on this Hub.') {
    super(message);
    this.name = 'PcaUnavailableError';
    Object.setPrototypeOf(this, PcaUnavailableError.prototype);
  }
}

export function isPcaUnavailableError(err: unknown): err is PcaUnavailableError {
  if (err instanceof PcaUnavailableError) return true;
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'PCA_UNAVAILABLE'
  );
}
