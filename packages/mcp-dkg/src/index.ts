#!/usr/bin/env node
/**
 * Stdio MCP server exposing the local DKG daemon to any MCP-aware client
 * (Cursor, Claude Code, Continue, …). See README.md for installation.
 *
 * Launched either directly via `dkg-mcp` (installed binary), via
 * `npx @origintrail-official/dkg-mcp`, or by the umbrella CLI's
 * `dkg mcp serve` wrapper which imports `main()` and invokes it with
 * a synthesised argv. `main()` reads its argv from the parameter (not
 * `process.argv`) so the umbrella wrapper can pass through subcommands
 * (`join`, `status`, etc.) cleanly.
 */
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, describeConfig } from './config.js';
import { DkgClient } from './client.js';
import { registerReadTools } from './tools.js';
import { registerAssertionTools } from './tools/assertions.js';
import { registerMemorySearchTool } from './tools/memory-search.js';
import { registerSetupTools } from './tools/setup.js';
import { registerHealthTools } from './tools/health.js';
import { registerPublishTools } from './tools/publish.js';
import { runCli, isKnownCliSubcommand } from './cli/index.js';
import { loadAdapters } from './adapters.js';

const VERSION = '0.1.0';

/**
 * Dual-mode entrypoint. With no args (the way Cursor / Claude Code
 * spawn an MCP server), boot the stdio MCP server. With a known
 * subcommand (`join`, `status`, `sync`, `create-project`, `help`),
 * delegate to the CLI dispatcher. This keeps the operator-facing
 * binary single (`dkg-mcp`) while still letting MCP clients spawn
 * the same process with no args.
 *
 * `argv` defaults to `process.argv` so direct-bin invocation
 * (`dkg-mcp join <invite>`) keeps working. The umbrella CLI's
 * `dkg mcp serve` wrapper passes a synthesised argv:
 * `['node', 'dkg-mcp', ...userArgs]` so `argv[2]` lines up with the
 * MCP-internal subcommand instead of the umbrella's `mcp` verb.
 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const sub = argv[2];
  if (sub && isKnownCliSubcommand(sub)) {
    process.exit(await runCli(argv.slice(2)));
  }

  const config = loadConfig();
  process.stderr.write(`[dkg-mcp ${VERSION}] ${describeConfig(config)}\n`);

  const client = new DkgClient({ config });
  const server = new McpServer({ name: 'dkg', version: VERSION });

  registerReadTools(server, client, config);
  registerAssertionTools(server, client, config);
  registerMemorySearchTool(server, client, config);
  registerSetupTools(server, client, config);
  registerHealthTools(server, client, config);
  registerPublishTools(server, client, config);

  await loadAdapters(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Self-execute only when invoked as the entrypoint script. When the
// umbrella `dkg mcp serve` wrapper imports this module to call `main()`
// directly, the module-load side effect must NOT boot a second MCP
// server — `process.argv[1]` is the umbrella `dkg` binary in that case,
// not this file.
const isDirectEntrypoint = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isDirectEntrypoint) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[dkg-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
