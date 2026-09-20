// SPDX-License-Identifier: Apache-2.0

/**
 * Flatten the nested text fields used by ethers and managed JSON-RPC
 * providers without depending on ethers or any adapter-specific code.
 */
export function collectEvmErrorText(err: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 5 || seen.has(value)) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value !== 'object') return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'shortMessage', 'reason', 'body', 'responseBody']) {
      if (typeof record[key] === 'string') parts.push(record[key]);
    }
    for (const key of ['error', 'info', 'cause', 'data', 'response']) {
      visit(record[key], depth + 1);
    }
  };
  visit(err, 0);
  return parts.join(' ').toLowerCase();
}

/** Common node phrasings for a requested block that is not locally available. */
export function isEvmBlockUnavailableError(err: unknown): boolean {
  return /\b(header not found|unknown block|block not found)\b/u
    .test(collectEvmErrorText(err));
}
