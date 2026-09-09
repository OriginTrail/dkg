import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import TOML from '@iarna/toml';
import { jsonDocumentAdapter, jsoncDocumentAdapter } from '../src/mcp-json-document.js';
import { tomlDocumentAdapter } from '../src/mcp-toml-document.js';
import { readRegisteredServerKeys, removeRegistration, writeRegistration } from '../src/mcp-client-config.js';
import { McpPhysicalConfig } from '../src/mcp-physical-config.js';
import type { DesiredRegistration, McpConfigDocumentAdapter, PersistedRegistration } from '../src/mcp-config-document.js';

const previous = { command: 'old', args: ['old'], cwd: '/keep', env: { DKG_HOME: '/old', KEEP: 'value' } };
const desired: DesiredRegistration = { command: 'node', args: ['cli.js', 'mcp', 'serve'], env: { DKG_HOME: '/new' } };
const merged: PersistedRegistration = { ...previous, ...desired, env: { ...previous.env, ...desired.env } };
const other = { command: 'other' };
const formats: {
  format: 'json' | 'jsonc' | 'toml';
  container: 'mcpServers' | 'servers' | 'mcp_servers';
  adapter: McpConfigDocumentAdapter;
  source: string;
}[] = [
  {
    format: 'json', container: 'mcpServers', adapter: jsonDocumentAdapter,
    source: JSON.stringify({ title: 'keep', mcpServers: { other, dkg: previous } }),
  },
  {
    format: 'jsonc', container: 'servers', adapter: jsoncDocumentAdapter,
    source: `// keep header\n{\n  "title": "keep",\n  "servers": {\n    // keep sibling\n    "other": { "command": "other" },\n    "dkg": ${JSON.stringify(previous)},\n  },\n}\n`,
  },
  {
    format: 'toml', container: 'mcp_servers', adapter: tomlDocumentAdapter,
    source: '# keep header\n' + TOML.stringify({ title: 'keep', mcp_servers: { other, dkg: previous } }),
  },
];

const directories: string[] = [];
function configFile(format: 'json' | 'jsonc' | 'toml', source: string): McpPhysicalConfig {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-mcp-document-'));
  directories.push(dir);
  const configPath = join(dir, `config.${format}`);
  writeFileSync(configPath, source);
  const paths = [{ configPath, displayPath: configPath }];
  if (format === 'toml') return new McpPhysicalConfig(realpathSync(configPath), { format, serverContainer: 'mcp_servers' }, paths);
  if (format === 'jsonc') return new McpPhysicalConfig(realpathSync(configPath), { format, serverContainer: 'servers' }, paths);
  return new McpPhysicalConfig(realpathSync(configPath), { format, serverContainer: 'mcpServers' }, paths);
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.each(formats)('$format document edit contract', ({ format, container, adapter, source }) => {
  it('derives upsert and removal from the edit alone', () => {
    const result = adapter.applyEdit(source, { kind: 'upsert', registration: merged }, container);
    expect(result.warning).toBeUndefined();
    expect(adapter.parse(result.content)).toEqual({ title: 'keep', [container]: { other, dkg: merged } });
    const removed = adapter.applyEdit(result.content, { kind: 'remove' }, container);
    expect(removed.warning).toBeUndefined();
    expect(adapter.parse(removed.content)).toEqual({ title: 'keep', [container]: { other } });
    if (format !== 'json') expect(removed.content).toContain('keep header');
    if (format === 'jsonc') expect(removed.content).toContain('    // keep sibling\n    "other": { "command": "other" },');
    if (format === 'toml') expect(removed.content).toContain('[mcp_servers.other]\ncommand = "other"');
  });

  it('creates an entry from an empty file without a pre-mutated body', () => {
    const result = adapter.applyEdit(' \n', { kind: 'upsert', registration: merged }, container);
    expect(adapter.parse(result.content)).toEqual({ [container]: { dkg: merged } });
  });

  it('leaves empty files and absent registrations unchanged on removal', () => {
    expect(adapter.applyEdit(' \n', { kind: 'remove' }, container)).toEqual({ content: ' \n' });
    const removed = adapter.applyEdit(source, { kind: 'remove' }, container);
    expect(adapter.applyEdit(removed.content, { kind: 'remove' }, container)).toEqual(removed);
  });

  it('rejects malformed containers at the edit boundary', () => {
    const body = { [container]: [] };
    const malformed = format === 'toml' ? TOML.stringify(body) : JSON.stringify(body);
    expect(() => adapter.applyEdit(malformed, { kind: 'upsert', registration: merged }, container)).toThrow(/container/);
    expect(() => adapter.applyEdit(malformed, { kind: 'remove' }, container)).toThrow(/container/);
  });

  it('merges extension fields and preserves unrelated entries through the coordinator', () => {
    const target = configFile(format, source);
    writeRegistration(target, desired);
    expect(adapter.parse(readFileSync(target.destination, 'utf8'))).toEqual({ title: 'keep', [container]: { other, dkg: merged } });
    expect(removeRegistration(target)).toBe(true);
    expect(adapter.parse(readFileSync(target.destination, 'utf8'))).toEqual({ title: 'keep', [container]: { other } });
    expect(removeRegistration(target)).toBe(false);
  });
});

describe.each(formats.filter(({ format }) => format !== 'toml'))('$format record root boundary', ({ format, adapter }) => {
  it.each(['[]', '[{"command":"keep"}]', 'null', '42', 'false', '"keep"'])('rejects %s without changing the file', root => {
    const source = format === 'jsonc' ? `// keep source\n${root}\n` : `${root}\n`;
    expect(() => adapter.parse(source)).toThrow(/object/i);
    const target = configFile(format, source);
    const dir = directories.at(-1)!;
    const entries = readdirSync(dir);
    expect(readRegisteredServerKeys(target).ok).toBe(false);
    expect(() => writeRegistration(target, desired)).toThrow(/not valid/);
    expect(() => removeRegistration(target)).toThrow(/not valid/);
    expect(readFileSync(target.destination, 'utf8')).toBe(source);
    expect(readdirSync(dir)).toEqual(entries);
  });

  it('preserves empty-file parsing', () => {
    expect(adapter.parse('')).toEqual({});
    expect(adapter.parse(' \n\t')).toEqual({});
  });
});
