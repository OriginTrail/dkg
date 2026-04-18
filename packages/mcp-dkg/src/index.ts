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

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  process.stderr.write(`[dkg-mcp ${VERSION}] ${describeConfig(config)}\n`);

  const client = new DkgClient({ config });
  const server = new McpServer({ name: 'dkg', version: VERSION });

  registerReadTools(server, client, config);
  registerWriteTools(server, client, config);
  registerAnnotationTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[dkg-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
