// OT-RFC-41 Bundle B targeted unit tests.
//
// Covers the new code paths introduced by Bundle B (PR 4/5/6):
//   1. `noteEdgeLegacyReleases` (migration.ts) — Edge first-start
//      migration writes ~/.dkg/previous-version from the active slot
//      version and is a no-op when one already exists.
//   2. `ensureStablePluginRoot` (daemon/plugin-loader.ts) — idempotent
//      materialisation of ~/.dkg/plugins/package.json.
//   3. `performNpmUpdateEdge` (daemon/auto-update.ts) — happy path
//      writes previous-version + execs `npm install -g`; EACCES on
//      install surfaces the prefix-configuration advisory.
//
// Heavily mocked: no real network, no real npm. Each suite isolates
// its own ~/.dkg-style temp home via process.env.DKG_HOME so the
// production helpers (`dkgDir()`, `releasesDir()`) point at it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { noteEdgeLegacyReleases } from '../src/migration.js';
import { ensureStablePluginRoot } from '../src/daemon/plugin-loader.js';
import { performNpmUpdateEdge } from '../src/daemon/auto-update.js';
import { _autoUpdateIo } from '../src/daemon/manifest.js';

let tmpDir: string;
let dkgHome: string;
let origDkgHome: string | undefined;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dkg-bundleB-'));
  dkgHome = join(tmpDir, '.dkg');
  origDkgHome = process.env.DKG_HOME;
  process.env.DKG_HOME = dkgHome;
  await mkdir(dkgHome, { recursive: true });
});

afterEach(async () => {
  if (origDkgHome === undefined) delete process.env.DKG_HOME;
  else process.env.DKG_HOME = origDkgHome;
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLog(): { fn: (msg: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { fn: (m: string) => calls.push(m), calls };
}

// ─── B1a: noteEdgeLegacyReleases ──────────────────────────────────────

describe('noteEdgeLegacyReleases (Bundle B1a)', () => {
  it('is a no-op when ~/.dkg/releases/ does not exist', async () => {
    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);
    expect(existsSync(join(dkgHome, 'previous-version'))).toBe(false);
    expect(log.calls).toEqual([]);
  });

  it('writes previous-version from npm-layout slot package.json', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotA = join(rDir, 'a');
    const slotPkg = join(
      slotA,
      'node_modules',
      '@origintrail-official',
      'dkg',
      'package.json',
    );
    await mkdir(join(slotA, 'node_modules', '@origintrail-official', 'dkg'), {
      recursive: true,
    });
    await writeFile(
      slotPkg,
      JSON.stringify({ version: '10.0.0-rc.11', name: '@origintrail-official/dkg' }),
    );
    await writeFile(join(rDir, 'active'), 'a');
    // The `active` text file plus 'current' symlink both contribute
    // to `activeSlot()`; symlink is the canonical signal.
    symlinkSync('a', join(rDir, 'current'));

    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);

    expect(existsSync(join(dkgHome, 'previous-version'))).toBe(true);
    expect(readFileSync(join(dkgHome, 'previous-version'), 'utf-8')).toBe('10.0.0-rc.11');
    expect(log.calls.some((m) => m.includes('10.0.0-rc.11'))).toBe(true);
  });

  it('falls back to git-layout slot package.json', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotB = join(rDir, 'b');
    await mkdir(join(slotB, 'packages', 'cli'), { recursive: true });
    await writeFile(
      join(slotB, 'packages', 'cli', 'package.json'),
      JSON.stringify({ version: '10.0.0-rc.10', name: '@origintrail-official/dkg' }),
    );
    await writeFile(join(rDir, 'active'), 'b');
    symlinkSync('b', join(rDir, 'current'));

    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);

    expect(readFileSync(join(dkgHome, 'previous-version'), 'utf-8')).toBe('10.0.0-rc.10');
  });

  it('is idempotent: leaves an existing previous-version alone', async () => {
    // Pre-existing previous-version (e.g. from a prior `dkg update`).
    await writeFile(join(dkgHome, 'previous-version'), '10.0.0-rc.9');

    // Even with a legacy slot present, the existing target wins.
    const rDir = join(dkgHome, 'releases');
    const slotA = join(rDir, 'a');
    await mkdir(join(slotA, 'node_modules', '@origintrail-official', 'dkg'), {
      recursive: true,
    });
    await writeFile(
      join(slotA, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
      JSON.stringify({ version: '10.0.0-rc.11' }),
    );
    symlinkSync('a', join(rDir, 'current'));

    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);

    // Old target preserved; nothing logged.
    expect(readFileSync(join(dkgHome, 'previous-version'), 'utf-8')).toBe('10.0.0-rc.9');
    expect(log.calls).toEqual([]);
  });

  it('silently does nothing when releases/ has no active slot', async () => {
    // releases/ exists but no `current` symlink or `active` file.
    await mkdir(join(dkgHome, 'releases'), { recursive: true });
    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);
    expect(existsSync(join(dkgHome, 'previous-version'))).toBe(false);
  });

  it('skips when slot package.json has no version field', async () => {
    const rDir = join(dkgHome, 'releases');
    const slotA = join(rDir, 'a');
    await mkdir(join(slotA, 'node_modules', '@origintrail-official', 'dkg'), {
      recursive: true,
    });
    await writeFile(
      join(slotA, 'node_modules', '@origintrail-official', 'dkg', 'package.json'),
      JSON.stringify({ name: '@origintrail-official/dkg' }), // no version
    );
    symlinkSync('a', join(rDir, 'current'));

    const log = makeLog();
    await noteEdgeLegacyReleases(log.fn);
    expect(existsSync(join(dkgHome, 'previous-version'))).toBe(false);
  });
});

// ─── B1e: ensureStablePluginRoot ──────────────────────────────────────

describe('ensureStablePluginRoot (Bundle B1e)', () => {
  it('creates ~/.dkg/plugins/package.json on first call', () => {
    const result = ensureStablePluginRoot(dkgHome);
    const pkgPath = join(dkgHome, 'plugins', 'package.json');
    expect(result).toBe(pkgPath);
    expect(existsSync(pkgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      name?: string;
      private?: boolean;
    };
    expect(parsed.name).toBe('dkg-plugin-root');
    expect(parsed.private).toBe(true);
  });

  it('is idempotent — second call leaves the file unchanged', () => {
    ensureStablePluginRoot(dkgHome);
    const pkgPath = join(dkgHome, 'plugins', 'package.json');
    const original = readFileSync(pkgPath, 'utf-8');

    ensureStablePluginRoot(dkgHome);
    expect(readFileSync(pkgPath, 'utf-8')).toBe(original);
  });

  it('returns null when the home is unwriteable (read-only parent)', () => {
    // Pass a path inside a non-existent root we cannot create. mkdirSync
    // with recursive:true tolerates a lot, so we simulate failure by
    // pointing at a file (not a directory) — mkdirSync against a file
    // path throws ENOTDIR.
    const sentinelFile = join(tmpDir, 'sentinel-file');
    writeFileSync_sync(sentinelFile, 'not a directory');
    const result = ensureStablePluginRoot(join(sentinelFile, 'nope'));
    expect(result).toBeNull();
  });
});

// Local helper to avoid pulling node:fs sync import only for one line.
function writeFileSync_sync(path: string, content: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('node:fs') as typeof import('node:fs');
  fs.writeFileSync(path, content);
}

// ─── B1b: performNpmUpdateEdge ────────────────────────────────────────

describe('performNpmUpdateEdge (Bundle B1b)', () => {
  // _autoUpdateIo is a mutable record exposed by manifest.ts for tests.
  // We monkey-patch `exec` to capture the npm command without spawning
  // a real subprocess. Other IO (readFile, writeFile, mkdir, …) we let
  // the real fs handle against the per-test DKG_HOME.
  const origIo = { ..._autoUpdateIo };
  const restartCommand = {
    nodeExecutable: '/usr/local/bin/node',
    nodeExecArgv: ['--enable-source-maps'],
    restartEntryPoint: '/npm-global/lib/node_modules/@origintrail-official/dkg/dist/cli.js',
  } as const;
  let execCalls: { cmd: string; opts?: any }[] = [];
  let execFileCalls: { file: string; args: string[]; opts?: any }[] = [];
  let operations: string[] = [];

  beforeEach(() => {
    execCalls = [];
    execFileCalls = [];
    operations = [];
    _autoUpdateIo.exec = ((cmd: string, opts?: any): Promise<{ stdout: string; stderr: string }> => {
      execCalls.push({ cmd, opts });
      operations.push(cmd);
      return Promise.resolve({ stdout: '', stderr: '' });
    }) as any;
    _autoUpdateIo.execFile = ((
      file: string,
      args: string[],
      opts?: any,
    ): Promise<{ stdout: string; stderr: string }> => {
      execFileCalls.push({ file, args, opts });
      operations.push(`${file} ${args.join(' ')}`);
      return Promise.resolve({ stdout: 'dkg 10.0.0-rc.12', stderr: '' });
    }) as any;
  });

  afterEach(() => {
    Object.assign(_autoUpdateIo, origIo);
  });

  it('records previous-version and runs npm install -g on success', async () => {
    const log = makeLog();
    const result = await performNpmUpdateEdge(
      '10.0.0-rc.12',
      '10.0.0-rc.11',
      log.fn,
      restartCommand,
    );

    expect(result).toBe('updated');
    expect(readFileSync(join(dkgHome, 'previous-version'), 'utf-8')).toBe('10.0.0-rc.11');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].cmd).toBe('npm install -g @origintrail-official/dkg@10.0.0-rc.12');
    expect(execFileCalls).toEqual([{
      file: restartCommand.nodeExecutable,
      args: [
        ...restartCommand.nodeExecArgv,
        restartCommand.restartEntryPoint,
        '--version',
      ],
      opts: { encoding: 'utf-8', timeout: 30_000 },
    }]);
    expect(execCalls.some(({ cmd }) => cmd === 'dkg --version')).toBe(false);
    expect(log.calls.some((m) => m.includes('10.0.0-rc.11 → ~/.dkg/previous-version'))).toBe(true);
    expect(log.calls.some((m) => m.includes('install completed'))).toBe(true);
  });

  it('warns when current version is unknown but still attempts the install', async () => {
    const log = makeLog();
    const result = await performNpmUpdateEdge('10.0.0-rc.12', null, log.fn, restartCommand);

    expect(result).toBe('updated');
    expect(existsSync(join(dkgHome, 'previous-version'))).toBe(false);
    expect(log.calls.some((m) => m.includes('current version unknown'))).toBe(true);
    expect(execCalls[0].cmd).toBe('npm install -g @origintrail-official/dkg@10.0.0-rc.12');
  });

  it('returns failed on npm install error', async () => {
    _autoUpdateIo.exec = (() => {
      const err: any = new Error('npm ERR! E404 Not Found');
      err.code = 'E404';
      return Promise.reject(err);
    }) as any;

    const log = makeLog();
    const result = await performNpmUpdateEdge('99.99.99', '10.0.0-rc.11', log.fn, restartCommand);

    expect(result).toBe('failed');
    expect(log.calls.some((m) => m.includes('npm install -g failed'))).toBe(true);
    // previous-version still recorded before the install attempt — by
    // design, so an operator can recover via `npm install -g
    // @origintrail-official/dkg@<previous>` even after a failed update.
    expect(readFileSync(join(dkgHome, 'previous-version'), 'utf-8')).toBe('10.0.0-rc.11');
  });

  it('rolls back when the installed CLI cannot pass its self-check', async () => {
    let versionChecks = 0;
    _autoUpdateIo.execFile = (async (file: string, args: string[], opts?: any) => {
      execFileCalls.push({ file, args, opts });
      operations.push(`${file} ${args.join(' ')}`);
      versionChecks += 1;
      if (versionChecks === 1) throw new Error('restart entry point cannot be executed');
      return { stdout: 'dkg 10.0.0-rc.11', stderr: '' };
    }) as any;

    const log = makeLog();
    const result = await performNpmUpdateEdge(
      '10.0.0-rc.12',
      '10.0.0-rc.11',
      log.fn,
      restartCommand,
    );
    expect(result).toBe('failed');
    const restartProbe = `${restartCommand.nodeExecutable} ${restartCommand.nodeExecArgv.join(' ')} ${restartCommand.restartEntryPoint} --version`;
    expect(operations).toEqual([
      'npm install -g @origintrail-official/dkg@10.0.0-rc.12',
      restartProbe,
      'npm install -g @origintrail-official/dkg@10.0.0-rc.11',
      restartProbe,
    ]);
    expect(log.calls.some((message) => message.includes('rollback restored'))).toBe(true);
  });

  it('rolls back on an exact-version mismatch, including semver prefix collisions', async () => {
    let versionChecks = 0;
    _autoUpdateIo.execFile = (async (file: string, args: string[], opts?: any) => {
      execFileCalls.push({ file, args, opts });
      operations.push(`${file} ${args.join(' ')}`);
      versionChecks += 1;
      return versionChecks === 1
        ? { stdout: 'dkg 10.0.0-rc.12', stderr: '' }
        : { stdout: 'dkg 10.0.0-rc.0', stderr: '' };
    }) as any;

    const log = makeLog();
    const result = await performNpmUpdateEdge(
      '10.0.0-rc.1',
      '10.0.0-rc.0',
      log.fn,
      restartCommand,
    );
    expect(result).toBe('failed');
    const restartProbe = `${restartCommand.nodeExecutable} ${restartCommand.nodeExecArgv.join(' ')} ${restartCommand.restartEntryPoint} --version`;
    expect(operations).toEqual([
      'npm install -g @origintrail-official/dkg@10.0.0-rc.1',
      restartProbe,
      'npm install -g @origintrail-official/dkg@10.0.0-rc.0',
      restartProbe,
    ]);
    expect(log.calls.some((message) => message.includes('expected 10.0.0-rc.1'))).toBe(true);
  });

  it('surfaces a prefix-configuration advisory on EACCES', async () => {
    _autoUpdateIo.exec = (() => {
      const err: any = new Error("EACCES: permission denied, mkdir '/usr/local/lib/node_modules'");
      err.code = 'EACCES';
      return Promise.reject(err);
    }) as any;

    const log = makeLog();
    const result = await performNpmUpdateEdge(
      '10.0.0-rc.12',
      '10.0.0-rc.11',
      log.fn,
      restartCommand,
    );

    expect(result).toBe('failed');
    expect(log.calls.some((m) => m.includes('EACCES'))).toBe(true);
    expect(log.calls.some((m) => m.includes('npm config set prefix'))).toBe(true);
  });

  // Concurrent-update locking is exercised by the existing
  // `performNpmUpdate` (Core) tests in auto-update.test.ts; the shared
  // `_updateInProgress` + `acquireUpdateLock` machinery is identical
  // between Core and Edge, so a parallel test here would add no signal.
});
