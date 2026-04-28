import { createHash } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { AutoUpdateConfig } from '../src/config.js';
import { _autoUpdateIo } from '../src/daemon.js';

const MARKITDOWN_TARGETS_JSON = JSON.stringify([
  { platform: 'linux', arch: 'x64', assetName: 'markitdown-linux-x64', runner: 'ubuntu-latest' },
  { platform: 'darwin', arch: 'arm64', assetName: 'markitdown-darwin-arm64', runner: 'macos-14' },
  { platform: 'win32', arch: 'x64', assetName: 'markitdown-win32-x64.exe', runner: 'windows-latest' },
]);
const CLI_VERSION = '9.0.0-beta.6';
const MARKITDOWN_BUILD_INFO_JSON = JSON.stringify({
  markItDownUpstreamVersion: '0.1.5',
  pyInstallerVersion: '6.19.0',
});
const MOCK_MARKITDOWN_ENTRY_SCRIPT = '# mock markitdown entry script\n';
const MOCK_BUNDLER_SCRIPT = [
  "export const MARKITDOWN_UPSTREAM_VERSION = '0.1.5';",
  "export const PYINSTALLER_VERSION = '6.19.0';",
].join('\n');
let mockBundledCliPackageVersion = CLI_VERSION;
let mockInstalledPackageVersion = '9.0.0-beta.4-dev.100.abc1234';

function buildFingerprintForTest(): string {
  return sha256HexForTest([
    '0.1.5',
    '6.19.0',
    sha256HexForTest(MOCK_MARKITDOWN_ENTRY_SCRIPT),
    sha256HexForTest(MOCK_BUNDLER_SCRIPT),
  ].join('\n'));
}

function mockReadFileSyncValue(path: unknown): string {
  const normalized = String(path).replace(/\\/g, '/');
  if (normalized.endsWith('/markitdown-targets.json')) return MARKITDOWN_TARGETS_JSON;
  if (normalized.endsWith('/markitdown-build-info.json')) return MARKITDOWN_BUILD_INFO_JSON;
  if (normalized.endsWith('/scripts/markitdown-entry.py')) return MOCK_MARKITDOWN_ENTRY_SCRIPT;
  if (normalized.endsWith('/scripts/bundle-markitdown-binaries.mjs')) return MOCK_BUNDLER_SCRIPT;
  if (normalized.includes('/node_modules/@origintrail-official/dkg/package.json')) {
    return JSON.stringify({ version: mockInstalledPackageVersion });
  }
  if (normalized.endsWith('/packages/cli/package.json')) {
    return JSON.stringify({ version: mockBundledCliPackageVersion });
  }
  return 'testtoken';
}

// Save original _autoUpdateIo values for restoration
const origIo = { ..._autoUpdateIo };

// Tracking arrays
let readFileCalls: [any, ...any[]][] = [];
let writeFileCalls: [any, any, ...any[]][] = [];
let mkdirCalls: any[][] = [];
let rmCalls: any[][] = [];
let copyFileCalls: any[][] = [];
let chmodCalls: any[][] = [];
let statCalls: any[][] = [];
let existsSyncCalls: any[][] = [];
let readFileSyncCalls: any[][] = [];
let openSyncCalls: any[][] = [];
let closeSyncCalls: any[][] = [];
let writeFileSyncCalls: any[][] = [];
let unlinkSyncCalls: any[][] = [];
let execCalls: { cmd: string; cwd: string }[] = [];
let execFileCalls: { file: string; args: string[]; cwd: string; env: any }[] = [];
let swapSlotCalls: string[] = [];
let fetchCalls: any[][] = [];

// Default mock implementations
let readFileImpl: (path: any, ...rest: any[]) => Promise<any> = async () => '';
let writeFileImpl: (path: any, data: any, ...rest: any[]) => Promise<any> = async () => {};
let existsSyncImpl: (path: any) => boolean = () => true;
let readFileSyncImpl: (path: any, ...rest: any[]) => any = (path: any) => mockReadFileSyncValue(path);
let execImpl: (cmd: string, opts?: any) => Promise<any> = async () => ({ stdout: '', stderr: '' });
let execFileImpl: (file: string, args: string[], opts?: any) => Promise<any> = async () => ({ stdout: '', stderr: '' });
let swapSlotImpl: (slot: 'a' | 'b') => Promise<void> = async () => {};
let fetchImpl: (...args: any[]) => Promise<any> = async () => ({ ok: true, json: async () => ({}) });

let mockActiveSlot = 'a';

function resetMocks() {
  readFileCalls = [];
  writeFileCalls = [];
  mkdirCalls = [];
  rmCalls = [];
  copyFileCalls = [];
  chmodCalls = [];
  statCalls = [];
  existsSyncCalls = [];
  readFileSyncCalls = [];
  openSyncCalls = [];
  closeSyncCalls = [];
  writeFileSyncCalls = [];
  unlinkSyncCalls = [];
  execCalls = [];
  execFileCalls = [];
  swapSlotCalls = [];
  fetchCalls = [];

  readFileImpl = async () => '';
  writeFileImpl = async () => {};
  existsSyncImpl = () => true;
  readFileSyncImpl = (path: any) => mockReadFileSyncValue(path);
  execImpl = async (_cmd, _opts) => ({ stdout: '', stderr: '' });
  execFileImpl = async (_file, _args, _opts) => ({ stdout: '', stderr: '' });
  swapSlotImpl = async () => {};
  fetchImpl = async () => ({ ok: true, json: async () => ({}) });
}

function installMocks() {
  _autoUpdateIo.readFile = (async (path: any, ...rest: any[]) => {
    readFileCalls.push([path, ...rest]);
    return readFileImpl(path, ...rest);
  }) as any;
  _autoUpdateIo.writeFile = (async (path: any, data: any, ...rest: any[]) => {
    writeFileCalls.push([path, data, ...rest]);
    return writeFileImpl(path, data, ...rest);
  }) as any;
  _autoUpdateIo.mkdir = (async (...args: any[]) => { mkdirCalls.push(args); }) as any;
  _autoUpdateIo.rm = (async (...args: any[]) => { rmCalls.push(args); }) as any;
  _autoUpdateIo.chmod = (async (...args: any[]) => { chmodCalls.push(args); }) as any;
  _autoUpdateIo.copyFile = (async (...args: any[]) => { copyFileCalls.push(args); }) as any;
  _autoUpdateIo.stat = (async (...args: any[]) => { statCalls.push(args); return { mode: 0o755 }; }) as any;
  _autoUpdateIo.rename = (async () => {}) as any;
  _autoUpdateIo.unlink = (async () => {}) as any;
  _autoUpdateIo.existsSync = ((...args: any[]) => {
    existsSyncCalls.push(args);
    return existsSyncImpl(args[0]);
  }) as any;
  _autoUpdateIo.readFileSync = ((...args: any[]) => {
    readFileSyncCalls.push(args);
    return readFileSyncImpl(args[0], ...args.slice(1));
  }) as any;
  _autoUpdateIo.openSync = ((...args: any[]) => { openSyncCalls.push(args); return 99; }) as any;
  _autoUpdateIo.closeSync = ((...args: any[]) => { closeSyncCalls.push(args); }) as any;
  _autoUpdateIo.writeFileSync = ((...args: any[]) => { writeFileSyncCalls.push(args); }) as any;
  _autoUpdateIo.unlinkSync = ((...args: any[]) => { unlinkSyncCalls.push(args); }) as any;
  _autoUpdateIo.exec = (async (cmd: any, opts?: any) => {
    execCalls.push({ cmd: String(cmd), cwd: normalizePathString(opts?.cwd) });
    return execImpl(String(cmd), opts);
  }) as any;
  _autoUpdateIo.execFile = (async (file: any, args: any[], opts?: any) => {
    execFileCalls.push({ file: String(file), args: args ?? [], cwd: normalizePathString(opts?.cwd), env: opts?.env });
    return execFileImpl(String(file), args ?? [], opts);
  }) as any;
  _autoUpdateIo.execSync = (() => '') as any;
  _autoUpdateIo.dkgDir = () => '/tmp/dkg-test';
  _autoUpdateIo.releasesDir = () => '/tmp/dkg-test/releases';
  _autoUpdateIo.activeSlot = (async () => mockActiveSlot as 'a' | 'b') as any;
  _autoUpdateIo.inactiveSlot = (async () => (mockActiveSlot === 'a' ? 'b' : 'a') as 'a' | 'b') as any;
  _autoUpdateIo.swapSlot = (async (slot: 'a' | 'b') => { swapSlotCalls.push(slot); return swapSlotImpl(slot); }) as any;
  _autoUpdateIo.fetch = (async (...args: any[]) => { fetchCalls.push(args); return fetchImpl(...args); }) as any;
  _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async () => false;
  _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => null;
  _autoUpdateIo.readCliPackageVersion = (pkgDir: string) => {
    try {
      const raw = readFileSyncImpl(normalizePathString(pkgDir + '/package.json'), 'utf-8');
      return JSON.parse(raw).version ?? null;
    } catch { return null; }
  };
}

function restoreIo() {
  Object.assign(_autoUpdateIo, origIo);
}

import { checkForNewCommitWithStatus, checkForUpdate, performUpdate, performNpmUpdate } from '../src/daemon.js';

const AU: AutoUpdateConfig = {
  enabled: true,
  repo: 'owner/repo',
  branch: 'main',
  checkIntervalMinutes: 30,
};

function normalizePathString(value: unknown): string {
  return String(value).replace(/\\/g, '/');
}

function sha256HexForTest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeFetchOk(sha: string) {
  fetchImpl = async () => ({
    ok: true,
    json: async () => ({ sha }),
  });
}

function getExecCalls() {
  return execCalls.map(c => ({
    cmd: c.cmd,
    cwd: c.cwd,
  }));
}

function getExecFileCalls() {
  return execFileCalls.map(c => ({
    file: c.file,
    args: c.args,
    cwd: c.cwd,
    env: c.env,
  }));
}

describe('blue-green checkForUpdate', () => {
  beforeEach(() => {
    resetMocks();
    mockActiveSlot = 'a';
    installMocks();
  });

  afterEach(() => {
    restoreIo();
  });

  it('skips when blue-green slots are not initialized', async () => {
    existsSyncImpl = () => false;
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('slots not initialized'))).toBe(true);
    expect(fetchCalls.length).toBe(0);
  });

  it('reinitializes missing target slot git metadata before fetch', async () => {
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.endsWith('/releases/a')) return true;
      if (path.endsWith('/releases/b/.git')) return false;
      if (path.includes('cli.js')) return true;
      return true;
    };
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');

    const result = await performUpdate(AU, () => {});
    expect(result).toBe(true);

    const gitCmds = getExecFileCalls();
    const targetDir = '/tmp/dkg-test/releases/b';
    expect(gitCmds.some(c => c.file === 'git' && c.args.join(' ') === 'init' && c.cwd === targetDir)).toBe(true);
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'fetch' && c.cwd === targetDir)).toBe(true);
  });

  it('uses ssh git transport with configured ssh key path', async () => {
    readFileImpl = async () => 'aaa1111';
    execFileImpl = async (file: string, args: string[], _opts?: any) => {
      if (file === 'git' && args[0] === 'ls-remote') return { stdout: 'bbb2222\trefs/heads/main\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const sshAu: AutoUpdateConfig = {
      ...AU,
      repo: 'git@github.com:owner/repo.git',
      sshKeyPath: '/tmp/test key',
    };

    const result = await checkForNewCommitWithStatus(sshAu, () => {});
    expect(result.status).toBe('available');
    expect(fetchCalls.length).toBe(0);

    const gitCmds = getExecFileCalls().filter(c => c.file === 'git' && c.args[0] === 'ls-remote');
    expect(gitCmds.length).toBeGreaterThan(0);
    expect(gitCmds.every(c => c.env?.GIT_SSH_COMMAND === "ssh -i '/tmp/test key' -o IdentitiesOnly=yes")).toBe(true);
  });

  it('passes GITHUB_TOKEN to git fetch for https GitHub repos', async () => {
    const origToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_test_123';
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');

    try {
      const result = await performUpdate({ ...AU, repo: 'https://github.com/owner/repo.git' }, () => {});
      expect(result).toBe(true);

      const fetchCall = getExecFileCalls().find(c => c.file === 'git' && c.args.includes('fetch'));
      expect(fetchCall).toBeTruthy();
      expect(fetchCall?.args[0]).toBe('-c');
      expect(fetchCall?.args[1]).toContain('http.extraHeader=Authorization: Basic ');
      expect(fetchCall?.args).toContain('fetch');
      expect(fetchCall?.args).toContain('https://github.com/owner/repo.git');
    } finally {
      if (origToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = origToken;
    }
  });

  it('skips when no new commit', async () => {
    const sha = 'abc123';
    readFileImpl = async () => sha;
    makeFetchOk(sha);

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  it('builds in inactive slot on new commit', async () => {
    const current = 'aaa111';
    const latest = 'bbb222';
    readFileImpl = async () => current;
    makeFetchOk(latest);

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);

    const allCmds = getExecCalls();
    const gitCmds = getExecFileCalls();
    const targetDir = '/tmp/dkg-test/releases/b';
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'fetch' && c.cwd === targetDir)).toBe(true);
    expect(gitCmds.some(c => c.file === 'git' && c.args[0] === 'checkout' && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm install') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm build') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('bundle-markitdown-binaries.mjs') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('--force') && c.cwd === targetDir)).toBe(false);
    expect(allCmds.some(c => c.cmd.includes('--best-effort') && c.cwd === targetDir)).toBe(true);
    expect(allCmds.some(c => c.cmd.includes('pnpm --filter @origintrail-official/dkg-evm-module build') && c.cwd === targetDir)).toBe(false);

    const activeDir = '/tmp/dkg-test/releases/a';
    expect(allCmds.every(c => c.cwd !== activeDir)).toBe(true);
  });

  it('continues the update when MarkItDown staging fails inside the best-effort git-update step', async () => {
    const current = 'aaa111';
    const latest = 'bbb223';
    readFileImpl = async () => current;
    makeFetchOk(latest);
    execImpl = async (cmd: string) => {
      if (String(cmd).includes('bundle-markitdown-binaries.mjs')) {
        throw new Error('markitdown staging spawn failed');
      }
      return { stdout: '', stderr: '' };
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(swapSlotCalls).toContain('b');
    expect(logCalls.some(m => m.includes('MarkItDown staging failed in slot b'))).toBe(true);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('swaps symlink after successful build', async () => {
    const current = 'aaa111';
    const latest = 'ccc333';
    readFileImpl = async () => current;
    makeFetchOk(latest);

    await performUpdate(AU, () => {});

    expect(swapSlotCalls).toContain('b');
    expect(
      writeFileCalls.some((call) =>
        normalizePathString(call[0]).includes('/tmp/dkg-test/.current-commit') && call[1] === latest)
    ).toBe(true);
  });

  it('returns true after swap via checkForUpdate', async () => {
    const current = 'aaa111';
    const latest = 'ddd444';
    readFileImpl = async () => current;
    makeFetchOk(latest);

    const updated = await checkForUpdate(AU, () => {});
    expect(updated).toBe(true);
  });

  it('build failure does not swap', async () => {
    const current = 'aaa111';
    const latest = 'eee555';
    readFileImpl = async () => current;
    makeFetchOk(latest);
    execImpl = async (cmd: string) => {
      if (String(cmd).includes('pnpm build')) throw new Error('build exploded');
      return { stdout: '', stderr: '' };
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(swapSlotCalls.length).toBe(0);
    expect(logCalls.some(m => m.includes('build failed'))).toBe(true);
  });

  it('build failure does not touch active slot', async () => {
    const current = 'aaa111';
    const latest = 'fff666';
    readFileImpl = async () => current;
    makeFetchOk(latest);
    execImpl = async (cmd: string) => {
      if (String(cmd).includes('pnpm build')) throw new Error('build exploded');
      return { stdout: '', stderr: '' };
    };

    await performUpdate(AU, () => {});

    const allCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    const activeDir = '/tmp/dkg-test/releases/a';
    expect(allCwds.every((cwd: string) => cwd !== activeDir)).toBe(true);
  });

  it('fetch failure does not attempt build', async () => {
    const current = 'aaa111';
    const latest = 'ggg777';
    readFileImpl = async () => current;
    makeFetchOk(latest);
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'fetch') throw new Error('network down');
      return { stdout: '', stderr: '' };
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);

    const allCmds = getExecCalls().map(c => c.cmd);
    expect(allCmds.some(c => c.includes('pnpm install'))).toBe(false);
    expect(allCmds.some(c => c.includes('pnpm build'))).toBe(false);
  });

  it('slot alternation — consecutive updates build in alternating slots', async () => {
    mockActiveSlot = 'a';
    readFileImpl = async () => 'commit1';
    makeFetchOk('commit2');

    await performUpdate(AU, () => {});
    const firstBuildCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    expect(firstBuildCwds.some((cwd: string) => cwd.includes('/b'))).toBe(true);

    // Reset for second update
    resetMocks();
    mockActiveSlot = 'b';
    installMocks();
    readFileImpl = async () => 'commit2';
    makeFetchOk('commit3');

    await performUpdate(AU, () => {});
    const secondBuildCwds = getExecCalls().map(c => c.cwd).filter(Boolean);
    expect(secondBuildCwds.some((cwd: string) => cwd.includes('/a'))).toBe(true);
  });

  it('rejects branch names with shell injection characters', async () => {
    readFileImpl = async () => 'aaa111';
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const malicious: AutoUpdateConfig = {
      ...AU,
      branch: 'main; rm -rf /',
    };
    const result = await performUpdate(malicious, log);
    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('invalid branch'))).toBe(true);
    expect(execCalls.length).toBe(0);
    expect(execFileCalls.length).toBe(0);
  });

  it('aborts swap when build output (cli.js) is missing', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('newcommit');

    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('cli.js')) return false;
      return true;
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(swapSlotCalls.length).toBe(0);
    expect(logCalls.some(m => m.includes('build output missing'))).toBe(true);
  });

  it('continues the swap when the bundled MarkItDown binary is missing after build', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('newcommit');

    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('markitdown-')) return false;
      return true;
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(swapSlotCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('reuses the active-slot MarkItDown binary when staging misses it during git update', async () => {
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.current-commit')) return 'aaa111';
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'build', cliVersion: CLI_VERSION, buildFingerprint: buildFingerprintForTest() });
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-')) return sourceBytes;
      throw new Error(`Unexpected readFile path: ${normalized}`);
    };
    makeFetchOk('newcommit');

    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/packages/cli/bin/markitdown-')) return true;
      if (path.includes('/releases/b/packages/cli/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion && !meta.buildFingerprint) return false;
        if (metadata.buildFingerprint && meta.buildFingerprint !== metadata.buildFingerprint) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: CLI_VERSION, buildFingerprint: buildFingerprintForTest() });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(copyFileCalls.length).toBeGreaterThanOrEqual(1);
    expect(chmodCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls.some(m => m.includes('reused bundled MarkItDown binary from the active slot'))).toBe(true);
  });

  it('continues the update when active-slot MarkItDown reuse copy fails', async () => {
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.current-commit')) return 'aaa111';
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'build', cliVersion: CLI_VERSION, buildFingerprint: buildFingerprintForTest() });
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-')) return sourceBytes;
      throw new Error(`Unexpected readFile path: ${normalized}`);
    };
    makeFetchOk('newcommit');
    _autoUpdateIo.copyFile = (async () => { copyFileCalls.push([]); throw new Error('disk full'); }) as any;

    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/packages/cli/bin/markitdown-')) return true;
      if (path.includes('/releases/b/packages/cli/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion && !meta.buildFingerprint) return false;
        if (metadata.buildFingerprint && meta.buildFingerprint !== metadata.buildFingerprint) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: CLI_VERSION, buildFingerprint: buildFingerprintForTest() });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(true);
    expect(logCalls.some(m => m.includes('failed to reuse bundled MarkItDown binary from the active slot'))).toBe(true);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('self-heals when target slot has no .git directory (empty dir from failed migration)', async () => {
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.endsWith('/releases/a')) return true;
      if (path.endsWith('/releases/b/.git')) return false;
      if (path.includes('cli.js')) return true;
      return true;
    };
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');

    const result = await performUpdate(AU, () => {});
    expect(result).toBe(true);
    const targetDir = '/tmp/dkg-test/releases/b';
    const gitCmds = getExecFileCalls();
    expect(gitCmds.some(c => c.file === 'git' && c.args.join(' ') === 'init' && c.cwd === targetDir)).toBe(true);
  });

  it('commit file is written before swap (crash safety)', async () => {
    readFileImpl = async () => 'old-commit';
    makeFetchOk('new-commit');

    const callOrder: string[] = [];
    writeFileImpl = async (path: any) => {
      const p = String(path);
      if (p.includes('.update-pending.json')) callOrder.push('writePending');
      else if (p.includes('.current-commit')) callOrder.push('writeCommit');
    };
    swapSlotImpl = async () => { callOrder.push('swapSlot'); };

    await performUpdate(AU, () => {});

    const writeIdx = callOrder.indexOf('writePending');
    const swapIdx = callOrder.indexOf('swapSlot');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(swapIdx).toBeGreaterThan(writeIdx);
  });

  it('clears pending file if swap fails', async () => {
    const oldCommit = 'old-sha-111';
    const newCommit = 'new-sha-222';
    readFileImpl = async () => oldCommit;
    makeFetchOk(newCommit);

    swapSlotImpl = async () => { throw new Error('symlink failed'); };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate(AU, log);
    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('symlink swap failed'))).toBe(true);
    const commitWrites = writeFileCalls.filter((c) => String(c[0]).includes('.current-commit'));
    expect(commitWrites.length).toBe(0);
  });

  it('checkForNewCommit is read-only — does not build, swap, or modify files', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    makeFetchOk('new-sha');

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await checkForNewCommit(AU, log);

    expect(result).toBe('new-sha');
    expect(execCalls.length).toBe(0);
    expect(swapSlotCalls.length).toBe(0);
    expect(writeFileCalls.length).toBe(0);
  });

  it('checkForNewCommit supports non-GitHub repos via git ls-remote', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'ls-remote') {
        return { stdout: 'abcdef1234567890abcdef1234567890abcdef12\trefs/heads/main\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await checkForNewCommit({ ...AU, repo: 'ssh://git.example.com/non-github.git' }, log);

    expect(result).toBe('abcdef1234567890abcdef1234567890abcdef12');
    expect(fetchCalls.length).toBe(0);
    expect(logCalls.every(m => !m.includes('failed to check for new commit'))).toBe(true);
  });

  it('checkForNewCommit also validates branch names', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await checkForNewCommit({
      ...AU,
      branch: '$(whoami)',
    }, log);

    expect(result).toBeNull();
    expect(logCalls.some(m => m.includes('invalid branch'))).toBe(true);
  });

  it('rejects unsafe repo specs that start with dash', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await performUpdate(
      { ...AU, repo: '-c protocol.file.allow=always' },
      log,
    );

    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('invalid autoUpdate.repo'))).toBe(true);
    expect(execFileCalls.some(c => c.file === 'git' && c.args[0] === 'fetch')).toBe(false);
  });

  it('rejects refs that start with dash to avoid git option injection', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await checkForNewCommit({
      ...AU,
      branch: '--upload-pack=/tmp/pwn',
    }, log);

    expect(result).toBeNull();
    expect(logCalls.some(m => m.includes('invalid branch/ref'))).toBe(true);
  });

  it('checkForNewCommit handles fetch/network errors without throwing', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    fetchImpl = async () => { throw new Error('network timeout'); };
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await checkForNewCommit(AU, log);

    expect(result).toBeNull();
    expect(logCalls.some(m => m.includes('failed to check for new commit'))).toBe(true);
  });

  it('supports explicit tag refs for version-targeted updates', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('tagsha123');

    const result = await performUpdate(AU, () => {}, { refOverride: 'refs/tags/v9.0.5', verifyTagSignature: true });
    expect(result).toBe(true);
    const fetchUrl = String(fetchCalls[0]?.[0] ?? '');
    expect(fetchUrl).toContain('/commits/v9.0.5');
    expect(fetchUrl).not.toContain('refs%2Ftags%2Fv9.0.5');
    const allGitCalls = getExecFileCalls();
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'fetch https://github.com/owner/repo.git refs/tags/v9.0.5:refs/tags/v9.0.5')).toBe(true);
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'verify-tag v9.0.5')).toBe(true);
    expect(allGitCalls.some((c) => c.file === 'git' && c.args.join(' ') === 'checkout --force FETCH_HEAD')).toBe(true);
  });

  it('accepts refs containing build metadata (+) for tag checks', async () => {
    const { checkForNewCommit } = await import('../src/daemon.js');
    readFileImpl = async () => 'current-sha';
    makeFetchOk('new-sha');
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await checkForNewCommit(
      { ...AU, branch: 'refs/tags/v1.2.3+build.5' },
      log,
    );

    expect(result).toBe('new-sha');
    expect(logCalls.every(m => !m.includes('invalid branch/ref'))).toBe(true);
  });

  it('logs clear error when requested tag does not exist', async () => {
    readFileImpl = async () => 'aaa111';
    fetchImpl = async () => ({ ok: false, status: 422 });
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };

    const result = await performUpdate(AU, log, { refOverride: 'refs/tags/v9.0.5' });

    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('tag "v9.0.5" not found'))).toBe(true);
  });

  it('blocks pre-release versions unless allowPrerelease is true', async () => {
    readFileImpl = async (path: any) => {
      const p = normalizePathString(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('/packages/cli/package.json')) return JSON.stringify({ version: '9.0.5-rc.1' });
      throw new Error(`Unexpected readFile path: ${p}`);
    };
    makeFetchOk('rcsha123');

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performUpdate({ ...AU, allowPrerelease: false }, log);
    expect(result).toBe(false);
    expect(logCalls.some(m => m.includes('pre-release'))).toBe(true);
    expect(swapSlotCalls.length).toBe(0);
  });

  it('allows pre-release versions when allowPrerelease=true', async () => {
    readFileImpl = async (path: any) => {
      const p = normalizePathString(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('/packages/cli/package.json')) return JSON.stringify({ version: '9.0.5-rc.1' });
      throw new Error(`Unexpected readFile path: ${p}`);
    };
    makeFetchOk('rcsha999');

    const result = await performUpdate({ ...AU, allowPrerelease: true }, () => {});
    expect(result).toBe(true);
    expect(swapSlotCalls.length).toBeGreaterThanOrEqual(1);
  });
});

import { afterEach } from 'vitest';

describe('checkForNpmVersionUpdate tag precedence', () => {
  function makeRegistryResponse(distTags: Record<string, string>) {
    return {
      ok: true,
      json: async () => ({ 'dist-tags': distTags }),
    } as any;
  }

  beforeEach(async () => {
    resetMocks();
    installMocks();
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-version')) return '9.0.0-beta.3';
      throw new Error('ENOENT');
    };
  });

  afterEach(() => {
    restoreIo();
  });

  it('uses latest tag when allowPrerelease=false and latest is stable', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => makeRegistryResponse({
      latest: '9.1.0',
      dev: '9.2.0-dev.123.abc1234',
    });
    const result = await checkForNpmVersionUpdate(() => {}, false);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.1.0');
  });

  it('skips when allowPrerelease=false and latest is a prerelease', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => makeRegistryResponse({
      latest: '9.1.0-beta.1',
      dev: '9.2.0-dev.123.abc1234',
    });
    const result = await checkForNpmVersionUpdate(() => {}, false);
    expect(result.status).toBe('up-to-date');
  });

  it('picks highest version across dev/latest/beta when allowPrerelease=true', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => makeRegistryResponse({
      latest: '9.0.0-beta.4',
      dev: '9.0.0-beta.4-dev.999.abc1234',
      beta: '9.0.0-beta.3',
    });
    const result = await checkForNpmVersionUpdate(() => {}, true);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.0.0-beta.4-dev.999.abc1234');
  });

  it('prefers stable latest over older dev tag when allowPrerelease=true', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => makeRegistryResponse({
      latest: '9.1.0',
      dev: '9.0.0-beta.4-dev.123.abc1234',
    });
    const result = await checkForNpmVersionUpdate(() => {}, true);
    expect(result.status).toBe('available');
    expect(result.version).toBe('9.1.0');
  });

  it('returns error on registry failure', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => ({ ok: false, status: 503 });
    const result = await checkForNpmVersionUpdate(() => {}, true);
    expect(result.status).toBe('error');
  });

  it('returns up-to-date when current version matches latest', async () => {
    const { checkForNpmVersionUpdate } = await import('../src/daemon.js');
    fetchImpl = async () => makeRegistryResponse({
      latest: '9.0.0-beta.3',
    });
    const result = await checkForNpmVersionUpdate(() => {}, true);
    expect(result.status).toBe('up-to-date');
  });
});

describe('performNpmUpdate', () => {
  beforeEach(() => {
    resetMocks();
    mockActiveSlot = 'a';
    mockBundledCliPackageVersion = CLI_VERSION;
    mockInstalledPackageVersion = '9.0.0-beta.4-dev.100.abc1234';
    installMocks();
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (p.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.100.abc1234' });
      throw new Error(`Unexpected readFile: ${p}`);
    };
  });

  afterEach(() => {
    restoreIo();
  });

  it('installs package and swaps slot on success', async () => {
    const result = await performNpmUpdate('9.0.0-beta.4-dev.100.abc1234', () => {});
    expect(result).toBe('updated');
    expect(swapSlotCalls).toContain('b');
    expect(writeFileCalls.some(c =>
      String(c[0]).includes('.current-version') && c[1] === '9.0.0-beta.4-dev.100.abc1234'
    )).toBe(true);
  });

  it('returns failed when npm install throws', async () => {
    execImpl = async () => { throw new Error('npm ERR! 404'); };
    const result = await performNpmUpdate('9.99.0', () => {});
    expect(result).toBe('failed');
    expect(swapSlotCalls.length).toBe(0);
  });

  it('returns failed when entry point missing after install', async () => {
    existsSyncImpl = (p: any) => {
      if (String(p).includes('cli.js')) return false;
      return true;
    };
    const result = await performNpmUpdate('9.0.0-beta.5', () => {});
    expect(result).toBe('failed');
    expect(swapSlotCalls.length).toBe(0);
  });

  it('continues when the bundled MarkItDown binary is missing after install', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.5';
    existsSyncImpl = (p: any) => {
      const path = String(p);
      if (path.includes('markitdown-')) return false;
      return true;
    };
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(swapSlotCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('reuses the active-slot MarkItDown binary when npm install leaves it missing', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.5';
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'release', cliVersion: '9.0.0-beta.5' });
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return sourceBytes;
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion && !meta.buildFingerprint) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: '9.0.0-beta.5' });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBeGreaterThanOrEqual(1);
    expect(chmodCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls.some(m => m.includes('reused bundled MarkItDown binary from the active slot'))).toBe(true);
  });

  it('skips active-slot MarkItDown reuse when metadata targets a different npm version', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.5';
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'release', cliVersion: '9.0.0-beta.4' });
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sha256HexForTest(Buffer.from('active-slot-markitdown', 'utf-8'))}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) {
        return Buffer.from('active-slot-markitdown', 'utf-8');
      }
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion && !meta.buildFingerprint) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: '9.0.0-beta.5' });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBe(0);
    expect(logCalls.some(m => m.includes('incompatible metadata'))).toBe(true);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('skips active-slot MarkItDown reuse when the checksum sidecar is missing', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.5';
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && path.endsWith('.sha256')) return false;
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      return true;
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBe(0);
    expect(logCalls.some(m => m.includes('skipping active-slot bundled MarkItDown binary without a valid checksum sidecar'))).toBe(true);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('does not probe a source-slot build binary as an npm reuse candidate', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.5';
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/packages/cli/bin/markitdown-')) {
        throw new Error(`npm update should not inspect source-slot MarkItDown candidates: ${normalized}`);
      }
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/packages/cli/bin/markitdown-')) return true;
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBe(0);
    expect(existsSyncCalls.some(
      ([path]) => normalizePathString(path).includes('/releases/a/packages/cli/bin/markitdown-'),
    )).toBe(false);
    expect(logCalls.some(m => m.includes('Continuing without document conversion'))).toBe(true);
  });

  it('validates npm-installed MarkItDown metadata against the resolved package version instead of the requested spec', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.6';
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({ source: 'release', cliVersion: '9.0.0-beta.6' });
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return sourceBytes;
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: '9.0.0-beta.6' });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('latest', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBeGreaterThanOrEqual(1);
    expect(writeFileCalls.some(c =>
      String(c[0]).includes('.current-version') && c[1] === '9.0.0-beta.6'
    )).toBe(true);
    expect(logCalls.some(m => m.includes('reused bundled MarkItDown binary from the active slot'))).toBe(true);
  });

  it('reuses a fingerprint-compatible active-slot MarkItDown binary across CLI version bumps', async () => {
    mockInstalledPackageVersion = '9.0.0-beta.6';
    const sourceBytes = Buffer.from('active-slot-markitdown', 'utf-8');
    const sourceHash = sha256HexForTest(sourceBytes);
    readFileImpl = async (path: any) => {
      const normalized = normalizePathString(path);
      if (normalized.endsWith('.update-pending.json')) throw new Error('ENOENT');
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.meta.json')) {
        return JSON.stringify({
          source: 'release',
          cliVersion: '9.0.0-beta.5',
          buildFingerprint: buildFingerprintForTest(),
        });
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-') && normalized.endsWith('.sha256')) {
        const assetName = normalized.split('/').pop()?.replace(/\.sha256$/, '') ?? 'markitdown-test';
        return `${sourceHash}  ${assetName}\n`;
      }
      if (normalized.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return sourceBytes;
      throw new Error(`Unexpected readFile: ${normalized}`);
    };
    existsSyncImpl = (p: any) => {
      const path = normalizePathString(p);
      if (path.includes('/releases/a/node_modules/@origintrail-official/dkg/bin/markitdown-')) return true;
      if (path.includes('/releases/b/node_modules/@origintrail-official/dkg/bin/markitdown-')) return false;
      return true;
    };
    _autoUpdateIo.hasVerifiedBundledMarkItDownBinary = async (binPath: string, metadata?: any) => {
      const normalized = normalizePathString(binPath);
      if (!existsSyncImpl(normalized)) return false;
      if (!existsSyncImpl(normalized + '.sha256')) return false;
      if (!metadata) return true;
      try {
        const metaRaw = await readFileImpl(normalized + '.meta.json');
        const meta = JSON.parse(metaRaw);
        if (metadata.buildFingerprint && meta.buildFingerprint === metadata.buildFingerprint) return true;
        if (metadata.cliVersion && meta.cliVersion !== metadata.cliVersion) return false;
        return true;
      } catch { return false; }
    };
    _autoUpdateIo.expectedBundledMarkItDownBuildMetadata = () => ({ cliVersion: '9.0.0-beta.6', buildFingerprint: buildFingerprintForTest() });

    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.6', log);
    expect(result).toBe('updated');
    expect(copyFileCalls.length).toBeGreaterThanOrEqual(1);
    expect(logCalls.some(m => m.includes('reused bundled MarkItDown binary from the active slot'))).toBe(true);
  });

  it('recovers pending state if swap succeeded but version was not written', async () => {
    mockActiveSlot = 'b';
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.update-pending.json')) {
        return JSON.stringify({
          target: 'b',
          commit: '',
          version: '9.0.0-beta.4-dev.200.def5678',
          ref: 'npm:9.0.0-beta.4-dev.200.def5678',
          createdAt: new Date().toISOString(),
        });
      }
      if (p.endsWith('package.json')) return JSON.stringify({ version: '9.0.0-beta.4-dev.200.def5678' });
      throw new Error(`Unexpected readFile: ${p}`);
    };
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.4-dev.200.def5678', log);
    expect(result).toBe('updated');
    expect(logCalls.some(m => m.includes('recovered pending'))).toBe(true);
    expect(writeFileCalls.some(c =>
      String(c[0]).includes('.current-version') && c[1] === '9.0.0-beta.4-dev.200.def5678'
    )).toBe(true);
    expect(swapSlotCalls.length).toBe(0);
  });

  it('returns failed when slot swap throws', async () => {
    swapSlotImpl = async () => { throw new Error('EPERM'); };
    const logCalls: string[] = [];
    const log = (msg: string) => { logCalls.push(msg); };
    const result = await performNpmUpdate('9.0.0-beta.5', log);
    expect(result).toBe('failed');
    expect(logCalls.some(m => m.includes('symlink swap failed'))).toBe(true);
  });
});

describe('compareSemver', () => {
  let compareSemver: (a: string, b: string) => number;
  beforeEach(async () => {
    ({ compareSemver } = await import('../src/daemon.js'));
  });

  it('stable > prerelease for the same version', () => {
    expect(compareSemver('9.0.0', '9.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0')).toBeLessThan(0);
  });

  it('higher prerelease > lower prerelease', () => {
    expect(compareSemver('9.0.0-beta.2', '9.0.0-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0-beta.2')).toBeLessThan(0);
  });

  it('ignores build metadata for ordering', () => {
    expect(compareSemver('1.2.3-alpha+1', '1.2.3-alpha+2')).toBe(0);
    expect(compareSemver('9.0.0+build.1', '9.0.0+build.2')).toBe(0);
  });

  it('handles dev suffix with numeric comparison', () => {
    expect(compareSemver('9.0.0-beta.4-dev.200', '9.0.0-beta.4-dev.100')).toBeGreaterThan(0);
  });

  it('equal versions return 0', () => {
    expect(compareSemver('9.0.0', '9.0.0')).toBe(0);
    expect(compareSemver('9.0.0-beta.1', '9.0.0-beta.1')).toBe(0);
  });

  it('major/minor/patch ordering', () => {
    expect(compareSemver('10.0.0', '9.99.99')).toBeGreaterThan(0);
    expect(compareSemver('9.1.0', '9.0.99')).toBeGreaterThan(0);
    expect(compareSemver('9.0.1', '9.0.0')).toBeGreaterThan(0);
  });

  it('strips v prefix', () => {
    expect(compareSemver('v9.0.0', '9.0.0')).toBe(0);
  });
});

// ─── Hardening: incremental builds, configurable timeouts, fail-safe contract diff,
//     persisted update status. See PR `autoupdater-hardening`.
describe('autoupdater hardening', () => {
  beforeEach(() => {
    resetMocks();
    mockActiveSlot = 'a';
    installMocks();
  });

  afterEach(() => {
    restoreIo();
  });

  it('does NOT run `git clean -fdx` by default — preserves node_modules/Hardhat cache for incremental rebuild', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    await performUpdate(AU, () => {});
    const cleanCall = getExecFileCalls().find(
      c => c.file === 'git' && c.args[0] === 'clean',
    );
    expect(cleanCall).toBeUndefined();
  });

  it('runs `git clean -fdx` only when forceClean=true is passed', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    await performUpdate(AU, () => {}, { forceClean: true });
    const cleanCall = getExecFileCalls().find(
      c => c.file === 'git' && c.args[0] === 'clean' && c.args[1] === '-fdx',
    );
    expect(cleanCall).toBeTruthy();
  });

  it('honours autoUpdate.buildTimeoutMs.install on pnpm install', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    let installTimeout: number | undefined;
    execImpl = async (cmd: string, opts?: any) => {
      if (cmd.includes('pnpm install')) installTimeout = opts?.timeout;
      return { stdout: '', stderr: '' };
    };
    const auWithTimeout: AutoUpdateConfig = {
      ...AU,
      buildTimeoutMs: { install: 600_000 },
    };
    await performUpdate(auWithTimeout as any, () => {});
    expect(installTimeout).toBe(600_000);
  });

  it('honours autoUpdate.buildTimeoutMs.contracts when contracts rebuild', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    let contractsTimeout: number | undefined;
    execImpl = async (cmd: string, opts?: any) => {
      if (cmd.includes('pnpm --filter @origintrail-official/dkg-evm-module build')) {
        contractsTimeout = opts?.timeout;
      }
      return { stdout: '', stderr: '' };
    };
    // Force a runtime build path + contract rebuild trigger via diff.
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'diff') {
        return { stdout: 'packages/evm-module/contracts/Foo.sol\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const auWithTimeout: AutoUpdateConfig = {
      ...AU,
      buildTimeoutMs: { contracts: 1_200_000 },
    };
    await performUpdate(auWithTimeout as any, () => {});
    expect(contractsTimeout).toBe(1_200_000);
  });

  it('contract-diff fails closed: skips contract build when diff errors and parent fetch also errors (matches legacy behaviour)', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    let contractsBuilt = false;
    execImpl = async (cmd: string) => {
      if (cmd.includes('pnpm --filter @origintrail-official/dkg-evm-module build')) {
        contractsBuilt = true;
      }
      return { stdout: '', stderr: '' };
    };
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'diff') {
        throw new Error('fatal: bad revision aaa111..bbb222');
      }
      if (file === 'git' && args[0] === 'fetch' && args.includes('--depth=1')) {
        throw new Error('fatal: remote unreachable');
      }
      return { stdout: '', stderr: '' };
    };
    await performUpdate(AU, () => {});
    expect(contractsBuilt).toBe(false);
  });

  it('contract-diff retries via `git fetch --depth=1` for the missing parent commit before giving up', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    let firstDiffSeen = false;
    let retryFetchArgs: string[] | null = null;
    let secondDiffSeen = false;
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'diff') {
        if (!firstDiffSeen) {
          firstDiffSeen = true;
          throw new Error('fatal: bad revision');
        }
        secondDiffSeen = true;
        return { stdout: 'packages/evm-module/contracts/Foo.sol\n', stderr: '' };
      }
      if (file === 'git' && args.includes('fetch') && args.includes('--depth=1')) {
        retryFetchArgs = args;
      }
      return { stdout: '', stderr: '' };
    };
    let contractsBuilt = false;
    execImpl = async (cmd: string) => {
      if (cmd.includes('pnpm --filter @origintrail-official/dkg-evm-module build')) {
        contractsBuilt = true;
      }
      return { stdout: '', stderr: '' };
    };
    await performUpdate({ ...AU, repo: 'owner/repo' }, () => {});
    expect(firstDiffSeen).toBe(true);
    expect(retryFetchArgs).toBeTruthy();
    expect(secondDiffSeen).toBe(true);
    expect(contractsBuilt).toBe(true);
    // Slots are initialized with bare `git init` and have no `origin` remote;
    // the retry must use the explicit fetch URL, not the literal 'origin'.
    expect(retryFetchArgs!.includes('origin')).toBe(false);
    expect(retryFetchArgs!.some(a => a.includes('github.com/owner/repo'))).toBe(true);
  });

  it('persists `.update-status.json` on a successful update with consecutiveFailures=0', async () => {
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      // Status file does not yet exist; readFile rejects.
      if (p.endsWith('.update-status.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return '';
    };
    makeFetchOk('bbb222');
    let writtenStatus: any = null;
    writeFileImpl = async (path: any, data: any) => {
      // writeFileAtomic writes to <path>.tmp.<pid>.<rand>, then rename(tmp, path).
      // The tmp path INCLUDES `.update-status.json`, so use .includes() not .endsWith().
      if (String(path).includes('.update-status.json')) {
        writtenStatus = JSON.parse(String(data));
      }
    };
    await performUpdate(AU, () => {});
    expect(writtenStatus).toBeTruthy();
    expect(writtenStatus.consecutiveFailures).toBe(0);
    expect(writtenStatus.lastAttempt?.status).toBe('updated');
    expect(writtenStatus.lastAttempt?.fromCommit).toBe('aaa111');
    expect(writtenStatus.lastAttempt?.toCommit).toBe('bbb222');
    expect(writtenStatus.lastSuccess?.toCommit).toBe('bbb222');
  });

  it('increments consecutiveFailures on a failed update', async () => {
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-status.json')) {
        return JSON.stringify({ consecutiveFailures: 2 });
      }
      return '';
    };
    makeFetchOk('bbb222');
    execImpl = async (cmd: string) => {
      if (cmd.includes('pnpm build')) throw new Error('build exploded');
      return { stdout: '', stderr: '' };
    };
    let writtenStatus: any = null;
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        writtenStatus = JSON.parse(String(data));
      }
    };
    await performUpdate(AU, () => {});
    expect(writtenStatus).toBeTruthy();
    expect(writtenStatus.consecutiveFailures).toBe(3);
    expect(writtenStatus.lastAttempt?.status).toBe('failed');
  });

  it('atomic bookkeeping writes go through a temp path then rename to final', async () => {
    // Reproduces the dkg-v9-relay-01 corruption scenario: a partial / retried
    // writeFile to `.current-commit` left an 80-char doubled SHA on disk. With
    // writeFileAtomic, the actual writeFile lands at a tmp path and only the
    // rename produces the live file — so an interrupted write can never be
    // observed by the daemon as a corrupted live file.
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    const renameCalls: Array<[string, string]> = [];
    _autoUpdateIo.rename = (async (from: any, to: any) => {
      renameCalls.push([String(from), String(to)]);
    }) as any;
    await performUpdate(AU, () => {});
    // We expect a rename whose target is the live `.current-commit` and source
    // is a sibling tmp path. The same applies to `.current-version` and
    // `.update-status.json`.
    const commitRename = renameCalls.find(([, to]) => to.endsWith('/.current-commit'));
    expect(commitRename).toBeTruthy();
    expect(commitRename?.[0]).toMatch(/\.current-commit\.tmp\./);
    const statusRename = renameCalls.find(([, to]) => to.endsWith('/.update-status.json'));
    expect(statusRename).toBeTruthy();
    expect(statusRename?.[0]).toMatch(/\.update-status\.json\.tmp\./);
  });

  it('self-heals pre-existing `.current-commit` corruption (>64 chars) by re-deriving from git HEAD', async () => {
    // Exact dkg-v9-relay-01 reproduction: the file on disk contained the same
    // 40-char SHA written twice end-to-end (80 chars total). The daemon should
    // detect the malformed value, fall back to `git rev-parse HEAD`, and on
    // the next swap rewrite the file (atomically) with the real SHA.
    const corrupted = 'a'.repeat(40) + 'a'.repeat(40); // 80 chars
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return corrupted;
      return '';
    };
    makeFetchOk('bbb222');
    let revParseCalled = false;
    execImpl = async (cmd: string) => {
      if (cmd.includes('git rev-parse HEAD')) {
        revParseCalled = true;
        return { stdout: 'aaa111\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
    const logCalls: string[] = [];
    await performUpdate(AU, (m) => logCalls.push(m));
    expect(revParseCalled).toBe(true);
    expect(logCalls.some((m) => m.includes('malformed value') && m.includes('len=80'))).toBe(true);
  });

  // ─── Bot-review fixes (PR #303) ─────────────────────────────────────────

  it('clears stale dist/ + tsconfig.tsbuildinfo before build (preserves node_modules + Hardhat caches)', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    await performUpdate(AU, () => {});
    const findCalls = getExecFileCalls().filter(c => c.file === 'find');
    const wipesDist = findCalls.some(c =>
      c.args.includes('packages') &&
      c.args.includes('-name') && c.args.includes('dist') &&
      c.args.includes('-exec') && c.args.includes('rm'),
    );
    const wipesTsBuildInfo = findCalls.some(c =>
      c.args.includes('packages') &&
      c.args.includes('-name') && c.args.includes('tsconfig.tsbuildinfo') &&
      c.args.includes('-delete'),
    );
    expect(wipesDist).toBe(true);
    expect(wipesTsBuildInfo).toBe(true);
    // Sanity: no node_modules wipe and no Hardhat cache wipe.
    const touchesNodeModules = findCalls.some(c => c.args.some(a => a.includes('node_modules')));
    const touchesHardhatCache = findCalls.some(c =>
      c.args.some(a => a === 'cache' || a === 'artifacts'),
    );
    expect(touchesNodeModules).toBe(false);
    expect(touchesHardhatCache).toBe(false);
  });

  it('orphan-process sweep is scoped to the slot dir (no host-wide pkill -f)', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    const sweepCalls: Array<{ cmd: string; env: any }> = [];
    _autoUpdateIo.execSync = ((cmd: any, opts?: any) => {
      sweepCalls.push({ cmd: String(cmd), env: opts?.env ?? null });
      return '';
    }) as any;
    // Make pnpm install time out → triggers the sweep.
    execImpl = async (cmd: string) => {
      if (cmd.includes('pnpm install')) {
        const err: any = new Error('Command failed: pnpm install ETIMEDOUT');
        err.killed = true;
        err.signal = 'SIGTERM';
        throw err;
      }
      return { stdout: '', stderr: '' };
    };
    await performUpdate(AU, () => {});
    expect(sweepCalls.length).toBeGreaterThan(0);
    for (const call of sweepCalls) {
      // No host-wide command-line pattern matching.
      expect(call.cmd).not.toMatch(/pkill\s+(-\S+\s+)*-f/);
      // Scoping happens via env vars, not embedded in the script. EUID is
      // resolved in Node and passed as DKG_AU_UID — we MUST NOT depend on
      // bash-only `$EUID` because /bin/sh on Ubuntu/Debian is dash.
      expect(call.cmd).toContain('$DKG_AU_SLOT');
      expect(call.cmd).toContain('pgrep -u "$DKG_AU_UID"');
      expect(call.cmd).not.toContain('$EUID');
      expect(call.cmd).toContain('/proc/$pid/cwd');
      expect(call.env?.DKG_AU_SLOT).toMatch(/\/releases\/[ab]$/);
      expect(call.env?.DKG_AU_UID).toMatch(/^\d+$/);
    }
  });

  it('up-to-date does NOT record an attempt (no lastAttempt overwrite), but a clean check clears consecutiveFailures', async () => {
    // Two distinct semantics, deliberately split:
    //  - `recordAttempt` is for "did we try to apply an update" — skipped
    //    on up-to-date because no attempt happened, so `lastAttempt`
    //    history stays accurate to real attempts.
    //  - `recordCheck('up-to-date')` proves the node is currently healthy
    //    (remote reachable AND local matches), so it MUST clear
    //    `consecutiveFailures` — otherwise after manual remediation or a
    //    remote rollback, the documented `consecutiveFailures >= 3` alert
    //    would never resolve.
    const statusWrites: any[] = [];
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-status.json')) {
        // Latest persisted state — read-modify-write semantics.
        return JSON.stringify(
          statusWrites[statusWrites.length - 1]
            ?? { consecutiveFailures: 2, lastAttempt: { status: 'failed', fromCommit: 'aaa111', toCommit: 'old222', ref: 'main', at: '', elapsedMs: 0 } },
        );
      }
      return '';
    };
    // Remote returns SAME commit → up-to-date.
    makeFetchOk('aaa111');
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        statusWrites.push(JSON.parse(String(data)));
      }
    };
    await performUpdate(AU, () => {});
    // The check path writes once with cleared counter and a populated lastCheck.
    expect(statusWrites.length).toBeGreaterThan(0);
    const last = statusWrites[statusWrites.length - 1];
    expect(last.consecutiveFailures).toBe(0);
    expect(last.lastCheck?.status).toBe('up-to-date');
    // Critically, `lastAttempt` from the prior failure is preserved verbatim —
    // we did NOT record this no-op poll as an attempt.
    expect(last.lastAttempt?.status).toBe('failed');
    expect(last.lastAttempt?.fromCommit).toBe('aaa111');
  });

  it('error and available checks do NOT clear consecutiveFailures (preserves alerting signal across transient remote errors)', async () => {
    let writtenStatus: any = null;
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.update-status.json')) {
        return JSON.stringify({ consecutiveFailures: 2 });
      }
      return '';
    };
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        writtenStatus = JSON.parse(String(data));
      }
    };
    // Force an error from resolveRemoteCommitSha (no fetch.ok and no
    // ls-remote → returns null → status='error').
    fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'ls-remote') {
        throw new Error('connection refused');
      }
      return { stdout: '', stderr: '' };
    };
    const result = await checkForNewCommitWithStatus(AU as any, () => {});
    expect(result.status).toBe('error');
    expect(writtenStatus.consecutiveFailures).toBe(2);
    expect(writtenStatus.lastCheck?.status).toBe('error');
  });

  it('records a `failed` attempt when an unexpected exception escapes _performUpdateInner after fromCommit is captured', async () => {
    // _performUpdateInner has a few unwrapped lines after `currentCommit` is
    // captured (notably the pending-state recovery `writeFileAtomic` calls).
    // If those throw — disk error, ENOSPC, etc. — the outer
    // `performUpdateWithStatus` must still record the attempt as `failed`.
    // Pre-fix the `outcome` was assigned inside the `try` block AFTER the
    // await, so an early throw left it null and `.update-status.json` lost
    // exactly the exceptional paths this PR exists to surface.
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-pending.json')) {
        return JSON.stringify({ target: 'a', commit: 'pending111' });
      }
      if (p.endsWith('.update-status.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return '';
    };
    // Make the atomic rename to `.current-commit` blow up on the recovery
    // path (this is one of the few unwrapped throw sites past fromCommit).
    _autoUpdateIo.rename = (async (_from: any, to: any) => {
      if (String(to).endsWith('/.current-commit')) {
        throw new Error('EIO: simulated disk failure');
      }
    }) as any;
    let writtenStatus: any = null;
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        writtenStatus = JSON.parse(String(data));
      }
    };
    await performUpdate(AU, () => {}).catch(() => {});
    expect(writtenStatus).toBeTruthy();
    expect(writtenStatus.lastAttempt?.status).toBe('failed');
    expect(writtenStatus.lastAttempt?.fromCommit).toBe('aaa111');
    expect(writtenStatus.consecutiveFailures).toBe(1);
  });

  it('records an `error` lastCheck when the configured branch/ref is invalid', async () => {
    // Misconfiguration path: `!isValidRef(ref)` returns early without ever
    // hitting `resolveRemoteCommitSha`. Without an explicit recordCheck on
    // this branch, alerting based on `lastCheck.status` would keep showing
    // the previous healthy poll while the node is silently broken.
    let writtenStatus: any = null;
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        writtenStatus = JSON.parse(String(data));
      }
    };
    const badAu: AutoUpdateConfig = { ...AU, branch: '--evil-flag' };
    const result = await checkForNewCommitWithStatus(badAu as any, () => {});
    expect(result.status).toBe('error');
    expect(writtenStatus).toBeTruthy();
    expect(writtenStatus.lastCheck?.status).toBe('error');
    expect(writtenStatus.lastCheck?.ref).toBe('--evil-flag');
  });

  it('persists the attempt status BEFORE releasing the update lock (avoids cross-process clobber)', async () => {
    // The status file is read-modify-write and is now the alerting source
    // of truth. If we released the lock first, another daemon could grab
    // it, write a newer status, and have it clobbered by this late write.
    // Order must be: write status → release lock.
    const order: string[] = [];
    readFileImpl = async (path: any) => {
      const p = String(path);
      if (p.endsWith('.current-commit')) return 'aaa111';
      if (p.endsWith('.update-status.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return '';
    };
    makeFetchOk('bbb222');
    writeFileImpl = async (path: any, _data: any) => {
      if (String(path).includes('.update-status.json')) {
        order.push('writeStatus');
      }
    };
    // Spy on lock release via the unlinkSync hook (releaseUpdateLock removes
    // the lockfile via unlinkSync).
    _autoUpdateIo.unlinkSync = ((p: any) => {
      if (String(p).endsWith('/.update.lock')) {
        order.push('releaseLock');
      }
    }) as any;
    await performUpdate(AU, () => {});
    const writeIdx = order.indexOf('writeStatus');
    const releaseIdx = order.indexOf('releaseLock');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeLessThan(releaseIdx);
  });

  it('aborts the update if pre-build clean fails (no swap of a potentially dirty slot)', async () => {
    readFileImpl = async () => 'aaa111';
    makeFetchOk('bbb222');
    // Force the Node-based clean to throw on rm of dist (EACCES-ish), and
    // also force the git clean -fdx fallback to fail. Update must abort.
    _autoUpdateIo.rm = (async () => {
      throw new Error('EACCES: simulated permission denied on dist');
    }) as any;
    execFileImpl = async (file: string, args: string[]) => {
      if (file === 'git' && args[0] === 'clean' && args[1] === '-fdx') {
        throw new Error('EACCES: simulated permission denied on git clean');
      }
      return { stdout: '', stderr: '' };
    };
    const logs: string[] = [];
    const result = await performUpdate(AU, (m) => logs.push(m));
    expect(result).toBe(false);
    expect(logs.some(m => m.includes('pre-build clean failed') && m.includes('Aborting'))).toBe(true);
    // No slot swap should have happened.
    expect(swapSlotCalls.length).toBe(0);
  });

  it('serializes recordCheck and recordAttempt: interleaving cannot clobber consecutiveFailures', async () => {
    // Simulate: prior status with consecutiveFailures=2 from a real failed
    // attempt. Then a check (`up-to-date`) and an attempt-record (`failed`)
    // race within the same Node process. With the in-process mutex, the
    // final on-disk state must reflect both writes serially — the LATER
    // write wins, not whichever read-snapshot raced last.
    let stored: any = { consecutiveFailures: 2, lastAttempt: { status: 'failed', fromCommit: 'aaa111', toCommit: 'old', ref: 'main', at: '', elapsedMs: 0 } };
    readFileImpl = async (path: any) => {
      if (String(path).endsWith('.update-status.json')) return JSON.stringify(stored);
      return '';
    };
    writeFileImpl = async (path: any, data: any) => {
      if (String(path).includes('.update-status.json')) {
        // Atomic file write goes path.tmp.* → rename → path. Just record
        // the last full-snapshot write here so we can verify the merged result.
        stored = JSON.parse(String(data));
      }
    };
    // Both runs concurrently; await their settled state.
    const [, ] = await Promise.all([
      // direct call to the recordCheck path
      checkForNewCommitWithStatus({ ...AU } as any, () => {}).then(() => {}),
      // an attempt-style write — invoke performUpdate where remote is bbb222 and build fails fast
      (async () => {
        // override fetch + impls to drive a `failed` recordAttempt on the second invocation
        const origFetchImpl = fetchImpl;
        fetchImpl = async () => ({ ok: true, json: async () => ({ sha: 'bbb222' }) });
        execImpl = async (cmd: string) => {
          if (cmd.includes('pnpm install')) throw new Error('boom');
          return { stdout: '', stderr: '' };
        };
        await performUpdate(AU, () => {});
        fetchImpl = origFetchImpl;
      })(),
    ]);
    // The final snapshot must be self-consistent: lastAttempt.status from
    // recordAttempt + lastCheck.status from recordCheck. consecutiveFailures
    // reflects the LAST write (whichever ran second), but it's never the
    // stale snapshot's value (would be 2 if races corrupted the merge).
    expect(stored.lastAttempt?.status).toBe('failed');
    expect(stored.lastCheck?.status).toBeDefined();
    // The mutex guarantees at least one of these writes saw the other's
    // result, i.e. counter is either 0 (recordCheck cleared, ran last) or 3
    // (recordAttempt incremented from 2, ran last). It must NOT remain at 2
    // (which would mean a write was lost).
    expect([0, 3]).toContain(stored.consecutiveFailures);
  });
});
