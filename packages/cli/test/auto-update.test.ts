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
        normalizePathString(call[0]).endsWith('/tmp/dkg-test/.current-commit') && call[1] === latest)
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
