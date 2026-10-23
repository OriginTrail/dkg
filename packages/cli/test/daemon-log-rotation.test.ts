import { appendFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DAEMON_LOG_ROTATION_CHECK_INTERVAL_MS,
  DEFAULT_DAEMON_LOG_MAX_BYTES,
  DEFAULT_DAEMON_LOG_RETAIN_MS,
  DEFAULT_DAEMON_LOG_TOTAL_BYTES,
  describeDaemonLogRotation,
  rotateDaemonLogIfNeeded,
  startDaemonLogRotationChecks,
  type DaemonLogRotationResult,
} from '../src/daemon/log-rotation.js';

const HOUR_MS = 60 * 60_000;
const tempDirs: string[] = [];

async function tempLogDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-log-rotation-'));
  tempDirs.push(dir);
  return dir;
}

async function tempLog(contents: string): Promise<string> {
  const path = join(await tempLogDir(), 'daemon.log');
  await writeFile(path, contents);
  return path;
}

/** Write a file whose newest line is `ageMs` old by `now`. */
async function writeAged(path: string, contents: string, now: number, ageMs: number): Promise<void> {
  await writeFile(path, contents);
  await utimes(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('rotateDaemonLogIfNeeded', () => {
  it('leaves a log at or below the size limit untouched', async () => {
    const path = await tempLog('one\ntwo\n');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10 });

    expect(result).toEqual({ rotated: false, trimmed: false, previousBytes: 8, removedFiles: 0, newestCutTo: null });
    expect(await readFile(path, 'utf-8')).toBe('one\ntwo\n');
    expect(await names(join(path, '..'))).toEqual(['daemon.log']);
  });

  it('renames an oversized log to daemon.log.1 and moves earlier files up, dropping no line', async () => {
    const path = await tempLog('live-1\nlive-2\nlive-3\n');
    await writeFile(`${path}.1`, 'previous\n');
    await writeFile(`${path}.2`, 'older\n');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10 });

    expect(result).toEqual({ rotated: true, trimmed: false, previousBytes: 21, removedFiles: 0, newestCutTo: null });
    expect(await names(join(path, '..'))).toEqual(['daemon.log.1', 'daemon.log.2', 'daemon.log.3']);
    expect(await readFile(`${path}.1`, 'utf-8')).toBe('live-1\nlive-2\nlive-3\n');
    expect(await readFile(`${path}.2`, 'utf-8')).toBe('previous\n');
    expect(await readFile(`${path}.3`, 'utf-8')).toBe('older\n');

    // Appends after a rotation start a new live file.
    await appendFile(path, 'next\n');
    expect(await readFile(path, 'utf-8')).toBe('next\n');
  });

  it('keeps a gap left by an interrupted rotation in order and moves past it', async () => {
    const path = await tempLog('x'.repeat(30));
    await writeFile(`${path}.1`, 'newest\n');
    await writeFile(`${path}.3`, 'oldest\n');

    await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10 });

    expect(await names(join(path, '..'))).toEqual(['daemon.log.1', 'daemon.log.2', 'daemon.log.4']);
    expect(await readFile(`${path}.2`, 'utf-8')).toBe('newest\n');
    expect(await readFile(`${path}.4`, 'utf-8')).toBe('oldest\n');
  });

  it('removes rotated files whose newest line is past the retention window, and only those', async () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const path = await tempLog('live\n');
    await writeAged(`${path}.1`, 'a day old\n', now, 24 * HOUR_MS);
    await writeAged(`${path}.2`, 'just inside\n', now, DEFAULT_DAEMON_LOG_RETAIN_MS);
    await writeAged(`${path}.3`, 'just outside\n', now, DEFAULT_DAEMON_LOG_RETAIN_MS + 1_000);
    await writeAged(`${path}.4`, 'older still\n', now, 100 * HOUR_MS);

    const result = await rotateDaemonLogIfNeeded(path, { now: () => now });

    expect(result).toEqual({ rotated: false, trimmed: false, previousBytes: 5, removedFiles: 2, newestCutTo: null });
    expect(await names(join(path, '..'))).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
  });

  it('removes the oldest files first once the live and kept files would pass the size cap', async () => {
    const path = await tempLog('l'.repeat(10));
    await writeFile(`${path}.1`, '1'.repeat(30));
    await writeFile(`${path}.2`, '2'.repeat(30));
    await writeFile(`${path}.3`, '3'.repeat(30));
    // Small enough to fit, but kept files are always one unbroken newest stretch.
    await writeFile(`${path}.4`, '4');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10, totalBytes: 75 });

    expect(result.removedFiles).toBe(2);
    expect(await names(join(path, '..'))).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2']);
  });

  it('touches only the numbered siblings of the log', async () => {
    const dir = await tempLogDir();
    const path = join(dir, 'daemon.log');
    await writeFile(path, 'x'.repeat(30));
    const others = ['daemon-log-writer-errors.log', 'daemon.log.0', 'daemon.log.1x', 'daemon.log.bak', 'other.log.1'];
    for (const name of others) await writeFile(join(dir, name), 'keep\n');
    await mkdir(join(dir, 'daemon.log.7'));

    await writeAged(join(dir, 'daemon.log.2'), 'aged\n', Date.now(), DEFAULT_DAEMON_LOG_RETAIN_MS + HOUR_MS);

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10 });

    // The live file moved to .1 and the aged file (moved to .3) went; nothing else changed.
    expect(result).toMatchObject({ rotated: true, removedFiles: 1 });
    expect(await names(dir)).toEqual([...others, 'daemon.log.1', 'daemon.log.7'].sort());
    for (const name of others) expect(await readFile(join(dir, name), 'utf-8')).toBe('keep\n');
  });

  it('keeps the last lines of a rotated file that alone passes the size limit, and judges older files as usual', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `line-${String(index + 1).padStart(4, '0')}\n`);
    const now = Date.now();
    const path = await tempLog(lines.join(''));
    await writeAged(`${path}.1`, 'previous\n', now, HOUR_MS);
    await writeAged(`${path}.2`, 'older\n', now, DEFAULT_DAEMON_LOG_RETAIN_MS + HOUR_MS);

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 50, keepBytes: 35, totalBytes: 200, now: () => now });

    // 600 bytes cannot fit in 200: the newest 35 bytes are read and the partial first line dropped.
    expect(result).toEqual({ rotated: true, trimmed: false, previousBytes: 600, removedFiles: 1, newestCutTo: 30 });
    expect(await readFile(`${path}.1`, 'utf-8')).toBe('line-0058\nline-0059\nline-0060\n');
    expect(await readFile(`${path}.2`, 'utf-8')).toBe('previous\n');
    expect(await names(join(path, '..'))).toEqual(['daemon.log.1', 'daemon.log.2']);
  });

  it('keeps the newest lines of an inherited log larger than the whole default size limit', async () => {
    const path = await tempLog('');
    const newest = '\nnewest line before the restart\n';
    const size = DEFAULT_DAEMON_LOG_TOTAL_BYTES + 1024;
    // A sparse file: only its last bytes are written.
    const handle = await open(path, 'r+');
    try {
      await handle.truncate(size);
      await handle.write(Buffer.from(newest), 0, newest.length, size - newest.length);
    } finally {
      await handle.close();
    }

    const result = await rotateDaemonLogIfNeeded(path);

    expect(result).toMatchObject({ rotated: true, previousBytes: size, newestCutTo: newest.length - 1 });
    expect(await readFile(`${path}.1`, 'utf-8')).toBe('newest line before the restart\n');
    expect(describeDaemonLogRotation(result, 'during startup')).toBe(
      'Rotated daemon.log during startup to daemon.log.1 (was 512.0 MB); '
        + 'kept the last 0.0 MB of the newest rotated file within the size limit',
    );
  });

  it('trims the live file in place to its last complete lines when the rename fails', async () => {
    const path = await tempLog([
      'old-0000000000',
      'middle-1111111',
      'recent-a',
      'recent-b',
      'recent-c',
      '',
    ].join('\n'));
    // A directory in the way of daemon.log.1 makes the rename fail.
    await mkdir(`${path}.1`);
    await writeFile(join(`${path}.1`, 'occupied'), '');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 40, keepBytes: 30 });

    expect(result).toMatchObject({ rotated: false, trimmed: true, previousBytes: 57 });
    expect(await readFile(path, 'utf-8')).toBe('recent-a\nrecent-b\nrecent-c\n');
  });

  it('keeps at most keepBytes of a single oversized line when it has to trim', async () => {
    const path = await tempLog('x'.repeat(200));
    await mkdir(`${path}.1`);
    await writeFile(join(`${path}.1`, 'occupied'), '');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 100, keepBytes: 60 });

    expect(result).toMatchObject({ trimmed: true, previousBytes: 200 });
    expect((await readFile(path)).length).toBe(60);
  });

  it('rejects invalid bounds before touching the file', async () => {
    const path = await tempLog('unchanged');

    await expect(
      rotateDaemonLogIfNeeded(path, { maxBytes: 10, keepBytes: 10 }),
    ).rejects.toThrow(/keepBytes/);
    await expect(
      rotateDaemonLogIfNeeded(path, { maxBytes: 10, keepBytes: 5, totalBytes: 9 }),
    ).rejects.toThrow(/totalBytes/);
    await expect(
      rotateDaemonLogIfNeeded(path, { retainMs: 0 }),
    ).rejects.toThrow(/retainMs/);
    expect(await readFile(path, 'utf-8')).toBe('unchanged');
  });

  it('defaults to 50 MB files, 512 MB in all and 72 hours', () => {
    expect(DEFAULT_DAEMON_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(DEFAULT_DAEMON_LOG_TOTAL_BYTES).toBe(512 * 1024 * 1024);
    expect(DEFAULT_DAEMON_LOG_RETAIN_MS).toBe(72 * HOUR_MS);
    expect(DAEMON_LOG_ROTATION_CHECK_INTERVAL_MS).toBe(10 * 60_000);
  });
});

/**
 * A node writing `mbPerHour` of log (MB of 10^6 bytes) for `hours`, checked
 * every 10 minutes, with the default limits scaled down 1024 times (1 MiB of log
 * is 1 KiB here). Each line carries the hour it was written in, and a file's time
 * is the time of its newest line, as on disk. Returns how many hours back the
 * oldest kept line goes, at the checks where the first line written is at least
 * `fromHours` old, and the most the log files took together at any check.
 */
async function simulate(mbPerHour: number, hours: number, fromHours: number) {
  const scale = 1024;
  const dir = await tempLogDir();
  const path = join(dir, 'daemon.log');
  const options = {
    maxBytes: DEFAULT_DAEMON_LOG_MAX_BYTES / scale,
    keepBytes: Math.floor(DEFAULT_DAEMON_LOG_MAX_BYTES / scale * 0.7),
    totalBytes: DEFAULT_DAEMON_LOG_TOTAL_BYTES / scale,
    retainMs: DEFAULT_DAEMON_LOG_RETAIN_MS,
  };
  const stepMs = DAEMON_LOG_ROTATION_CHECK_INTERVAL_MS;
  const start = Date.UTC(2026, 9, 20);
  const bytesPerStep = mbPerHour * 1_000_000 / scale * stepMs / HOUR_MS;
  let written = 0;
  let fewestHoursKept = Infinity;
  let largestTotal = 0;
  for (let step = 1; step * stepMs <= hours * HOUR_MS; step += 1) {
    const now = start + step * stepMs;
    const line = `${(now - start) / HOUR_MS}`.padEnd(31, ' ') + '\n';
    let chunk = '';
    while (written + line.length <= bytesPerStep * step) {
      chunk += line;
      written += line.length;
    }
    await appendFile(path, chunk);
    await utimes(path, now / 1000, now / 1000);
    await rotateDaemonLogIfNeeded(path, { ...options, now: () => now });

    const files = await readdir(dir);
    const sizes = await Promise.all(files.map(async (name) => (await stat(join(dir, name))).size));
    largestTotal = Math.max(largestTotal, sizes.reduce((sum, size) => sum + size, 0));
    // The first line is written at the first check, one interval after `start`.
    if (now - start - stepMs >= fromHours * HOUR_MS) {
      const oldest = files.filter((name) => name !== 'daemon.log')
        .sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()))[0] ?? 'daemon.log';
      const firstHour = Number((await readFile(join(dir, oldest), 'utf-8')).split(/\s/, 1)[0]);
      fewestHoursKept = Math.min(fewestHoursKept, (now - start) / HOUR_MS - firstHour);
    }
  }
  return { fewestHoursKept, largestTotal, cap: options.totalBytes };
}

describe('daemon.log retention over days of writing', () => {
  it('keeps the full 72 hours at the 6.5 MB an hour of the busiest Cores, and 48 at 9 MB, within the cap', async () => {
    const busiest = await simulate(6.5, 144, 72);
    expect(busiest.fewestHoursKept).toBeGreaterThanOrEqual(72);
    expect(busiest.largestTotal).toBeLessThanOrEqual(busiest.cap);

    const busier = await simulate(9, 144, 48);
    expect(busier.fewestHoursKept).toBeGreaterThanOrEqual(48);
    expect(busier.largestTotal).toBeLessThanOrEqual(busier.cap);
  });

  it('lets the cap win over the 48 hours when a node writes far more', async () => {
    const flood = await simulate(40, 60, 24);
    expect(flood.fewestHoursKept).toBeLessThan(48);
    expect(flood.largestTotal).toBeLessThanOrEqual(flood.cap);
  });
});

describe('daemon.log rotation lines and checks', () => {
  const unchanged: DaemonLogRotationResult = {
    rotated: false,
    trimmed: false,
    previousBytes: 10,
    removedFiles: 0,
    newestCutTo: null,
  };

  it('describes only checks that changed something', () => {
    expect(describeDaemonLogRotation(unchanged)).toBeNull();
    expect(describeDaemonLogRotation({ ...unchanged, rotated: true, previousBytes: 52_428_900 }))
      .toBe('Rotated daemon.log to daemon.log.1 (was 50.0 MB)');
    expect(describeDaemonLogRotation(
      { ...unchanged, rotated: true, previousBytes: 60 * 1024 * 1024, removedFiles: 1 },
      'during startup',
    )).toBe('Rotated daemon.log during startup to daemon.log.1 (was 60.0 MB); '
      + 'removed 1 rotated daemon.log file(s) past the age or size limit');
    expect(describeDaemonLogRotation({ ...unchanged, trimmed: true, previousBytes: 60 * 1024 * 1024 }))
      .toBe('Trimmed daemon.log in place after a failed rename (was 60.0 MB)');
    expect(describeDaemonLogRotation({ ...unchanged, removedFiles: 2 }))
      .toBe('Removed 2 rotated daemon.log file(s) past the age or size limit');
    expect(describeDaemonLogRotation({ ...unchanged, newestCutTo: 35 * 1024 * 1024 }))
      .toBe('Kept the last 35.0 MB of the newest rotated file within the size limit');
  });

  it('checks every interval, logs what changed, and survives a failed check', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const results: Array<DaemonLogRotationResult | Error> = [
      unchanged,
      new Error('writer stopped'),
      { ...unchanged, rotated: true, previousBytes: 50 * 1024 * 1024 },
    ];
    const rotate = vi.fn(async () => {
      const next = results.shift() ?? unchanged;
      if (next instanceof Error) throw next;
      return next;
    });
    const lines: string[] = [];
    const checks = startDaemonLogRotationChecks({ rotate, log: (line) => lines.push(line), intervalMs: 1_000 });

    expect(rotate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(rotate).toHaveBeenCalledTimes(3);
    expect(lines).toEqual(['Rotated daemon.log to daemon.log.1 (was 50.0 MB)']);

    checks.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rotate).toHaveBeenCalledTimes(3);
  });
});
