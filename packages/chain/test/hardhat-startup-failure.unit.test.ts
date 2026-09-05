import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { beforeEach, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ message: 'EADDRINUSE', delayOutput: false, idle: false, children: [] as any[] }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null as string | null,
      kill: vi.fn(() => {
        child.signalCode = 'SIGTERM';
        child.stdout.end(); child.stderr.end(); child.emit('close', null, 'SIGTERM');
        return true;
      }),
    });
    failure.children.push(child);
    if (!failure.idle) queueMicrotask(() => {
      child.exitCode = 1;
      child.emit('exit', 1, null);
      const close = () => {
        child.stderr.write(failure.message);
        child.stdout.end(); child.stderr.end(); child.emit('close', 1, null);
      };
      if (failure.delayOutput) setTimeout(close, 75); else close();
    });
    return child;
  }),
}));

import { spawn } from 'node:child_process';
import { spawnHardhatEnv } from './hardhat-harness.js';
import { startHardhatNode } from './hardhat-harness.js';

beforeEach(() => { failure.children.length = 0; failure.delayOutput = false; failure.idle = false; vi.mocked(spawn).mockClear(); });

it.each([false, true])('retains complete startup diagnostics after stdio drains (delayed output=%s)', async (delayOutput) => {
  failure.message = 'Error: listen EADDRINUSE'; failure.delayOutput = delayOutput;
  await expect(spawnHardhatEnv()).rejects.toThrow('EADDRINUSE');
  expect(failure.children).toHaveLength(1);
  expect(vi.mocked(spawn).mock.calls.map((call) => call[1]![call[1]!.indexOf('--port') + 1])).toEqual(['0']);
});

it('fails immediately on an invalid Hardhat configuration', async () => {
  failure.message = 'invalid Hardhat configuration';
  await expect(spawnHardhatEnv()).rejects.toThrow('invalid Hardhat configuration');
  expect(failure.children).toHaveLength(1);
});

it('never deploys against a valid foreign RPC when the owned child is unready', async () => {
  failure.idle = true;
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end(JSON.stringify({ result: '0x0' })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await expect(startHardhatNode(60)).rejects.toThrow('failed to start');
    expect(requests).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure.children[0].kill).toHaveBeenCalledOnce();
    expect(server.listening).toBe(true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
