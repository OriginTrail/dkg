import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import type { CatchupStatusResponse } from '../src/catchup-status-wire.js';
import {
  printCatchupStatus,
  runCatchupStatusCommand,
} from '../src/cli-helpers.js';

const recoveredStatus: CatchupStatusResponse = {
  jobId: 'job-recovered',
  contextGraphId: 'cg-recovered',
  includeWorkspace: false,
  includeSharedMemory: true,
  status: 'done',
  queuedAt: 1,
  startedAt: 2,
  finishedAt: 3,
  attempt: {
    status: 'unreachable',
    error: 'durable VM missing',
  },
  convergence: {
    state: 'complete',
    required: { metadata: true, durable: true, sharedMemory: true },
    verified: { metadata: true, durable: true, sharedMemory: true },
    missing: [],
    readinessUpdatedAt: 4,
    observedAt: 5,
    syncMode: 'on-demand',
    automaticRetryActive: true,
  },
  completedAfterAttempt: true,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('catch-up status CLI', () => {
  it('renders actionable recovery with historical attempt diagnostics', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    printCatchupStatus(recoveredStatus);

    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines).toContain('Status:        done');
    expect(lines).toContain('Last attempt:  unreachable');
    expect(lines).toContain('Attempt error: durable VM missing');
    expect(lines).toContain('Shared Memory: enabled');
    expect(lines).toContain('Convergence:   complete');
    expect(lines).toContain('Recovered:     a later synchronization completed the selected graph');
  });

  it('stops watch mode on the canonical actionable status', async () => {
    const catchupStatus = vi.fn().mockResolvedValue(recoveredStatus);
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ catchupStatus } as ApiClient);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'clear').mockImplementation(() => {});

    await runCatchupStatusCommand('cg-recovered', { watch: true, interval: 1 });

    expect(catchupStatus).toHaveBeenCalledTimes(1);
    expect(catchupStatus).toHaveBeenCalledWith('cg-recovered');
  });
});
