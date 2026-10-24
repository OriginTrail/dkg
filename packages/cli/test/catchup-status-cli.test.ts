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

  it('shows what a name-hash-only job is waiting for and where a resolved job continued', async () => {
    const nameHash = '0x69a1d4a3500548577083af0be5c4376dcf171907ab7da012d25dc778ced894e3';
    const message = 'Context Graph 0x69a1d4a3…94e3 is known only by its on-chain name hash; '
      + 'waiting for a peer to reveal the cleartext id, or subscribe with the cleartext id.';
    const catchupStatus = vi.fn()
      .mockResolvedValueOnce({
        jobId: 'hash-job',
        contextGraphId: nameHash,
        includeWorkspace: true,
        status: 'unreachable',
        jobStatus: 'unreachable',
        queuedAt: 1,
        error: message,
        identity: { state: 'name-hash-only', nameHash, message },
      })
      .mockResolvedValueOnce({
        jobId: 'resolved-job',
        contextGraphId: nameHash,
        resolvedContextGraphId: 'acme-fun-facts',
        includeWorkspace: true,
        status: 'done',
        jobStatus: 'done',
        queuedAt: 1,
        identity: { state: 'resolved', nameHash, contextGraphId: 'acme-fun-facts', message: 'resolves to "acme-fun-facts"' },
      });
    vi.spyOn(ApiClient, 'connect').mockResolvedValue({ catchupStatus } as unknown as ApiClient);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCatchupStatusCommand(nameHash, {});
    let output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain(`Error:         ${message}`);
    // The identity note repeats the error verbatim, so it is printed once.
    expect(output.split(message)).toHaveLength(2);
    expect(output).not.toContain('Retry once the network is healthier');

    log.mockClear();
    await runCatchupStatusCommand(nameHash, {});
    output = log.mock.calls.map(([line]) => String(line)).join('\n');
    expect(output).toContain('Resolved To:   acme-fun-facts');
    expect(output).toContain('Identity:      resolves to "acme-fun-facts"');
  });
});
