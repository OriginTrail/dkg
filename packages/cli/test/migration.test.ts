import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

vi.mock('node:child_process', async () => {
  const { mkdirSync } = await import('node:fs');
  return {
    execSync: vi.fn((cmd: string) => {
      const cmdStr = String(cmd);
      if (cmdStr.startsWith('git clone')) {
        const parts = cmdStr.split('"');
        const target = parts[parts.length - 2];
        if (target && !target.startsWith('git') && !target.startsWith('http')) {
          try { mkdirSync(target, { recursive: true }); } catch {}
        }
      }
      return 'https://github.com/test/repo.git';
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
    await mkdir(join(rDir, 'a'), { recursive: true });
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
});
