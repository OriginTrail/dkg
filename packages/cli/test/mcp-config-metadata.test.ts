import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, existsSync, statSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { snapshotMcpConfigSource as snapshotSourceTransaction, writeMcpConfigAtomic } from '../src/mcp-config-file.js';
import { detectClients } from '../src/mcp-client-registry.js';
import { detectMcpRuntime } from '../src/mcp-runtime.js';
import { copyWindowsMcpConfigMetadata, linuxMetadataCopyCommand, mcpConfigPersistenceStrategy } from '../src/mcp-config-metadata.js';

const runtimeFixture = vi.hoisted(() => ({ release: undefined as string | undefined, proc: undefined as string | undefined }));
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => process.platform, release: () => runtimeFixture.release ?? actual.release() };
});
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
    if (args[0] === '/proc/version' && runtimeFixture.proc !== undefined) return runtimeFixture.proc;
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync };
});

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const nativeMetadata = process.env.DKG_REQUIRE_NATIVE_MCP_METADATA === '1';
const snapshotMcpConfigSource = (configPath: string) => snapshotSourceTransaction(
  configPath,
  [{ configPath, displayPath: configPath }],
);
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dkg-mcp-metadata-'));
  path = join(directory, "config 'quoted'.json");
  writeFileSync(path, '{"original":true}\n');
});
afterEach(() => { runtimeFixture.release = undefined; runtimeFixture.proc = undefined; vi.unstubAllEnvs(); vi.mocked(execFileSync).mockReset(); rmSync(directory, { recursive: true, force: true }); });

const signals = [
  { name: 'distro environment', env: 'WSL_DISTRO_NAME', release: 'generic', proc: 'generic' },
  { name: 'interop environment', env: 'WSL_INTEROP', release: 'generic', proc: 'generic' },
  { name: 'Microsoft release', release: '5.15.0-microsoft-standard', proc: 'generic' },
  { name: 'WSL-only release', release: '5.15.0-wsl2', proc: 'generic' },
  { name: 'Microsoft procfs', release: 'generic', proc: 'Linux Microsoft kernel' },
  { name: 'WSL-only procfs', release: 'generic', proc: 'Linux WSL2 kernel' },
];
const destinations = [
  { name: 'drive', translated: 'C:\\fixture\\config.json', kind: 'windows-wsl' },
  { name: 'network share', translated: '\\\\server\\share\\config.json', kind: 'windows-wsl' },
  { name: 'Linux distro', translated: '\\\\wsl.localhost\\Ubuntu\\home\\user\\config.json', kind: 'linux' },
  { name: 'legacy Linux distro', translated: '\\\\wsl$\\Ubuntu\\home\\user\\config.json', kind: 'linux' },
];
it.each(signals.flatMap(signal => destinations.map(destination => ({ signal, destination,
  name: signal.name + ': ' + destination.name }))))('routes a shared runtime signal: $name', ({ signal, destination }) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.stubEnv('WSL_DISTRO_NAME', undefined);
  vi.stubEnv('WSL_INTEROP', undefined);
  if (signal.env) vi.stubEnv(signal.env, 'fixture');
  runtimeFixture.release = signal.release;
  runtimeFixture.proc = signal.proc;
  vi.mocked(execFileSync).mockReturnValue(destination.translated);
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(detectMcpRuntime()).toBe('wsl');
    const discoverWindowsPath = vi.fn(() => null);
    detectClients(discoverWindowsPath);
    expect(discoverWindowsPath).toHaveBeenCalledWith('USERPROFILE');
    expect(mcpConfigPersistenceStrategy(path).kind).toBe(destination.kind);
    expect(execFileSync).toHaveBeenCalledWith('/usr/bin/wslpath', ['-w', path], expect.any(Object));
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it.each([['darwin', 'posix'], ['win32', 'windows-native']] as const)('ignores WSL markers outside Linux on %s', (operatingSystem, kind) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.stubEnv('WSL_DISTRO_NAME', 'fixture');
  runtimeFixture.release = 'microsoft-wsl';
  try {
    Object.defineProperty(process, 'platform', { value: operatingSystem });
    expect(mcpConfigPersistenceStrategy(path).kind).toBe(kind);
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('finds a separately installed GNU command when the default cp is BusyBox', () => {
  vi.mocked(execFileSync).mockReturnValueOnce('BusyBox cp: -p preserve mode and owner\n');
  vi.mocked(execFileSync).mockReturnValueOnce('GNU cp --preserve=ATTR_LIST including xattr\n');
  expect(linuxMetadataCopyCommand()).toBe('gcp');
});

it('rejects a missing metadata capability before creating files or changing contents', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const before = readdirSync(directory);
  vi.mocked(execFileSync).mockReturnValueOnce('BusyBox cp: -p preserve mode and owner\n');
  vi.mocked(execFileSync).mockImplementationOnce(() => { throw new Error('gcp not installed'); });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path))).toThrow('apk add coreutils');
    expect(readFileSync(path, 'utf8')).toBe('{"original":true}\n');
    expect(readdirSync(directory)).toEqual(before);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it.each(['acl', 'replace', 'restore-backup', 'retain-backup'] as const)('preserves Windows config on %s failure', stage => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  vi.mocked(execFileSync).mockImplementation((_command, _args, options) => {
    const paths = (options as { env: NodeJS.ProcessEnv }).env;
    if (!paths.DKG_MCP_FILE_BACKUP) {
      if (stage === 'acl') throw new Error('ACL copy failed');
      return Buffer.from('');
    }
    const backup = paths.DKG_MCP_FILE_BACKUP;
    const destination = paths.DKG_MCP_FILE_DESTINATION!;
    if (stage === 'restore-backup') renameSync(destination, backup);
    if (stage === 'retain-backup') copyFileSync(destination, backup);
    throw new Error('Replacement failed');
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path))).toThrow(stage === 'retain-backup' ? 'backup is retained' : 'failed');
    expect(readFileSync(path, 'utf8')).toBe('{"original":true}\n');
    const backups = readdirSync(directory).filter(name => name.endsWith('.backup'));
    expect(backups).toHaveLength(stage === 'retain-backup' ? 1 : 0);
    if (backups[0]) expect(readFileSync(join(directory, backups[0]), 'utf8')).toBe('{"original":true}\n');
    expect(readdirSync(directory).filter(name => name.endsWith('.tmp'))).toEqual([]);
  } finally { Object.defineProperty(process, 'platform', platform); }
});

it('aborts publication when the client changes the destination after the edit snapshot', () => {
  const source = snapshotMcpConfigSource(path);
  const publish = vi.fn();
  const persistence = {
    kind: 'posix' as const,
    preflight() {},
    prepare() {},
    secure() { writeFileSync(path, '{"clientChange":true}\n'); },
    publish,
  };
  expect(() => writeMcpConfigAtomic(path, '{"dkgChange":true}\n', persistence, source))
    .toThrow('changed while it was being edited');
  expect(publish).not.toHaveBeenCalled();
  expect(readFileSync(path, 'utf8')).toBe('{"clientChange":true}\n');
  expect(readdirSync(directory)).toEqual(["config 'quoted'.json"]);
});

it('rejects first-time creation if a symlinked parent changes after inspection', () => {
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  const alias = join(directory, 'alias');
  mkdirSync(first); mkdirSync(second);
  symlinkSync(first, alias, 'junction');
  const configPath = join(alias, 'config.json');
  const source = snapshotMcpConfigSource(configPath);
  expect(source.content).toBeUndefined();
  unlinkSync(alias);
  symlinkSync(second, alias, 'junction');
  expect(() => writeMcpConfigAtomic(configPath, '{}\n', mcpConfigPersistenceStrategy(source.destination), source))
    .toThrow('path changed since inspection');
  expect(readdirSync(first)).toEqual([]);
  expect(readdirSync(second)).toEqual([]);
});

// test-disable-allow: D1 #425 -- owner=branarakic lane=mcp-config-native-macos expires=2026-10-08 Native ACL/xattr case runs on macos-latest in mcp-config-native.yml.
it.runIf(nativeMetadata && process.platform === 'darwin')('preserves macOS permissions, ownership, ACLs and extended attributes', () => {
  chmodSync(path, 0o640);
  execFileSync('/bin/chmod', ['+a', 'everyone allow read', path]);
  execFileSync('/usr/bin/xattr', ['-w', 'org.origintrail.fixture', 'retained', path]);
  const acl = () => execFileSync('/bin/ls', ['-le', path], { encoding: 'utf8' }).split('\n').slice(1).join('\n');
  const before = acl();
  const { mode, uid, gid } = statSync(path);
  expect(mode & 0o777).toBe(0o640);
  expect(before).toContain('everyone allow read');
  writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path));
  expect(acl()).toBe(before);
  expect(statSync(path)).toMatchObject({ mode, uid, gid });
  expect(execFileSync('/usr/bin/xattr', ['-p', 'org.origintrail.fixture', path], { encoding: 'utf8' }).trim()).toBe('retained');
  expect(readdirSync(directory)).toEqual(["config 'quoted'.json"]);
});

// test-disable-allow: D1 #425 -- owner=branarakic lane=mcp-config-native-linux expires=2026-10-08 Required Linux ACL/xattr tools are installed by mcp-config-native.yml.
it.runIf(nativeMetadata && process.platform === 'linux')('preserves Linux ACLs and extended attributes', () => {
  execFileSync('setfacl', ['-m', 'u:65534:r--', path]);
  execFileSync('setfattr', ['-n', 'user.dkg_fixture', '-v', 'retained', path]);
  const acl = () => execFileSync('getfacl', ['-cn', path], { encoding: 'utf8' });
  const before = acl();
  expect(before).toContain('user:65534:r--');
  writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path));
  expect(acl()).toBe(before);
  expect(execFileSync('getfattr', ['--only-values', '-n', 'user.dkg_fixture', path], { encoding: 'utf8' }).trim()).toBe('retained');
  expect(readdirSync(directory)).toEqual(["config 'quoted'.json"]);
});

// test-disable-allow: D1 #425 -- owner=branarakic lane=mcp-config-native-windows expires=2026-10-08 Native security-descriptor case runs on windows-latest in mcp-config-native.yml.
it.runIf(nativeMetadata && process.platform === 'win32')('preserves a protected Windows DACL and owner through replacement', () => {
  const systemPowerShell = win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const powershell = (script: string) => execFileSync(systemPowerShell, ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; ${script}`], {
    encoding: 'utf8', env: { ...process.env, DKG_MCP_NATIVE_PATH: path }, windowsHide: true,
  }).trim();
  powershell("$acl=Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'); $acl.SetAccessRule($rule); Set-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH -AclObject $acl");
  const descriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH).Sddl');
  const before = descriptor();
  expect(powershell('(Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH).AreAccessRulesProtected')).toBe('True');
  const untrusted = join(directory, 'untrusted');
  mkdirSync(untrusted);
  const shadowExecutable = join(untrusted, 'powershell.exe');
  const marker = join(untrusted, 'shadow-executed');
  vi.stubEnv('DKG_MCP_SHADOW_EXE', shadowExecutable);
  vi.stubEnv('DKG_MCP_SHADOW_MARKER', marker);
  const priorCwd = process.cwd();
  try {
    powershell(`Add-Type -TypeDefinition 'using System; using System.IO; public class ShadowPowerShell { public static int Main() { File.WriteAllText(Environment.GetEnvironmentVariable("DKG_MCP_SHADOW_MARKER"), "executed"); return 99; } }' -OutputAssembly $env:DKG_MCP_SHADOW_EXE -OutputType ConsoleApplication`);
    // Prove the sentinel is executable before using it to detect unsafe lookup.
    expect(() => execFileSync(shadowExecutable, [], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(marker, 'utf8')).toBe('executed');
    rmSync(marker);
    process.chdir(untrusted);
    writeMcpConfigAtomic(path, '{"replacement":true}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path));
    expect(existsSync(marker)).toBe(false);
  } finally {
    process.chdir(priorCwd);
    vi.unstubAllEnvs();
  }
  expect(descriptor()).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe('{"replacement":true}\n');
  const firstPath = join(directory, 'first-time.json');
  const source = snapshotMcpConfigSource(firstPath);
  expect(source.content).toBeUndefined();
  writeMcpConfigAtomic(firstPath, '{"mcpServers":{"dkg":{"command":"node"}}}\n',
    mcpConfigPersistenceStrategy(source.destination), source);
  expect(JSON.parse(readFileSync(firstPath, 'utf8'))).toEqual({ mcpServers: { dkg: { command: 'node' } } });
  expect(readdirSync(directory).sort()).toEqual(["config 'quoted'.json", 'first-time.json', 'untrusted']);
});


it('routes Windows-side WSL replacements through converted paths and Windows security APIs', () => {
  vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const converted = new Map<string, string>();
  const systemPowerShell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const scripts: string[] = [];
  vi.mocked(execFileSync).mockImplementation((command, args, options) => {
    if (command === '/usr/bin/wslpath') {
      if (args?.[0] === '-u') return systemPowerShell;
      expect(args?.[0]).toBe('-w');
      const native = String(args?.[1]);
      const windows = `C:\\fixture\\${converted.size}`;
      converted.set(windows, native);
      return windows;
    }
    expect(command).toBe(systemPowerShell);
    const environment = (options as { env: NodeJS.ProcessEnv }).env;
    for (const name of ['DKG_MCP_FILE_SOURCE', 'DKG_MCP_FILE_DESTINATION', 'DKG_MCP_FILE_BACKUP']) {
      expect(environment.WSLENV?.split(':')).toContain(name);
    }
    const script = String(args?.[args.length - 1]);
    scripts.push(script);
    const source = converted.get(environment.DKG_MCP_FILE_SOURCE!)!;
    const destination = converted.get(environment.DKG_MCP_FILE_DESTINATION!)!;
    if (script.includes('::Replace')) renameSync(source, destination);
    return Buffer.from('');
  });
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    writeMcpConfigAtomic(path, '{"wsl":true}\n', mcpConfigPersistenceStrategy(path), snapshotMcpConfigSource(path));
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('Get-Acl');
    expect(scripts[1]).toContain('::Replace');
    expect(readFileSync(path, 'utf8')).toBe('{"wsl":true}\n');
  } finally { Object.defineProperty(process, 'platform', platform); }
});


it('uses an absolute system PowerShell executable regardless of working-directory candidates', () => {
  vi.stubEnv('SystemRoot', 'D:\\Windows');
  try {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''));
    copyWindowsMcpConfigMetadata('D:\\config.json', 'D:\\replacement.json', 'native');
    expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  } finally { vi.unstubAllEnvs(); }
});

it.each(['.', 'Windows', 'C:Windows', '\\Windows', 'C:\\Windows\\..\\untrusted'])('rejects ambiguous system root %s without executing a binary', root => {
  vi.stubEnv('SystemRoot', root);
  try {
    expect(() => copyWindowsMcpConfigMetadata('source', 'destination', 'native')).toThrow('absolute Windows SystemRoot');
    expect(execFileSync).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

it('rejects a relative WSL system-executable conversion before running PowerShell', () => {
  vi.mocked(execFileSync).mockReturnValue('powershell.exe');
  expect(() => copyWindowsMcpConfigMetadata(path, path, 'windows-wsl'))
    .toThrow('absolute WSL path');
  expect(execFileSync).toHaveBeenCalledTimes(1);
  expect(vi.mocked(execFileSync).mock.calls[0]?.[0]).toBe('/usr/bin/wslpath');
  expect(readFileSync(path, 'utf8')).toBe('{"original":true}\n');
});
