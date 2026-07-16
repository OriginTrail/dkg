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
 * does not abort startup — adapters are opt-in and optional.
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

export type AdapterRegisterFn = (
  server: McpServer,
  client: DkgClient,
  config: DkgConfig,
) => void;

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
  for (const name of names) {
    const pkg = ADAPTER_MAP[name] ?? name;
    try {
      const retired = RETIRED_ALIASES[name];
      if (retired) throw new Error(retired);
      const mod = (await import(pkg)) as { registerTools?: AdapterRegisterFn };
      if (typeof mod.registerTools === 'function') {
        mod.registerTools(server, client, config);
        process.stderr.write(`[dkg-mcp] adapter loaded: ${name}\n`);
      } else {
        process.stderr.write(
          `[dkg-mcp] adapter ${name}: no registerTools export, skipped\n`,
        );
      }
    } catch (e) {
      process.stderr.write(
        `[dkg-mcp] adapter ${name} failed to load: ${formatError(e)}\n`,
      );
    }
  }
}
