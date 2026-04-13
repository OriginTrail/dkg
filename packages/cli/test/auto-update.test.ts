import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoUpdateConfig } from '../src/config.js';

const MARKITDOWN_TARGETS_JSON = JSON.stringify([
  { platform: 'linux', arch: 'x64', assetName: 'markitdown-linux-x64', runner: 'ubuntu-latest' },
  { platform: 'darwin', arch: 'arm64', assetName: 'markitdown-darwin-arm64', runner: 'macos-14' },
  { platform: 'win32', arch: 'x64', assetName: 'markitdown-win32-x64.exe', runner: 'windows-latest' },
]);

function mockReadFileSyncValue(path: unknown): string {
  const normalized = String(path).replace(/\\/g, '/');
  if (normalized.endsWith('/markitdown-targets.json')) return MARKITDOWN_TARGETS_JSON;
  if (normalized.endsWith('/package.json')) return JSON.stringify({ version: '9.0.0-beta.6' });
  return `${process.pid}:${Date.now()}:testtoken`;
}

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, cb: Function) => cb(null, '', '')),
  execFile: vi.fn((_file: string, _args: string[], _opts: any, cb: Function) => cb(null, '', '')),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    rm: vi.fn(),
    symlink: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    readlink: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    openSync: vi.fn(() => 99),
    closeSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn((path: unknown) => mockReadFileSyncValue(path)),
    unlinkSync: vi.fn(),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

let mockActiveSlot = 'a';
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    dkgDir: () => '/tmp/dkg-test',
    releasesDir: () => '/tmp/dkg-test/releases',
    activeSlot: () => Promise.resolve(mockActiveSlot as 'a' | 'b'),
    inactiveSlot: () => Promise.resolve(mockActiveSlot === 'a' ? 'b' : 'a' as 'a' | 'b'),
    swapSlot: vi.fn(),
  };
});

import { copyFile, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, openSync, closeSync, writeFileSync as fsWriteFileSync, readFileSync, unlinkSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { checkForNewCommitWithStatus, checkForUpdate, performUpdate, performNpmUpdate } from '../src/daemon.js';
import { swapSlot } from '../src/config.js';

const mockedCopyFile = vi.mocked(copyFile);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);
const mockedRm = vi.mocked(rm);
const mockedExistsSync = vi.mocked(existsSync);
const mockedOpenSync = vi.mocked(openSync);
const mockedCloseSync = vi.mocked(closeSync);
const mockedFsWriteFileSync = vi.mocked(fsWriteFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedSwapSlot = vi.mocked(swapSlot);
const mockedExec = vi.mocked(exec);
const mockedExecFile = vi.mocked(execFile);

const AU: AutoUpdateConfig = {
  enabled: true,
  repo: 'owner/repo',
  branch: 'main',
  checkIntervalMinutes: 30,
};

function normalizePathString(value: unknown): string {
  return String(value).replace(/\\/g, '/');
}

function sha256HexForTest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeFetchOk(sha: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ sha }),
  });
}

function getExecCalls() {
  return mockedExec.mock.calls.map(c => ({
    cmd: String(c[0]),
    cwd: normalizePathString((c[1] as any)?.cwd),
  }));
}

function getExecFileCalls() {
  return mockedExecFile.mock.calls.map(c => ({
    file: String(c[0]),
    args: (c[1] as string[]) ?? [],
    cwd: normalizePathString((c[2] as any)?.cwd),
    env: (c[2] as any)?.env,
  }));
}

describe('blue-green checkForUpdate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockActiveSlot = 'a';
    mockedExistsSync.mockReturnValue(true);
    mockedCopyFile.mockResolvedValue(undefined as any);
    mockedMkdir.mockResolvedValue(undefined as any);
    mockedRm.mockResolvedValue(undefined as any);
    mockedOpenSync.mockReturnValue(99 as any);
    mockedCloseSync.mockReturnValue(undefined as any);
    mockedFsWriteFileSync.mockReturnValue(undefined as any);
    mockedReadFileSync.mockImplementation((path: unknown) => mockReadFileSyncValue(path) as any);
    mockedUnlinkSync.mockReturnValue(undefined as any);
    (mockedExec as any).mockImplementation((_cmd: string, _opts: any, cb: Function) => cb(null, '', ''));
    (mockedExecFile as any).mockImplementation((_file: string, _args: string[], _opts: any, cb: Function) => cb(null, '', ''));
  });

  it('skips when blue-green slots are not initialized', async () => {
    mockedExistsSync.mockReturnValue(false);
    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slots not initialized'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reinitializes missing target slot git metadata before fetch', async () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.endsWith('/releases/a')) return true; // active slot path
      if (path.endsWith('/releases/b/.git')) return false; // target slot missing git metadata
      if (path.includes('cli.js')) return true;
      return true;
    });
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('bbb222');

    const result = await performUpdate(AU, vi.fn());
    expect(result).toBe(true);

    const gitCmds = getExecFileCalls();
    const targetDir = '/tmp/dkg-test/releases/b';
    expect(gitCmds.some(c => c.file === 'git' && c.args.join(' ') === 'init' && c.cwd === targetDir)).toBe(true);
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'fetch' && c.cwd === targetDir)).toBe(true);
  });

  it('uses ssh git transport with configured ssh key path', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa1111' as any);
    (mockedExecFile as any).mockImplementation((file: string, args: string[], opts: any, cb: Function) => {
      if (file === 'git' && args[0] === 'ls-remote') return cb(null, 'bbb2222\trefs/heads/main\n', '');
      return cb(null, '', '');
    });

    const sshAu: AutoUpdateConfig = {
      ...AU,
      repo: 'git@github.com:owner/repo.git',
      sshKeyPath: '/tmp/test key',
    };

    const result = await checkForNewCommitWithStatus(sshAu, vi.fn());
    expect(result.status).toBe('available');
    expect(fetchMock).not.toHaveBeenCalled();

    const gitCmds = getExecFileCalls().filter(c => c.file === 'git' && c.args[0] === 'ls-remote');
    expect(gitCmds.length).toBeGreaterThan(0);
    expect(gitCmds.every(c => c.env?.GIT_SSH_COMMAND === "ssh -i '/tmp/test key' -o IdentitiesOnly=yes")).toBe(true);
  });

  it('passes GITHUB_TOKEN to git fetch for https GitHub repos', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test_123');
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('bbb222');

    const result = await performUpdate({ ...AU, repo: 'https://github.com/owner/repo.git' }, vi.fn());
    expect(result).toBe(true);

    const fetchCall = getExecFileCalls().find(c => c.file === 'git' && c.args.includes('fetch'));
    expect(fetchCall).toBeTruthy();
    expect(fetchCall?.args[0]).toBe('-c');
    expect(fetchCall?.args[1]).toContain('http.extraHeader=Authorization: Basic ');
    expect(fetchCall?.args).toContain('fetch');
    expect(fetchCall?.args).toContain('https://github.com/owner/repo.git');

    delete process.env.GITHUB_TOKEN;
  });

  it('skips when no new commit', async () => {
    const sha = 'abc123';
    mockedReadFile.mockResolvedValueOnce(sha as any);
    makeFetchOk(sha);

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('builds in inactive slot on new commit', async () => {
    const current = 'aaa111';
    const latest = 'bbb222';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);

    const allCmds = getExecCalls();
    const gitCmds = getExecFileCalls();
    const targetDir = '/tmp/dkg-test/releases/b';
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'fetch' && c.cwd === targetDir)).toBe(true);
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'checkout' && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm install') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm build') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('bundle-markitdown-binaries.mjs') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('--force') && c.cwd === targetDir)).toBe(false);
    expect(allCmds.some(c => c.cmd.includes('--best-effort') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm --filter @origintrail-official/dkg-evm-module build') && c.cwd === targetDir)).toBe(false);

    const activeDir = '/tmp/dkg-test/releases/a';
    expect(allCmds.every(c => c.cwd !== activeDir)).toBe(true);
  });

  it('swaps symlink after successful build', async () => {
    const current = 'aaa111';
    const latest = 'ccc333';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);

    await performUpdate(AU, vi.fn());

    expect(mockedSwapSlot).toHaveBeenCalledWith('b');
    expect(
      mockedWriteFile.mock.calls.some((call) =>
        normalizePathString(call[0]).endsWith('/tmp/dkg-test/.current-commit') && call[1] === latest)
    ).toBe(true);
  });

  it('returns true after swap via checkForUpdate', async () => {
    const current = 'aaa111';
    const latest = 'ddd444';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);

    const log = vi.fn();
    const updated = await checkForUpdate(AU, log);
    expect(updated).toBe(true);
  });

  it('build failure does not swap', async () => {
    const current = 'aaa111';
    const latest = 'eee555';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);
    (mockedExec as any).mockImplementation((cmd: string, _opts: any, cb: Function) => {
      if (String(cmd).includes('pnpm build')) return cb(new Error('build exploded'), '', '');
      return cb(null, '', '');
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(mockedSwapSlot).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('build failed'));
  });

  it('build failure does not touch active slot', async () => {
    const current = 'aaa111';
    const latest = 'fff666';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);
    (mockedExec as any).mockImplementation((cmd: string, _opts: any, cb: Function) => {
      if (String(cmd).includes('pnpm build')) return cb(new Error('build exploded'), '', '');
      return cb(null, '', '');
    });

    await performUpdate(AU, vi.fn());

    const allCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    const activeDir = '/tmp/dkg-test/releases/a';
    expect(allCwds.every((cwd: string) => cwd !== activeDir)).toBe(true);
  });

  it('fetch failure does not attempt build', async () => {
    const current = 'aaa111';
    const latest = 'ggg777';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);
    (mockedExecFile as any).mockImplementation((file: string, args: string[], _opts: any, cb: Function) => {
      if (file === 'git' && args[0] === 'fetch') return cb(new Error('network down'), '', '');
      return cb(null, '', '');
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);

    const allCmds = getExecCalls().map(c => c.cmd);
    expect(allCmds.some(c => c.includes('pnpm install'))).toBe(false);
    expect(allCmds.some(c => c.includes('pnpm build'))).toBe(false);
  });

  it('slot alternation — consecutive updates build in alternating slots', async () => {
    // First update: active=a, builds in b
    mockActiveSlot = 'a';
    mockedReadFile.mockResolvedValueOnce('commit1' as any);
    makeFetchOk('commit2');

    await performUpdate(AU, vi.fn());
    const firstBuildCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    expect(firstBuildCwds.some((cwd: string) => cwd.includes('/b'))).toBe(true);

    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(true);
    (mockedExec as any).mockImplementation((_cmd: string, _opts: any, cb: Function) => cb(null, '', ''));

    // Second update: active=b, builds in a
    mockActiveSlot = 'b';
    mockedReadFile.mockResolvedValueOnce('commit2' as any);
    makeFetchOk('commit3');

    await performUpdate(AU, vi.fn());
    const secondBuildCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    expect(secondBuildCwds.some((cwd: string) => cwd.includes('/a'))).toBe(true);
  });

  // -------------------------------------------------------------------
  // Regression tests for bugs found during PR review cycles
  // -------------------------------------------------------------------

  it('rejects branch names with shell injection characters', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    const log = vi.fn();

    const malicious: AutoUpdateConfig = {
      ...AU,
      branch: 'main; rm -rf /',
    };
    const result = await performUpdate(malicious, log);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid branch'));
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedExecFile).not.toHaveBeenCalled();
  });

  it('aborts swap when build output (cli.js) is missing', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('newcommit');

    // existsSync returns true for dirs but false for cli.js entry file
    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('cli.js')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(mockedSwapSlot).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('build output missing'));
  });

  it('continues the swap when the bundled MarkItDown binary is missing after build', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('newcommit');

    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('markitdown-')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(mockedSwapSlot).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Continuing without document conversion'));
  });

  it('reuses the active-slot MarkItDown binary when staging misses it during git update', async () => {
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    mockedReadFile.mockImplementation(async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.current-commit')) return 'aaa111' as any;
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n` as any;
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-')) return sourceBytes as any;
      throw new Error(`Unexpected readFile path: ${normalized}`);
    });
    makeFetchOk('newcommit');

    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/packages/cli/bin/markitdown-')) return true;
      if (path.includes('/releases/b/packages/cli/bin/markitdown-')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(mockedCopyFile).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reused bundled MarkItDown binary from the active slot'));
  });

  it('continues the update when active-slot MarkItDown reuse copy fails', async () => {
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    mockedReadFile.mockImplementation(async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.current-commit')) return 'aaa111' as any;
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n` as any;
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-')) return sourceBytes as any;
      throw new Error(`Unexpected readFile path: ${normalized}`);
    });
    makeFetchOk('newcommit');
    mockedCopyFile.mockRejectedValueOnce(new Error('disk full') as any);

    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/packages/cli/bin/markitdown-')) return true;
      if (path.includes('/releases/b/packages/cli/bin/markitdown-')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to reuse bundled MarkItDown binary from the active slot'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Continuing without document conversion'));
  });

  it('self-heals when target slot has no .git directory (empty dir from failed migration)', async () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.endsWith('/releases/a')) return true;
      if (path.endsWith('/releases/b/.git')) return false;
      if (path.includes('cli.js')) return true;
      return true;
    });
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('bbb222');

    const result = await performUpdate(AU, vi.fn());
    expect(result).toBe(true);
    const targetDir = '/tmp/dkg-test/releases/b';
    const gitCmds = getExecFileCalls();
    expect(gitCmds.some(c => c.file === 'git' && c.args.join(' ') === 'init' && c.cwd === targetDir)).toBe(true);
  });

  it('commit file is written before swap (crash safety)', async () => {
    mockedReadFile.mockResolvedValueOnce('old-commit' as any);
    makeFetchOk('new-commit');

    const callOrder: string[] = [];
    mockedWriteFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.includes('.update-pending.json')) callOrder.push('writePending');
      else if (p.includes('.current-commit')) callOrder.push('writeCommit');
    });
    mockedSwapSlot.mockImplementation(async () => { callOrder.push('swapSlot'); });

    await performUpdate(AU, vi.fn());

    const writeIdx = callOrder.indexOf('writePending');
    const swapIdx = callOrder.indexOf('swapSlot');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(writeIdx);
  });

  it('clears pending file if swap fails', async () => {
    const oldCommit = 'old-sha-111';
    const newCommit = 'new-sha-222';
    mockedReadFile.mockResolvedValueOnce(oldCommit as any);
    makeFetchOk(newCommit);

    mockedSwapSlot.mockRejectedValueOnce(new Error('symlink failed'));

    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('symlink swap failed'));
    // commit file should not be rewritten to the new commit on failed swap
    const commitWrites = mockedWriteFile.mock.calls.filter((c) => String(c[0]).includes('.current-commit'));
    expect(commitWrites.length).toBe(0);
  });

  it('checkForNewCommit is read-only — does not build, swap, or modify files', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    makeFetchOk('new-sha');

    const log = vi.fn();
    const result = await checkForNewCommit(AU, log);

    expect(result).toBe('new-sha');
    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedSwapSlot).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('checkForNewCommit supports non-GitHub repos via git ls-remote', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    (mockedExecFile as any).mockImplementation((file: string, args: string[], _opts: any, cb: Function) => {
      if (file === 'git' && args[0] === 'ls-remote') {
        return cb(null, 'abcdef1234567890abcdef1234567890abcdef12\trefs/heads/main\n', '');
      }
      return cb(null, '', '');
    });
    const log = vi.fn();

    const result = await checkForNewCommit({ ...AU, repo: 'ssh://git.example.com/non-github.git' }, log);

    expect(result).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('failed to check for new commit'));
  });

  it('checkForNewCommit also validates branch names', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    const log = vi.fn();

    const result = await checkForNewCommit({
      ...AU,
      branch: '$(whoami)',
    }, log);

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid branch'));
  });

  it('rejects unsafe repo specs that start with dash', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('bbb222');
    const log = vi.fn();

    const result = await performUpdate(
      { ...AU, repo: '-c protocol.file.allow=always' },
      log,
    );

    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid autoUpdate.repo'));
    expect(mockedExecFile.mock.calls.some(c => String(c[0]) === 'git' && (c[1] as string[])[0] === 'fetch')).toBe(false);
  });

  it('rejects refs that start with dash to avoid git option injection', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    const log = vi.fn();

    const result = await checkForNewCommit({
      ...AU,
      branch: '--upload-pack=/tmp/pwn',
    }, log);

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('invalid branch/ref'));
  });

  it('checkForNewCommit handles fetch/network errors without throwing', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    fetchMock.mockRejectedValueOnce(new Error('network timeout'));
    const log = vi.fn();

    const result = await checkForNewCommit(AU, log);

    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failed to check for new commit'));
  });

  it('supports explicit tag refs for version-targeted updates', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    makeFetchOk('tagsha123');

    const result = await performUpdate(AU, vi.fn(), { refOverride: 'refs/tags/v9.0.5', verifyTagSignature: true });
    expect(result).toBe(true);
    const fetchUrl = String(fetchMock.mock.calls[0]?.[0] ?? '');
    expect(fetchUrl).toContain('/commits/v9.0.5');
    expect(fetchUrl).not.toContain('refs%2Ftags%2Fv9.0.5');
    const allGitCalls = getExecFileCalls();
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'fetch https://github.com/owner/repo.git refs/tags/v9.0.5:refs/tags/v9.0.5')).toBe(true);
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'verify-tag v9.0.5')).toBe(true);
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'checkout --force FETCH_HEAD')).toBe(true);
  });

  it('accepts refs containing build metadata (+) for tag checks', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    mockedReadFile.mockResolvedValueOnce('current-sha' as any);
    makeFetchOk('new-sha');
    const log = vi.fn();

    const result = await checkForNewCommit(
      { ...AU, branch: 'refs/tags/v1.2.3+build.5' },
      log,
    );

    expect(result).toBe('new-sha');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('invalid branch/ref'));
  });

  it('logs clear error when requested tag does not exist', async () => {
    mockedReadFile.mockResolvedValueOnce('aaa111' as any);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 422 } as any);
    const log = vi.fn();

    const result = await performUpdate(AU, log, { refOverride: 'refs/tags/v9.0.5' });

    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tag "v9.0.5" not found'));
  });

  it('blocks pre-release versions unless allowPrerelease is true', async () => {
    mockedReadFile.mockImplementation(async (path: any) => {
      const p = normalizePathString(path);
      if (p.endsWith('.current-commit')) return 'aaa111' as any;
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('/packages/cli/package.json')) return JSON.stringify({ version: '9.0.5-rc.1' }) as any;
      throw new Error(`Unexpected readFile path: ${p}`);
    });
    makeFetchOk('rcsha123');

    const log = vi.fn();
    const result = await performUpdate({ ...AU, allowPrerelease: false }, log);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pre-release'));
    expect(mockedSwapSlot).not.toHaveBeenCalled();
  });

  it('allows pre-release versions when allowPrerelease=true', async () => {
    mockedReadFile.mockImplementation(async (path: any) => {
      const p = normalizePathString(path);
      if (p.endsWith('.current-commit')) return 'aaa111' as any;
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('/packages/cli/package.json')) return JSON.stringify({ version: '9.0.5-rc.1' }) as any;
      throw new Error(`Unexpected readFile path: ${p}`);
    });
    makeFetchOk('rcsha999');

    const result = await performUpdate({ ...AU, allowPrerelease: true }, vi.fn());
    expect(result).toBe(true);
    expect(mockedSwapSlot).toHaveBeenCalled();
  });
});

describe('checkForNpmVersionUpdate tag precedence', () => {
  function makeRegistryResponse(distTags: Record<string, string>) {
    return {
      ok: true,
      json: async () => ({ 'dist-tags': distTags }),
    } as any;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockedReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-version')) return '9.0.0-beta.3' as any;
      throw new Error('ENOENT');
    });
  });

  it('uses latest tag when allowPrerelease=false and latest is stable', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce(makeRegistryResponse({
      latest: '9.1.0',
      dev: '9.2.0-dev.123.abc1234',
    }));
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, false);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.1.0');
  });

  it('skips when allowPrerelease=false and latest is a prerelease', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce(makeRegistryResponse({
      latest: '9.1.0-beta.1',
      dev: '9.2.0-dev.123.abc1234',
    }));
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, false);
    expect(result.status).toBe('up-to-date');
  });

  it('picks highest version across dev/latest/beta when allowPrerelease=true', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce(makeRegistryResponse({
      latest: '9.0.0-beta.4',
      dev: '9.0.0-beta.4-dev.999.abc1234',
      beta: '9.0.0-beta.3',
    }));
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, true);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.0.0-beta.4-dev.999.abc1234');
  });

  it('prefers stable latest over older dev tag when allowPrerelease=true', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce(makeRegistryResponse({
      latest: '9.1.0',
      dev: '9.0.0-beta.4-dev.123.abc1234',
    }));
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, true);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.1.0');
  });

  it('returns error on registry failure', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as any);
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, true);
    expect(result.status).toBe('error');
  });

  it('returns up-to-date when current version matches latest', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchMock.mockResolvedValueOnce(makeRegistryResponse({
      latest: '9.0.0-beta.3',
    }));
    const log = vi.fn();
    const result = await checkForNpmVersionUpdate(log, true);
    expect(result.status).toBe('up-to-date');
  });
});

describe('performNpmUpdate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockActiveSlot = 'a';
    mockedExistsSync.mockReturnValue(true);
    mockedMkdir.mockResolvedValue(undefined as any);
    mockedRm.mockResolvedValue(undefined as any);
    mockedWriteFile.mockResolvedValue(undefined as any);
    mockedReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.100.abc1234' }) as any;
      throw new Error(`Unexpected readFile: ${p}`);
    });
    mockedExec.mockImplementation((_cmd: any, _opts: any, cb: any) => cb(null, '', '') as any);
  });

  it('installs package and swaps slot on success', async () => {
    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.4-dev.100.abc1234', log);
    expect(result).toBe('updated');
    expect(mockedSwapSlot).toHaveBeenCalledWith('b');
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.current-version'),
      '9.0.0-beta.4-dev.100.abc1234',
    );
  });

  it('returns failed when npm install throws', async () => {
    mockedExec.mockImplementation((_cmd: any, _opts: any, cb: any) =>
      cb(new Error('npm ERR! 404'), '', '') as any);
    const log = vi.fn();
    const result = await performNpmUpdate('9.99.0', log);
    expect(result).toBe('failed');
    expect(mockedSwapSlot).not.toHaveBeenCalled();
  });

  it('returns failed when entry point missing after install', async () => {
    mockedExistsSync.mockImplementation((p: any) => {
      if (String(p).includes('cli.js')) return false;
      return true;
    });
    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('failed');
    expect(mockedSwapSlot).not.toHaveBeenCalled();
  });

  it('continues when the bundled MarkItDown binary is missing after install', async () => {
    mockedExistsSync.mockImplementation((p: any) => {
      const path = String(p);
      if (path.includes('markitdown-')) return false;
      return true;
    });
    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(mockedSwapSlot).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Continuing without document conversion'));
  });

  it('reuses the active-slot MarkItDown binary when npm install leaves it missing', async () => {
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    mockedReadFile.mockImplementation(async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n` as any;
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return sourceBytes as any;
      if (normalized.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.100.abc1234' }) as any;
      throw new Error(`Unexpected readFile: ${normalized}`);
    });
    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(mockedCopyFile).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reused bundled MarkItDown binary from the active slot'));
  });

  it('skips active-slot MarkItDown reuse when the checksum sidecar is missing', async () => {
    mockedReadFile.mockImplementation(async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.100.abc1234' }) as any;
      throw new Error(`Unexpected readFile: ${normalized}`);
    });
    mockedExistsSync.mockImplementation((p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && path.endsWith('.sha256')) return false;
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    });

    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(mockedCopyFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping active-slot bundled MarkItDown binary without a valid checksum sidecar'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Continuing without document conversion'));
  });

  it('recovers pending state if swap succeeded but version was not written', async () => {
    mockActiveSlot = 'b';
    mockedReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.endsWith('.update-pending.json')) {
        return JSON.stringify({
          target: 'b',
          commit: '',
          version: '9.0.0-beta.4-dev.200.def5678',
          ref: 'npm:9.0.0-beta.4-dev.200.def5678',
          createdAt: new Date().toISOString(),
        }) as any;
      }
      if (p.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.200.def5678' }) as any;
      throw new Error(`Unexpected readFile: ${p}`);
    });
    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.4-dev.200.def5678', log);
    expect(result).toBe('updated');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recovered pending'));
    expect(mockedWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.current-version'),
      '9.0.0-beta.4-dev.200.def5678',
    );
    expect(mockedSwapSlot).not.toHaveBeenCalled();
  });

  it('returns failed when slot swap throws', async () => {
    mockedSwapSlot.mockRejectedValueOnce(new Error('EPERM'));
    const log = vi.fn();
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('failed');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('symlink swap failed'));
  });
});

describe('compareSemver', () => {
  let compareSemver: (a: string, b: string) => number;
  beforeEach(async () => {
    ({ compareSemver } = await import('../src/daemon.js'));
  });

  it('stable > prerelease for the same version', () => {
    expect(compareSemver('9.0.0', '9.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0')).toBeLessThan(0);
  });

  it('higher prerelease > lower prerelease', () => {
    expect(compareSemver('9.0.0-beta.2', '9.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0-beta.2')).toBeLessThan(0);
  });

  it('ignores build metadata for ordering', () => {
    expect(compareSemver('1.2.3-alpha+1', '1.2.3-alpha+2')).toBe(0);
    expect(compareSemver('9.0.0+build.1', '9.0.0+build.2')).toBe(0);
  });

  it('handles dev suffix with numeric comparison', () => {
    expect(compareSemver('9.0.0-beta.4-dev.200', '9.0.0-beta.4-dev.100')).toBeGreaterThan(0);
  });

  it('equal versions return 0', () => {
    expect(compareSemver('9.0.0', '9.0.0')).toBe(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0-beta.1')).toBe(0);
  });

  it('major/minor/patch ordering', () => {
    expect(compareSemver('10.0.0', '9.99.99')).toBeGreaterThan(0);
    expect(compareSemver('9.1.0', '9.0.99')).toBeGreaterThan(0);
    expect(compareSemver('9.0.1', '9.0.0')).toBeGreaterThan(0);
  });

  it('strips v prefix', () => {
    expect(compareSemver('v9.0.0', '9.0.0')).toBe(0);
  });
});
