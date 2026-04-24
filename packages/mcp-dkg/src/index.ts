#!/usr/bin/env node
/**
 * Stdio MCP server exposing the local DKG daemon to any MCP-aware client
 * (Cursor, Claude Code, Continue, …). See README.md for installation.
 *
 * Launched either directly via `dkg-mcp` (installed binary) or via
 * `npx @origintrail-official/dkg-mcp`. Picks up `.dkg/config.yaml` from
 * the workspace or falls back to environment variables.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, describeConfig } from './config.js';
import { DkgClient } from './client.js';
import { registerReadTools } from './tools.js';
import { registerWriteTools } from './tools/writes.js';
import { registerAnnotationTools } from './tools/annotations.js';
import { registerReviewTools } from './tools/review.js';
import { runCli, isKnownCliSubcommand } from './cli/index.js';

const VERSION = '0.1.0';

/**
 * Dual-mode entrypoint. With no args (the way Cursor / Claude Code
 * spawn an MCP server), boot the stdio MCP server. With a known
 * subcommand (`join`, `status`, `sync`, `create-project`, `help`),
 * delegate to the CLI dispatcher. This keeps the operator-facing
 * binary single (`dkg-mcp`) while still letting MCP clients spawn
 * the same process with no args.
 */
async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub && isKnownCliSubcommand(sub)) {
    process.exit(await runCli(process.argv.slice(2)));
  }

  const config = loadConfig();
  process.stderr.write(`[dkg-mcp ${VERSION}] ${describeConfig(config)}\n`);

  const client = new DkgClient({ config });
  const server = new McpServer({ name: 'dkg', version: VERSION });

  registerReadTools(server, client, config);
  registerWriteTools(server, client, config);
  registerAnnotationTools(server, client, config);
  registerReviewTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[dkg-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
