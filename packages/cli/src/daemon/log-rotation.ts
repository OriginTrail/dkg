import { open, stat, writeFile } from 'node:fs/promises';

export const DEFAULT_DAEMON_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_DAEMON_LOG_KEEP_BYTES = Math.floor(
  DEFAULT_DAEMON_LOG_MAX_BYTES * 0.7,
);

export interface DaemonLogRotationResult {
  rotated: boolean;
  previousBytes: number;
  keptBytes: number;
}

/**
 * Trim an oversized daemon log from a bounded tail read.
 *
 * The previous implementation used readFile(), so a multi-gigabyte log was
 * copied wholesale into the daemon heap precisely when rotation was supposed
 * to protect the node. This reads at most keepBytes and drops the first
 * partial line before replacing the file.
 */
export async function rotateDaemonLogIfNeeded(
  logFile: string,
  options: {
    maxBytes?: number;
    keepBytes?: number;
  } = {},
): Promise<DaemonLogRotationResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_DAEMON_LOG_MAX_BYTES;
  const keepBytes = options.keepBytes ?? DEFAULT_DAEMON_LOG_KEEP_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('daemon log maxBytes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(keepBytes) || keepBytes <= 0 || keepBytes >= maxBytes) {
    throw new Error('daemon log keepBytes must be a positive safe integer below maxBytes');
  }

  const before = await stat(logFile).catch(() => null);
  if (!before || before.size <= maxBytes) {
    return {
      rotated: false,
      previousBytes: before?.size ?? 0,
      keptBytes: before?.size ?? 0,
    };
  }

  const bytesToRead = Math.min(keepBytes, before.size);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const handle = await open(logFile, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < bytesToRead) {
      const result = await handle.read(
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        before.size - bytesToRead + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  const tail = buffer.subarray(0, bytesRead);
  const firstNewline = tail.indexOf(0x0a);
  const retained = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
  await writeFile(logFile, retained);

  return {
    rotated: true,
    previousBytes: before.size,
    keptBytes: retained.length,
  };
}
