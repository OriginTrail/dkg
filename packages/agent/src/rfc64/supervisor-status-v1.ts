// SPDX-License-Identifier: Apache-2.0

/** Shared bounded status formatting for RFC-64 background supervisors. */

const MAX_STATUS_ERROR_BYTES_V1 = 1024;
const UTF8 = new TextEncoder();

export function rfc64SupervisorErrorMessageV1(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedRfc64SupervisorErrorV1(error: unknown): string {
  const input = rfc64SupervisorErrorMessageV1(error);
  if (UTF8.encode(input).byteLength <= MAX_STATUS_ERROR_BYTES_V1) return input;
  let output = '';
  for (const character of input) {
    if (UTF8.encode(`${output}${character}`).byteLength > MAX_STATUS_ERROR_BYTES_V1) break;
    output += character;
  }
  return output;
}
