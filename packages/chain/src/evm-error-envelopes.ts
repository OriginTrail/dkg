// SPDX-License-Identifier: Apache-2.0

/**
 * Where ethers and JSON-RPC providers put the errors they wrap: the provider
 * error (`info.error`), a re-thrown `cause`, or a library's `originalError`.
 * The one place that knows these envelope shapes; each decoder decides what
 * it accepts from them.
 */
const EVM_ERROR_WRAPPER_KEYS = ['error', 'cause', 'info', 'data', 'originalError'] as const;
const MAX_EVM_ERROR_WRAPPER_DEPTH = 5;

export type RawRevertData = string | Uint8Array;

/**
 * Visit an EVM error and each error it wraps, depth-first in wrapper-key
 * order and once each. `depth` is 0 for the error itself.
 */
export function forEachEvmErrorEnvelope(
  error: unknown,
  visit: (envelope: Record<string, unknown>, depth: number) => void,
): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): void => {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > MAX_EVM_ERROR_WRAPPER_DEPTH) return;
    seen.add(value);
    const envelope = value as Record<string, unknown>;
    visit(envelope, depth);
    for (const key of EVM_ERROR_WRAPPER_KEYS) walk(envelope[key], depth + 1);
  };
  walk(error, 0);
}

/** Revert data in an envelope's own structured fields: never its message text or transaction calldata. */
export function structuredRevertData(envelope: Record<string, unknown>): RawRevertData[] {
  return [envelope.data, envelope.errorData].filter(isRawRevertData);
}

function isRawRevertData(raw: unknown): raw is RawRevertData {
  if (raw instanceof Uint8Array) return true;
  return typeof raw === 'string' && /^0x[0-9a-fA-F]+$/.test(raw);
}
