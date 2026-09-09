import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import TOML from '@iarna/toml';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mcpConfigPersistenceStrategy } from '../src/mcp-config-metadata.js';

const fixture = vi.hoisted(() => ({ home: '', platform: 'darwin' }));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (...args: Parameters<typeof actual.execFileSync>) => {
      if (args[0] === '/usr/bin/wslpath' && args[1]?.[0] === '-w'
          && process.env.WSL_DISTRO_NAME === 'Fixture') {
        // Synthetic WSL identities still point at host temporary files. Model
        // that Linux-backed storage here; real Windows ACLs run in the WSL fixture.
        return '\\\\wsl.localhost\\Fixture' + String(args[1][1]).replace(/\//g, '\\');
      }
      return actual.execFileSync(...args);
    },
  };
});
// Isolate the actual client-path resolver without mocking detection, config writes,
// the uninstall action, or Commander. The process's real home stays untouched.
// Windows-side selector fixtures use temporary host files; the separate native
// WSL scenario exercises the real metadata boundary with Windows security APIs.
vi.mock('../src/mcp-config-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mcp-config-file.js')>();
  return {
    ...actual,
    writeMcpConfigAtomic: vi.fn((
      path: string,
      content: string,
      _persistence: Parameters<typeof actual.writeMcpConfigAtomic>[2],
      expectedSource: Parameters<typeof actual.writeMcpConfigAtomic>[3],
      validateDestination?: () => void,
    ) => actual.writeMcpConfigAtomic(path, content, mcpConfigPersistenceStrategy(path, process.platform === 'win32' ? 'windows' : process.platform === 'linux' ? 'linux' : 'posix'), expectedSource, validateDestination)),
  };
});

vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => fixture.home,
  platform: () => fixture.platform,
}));

let originalExitCode: typeof process.exitCode;
let cursor: string;
let claude: string;
beforeEach(() => {
  fixture.platform = 'darwin';
  fixture.home = mkdtempSync(join(tmpdir(), 'dkg-mcp-command-'));
  vi.stubEnv('DKG_HOME', join(fixture.home, 'dkg-node'));
  mkdirSync(join(fixture.home, 'dkg-node'));
  mkdirSync(join(fixture.home, '.cursor'));
  cursor = join(fixture.home, '.cursor', 'mcp.json');
  claude = join(fixture.home, '.claude.json');
  for (const path of [cursor, claude]) writeFileSync(path, '{"mcpServers":{"dkg":{"command":"dkg"},"other":{"command":"keep"}}}');
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(fixture.home, { recursive: true, force: true });
});

async function run(...args: string[]) {
  const { registerMcpCommand } = await import('../src/commands/mcp.js');
  const program = new Command().exitOverride();
  registerMcpCommand(program);
  await program.parseAsync(['node', 'dkg', 'mcp', 'uninstall', ...args]);
}

describe('dkg mcp uninstall command boundary', () => {
  it('forwards --dry-run and --client, preserving registrations and production-resolved node files', async () => {
    const { configPath, dkgDir } = await import('../src/config.js');
    const { dkgAuthTokenPath } = await import('@origintrail-official/dkg-core');
    const nodeConfig = configPath();
    const token = dkgAuthTokenPath(dkgDir());
    writeFileSync(nodeConfig, '{"sentinel":"node-config"}');
    writeFileSync(token, 'local-test-token');
    const paths = [cursor, claude, nodeConfig, token];
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    await run('--dry-run', '--client', 'cursor');
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Would remove DKG MCP: Cursor'));
    expect(process.exitCode).toBeUndefined();
  });

  it('forwards --yes and --client to remove only the selected registration', async () => {
    const before = readFileSync(claude, 'utf8');
    await run('--yes', '--client', 'cursor');
    expect(JSON.parse(readFileSync(cursor, 'utf8'))).toEqual({ mcpServers: { other: { command: 'keep' } } });
    expect(readFileSync(claude, 'utf8')).toBe(before);
    expect(process.exitCode).toBeUndefined();
  });

  it('reports nonzero status for unsupported selectors without changing registrations', async () => {
    const before = readFileSync(cursor, 'utf8');
    await run('--yes', '--client', 'typo');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unsupported MCP client selector'));
    expect(readFileSync(cursor, 'utf8')).toBe(before);
  });

  it('requires --yes when the actual command runs non-interactively', async () => {
    const before = readFileSync(cursor, 'utf8');
    await run('--client', 'cursor');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('requires --yes'));
    expect(readFileSync(cursor, 'utf8')).toBe(before);
  });
});


it('assigns one stable Cursor ID to real native and Windows-side detection candidates', async () => {
  fixture.platform = 'linux';
  vi.stubEnv('WSL_DISTRO_NAME', 'Fixture');
  const windowsHome = join(fixture.home, 'windows-user');
  mkdirSync(join(windowsHome, '.cursor'), { recursive: true });
  const windowsCursor = join(windowsHome, '.cursor', 'mcp.json');
  writeFileSync(windowsCursor, '{"mcpServers":{"dkg":{"command":"dkg"}}}');
  const { detectClients } = await import('../src/mcp-client-registry.js');
  const resolver = (name: string) => name === 'USERPROFILE' ? windowsHome : null;
  const both = detectClients(resolver).filter((target) => target.id === 'cursor');
  expect(both).toMatchObject([
    { id: 'cursor', location: 'native', configPath: cursor },
    { id: 'cursor', location: 'windows-wsl', configPath: windowsCursor },
  ]);
  rmSync(join(fixture.home, '.cursor'), { recursive: true });
  expect(detectClients(resolver).filter((target) => target.id === 'cursor'))
    .toMatchObject([{ id: 'cursor', location: 'windows-wsl', configPath: windowsCursor }]);
});

// These expected paths/shapes are independent of the production registry.
function seedNativeClients(selectedPlatform: string) {
  fixture.platform = selectedPlatform;
  const appData = join(fixture.home, 'roaming');
  const xdg = join(fixture.home, 'xdg-config');
  vi.stubEnv('APPDATA', appData);
  vi.stubEnv('XDG_CONFIG_HOME', xdg);
  vi.stubEnv('WSL_DISTRO_NAME', undefined);
  vi.stubEnv('WSL_INTEROP', undefined);
  const guiRoot = selectedPlatform === 'darwin'
    ? join(fixture.home, 'Library', 'Application Support')
    : selectedPlatform === 'win32' ? appData : xdg;
  const specs = [
    { id: 'cursor', configPath: join(fixture.home, '.cursor', 'mcp.json'), format: 'json', serverContainer: 'mcpServers' },
    { id: 'claude-code', configPath: join(fixture.home, '.claude.json'), format: 'json', serverContainer: 'mcpServers' },
    { id: 'claude-desktop', configPath: join(guiRoot, 'Claude', 'claude_desktop_config.json'), format: 'json', serverContainer: 'mcpServers' },
    { id: 'windsurf', configPath: join(fixture.home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'json', serverContainer: 'mcpServers' },
    { id: 'vscode', configPath: join(guiRoot, 'Code', 'User', 'mcp.json'), format: 'jsonc', serverContainer: 'servers' },
    { id: 'cline', configPath: join(guiRoot, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), format: 'json', serverContainer: 'mcpServers' },
    { id: 'codex-cli', configPath: join(fixture.home, '.codex', 'config.toml'), format: 'toml', serverContainer: 'mcp_servers' },
  ] as const;
  for (const spec of specs) {
    mkdirSync(dirname(spec.configPath), { recursive: true });
    const body = { [spec.serverContainer]: { dkg: { command: 'dkg' }, other: { command: 'keep' } } };
    writeFileSync(spec.configPath, spec.format === 'toml' ? TOML.stringify(body) : JSON.stringify(body));
  }
  return specs;
}

it.each(['darwin', 'linux', 'win32'])('detects every native client with its stable ID and explicit config shape on %s', async (selectedPlatform) => {
  const expected = seedNativeClients(selectedPlatform);
  const { detectClients } = await import('../src/mcp-client-registry.js');
  const actual = detectClients().map(({ id, location, configPath, format, serverContainer }) => ({ id, location, configPath, format, serverContainer }));
  expect(actual).toEqual(expected.map((spec) => ({ ...spec, location: 'native' })));
});

it.each(['cursor', 'claude-code', 'claude-desktop', 'windsurf', 'vscode', 'cline', 'codex-cli'])(
  'routes the real --client %s selector to its native registration only', async (id) => {
    const expected = seedNativeClients('darwin');
    const before = expected.map((spec) => readFileSync(spec.configPath, 'utf8'));
    await run('--yes', '--client', id);
    expect(process.exitCode).toBeUndefined();
    expected.forEach((spec, index) => {
      const raw = readFileSync(spec.configPath, 'utf8');
      if (spec.id !== id) {
        expect(raw).toBe(before[index]);
      } else {
        const body = spec.format === 'toml' ? TOML.parse(raw) : JSON.parse(raw);
        expect(body[spec.serverContainer]).toEqual({ other: { command: 'keep' } });
      }
    });
  },
);

it.each(['cursor', 'claude-desktop', 'windsurf', 'vscode', 'cline'])(
  'detects and selects Windows-side %s without changing its native peer', async (id) => {
    seedNativeClients('linux');
    vi.stubEnv('WSL_DISTRO_NAME', 'Fixture');
    const windowsHome = join(fixture.home, 'windows-user');
    const appData = join(windowsHome, 'AppData', 'Roaming');
    const expected = [
      { id: 'cursor', configPath: join(windowsHome, '.cursor', 'mcp.json'), serverContainer: 'mcpServers' },
      { id: 'claude-desktop', configPath: join(appData, 'Claude', 'claude_desktop_config.json'), serverContainer: 'mcpServers' },
      { id: 'windsurf', configPath: join(windowsHome, '.codeium', 'windsurf', 'mcp_config.json'), serverContainer: 'mcpServers' },
      { id: 'vscode', configPath: join(appData, 'Code', 'User', 'mcp.json'), serverContainer: 'servers' },
      { id: 'cline', configPath: join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), serverContainer: 'mcpServers' },
    ];
    for (const spec of expected) {
      mkdirSync(dirname(spec.configPath), { recursive: true });
      writeFileSync(spec.configPath, JSON.stringify({ [spec.serverContainer]: { dkg: { command: 'dkg' }, other: { command: 'keep' } } }));
    }
    const { detectClients } = await import('../src/mcp-client-registry.js');
    const { mcpUninstallAction } = await import('../src/mcp-uninstall.js');
    const resolver = (name: string) => name === 'USERPROFILE' ? windowsHome : appData;
    const targets = detectClients(resolver);
    expect(targets.filter((target) => target.location === 'windows-wsl')
      .map(({ id, location, configPath, format, serverContainer }) => ({ id, location, configPath, format, serverContainer })))
      .toEqual(expected.map((spec) => ({ ...spec, location: 'windows-wsl', format: spec.id === 'vscode' ? 'jsonc' : 'json' })));
    expect(targets).toHaveLength(12);
    const before = targets.map((target) => readFileSync(target.configPath, 'utf8'));
    await mcpUninstallAction({ yes: true, client: `${id}:windows-wsl` }, { detectClients: () => detectClients(resolver), log: () => {} });
    targets.forEach((target, index) => {
      const raw = readFileSync(target.configPath, 'utf8');
      if (target.id === id && target.location === 'windows-wsl') {
        expect(JSON.parse(raw)[target.serverContainer]).toEqual({ other: { command: 'keep' } });
      } else {
        expect(raw).toBe(before[index]);
      }
    });
  },
);

it.each(['cursor:native', 'cursor:windows-wsl', 'cursor', undefined])(
  'preserves overlapping native/WSL identities for selector %s and writes each path once', async (client) => {
    fixture.platform = 'linux';
    vi.stubEnv('WSL_DISTRO_NAME', 'Fixture');
    const { detectClients } = await import('../src/mcp-client-registry.js');
    const { mcpUninstallAction } = await import('../src/mcp-uninstall.js');
    // A WSL shell may use its Windows profile as HOME. Both real resolver
    // candidates then describe the same file, but retain different selectors.
    const resolver = (name: string) => name === 'USERPROFILE' ? fixture.home : null;
    expect(detectClients(resolver).filter((target) => target.id === 'cursor'))
      .toMatchObject([
        { location: 'native', configPath: cursor },
        { location: 'windows-wsl', configPath: cursor },
      ]);
    const messages: string[] = [];
    await mcpUninstallAction({ yes: true, client }, {
      detectClients: () => detectClients(resolver),
      log: (message) => messages.push(message),
    });
    expect(JSON.parse(readFileSync(cursor, 'utf8'))).toEqual({ mcpServers: { other: { command: 'keep' } } });
    expect(messages.filter((message) => message.startsWith('Found DKG MCP: Cursor'))).toHaveLength(1);
    expect(messages.filter((message) => message.startsWith('Removed DKG MCP from Cursor'))).toHaveLength(1);
    expect(messages.some((message) => message.startsWith('Already unregistered:'))).toBe(false);
  },
);
