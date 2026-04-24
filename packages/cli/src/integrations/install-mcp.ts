// Installer for registry entries with `install.kind === "mcp"`.
//
// MCP servers get wired into a specific MCP client's config (Cursor has
// ~/.cursor/mcp.json, Claude Desktop has its own path, etc). Client configs
// are opinionated JSON files users hand-edit and fork quickly across
// clients; silently rewriting them is a great way to clobber someone's
// custom setup.
//
// So this "installer" is deliberately non-invasive: it renders the exact
// JSON block the user should paste into the client's mcp.json, with their
// DKG auth token and API URL prefilled, and prints the standard config
// paths. An explicit --write-client flag to auto-merge into a client file
// is left to a follow-up PR.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dkgDir } from '../config.js';
import type { InstallMcp, IntegrationEntry } from './schema.js';

export interface InstallMcpOptions {
  entry: IntegrationEntry;
  apiUrl?: string;
  logger?: (msg: string) => void;
}

export interface InstallMcpResult {
  serverKey: string;
  serverBlock: Record<string, unknown>;
  mcpJson: string;
  suggestedPaths: Array<{ client: string; path: string }>;
  token?: string;
}

function assertMcp(spec: IntegrationEntry['install']): asserts spec is InstallMcp {
  if (spec.kind !== 'mcp') {
    throw new Error(`install-mcp received non-mcp install spec (kind=${spec.kind})`);
  }
}

// Best-effort token read from the standard daemon-written path. Matches the
// format produced by `dkg auth rotate` (a leading comment line + the token).
// Resolves the path via dkgDir() so DKG_HOME and the monorepo's .dkg-dev
// fallback are respected — matches where the rest of the CLI writes auth.
// If we can't find one, we emit a placeholder and let the user fill it in.
async function readLocalToken(): Promise<string | undefined> {
  try {
    const raw = await readFile(join(dkgDir(), 'auth.token'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) return t;
    }
  } catch {
    // fall through — no token file is a normal state on a fresh machine.
  }
  return undefined;
}

export async function installMcp(options: InstallMcpOptions): Promise<InstallMcpResult> {
  const { entry, apiUrl = 'http://127.0.0.1:9200', logger = console.log } = options;
  assertMcp(entry.install);

  // Registry schema: entries declare the env var NAMES they need via
  // `envRequired`. DKG_API_URL and DKG_AUTH_TOKEN are auto-filled if
  // listed; every other name is rendered as a placeholder the user fills
  // in. Entries that do NOT list DKG_AUTH_TOKEN never get the local admin
  // token embedded — that is the security boundary. Auto-injecting the
  // token into every MCP block would hand the node's write authority to
  // any third-party server the moment the user pastes the snippet.
  const envRequired = entry.install.envRequired ?? [];
  const entryWantsToken = envRequired.includes('DKG_AUTH_TOKEN');
  const entryWantsApiUrl = envRequired.includes('DKG_API_URL');

  let localToken: string | undefined;
  if (entryWantsToken) {
    localToken = await readLocalToken();
  }
  const tokenPlaceholder = '<DKG_AUTH_TOKEN>';
  let tokenUsed = false;

  const env: Record<string, string> = {};
  if (entryWantsApiUrl) {
    env.DKG_API_URL = apiUrl;
  }
  if (entryWantsToken) {
    if (localToken) {
      env.DKG_AUTH_TOKEN = localToken;
      tokenUsed = true;
    } else {
      env.DKG_AUTH_TOKEN = tokenPlaceholder;
    }
  }
  // Any other env vars the entry declares get placeholder slots the user
  // must fill in manually — we don't invent values for unknown names.
  for (const name of envRequired) {
    if (name === 'DKG_API_URL' || name === 'DKG_AUTH_TOKEN') continue;
    env[name] = `<${name}>`;
  }

  const serverBlock: Record<string, unknown> = {
    command: entry.install.command,
    args: entry.install.args,
    env,
  };

  const serverKey = entry.slug;
  const mcpJson = JSON.stringify({ mcpServers: { [serverKey]: serverBlock } }, null, 2);

  const suggestedPaths: InstallMcpResult['suggestedPaths'] = [
    { client: 'Cursor', path: join(homedir(), '.cursor', 'mcp.json') },
    {
      client: 'Claude Desktop (macOS)',
      path: join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    },
    {
      client: 'Claude Desktop (Windows)',
      path: '%APPDATA%\\Claude\\claude_desktop_config.json',
    },
  ];

  logger('This integration runs as an MCP server. Add the block below to your MCP client\'s config:');
  logger('');
  logger(mcpJson);
  logger('');
  logger('Common config locations:');
  for (const { client, path } of suggestedPaths) logger(`  ${client}: ${path}`);
  if (entryWantsToken && !localToken) {
    logger('');
    logger(`No local DKG auth token found — replace ${tokenPlaceholder} with the value from \`dkg auth show\`.`);
  }
  if (!entryWantsToken) {
    logger('');
    logger('This entry does not declare DKG_AUTH_TOKEN in envRequired, so no local token was embedded in the block.');
  }
  const userMustFill = envRequired.filter((n) => n !== 'DKG_API_URL' && n !== 'DKG_AUTH_TOKEN');
  if (userMustFill.length > 0) {
    logger('');
    logger(`The following env values are not auto-filled — replace the placeholders before use: ${userMustFill.join(', ')}`);
  }
  if (entry.install.usageHint) {
    logger('');
    logger('Usage:');
    for (const line of entry.install.usageHint.split('\n')) logger(`  ${line}`);
  }

  return {
    serverKey,
    serverBlock,
    mcpJson,
    suggestedPaths,
    token: tokenUsed ? localToken : undefined,
  };
}
