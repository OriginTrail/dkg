import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', async () => {
  const { mkdirSync } = await import('node:fs');
  return {
    execSync: vi.fn((cmd: string) => {
      return 'https://github.com/test/repo.git';
    }),
    execFileSync: vi.fn((binary: string, args: string[]) => {
      if (binary === 'git' && args[0] === 'clone') {
        const target = args[args.length - 1];
        if (target && !target.startsWith('git') && !target.startsWith('http')) {
          try { mkdirSync(target, { recursive: true }); } catch {}
        }
      }
      if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return 'https://github.com/test/repo.git';
      }
      return '';
    }),
  };
});

let tmpDir: string;
let dkgHome: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-mig-'));
  dkgHome = join(tmpDir, '.dkg');
  vi.stubEnv('DKG_HOME', dkgHome);
  await mkdir(dkgHome, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('migrateToBlueGreen', () => {
  it('skips migration when releases/current already exists', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
    await symlink('a', join(rDir, 'current'));

    const { migrateToBlueGreen } = await import('../src/migration.js');
    const log = vi.fn();
    await migrateToBlueGreen(log);

    expect(log).not.toHaveBeenCalled();
  });

  it('creates releases dir, slot a symlink, and current symlink', async () => {
    // The migration function uses repoDir() which resolves from import.meta.url.
    // Since we're in tests, it resolves to the actual repo root which IS a git repo.
    const { migrateToBlueGreen } = await import('../src/migration.js');
    const log = vi.fn();
    await migrateToBlueGreen(log);

    const rDir = join(dkgHome, 'releases');
    expect(existsSync(rDir)).toBe(true);
    expect(existsSync(join(rDir, 'a'))).toBe(true);
    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('a');
    const active = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
    expect(active).toBe('a');
  });

  it('restores current symlink from existing active metadata when valid', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'active'), 'b');

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

  it('slot b directory is created even if clone/build fails', async () => {
    const { migrateToBlueGreen } = await import('../src/migration.js');
    const log = vi.fn();
    await migrateToBlueGreen(log);

    const slotB = join(dkgHome, 'releases', 'b');
    expect(existsSync(slotB)).toBe(true);
  });

  it('data files remain in dkg root, not in slots', async () => {
    await writeFile(join(dkgHome, 'config.json'), '{}');
    await writeFile(join(dkgHome, 'wallets.json'), '{}');

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    expect(existsSync(join(dkgHome, 'config.json'))).toBe(true);
    expect(existsSync(join(dkgHome, 'wallets.json'))).toBe(true);
  });

  it('logs migration progress', async () => {
    const { migrateToBlueGreen } = await import('../src/migration.js');
    const log = vi.fn();
    await migrateToBlueGreen(log);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Migrating'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Migration complete'));
  });

  it('skips remote bootstrap when no local checkout exists and bootstrap is disallowed', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config.js')>();
      return {
        ...actual,
        repoDir: () => null,
      };
    });

    const { execSync, execFileSync } = await import('node:child_process');
    const mockedExecSync = vi.mocked(execSync);
    const mockedExecFileSync = vi.mocked(execFileSync);
    const { migrateToBlueGreen } = await import('../src/migration.js');
    const log = vi.fn();

    await migrateToBlueGreen(log, { allowRemoteBootstrap: false });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping remote bootstrap'));
    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(mockedExecSync).not.toHaveBeenCalled();

    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  it('passes configured ssh key via GIT_SSH_COMMAND during remote bootstrap clone', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config.js')>();
      return {
        ...actual,
        repoDir: () => null,
        loadConfig: async () => ({ autoUpdate: { enabled: true, repo: 'git@github.com:test/repo.git', branch: 'main', sshKeyPath: '/tmp/test key' } }),
        loadNetworkConfig: async () => undefined,
      };
    });

    const { execFileSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);
    const { migrateToBlueGreen } = await import('../src/migration.js');

    await migrateToBlueGreen(vi.fn(), { allowRemoteBootstrap: true });

    const cloneCall = mockedExecFileSync.mock.calls.find(c => String(c[0]) === 'git' && (c[1] as string[])[0] === 'clone');
    expect(cloneCall).toBeTruthy();
    expect((cloneCall?.[2] as { env?: Record<string, string> })?.env?.GIT_SSH_COMMAND).toBe("ssh -i '/tmp/test key' -o IdentitiesOnly=yes");

    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  it('passes GITHUB_TOKEN to git clone for https GitHub bootstrap repos', async () => {
    vi.resetModules();
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test_123');
    vi.doMock('../src/config.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config.js')>();
      return {
        ...actual,
        repoDir: () => null,
        loadConfig: async () => ({ autoUpdate: { enabled: true, repo: 'https://github.com/test/repo.git', branch: 'main' } }),
        loadNetworkConfig: async () => undefined,
      };
    });

    const { execFileSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);
    const { migrateToBlueGreen } = await import('../src/migration.js');

    await migrateToBlueGreen(vi.fn(), { allowRemoteBootstrap: true });

    const cloneCall = mockedExecFileSync.mock.calls.find(c => String(c[0]) === 'git' && (c[1] as string[]).includes('clone'));
    expect(cloneCall).toBeTruthy();
    expect((cloneCall?.[1] as string[])[0]).toBe('-c');
    expect((cloneCall?.[1] as string[])[1]).toContain('http.extraHeader=Authorization: Basic ');

    delete process.env.GITHUB_TOKEN;
    vi.doUnmock('../src/config.js');
    vi.resetModules();
  });

  // -------------------------------------------------------------------
  // Regression tests for bugs found during PR review cycles
  // -------------------------------------------------------------------

  it('migration uses git clone (not symlink) for slot A to prevent dev repo damage', async () => {
    const { execFileSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const cloneCalls = mockedExecFileSync.mock.calls
      .map(c => ({ binary: String(c[0]), args: c[1] as string[] }))
      .filter(call => call.binary === 'git' && call.args[0] === 'clone');

    // Slot A should be cloned, not symlinked
    expect(cloneCalls.some(call => call.args.includes('--local'))).toBe(true);
  });

  it('migration builds slot A after cloning (not just clone)', async () => {
    const { execSync } = await import('node:child_process');
    const mockedExecSync = vi.mocked(execSync);

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const allCmds = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(allCmds.some(cmd => cmd.includes('pnpm install'))).toBe(true);
    expect(allCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
  });

  it('migration slot B clone uses --dissociate to prevent repo corruption', async () => {
    const { execFileSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const cloneCalls = mockedExecFileSync.mock.calls
      .map(c => ({ binary: String(c[0]), args: c[1] as string[] }))
      .filter(call => call.binary === 'git' && call.args[0] === 'clone' && call.args.includes('--reference'));

    if (cloneCalls.length > 0) {
      expect(cloneCalls[0].args).toContain('--dissociate');
    }
  });

  it('when local repo exists, slot B clones from same local source path', async () => {
    const { execFileSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);
    const { repoDir } = await import('../src/config.js');
    const expectedSource = repoDir();

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const cloneCalls = mockedExecFileSync.mock.calls
      .map(c => ({ binary: String(c[0]), args: c[1] as string[] }))
      .filter(call => call.binary === 'git' && call.args[0] === 'clone');

    const slotBClone = cloneCalls.find(call => String(call.args[call.args.length - 1]).endsWith('/b'));
    expect(slotBClone).toBeTruthy();
    expect(slotBClone?.args).toContain(expectedSource!);
  });

  it('rebuilds slot A when directory exists but is incomplete', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotA = join(rDir, 'a');
    await mkdir(slotA, { recursive: true }); // create incomplete slot

    const { execFileSync, execSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);
    const mockedExecSync = vi.mocked(execSync);

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const gitCalls = mockedExecFileSync.mock.calls
      .map(c => ({ binary: String(c[0]), args: c[1] as string[] }))
      .filter(call => call.binary === 'git' && call.args[0] === 'clone');
    expect(gitCalls.some(call => call.args.includes('--local'))).toBe(true);
    const allCmds = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(allCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
  });

  it('repairs incomplete slots even when current symlink exists', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
    await mkdir(join(rDir, 'b'), { recursive: true }); // incomplete slot b
    await symlink('a', join(rDir, 'current'));

    const { execFileSync, execSync } = await import('node:child_process');
    const mockedExecFileSync = vi.mocked(execFileSync);
    const mockedExecSync = vi.mocked(execSync);

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const gitCloneCalls = mockedExecFileSync.mock.calls
      .map(c => ({ binary: String(c[0]), args: c[1] as string[] }))
      .filter(call => call.binary === 'git' && call.args[0] === 'clone');
    expect(gitCloneCalls.some(call => String(call.args[call.args.length - 1]).endsWith('/b'))).toBe(true);
    const buildCmds = mockedExecSync.mock.calls.map(c => String(c[0]));
    expect(buildCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
  });

  it('repairs non-symlink releases/current by recreating current symlink', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'active'), 'b');
    await mkdir(join(rDir, 'current'), { recursive: true }); // legacy broken state: directory instead of symlink

    const { migrateToBlueGreen } = await import('../src/migration.js');
    await migrateToBlueGreen(vi.fn());

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

});
