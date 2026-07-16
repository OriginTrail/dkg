import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  blueGreenSlotEntryPoint,
  blueGreenSlotReady,
  findPackageRepoDir,
} from '../src/index.js';

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'dkg-core-blue-green-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe('blue-green shared helpers', () => {
  it('findPackageRepoDir walks up to the package workspace root used by CLI migration', async () => {
    const repo = join(testDir, 'host-repo');
    const nested = join(repo, 'node_modules', '@origintrail-official', 'dkg', 'dist');
    await mkdir(join(repo, 'packages'), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, 'package.json'), '{}\n');

    expect(findPackageRepoDir(nested)).toBe(repo);
  });

  it('findPackageRepoDir returns null when no package workspace root exists', async () => {
    const nested = join(testDir, 'standalone', 'dist');
    await mkdir(nested, { recursive: true });

    expect(findPackageRepoDir(nested)).toBeNull();
  });

  it('blueGreenSlotEntryPoint supports git-layout slots', async () => {
    const slot = join(testDir, 'slot-a');
    const entry = join(slot, 'packages', 'cli', 'dist', 'cli.js');
    await mkdir(join(slot, 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(entry, '');

    expect(blueGreenSlotEntryPoint(slot)).toBe(entry);
  });

  it('blueGreenSlotEntryPoint supports npm-layout slots', async () => {
    const slot = join(testDir, 'slot-a');
    const entry = join(slot, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js');
    await mkdir(join(slot, 'node_modules', '@origintrail-official', 'dkg', 'dist'), { recursive: true });
    await writeFile(entry, '');

    expect(blueGreenSlotEntryPoint(slot)).toBe(entry);
  });

  it('blueGreenSlotReady requires both an entry point and install metadata', async () => {
    const slot = join(testDir, 'slot-a');
    const entryDir = join(slot, 'packages', 'cli', 'dist');
    await mkdir(entryDir, { recursive: true });
    await writeFile(join(entryDir, 'cli.js'), '');

    expect(blueGreenSlotReady(slot)).toBe(false);

    await writeFile(join(slot, 'package.json'), '{}\n');

    expect(blueGreenSlotReady(slot)).toBe(true);
  });
});
