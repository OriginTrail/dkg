import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { _migrationIo, migrateToBlueGreen } from '../src/migration.js';
import { repoDir } from '../src/config.js';

let tmpDir: string;
let dkgHome: string;

let execSyncCalls: { cmd: string; opts?: any }[] = [];
let execFileSyncCalls: { binary: string; args: string[]; opts?: any }[] = [];
const RUNTIME_PACKAGES_BUILD_CMD = 'pnpm build:runtime:packages';
const RUNTIME_BUILD_CMD = 'pnpm build:runtime';
const RUNTIME_BUILD_COMPAT_WRAPPER = 'pnpm run build:runtime:packages && pnpm --filter @origintrail-official/dkg-node-ui run build:ui';
const FULL_BUILD_CMD = 'pnpm build';
const NODE_UI_BUILD_CMD = 'pnpm --filter @origintrail-official/dkg-node-ui run build:ui';
const LEGACY_NODE_UI_BUILD_CMD = 'pnpm --filter @dkg/node-ui run build:ui';

const origIo = { ..._migrationIo };

function installMocks() {
  _migrationIo.execSync = ((cmd: string, opts?: any) => {
    execSyncCalls.push({ cmd, opts });
    const cwd = opts?.cwd ? String(opts.cwd) : '';
    if (cwd && (cmd === RUNTIME_PACKAGES_BUILD_CMD || cmd === RUNTIME_BUILD_CMD || cmd === FULL_BUILD_CMD)) {
      mkdirSync(join(cwd, 'packages', 'cli', 'dist'), { recursive: true });
      writeFileSync(join(cwd, 'packages', 'cli', 'dist', 'cli.js'), '');
    }
    if (cwd && (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD)) {
      mkdirSync(join(cwd, 'packages', 'node-ui', 'dist-ui'), { recursive: true });
      writeFileSync(join(cwd, 'packages', 'node-ui', 'dist-ui', 'index.html'), '');
    }
    return 'https://github.com/test/repo.git';
  }) as any;

  _migrationIo.execFileSync = ((binary: string, args: string[], opts?: any) => {
    execFileSyncCalls.push({ binary, args: [...args], opts });
    if (binary === 'git' && args.includes('clone')) {
      const target = args[args.length - 1];
      if (target && !target.startsWith('git') && !target.startsWith('http')) {
        try {
          mkdirSync(join(target, '.git'), { recursive: true });
          writeFileSync(
            join(target, 'package.json'),
            JSON.stringify({
              dkgBuild: { releaseRuntimeBuildScript: 'build:runtime:packages' },
              scripts: {
                'build:runtime:packages': RUNTIME_PACKAGES_BUILD_CMD,
                'build:runtime': RUNTIME_BUILD_COMPAT_WRAPPER,
              },
            }),
          );
        } catch {}
      }
    }
    if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return 'https://github.com/test/repo.git';
    }
    return '';
  }) as any;
}

function restoreIo() {
  Object.assign(_migrationIo, origIo);
}

let origDkgHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-mig-'));
  dkgHome = join(tmpDir, '.dkg');
  origDkgHome = process.env.DKG_HOME;
  process.env.DKG_HOME = dkgHome;
  execSyncCalls = [];
  execFileSyncCalls = [];
  installMocks();
  await mkdir(dkgHome, { recursive: true });
});

afterEach(async () => {
  if (origDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = origDkgHome;
  restoreIo();
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLog(): { fn: (msg: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { fn: (msg: string) => { calls.push(msg); }, calls };
}

async function writeSlotReady(slotDir: string, includeUi = true): Promise<void> {
  await mkdir(join(slotDir, '.git'), { recursive: true });
  await mkdir(join(slotDir, 'packages', 'cli', 'dist'), { recursive: true });
  await writeFile(join(slotDir, 'packages', 'cli', 'dist', 'cli.js'), '');
  if (includeUi) {
    await mkdir(join(slotDir, 'packages', 'node-ui', 'dist-ui'), { recursive: true });
    await writeFile(join(slotDir, 'packages', 'node-ui', 'dist-ui', 'index.html'), '');
  }
}

async function writeNpmSlotReady(slotDir: string, includeUi = true): Promise<void> {
  await mkdir(join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist'), { recursive: true });
  await writeFile(join(slotDir, 'package.json'), '{}');
  await writeFile(join(slotDir, 'node_modules', '@origintrail-official', 'dkg', 'dist', 'cli.js'), '');
  if (includeUi) {
    await mkdir(
      join(
        slotDir,
        'node_modules',
        '@origintrail-official',
        'dkg',
        'node_modules',
        '@origintrail-official',
        'dkg-node-ui',
        'dist-ui',
      ),
      { recursive: true },
    );
    await writeFile(
      join(
        slotDir,
        'node_modules',
        '@origintrail-official',
        'dkg',
        'node_modules',
        '@origintrail-official',
        'dkg-node-ui',
        'dist-ui',
        'index.html',
      ),
      '',
    );
  }
}

describe('migrateToBlueGreen', () => {
  it('skips migration when releases/current already exists', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(rDir, { recursive: true });
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'));
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(log.calls.length).toBe(0);
  });

  it('creates releases dir, slot a symlink, and current symlink', async () => {
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const rDir = join(dkgHome, 'releases');
    expect(existsSync(rDir)).toBe(true);
    expect(existsSync(join(rDir, 'a'))).toBe(true);
    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('a');
    const active = (await readFile(join(rDir, 'active'), 'utf-8')).trim();
    expect(active).toBe('a');
  });

  it('restores current symlink from existing active metadata when valid', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'b');

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

  it('slot b directory is created even if clone/build fails', async () => {
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const slotB = join(dkgHome, 'releases', 'b');
    expect(existsSync(slotB)).toBe(true);
  });

  it('data files remain in dkg root, not in slots', async () => {
    await writeFile(join(dkgHome, 'config.json'), '{}');
    await writeFile(join(dkgHome, 'wallets.json'), '{}');

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(existsSync(join(dkgHome, 'config.json'))).toBe(true);
    expect(existsSync(join(dkgHome, 'wallets.json'))).toBe(true);
  });

  it('logs migration progress', async () => {
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(log.calls.some(m => m.includes('Migrating'))).toBe(true);
    expect(log.calls.some(m => m.includes('Migration complete'))).toBe(true);
  });

  it('skips remote bootstrap when no local checkout exists and bootstrap is disallowed', async () => {
    _migrationIo.repoDir = () => null;
    execSyncCalls = [];
    execFileSyncCalls = [];

    const log = makeLog();
    await migrateToBlueGreen(log.fn, { allowRemoteBootstrap: false });

    expect(log.calls.some(m => m.includes('skipping remote bootstrap'))).toBe(true);
    expect(execFileSyncCalls.length).toBe(0);
    expect(execSyncCalls.length).toBe(0);
  });

  it('passes configured ssh key via GIT_SSH_COMMAND during remote bootstrap clone', async () => {
    _migrationIo.repoDir = () => null;
    _migrationIo.loadConfig = async () => ({
      autoUpdate: { enabled: true, repo: 'git@github.com:test/repo.git', branch: 'main', sshKeyPath: '/tmp/test key' },
    });
    _migrationIo.loadNetworkConfig = async () => undefined;
    execFileSyncCalls = [];

    const log = makeLog();
    await migrateToBlueGreen(log.fn, { allowRemoteBootstrap: true });

    const cloneCall = execFileSyncCalls.find(
      c => c.binary === 'git' && c.args[0] === 'clone',
    );
    expect(cloneCall).toBeTruthy();
    expect(cloneCall?.opts?.env?.GIT_SSH_COMMAND).toBe(
      "ssh -i '/tmp/test key' -o IdentitiesOnly=yes",
    );
  });

  it('passes GITHUB_TOKEN to git clone for https GitHub bootstrap repos', async () => {
    const origToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test_123';

    _migrationIo.repoDir = () => null;
    _migrationIo.loadConfig = async () => ({
      autoUpdate: { enabled: true, repo: 'https://github.com/test/repo.git', branch: 'main' },
    });
    _migrationIo.loadNetworkConfig = async () => undefined;
    execFileSyncCalls = [];

    try {
      const log = makeLog();
      await migrateToBlueGreen(log.fn, { allowRemoteBootstrap: true });

      const cloneCall = execFileSyncCalls.find(
        c => c.binary === 'git' && c.args.includes('clone'),
      );
      expect(cloneCall).toBeTruthy();
      expect(cloneCall!.args[0]).toBe('-c');
      expect(cloneCall!.args[1]).toContain('http.extraHeader=Authorization: Basic ');
    } finally {
      if (origToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = origToken;
    }
  });

  // -------------------------------------------------------------------
  // Regression tests for bugs found during PR review cycles
  // -------------------------------------------------------------------

  it('migration uses git clone (not symlink) for slot A to prevent dev repo damage', async () => {
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const cloneCalls = execFileSyncCalls
      .filter(c => c.binary === 'git' && c.args[0] === 'clone');

    expect(cloneCalls.some(call => call.args.includes('--local'))).toBe(true);
  });

  it('migration builds slot A after cloning (not just clone)', async () => {
    _migrationIo.swapSlot = (async () => undefined) as any;
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const allCmds = execSyncCalls.map(c => c.cmd);
    expect(allCmds.some(cmd => cmd.includes('pnpm install'))).toBe(true);
    expect(allCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
    expect(allCmds.some(cmd => cmd === NODE_UI_BUILD_CMD)).toBe(true);
    const uiBuildIdx = allCmds.indexOf(NODE_UI_BUILD_CMD);
    const runtimeBuildIdx = allCmds.indexOf(RUNTIME_PACKAGES_BUILD_CMD);
    expect(uiBuildIdx).toBeGreaterThan(runtimeBuildIdx);
    expect(allCmds).not.toContain(RUNTIME_BUILD_CMD);
  });

  it('falls back to build:runtime during bootstrap when the runtime-only package script is absent', async () => {
    const rDir = join(dkgHome, 'releases');
    _migrationIo.repoDir = () => repoDir();
    _migrationIo.swapSlot = (async () => undefined) as any;
    _migrationIo.execFileSync = ((binary: string, args: string[], opts?: any) => {
      execFileSyncCalls.push({ binary, args: [...args], opts });
      if (binary === 'git' && args.includes('clone')) {
        const target = args[args.length - 1];
        mkdirSync(join(target, '.git'), { recursive: true });
        writeFileSync(
          join(target, 'package.json'),
          JSON.stringify({ scripts: { 'build:runtime': RUNTIME_BUILD_CMD } }),
        );
      }
      if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return 'https://github.com/test/repo.git';
      }
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const slotACmds = execSyncCalls
      .filter(c => String(c.opts?.cwd) === join(rDir, 'a'))
      .map(c => c.cmd);
    expect(slotACmds).toContain(RUNTIME_BUILD_CMD);
    expect(slotACmds).not.toContain(RUNTIME_PACKAGES_BUILD_CMD);
  });

  it('falls back to pnpm build during bootstrap when runtime build scripts are absent', async () => {
    const rDir = join(dkgHome, 'releases');
    _migrationIo.repoDir = () => repoDir();
    _migrationIo.swapSlot = (async () => undefined) as any;
    _migrationIo.execFileSync = ((binary: string, args: string[], opts?: any) => {
      execFileSyncCalls.push({ binary, args: [...args], opts });
      if (binary === 'git' && args.includes('clone')) {
        const target = args[args.length - 1];
        mkdirSync(join(target, '.git'), { recursive: true });
        writeFileSync(
          join(target, 'package.json'),
          JSON.stringify({ scripts: { build: 'turbo build' } }),
        );
      }
      if (binary === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
        return 'https://github.com/test/repo.git';
      }
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const slotACmds = execSyncCalls
      .filter(c => String(c.opts?.cwd) === join(rDir, 'a'))
      .map(c => c.cmd);
    expect(slotACmds).toContain(FULL_BUILD_CMD);
    expect(slotACmds).not.toContain(RUNTIME_PACKAGES_BUILD_CMD);
    expect(slotACmds).not.toContain(RUNTIME_BUILD_CMD);
  });

  it('repairs inactive ready slots that are missing the Node UI static bundle', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const uiBuilds = execSyncCalls.filter(c => c.cmd === NODE_UI_BUILD_CMD);
    expect(uiBuilds.map(c => String(c.opts?.cwd))).toEqual([join(rDir, 'b')]);
    expect(log.calls.some(m => m.includes('Node UI static bundle missing'))).toBe(true);
    expect(execFileSyncCalls.some(c => c.binary === 'git' && c.args[0] === 'clone')).toBe(false);
  });

  it('does not run workspace UI build for npm-layout slots missing UI', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotB = join(rDir, 'b');
    await writeSlotReady(join(rDir, 'a'));
    await writeNpmSlotReady(slotB, false);
    await writeFile(join(rDir, 'active'), 'a');
    _migrationIo.swapSlot = (async () => undefined) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const slotBCmds = execSyncCalls
      .filter(c => String(c.opts?.cwd) === slotB)
      .map(c => c.cmd);
    expect(slotBCmds).not.toContain(NODE_UI_BUILD_CMD);
    expect(slotBCmds).not.toContain(LEGACY_NODE_UI_BUILD_CMD);
    expect(log.calls.some(m => m.includes('repair failed') && m.includes('Trying remaining slots'))).toBe(true);
  });

  it('does not select npm-layout slots that are missing UI', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeNpmSlotReady(join(rDir, 'a'), false);
    await writeNpmSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'a');
    const swaps: Array<'a' | 'b'> = [];
    _migrationIo.swapSlot = (async (slot: 'a' | 'b') => {
      swaps.push(slot);
    }) as any;

    const log = makeLog();
    await expect(migrateToBlueGreen(log.fn)).rejects.toThrow('Node UI static bundle missing');

    expect(swaps).toEqual([]);
    expect(execSyncCalls.length).toBe(0);
    expect(log.calls.filter(m => m.includes('Trying remaining slots')).length).toBe(2);
  });

  it('uses the Node UI workspace package name from each slot during repair', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotB = join(rDir, 'b');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(slotB, false);
    await mkdir(join(slotB, 'packages', 'node-ui'), { recursive: true });
    await writeFile(
      join(slotB, 'packages', 'node-ui', 'package.json'),
      JSON.stringify({ name: '@dkg/node-ui', scripts: { 'build:ui': 'vite build' } }),
    );
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const slotBuilds = execSyncCalls
      .filter(c => String(c.opts?.cwd) === slotB)
      .map(c => c.cmd);
    expect(slotBuilds).toContain(LEGACY_NODE_UI_BUILD_CMD);
    expect(slotBuilds).not.toContain(NODE_UI_BUILD_CMD);
  });

  it('uses releases/current before stale active metadata when deciding the live slot', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'b');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const uiBuilds = execSyncCalls.filter(c => c.cmd === NODE_UI_BUILD_CMD);
    expect(uiBuilds.map(c => String(c.opts?.cwd))).toEqual([join(rDir, 'b')]);
  });

  it('repairs a live slot missing UI in place instead of failing over', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'));
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    const uiBuilds = execSyncCalls.filter(c => c.cmd === NODE_UI_BUILD_CMD);
    expect(uiBuilds.map(c => String(c.opts?.cwd))).toEqual([join(rDir, 'a')]);
    expect(log.calls.some(m => m.includes('active slot') && m.includes('rebuilding'))).toBe(true);
  });

  it('leaves live slot untouched when live UI repair is disabled', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'));
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn, { repairLiveNodeUi: false });

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    const uiBuilds = execSyncCalls.filter(c => c.cmd === NODE_UI_BUILD_CMD);
    expect(uiBuilds.map(c => String(c.opts?.cwd))).not.toContain(join(rDir, 'a'));
    expect(log.calls.some(m => m.includes('active slot') && m.includes('untouched'))).toBe(true);
  });

  it('repairs live and standby UI when both ready slots are missing UI', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    const uiBuilds = execSyncCalls.filter(c => c.cmd === NODE_UI_BUILD_CMD);
    expect(uiBuilds.map(c => String(c.opts?.cwd))).toEqual([join(rDir, 'a'), join(rDir, 'b')]);
  });

  it('does not block migration when inactive slot UI repair fails', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));
    _migrationIo.execSync = ((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD) throw new Error('vite exploded');
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(log.calls.some(m => m.includes('repair failed') && m.includes('next update'))).toBe(true);
  });

  it('continues startup when live slot UI repair fails instead of rolling back', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'));
    await writeFile(join(rDir, 'active'), 'a');
    await symlink('a', join(rDir, 'current'));
    _migrationIo.execSync = ((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD) throw new Error('vite exploded');
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    expect(log.calls.some(m => m.includes('repair failed') && m.includes('fallback page'))).toBe(true);
  });

  it('restores current to a healthy UI slot when another ready slot repair fails', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'b');
    _migrationIo.execSync = ((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD) throw new Error('vite exploded');
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(await readlink(join(rDir, 'current'))).toBe('a');
    expect(log.calls.some(m => m.includes('repair failed') && m.includes('Trying remaining slots'))).toBe(true);
  });

  it('tries both slots before failing no-current UI repair', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'), false);
    await writeFile(join(rDir, 'active'), 'a');
    _migrationIo.execSync = ((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      const cwd = String(opts?.cwd ?? '');
      if (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD) {
        if (cwd.endsWith(`${join('releases', 'a')}`)) throw new Error('vite exploded');
        mkdirSync(join(cwd, 'packages', 'node-ui', 'dist-ui'), { recursive: true });
        writeFileSync(join(cwd, 'packages', 'node-ui', 'dist-ui', 'index.html'), '');
      }
      return '';
    }) as any;

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    expect(await readlink(join(rDir, 'current'))).toBe('b');
    expect(log.calls.some(m => m.includes('Trying remaining slots'))).toBe(true);
  });

  it('fails initial migration when no slot can provide the Node UI static bundle', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'), false);
    await writeSlotReady(join(rDir, 'b'), false);
    _migrationIo.execSync = ((cmd: string, opts?: any) => {
      execSyncCalls.push({ cmd, opts });
      if (cmd === NODE_UI_BUILD_CMD || cmd === LEGACY_NODE_UI_BUILD_CMD) throw new Error('vite exploded');
      return '';
    }) as any;

    const log = makeLog();
    await expect(migrateToBlueGreen(log.fn)).rejects.toThrow('vite exploded');
    expect(existsSync(join(rDir, 'current'))).toBe(false);
  });

  it('migration slot B clone uses --dissociate to prevent repo corruption', async () => {
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const cloneCalls = execFileSyncCalls
      .filter(c => c.binary === 'git' && c.args[0] === 'clone' && c.args.includes('--reference'));

    if (cloneCalls.length > 0) {
      expect(cloneCalls[0].args).toContain('--dissociate');
    }
  });

  it('when local repo exists, slot B clones from same local source path', async () => {
    execFileSyncCalls = [];
    const expectedSource = repoDir();

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const cloneCalls = execFileSyncCalls
      .filter(c => c.binary === 'git' && c.args[0] === 'clone');

    const slotBClone = cloneCalls.find(call => String(call.args[call.args.length - 1]).endsWith('/b'));
    expect(slotBClone).toBeTruthy();
    expect(slotBClone?.args).toContain(expectedSource!);
  });

  it('rebuilds slot A when directory exists but is incomplete', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotA = join(rDir, 'a');
    await mkdir(slotA, { recursive: true }); // create incomplete slot

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const gitCalls = execFileSyncCalls
      .filter(c => c.binary === 'git' && c.args[0] === 'clone');
    expect(gitCalls.some(call => call.args.includes('--local'))).toBe(true);
    const allCmds = execSyncCalls.map(c => c.cmd);
    expect(allCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
  });

  it('repairs incomplete slots even when current symlink exists', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await mkdir(join(rDir, 'b'), { recursive: true }); // incomplete slot b
    await symlink('a', join(rDir, 'current'));

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const gitCloneCalls = execFileSyncCalls
      .filter(c => c.binary === 'git' && c.args[0] === 'clone');
    expect(gitCloneCalls.some(call => String(call.args[call.args.length - 1]).endsWith('/b'))).toBe(true);
    const buildCmds = execSyncCalls.map(c => c.cmd);
    expect(buildCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
  });

  it('repairs non-symlink releases/current by recreating current symlink', async () => {
    const rDir = join(dkgHome, 'releases');
    await writeSlotReady(join(rDir, 'a'));
    await writeSlotReady(join(rDir, 'b'));
    await writeFile(join(rDir, 'active'), 'b');
    await mkdir(join(rDir, 'current'), { recursive: true }); // legacy broken state: directory instead of symlink

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

});
