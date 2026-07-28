import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readRegisteredServerKeys, type ClientTarget } from '../src/mcp-setup.js';

// `dkg integration installed` reads MCP client configs through this helper to
// decide whether an integration is wired into a client. The detectInstalled
// tests inject a stub for row-mapping, so the real parsing behaviour — format
// dispatch, alternate containers, and error swallowing — has to be exercised
// here against genuine files, or nothing covers it.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dkg-mcp-keys-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function target(
  filename: string,
  body: string,
  extra: Partial<ClientTarget> = {},
): Promise<ClientTarget> {
  const configPath = join(dir, filename);
  await writeFile(configPath, body, 'utf8');
  return { name: 'Test', configPath, displayPath: configPath, ...extra };
}

describe('readRegisteredServerKeys', () => {
  it('reads the default mcpServers container', async () => {
    const t = await target(
      'cursor.json',
      JSON.stringify({ mcpServers: { dkg: {}, 'buzz-dkg': {}, other: {} } }),
    );
    expect(readRegisteredServerKeys(t).sort()).toEqual(['buzz-dkg', 'dkg', 'other']);
  });

  // VSCode + Copilot Chat uses `servers.<name>` rather than `mcpServers.<name>`.
  // A detector hardcoding `mcpServers` would silently report nothing here.
  it('honours a non-default entryPath container', async () => {
    const t = await target('vscode.json', JSON.stringify({ servers: { dkg: {}, mine: {} } }), {
      entryPath: 'servers.dkg',
    });
    expect(readRegisteredServerKeys(t).sort()).toEqual(['dkg', 'mine']);
  });

  // Codex CLI keeps MCP servers in TOML under `mcp_servers`.
  it('reads a TOML config with its own container', async () => {
    const t = await target('codex.toml', '[mcp_servers.dkg]\ncommand = "x"\n\n[mcp_servers.mine]\ncommand = "y"\n', {
      format: 'toml',
      entryPath: 'mcp_servers.dkg',
    });
    expect(readRegisteredServerKeys(t).sort()).toEqual(['dkg', 'mine']);
  });

  it('returns [] for a malformed config rather than throwing', async () => {
    const t = await target('broken.json', '{ this is not json');
    expect(readRegisteredServerKeys(t)).toEqual([]);
  });

  it('returns [] when the config file does not exist', async () => {
    const t: ClientTarget = {
      name: 'Absent',
      configPath: join(dir, 'nope.json'),
      displayPath: 'nope.json',
    };
    expect(readRegisteredServerKeys(t)).toEqual([]);
  });

  it('returns [] when the container is missing or not an object', async () => {
    const missing = await target('a.json', JSON.stringify({ somethingElse: {} }));
    expect(readRegisteredServerKeys(missing)).toEqual([]);

    const scalar = await target('b.json', JSON.stringify({ mcpServers: 'nope' }));
    expect(readRegisteredServerKeys(scalar)).toEqual([]);
  });

  it('returns [] for an empty container without conflating it with a parse error', async () => {
    const t = await target('empty.json', JSON.stringify({ mcpServers: {} }));
    expect(readRegisteredServerKeys(t)).toEqual([]);
  });
});
