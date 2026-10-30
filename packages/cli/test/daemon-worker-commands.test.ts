import { Command } from 'commander';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerLifecycleCommands } from '../src/commands/lifecycle.js';

const { runDaemon } = vi.hoisted(() => ({
  runDaemon: vi.fn<(foreground: boolean) => Promise<void>>(),
}));

vi.mock('../src/daemon.js', () => ({ runDaemon }));

beforeEach(() => runDaemon.mockReset());

const workers = [
  ['daemon-worker', false],
  ['daemon-foreground-worker', true],
] as const;

function command(): Command {
  const program = new Command();
  registerLifecycleCommands(program);
  return program;
}

it.each(workers)('%s waits for its daemon with foreground=%s', async (name, foreground) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const lifetime = new Promise<void>(resolve => { release = resolve; });
  runDaemon.mockImplementation(async () => { entered(); await lifetime; });

  let settled = false;
  const execution = command().parseAsync(['node', 'dkg', name]).then(() => { settled = true; });
  try {
    await started;
    expect(runDaemon).toHaveBeenCalledExactlyOnceWith(foreground);
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release();
    await execution;
  }
  expect(settled).toBe(true);
});

it.each(workers)('%s propagates daemon startup failure with foreground=%s', async (name, foreground) => {
  const failure = new Error('daemon startup rejected');
  runDaemon.mockRejectedValueOnce(failure);

  await expect(command().parseAsync(['node', 'dkg', name])).rejects.toBe(failure);
  expect(runDaemon).toHaveBeenCalledExactlyOnceWith(foreground);
});
