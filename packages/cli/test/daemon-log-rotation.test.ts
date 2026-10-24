import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateDaemonLogIfNeeded } from '../src/daemon/log-rotation.js';

const tempDirs: string[] = [];

async function tempLog(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-log-rotation-'));
  tempDirs.push(dir);
  const path = join(dir, 'daemon.log');
  await writeFile(path, contents);
  return path;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('rotateDaemonLogIfNeeded', () => {
  it('leaves a log at or below the size limit untouched', async () => {
    const path = await tempLog('one\ntwo\n');

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 20, keepBytes: 10 });

    expect(result).toEqual({ rotated: false, previousBytes: 8, keptBytes: 8 });
    expect(await readFile(path, 'utf-8')).toBe('one\ntwo\n');
  });

  it('reads only the bounded tail and keeps complete recent log lines', async () => {
    const path = await tempLog([
      'old-0000000000',
      'middle-1111111',
      'recent-a',
      'recent-b',
      'recent-c',
      '',
    ].join('\n'));

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 40, keepBytes: 30 });
    const retained = await readFile(path, 'utf-8');

    expect(result.rotated).toBe(true);
    expect(result.previousBytes).toBeGreaterThan(40);
    expect(result.keptBytes).toBeLessThanOrEqual(30);
    expect(retained).toBe('recent-a\nrecent-b\nrecent-c\n');
  });

  it('handles a single oversized line without allocating beyond keepBytes', async () => {
    const path = await tempLog('x'.repeat(200));

    const result = await rotateDaemonLogIfNeeded(path, { maxBytes: 100, keepBytes: 60 });

    expect(result).toEqual({ rotated: true, previousBytes: 200, keptBytes: 60 });
    expect((await readFile(path)).length).toBe(60);
  });

  it('rejects invalid bounds before touching the file', async () => {
    const path = await tempLog('unchanged');

    await expect(
      rotateDaemonLogIfNeeded(path, { maxBytes: 10, keepBytes: 10 }),
    ).rejects.toThrow(/keepBytes/);
    expect(await readFile(path, 'utf-8')).toBe('unchanged');
  });
});
