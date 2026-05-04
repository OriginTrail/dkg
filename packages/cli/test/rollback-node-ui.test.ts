import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { ensureRollbackNodeUiBundle, type RollbackNodeUiIo } from '../src/rollback-node-ui.js';

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function makeIo(overrides: Partial<RollbackNodeUiIo>): RollbackNodeUiIo {
  return {
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('unexpected read');
    },
    rmSync: () => {},
    execSync: () => '',
    log: () => {},
    error: () => {},
    ...overrides,
  };
}

describe('ensureRollbackNodeUiBundle', () => {
  it('builds a missing git-layout Node UI bundle before rollback can activate the slot', () => {
    const slotDir = join('tmp', 'releases', 'b');
    const gitIndex = join(slotDir, 'packages', 'node-ui', 'dist-ui', 'index.html');
    let built = false;
    const commands: string[] = [];
    const removed: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const io = makeIo({
      existsSync: (path) => normalizePath(path).endsWith('/packages/cli/dist/cli.js')
        || (built && path === gitIndex),
      readFileSync: (path) => {
        expect(normalizePath(path)).toContain('/packages/node-ui/package.json');
        return '{"name":"@origintrail-official/dkg-node-ui"}';
      },
      rmSync: (path) => {
        removed.push(normalizePath(path));
      },
      execSync: (command: string, options?: ExecSyncOptionsWithStringEncoding) => {
        commands.push(command);
        expect(options?.cwd).toBe(slotDir);
        expect(options?.timeout).toBe(15 * 60_000);
        built = true;
        return '';
      },
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    });

    expect(ensureRollbackNodeUiBundle(slotDir, 'b', io)).toBe(true);
    expect(removed).toEqual([
      normalizePath(join(slotDir, 'packages', 'node-ui', 'dist-ui')),
    ]);
    expect(commands).toEqual(['pnpm --filter @origintrail-official/dkg-node-ui run build:ui']);
    expect(logs).toEqual(['Slot b has no Node UI static bundle; building UI assets before rollback...']);
    expect(errors).toEqual([]);
  });

  it('accepts an existing git-layout Node UI bundle without rebuilding during rollback', () => {
    const slotDir = join('tmp', 'releases', 'b');
    const gitIndex = join(slotDir, 'packages', 'node-ui', 'dist-ui', 'index.html');
    const commands: string[] = [];
    const removed: string[] = [];
    const logs: string[] = [];
    const io = makeIo({
      existsSync: (path) => {
        const normalized = normalizePath(path);
        if (normalized.endsWith('/packages/cli/dist/cli.js')) return true;
        if (path === gitIndex) return true;
        return false;
      },
      readFileSync: () => '{"name":"@origintrail-official/dkg-node-ui"}',
      rmSync: (path) => {
        removed.push(normalizePath(path));
      },
      execSync: (command: string) => {
        commands.push(command);
        return '';
      },
      log: (message) => logs.push(message),
    });

    expect(ensureRollbackNodeUiBundle(slotDir, 'b', io)).toBe(true);
    expect(removed).toEqual([]);
    expect(commands).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('fails a git-layout rollback when the UI build cannot produce index.html', () => {
    const slotDir = join('tmp', 'releases', 'b');
    const commands: string[] = [];
    const errors: string[] = [];
    const io = makeIo({
      existsSync: (path) => normalizePath(path).endsWith('/packages/cli/dist/cli.js'),
      readFileSync: () => '{"name":"@origintrail-official/dkg-node-ui"}',
      execSync: (command: string) => {
        commands.push(command);
        throw new Error('vite exploded');
      },
      error: (message) => errors.push(message),
    });

    expect(ensureRollbackNodeUiBundle(slotDir, 'b', io)).toBe(false);
    expect(commands).toEqual(['pnpm --filter @origintrail-official/dkg-node-ui run build:ui']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Rollback aborted: failed to build Node UI static bundle');
    expect(errors[0]).toContain('vite exploded');
  });

  it('accepts an npm-layout rollback target that already contains packaged UI assets', () => {
    const slotDir = join('tmp', 'releases', 'b');
    const npmIndex = join(
      slotDir,
      'node_modules',
      '@origintrail-official',
      'dkg-node-ui',
      'dist-ui',
      'index.html',
    );
    const commands: string[] = [];
    const io = makeIo({
      existsSync: (path) => path === npmIndex,
      readFileSync: (path) => {
        expect(normalizePath(path)).toContain('/node_modules/@origintrail-official/dkg/package.json');
        return '{"dependencies":{"@origintrail-official/dkg-node-ui":"10.0.0"}}';
      },
      execSync: (command: string) => {
        commands.push(command);
        return '';
      },
    });

    expect(ensureRollbackNodeUiBundle(slotDir, 'b', io)).toBe(true);
    expect(commands).toEqual([]);
  });

  it('fails an npm-layout rollback target that lacks packaged UI assets without attempting a repair build', () => {
    const slotDir = join('tmp', 'releases', 'b');
    const commands: string[] = [];
    const errors: string[] = [];
    const io = makeIo({
      existsSync: () => false,
      readFileSync: () => '{"dependencies":{"@origintrail-official/dkg-node-ui":"10.0.0"}}',
      execSync: (command: string) => {
        commands.push(command);
        return '';
      },
      error: (message) => errors.push(message),
    });

    expect(ensureRollbackNodeUiBundle(slotDir, 'b', io)).toBe(false);
    expect(commands).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Slot b has no Node UI static bundle');
    expect(errors[0]).toContain('Run "dkg update" first');
  });
});
