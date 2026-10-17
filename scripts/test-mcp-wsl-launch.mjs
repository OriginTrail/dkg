#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Run inside real WSL after `dkg mcp setup`, passing a Windows client JSON config.
// This launches the actual Windows wsl.exe through interop and performs MCP
// initialize + tools/list against the registered Linux CLI, never a fake server.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

if (process.platform !== 'linux' || !process.env.WSL_DISTRO_NAME) {
  throw new Error('This smoke test requires a real WSL distribution with Windows interop enabled.');
}
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/test-mcp-wsl-launch.mjs /mnt/c/Users/<user>/.cursor/mcp.json');
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { parse, printParseErrorCode } = require('jsonc-parser');
const errors = [];
const config = parse(readFileSync(configPath, 'utf8'), errors, { allowTrailingComma: true });
if (errors.length) throw new Error(`Invalid client JSON: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
const entry = config.mcpServers?.dkg ?? config.servers?.dkg;
if (!entry || !/\\System32\\wsl\.exe$/i.test(entry.command) || !Array.isArray(entry.args)) {
  throw new Error('The config has no Windows wsl.exe DKG registration. Run setup inside this WSL distribution first.');
}
const executable = execFileSync('/usr/bin/wslpath', ['-u', entry.command], { encoding: 'utf8' }).trim();
const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const transport = new StdioClientTransport({ command: executable, args: entry.args, stderr: 'inherit' });
const client = new Client({ name: 'dkg-wsl-launch-regression', version: '1.0.0' });
// Match the mandatory native fixture: cold NTFS imports measured over three minutes.
const timeoutMs = 240_000;
let timer;
try {
  await Promise.race([
    (async () => {
      await client.connect(transport, { timeout: timeoutMs });
      const result = await client.listTools();
      if (!result.tools.length) throw new Error('MCP initialized without any DKG tools.');
      console.log(`WSL Windows-launch MCP handshake passed (${result.tools.length} tools).`);
    })(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Windows-to-WSL MCP handshake timed out after ${timeoutMs}ms`)), timeoutMs); }),
  ]);
} finally {
  clearTimeout(timer);
  await client.close();
  await transport.close();
}
