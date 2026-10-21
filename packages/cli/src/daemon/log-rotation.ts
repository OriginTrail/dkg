import { open, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * daemon.log rotation and retention.
 *
 * A live log past `maxBytes` is renamed to `daemon.log.1`, and the files
 * rotated before it move up one number (`.1` to `.2` and so on), so neither a
 * rotation nor a restart drops a line. Rotated files are kept, newest first,
 * while their newest line is younger than `retainMs` and the live file and the
 * kept files together stay within `totalBytes`; the rest are removed, oldest
 * first.
 *
 * The defaults keep at least 48 hours of a busy Core's log: within 512 MB a
 * node keeps the full 72 hours up to about 6.5 MB of log an hour, what the
 * busiest Cores write, and at least 48 hours up to about 9 MB an hour. A quiet
 * node, which rotates rarely, keeps its live file and the files rotated in the
 * last 72 hours.
 *
 * Renaming keeps every line across rotations and restarts. Trimming the live
 * file in place to its last 35 MB, which reads only a bounded tail, is the
 * fallback when a rename fails, so the size bound holds either way.
 */
export const DEFAULT_DAEMON_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_DAEMON_LOG_TOTAL_BYTES = 512 * 1024 * 1024;
export const DEFAULT_DAEMON_LOG_RETAIN_MS = 72 * 60 * 60_000;
/** Kept by the fallback trim. */
export const DEFAULT_DAEMON_LOG_KEEP_BYTES = Math.floor(
  DEFAULT_DAEMON_LOG_MAX_BYTES * 0.7,
);
/** How often a running daemon checks its log: a stat and a listing of its directory. */
export const DAEMON_LOG_ROTATION_CHECK_INTERVAL_MS = 10 * 60_000;

export interface DaemonLogRotationOptions {
  maxBytes?: number;
  totalBytes?: number;
  retainMs?: number;
  keepBytes?: number;
  now?: () => number;
}

export interface DaemonLogRotationResult {
  /** The live file was renamed to `daemon.log.1`. */
  rotated: boolean;
  /** The rename failed and the live file was trimmed in place to its tail instead. */
  trimmed: boolean;
  previousBytes: number;
  /** Rotated files removed by the age or size limit. */
  removedFiles: number;
}

interface RotatedLogFile {
  index: number;
  size: number;
  mtimeMs: number;
}

const MIB = 1024 * 1024;

function rotatedLogPath(logFile: string, index: number): string {
  return `${logFile}.${index}`;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`daemon log ${name} must be a positive safe integer`);
  }
  return value;
}

/** The rotated files beside `logFile`, newest (lowest number) first. */
async function listRotatedLogFiles(logFile: string): Promise<RotatedLogFile[]> {
  const prefix = `${basename(logFile)}.`;
  const names = await readdir(dirname(logFile)).catch(() => [] as string[]);
  const files: RotatedLogFile[] = [];
  for (const name of names) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (!/^[1-9]\d{0,5}$/.test(suffix)) continue;
    const info = await stat(join(dirname(logFile), name)).catch(() => null);
    if (info?.isFile()) files.push({ index: Number(suffix), size: info.size, mtimeMs: info.mtimeMs });
  }
  return files.sort((a, b) => a.index - b.index);
}

/**
 * Trim an oversized log in place from a bounded tail read: at most keepBytes
 * are read, and the first partial line is dropped. A whole-file read once
 * copied a multi-gigabyte log into the daemon heap.
 */
async function trimDaemonLogTail(logFile: string, size: number, keepBytes: number): Promise<void> {
  const bytesToRead = Math.min(keepBytes, size);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  const handle = await open(logFile, 'r');
  let bytesRead = 0;
  try {
    while (bytesRead < bytesToRead) {
      const result = await handle.read(
        buffer,
        bytesRead,
        bytesToRead - bytesRead,
        size - bytesToRead + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  const tail = buffer.subarray(0, bytesRead);
  const firstNewline = tail.indexOf(0x0a);
  await writeFile(logFile, firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail);
}

/** Move every rotated file up one number, oldest first, then the live file to `.1`. */
async function renameIntoRotation(logFile: string, files: readonly RotatedLogFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    await rename(rotatedLogPath(logFile, file.index), rotatedLogPath(logFile, file.index + 1));
  }
  await rename(logFile, rotatedLogPath(logFile, 1));
}

/**
 * Rotate the live log when it passed `maxBytes`, then apply retention to the
 * rotated files. Safe to call at any time: without anything to do it only
 * reads sizes and times.
 */
export async function rotateDaemonLogIfNeeded(
  logFile: string,
  options: DaemonLogRotationOptions = {},
): Promise<DaemonLogRotationResult> {
  const maxBytes = positiveSafeInteger(options.maxBytes ?? DEFAULT_DAEMON_LOG_MAX_BYTES, 'maxBytes');
  const totalBytes = positiveSafeInteger(options.totalBytes ?? DEFAULT_DAEMON_LOG_TOTAL_BYTES, 'totalBytes');
  const retainMs = positiveSafeInteger(options.retainMs ?? DEFAULT_DAEMON_LOG_RETAIN_MS, 'retainMs');
  const keepBytes = positiveSafeInteger(options.keepBytes ?? DEFAULT_DAEMON_LOG_KEEP_BYTES, 'keepBytes');
  if (keepBytes >= maxBytes) {
    throw new Error('daemon log keepBytes must be below maxBytes');
  }
  if (totalBytes < maxBytes) {
    throw new Error('daemon log totalBytes must hold at least maxBytes');
  }
  const now = options.now ?? Date.now;

  const before = await stat(logFile).catch(() => null);
  const previousBytes = before?.size ?? 0;
  let files = await listRotatedLogFiles(logFile);
  let rotated = false;
  let trimmed = false;
  if (before && before.size > maxBytes) {
    try {
      await renameIntoRotation(logFile, files);
      rotated = true;
    } catch {
      await trimDaemonLogTail(logFile, before.size, keepBytes);
      trimmed = true;
    }
    files = await listRotatedLogFiles(logFile);
  }

  // Newest first: a file is kept only while every newer one is, so what is
  // kept is always one unbroken stretch of the most recent log.
  const live = await stat(logFile).catch(() => null);
  let keptBytes = live?.size ?? 0;
  let keeping = true;
  let removedFiles = 0;
  for (const file of files) {
    keeping = keeping
      && now() - file.mtimeMs <= retainMs
      && keptBytes + file.size <= totalBytes;
    if (keeping) {
      keptBytes += file.size;
      continue;
    }
    await unlink(rotatedLogPath(logFile, file.index)).then(
      () => { removedFiles += 1; },
      // Left for the next check.
      () => {},
    );
  }
  return { rotated, trimmed, previousBytes, removedFiles };
}

/** The log line for a check that changed something, or null when it changed nothing. */
export function describeDaemonLogRotation(
  result: DaemonLogRotationResult,
  when = '',
): string | null {
  const was = `was ${(result.previousBytes / MIB).toFixed(1)} MB`;
  const parts: string[] = [];
  if (result.rotated) parts.push(`Rotated daemon.log${when ? ` ${when}` : ''} to daemon.log.1 (${was})`);
  if (result.trimmed) parts.push(`Trimmed daemon.log${when ? ` ${when}` : ''} in place after a failed rename (${was})`);
  if (result.removedFiles > 0) {
    parts.push(`removed ${result.removedFiles} rotated daemon.log file(s) past the age or size limit`);
  }
  if (parts.length === 0) return null;
  const message = parts.join('; ');
  return message.charAt(0).toUpperCase() + message.slice(1);
}

/**
 * Check the log every `intervalMs` through the daemon's log writer, which runs
 * each check between its appends.
 */
export function startDaemonLogRotationChecks(options: {
  rotate: () => Promise<DaemonLogRotationResult>;
  log: (message: string) => void;
  intervalMs?: number;
}): { stop(): void } {
  const check = async (): Promise<void> => {
    try {
      const message = describeDaemonLogRotation(await options.rotate());
      if (message) options.log(message);
    } catch {
      // Retried at the next check; a log check must never crash the daemon.
    }
  };
  const timer = setInterval(() => {
    void check();
  }, options.intervalMs ?? DAEMON_LOG_ROTATION_CHECK_INTERVAL_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
