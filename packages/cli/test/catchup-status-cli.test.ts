import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/api-client.js';
import { runCatchupStatusCommand } from '../src/cli-helpers.js';

describe('catch-up status CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints graph continuation and exits watch mode for a partial bounded job', async () => {
    const catchupStatus = vi.fn().mockResolvedValue({
      jobId: 'partial-job',
      contextGraphId: 'cg-selected',
      includeWorkspace: true,
      status: 'unreachable',
      jobStatus: 'partial',
      queuedAt: 1,
      graphSync: {
        mechanism: 'rfc64-selected-on-connect',
        state: 'continuing',
        configuredProviderCount: 1,
        retryRequiredProviderCount: 1,
        terminalProviderCount: 0,
      },
    });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ catchupStatus } as unknown as ApiClient);
    vi.spyOn(console, 'clear').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCatchupStatusCommand('cg-selected', { watch: true, interval: 1 });

    expect(catchupStatus).toHaveBeenCalledTimes(1);
    const output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Job Status:    partial');
    expect(output).toContain('Graph Sync:    continuing (rfc64-selected-on-connect)');
  });
});
