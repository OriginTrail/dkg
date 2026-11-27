// getCurrentCommitFull (daemon/manifest.ts) is the full commit /api/status
// reports when a node has no build-info.json. A DKG source checkout answers
// from git; any other install falls back to <DKG home>/.current-commit, which
// the git auto-updater writes after each slot build. The helper caches its
// first answer for the process, so every case imports a fresh module.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const FULL = '0123456789abcdef0123456789abcdef01234567';
const OTHER_FULL = 'fedcba9876543210fedcba9876543210fedcba98';
const CLI_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = dirname(dirname(CLI_DIR));

let dkgHome: string;
let origDkgHome: string | undefined;

beforeEach(async () => {
  dkgHome = await mkdtemp(join(tmpdir(), 'dkg-current-commit-'));
  origDkgHome = process.env.DKG_HOME;
  process.env.DKG_HOME = dkgHome;
  vi.resetModules();
});

afterEach(async () => {
  vi.doUnmock('node:child_process');
  if (origDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = origDkgHome;
  await rm(dkgHome, { recursive: true, force: true });
});

async function loadWithGit(git: (command: string) => string) {
  const execSync = vi.fn((command: string) => git(command));
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execSync,
  }));
  const { getCurrentCommitFull } = await import('../src/daemon/manifest.js');
  return { getCurrentCommitFull, execSync };
}

function notACheckout(): string {
  throw new Error('fatal: not a git repository');
}

describe('getCurrentCommitFull', () => {
  it('answers from git inside the DKG source checkout', async () => {
    await writeFile(join(dkgHome, '.current-commit'), OTHER_FULL);
    const { getCurrentCommitFull } = await loadWithGit((command) =>
      command.includes('--show-toplevel') ? `${REPO_ROOT}\n` : `${FULL}\n`);
    expect(getCurrentCommitFull()).toBe(FULL);
  });

  it('falls back to <DKG home>/.current-commit outside a source checkout', async () => {
    await writeFile(join(dkgHome, '.current-commit'), `${FULL}\n`);
    const { getCurrentCommitFull } = await loadWithGit(notACheckout);
    expect(getCurrentCommitFull()).toBe(FULL);
  });

  it("does not report the commit of a consumer's checkout that contains the CLI", async () => {
    await writeFile(join(dkgHome, '.current-commit'), FULL);
    const { getCurrentCommitFull, execSync } = await loadWithGit((command) =>
      command.includes('--show-toplevel') ? '/work/consumer-app\n' : `${OTHER_FULL}\n`);
    expect(getCurrentCommitFull()).toBe(FULL);
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it('reports no commit when .current-commit holds an abbreviated id', async () => {
    await writeFile(join(dkgHome, '.current-commit'), '6ccdbc57\n');
    const { getCurrentCommitFull } = await loadWithGit(notACheckout);
    expect(getCurrentCommitFull()).toBeNull();
  });

  it('reports no commit when neither source exists, and keeps that answer', async () => {
    const { getCurrentCommitFull, execSync } = await loadWithGit(notACheckout);
    expect(getCurrentCommitFull()).toBeNull();
    await writeFile(join(dkgHome, '.current-commit'), FULL);
    expect(getCurrentCommitFull()).toBeNull();
    expect(execSync).toHaveBeenCalledTimes(1);
  });
});
