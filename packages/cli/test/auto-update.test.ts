import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AutoUpdateConfig } from '../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(), writeFile: vi.fn() };
});

// Stub global fetch for GitHub API calls
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { checkForUpdate } from '../src/daemon.js';

const mockedExecSync = vi.mocked(execSync);
const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);

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

describe('checkForUpdate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('skips update when worktree has uncommitted changes', async () => {
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git status --porcelain')) return ' M dirty-file.ts\n';
      return '';
    });

    const log = vi.fn();
    await checkForUpdate(AU, log);

    expect(log).toHaveBeenCalledWith(
      'Auto-update: skipping — worktree has uncommitted changes',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips update when ff-only merge fails (diverged history)', async () => {
    const currentCommit = 'aaa111';
    const latestCommit = 'bbb222';

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git status --porcelain')) return '';
      if (cmd.startsWith('git fetch')) return '';
      if (cmd.startsWith('git merge --ff-only')) throw new Error('Not possible to fast-forward');
      return '';
    });
    mockedReadFile.mockResolvedValueOnce(currentCommit);
    makeFetchOk(latestCommit);

    const log = vi.fn();
    await checkForUpdate(AU, log);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('new commit detected'),
    );
    expect(log).toHaveBeenCalledWith(
      'Auto-update: skipping — fast-forward merge not possible (history has diverged)',
    );
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not force-reset on build failure after merge', async () => {
    const currentCommit = 'aaa111';
    const latestCommit = 'ccc333';

    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.startsWith('git status --porcelain')) return '';
      if (cmd.startsWith('git fetch')) return '';
      if (cmd.startsWith('git merge --ff-only')) return '';
      if (cmd.startsWith('pnpm install')) return '';
      if (cmd === 'pnpm build') throw new Error('build exploded');
      if (cmd.startsWith('git reset --hard')) return '';
      return '';
    });
    mockedReadFile.mockResolvedValueOnce(currentCommit);
    makeFetchOk(latestCommit);

    const log = vi.fn();
    await checkForUpdate(AU, log);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('build failed after merge'),
    );
    const allCmds = mockedExecSync.mock.calls.map((c) => String(c[0]));
    expect(allCmds.some(cmd => cmd.includes(`git reset --hard ${currentCommit}`))).toBe(true);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('rolled back to previous commit'),
    );
  });
});
