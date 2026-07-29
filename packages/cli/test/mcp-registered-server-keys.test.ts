import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readRegisteredServerKeys,
  type ClientTarget,
  type ServerKeyProbe,
} from '../src/mcp-setup.js';

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

/** Fails loudly with the probe's own reason instead of a bare undefined. */
function keysOf(probe: ServerKeyProbe): string[] {
  if (!probe.ok) throw new Error(`expected a readable config, got: ${probe.reason}`);
  return Object.keys(probe.servers).sort();
}

/** A minimal launchable block — anything without `command` is not a registration. */
const blk = (command = 'npx', args: string[] = []) => ({ command, args });

describe('readRegisteredServerKeys', () => {
  it('reads the default mcpServers container', async () => {
    const t = await target(
      'cursor.json',
      JSON.stringify({ mcpServers: { dkg: blk(), 'buzz-dkg': blk(), other: blk() } }),
    );
    expect(keysOf(readRegisteredServerKeys(t))).toEqual(['buzz-dkg', 'dkg', 'other']);
  });

  // VSCode + Copilot Chat uses `servers.<name>` rather than `mcpServers.<name>`.
  // A detector hardcoding `mcpServers` would silently report nothing here.
  it('honours a non-default entryPath container', async () => {
    const t = await target('vscode.json', JSON.stringify({ servers: { dkg: blk(), mine: blk() } }), {
      entryPath: 'servers.dkg',
    });
    expect(keysOf(readRegisteredServerKeys(t))).toEqual(['dkg', 'mine']);
  });

  // Codex CLI keeps MCP servers in TOML under `mcp_servers`.
  it('reads a TOML config with its own container', async () => {
    const t = await target('codex.toml', '[mcp_servers.dkg]\ncommand = "x"\n\n[mcp_servers.mine]\ncommand = "y"\n', {
      format: 'toml',
      entryPath: 'mcp_servers.dkg',
    });
    expect(keysOf(readRegisteredServerKeys(t))).toEqual(['dkg', 'mine']);
  });

  // The cases below are the point of the probe type. "We read it, nothing is
  // registered" and "we could not read it" must not be the same value, or a
  // caller reporting install state turns an unreadable config into a confident
  // "not installed". Each pair is asserted in BOTH directions so a regression
  // that collapses them fails here rather than surfacing as a false negative.

  it('reports a config it cannot parse as a FAILED probe', async () => {
    const t = await target('broken.json', '{ this is not json');
    const probe = readRegisteredServerKeys(t);
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('could not read');
  });

  it('reports a malformed server container as a FAILED probe', async () => {
    // Readable JSON, but the container we need is a scalar — we cannot tell
    // what is registered, so this is not evidence of absence.
    const t = await target('b.json', JSON.stringify({ mcpServers: 'nope' }));
    const probe = readRegisteredServerKeys(t);
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toContain('malformed');
  });

  it('treats an absent config file as a SUCCESSFUL probe with no servers', async () => {
    // Nothing to read is a real answer: this client registered nothing.
    const t: ClientTarget = {
      name: 'Absent',
      configPath: join(dir, 'nope.json'),
      displayPath: 'nope.json',
    };
    expect(readRegisteredServerKeys(t)).toEqual({ ok: true, servers: {} });
  });

  it('treats a missing container as a SUCCESSFUL probe with no servers', async () => {
    const t = await target('a.json', JSON.stringify({ somethingElse: {} }));
    expect(readRegisteredServerKeys(t)).toEqual({ ok: true, servers: {} });
  });

  // The inverse false report: a key whose value cannot launch anything is not
  // a registration. `classify()` in the same module already treats `{ dkg: null }`
  // as not-registered, so counting it here would have made `installed` claim an
  // integration was present that no client could start.
  it('ignores keys whose value is not a usable server block', async () => {
    const t = await target(
      'mixed.json',
      JSON.stringify({
        mcpServers: {
          good: { command: 'npx', args: ['-y', 'p'] },
          nulled: null,
          scalar: 'npx -y p',
          listy: [],
          // An object with no `command` cannot launch either, so it is not a
          // registration — review flagged `{}` under a slug being counted.
          noCommand: { env: { A: '1' } },
        },
      }),
    );
    // The readable-config status is unchanged — this is a filter, not a failure.
    expect(keysOf(readRegisteredServerKeys(t))).toEqual(['good']);
  });

  it('distinguishes an empty container from a parse error', async () => {
    const empty = await target('empty.json', JSON.stringify({ mcpServers: {} }));
    const broken = await target('broken2.json', '{ nope');
    // Same "no keys" outcome, DIFFERENT probe status — the previous version of
    // this test compared both to [] and so could not have caught a regression
    // that conflated them.
    expect(readRegisteredServerKeys(empty)).toEqual({ ok: true, servers: {} });
    expect(readRegisteredServerKeys(broken).ok).toBe(false);
  });
});
