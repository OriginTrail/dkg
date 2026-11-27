/**
 * Dynamic adapter loader for the DKG MCP server.
 *
 * Loads optional companion packages declared in the `DKG_ADAPTERS` env var
 * (comma-separated). Each adapter is a workspace or npm package whose entry
 * module exports a `registerTools` function:
 *
 *   export function registerTools(
 *     server: McpServer,
 *     client: DkgClient,
 *     config: DkgConfig,
 *   ): void;
 *
 * The adapter then calls `server.registerTool(...)` for every tool it
 * contributes. Failure to load any single adapter is logged to stderr and
 * does not abort startup — adapters are opt-in and optional. Program-pinned
 * entries are required and fail session startup if verification or loading fails.
 *
 * Compared to the legacy mcp-server loader (removed in the V10 keeper
 * consolidation 2026-05-04; see `pre-v10-tool-drop` tag for its original
 * shape): the lazy `getClient: () => Promise<DkgClient>` getter is
 * replaced by a concrete `DkgClient`, and adapters now also receive the
 * resolved `DkgConfig` so they can honour the workspace's pinned project,
 * agent URI, and capture defaults without re-reading `.dkg/config.yaml`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DkgClient } from './client.js';
import type { DkgConfig } from './config.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type AdapterRegisterFn = (
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
) => void | Promise<void>;

/** Short-name → package-id map for first-party adapters. */
const ADAPTER_MAP: Record<string, string> = {};

/**
 * Aliases that previously mapped to a first-party adapter but have been
 * retired. Loading them throws an explicit deprecation error rather than
 * falling through to `import(name)`, which would otherwise resolve to
 * whatever unscoped npm package happens to be installed under that name.
 */
const RETIRED_ALIASES: Record<string, string> = {
  autoresearch:
    'the "autoresearch" alias has been retired. If you still need it, set ' +
    'DKG_ADAPTERS to the full package id ' +
    '(@origintrail-official/dkg-adapter-autoresearch) and ensure the package ' +
    'is installed.',
};

function formatError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Load and register every adapter named in `DKG_ADAPTERS`. Names not in
 * `ADAPTER_MAP` are treated as raw package ids so operators can plug in
 * third-party adapters without code changes here.
 */
export async function loadAdapters(
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
): Promise<void> {
  const raw = process.env.DKG_ADAPTERS ?? '';
  const names = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const pins: Array<{ path: string; sha256: string }> | undefined = process.env.DKG_ADAPTER_HASHES
    ? JSON.parse(process.env.DKG_ADAPTER_HASHES) : undefined;
  if (pins && (!Array.isArray(pins) || pins.length !== names.length
    || new Set(pins.map(pin => pin.path)).size !== names.length
    || pins.some(pin => !names.includes(pin.path) || !isAbsolute(pin.path) || !/^[a-f0-9]{64}$/.test(pin.sha256)))) {
    throw new Error('INVALID_PINNED_ADAPTER_CONFIGURATION');
  }
  for (const name of names) {
    const pkg = ADAPTER_MAP[name] ?? name;
    let snapshot: string | undefined;
    try {
      const retired = RETIRED_ALIASES[name];
      if (retired) throw new Error(retired);
      const pin = pins?.find(pin => pin.path === name);
      if (pin) {
        const bytes = await readFile(name);
        if (createHash('sha256').update(bytes).digest('hex') !== pin.sha256) {
          throw new Error('PINNED_ADAPTER_CONTENT_CHANGED');
        }
        // Import exactly the verified bytes. A sibling keeps relative imports
        // and package type resolution intact, even if the original is replaced
        // between reading and importing. Dependencies are not part of this pin.
        const file = join(dirname(name), `.dkg-pinned-${randomUUID()}${extname(name) || '.mjs'}`);
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
        snapshot = file;
      }
      const mod = (await import(snapshot ? pathToFileURL(snapshot).href : pkg)) as { registerTools?: AdapterRegisterFn };
      if (typeof mod.registerTools === 'function') {
        await mod.registerTools(server, client, config);
        process.stderr.write(`[dkg-mcp] adapter loaded: ${name}\n`);
      } else {
        if (pin) throw new Error('PINNED_ADAPTER_REGISTER_TOOLS_MISSING');
        process.stderr.write(
          `[dkg-mcp] adapter ${name}: no registerTools export, skipped\n`,
        );
      }
    } catch (e) {
      // A Program-approved adapter is required, unlike an optional CLI adapter.
      if (pins) throw e;
      process.stderr.write(
        `[dkg-mcp] adapter ${name} failed to load: ${formatError(e)}\n`,
      );
    } finally {
      if (snapshot) await unlink(snapshot);
    }
  }
}
