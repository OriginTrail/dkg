/**
 * Case-insensitive EVM address equality — the single shared implementation.
 *
 * Kept as a pure leaf module so publishing and identity-wallet features share
 * it without either domain owning the other.
 */
export const eqAddress = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
