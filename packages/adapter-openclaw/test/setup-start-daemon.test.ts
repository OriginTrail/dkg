import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const resolvedDkgCli = vi.hoisted(() => ({ node: 'node-bin', cliPath: 'cli-path' }));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock('../src/resolve-dkg-cli.js', () => ({
  resolveDkgCli: () => resolvedDkgCli,
}));

vi.mock('@origintrail-official/dkg-core', async () => {
  const actual = await vi.importActual<typeof import('@origintrail-official/dkg-core')>(
    '@origintrail-official/dkg-core',
  );
  return {
    ...actual,
    requestFaucetFunding: vi.fn(),
    resolveDkgConfigHome: () => {
      if (!process.env.DKG_HOME) throw new Error('DKG_HOME must be set for this test');
      return process.env.DKG_HOME;
    },
  };
});

import { startDaemon } from '../src/setup.js';

const MIGRATION_START_TIMEOUT_MS = 60 * 60_000;

describe('startDaemon blue-green migration timeout handling', () => {
  let testDir: string;
  let dkgHome: string;
  let cliRepo: string;
  let originalDkgHome: string | undefined;
  let originalNoBlueGreen: string | undefined;

  beforeEach(() => {
    testDir = join(tmpdir(), `dkg-start-daemon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dkgHome = join(testDir, '.dkg');
    cliRepo = join(testDir, 'repo');
    mkdirSync(dkgHome, { recursive: true });
    mkdirSync(join(cliRepo, '.git'), { recursive: true });
    mkdirSync(join(cliRepo, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(cliRepo, 'package.json'), '{}\n');
    writeFileSync(join(cliRepo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(cliRepo, 'project.json'), '{}\n');
    writeFileSync(
      join(cliRepo, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@origintrail-official/dkg' }) + '\n',
    );
    writeFileSync(join(cliRepo, 'packages', 'cli', 'dist', 'cli.js'), '');
    originalDkgHome = process.env.DKG_HOME;
    originalNoBlueGreen = process.env.DKG_NO_BLUE_GREEN;
    process.env.DKG_HOME = dkgHome;
    delete process.env.DKG_NO_BLUE_GREEN;
    resolvedDkgCli.cliPath = join(cliRepo, 'packages', 'cli', 'dist', 'cli.js');

    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, signal: null, error: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = originalDkgHome;
    if (originalNoBlueGreen === undefined) delete process.env.DKG_NO_BLUE_GREEN;
    else process.env.DKG_NO_BLUE_GREEN = originalNoBlueGreen;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function spawnOptions(): Record<string, unknown> {
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    return spawnSyncMock.mock.calls[0][2] as Record<string, unknown>;
  }

  function seedReadySlot(slot: 'a' | 'b', layout: 'git' | 'npm' = 'git'): void {
    const slotDir = join(dkgHome, 'releases', slot);
    const entryDir = layout === 'git'
      ? join(slotDir, 'packages', 'cli', 'dist')
      : join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(entryDir, 'cli.js'), '');
    writeFileSync(join(slotDir, 'package.json'), '{}\n');
  }

  function seedCurrentSymlink(target: 'a' | 'b' = 'a'): void {
    const releasesDir = join(dkgHome, 'releases');
    const current = join(releasesDir, 'current');
    try {
      symlinkSync(target, current, 'dir');
    } catch {
      symlinkSync(join(releasesDir, target), current, 'junction');
    }
  }

  it('uses the migration-aware spawn timeout when releases/current is missing', async () => {
    await startDaemon(9200);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'node-bin',
      [resolvedDkgCli.cliPath, 'start'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(spawnOptions()).toMatchObject({ timeout: MIGRATION_START_TIMEOUT_MS });
  });

  it('uses the migration-aware spawn timeout when releases/current is not a symlink', async () => {
    mkdirSync(join(dkgHome, 'releases', 'current'), { recursive: true });

    await startDaemon(9200);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      'node-bin',
      [resolvedDkgCli.cliPath, 'start'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(spawnOptions()).toMatchObject({ timeout: MIGRATION_START_TIMEOUT_MS });
  });

  it('keeps the normal spawn timeout when blue-green slots are ready', async () => {
    seedReadySlot('a');
    seedReadySlot('b');
    seedCurrentSymlink('a');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({
      stdio: 'inherit',
      timeout: 30_000,
    });
  });

  it('uses the migration-aware spawn timeout when an inactive slot needs repair', async () => {
    seedReadySlot('a');
    mkdirSync(join(dkgHome, 'releases', 'b'), { recursive: true });
    seedCurrentSymlink('a');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: MIGRATION_START_TIMEOUT_MS });
  });

  it('keeps the normal spawn timeout when npm-layout blue-green slots are ready', async () => {
    seedReadySlot('a', 'npm');
    seedReadySlot('b', 'npm');
    seedCurrentSymlink('a');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: 30_000 });
  });

  it('keeps the normal spawn timeout when blue-green migration is disabled', async () => {
    process.env.DKG_NO_BLUE_GREEN = '1';

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: 30_000 });
  });

  it('keeps the normal spawn timeout when the CLI is not running from a local checkout', async () => {
    resolvedDkgCli.cliPath = join(testDir, 'standalone', 'dist', 'cli.js');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: 30_000 });
  });

  it('uses the migration-aware spawn timeout when the CLI path is symlinked into a local DKG checkout', async () => {
    const linkedPackageParent = join(testDir, 'host-repo', 'node_modules', '@origintrail-official');
    const linkedPackage = join(linkedPackageParent, 'dkg');
    mkdirSync(linkedPackageParent, { recursive: true });
    symlinkSync(cliRepo, linkedPackage, 'junction');
    resolvedDkgCli.cliPath = join(linkedPackage, 'packages', 'cli', 'dist', 'cli.js');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: MIGRATION_START_TIMEOUT_MS });
  });

  it('uses the migration-aware spawn timeout when the CLI is inside any git package workspace', async () => {
    const hostRepo = join(testDir, 'host-repo');
    mkdirSync(join(hostRepo, '.git'), { recursive: true });
    mkdirSync(join(hostRepo, 'packages', 'cli', 'dist'), { recursive: true });
    writeFileSync(join(hostRepo, 'package.json'), '{}\n');
    writeFileSync(join(hostRepo, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(join(hostRepo, 'project.json'), '{}\n');
    writeFileSync(
      join(hostRepo, 'packages', 'cli', 'package.json'),
      JSON.stringify({ name: '@example/not-dkg' }) + '\n',
    );
    resolvedDkgCli.cliPath = join(hostRepo, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');

    await startDaemon(9200);

    expect(spawnOptions()).toMatchObject({ timeout: MIGRATION_START_TIMEOUT_MS });
  });

  it('surfaces spawn errors clearly when daemon start fails', async () => {
    seedReadySlot('a');
    seedReadySlot('b');
    seedCurrentSymlink('a');
    spawnSyncMock.mockReturnValueOnce({
      status: null,
      signal: null,
      error: new Error('spawnSync node ETIMEDOUT'),
    });

    await expect(startDaemon(9200)).rejects.toThrow(
      /Failed to start DKG daemon: spawnSync node ETIMEDOUT/,
    );
    expect(spawnOptions()).toMatchObject({ timeout: 30_000 });
  });

  it('surfaces non-zero dkg start exits clearly', async () => {
    seedReadySlot('a');
    seedReadySlot('b');
    seedCurrentSymlink('a');
    spawnSyncMock.mockReturnValueOnce({ status: 1, signal: null, error: undefined });

    await expect(startDaemon(9200)).rejects.toThrow(
      /Failed to start DKG daemon: dkg start exited with 1/,
    );
    expect(spawnOptions()).toMatchObject({ timeout: 30_000 });
  });
});
