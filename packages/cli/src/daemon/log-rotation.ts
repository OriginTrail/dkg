import { link, open, readdir, lstat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * daemon.log rotation and retention.
 *
 * A live log past `maxBytes` is renamed to `daemon.log.1`, and the files
 * rotated before it move up one number (`.1` to `.2` and so on), so neither a
 * rotation nor a restart drops a line. Rotated files are kept, newest first,
 * while their newest line is younger than `retainMs` and the live file and the
 * kept files together stay within `totalBytes`; the rest are removed, oldest
 * first. A newest rotated file too large to fit on its own keeps its last
 * lines.
 *
 * The defaults keep at least 48 hours of a busy Core's log: within 512 MB a
 * node keeps the full 72 hours up to about 6.5 MB of log an hour, what the
 * busiest Cores write, and at least 48 hours up to about 9 MB an hour. A quiet
 * node, which rotates rarely, keeps its live file and the files rotated in the
 * last 72 hours.
 *
 * Moving files without replacing an existing name keeps every line across rotations and restarts. Trimming the live
 * file in place to its last 35 MB, which reads only a bounded tail, is the
 * fallback when a move safely fails; an incomplete scan or uncertain move is left for the next check.
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
  /** Set when the newest rotated file alone passed the size limit: it kept only its last lines, this many bytes. */
  newestCutTo: number | null;
}

interface RotatedLogFile {
  index: number;
  size: number;
  mtimeMs: number;
  identity: string | null;
}

const MIB = 1024 * 1024;

/** Inspect the entry itself; bigint identities keep distinct inode numbers distinct. */
async function statLogFile(path: string) {
  const info = await lstat(path, { bigint: true });
  const identity = typeof info.dev === 'bigint' && typeof info.ino === 'bigint'
    && info.ino > 0n ? `${info.dev}:${info.ino}` : null;
  return { size: Number(info.size), mtimeMs: Number(info.mtimeMs), identity, isFile: () => info.isFile(), isSymbolicLink: () => info.isSymbolicLink() };
}

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
  const names = await readdir(dirname(logFile));
  const files: RotatedLogFile[] = [];
  for (const name of names) {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (!/^[1-9]\d{0,5}$/.test(suffix)) continue;
    const info = await statLogFile(join(dirname(logFile), name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new IncompleteLogMoveError('Rotated log is a symbolic link');
    if (info?.isFile()) files.push({ index: Number(suffix), size: info.size, mtimeMs: info.mtimeMs, identity: info.identity });
  }
  return files.sort((a, b) => a.index - b.index);
}

/**
 * Cut a log file in place to its last lines from a bounded tail read: at most
 * keepBytes are read, and the first partial line is dropped. Returns the bytes
 * kept. A whole-file read once copied a multi-gigabyte log into the daemon heap.
 */
async function keepLogTail(logFile: string, size: number, keepBytes: number): Promise<number> {
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
  const kept = firstNewline >= 0 ? tail.subarray(firstNewline + 1) : tail;
  await writeFile(logFile, kept);
  return kept.length;
}

/** Neither trimming nor retention may change a still-linked source after a failed rollback. */
class IncompleteLogMoveError extends Error {}

/** Pathname checks narrow external races; Node does not provide compare-and-unlink. */
async function assertLinkedLogEntries(from: string, to: string, identity: string): Promise<void> {
  const [source, destination] = await Promise.all([statLogFile(from), statLogFile(to)]).catch(error => {
    throw new IncompleteLogMoveError('Log move identity could not be verified', { cause: error });
  });
  if (!source.isFile() || !destination.isFile()
    || source.identity !== identity || destination.identity !== identity) {
    throw new IncompleteLogMoveError('Log identity changed during a move');
  }
}

/** Claim the destination atomically: rename() can overwrite a file omitted by a stale scan. */
async function moveLogWithoutReplacing(from: string, to: string): Promise<void> {
  const source = await statLogFile(from).catch(() => null);
  if (!source?.isFile() || source.identity === null) {
    throw new IncompleteLogMoveError('Log source identity is unavailable for a move');
  }
  const identity = source.identity;
  try {
    await link(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // A stale scan may have omitted an existing link to the live log itself.
      const destination = await statLogFile(to).catch(() => null);
      if (destination === null || destination.isFile() || destination.isSymbolicLink()) {
        throw new IncompleteLogMoveError('Log destination appeared after its directory scan', { cause: error });
      }
    }
    throw error;
  }
  await assertLinkedLogEntries(from, to, identity);
  try {
    await unlink(from);
  } catch (error) {
    try {
      // A failed source removal can coincide with either entry being replaced.
      // Roll back only while the original content still has both regular links.
      await assertLinkedLogEntries(from, to, identity);
      await unlink(to);
    } catch {
      throw new IncompleteLogMoveError('Log move could not remove its source or roll back its link', { cause: error });
    }
    throw error;
  }
}

/** Recover an interrupted link/unlink without creating more aliases on each retry. */
async function removeInterruptedMoveAliases(
  logFile: string,
  liveIdentity: string | null,
  files: readonly RotatedLogFile[],
): Promise<RotatedLogFile[]> {
  const seen = new Map(liveIdentity === null ? [] : [[liveIdentity, logFile]]);
  const unique: RotatedLogFile[] = [];
  for (const file of files) {
    if (file.identity !== null && seen.has(file.identity)) {
      try {
        const duplicatePath = rotatedLogPath(logFile, file.index);
        const retainedPath = seen.get(file.identity)!;
        // Scan identities can be stale after an operator replaces a path. Confirm
        // both regular entries still name the retained inode before removing one.
        await assertLinkedLogEntries(retainedPath, duplicatePath, file.identity);
        await unlink(duplicatePath);
      } catch (error) {
        throw new IncompleteLogMoveError('Interrupted log move is still linked', { cause: error });
      }
    } else {
      if (file.identity !== null) seen.set(file.identity, rotatedLogPath(logFile, file.index));
      unique.push(file);
    }
  }
  return unique;
}

/** Move every rotated file up one number, oldest first, then the live file to `.1`. */
async function moveIntoRotation(logFile: string, files: readonly RotatedLogFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    await moveLogWithoutReplacing(rotatedLogPath(logFile, file.index), rotatedLogPath(logFile, file.index + 1));
  }
  await moveLogWithoutReplacing(logFile, rotatedLogPath(logFile, 1));
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

  const before = await statLogFile(logFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const previousBytes = before?.size ?? 0;
  if (before && !before.isFile()) {
    return { rotated: false, trimmed: false, previousBytes, removedFiles: 0, newestCutTo: null };
  }
  let files = await listRotatedLogFiles(logFile).catch(() => null);
  let rotated = false;
  let trimmed = false;
  if (before && before.size > maxBytes) {
    try {
      if (files === null) throw new IncompleteLogMoveError('Incomplete rotated-log scan');
      if (before.identity === null || files.some(file => file.identity === null)) {
        throw new IncompleteLogMoveError('Log identity is unavailable for no-replace rotation');
      }
      files = await removeInterruptedMoveAliases(logFile, before.identity, files);
      await moveIntoRotation(logFile, files);
      rotated = true;
    } catch (error) {
      if (error instanceof IncompleteLogMoveError) {
        return { rotated: false, trimmed: false, previousBytes, removedFiles: 0, newestCutTo: null };
      }
      await keepLogTail(logFile, before.size, keepBytes);
      trimmed = true;
    }
    files = await listRotatedLogFiles(logFile).catch(() => null);
  }

  // An incomplete scan cannot prove which files are newest or fit retention.
  if (files === null) return { rotated, trimmed, previousBytes, removedFiles: 0, newestCutTo: null };

  // Newest first: a file is kept only while every newer one is, so what is
  // kept is the most recent log. The newest rotated file can pass the size
  // limit alone (a live file that grew far past `maxBytes`, as an inherited
  // one can); it then keeps its last lines, at most `keepBytes` and what the
  // limit leaves, and the files before it are judged as usual.
  const live = await statLogFile(logFile).catch(() => null);
  let keptBytes = live?.size ?? 0;
  let keeping = true;
  let removedFiles = 0;
  let newestCutTo: number | null = null;
  for (const [position, file] of files.entries()) {
    const room = totalBytes - keptBytes;
    let size = file.size;
    keeping = keeping && now() - file.mtimeMs <= retainMs;
    if (keeping && position === 0 && size > room && room > 0) {
      size = newestCutTo = await keepLogTail(rotatedLogPath(logFile, file.index), size, Math.min(keepBytes, room));
    }
    keeping = keeping && size <= room;
    if (keeping) {
      keptBytes += size;
      continue;
    }
    await unlink(rotatedLogPath(logFile, file.index)).then(
      () => { removedFiles += 1; },
      // Left for the next check.
      () => {},
    );
  }
  return { rotated, trimmed, previousBytes, removedFiles, newestCutTo };
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
  if (result.newestCutTo !== null) {
    parts.push(`kept the last ${(result.newestCutTo / MIB).toFixed(1)} MB of the newest rotated file within the size limit`);
  }
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
