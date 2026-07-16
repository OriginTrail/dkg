import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Integration test: full blue-green update cycle with real git repos in a temp directory.
 * Uses real filesystem and git operations — no mocks.
 * Uses tiny repos with shell build scripts to keep it fast.
 */
describe.sequential('blue-green integration', () => {
  let tmpDir: string;
  let bareRepo: string;
  let dkgHome: string;
  let rDir: string;
  let slotA: string;
  let slotB: string;
  let prevDkgHome: string | undefined;

  function git(cmd: string, cwd: string) {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  }

  beforeAll(async () => {
    prevDkgHome = process.env.DKG_HOME;
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-bg-int-'));
    bareRepo = join(tmpDir, 'origin.git');
    dkgHome = join(tmpDir, '.dkg');
    rDir = join(dkgHome, 'releases');
    slotA = join(rDir, 'a');
    slotB = join(rDir, 'b');

    process.env.DKG_HOME = dkgHome;

    // Create bare repo with initial-branch=main
    execSync(`git init --bare --initial-branch=main "${bareRepo}"`, { stdio: 'pipe' });

    // Clone, create initial content, push
    const workDir = join(tmpDir, 'work');
    execSync(`git clone "${bareRepo}" "${workDir}"`, { stdio: 'pipe' });
    git('git config user.email "test@test.com"', workDir);
    git('git config user.name "Test"', workDir);
    git('git checkout -B main', workDir);
    await writeFile(join(workDir, 'VERSION'), '1.0.0');
    git('git add -A', workDir);
    git('git commit -m "initial"', workDir);
    git('git push -u origin main', workDir);

    // Set up both slots from the bare repo
    await mkdir(rDir, { recursive: true });
    execSync(`git clone -b main "${bareRepo}" "${slotA}"`, { stdio: 'pipe' });
    git('git config user.email "test@test.com"', slotA);
    git('git config user.name "Test"', slotA);

    execSync(`git clone -b main "${bareRepo}" "${slotB}"`, { stdio: 'pipe' });
    git('git config user.email "test@test.com"', slotB);
    git('git config user.name "Test"', slotB);

    // Initialize current → a
    await symlink('a', join(rDir, 'current'));
    await writeFile(join(rDir, 'active'), 'a');

    // Record current commit
    const sha = git('git rev-parse HEAD', slotA);
    await writeFile(join(dkgHome, '.current-commit'), sha);

    // Push a new commit (the "update")
    await writeFile(join(workDir, 'VERSION'), '2.0.0');
    await writeFile(join(workDir, 'NEW_FILE'), 'updated content');
    git('git add -A', workDir);
    git('git commit -m "update to v2"', workDir);
    git('git push origin main', workDir);

    await rm(workDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    if (prevDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = prevDkgHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('setup: slots and symlink exist', () => {
    expect(existsSync(slotA)).toBe(true);
    expect(existsSync(slotB)).toBe(true);
    expect(existsSync(join(rDir, 'current'))).toBe(true);
  });

  it('full update cycle: fetch, checkout, and swap in inactive slot', async () => {
    const latestSha = git('git ls-remote --heads origin main', slotA).split(/\s/)[0];
    const currentSha = (await readFile(join(dkgHome, '.current-commit'), 'utf-8')).trim();
    expect(latestSha).not.toBe(currentSha);

    // Simulate performUpdate core logic with real git
    git('git fetch origin main', slotB);
    git('git checkout --force origin/main', slotB);

    // Swap symlink: current → b
    const { swapSlot } = await import('../src/config.js');
    await swapSlot('b');
    await writeFile(join(dkgHome, '.current-commit'), latestSha);

    // Verify symlink and active file
    expect(await readlink(join(rDir, 'current'))).toBe('b');
    expect((await readFile(join(rDir, 'active'), 'utf-8')).trim()).toBe('b');
    expect((await readFile(join(dkgHome, '.current-commit'), 'utf-8')).trim()).toBe(latestSha);

    // Verify the updated files are in slot b
    expect(existsSync(join(slotB, 'NEW_FILE'))).toBe(true);
    const version = (await readFile(join(slotB, 'VERSION'), 'utf-8')).trim();
    expect(version).toBe('2.0.0');

    // Verify slot a was NOT modified (still on old version)
    const versionA = (await readFile(join(slotA, 'VERSION'), 'utf-8')).trim();
    expect(versionA).toBe('1.0.0');
  });

  it('rollback after update: swaps back to slot a', async () => {
    const { swapSlot } = await import('../src/config.js');
    await swapSlot('a');

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    expect((await readFile(join(rDir, 'active'), 'utf-8')).trim()).toBe('a');
  });

  it('slot a is untouched after update + rollback', async () => {
    const versionA = (await readFile(join(slotA, 'VERSION'), 'utf-8')).trim();
    expect(versionA).toBe('1.0.0');
    expect(existsSync(join(slotA, 'NEW_FILE'))).toBe(false);
  });
});
