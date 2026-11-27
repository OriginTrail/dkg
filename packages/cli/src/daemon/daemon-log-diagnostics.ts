import { appendFile, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_DAEMON_LOG_DIAGNOSTIC_MAX_BYTES = 256 * 1024;

/**
 * Append to the non-recursive daemon-log fallback without allowing that file
 * to become a second unbounded log. When the next line would exceed the cap,
 * replace the file with that latest cumulative diagnostic.
 */
export async function appendBoundedDaemonLogDiagnostic(
  file: string,
  line: string,
  maxBytes = DEFAULT_DAEMON_LOG_DIAGNOSTIC_MAX_BYTES,
): Promise<void> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('daemon log diagnostic maxBytes must be a positive safe integer');
  }
  const encoded = Buffer.from(line);
  const payload = encoded.length <= maxBytes
    ? encoded
    : encoded.subarray(encoded.length - maxBytes);
  const current = await stat(file).catch(() => null);
  if (current && current.size + payload.length > maxBytes) {
    await writeFile(file, payload);
    return;
  }
  await appendFile(file, payload);
}
