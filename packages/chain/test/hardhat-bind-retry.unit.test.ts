import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';

const failure = vi.hoisted(() => ({ message: 'EADDRINUSE', children: [] as Array<{ kill: ReturnType<typeof vi.fn> }> }));
vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null as number | null, signalCode: null,
      kill: vi.fn(),
    });
    failure.children.push(child);
    queueMicrotask(() => {
      child.stderr.write(failure.message);
      child.exitCode = 1;
      child.emit('exit', 1, null);
    });
    return child;
  }),
}));

import { spawnHardhatEnv } from './hardhat-harness.js';

beforeEach(() => { failure.children.length = 0; });

it('bounds recovery when another process repeatedly claims the selected port', async () => {
  failure.message = 'Error: listen EADDRINUSE';
  await expect(spawnHardhatEnv(0)).rejects.toThrow('EADDRINUSE');
  expect(failure.children).toHaveLength(3);
  expect(failure.children.every((child) => child.kill.mock.calls.length === 1)).toBe(true);
});

it('does not retry other startup failures as port collisions', async () => {
  failure.message = 'invalid Hardhat configuration';
  await expect(spawnHardhatEnv(0)).rejects.toThrow('invalid Hardhat configuration');
  expect(failure.children).toHaveLength(1);
});
