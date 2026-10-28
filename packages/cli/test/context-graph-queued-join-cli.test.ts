// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ApiClient } from '../src/api-client.js';
import { registerContextGraphCommand } from '../src/commands/context-graph.js';

async function requestJoin(
  queued: boolean,
  options: { answer?: Record<string, unknown>; flags?: string[]; reRequest?: boolean } = {},
) {
  const program = new Command().name('dkg').exitOverride();
  registerContextGraphCommand(program);
  const delegation = { scope: 'join:test:graph' };
  const requestJoin = vi.fn().mockResolvedValue(
    options.answer ?? { ok: true, status: 'pending', delivered: 0, queued },
  );
  vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    signJoinRequest: vi.fn().mockResolvedValue({ delegation }), requestJoin,
  } as unknown as ApiClient);
  await program.parseAsync([
    'node', 'dkg', 'context-graph', 'request-join', 'graph', 'curator-peer', ...(options.flags ?? []),
  ]);
  expect(requestJoin).toHaveBeenCalledWith(
    'graph',
    delegation,
    'curator-peer',
    undefined,
    { reRequest: options.reRequest ?? false },
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe('queued join request CLI', () => {
  it('reports automatic retry without exiting when delivery is durably queued', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('unexpected exit'); }) as typeof process.exit);
    await requestJoin(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Delivery will retry automatically'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('dkg context-graph info graph'));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('retains the failure exit when there was neither delivery nor queue acceptance', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit:1'); }) as typeof process.exit);
    await expect(requestJoin(false)).rejects.toThrow('exit:1');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not deliver join request'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('reports an approval whose member list is on its way without exiting (#3421)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('unexpected exit'); }) as typeof process.exit);
    await requestJoin(false, {
      answer: {
        ok: true,
        status: 'approved',
        joinState: 'approved-metadata-pending',
        delivered: 0,
        alreadyMember: true,
      },
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('member list is still on its way'));
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('asks for a new request with --re-request', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('unexpected exit'); }) as typeof process.exit);
    await requestJoin(false, {
      answer: { ok: true, status: 'pending', delivered: 1 },
      flags: ['--re-request'],
      reRequest: true,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Join request sent'));
  });
});
