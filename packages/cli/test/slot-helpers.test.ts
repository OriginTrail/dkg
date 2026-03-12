import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-slot-'));
  vi.stubEnv('DKG_HOME', tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('slot helpers', () => {
  async function importHelpers() {
    // Dynamic import to pick up DKG_HOME override
    const mod = await import('../src/config.js');
    return mod;
  }

  it('releasesDir() returns {dkgDir}/releases', async () => {
    const { releasesDir, dkgDir } = await importHelpers();
    expect(releasesDir()).toBe(join(dkgDir(), 'releases'));
  });

  it('activeSlot() returns null when active file is missing', async () => {
    const { activeSlot } = await importHelpers();
    expect(await activeSlot()).toBeNull();
  });

  it('activeSlot() reads the active file correctly', async () => {
    const { activeSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await writeFile(join(rDir, 'active'), 'b');
    expect(await activeSlot()).toBe('b');
  });

  it('inactiveSlot() returns opposite of activeSlot()', async () => {
    const { inactiveSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await writeFile(join(rDir, 'active'), 'a');
    expect(await inactiveSlot()).toBe('b');
    await writeFile(join(rDir, 'active'), 'b');
    expect(await inactiveSlot()).toBe('a');
  });

  it('inactiveSlot() defaults to "b" when no active file', async () => {
    const { inactiveSlot } = await importHelpers();
    expect(await inactiveSlot()).toBe('b');
  });

  it('swapSlot() creates symlink and active file', async () => {
    const { swapSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });

    await swapSlot('a');

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('a');
    const active = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
    expect(active).toBe('a');
  });

  it('swapSlot() atomically swaps to a different target', async () => {
    const { swapSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });

    await swapSlot('a');
    expect(await readlink(join(rDir, 'current'))).toBe('a');

    await swapSlot('b');
    expect(await readlink(join(rDir, 'current'))).toBe('b');
    expect((await readFile(join(rDir, 'active'), 'utf-8')).trim()).toBe('b');
  });

  it('swapSlot() is idempotent — calling twice with same target is no-op', async () => {
    const { swapSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });

    await swapSlot('a');
    await swapSlot('a');

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    expect((await readFile(join(rDir, 'active'), 'utf-8')).trim()).toBe('a');
  });

  it('repoDir() resolves to the current repo root', async () => {
    const { repoDir } = await importHelpers();
    const dir = repoDir();
    expect(dir).not.toBeNull();
    expect(typeof dir).toBe('string');
    expect(dir!.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------
  // Regression tests for bugs found during PR review cycles
  // -------------------------------------------------------------------

  it('activeSlot() reads symlink target even when it is an absolute path', async () => {
    const { symlink } = await import('node:fs/promises');
    const { activeSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });
    // Create symlink with absolute target instead of relative "b"
    await symlink(join(rDir, 'b'), join(rDir, 'current'));
    expect(await activeSlot()).toBe('b');
  });

  it('activeSlot() prefers symlink over active file when both exist', async () => {
    const { symlink } = await import('node:fs/promises');
    const { activeSlot, releasesDir } = await importHelpers();
    const rDir = releasesDir();
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });
    // Symlink points to b, but active file says a — symlink wins
    await symlink('b', join(rDir, 'current'));
    await writeFile(join(rDir, 'active'), 'a');
    expect(await activeSlot()).toBe('b');
  });

  it('repoDir() walks up to find repo root with package.json + packages/', async () => {
    const { repoDir } = await importHelpers();
    const dir = repoDir();
    const { existsSync } = await import('node:fs');
    expect(dir).not.toBeNull();
    expect(existsSync(join(dir!, 'package.json'))).toBe(true);
    expect(existsSync(join(dir!, 'packages'))).toBe(true);
  });

  it('findRepoDir() returns null when no monorepo root exists above the start path', async () => {
    const { findRepoDir } = await importHelpers();
    const outsideRepo = await mkdtemp(join(tmpdir(), 'dkg-no-repo-'));
    await mkdir(join(outsideRepo, 'nested', 'deeper'), { recursive: true });

    expect(findRepoDir(join(outsideRepo, 'nested', 'deeper'))).toBeNull();

    await rm(outsideRepo, { recursive: true, force: true });
  });
});
