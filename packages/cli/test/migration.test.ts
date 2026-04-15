import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readlink, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { _migrationIo, migrateToBlueGreen } from '../src/migration.js';
import { repoDir } from '../src/config.js';

let tmpDir: string;
let dkgHome: string;

let execSyncCalls: { cmd: string; opts?: any }[] = [];
let execFileSyncCalls: { binary: string; args: string[]; opts?: any }[] = [];

const origIo = { ..._migrationIo };

function installMocks() {
  _migrationIo.execSync = ((cmd: string, opts?: any) => {
    execSyncCalls.push({ cmd, opts });
    return 'https://github.com/test/repo.git';
  }) as any;

  _migrationIo.execFileSync = ((binary: string, args: string[], opts?: any) => {
    execFileSyncCalls.push({ binary, args: [...args], opts });
    if (binary === 'git' && args[0] === 'clone') {
      const target = args[args.length - 1];
      if (target && !target.startsWith('git') && !target.startsWith('http')) {
        try { mkdirSync(target, { recursive: true }); } catch {}
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

describe('migrateToBlueGreen', () => {
  it('skips migration when releases/current already exists', async () => {
    const rDir = join(dkgHome, 'releases');
    await mkdir(rDir, { recursive: true });
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
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
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
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
    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const allCmds = execSyncCalls.map(c => c.cmd);
    expect(allCmds.some(cmd => cmd.includes('pnpm install'))).toBe(true);
    expect(allCmds.some(cmd => cmd.includes('pnpm build'))).toBe(true);
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
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
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
    await mkdir(join(rDir, 'a', '.git'), { recursive: true });
    await mkdir(join(rDir, 'b', '.git'), { recursive: true });
    await mkdir(join(rDir, 'a', 'packages', 'cli', 'dist'), { recursive: true });
    await mkdir(join(rDir, 'b', 'packages', 'cli', 'dist'), { recursive: true });
    await writeFile(join(rDir, 'a', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'b', 'packages', 'cli', 'dist', 'cli.js'), '');
    await writeFile(join(rDir, 'active'), 'b');
    await mkdir(join(rDir, 'current'), { recursive: true }); // legacy broken state: directory instead of symlink

    const log = makeLog();
    await migrateToBlueGreen(log.fn);

    const target = await readlink(join(rDir, 'current'));
    expect(target).toBe('b');
  });

});
