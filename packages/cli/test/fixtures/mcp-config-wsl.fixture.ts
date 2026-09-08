/** Mandatory native WSL fixture; bundled on Windows and executed by Linux Node. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeRegistration, writeRegistration } from '../../src/mcp-client-config.js';
import type { ClientTarget } from '../../src/mcp-client-registry.js';

assert.equal(process.platform, 'linux', 'fixture must run inside WSL using Linux Node');
assert(process.env.WSL_DISTRO_NAME, 'fixture requires a real WSL distribution');
const windowsRoot = process.argv[2];
assert(windowsRoot, 'Windows-side temporary root is required');
const directory = mkdtempSync(join(windowsRoot, 'dkg-wsl-acl-'));
const path = join(directory, "config 'quoted'.json");
const winPath = execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
assert.match(winPath, /^[A-Za-z]:\\/, 'fixture config must live on a Windows drive');
const powershell = (script: string) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; ${script}`], {
  encoding: 'utf8',
  env: { ...process.env, DKG_NATIVE_FIXTURE_PATH: winPath, WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}DKG_NATIVE_FIXTURE_PATH` },
}).trim();
try {
  writeFileSync(path, JSON.stringify({ mcpServers: { dkg: { command: 'old', env: { EXTRA: 'keep' } }, sibling: { command: 'other' } } }));
  powershell("$acl=Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH -AclObject $acl");
  const descriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).Sddl');
  const before = descriptor();
  assert.equal(powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).AreAccessRulesProtected'), 'True');
  const target: ClientTarget = { id: 'cursor', name: 'Cursor', configPath: path, displayPath: path, format: 'json', serverContainer: 'mcpServers', location: 'windows-wsl' };
  writeRegistration(target, { command: 'node', args: ['dkg.js'], env: { DKG_HOME: '/fixture' } });
  assert.equal(descriptor(), before, 'setup must preserve the complete protected security descriptor');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).mcpServers.dkg.env, { EXTRA: 'keep', DKG_HOME: '/fixture' });
  assert.equal(removeRegistration(target), true);
  assert.equal(descriptor(), before, 'uninstall must preserve the complete protected security descriptor');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { sibling: { command: 'other' } } });
  assert.deepEqual(readdirSync(directory), ["config 'quoted'.json"]);
  console.log('Native WSL setup and uninstall preserved protected Windows DACL, owner and sibling registration.');
} finally { rmSync(directory, { recursive: true, force: true }); }
