import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api-client.js';
import { createPublicCheckpointClient } from '../src/public-checkpoint-client.js';
import { registerSyncCommand } from '../src/commands/sync.js';

const directories: string[] = [];
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode; process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks(); process.exitCode = previousExitCode;
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-cli-')); directories.push(directory);
  const file = join(directory, 'request.json');
  await writeFile(file, JSON.stringify({ contextGraphId: 'graph', onChainId: '14',
    mode: 'rpc-only', trustedCorePeerIds: ['core'], transport: 'bulk' }));
  const result = { state: 'verified-unpublished', current: false, activeStoreChanged: false, committed: 0 };
  const http = { post: vi.fn(async () => ({ id: 'owned-job', state: 'running' })),
    get: vi.fn(async () => ({ id: 'owned-job', state: 'complete', result })) };
  const connect = vi.spyOn(ApiClient, 'connect').mockResolvedValue({
    checkpoints: createPublicCheckpointClient(http as never),
  } as unknown as ApiClient);
  const run = (...args: string[]) => {
    const program = new Command(); registerSyncCommand(program);
    return program.parseAsync(['node', 'dkg', 'sync', 'prepare-bootstrap', '--request', file, ...args]);
  };
  return { file, run, http, result, connect };
}

describe('public bootstrap preparation command', () => {
  it.each([false, true])('submits one bounded request and reports unpublished preparation (native=%s)', async native => {
    const f = await fixture();
    if (native) f.http.get.mockResolvedValueOnce({ id: 'owned-job', state: 'running' } as never);
    await f.run(...(native ? ['--native'] : []));
    expect(process.exitCode).toBeUndefined();
    expect(f.http.post).toHaveBeenCalledExactlyOnceWith('/api/context-graph/snapshot-checkpoint', {
      contextGraphId: 'graph', onChainId: '14', mode: 'rpc-only', trustedCorePeerIds: ['core'], native,
    });
    expect(f.http.get).toHaveBeenCalledWith('/api/context-graph/snapshot-checkpoint', { auth: true });
    expect(f.http.get).toHaveBeenCalledTimes(native ? 2 : 1);
    expect(console.log).toHaveBeenLastCalledWith(JSON.stringify(f.result, null, 2));
    expect(console.error).not.toHaveBeenCalled();
  });
  it.each(['oversize', 'malformed', 'policy'] as const)('refuses a %s request before contacting the daemon', async failure => {
    const f = await fixture();
    await writeFile(f.file, failure === 'oversize' ? ' '.repeat(4097) : failure === 'malformed' ? '{' : '{}');
    await f.run();
    expect(process.exitCode).toBe(1); expect(f.connect).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce(); expect(console.log).not.toHaveBeenCalled();
  });
  it.each(['no identity', 'ownership', 'failed', 'deadline'] as const)('retains a %s outcome without submitting a replacement job', async failure => {
    const f = await fixture();
    if (failure === 'no identity') f.http.post.mockResolvedValue({ state: 'running' } as never);
    if (failure === 'ownership') f.http.get.mockResolvedValue({ id: 'different-job', state: 'complete', result: f.result });
    if (failure === 'failed') f.http.get.mockResolvedValue({ id: 'owned-job', state: 'failed', error: 'Inventory changed' } as never);
    if (failure === 'deadline') {
      vi.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValue(3_601_000);
      f.http.get.mockResolvedValue({ id: 'owned-job', state: 'running' } as never);
    }
    await f.run('--native');
    const error = { 'no identity': 'no job identity', ownership: 'ownership changed', failed: 'Inventory changed', deadline: 'snapshot deadline' }[failure];
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(f.http.post).toHaveBeenCalledOnce();
    expect(f.http.get).toHaveBeenCalledTimes(failure === 'no identity' ? 0 : 1);
    expect(console.log).not.toHaveBeenCalledWith(JSON.stringify(f.result, null, 2));
  });
});
