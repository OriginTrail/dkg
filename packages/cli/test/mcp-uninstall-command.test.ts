import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ home: '', platform: 'darwin' }));
// Isolate the actual client-path resolver without mocking detection, config writes,
// the uninstall action, or Commander. The process's real home stays untouched.
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
