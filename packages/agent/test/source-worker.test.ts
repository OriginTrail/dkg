import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSourceWorkerOnce } from '../src/source-worker.js';

const cleanup: string[] = [];
afterEach(async () => {
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
});
