import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-rb-'));
  vi.stubEnv('DKG_HOME', tmpDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

describe('rollback (swapSlot)', () => {
  it('rollback swaps to inactive slot', async () => {
    const rDir = join(tmpDir, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });
    await symlink('b', join(rDir, 'current'));
    await writeFile(join(rDir, 'active'), 'b');

    const { swapSlot } = await import('../src/config.js');
    await swapSlot('a');

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('a');
    const active = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
    expect(active).toBe('a');
  });

  it('rollback from a to b works correctly', async () => {
    const rDir = join(tmpDir, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });
    await symlink('a', join(rDir, 'current'));
    await writeFile(join(rDir, 'active'), 'a');

    const { swapSlot } = await import('../src/config.js');
    await swapSlot('b');

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
    const active = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
    expect(active).toBe('b');
  });

  it('rollback when no current link exists creates one', async () => {
    const rDir = join(tmpDir, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });

    const { swapSlot } = await import('../src/config.js');
    await swapSlot('a');

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('a');
  });

  // -------------------------------------------------------------------
  // Regression: CLI rollback command verifies target slot has build
  // -------------------------------------------------------------------

  it('swapSlot works even if target slot is empty (low-level)', async () => {
    const rDir = join(tmpDir, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    // b exists but has no build output — swapSlot is a low-level operation
    // The CLI rollback command checks for cli.js before calling swapSlot
    await mkdir(join(rDir, 'b'), { recursive: true });

    const { swapSlot } = await import('../src/config.js');
    await swapSlot('b');

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

  it('activeSlot + inactiveSlot are consistent after rollback', async () => {
    const rDir = join(tmpDir, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a'), { recursive: true });
    await mkdir(join(rDir, 'b'), { recursive: true });
    await symlink('a', join(rDir, 'current'));
    await writeFile(join(rDir, 'active'), 'a');

    const { swapSlot, activeSlot, inactiveSlot } = await import('../src/config.js');

    expect(await activeSlot()).toBe('a');
    expect(await inactiveSlot()).toBe('b');

    await swapSlot('b');

    expect(await activeSlot()).toBe('b');
    expect(await inactiveSlot()).toBe('a');
  });
});
