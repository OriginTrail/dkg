import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { cleanStaleWorkspacePackages } from '../src/daemon/auto-update-workspace-clean.js';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(dependencies: Record<string, string> = {}) {
  const slot = await mkdtemp(join(tmpdir(), 'dkg-workspace-clean-'));
  temps.push(slot);
  const source = join(slot, 'packages/publisher');
  const installed = join(slot, 'node_modules/@origintrail-official/dkg-publisher');
  await mkdir(source, { recursive: true });
  await mkdir(installed, { recursive: true });
  await writeFile(join(slot, 'package.json'), JSON.stringify({ dependencies }));
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: '@origintrail-official/dkg-publisher', version: '10.0.16', exports: { '.': './index.js' },
  }));
  await mkdir(join(installed, 'dist'));
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: '@origintrail-official/dkg-publisher', version: '10.0.5' }));
  await writeFile(join(installed, 'dist/dkg-publisher.js'), 'module.exports = "obsolete";');
  await writeFile(join(installed, 'dist/dkg-publisher.d.ts'), 'export declare const obsolete: true;');
  return { slot, source, installed };
}

describe('inactive git slot workspace cleanup', () => {
  it('quarantines the undeclared package that bypasses workspace exports, preserving evidence and caches', async () => {
    const { slot, source, installed } = await fixture();
    await mkdir(join(slot, 'packages/evm-module/cache'), { recursive: true });
    await writeFile(join(slot, 'packages/evm-module/cache/keep'), 'cache');
    const reference = '@origintrail-official/dkg-publisher/dist/dkg-publisher.js';
    const resolveReference = () => ts.resolveModuleName(reference, join(source, 'test.ts'), {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }, ts.sys).resolvedModule?.resolvedFileName;
    expect(resolveReference()).toBe(await realpath(join(installed, 'dist/dkg-publisher.d.ts')));
    const logs: string[] = [];
    await cleanStaleWorkspacePackages(slot, (m) => logs.push(m));
    expect(resolveReference()).toBeUndefined();
    const [run] = await readdir(join(slot, '.dkg-stale-workspace-dependencies'));
    expect(await readFile(join(slot, '.dkg-stale-workspace-dependencies', run, '@origintrail-official+dkg-publisher/dist/dkg-publisher.js'), 'utf8')).toContain('obsolete');
    expect(await readFile(join(slot, 'packages/evm-module/cache/keep'), 'utf8')).toBe('cache');
    expect(logs).toHaveLength(1);
    await cleanStaleWorkspacePackages(slot, (m) => logs.push(m));
    expect(logs).toHaveLength(1);
  });

  it('preserves explicitly declared root dependencies', async () => {
    const { slot, installed } = await fixture({ '@origintrail-official/dkg-publisher': '10.0.5' });
    await cleanStaleWorkspacePackages(slot, () => {});
    expect(await readFile(join(installed, 'package.json'), 'utf8')).toContain('10.0.5');
  });

  it('preserves pnpm workspace links and unrelated packages', async () => {
    const { slot, source, installed } = await fixture();
    await rm(installed, { recursive: true });
    await symlink(source, installed, 'dir');
    await mkdir(join(slot, 'node_modules/unrelated'));
    await cleanStaleWorkspacePackages(slot, () => {});
    expect(await readFile(join(installed, 'package.json'), 'utf8')).toContain('10.0.16');
    expect(await readdir(join(slot, 'node_modules'))).toContain('unrelated');
  });

  it.each(['node_modules', 'node_modules/@origintrail-official'])('does not traverse a symlinked %s', async (path) => {
    const { slot } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'dkg-workspace-outside-'));
    temps.push(outside);
    await rm(join(slot, path), { recursive: true });
    await symlink(outside, join(slot, path), 'dir');
    await cleanStaleWorkspacePackages(slot, () => {});
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses a symlinked quarantine destination', async () => {
    const { slot, installed } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), 'dkg-workspace-outside-'));
    temps.push(outside);
    await symlink(outside, join(slot, '.dkg-stale-workspace-dependencies'), 'dir');
    await expect(cleanStaleWorkspacePackages(slot, () => {})).rejects.toThrow('Unsafe workspace quarantine');
    expect(await readFile(join(installed, 'package.json'), 'utf8')).toContain('10.0.5');
    expect(await readdir(outside)).toEqual([]);
  });
});
