/**
 * `dkg store harden` — Commander action wrapper tests.
 *
 * The migration executor is covered in blazegraph-harden.test.ts, but the
 * command wrapper owns the parts operators actually invoke: the
 * managed-config gate, the running-daemon --yes refusal, dry-run routing,
 * the confirmation prompt, and persisting options.containerName on
 * success. These tests drive the REAL registerStoreCommand action through
 * commander with the config loader, pid probes, readline, and the harden
 * executor mocked — so a regression that e.g. moves the executor call
 * before the confirmation, or drops the running-daemon refusal, fails
 * here even though every executor-level test stays green.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  dkgDir: vi.fn(),
  readPid: vi.fn(),
  isProcessRunning: vi.fn(),
  executeHardenMigration: vi.fn(),
  // Scripted answer for the confirmation prompt; null = prompting is an error.
  confirmAnswer: { value: null as string | null },
  questionCalls: [] as string[],
}));

vi.mock('../src/config.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    saveConfig: mocks.saveConfig,
    dkgDir: mocks.dkgDir,
    readPid: mocks.readPid,
    isProcessRunning: mocks.isProcessRunning,
  };
});

vi.mock('../src/daemon/blazegraph-harden.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/daemon/blazegraph-harden.js')>();
  return {
    ...actual,
    executeHardenMigration: mocks.executeHardenMigration,
  };
});

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (q: string, cb: (answer: string) => void) => {
      mocks.questionCalls.push(q);
      if (mocks.confirmAnswer.value == null) {
        throw new Error('confirmation prompt fired but the test scripted no answer');
      }
      cb(mocks.confirmAnswer.value);
    },
    close: () => {},
  }),
}));

const { registerStoreCommand } = await import('../src/commands/store.js');

const MANAGED_STORE = () => ({
  backend: 'blazegraph',
  options: {
    url: 'http://127.0.0.1:9999/bigdata/namespace/dkg/sparql',
    managedByDkg: true,
  },
});

const HARDENED_RESULT = {
  outcome: 'hardened' as const,
  containerName: 'dkg-blazegraph-dkg',
  backupContainerName: 'dkg-blazegraph-dkg-backup',
  hostPort: 9999,
  exportPath: '/tmp/x/bigdata.jnl',
  journalBytes: 1000,
  heapMb: 3072,
};

const DRY_RUN_RESULT = {
  ...HARDENED_RESULT,
  outcome: 'dry-run' as const,
  exportPath: null,
  journalBytes: null,
  steps: [
    { id: 'stop', description: 'stop it', dockerArgs: ['stop', '-t', '120', 'dkg-blazegraph-dkg'], predicate: 'stopped' },
  ],
};

async function runHarden(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStoreCommand(program);
  await program.parseAsync(['node', 'dkg', 'store', 'harden', ...args]);
}

describe('dkg store harden command wrapper', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dkg-store-harden-cmd-'));
    mocks.questionCalls.length = 0;
    mocks.confirmAnswer.value = null;
    mocks.dkgDir.mockReturnValue(home);
    mocks.loadConfig.mockResolvedValue({ name: 'test-node', store: MANAGED_STORE() });
    mocks.saveConfig.mockResolvedValue(undefined);
    mocks.readPid.mockResolvedValue(null);
    mocks.isProcessRunning.mockReturnValue(false);
    mocks.executeHardenMigration.mockImplementation(async (opts: { dryRun?: boolean }) =>
      opts.dryRun ? DRY_RUN_RESULT : HARDENED_RESULT,
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses non-managed configs before touching the executor', async () => {
    mocks.loadConfig.mockResolvedValue({ name: 'test-node', store: { backend: 'oxigraph' } });
    await expect(runHarden('--yes')).rejects.toThrow('process.exit:1');
    expect(mocks.executeHardenMigration).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('refuses a running daemon without --yes BEFORE any executor call (even the preview)', async () => {
    writeFileSync(join(home, 'daemon.pid'), '4242\n');
    mocks.readPid.mockResolvedValue(4242);
    mocks.isProcessRunning.mockReturnValue(true);
    await expect(runHarden()).rejects.toThrow('process.exit:1');
    // Not even the dry-run preview may run: the refusal is the FIRST gate
    // after config validation, so a wedged store can be hardened calmly
    // after `dkg stop` instead of mid-daemon by accident.
    expect(mocks.executeHardenMigration).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('a running daemon WITH --yes proceeds to the executor', async () => {
    writeFileSync(join(home, 'daemon.pid'), '4242\n');
    mocks.readPid.mockResolvedValue(4242);
    mocks.isProcessRunning.mockReturnValue(true);
    await runHarden('--yes');
    const dryRunFlags = mocks.executeHardenMigration.mock.calls.map((c) => c[0].dryRun === true);
    expect(dryRunFlags).toEqual([true, false]); // preview, then the real run
  });

  it('--dry-run routes to the executor exactly once, dryRun: true, and never saves config', async () => {
    await runHarden('--dry-run');
    expect(mocks.executeHardenMigration).toHaveBeenCalledTimes(1);
    expect(mocks.executeHardenMigration.mock.calls[0][0]).toMatchObject({
      dryRun: true,
      containerName: 'dkg-blazegraph-dkg', // derived from the store URL namespace
      namespace: 'dkg',
      dkgHome: home,
    });
    expect(mocks.questionCalls).toHaveLength(0); // no confirmation for a dry run
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('an accepted run (--yes) shows the preview, executes, and persists options.containerName', async () => {
    await runHarden('--yes');
    // Call 1 = dry-run preview (plan shown before the swap), call 2 = real.
    expect(mocks.executeHardenMigration).toHaveBeenCalledTimes(2);
    expect(mocks.executeHardenMigration.mock.calls[0][0].dryRun).toBe(true);
    const realCall = mocks.executeHardenMigration.mock.calls[1][0];
    expect(realCall.dryRun).toBeUndefined();
    expect(realCall).toMatchObject({
      containerName: 'dkg-blazegraph-dkg',
      namespace: 'dkg',
      dkgHome: home, // harden lock must land where the daemon monitor watches
    });
    // Success persists the container name so monitor/boot-recovery/harden
    // stop depending on URL parsing.
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    const saved = mocks.saveConfig.mock.calls[0][0];
    expect(saved.store.options.containerName).toBe('dkg-blazegraph-dkg');
  });

  it('a declined confirmation aborts after the preview without executing or saving', async () => {
    mocks.confirmAnswer.value = 'n';
    await runHarden();
    expect(mocks.questionCalls).toHaveLength(1);
    // Only the dry-run preview ran; the real migration never started.
    expect(mocks.executeHardenMigration).toHaveBeenCalledTimes(1);
    expect(mocks.executeHardenMigration.mock.calls[0][0].dryRun).toBe(true);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('an accepted confirmation (y) executes after the prompt', async () => {
    mocks.confirmAnswer.value = 'y';
    await runHarden();
    expect(mocks.questionCalls).toHaveLength(1);
    const dryRunFlags = mocks.executeHardenMigration.mock.calls.map((c) => c[0].dryRun === true);
    expect(dryRunFlags).toEqual([true, false]);
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('passes --container, --port and --migration-dir through to the executor', async () => {
    await runHarden('--yes', '--container', 'my-bg', '--port', '10123', '--migration-dir', '/mnt/big');
    const realCall = mocks.executeHardenMigration.mock.calls.at(-1)![0];
    expect(realCall).toMatchObject({
      containerName: 'my-bg',
      hostPort: 10123,
      migrationDir: '/mnt/big',
    });
  });
});
