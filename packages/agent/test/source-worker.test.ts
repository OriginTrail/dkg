import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSourceWorkerOnce, saveSourceWorkerState } from '../src/source-worker.js';

const cleanup: string[] = [];
afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('source worker runtime', () => {
  it('skips unchanged finalized jobs and persists reconciled state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: vi.fn(async () => 'fp-1'),
      getJobStatus: vi.fn(async () => 'finalized'),
      processSource: vi.fn(async () => ({
        sourceId: 'src-1',
        skipped: false,
        fingerprint: 'fp-1',
        status: 'queued',
        nextState: { fingerprint: 'fp-1', lastStatus: 'queued', lastJobIds: ['job-1'] },
      })),
    };

    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    const second = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.processSource).toHaveBeenCalledTimes(1);
    expect(second.sources['src-1']?.lastStatus).toBe('finalized');
  });

  it('reprocesses stable sources only when their content fingerprint changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');
    const fingerprints = ['fp-1', 'fp-1', 'fp-2'];
    let processed = 0;

    const deps = {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: vi.fn(async () => fingerprints.shift() ?? 'fp-2'),
      getJobStatus: vi.fn(async () => 'finalized'),
      processSource: vi.fn(async (source: { id: string }, fingerprint: string) => {
        processed += 1;
        return {
          sourceId: source.id,
          skipped: false,
          jobIds: [`job-${processed}`],
          jobStatuses: { [`job-${processed}`]: 'queued' },
          status: 'queued',
          nextState: {
            fingerprint,
            lastStatus: 'queued',
            lastJobIds: [`job-${processed}`],
            lastJobStatuses: { [`job-${processed}`]: 'queued' },
          },
        };
      }),
    };

    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);
    const changed = await runSourceWorkerOnce([{ id: 'src-1', maxRetries: 3 }], statePath, deps);

    expect(deps.processSource).toHaveBeenCalledTimes(2);
    expect(deps.processSource.mock.calls.map((call) => call[1])).toEqual(['fp-1', 'fp-2']);
    expect(changed.sources['src-1']).toMatchObject({
      fingerprint: 'fp-2',
      lastStatus: 'queued',
      lastJobIds: ['job-2'],
    });
  });

  it('saves state without leaving temp files behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'source-worker-'));
    cleanup.push(dir);
    const statePath = join(dir, 'state.json');

    await saveSourceWorkerState(statePath, {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });

    await expect(readdir(dir)).resolves.toEqual(['state.json']);
    await expect(runSourceWorkerOnce([], statePath, {
      now: () => '2026-04-28T00:00:00.000Z',
      getFingerprint: vi.fn(async () => ''),
      getJobStatus: vi.fn(async () => ''),
      processSource: vi.fn(async () => {
        throw new Error('unexpected source processing');
      }),
    })).resolves.toMatchObject({
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });
  });

  it('persists state through same-directory temp write, file fsync, rename, and directory fsync', async () => {
    vi.resetModules();

    const calls: string[] = [];
    const fileHandle = {
      writeFile: vi.fn(async () => {
        calls.push('writeFile');
      }),
      sync: vi.fn(async () => {
        calls.push('fileSync');
      }),
      close: vi.fn(async () => {
        calls.push('fileClose');
      }),
    };
    const dirHandle = {
      sync: vi.fn(async () => {
        calls.push('dirSync');
      }),
      close: vi.fn(async () => {
        calls.push('dirClose');
      }),
    };
    const mkdir = vi.fn(async () => {
      calls.push('mkdir');
    });
    const open = vi.fn(async (path: string, flags: string) => {
      calls.push(`open:${flags}:${path}`);
      return flags === 'wx' ? fileHandle : dirHandle;
    });
    const rename = vi.fn(async (from: string, to: string) => {
      calls.push(`rename:${from}->${to}`);
    });
    const rmMock = vi.fn(async () => {
      calls.push('rm');
    });

    vi.doMock('node:fs/promises', () => ({
      mkdir,
      open,
      readFile: vi.fn(),
      rename,
      rm: rmMock,
    }));

    const { saveSourceWorkerState: saveWithMockedFs } = await import('../src/source-worker.js');
    const statePath = join(tmpdir(), 'source-worker-state-test', 'state.json');
    const stateDir = dirname(statePath);

    await saveWithMockedFs(statePath, {
      sources: {
        'src-1': {
          fingerprint: 'fp-1',
          lastStatus: 'queued',
        },
      },
    });

    const tempPath = String(open.mock.calls[0][0]);
    expect(dirname(tempPath)).toBe(stateDir);
    expect(basename(tempPath)).toMatch(/^\.state\.json\.\d+\..+\.tmp$/);
    expect(mkdir).toHaveBeenCalledWith(stateDir, { recursive: true });
    expect(fileHandle.writeFile).toHaveBeenCalledWith(expect.stringContaining('"src-1"'), 'utf8');
    expect(rmMock).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'mkdir',
      `open:wx:${tempPath}`,
      'writeFile',
      'fileSync',
      'fileClose',
      `rename:${tempPath}->${statePath}`,
      `open:r:${stateDir}`,
      'dirSync',
      'dirClose',
    ]);
  });
});
