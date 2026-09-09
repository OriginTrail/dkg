/** Mandatory native WSL fixture; runs the built CLI modules with Linux Node. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowsPowerShellExecutable } from '../../dist/mcp-config-metadata.js';
import { detectClients } from '../../dist/mcp-client-registry.js';
import { mcpSetupAction } from '../../dist/mcp-setup.js';
import { mcpUninstallAction } from '../../dist/mcp-uninstall.js';

assert.equal(process.platform, 'linux', 'fixture must run inside WSL using Linux Node');
assert(process.env.WSL_DISTRO_NAME, 'fixture requires a real WSL distribution');
const windowsRoot = process.argv[2];
assert(windowsRoot, 'Windows-side temporary root is required');
const directory = mkdtempSync(join(windowsRoot, "dkg-wsl-acl 'quoted'-"));
const cursorDirectory = join(directory, '.cursor');
mkdirSync(cursorDirectory);
const path = join(cursorDirectory, 'mcp.json');
const winPath = execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
assert.match(winPath, /^[A-Za-z]:\\/, 'fixture config must live on a Windows drive');
const powershell = (script: string) => execFileSync(windowsPowerShellExecutable('windows-wsl'), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; ${script}`], {
  encoding: 'utf8',
  env: { ...process.env, DKG_NATIVE_FIXTURE_PATH: winPath, WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}DKG_NATIVE_FIXTURE_PATH` },
}).trim();
async function main(): Promise<void> {
  const priorHome = process.env.HOME;
  const priorDkgHome = process.env.DKG_HOME;
  const priorPath = process.env.PATH;
  const priorCwd = process.cwd();
  try {
    // The isolated Linux home and the Windows USERPROFILE resolver name the
    // same Windows directory, exactly as in the reported aliasing case.
    process.env.HOME = directory;
    const nodeHome = join(directory, '.dkg');
    process.env.DKG_HOME = nodeHome;
    mkdirSync(nodeHome);
    writeFileSync(join(nodeHome, 'config.json'), JSON.stringify({ name: 'Metadata fixture', networkConfig: 'testnet', apiPort: 9200 }));
    writeFileSync(path, JSON.stringify({ mcpServers: { dkg: { command: 'old', env: { EXTRA: 'keep' } }, sibling: { command: 'other' } } }));
    powershell("$acl=Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH -AclObject $acl");
    const descriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).Sddl');
    const before = descriptor();
    assert.equal(powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).AreAccessRulesProtected'), 'True');
    const clients = detectClients(name => name === 'USERPROFILE' ? directory : null)
      .filter(target => target.id === 'cursor');
    assert.deepEqual(clients.map(target => target.location), ['native', 'windows-wsl']);
    assert(clients.every(target => target.configPath === path));
    const unexpected = (): never => { throw new Error('Metadata fixture must not initialize, start, or fund a node'); };
    const untrusted = join(directory, 'untrusted');
    mkdirSync(untrusted);
    const marker = join(untrusted, 'shadow-executed');
    const shadowExecutable = join(untrusted, 'powershell.exe');
    writeFileSync(shadowExecutable, '#!/bin/sh\nprintf executed > shadow-executed\nexit 99\n');
    chmodSync(shadowExecutable, 0o755);
    process.chdir(untrusted);
    process.env.PATH = `${untrusted}:${priorPath ?? ''}`;
    assert.throws(() => execFileSync(shadowExecutable, [], { stdio: 'pipe' }));
    assert.equal(readFileSync(marker, 'utf8'), 'executed');
    rmSync(marker);
    let registrationPlans = 0;
    await mcpSetupAction({ installed: true, start: false, fund: false, verify: false, force: true, yes: true }, {
      detectClients: () => clients,
      loadNetworkConfig: unexpected,
      ensureDkgNodeConfig: unexpected,
      startDaemon: unexpected,
      fundWalletsBestEffort: unexpected,
      loadOpWallets: async () => ({ wallets: [] }),
      findDkgMonorepoRoot: () => null,
      resolveKnownNetworkConfigName: () => 'testnet',
      resolveDkgConfigHome: () => nodeHome,
      confirmPlan: async (planned) => {
        assert.equal(planned.length, 1, 'one physical leaf must produce one registration write');
        assert.equal(planned[0]!.s.target.endpoint.location, 'windows-wsl');
        assert.equal(planned[0]!.action, 'refresh');
        registrationPlans += planned.length;
        return [...planned];
      },
    });
    assert.equal(registrationPlans, 1);
    assert.equal(existsSync(marker), false, 'setup must not execute the PATH/cwd shadow PowerShell');
    assert.equal(descriptor(), before, 'setup must preserve the complete protected security descriptor');
    const registered = JSON.parse(readFileSync(path, 'utf8')).mcpServers.dkg;
    assert.equal(registered.command, process.execPath);
    assert.deepEqual(registered.env, { EXTRA: 'keep', DKG_HOME: nodeHome });
    // Even an explicit native selector must retain the Windows persistence
    // strategy when both logical locations resolve to this one NTFS file.
    await mcpUninstallAction({ yes: true, client: 'cursor:native' }, {
      detectClients: () => clients,
      log: () => {},
    });
    assert.equal(existsSync(marker), false, 'uninstall must not execute the PATH/cwd shadow PowerShell');
    assert.equal(descriptor(), before, 'uninstall must preserve the complete protected security descriptor');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { sibling: { command: 'other' } } });
    assert.deepEqual(readdirSync(cursorDirectory).sort(), ['mcp.json', 'skills']);
    console.log('Native WSL setup planned one Windows-backed write for overlapping HOME/USERPROFILE aliases and preserved the protected DACL, owner and sibling registration through uninstall.');
  } finally {
    process.chdir(priorCwd);
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = priorDkgHome;
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
