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
  executeRollbackActivation,
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

  it('aborts a rollback before activating the target when daemon shutdown times out', async () => {
    const swapSlot = vi.fn(async () => {});
    const errors: string[] = [];

    const prepareStores = vi.fn(async () => ({ release() {} }));
    await expect(executeRollbackActivation(() => swapSlot('b'), {
      stopDaemon: async () => false,
      prepareStores,
      error: (message) => errors.push(message),
    })).resolves.toBeNull();

    expect(prepareStores).not.toHaveBeenCalled();

    expect(swapSlot).not.toHaveBeenCalled();
    expect(errors).toEqual([
      'Rollback aborted because the daemon did not stop before its configured shutdown deadline.',
    ]);
  });

  it('stops the daemon and readies the stores before activating the rollback target', async () => {
    const calls: string[] = [];

    await expect(executeRollbackActivation(async () => { calls.push('swap:b'); return 'activated'; }, {
      stopDaemon: async () => { calls.push('stop'); return true; },
      prepareStores: async () => {
        calls.push('stores');
        return { release: () => { calls.push('release'); } };
      },
      error: () => {},
    })).resolves.toEqual({ result: 'activated' });

    expect(calls).toEqual(['stop', 'stores', 'swap:b', 'release']);
  });

  it('keeps the current version when the stores cannot be readied for the target', async () => {
    const swapSlot = vi.fn(async () => {});

    await expect(executeRollbackActivation(() => swapSlot('b'), {
      stopDaemon: async () => true,
      prepareStores: async () => null,
      error: () => {},
    })).resolves.toBeNull();

    expect(swapSlot).not.toHaveBeenCalled();
  });

  it('releases the stores when the activation fails', async () => {
    const release = vi.fn();

    await expect(executeRollbackActivation(async () => { throw new Error('slot link refused'); }, {
      stopDaemon: async () => true,
      prepareStores: async () => ({ release }),
      error: () => {},
    })).rejects.toThrow('slot link refused');

    expect(release).toHaveBeenCalledTimes(1);
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
