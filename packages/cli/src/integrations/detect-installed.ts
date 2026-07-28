// Detects which registry integrations are present on this machine.
//
// Deliberately DERIVED rather than recorded. A ledger would say what we did;
// detection says what is true — it cannot go stale when a user upgrades a
// package by hand, deletes an MCP block, or installs on another machine. It is
// also the only honest option for `mcp`: installMcp writes nothing, it prints a
// config block for the user to paste, so a ledger entry would claim an install
// that may never have happened.
//
// Coverage matches what the installers actually do:
//   cli     -> `npm ls -g` for install.package
//   mcp     -> the MCP client configs installMcp points users at, keyed on slug
//   others  -> undetectable; reported as 'unknown', never as 'not installed'

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { IntegrationEntry } from './schema.js';

const execFileAsync = promisify(execFile);

export type InstalledState = 'installed' | 'not installed' | 'unknown';

export interface InstalledRow {
  slug: string;
  kind: string;
  state: InstalledState;
  /** Human-readable evidence: version found, or which client it is wired into. */
  detail: string;
}

/** Injectable for tests so nothing spawns npm or touches a real home dir. */
export interface DetectDeps {
  listGlobalNpm?: () => Promise<Record<string, string>>;
  readClientConfig?: (path: string) => Promise<string | null>;
  mcpClientPaths?: Array<{ client: string; path: string }>;
}

// The same locations install-mcp.ts tells users to paste into. Kept in sync
// with that list; if one moves, both should move.
export function defaultMcpClientPaths(): Array<{ client: string; path: string }> {
  return [
    { client: 'Cursor', path: join(homedir(), '.cursor', 'mcp.json') },
    {
      client: 'Claude Desktop',
      path: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    },
    {
      client: 'Claude Desktop',
      path: join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json'),
    },
  ];
}

/** `npm ls -g --json --depth=0` -> { packageName: version }. Empty on failure. */
async function listGlobalNpmPackages(): Promise<Record<string, string>> {
  try {
    // npm exits non-zero on extraneous/peer warnings while still emitting valid
    // JSON, so parse stdout regardless of exit code.
    const { stdout } = await execFileAsync('npm', ['ls', '--global', '--json', '--depth=0'], {
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32',
    }).catch((err: { stdout?: string }) => ({ stdout: err?.stdout ?? '' }));
    if (!stdout.trim()) return {};
    const parsed = JSON.parse(stdout) as { dependencies?: Record<string, { version?: string }> };
    const out: Record<string, string> = {};
    for (const [name, meta] of Object.entries(parsed.dependencies ?? {})) {
      out[name] = meta?.version ?? '';
    }
    return out;
  } catch {
    return {};
  }
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Which of `entries` are present locally. Never claims 'not installed' for a
 * kind the CLI cannot detect — that is reported as 'unknown'.
 */
export async function detectInstalled(
  entries: IntegrationEntry[],
  deps: DetectDeps = {},
): Promise<InstalledRow[]> {
  const needsNpm = entries.some((e) => e.install.kind === 'cli');
  const needsMcp = entries.some((e) => e.install.kind === 'mcp');

  const globals = needsNpm ? await (deps.listGlobalNpm ?? listGlobalNpmPackages)() : {};

  // slug -> the client(s) whose config declares it as an MCP server
  const wiredMcp = new Map<string, string[]>();
  if (needsMcp) {
    const paths = deps.mcpClientPaths ?? defaultMcpClientPaths();
    const read = deps.readClientConfig ?? readIfPresent;
    for (const { client, path } of paths) {
      const raw = await read(path);
      if (!raw) continue;
      let servers: Record<string, unknown> = {};
      try {
        servers = (JSON.parse(raw) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
      } catch {
        continue; // a client config we can't parse is not evidence either way
      }
      for (const key of Object.keys(servers)) {
        const list = wiredMcp.get(key) ?? [];
        if (!list.includes(client)) list.push(client);
        wiredMcp.set(key, list);
      }
    }
  }

  return entries.map((e): InstalledRow => {
    switch (e.install.kind) {
      case 'cli': {
        const found = globals[e.install.package];
        if (found === undefined) {
          return { slug: e.slug, kind: 'cli', state: 'not installed', detail: '' };
        }
        const pinned = e.install.version;
        const drift = found && pinned && found !== pinned ? ` (registry pins ${pinned})` : '';
        return {
          slug: e.slug,
          kind: 'cli',
          state: 'installed',
          detail: `${e.install.package}@${found || '?'}${drift}`,
        };
      }
      case 'mcp': {
        // installMcp keys the server block on the entry slug, so that is what
        // we look for. Note this detects a config the USER pasted — the CLI
        // never writes it — so the wording is "wired into", not "installed by".
        const clients = wiredMcp.get(e.slug);
        if (!clients?.length) {
          return { slug: e.slug, kind: 'mcp', state: 'not installed', detail: '' };
        }
        return {
          slug: e.slug,
          kind: 'mcp',
          state: 'installed',
          detail: `wired into ${clients.join(', ')}`,
        };
      }
      default:
        return {
          slug: e.slug,
          kind: e.install.kind,
          state: 'unknown',
          detail: 'the CLI does not perform this install kind',
        };
    }
  });
}
