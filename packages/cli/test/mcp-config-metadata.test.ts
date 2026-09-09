import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, statSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotMcpConfigSource, writeMcpConfigAtomic } from '../src/mcp-config-file.js';
import { linuxMetadataCopyCommand, mcpConfigPersistenceStrategy } from '../src/mcp-config-metadata.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

const nativeMetadata = process.env.DKG_REQUIRE_NATIVE_MCP_METADATA === '1';
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dkg-mcp-metadata-'));
  path = join(directory, "config 'quoted'.json");
  writeFileSync(path, '{"original":true}\n');
});
afterEach(() => { vi.mocked(execFileSync).mockReset(); rmSync(directory, { recursive: true, force: true }); });

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
    expect(() => writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy('native'), snapshotMcpConfigSource(path))).toThrow('apk add coreutils');
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
    expect(() => writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy('native'), snapshotMcpConfigSource(path))).toThrow(stage === 'retain-backup' ? 'backup is retained' : 'failed');
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
  writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy('native'), snapshotMcpConfigSource(path));
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
  writeMcpConfigAtomic(path, '{}\n', mcpConfigPersistenceStrategy('native'), snapshotMcpConfigSource(path));
  expect(acl()).toBe(before);
  expect(execFileSync('getfattr', ['--only-values', '-n', 'user.dkg_fixture', path], { encoding: 'utf8' }).trim()).toBe('retained');
  expect(readdirSync(directory)).toEqual(["config 'quoted'.json"]);
});

// test-disable-allow: D1 #425 -- owner=branarakic lane=mcp-config-native-windows expires=2026-10-08 Native security-descriptor case runs on windows-latest in mcp-config-native.yml.
it.runIf(nativeMetadata && process.platform === 'win32')('preserves a protected Windows DACL and owner through replacement', () => {
  const powershell = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:PSModulePath = $PSHOME + '\\Modules'; ${script}`], {
    encoding: 'utf8', env: { ...process.env, DKG_MCP_NATIVE_PATH: path }, windowsHide: true,
  }).trim();
  powershell("$acl=Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'); $acl.SetAccessRule($rule); Set-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH -AclObject $acl");
  const descriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH).Sddl');
  const before = descriptor();
  expect(powershell('(Get-Acl -LiteralPath $env:DKG_MCP_NATIVE_PATH).AreAccessRulesProtected')).toBe('True');
  writeMcpConfigAtomic(path, '{"replacement":true}\n', mcpConfigPersistenceStrategy('native'), snapshotMcpConfigSource(path));
  expect(descriptor()).toBe(before);
  expect(readFileSync(path, 'utf8')).toBe('{"replacement":true}\n');
  expect(readdirSync(directory)).toEqual(["config 'quoted'.json"]);
});


it('routes Windows-side WSL replacements through converted paths and Windows security APIs', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const converted = new Map<string, string>();
  const scripts: string[] = [];
  vi.mocked(execFileSync).mockImplementation((command, args, options) => {
    if (command === 'wslpath') {
      expect(args?.[0]).toBe('-w');
      const native = String(args?.[1]);
      const windows = `C:\\fixture\\${converted.size}`;
      converted.set(windows, native);
      return windows;
    }
    expect(command).toBe('powershell.exe');
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
    writeMcpConfigAtomic(path, '{"wsl":true}\n', mcpConfigPersistenceStrategy('windows-wsl'), snapshotMcpConfigSource(path));
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('Get-Acl');
    expect(scripts[1]).toContain('::Replace');
    expect(readFileSync(path, 'utf8')).toBe('{"wsl":true}\n');
  } finally { Object.defineProperty(process, 'platform', platform); }
});
