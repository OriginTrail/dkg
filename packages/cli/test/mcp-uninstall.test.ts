import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { parse as parseJsonc } from 'jsonc-parser';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { inspectRegistration, removeRegistration, readRegistration, classifyRegistration, writeRegistration } from '../src/mcp-client-config.js';
import { writeMcpConfigAtomic } from '../src/mcp-config-file.js';
import { type ClientTarget } from '../src/mcp-client-registry.js';
import { dkgDir, configPath } from '../src/config.js';
import { dkgAuthTokenPath } from '@origintrail-official/dkg-core';
import { mcpUninstallAction } from '../src/mcp-uninstall.js';
import { createInterface } from 'node:readline/promises';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

// Selector cases exercise routing with synthetic WSL targets on any host. Native
// Windows/WSL metadata is verified separately by the mandatory OS fixture.
vi.mock('../src/mcp-config-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/mcp-config-file.js')>();
  return { ...actual, writeMcpConfigAtomic: vi.fn((path: string, content: string) => actual.writeMcpConfigAtomic(path, content)) };
});

vi.mock('node:readline/promises', () => ({ createInterface: vi.fn() }));

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dkg-mcp-uninstall-')); });
afterEach(() => { vi.restoreAllMocks(); vi.mocked(fs.renameSync).mockReset(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

function target(name: string, container: 'mcpServers' | 'servers' | 'mcp_servers' = 'mcpServers', format: 'json' | 'jsonc' | 'toml' = 'json'): ClientTarget {
  const configPath = join(root, `${name}.${format}`);
  const paths = { name, configPath, displayPath: configPath, location: 'native' as const };
  if (format === 'toml') return { ...paths, id: 'codex-cli', format: 'toml', serverContainer: 'mcp_servers' };
  if (container === 'servers') return { ...paths, id: 'vscode', format: 'jsonc', serverContainer: 'servers' };
  const id = ({ 'Claude Code': 'claude-code', 'Claude Desktop': 'claude-desktop', Windsurf: 'windsurf', Cline: 'cline' } as const)[name as 'Claude Code' | 'Claude Desktop' | 'Windsurf' | 'Cline'] ?? 'cursor';
  return { ...paths, id, format: 'json', serverContainer: 'mcpServers' };
}
function seed(client: ClientTarget, onlyDkg = false): void {
  const container = client.serverContainer;
  const body = { setting: 'keep', [container]: {
    dkg: { command: 'dkg', args: ['mcp', 'serve'] },
    ...(onlyDkg ? {} : { other: { command: 'other-server', custom: 'keep' } }),
  } };
  writeFileSync(client.configPath, client.format === 'toml' ? TOML.stringify(body) : JSON.stringify(body));
}
function read(client: ClientTarget): Record<string, any> {
  const raw = readFileSync(client.configPath, 'utf8');
  return client.format === 'toml' ? TOML.parse(raw) : client.format === 'jsonc' ? parseJsonc(raw) : JSON.parse(raw);
}

describe('MCP registration removal', () => {
  it('refuses to replace a dangling config symlink during a write', () => {
    const client = target('dangling');
    fs.symlinkSync('missing-target.json', client.configPath);
    const entries = fs.readdirSync(root);
    expect(() => writeMcpConfigAtomic(client.configPath, '{}\n')).toThrow();
    expect(fs.lstatSync(client.configPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(client.configPath)).toBe('missing-target.json');
    expect(fs.readdirSync(root)).toEqual(entries);
  });

  it('updates a symlink target while retaining the config link and leaving no temporary file', () => {
    const client = target('linked');
    const real = target('real');
    seed(real);
    fs.symlinkSync(real.configPath, client.configPath);
    const entries = fs.readdirSync(root);
    expect(removeRegistration(client)).toBe(true);
    expect(fs.lstatSync(client.configPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(client.configPath)).toBe(real.configPath);
    expect(read(real).mcpServers).toEqual({ other: { command: 'other-server', custom: 'keep' } });
    expect(fs.readdirSync(root)).toEqual(entries);
  });

  it.each([false, true])('preserves destination ownership across an atomic edit (symlink=%s)', (symlink) => {
    const real = target('owner-real');
    seed(real);
    const original = fs.statSync(real.configPath);
    if (process.platform !== 'win32') {
      const alternateGroup = (process.getgroups?.() ?? []).find((gid) => gid !== original.gid);
      if (alternateGroup !== undefined) fs.chownSync(real.configPath, original.uid, alternateGroup);
    }
    const before = fs.statSync(real.configPath);
    const path = symlink ? join(root, 'owner-link.json') : real.configPath;
    if (symlink) fs.symlinkSync(real.configPath, path);
    const entries = fs.readdirSync(root);
    writeMcpConfigAtomic(path, '{}\n');
    const after = fs.statSync(real.configPath);
    expect({ uid: after.uid, gid: after.gid, mode: after.mode }).toEqual({ uid: before.uid, gid: before.gid, mode: before.mode });
    expect(readFileSync(real.configPath, 'utf8')).toBe('{}\n');
    if (symlink) expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(root)).toEqual(entries);
  });

  it('leaves the original and symlink intact when ownership preservation fails', () => {
    if (process.platform === 'win32') return;
    const client = target('ownership-failure');
    seed(client);
    const link = join(root, 'ownership-link.json');
    fs.symlinkSync(client.configPath, link);
    const raw = readFileSync(client.configPath, 'utf8');
    const files = fs.readdirSync(root);
    const actualFstat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce((fd) => {
      const copied = actualFstat(fd);
      copied.uid += 1;
      return copied;
    });
    vi.spyOn(fs, 'fchownSync').mockImplementationOnce(() => { throw new Error('ownership preservation denied'); });
    expect(() => writeMcpConfigAtomic(link, '{}\n')).toThrow('ownership preservation denied');
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(readFileSync(client.configPath, 'utf8')).toBe(raw);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(root)).toEqual(files);
  });


  it.each([
    '"dkg":{"command":"dkg"},"other":{"clientId":9007199254740993}',
    '"other":{"clientId":9007199254740993},"dkg":{"command":"dkg"}',
    '"dkg":{"command":"dkg"}',
  ])('retains unrelated numeric lexemes when removing strict JSON registration: %s', (servers) => {
    const client = target('lossless');
    const raw = `{\n "clientId":9007199254740993, "ratio":1.2300e+06, "mcpServers":{${servers}}\n}\n`;
    writeFileSync(client.configPath, raw);
    expect(removeRegistration(client)).toBe(true);
    const result = readFileSync(client.configPath, 'utf8');
    expect(result).toContain('"clientId":9007199254740993');
    expect(result).toContain('"ratio":1.2300e+06');
    expect(JSON.parse(result).mcpServers).not.toHaveProperty('dkg');
    if (servers.includes('"other"')) expect(result).toContain('"other":{"clientId":9007199254740993}');
  });

  it('removes DKG from VS Code JSONC while preserving comments, trailing commas and siblings', async () => {
    const client = target('VSCode', 'servers', 'jsonc');
    const raw = '{\n  // operator preference\n  "setting": "keep",\n  "servers": {\n    "dkg": { "command": "dkg" },\n    // unrelated server\n    "other": { "command": "other" },\n  },\n}\n';
    writeFileSync(client.configPath, raw);
    await mcpUninstallAction({ yes: true, client: 'vscode' }, { detectClients: () => [client], log: () => {} });
    const output = readFileSync(client.configPath, 'utf8');
    expect(read(client)).toEqual({ setting: 'keep', servers: { other: { command: 'other' } } });
    expect(output).toContain('// operator preference');
    expect(output).toContain('// unrelated server');
    expect(output).toContain('"other": { "command": "other" },');
  });

  it.each([
    '{ "servers": { "other": { "command": "other" }, /* keep */ "dkg": {} } }',
    '{ "servers": { /* keep */ "dkg": {}, } }',
  ])('preserves JSONC comments when removing a last or only registration', (raw) => {
    const client = target('VSCode', 'servers', 'jsonc');
    writeFileSync(client.configPath, raw);
    const expected = parseJsonc(raw);
    delete expected.servers.dkg;
    expect(removeRegistration(client)).toBe(true);
    expect(read(client)).toEqual(expected);
    expect(readFileSync(client.configPath, 'utf8')).toContain('/* keep */');
  });

  it.each(['json', 'jsonc', 'toml'] as const)('preserves the original %s config and cleans temporary files when replacement fails', (format) => {
    const client = target('atomic', format === 'toml' ? 'mcp_servers' : format === 'jsonc' ? 'servers' : 'mcpServers', format);
    seed(client);
    const original = readFileSync(client.configPath, 'utf8');
    const files = fs.readdirSync(root);
    const rename = vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('replacement failed'); });
    expect(() => removeRegistration(client)).toThrow('replacement failed');
    expect(rename).toHaveBeenCalledOnce();
    expect(readFileSync(client.configPath, 'utf8')).toBe(original);
    expect(fs.readdirSync(root)).toEqual(files);
  });

  it('preserves existing config permissions after successful replacement', () => {
    const client = target('permissions');
    seed(client);
    fs.chmodSync(client.configPath, 0o640);
    expect(removeRegistration(client)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(client.configPath).mode & 0o777).toBe(0o640);
  });

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

  it('preserves escaped multiline TOML content that resembles an owned table', () => {
    const client = target('Codex CLI', 'mcp_servers', 'toml');
    const prefix = String.raw`# keep this comment
note = """
Escaped triple quote: \"""
[mcp_servers.dkg]
this_is_string_content = true
"""

`;
    const sibling = '[mcp_servers.other]\ncommand = "other"\n';
    const raw = prefix + '[mcp_servers.dkg]\ncommand = "dkg"\n\n' + sibling;
    const expected = TOML.parse(raw);
    delete (expected.mcp_servers as TOML.JsonMap).dkg;
    writeFileSync(client.configPath, raw);
    expect(removeRegistration(client)).toBe(true);
    const output = readFileSync(client.configPath, 'utf8');
    expect(TOML.parse(output)).toEqual(expected);
    expect(output.startsWith(prefix)).toBe(true);
    expect(output.endsWith(sibling)).toBe(true);
    expect(removeRegistration(client)).toBe(false);
    expect(readFileSync(client.configPath, 'utf8')).toBe(output);
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

  it('preserves explicit readline declines and continues with later confirmations', async () => {
    const { clients, deps } = fixture();
    const originals = clients.map((client) => readFileSync(client.configPath, 'utf8'));
    const question = vi.fn().mockResolvedValueOnce('n').mockResolvedValueOnce(' NO ').mockResolvedValueOnce('yes');
    const close = vi.fn();
    vi.mocked(createInterface).mockReturnValue({ question, close } as unknown as ReturnType<typeof createInterface>);
    const streams = [process.stdin, process.stdout];
    const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
    streams.forEach((stream) => Object.defineProperty(stream, 'isTTY', { configurable: true, value: true }));
    try {
      await mcpUninstallAction({}, deps);
      expect(question).toHaveBeenCalledTimes(3);
      expect(close).toHaveBeenCalledTimes(1);
      expect(clients.map((client) => inspectRegistration(client))).toEqual([true, true, false]);
      expect(clients.slice(0, 2).map((client) => readFileSync(client.configPath, 'utf8'))).toEqual(originals.slice(0, 2));
    } finally {
      streams.forEach((stream, index) => {
        const descriptor = descriptors[index];
        if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
        else Reflect.deleteProperty(stream, 'isTTY');
      });
      vi.mocked(createInterface).mockReset();
    }
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

  it('continues processing confirmed clients after a config fails during removal', async () => {
    const { clients, deps } = fixture();
    const original = readFileSync(clients[0].configPath, 'utf8');
    await expect(mcpUninstallAction({ yes: true }, {
      ...deps,
      confirmTargets: async (planned) => {
        expect(planned).toHaveLength(clients.length);
        vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error('replacement failed'); });
        return planned;
      },
    })).rejects.toThrow('Could not remove 1');
    expect(readFileSync(clients[0].configPath, 'utf8')).toBe(original);
    expect(clients.slice(1).every((client) => !inspectRegistration(client))).toBe(true);
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
    const template = target('Cursor');
    if (template.id !== 'cursor') throw new Error('Expected a Cursor fixture');
    const client = { ...template, name: 'Cursor (Windows-side via WSL)', location: 'windows-wsl' as const };
    seed(client);
    await mcpUninstallAction({ yes: true, client: 'cursor' }, { detectClients: () => [client], log: () => {} });
    expect(inspectRegistration(client)).toBe(false);
    expect(writeMcpConfigAtomic).toHaveBeenCalledWith(client.configPath, expect.any(String), 'windows-wsl');
  });

  it.each(['cursor', 'cursor:windows-wsl', 'cursor:native'])('selects native/WSL variants explicitly with %s', async (selector) => {
    const native = target('Cursor');
    const template = target('windows');
    if (template.id !== 'cursor') throw new Error('Expected a Cursor fixture');
    const windows = { ...template, name: 'A renamed Windows display label', location: 'windows-wsl' as const };
    seed(native); seed(windows);
    await mcpUninstallAction({ yes: true, client: selector }, { detectClients: () => [native, windows], log: () => {} });
    expect(inspectRegistration(native)).toBe(selector === 'cursor:windows-wsl');
    expect(inspectRegistration(windows)).toBe(selector === 'cursor:native');
  });

  it.each(['typo', 'codex-cli:windows-wsl', 'claude-code:windows-wsl'])('rejects unsupported selector %s before detection', async selector => {
    const detect = vi.fn(() => []);
    await expect(mcpUninstallAction({ yes: true, client: selector }, { detectClients: detect })).rejects.toThrow('Unsupported MCP client selector');
    expect(detect).not.toHaveBeenCalled();
  });
});


describe('typed owned-registration boundary', () => {
  const expected = { command: 'node', args: ['cli.js'], env: { DKG_HOME: '/dkg' } };
  it.each([
    { value: undefined, kind: 'absent', state: 'not-registered' },
    { value: null, kind: 'absent', state: 'not-registered' },
    { value: 'stale', kind: 'invalid', state: 'stale' },
    { value: [], kind: 'invalid', state: 'stale' },
    { value: {}, kind: 'entry', state: 'stale' },
    { value: { ...expected, command: 1 }, kind: 'invalid', state: 'stale' },
    { value: { ...expected, args: [1] }, kind: 'invalid', state: 'stale' },
    { value: { ...expected, env: [] }, kind: 'invalid', state: 'stale' },
    { value: { ...expected, env: { DKG_HOME: 1 } }, kind: 'invalid', state: 'stale' },
    { value: expected, kind: 'entry', state: 'registered' },
    { value: { ...expected, env: { ...expected.env, EXTRA: 'keep' } }, kind: 'entry', state: 'registered' },
  ])('classifies $kind/$state without exposing raw owned fields', ({ value, kind, state }) => {
    const client = target('Cursor');
    writeFileSync(client.configPath, JSON.stringify({ mcpServers: { dkg: value } }));
    const read = readRegistration(client);
    expect(read.kind).toBe(kind);
    expect(classifyRegistration(read, expected)).toBe(state);
  });

  it.each([{ value: ['array-entry'] }, { value: { command: 'old', env: ['array-env'], cwd: '/keep' } }])('does not merge array indices into owned registration records', ({ value }) => {
    const client = target('Cursor');
    writeFileSync(client.configPath, JSON.stringify({ mcpServers: { dkg: value } }));
    writeRegistration(client, expected);
    const entry = JSON.parse(readFileSync(client.configPath, 'utf8')).mcpServers.dkg;
    expect(entry).not.toHaveProperty('0');
    expect(entry.env).toEqual(expected.env);
    if (!Array.isArray(value)) expect(entry.cwd).toBe('/keep');
    expect(classifyRegistration(readRegistration(client), expected)).toBe('registered');
  });
});
