import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { inspectRegistration, removeRegistration } from '../src/mcp-client-config.js';
import { type ClientTarget, type McpClientId } from '../src/mcp-client-registry.js';
import { dkgDir, configPath } from '../src/config.js';
import { dkgAuthTokenPath } from '@origintrail-official/dkg-core';
import { mcpUninstallAction } from '../src/mcp-uninstall.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dkg-mcp-uninstall-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function target(name: string, container = 'mcpServers', format: 'json' | 'toml' = 'json'): ClientTarget {
  const configPath = join(root, `${name}.${format}`);
  const id = ({ Cursor: 'cursor', 'Claude Code': 'claude-code', 'Claude Desktop': 'claude-desktop', Windsurf: 'windsurf', VSCode: 'vscode', Cline: 'cline', 'Codex CLI': 'codex-cli' } as Record<string, McpClientId>)[name] ?? 'cursor';
  return { id, location: 'native', name, configPath, displayPath: configPath, entryPath: `${container}.dkg`, format };
}
function seed(client: ClientTarget, onlyDkg = false): void {
  const container = client.entryPath!.split('.')[0];
  const body = { setting: 'keep', [container]: {
    dkg: { command: 'dkg', args: ['mcp', 'serve'] },
    ...(onlyDkg ? {} : { other: { command: 'other-server', custom: 'keep' } }),
  } };
  writeFileSync(client.configPath, client.format === 'toml' ? TOML.stringify(body) : JSON.stringify(body));
}
function read(client: ClientTarget): Record<string, any> {
  const raw = readFileSync(client.configPath, 'utf8');
  return client.format === 'toml' ? TOML.parse(raw) : JSON.parse(raw);
}

describe('MCP registration removal', () => {
  it.each([
    ['Cursor', 'mcpServers', 'json'], ['Claude Code', 'mcpServers', 'json'],
    ['Claude Desktop', 'mcpServers', 'json'], ['Windsurf', 'mcpServers', 'json'],
    ['VSCode', 'servers', 'json'], ['Cline', 'mcpServers', 'json'],
    ['Codex CLI', 'mcp_servers', 'toml'],
  ] as const)('removes only DKG from %s', (name, container, format) => {
    const client = target(name, container, format);
    seed(client);
    expect(removeRegistration(client)).toBe(true);
    expect(read(client)).toEqual({ setting: 'keep', [container]: { other: { command: 'other-server', custom: 'keep' } } });
    const bytes = readFileSync(client.configPath, 'utf8');
    expect(removeRegistration(client)).toBe(false);
    expect(readFileSync(client.configPath, 'utf8')).toBe(bytes);
  });

  it.each([['mcpServers', 'json'], ['servers', 'json'], ['mcp_servers', 'toml']] as const)(
    'preserves the empty %s container', (container, format) => {
      const client = target('only', container, format);
      seed(client, true);
      expect(removeRegistration(client)).toBe(true);
      expect(read(client)).toEqual({ setting: 'keep', [container]: {} });
    },
  );

  it('preserves TOML comments and sibling tables while removing DKG subtables', () => {
    const client = target('Codex CLI', 'mcp_servers', 'toml');
    writeFileSync(client.configPath, '# preferences\nmodel = "example"\n\n[mcp_servers.dkg]\ncommand = "dkg"\n[mcp_servers.dkg.env]\nDKG_HOME = "/fixture"\n\n# unrelated server\n[mcp_servers.other]\ncommand = "other"\n');
    expect(removeRegistration(client)).toBe(true);
    const output = readFileSync(client.configPath, 'utf8');
    expect(output).toContain('# preferences\nmodel = "example"');
    expect(output).toContain('# unrelated server\n[mcp_servers.other]\ncommand = "other"');
    expect(read(client)).toEqual({ model: 'example', mcp_servers: { other: { command: 'other' } } });
  });

  it('handles inline TOML without deleting sibling settings', () => {
    const client = target('Codex CLI', 'mcp_servers', 'toml');
    writeFileSync(client.configPath, 'setting = "keep"\nmcp_servers = { dkg = { command = "dkg" }, other = { command = "other" } }\n');
    expect(removeRegistration(client)).toBe(true);
    expect(read(client)).toEqual({ setting: 'keep', mcp_servers: { other: { command: 'other' } } });
  });

  it('does not create a missing config', () => {
    const client = target('absent');
    expect(removeRegistration(client)).toBe(false);
    expect(existsSync(client.configPath)).toBe(false);
  });

  it.each(['{bad', '{"mcpServers":[]}', '{"mcpServers":null}'])(
    'leaves malformed configuration untouched: %s', (raw) => {
      const client = target('malformed');
      writeFileSync(client.configPath, raw);
      expect(() => removeRegistration(client)).toThrow();
      expect(readFileSync(client.configPath, 'utf8')).toBe(raw);
    },
  );

  it('removes a stale DKG entry even when it cannot launch', () => {
    const client = target('stale');
    writeFileSync(client.configPath, '{"mcpServers":{"dkg":null,"other":{"url":"https://example.org/mcp"}}}');
    expect(removeRegistration(client)).toBe(true);
    expect(read(client).mcpServers).toEqual({ other: { url: 'https://example.org/mcp' } });
  });
});

describe('mcpUninstallAction', () => {
  function fixture() {
    const clients = [target('Cursor'), target('Claude Code'), target('VSCode', 'servers')];
    clients.forEach((client) => seed(client));
    const messages: string[] = [];
    return { clients, messages, deps: { detectClients: () => clients, log: (message: string) => { messages.push(message); } } };
  }

  it('--yes removes every registration without prompting, then reruns as a no-op', async () => {
    const { clients, messages, deps } = fixture();
    await mcpUninstallAction({ yes: true }, deps);
    expect(clients.every((client) => !inspectRegistration(client))).toBe(true);
    await mcpUninstallAction({ yes: true }, deps);
    expect(messages.at(-1)).toBe('No DKG MCP registrations found.');
  });

  it('requires --yes for a non-interactive uninstall', async () => {
    const { clients, deps } = fixture();
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(mcpUninstallAction({}, deps)).rejects.toThrow('requires --yes');
    expect(clients.every((client) => inspectRegistration(client))).toBe(true);
  });

  it('--client selects one canonical client name', async () => {
    const { clients, deps } = fixture();
    const untouched = readFileSync(clients[0].configPath, 'utf8');
    await mcpUninstallAction({ yes: true, client: 'claude-code' }, deps);
    expect(inspectRegistration(clients[1])).toBe(false);
    expect(readFileSync(clients[0].configPath, 'utf8')).toBe(untouched);
    expect(inspectRegistration(clients[2])).toBe(true);
  });

  it('--dry-run reports without prompting, changing bytes, or touching node files', async () => {
    const { clients, messages, deps } = fixture();
    const originals = clients.map((client) => readFileSync(client.configPath, 'utf8'));
    vi.stubEnv('DKG_HOME', root);
    expect(dkgDir()).toBe(root);
    const nodeConfig = configPath();
    const authToken = dkgAuthTokenPath(dkgDir());
    writeFileSync(nodeConfig, 'sentinel-config'); writeFileSync(authToken, 'sentinel-token');
    await mcpUninstallAction({ dryRun: true }, {
      ...deps, confirmTargets: async () => { throw new Error('dry-run must not prompt'); },
    });
    expect(clients.map((client) => readFileSync(client.configPath, 'utf8'))).toEqual(originals);
    expect(messages.every((message) => message.startsWith('Would remove'))).toBe(true);
    expect(readFileSync(nodeConfig, 'utf8')).toBe('sentinel-config');
    expect(readFileSync(authToken, 'utf8')).toBe('sentinel-token');
  });

  it('preserves declined clients and continues with later confirmations', async () => {
    const { clients, deps } = fixture();
    await mcpUninstallAction({}, { ...deps, confirmTargets: async (planned) => planned.filter((_target, index) => index !== 1) });
    expect(clients.map((client) => inspectRegistration(client))).toEqual([false, true, false]);
  });

  it('reports no clients as a successful no-op', async () => {
    const messages: string[] = [];
    await mcpUninstallAction({}, { detectClients: () => [], log: (message) => { messages.push(message); } });
    expect(messages).toEqual(['No DKG MCP registrations found.']);
  });

  it('rejects an unknown client without modifying any registration', async () => {
    const { clients, deps } = fixture();
    await expect(mcpUninstallAction({ yes: true, client: 'typo' }, deps)).rejects.toThrow('Unsupported MCP client selector');
    expect(clients.every((client) => inspectRegistration(client))).toBe(true);
  });

  it('reports unreadable configuration and still processes other confirmed clients', async () => {
    const { clients, deps } = fixture();
    writeFileSync(clients[0].configPath, '{bad');
    await expect(mcpUninstallAction({ yes: true }, deps)).rejects.toThrow('Could not remove 1');
    expect(readFileSync(clients[0].configPath, 'utf8')).toBe('{bad');
    expect(clients.slice(1).every((client) => !inspectRegistration(client))).toBe(true);
  });
});


describe('stable client selectors', () => {
  it('selects a Windows-side-only WSL target with the canonical client ID', async () => {
    const client = { ...target('Cursor'), name: 'Cursor (Windows-side via WSL)', location: 'windows-wsl' as const };
    seed(client);
    await mcpUninstallAction({ yes: true, client: 'cursor' }, { detectClients: () => [client], log: () => {} });
    expect(inspectRegistration(client)).toBe(false);
  });

  it.each(['cursor', 'cursor:windows-wsl', 'cursor:native'])('selects native/WSL variants explicitly with %s', async (selector) => {
    const native = target('Cursor');
    const windows = { ...target('windows'), name: 'A renamed Windows display label', location: 'windows-wsl' as const };
    seed(native); seed(windows);
    await mcpUninstallAction({ yes: true, client: selector }, { detectClients: () => [native, windows], log: () => {} });
    expect(inspectRegistration(native)).toBe(selector === 'cursor:windows-wsl');
    expect(inspectRegistration(windows)).toBe(selector === 'cursor:native');
  });

  it('rejects unsupported selectors even when no clients are detected', async () => {
    const detect = vi.fn(() => []);
    await expect(mcpUninstallAction({ yes: true, client: 'typo' }, { detectClients: detect })).rejects.toThrow('Unsupported MCP client selector');
    expect(detect).not.toHaveBeenCalled();
  });
});
