import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const commandWiring = vi.hoisted(() => ({ root: '', calls: [] as string[] }));

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: async () => ({ nodeRole: 'core' }),
    activeSlot: async () => 'a',
    releasesDir: () => `${commandWiring.root}/releases`,
    dkgDir: () => commandWiring.root,
    slotEntryPoint: (slotDir: string) => `${slotDir}/dist/cli.js`,
    swapSlot: async (target: 'a' | 'b') => { commandWiring.calls.push(`swap:${target}`); },
  };
});

vi.mock('../src/cli-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cli-helpers.js')>();
  return {
    ...actual,
    stopDaemonIfRunning: async () => { commandWiring.calls.push('stop'); return true; },
  };
});

vi.mock('../src/rollback-node-ui.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/rollback-node-ui.js')>();
  return { ...actual, ensureRollbackNodeUiBundle: () => true };
});

import {
  executeCoreRollbackActivation,
  registerMaintenanceCommands,
} from '../src/commands/maintenance.js';

describe('maintenance command shutdown gate', () => {
  beforeEach(async () => {
    commandWiring.root = await mkdtemp(join(tmpdir(), 'dkg-maintenance-command-'));
    commandWiring.calls.length = 0;
    await mkdir(join(commandWiring.root, 'releases', 'b'), { recursive: true });
  });

  afterEach(async () => {
    await rm(commandWiring.root, { recursive: true, force: true });
  });

  it('aborts Core rollback before swapping slots when daemon shutdown times out', async () => {
    const swapSlot = vi.fn(async () => {});
    const errors: string[] = [];

    await expect(executeCoreRollbackActivation('b', {
      stopDaemon: async () => false,
      swapSlot,
      error: (message) => errors.push(message),
    })).resolves.toBe(false);

    expect(swapSlot).not.toHaveBeenCalled();
    expect(errors).toEqual([
      'Rollback aborted because the daemon did not stop before its configured shutdown deadline.',
    ]);
  });

  it('stops the daemon before activating the exact Core rollback target', async () => {
    const calls: string[] = [];

    await expect(executeCoreRollbackActivation('b', {
      stopDaemon: async () => { calls.push('stop'); return true; },
      swapSlot: async (target) => { calls.push(`swap:${target}`); },
      error: () => {},
    })).resolves.toBe(true);

    expect(calls).toEqual(['stop', 'swap:b']);
  });

  it('wires the registered Core rollback action through the shutdown gate', async () => {
    const program = new Command();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    registerMaintenanceCommands(program);

    try {
      await program.parseAsync(['node', 'dkg', 'rollback']);
    } finally {
      log.mockRestore();
    }

    expect(commandWiring.calls).toEqual(['stop', 'swap:b']);
  });
});
