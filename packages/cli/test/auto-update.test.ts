import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoUpdateConfig } from '../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn((_cmd: string, _opts: any, cb: Function) => cb(null, '', '')),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    symlink: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    readlink: vi.fn(),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
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

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { exec } from 'node:child_process';
import { checkForUpdate, performUpdate } from '../src/daemon.js';
import { swapSlot } from '../src/config.js';

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedExistsSync = vi.mocked(existsSync);
const mockedSwapSlot = vi.mocked(swapSlot);
const mockedExec = vi.mocked(exec);

const AU: AutoUpdateConfig = {
  enabled: true,
  repo: 'owner/repo',
  branch: 'main',
  checkIntervalMinutes: 30,
};

function makeFetchOk(sha: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ sha }),
  });
}

function getExecCalls() {
  return mockedExec.mock.calls.map(c => ({
    cmd: String(c[0]),
    cwd: (c[1] as any)?.cwd,
  }));
}

describe('blue-green checkForUpdate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockActiveSlot = 'a';
    mockedExistsSync.mockReturnValue(true);
    (mockedExec as any).mockImplementation((_cmd: string, _opts: any, cb: Function) => cb(null, '', ''));
  });

  it('skips when blue-green slots are not initialized', async () => {
    mockedExistsSync.mockReturnValue(false);
    const log = vi.fn();
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('slots not initialized'));
    expect(fetchMock).not.toHaveBeenCalled();
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
    const targetDir = '/tmp/dkg-test/releases/b';
    expect(allCmds.some(c => c.cmd.includes('git fetch') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('git checkout --force') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm install') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm build') && c.cwd === targetDir)).toBe(true);

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
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/tmp/dkg-test/.current-commit',
      latest,
    );
  });

  it('calls SIGTERM after swap via checkForUpdate', async () => {
    const current = 'aaa111';
    const latest = 'ddd444';
    mockedReadFile.mockResolvedValueOnce(current as any);
    makeFetchOk(latest);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const log = vi.fn();
    await checkForUpdate(AU, log);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    killSpy.mockRestore();
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
    (mockedExec as any).mockImplementation((cmd: string, _opts: any, cb: Function) => {
      if (String(cmd).includes('git fetch')) return cb(new Error('network down'), '', '');
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
});
