// SPDX-License-Identifier: Apache-2.0

export function boundedErrorChainV1(error) {
  const messages = [];
  const seen = new Set();
  let current = error;
  while (current !== null && current !== undefined && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = typeof current === 'object' ? current.cause : null;
  }
  return messages.join(' <- ').slice(0, 2_048);
}
