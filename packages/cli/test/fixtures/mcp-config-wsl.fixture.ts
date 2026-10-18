/** Mandatory native WSL fixture; runs the built CLI modules with Linux Node. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { windowsPowerShellExecutable } from '../../dist/mcp-config-metadata.js';
import { detectClients } from '../../dist/mcp-client-registry.js';
import { mcpSetupAction } from '../../dist/mcp-setup.js';
import { mcpUninstallAction } from '../../dist/mcp-uninstall.js';

assert.equal(process.platform, 'linux', 'fixture must run inside WSL using Linux Node');
assert(process.env.WSL_DISTRO_NAME, 'fixture requires a real WSL distribution');
const windowsRoot = process.argv[2];
const windowsNode = process.argv[3];
assert(windowsNode, 'Windows Node executable is required for the actual client launch');
assert(windowsRoot, 'Windows-side temporary root is required');
const projectMarker = "native-wsl-project 'literal' $HOME";
const directory = mkdtempSync(join(windowsRoot, "dkg-wsl-acl 'quoted'-"));
const cursorDirectory = join(directory, '.cursor');
mkdirSync(cursorDirectory);
const path = join(cursorDirectory, 'mcp.json');
const windowsPath = (path: string) => execFileSync('/usr/bin/wslpath', ['-w', path], { encoding: 'utf8' }).trim();
assert.match(windowsPath(path), /^[A-Za-z]:\\/, 'fixture config must live on a Windows drive');
const powershell = (script: string, configPath = path) => execFileSync(windowsPowerShellExecutable('windows-wsl'), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; ${script}`], {
  encoding: 'utf8',
  env: { ...process.env, DKG_NATIVE_FIXTURE_PATH: windowsPath(configPath), WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}DKG_NATIVE_FIXTURE_PATH` },
}).trim();
const protect = (configPath: string) => powershell("$acl=Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH; $acl.SetAccessRuleProtection($true,$false); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl.SetAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow')); Set-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH -AclObject $acl", configPath);
async function main(): Promise<void> {
  const priorHome = process.env.HOME;
  const priorDkgHome = process.env.DKG_HOME;
  const priorPath = process.env.PATH;
  const priorCwd = process.cwd();
  const priorEntrypoint = process.argv[1];
  const priorWslEnvironment = process.env.WSLENV;
  const linuxHome = mkdtempSync('/tmp/dkg-wsl-native-home-');
  try {
    delete process.env.WSLENV;
    // The isolated Linux home and the Windows USERPROFILE resolver name the
    // same Windows directory, exactly as in the reported aliasing case.
    process.env.HOME = directory;
    process.argv[1] = fileURLToPath(new URL('../cli.js', import.meta.url));
    const nodeHome = join(directory, '.dkg');
    process.env.DKG_HOME = nodeHome;
    mkdirSync(nodeHome);
    writeFileSync(join(nodeHome, 'config.json'), JSON.stringify({ name: 'Metadata fixture', networkConfig: 'testnet', apiPort: 59231 }));
    writeFileSync(path, JSON.stringify({ mcpServers: { dkg: { command: 'old', env: { EXTRA: 'keep', DKG_PROJECT: projectMarker } }, sibling: { command: 'other' } } }));
    protect(path);
    const descriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).Sddl');
    const before = descriptor();
    assert.equal(powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).AreAccessRulesProtected'), 'True');
    const aliasedClients = detectClients(name => name === 'USERPROFILE' ? directory : null)
      .filter(target => target.id === 'cursor');
    assert.deepEqual(aliasedClients.map(target => target.location), ['native', 'windows-wsl']);
    assert(aliasedClients.every(target => target.configPath === path));
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
    const setupOptions = { installed: true, start: false, fund: false, verify: false, force: true, yes: true } as const;
    const setupDeps: Parameters<typeof mcpSetupAction>[1] = {
      detectClients: () => aliasedClients,
      loadNetworkConfig: unexpected,
      ensureDkgNodeConfig: unexpected,
      startDaemon: unexpected,
      fundWalletsBestEffort: unexpected,
      loadOpWallets: async () => ({ wallets: [] }),
      findDkgMonorepoRoot: () => null,
      resolveKnownNetworkConfigName: () => 'testnet',
      resolveDkgConfigHome: () => nodeHome,
    };
    const originalBytes = readFileSync(path, 'utf8');
    await assert.rejects(mcpSetupAction(setupOptions, { ...setupDeps, confirmPlan: async planned => {
      assert.equal(planned.length, 1, 'one physical leaf must produce one decision');
      assert.equal(planned[0]!.action, 'skip', 'incompatible client runtimes must fail closed');
      return [...planned];
    } }), /No client configs updated.*1 client\(s\) failed:/s);
    assert.equal(readFileSync(path, 'utf8'), originalBytes, 'aliased setup must leave bytes unchanged');
    assert.equal(descriptor(), before, 'aliased setup must leave metadata unchanged');
    // Removing an old shared entry is still valid and must retain NTFS metadata,
    // even when the operator selects its native alias.
    await mcpUninstallAction({ yes: true, client: 'cursor:native' }, {
      detectClients: () => aliasedClients, log: () => {},
    });
    assert.equal(descriptor(), before, 'aliased uninstall must retain the protected descriptor');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { sibling: { command: 'other' } } });
    writeFileSync(path, originalBytes);
    assert.equal(descriptor(), before);


    // Distinct physical files allow native Linux and Windows clients to coexist.
    process.env.HOME = linuxHome;
    const linuxCursorDirectory = join(linuxHome, '.cursor');
    mkdirSync(linuxCursorDirectory);
    const linuxCursorPath = join(linuxCursorDirectory, 'mcp.json');
    const clients = detectClients(name => name === 'USERPROFILE' ? directory : null)
      .filter(target => target.id === 'cursor');
    assert.deepEqual(clients.map(target => target.configPath), [linuxCursorPath, path]);
    const separateDeps = { ...setupDeps, detectClients: () => clients };
    const resolvedEntries = new Map<string, { command: string; args: string[] }>();
    await mcpSetupAction({ ...setupOptions, force: false }, { ...separateDeps, confirmPlan: async planned => {
      assert.deepEqual(planned.map(item => item.action), ['register', 'refresh']);
      for (const item of planned) {
        assert(item.action !== 'skip');
        assert.equal(item.s.kind, 'classified');
        resolvedEntries.set(item.s.target.file.destination, item.s.entry);
      }
      return [...planned];
    } });
    assert.equal(existsSync(marker), false, 'setup must not execute the PATH/cwd shadow PowerShell');
    assert.equal(descriptor(), before, 'setup must preserve the complete protected security descriptor');
    const registered = JSON.parse(readFileSync(path, 'utf8')).mcpServers.dkg;
    const native = JSON.parse(readFileSync(linuxCursorPath, 'utf8')).mcpServers.dkg;
    for (const [configPath, entry] of resolvedEntries) {
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers.dkg;
      assert.equal(persisted.command, entry.command);
      assert.deepEqual(persisted.args, entry.args);
    }
    assert.equal(native.command, process.execPath);
    assert.deepEqual(native.args, [process.argv[1], 'mcp', 'serve']);
    assert.deepEqual(native.env, { DKG_HOME: nodeHome });
    assert.match(registered.command, /\\System32\\wsl\.exe$/);
    assert.deepEqual(registered.args.slice(0, 2), ['--distribution', process.env.WSL_DISTRO_NAME]);
    assert.deepEqual(registered.env, { EXTRA: 'keep', DKG_PROJECT: projectMarker, DKG_HOME: nodeHome,
      WSLENV: 'DKG_HOME/u:DKG_PROJECT/u:EXTRA/u' });
    assert.equal('environmentTransfer' in registered, false);
    assert(registered.args.includes(`DKG_HOME=${nodeHome}`));
    await mcpSetupAction({ ...setupOptions, force: false }, { ...separateDeps, confirmPlan: async planned => {
      assert.deepEqual(planned.map(item => [item.s.state, item.action]), [['registered', 'skip'], ['registered', 'skip']]);
      return [...planned];
    } });

    // A real Windows Node process launches the exact registered command/argv,
    // as a GUI MCP client does. It initializes the production MCP server over
    // stdio; no tool call, daemon, faucet or network request is needed.
    // Cold module imports across the CI checkout's NTFS/WSL boundary took 146s
    // before setup even began. Bound this correctness smoke independently of
    // interactive client startup performance; retain real initialize/tools-list.
    const smoke = fileURLToPath(new URL('../../../../scripts/test-mcp-wsl-launch.mjs', import.meta.url));
    console.log(execFileSync(process.execPath, [smoke, path, windowsNode, projectMarker, '59231'], {
      encoding: 'utf8', timeout: 310_000, maxBuffer: 1024 * 1024,
    }).trim());
    await mcpUninstallAction({ yes: true, client: 'cursor:native' }, { detectClients: () => clients, log: () => {} });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers.dkg.command, registered.command,
      'uninstalling the native client must retain the Windows registration');
    await mcpUninstallAction({ yes: true, client: 'cursor:windows-wsl' }, { detectClients: () => clients, log: () => {} });
    assert.equal(existsSync(marker), false, 'uninstall must not execute the PATH/cwd shadow PowerShell');
    assert.equal(descriptor(), before, 'uninstall must preserve the complete protected security descriptor');
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { mcpServers: { sibling: { command: 'other' } } });
    assert.deepEqual(readdirSync(cursorDirectory), ['mcp.json'], 'Windows config leaves no transaction artifacts');
    assert.equal(existsSync(join(linuxCursorDirectory, 'skills', 'dkg-node', 'SKILL.md')), true,
      'setup delivers the bundled skill under the selected Linux HOME');
    process.env.HOME = directory;

    // Codex has no Windows-side alias. Its native WSL configuration can still
    // live on NTFS, including first-time setup and a Linux-home symlink.
    const codexDirectory = join(directory, '.codex');
    mkdirSync(codexDirectory);
    const codexPath = join(codexDirectory, 'config.toml');
    const codexTargets = detectClients(() => null).filter(target => target.id === 'codex-cli');
    assert.equal(codexTargets.length, 1);
    assert.equal(codexTargets[0]!.location, 'native');
    assert.equal(existsSync(codexPath), false);
    await mcpSetupAction(setupOptions, { ...setupDeps, detectClients: () => codexTargets });
    assert.equal((TOML.parse(readFileSync(codexPath, 'utf8')).mcp_servers as TOML.JsonMap).dkg !== undefined, true);
    assert.deepEqual(readdirSync(codexDirectory), ['config.toml'], 'first setup must leave no transaction artifacts');
    protect(codexPath);
    const codexDescriptor = () => powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).Sddl', codexPath);
    const codexBefore = codexDescriptor();
    assert.equal(powershell('(Get-Acl -LiteralPath $env:DKG_NATIVE_FIXTURE_PATH).AreAccessRulesProtected', codexPath), 'True');
    writeFileSync(codexPath, readFileSync(codexPath, 'utf8') + '\n[mcp_servers.sibling]\ncommand = "keep"\n');
    const linuxCodexDirectory = join(linuxHome, '.codex');
    mkdirSync(linuxCodexDirectory);
    const codexLink = join(linuxCodexDirectory, 'config.toml');
    symlinkSync(codexPath, codexLink);
    for (const home of [directory, linuxHome]) {
      process.env.HOME = home;
      const targets = detectClients(() => null).filter(target => target.id === 'codex-cli');
      assert.equal(targets.length, 1);
      assert.equal(targets[0]!.location, 'native');
      await mcpSetupAction(setupOptions, { ...setupDeps, detectClients: () => targets });
      assert.equal(codexDescriptor(), codexBefore, 'native-only setup must preserve the protected Windows descriptor');
      const servers = TOML.parse(readFileSync(codexPath, 'utf8')).mcp_servers as TOML.JsonMap;
      assert.equal((servers.dkg as TOML.JsonMap).command, process.execPath);
      await mcpUninstallAction({ yes: true, client: 'codex-cli:native' }, { detectClients: () => targets, log: () => {} });
      assert.equal(codexDescriptor(), codexBefore, 'native-only uninstall must preserve the protected Windows descriptor');
      assert.deepEqual(TOML.parse(readFileSync(codexPath, 'utf8')), { mcp_servers: { sibling: { command: 'keep' } } });
    }
    assert.equal(lstatSync(codexLink).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(codexDirectory), ['config.toml']);

    // A native config on the Linux filesystem must keep POSIX metadata.
    const linuxConfig = join(linuxHome, '.claude.json');
    writeFileSync(linuxConfig, '{"mcpServers":{"sibling":{"command":"keep"}}}');
    chmodSync(linuxConfig, 0o640);
    const { uid, gid, mode } = statSync(linuxConfig);
    const linuxTargets = detectClients(() => null).filter(target => target.id === 'claude-code');
    await mcpSetupAction(setupOptions, { ...setupDeps, detectClients: () => linuxTargets });
    await mcpUninstallAction({ yes: true }, { detectClients: () => linuxTargets, log: () => {} });
    const after = statSync(linuxConfig);
    assert.deepEqual({ uid: after.uid, gid: after.gid, mode: after.mode }, { uid, gid, mode });
    assert.deepEqual(JSON.parse(readFileSync(linuxConfig, 'utf8')), { mcpServers: { sibling: { command: 'keep' } } });
    assert.equal(existsSync(marker), false, 'all native-only operations must ignore shadow PowerShell');
    console.log('Real WSL setup/uninstall passed for rejected aliases, separate native/Windows launchers, production MCP stdio initialization, native-only Codex on NTFS, Linux-home symlinks, first-time creation, and native Linux metadata.');

  } finally {
    process.chdir(priorCwd);
    process.argv[1] = priorEntrypoint;
    if (priorWslEnvironment === undefined) delete process.env.WSLENV;
    else process.env.WSLENV = priorWslEnvironment;
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorDkgHome === undefined) delete process.env.DKG_HOME;
    else process.env.DKG_HOME = priorDkgHome;
    rmSync(linuxHome, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
